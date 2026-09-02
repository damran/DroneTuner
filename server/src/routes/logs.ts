import type { FastifyInstance } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { listBlackboxSessions, parseBlackboxLog } from "@dronetuner/shared/blackbox";
import type { FlightLog, LogUploadResult } from "@dronetuner/shared";
import type { AppContext } from "../context";
import { analyses, drones, logs } from "../db/schema";
import { analyzeLog, normalizeGoal } from "../services/analysis";

export function toLog(row: typeof logs.$inferSelect): FlightLog {
  return {
    id: row.id,
    droneId: row.droneId,
    filePath: row.filePath,
    headers: (row.headersJson ?? null) as Record<string, string> | null,
    uploadedAt: row.uploadedAt,
    sessionIndex: row.sessionIndex,
    sessionCount: row.sessionCount,
    originalName: row.originalName,
    durationS: row.durationS,
    recordedAt: row.recordedAt,
  };
}

const LOG_EXTENSIONS = new Set([".bbl", ".bfl", ".txt", ".log"]);

/** Sessions shorter than this are arm/disarm blips, not flights. */
const MIN_SESSION_S = 3;
/** Upload-time parse cap per session (duration only needs the last timestamp). */
const UPLOAD_MAX_FRAMES = 2_000_000;

/**
 * When the flight was recorded. Betaflight only writes a real
 * "Log start datetime" when the FC has a clock (GPS/RTC); whoops log
 * 0000-01-01, so fall back to the timestamp Configurator puts in the
 * download name (BTFL_BLACKBOX_LOG_<craft>_YYYYMMDD_HHMMSS_<target>.BBL).
 */
export function recordedAtFrom(headers: Record<string, string> | null, originalName: string | null): number | null {
  const dt = headers?.["Log start datetime"];
  if (dt) {
    const t = Date.parse(dt);
    if (!Number.isNaN(t) && new Date(t).getFullYear() > 2000) return t;
  }
  const m = originalName ? /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(originalName) : null;
  if (m) {
    const [, y, mo, d, h, mi, sec] = m;
    const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec)).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

/** Newest flight first; sessions of one file keep their in-file order reversed so "previous" = the earlier flight. */
const NEWEST_FIRST = [desc(sql`coalesce(${logs.recordedAt}, ${logs.uploadedAt})`), desc(logs.sessionIndex), desc(logs.id)];

interface SessionSummary {
  index: number;
  headers: Record<string, string>;
  durationS: number;
}

/**
 * Enumerate the flight sessions in an uploaded file. Every session is parsed
 * (frames are needed for the duration); unparsable ones are dropped.
 */
export function summarizeSessions(data: Uint8Array): { kept: SessionSummary[]; skipped: number; total: number } {
  const ranges = listBlackboxSessions(data);
  const all: SessionSummary[] = [];
  for (const r of ranges) {
    try {
      const parsed = parseBlackboxLog(data, { sessionIndex: r.index, maxFrames: UPLOAD_MAX_FRAMES });
      const t = parsed.timeUs;
      const durationS = t.length > 1 ? (t[t.length - 1]! - t[0]!) / 1e6 : 0;
      all.push({ index: r.index, headers: parsed.headers, durationS });
    } catch {
      /* corrupt session: skip */
    }
  }
  let kept = all.filter((s) => s.durationS >= MIN_SESSION_S);
  // Keep the longest session rather than nothing when every flight is a blip.
  if (kept.length === 0 && all.length > 0) kept = [all.reduce((a, b) => (b.durationS > a.durationS ? b : a))];
  return { kept, skipped: ranges.length - kept.length, total: ranges.length };
}

export default async function logsRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db, config } = opts.ctx;

  app.get("/api/logs", async (req) => {
    const { droneId } = req.query as { droneId?: string };
    const rows = droneId
      ? await db.select().from(logs).where(eq(logs.droneId, Number(droneId))).orderBy(...NEWEST_FIRST)
      : await db.select().from(logs).orderBy(...NEWEST_FIRST);
    return rows.map(toLog);
  });

  app.get("/api/logs/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = await db.select().from(logs).where(eq(logs.id, id)).get();
    if (!row) return reply.code(404).send({ error: "Log not found" });
    return toLog(row);
  });

  app.post("/api/logs", async (req, reply) => {
    let droneId: number | null = null;
    let savedPath: string | null = null;
    let originalName: string | null = null;
    let truncated = false;

    const cleanup = (): void => {
      if (savedPath) fs.promises.unlink(path.join(config.logsDir, savedPath)).catch(() => {});
    };

    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === "file") {
        const ext = path.extname(part.filename).toLowerCase();
        if (!LOG_EXTENSIONS.has(ext)) {
          return reply.code(400).send({ error: `Unsupported log file type "${ext || "(none)"}"` });
        }
        const name = `${crypto.randomUUID()}${ext}`;
        const dest = path.join(config.logsDir, name);
        await pipeline(part.file, fs.createWriteStream(dest));
        if (part.file.truncated) truncated = true;
        savedPath = name;
        originalName = path.basename(part.filename).slice(0, 200) || null;
      } else if (part.fieldname === "droneId") {
        droneId = Number(part.value);
      }
    }

    if (!savedPath) return reply.code(400).send({ error: "No file uploaded" });
    if (truncated) {
      cleanup();
      return reply.code(413).send({ error: "Log file exceeds the upload size limit" });
    }
    if (!droneId || Number.isNaN(droneId)) {
      cleanup();
      return reply.code(400).send({ error: "droneId required" });
    }

    const drone = await db.select().from(drones).where(eq(drones.id, droneId)).get();
    if (!drone) {
      cleanup();
      return reply.code(404).send({ error: "Drone not found" });
    }

    // One log row per flight session: a flash download holds every arm
    // since the last erase, and analysing "the file" would silently mean
    // analysing only the first (often a 2 s blip).
    const data = new Uint8Array(await fs.promises.readFile(path.join(config.logsDir, savedPath)));
    const { kept, skipped, total } = summarizeSessions(data);
    if (kept.length === 0) {
      cleanup();
      return reply.code(400).send({ error: "No blackbox flight session found in this file" });
    }

    const uploadedAt = Date.now();
    const created: FlightLog[] = [];
    for (const session of kept) {
      const [row] = await db
        .insert(logs)
        .values({
          droneId,
          filePath: savedPath,
          headersJson: session.headers,
          uploadedAt,
          sessionIndex: session.index,
          sessionCount: total,
          originalName,
          durationS: Math.round(session.durationS),
          recordedAt: recordedAtFrom(session.headers, originalName),
        })
        .returning();
      created.push(toLog(row!));
    }
    // Newest flight first, same order as GET /api/logs.
    created.sort((a, b) => b.sessionIndex - a.sessionIndex);
    const result: LogUploadResult = { logs: created, skippedSessions: skipped, sessionCount: total };
    return result;
  });

  app.get("/api/logs/:id/file", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const log = await db.select().from(logs).where(eq(logs.id, id)).get();
    if (!log) return reply.code(404).send({ error: "Log not found" });
    const filePath = path.join(config.logsDir, log.filePath);
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: "File missing on disk" });
    return reply.type("application/octet-stream").send(fs.createReadStream(filePath));
  });

  app.post("/api/logs/:id/analyze", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const log = await db.select().from(logs).where(eq(logs.id, id)).get();
    if (!log) return reply.code(404).send({ error: "Log not found" });
    // Optional { goal } — otherwise the drone's latest non-template profile decides.
    const body = (req.body ?? {}) as { goal?: unknown };
    if (body.goal !== undefined && (typeof body.goal !== "string" || !normalizeGoal(body.goal))) {
      return reply.code(400).send({ error: "Unknown tuning goal" });
    }
    try {
      return await analyzeLog(opts.ctx, id, typeof body.goal === "string" ? body.goal : null);
    } catch (err) {
      // Don't leak absolute filesystem paths or parser internals.
      const msg = err instanceof Error && err.name === "BlackboxParseError" ? err.message : "Failed to analyze log";
      req.log.warn(err, "log analysis failed");
      return reply.code(400).send({ error: msg });
    }
  });

  app.get("/api/logs/:id/analysis", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rows = await db
      .select()
      .from(analyses)
      .where(eq(analyses.logId, id))
      .orderBy(desc(analyses.createdAt))
      .limit(1);
    if (rows.length === 0) return reply.code(404).send({ error: "No analysis yet" });
    const a = rows[0]!;
    return {
      id: a.id,
      logId: a.logId,
      metrics: a.metricsJson,
      findings: a.findingsJson,
      createdAt: a.createdAt,
    };
  });

  app.delete("/api/logs/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const log = await db.select().from(logs).where(eq(logs.id, id)).get();
    if (!log) return reply.code(404).send({ error: "Log not found" });
    await db.delete(logs).where(eq(logs.id, id));
    // Sibling sessions share the file — only remove it with the last row.
    const siblings = await db.select({ id: logs.id }).from(logs).where(eq(logs.filePath, log.filePath));
    const filePath = path.join(config.logsDir, log.filePath);
    if (siblings.length === 0 && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return reply.code(204).send();
  });
}

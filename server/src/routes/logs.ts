import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { parseBlackboxHeaders } from "@dronetuner/shared/blackbox";
import type { FlightLog } from "@dronetuner/shared";
import type { AppContext } from "../context";
import { analyses, drones, logs } from "../db/schema";
import { analyzeLog } from "../services/analysis";

function toLog(row: typeof logs.$inferSelect): FlightLog {
  return {
    id: row.id,
    droneId: row.droneId,
    filePath: row.filePath,
    headers: (row.headersJson ?? null) as Record<string, string> | null,
    uploadedAt: row.uploadedAt,
  };
}

const LOG_EXTENSIONS = new Set([".bbl", ".bfl", ".txt", ".log"]);

export default async function logsRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db, config } = opts.ctx;

  app.get("/api/logs", async (req) => {
    const { droneId } = req.query as { droneId?: string };
    const rows = droneId
      ? await db.select().from(logs).where(eq(logs.droneId, Number(droneId))).orderBy(desc(logs.uploadedAt))
      : await db.select().from(logs).orderBy(desc(logs.uploadedAt));
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

    let headers: Record<string, string> | null;
    try {
      const fullPath = path.join(config.logsDir, savedPath);
      const fd = fs.openSync(fullPath, "r");
      const buf = Buffer.alloc(1024 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      headers = parseBlackboxHeaders(new Uint8Array(buf.subarray(0, n)));
    } catch {
      headers = null;
    }

    const [row] = await db
      .insert(logs)
      .values({ droneId, filePath: savedPath, headersJson: headers, uploadedAt: Date.now() })
      .returning();
    return toLog(row!);
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
    try {
      return await analyzeLog(opts.ctx, id);
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
    const filePath = path.join(config.logsDir, log.filePath);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return reply.code(204).send();
  });
}

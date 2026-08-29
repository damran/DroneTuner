import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { parseBlackboxLog } from "@dronetuner/shared/blackbox";
import { computeMetrics } from "@dronetuner/shared/analysis";
import { runRules } from "@dronetuner/shared/tuning";
import type { AppContext } from "../context";
import { analyses, flights, logs } from "../db/schema";

export interface AnalyzeResult {
  id: number;
  logId: number;
  metrics: ReturnType<typeof computeMetrics>;
  findings: ReturnType<typeof runRules>["findings"];
  createdAt: number;
}

export async function analyzeLog(ctx: AppContext, logId: number): Promise<AnalyzeResult> {
  const { db, config } = ctx;
  const log = await db.select().from(logs).where(eq(logs.id, logId)).get();
  if (!log) throw new Error("Log not found");

  const filePath = path.join(config.logsDir, log.filePath);
  const data = await fs.promises.readFile(filePath);
  // Parse + metrics run synchronously on the Fastify event loop. That blocks
  // other requests for the duration (a few hundred ms for a typical log) —
  // acceptable for a single-user local app; move to a worker thread if that
  // ever changes.
  const parsed = parseBlackboxLog(new Uint8Array(data));
  const metrics = computeMetrics(parsed);
  const { findings } = runRules(metrics, "freestyle");

  const [analysis] = await db
    .insert(analyses)
    .values({
      logId,
      metricsJson: metrics as unknown as Record<string, unknown>,
      findingsJson: findings as unknown as Record<string, unknown>[],
      createdAt: Date.now(),
    })
    .returning();

  const existingFlight = await db.select().from(flights).where(eq(flights.logId, logId)).get();
  if (!existingFlight) {
    await db
      .insert(flights)
      .values({
        droneId: log.droneId,
        batteryComponentId: null,
        logId,
        date: parseLogDate(parsed.headers) ?? log.uploadedAt,
        durationS: Math.round(metrics.durationS),
        styleTag: null,
      });
  } else {
    // Keep the inferred flight in sync on re-analysis.
    await db
      .update(flights)
      .set({
        date: parseLogDate(parsed.headers) ?? existingFlight.date,
        durationS: Math.round(metrics.durationS),
      })
      .where(eq(flights.id, existingFlight.id));
  }

  return { id: analysis!.id, logId, metrics, findings, createdAt: analysis!.createdAt };
}

function parseLogDate(headers: Record<string, string>): number | null {
  const dt = headers["Log start datetime"];
  if (!dt) return null;
  const t = Date.parse(dt);
  return Number.isNaN(t) ? null : t;
}

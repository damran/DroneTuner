import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, ne } from "drizzle-orm";
import { parseBlackboxLog } from "@dronetuner/shared/blackbox";
import { computeMetrics } from "@dronetuner/shared/analysis";
import { runRules } from "@dronetuner/shared/tuning";
import { LEGACY_TUNE_GOALS, TUNE_GOALS, type TuneGoal } from "@dronetuner/shared";
import type { AppContext } from "../context";
import { analyses, flights, logs, profiles } from "../db/schema";

export interface AnalyzeResult {
  id: number;
  logId: number;
  metrics: ReturnType<typeof computeMetrics>;
  findings: ReturnType<typeof runRules>["findings"];
  createdAt: number;
}

/** Coerce a stored/user goal string (legacy names included) to a TuneGoal, or null. */
export function normalizeGoal(goal: string | null | undefined): TuneGoal | null {
  if (!goal) return null;
  if ((TUNE_GOALS as readonly string[]).includes(goal)) return goal as TuneGoal;
  return LEGACY_TUNE_GOALS[goal] ?? null;
}

/**
 * The goal the rules score against: an explicit request wins, otherwise the
 * drone's most recent non-template profile (generated / snapshot / imported
 * flown config), otherwise "freestyle".
 */
export async function resolveGoal(ctx: AppContext, droneId: number, requested?: string | null): Promise<TuneGoal> {
  const explicit = normalizeGoal(requested);
  if (explicit) return explicit;
  const latest = await ctx.db
    .select({ goal: profiles.goal })
    .from(profiles)
    .where(and(eq(profiles.droneId, droneId), ne(profiles.source, "template")))
    .orderBy(desc(profiles.createdAt))
    .limit(1)
    .get();
  return normalizeGoal(latest?.goal) ?? "freestyle";
}

export async function analyzeLog(ctx: AppContext, logId: number, requestedGoal?: string | null): Promise<AnalyzeResult> {
  const { db, config } = ctx;
  const log = await db.select().from(logs).where(eq(logs.id, logId)).get();
  if (!log) throw new Error("Log not found");
  const goal = await resolveGoal(ctx, log.droneId, requestedGoal);

  const filePath = path.join(config.logsDir, log.filePath);
  const data = await fs.promises.readFile(filePath);
  // Parse + metrics run synchronously on the Fastify event loop. That blocks
  // other requests for the duration (a few hundred ms for a typical log) —
  // acceptable for a single-user local app; move to a worker thread if that
  // ever changes.
  const parsed = parseBlackboxLog(new Uint8Array(data), { sessionIndex: log.sessionIndex });
  const metrics = computeMetrics(parsed);
  const { findings } = runRules(metrics, goal);

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
        date: parseLogDate(parsed.headers) ?? log.recordedAt ?? log.uploadedAt,
        durationS: Math.round(metrics.durationS),
        styleTag: null,
      });
  } else {
    // Keep the inferred flight in sync on re-analysis.
    await db
      .update(flights)
      .set({
        date: parseLogDate(parsed.headers) ?? log.recordedAt ?? existingFlight.date,
        durationS: Math.round(metrics.durationS),
      })
      .where(eq(flights.id, existingFlight.id));
  }

  return { id: analysis!.id, logId, metrics, findings, createdAt: analysis!.createdAt };
}

/** Only trust the header datetime when the FC actually had a clock (whoops log 0000-01-01). */
function parseLogDate(headers: Record<string, string>): number | null {
  const dt = headers["Log start datetime"];
  if (!dt) return null;
  const t = Date.parse(dt);
  return Number.isNaN(t) || new Date(t).getFullYear() <= 2000 ? null : t;
}

import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { TuningProgressRow } from "@dronetuner/shared";
import { TUNING_SEQUENCE } from "@dronetuner/shared/tuning";
import type { AppContext } from "../context";
import { drones, tuningProgress } from "../db/schema";

const STEP_IDS = TUNING_SEQUENCE.map((s) => s.id) as [string, ...string[]];

const putSchema = z.object({
  done: z.boolean(),
  notes: z.string().max(500).nullable().optional(),
});

function toRow(row: typeof tuningProgress.$inferSelect): TuningProgressRow {
  return { droneId: row.droneId, step: row.step, done: row.done, updatedAt: row.updatedAt, notes: row.notes };
}

/** Per-drone tuning-sequence ticks (shared/src/tuning/sequence.ts). */
export default async function tuningProgressRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db } = opts.ctx;

  app.get("/api/drones/:id/tuning-progress", async (req, reply) => {
    const droneId = Number((req.params as { id: string }).id);
    const drone = await db.select({ id: drones.id }).from(drones).where(eq(drones.id, droneId)).get();
    if (!drone) return reply.code(404).send({ error: "Drone not found" });
    const rows = await db.select().from(tuningProgress).where(eq(tuningProgress.droneId, droneId));
    return rows.map(toRow);
  });

  app.put("/api/drones/:id/tuning-progress/:step", async (req, reply) => {
    const { id, step } = req.params as { id: string; step: string };
    const droneId = Number(id);
    if (!STEP_IDS.includes(step)) return reply.code(400).send({ error: `Unknown tuning step: ${step}` });
    const drone = await db.select({ id: drones.id }).from(drones).where(eq(drones.id, droneId)).get();
    if (!drone) return reply.code(404).send({ error: "Drone not found" });
    const body = putSchema.parse(req.body);
    const now = Date.now();
    await db
      .insert(tuningProgress)
      .values({ droneId, step, done: body.done, updatedAt: now, notes: body.notes ?? null })
      .onConflictDoUpdate({
        target: [tuningProgress.droneId, tuningProgress.step],
        set: { done: body.done, updatedAt: now, notes: body.notes ?? null },
      });
    const row = await db
      .select()
      .from(tuningProgress)
      .where(and(eq(tuningProgress.droneId, droneId), eq(tuningProgress.step, step)))
      .get();
    return toRow(row!);
  });
}

import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { FcConfig, FcDump, FcSnapshot } from "@dronetuner/shared";
import type { AppContext } from "../context";
import { fcSnapshots } from "../db/schema";
import { buildApplyPlan, fcConfigToSettings } from "../services/applyplan";

const createSchema = z.object({
  droneId: z.number().int().positive(),
  dump: z.object({
    apiVersion: z.string(),
    fcVariant: z.string(),
    fcVersion: z.string(),
    capturedAt: z.number(),
    sections: z.array(z.object({ command: z.number().int(), payloadHex: z.string() })),
    decoded: z.object({ pids: z.record(z.object({ p: z.number(), i: z.number(), d: z.number() })) }).passthrough(),
  }),
  reason: z.string().nullable().optional(),
});

function toSnapshot(row: typeof fcSnapshots.$inferSelect): FcSnapshot {
  return {
    id: row.id,
    droneId: row.droneId,
    dump: row.dumpJson as FcDump,
    takenAt: row.takenAt,
    reason: row.reason,
  };
}

export default async function snapshotsRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db } = opts.ctx;

  app.get("/api/snapshots", async (req) => {
    const { droneId } = req.query as { droneId?: string };
    const rows = droneId
      ? await db.select().from(fcSnapshots).where(eq(fcSnapshots.droneId, Number(droneId))).orderBy(desc(fcSnapshots.takenAt))
      : await db.select().from(fcSnapshots).orderBy(desc(fcSnapshots.takenAt));
    return rows.map(toSnapshot);
  });

  app.post("/api/snapshots", async (req) => {
    const body = createSchema.parse(req.body);
    const [row] = await db
      .insert(fcSnapshots)
      .values({
        droneId: body.droneId,
        dumpJson: body.dump as unknown as FcDump,
        takenAt: Date.now(),
        reason: body.reason ?? null,
      })
      .returning();
    return toSnapshot(row!);
  });

  app.delete("/api/snapshots/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    await db.delete(fcSnapshots).where(eq(fcSnapshots.id, id));
    return reply.code(204).send();
  });

  app.post("/api/snapshots/:id/restore-plan", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const snapshot = await db.select().from(fcSnapshots).where(eq(fcSnapshots.id, id)).get();
    if (!snapshot) return reply.code(404).send({ error: "Snapshot not found" });
    const parsed = z
      .object({
        current: z
          .object({
            pids: z.record(z.object({ p: z.number(), i: z.number(), d: z.number() })),
            filters: z.record(z.number()),
            rates: z.record(z.number()),
            advanced: z.record(z.number()),
          })
          .passthrough(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "current FC config required (decoded pids/filters/rates/advanced)" });
    }
    const dump = snapshot.dumpJson as FcDump;
    const plan = buildApplyPlan(parsed.data.current as unknown as FcConfig, fcConfigToSettings(dump.decoded));
    return {
      snapshotId: id,
      diff: plan.diff,
      sections: dump.sections,
      upToDate: plan.upToDate,
    };
  });
}

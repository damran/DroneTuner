import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { FcDump, FcSnapshot } from "@dronetuner/shared";
import type { AppContext } from "../context";
import { fcSnapshots } from "../db/schema";

/**
 * Restore replays these payloads verbatim to the FC, so only the four tuning
 * SET commands DroneTuner itself writes are storable — anything else (arming,
 * feature, reboot, …) must never be replayed. Mirrors SET_COMMANDS in
 * client/src/lib/msp/commands.ts; the MSP session re-checks at replay time.
 */
const RESTORABLE_COMMANDS = new Set([93, 95, 202, 204]);

const createSchema = z.object({
  droneId: z.number().int().positive(),
  dump: z.object({
    apiVersion: z.string(),
    fcVariant: z.string(),
    fcVersion: z.string(),
    capturedAt: z.number(),
    sections: z.array(
      z.object({
        command: z
          .number()
          .int()
          .refine((c) => RESTORABLE_COMMANDS.has(c), "command is not a restorable MSP SET command"),
        // even-length hex, capped well above the largest managed payload (~64 bytes)
        payloadHex: z.string().regex(/^([0-9a-fA-F]{2}){0,128}$/, "payloadHex must be even-length hex"),
      }),
    ),
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
}

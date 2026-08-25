import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Flight } from "@dronetuner/shared";
import { FLIGHT_STYLE_TAGS } from "@dronetuner/shared";
import type { AppContext } from "../context";
import { components, flights } from "../db/schema";

const createSchema = z.object({
  droneId: z.number().int().positive(),
  batteryComponentId: z.number().int().positive().nullable().optional(),
  logId: z.number().int().positive().nullable().optional(),
  date: z.number().int().optional(),
  durationS: z.number().int().nullable().optional(),
  styleTag: z.enum([...FLIGHT_STYLE_TAGS] as [string, ...string[]]).nullable().optional(),
});

const updateSchema = z.object({
  batteryComponentId: z.number().int().positive().nullable().optional(),
  styleTag: z.enum([...FLIGHT_STYLE_TAGS] as [string, ...string[]]).nullable().optional(),
  date: z.number().int().optional(),
  durationS: z.number().int().nullable().optional(),
});

function toFlight(row: typeof flights.$inferSelect): Flight {
  return {
    id: row.id,
    droneId: row.droneId,
    batteryComponentId: row.batteryComponentId,
    logId: row.logId,
    date: row.date,
    durationS: row.durationS,
    styleTag: row.styleTag,
  };
}

export default async function flightsRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db } = opts.ctx;

  app.get("/api/flights", async (req) => {
    const { droneId } = req.query as { droneId?: string };
    const rows = droneId
      ? await db.select().from(flights).where(eq(flights.droneId, Number(droneId))).orderBy(desc(flights.date))
      : await db.select().from(flights).orderBy(desc(flights.date));
    return rows.map(toFlight);
  });

  app.post("/api/flights", async (req) => {
    const body = createSchema.parse(req.body);
    const [row] = await db
      .insert(flights)
      .values({
        droneId: body.droneId,
        batteryComponentId: body.batteryComponentId ?? null,
        logId: body.logId ?? null,
        date: body.date ?? Date.now(),
        durationS: body.durationS ?? null,
        styleTag: body.styleTag ?? null,
      })
      .returning();
    return toFlight(row!);
  });

  app.patch("/api/flights/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = updateSchema.parse(req.body);
    const existing = await db.select().from(flights).where(eq(flights.id, id)).get();
    if (!existing) return reply.code(404).send({ error: "Flight not found" });
    const [row] = await db
      .update(flights)
      .set({
        batteryComponentId: body.batteryComponentId !== undefined ? body.batteryComponentId : existing.batteryComponentId,
        styleTag: body.styleTag !== undefined ? body.styleTag : existing.styleTag,
        date: body.date ?? existing.date,
        durationS: body.durationS !== undefined ? body.durationS : existing.durationS,
      })
      .where(eq(flights.id, id))
      .returning();
    return toFlight(row!);
  });

  app.delete("/api/flights/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    await db.delete(flights).where(eq(flights.id, id));
    return reply.code(204).send();
  });

  app.get("/api/stats/batteries", async (req) => {
    const { droneId } = req.query as { droneId?: string };
    const rows = droneId
      ? await db.select().from(flights).where(eq(flights.droneId, Number(droneId)))
      : await db.select().from(flights);

    const agg = new Map<number, { count: number; totalDurationS: number; lastFlown: number | null }>();
    for (const f of rows) {
      if (f.batteryComponentId == null) continue;
      const e = agg.get(f.batteryComponentId) ?? { count: 0, totalDurationS: 0, lastFlown: null as number | null };
      e.count += 1;
      e.totalDurationS += f.durationS ?? 0;
      e.lastFlown = Math.max(e.lastFlown ?? 0, f.date);
      agg.set(f.batteryComponentId, e);
    }

    const ids = [...agg.keys()];
    const nameById = new Map<number, string>();
    for (const id of ids) {
      const c = await db.select().from(components).where(eq(components.id, id)).get();
      if (c) nameById.set(id, c.name);
    }

    return [...agg.entries()]
      .map(([componentId, e]) => ({
        componentId,
        name: nameById.get(componentId) ?? "Unknown battery",
        flightCount: e.count,
        totalDurationS: e.totalDurationS,
        lastFlown: e.lastFlown,
      }))
      .sort((a, b) => b.flightCount - a.flightCount);
  });
}

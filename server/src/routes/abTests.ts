import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AbTest, AbTestVariant } from "@dronetuner/shared";
import type { AppContext } from "../context";
import { abTests, drones } from "../db/schema";

const variantSchema = z.object({
  side: z.enum(["A", "B"]),
  label: z.string().min(1).max(60),
  slot: z.number().int().min(0).max(5),
  settings: z.object({}).passthrough(),
});

const createSchema = z.object({
  droneId: z.number().int().positive(),
  kind: z.enum(["pid", "rate"]),
  variants: z.tuple([variantSchema, variantSchema]),
  notes: z.string().max(500).nullable().optional(),
});

function toAbTest(row: typeof abTests.$inferSelect): AbTest {
  return {
    id: row.id,
    droneId: row.droneId,
    kind: row.kind as AbTest["kind"],
    createdAt: row.createdAt,
    variants: row.variantsJson as AbTestVariant[],
    notes: row.notes,
  };
}

export default async function abTestsRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db } = opts.ctx;

  app.get("/api/ab-tests", async (req) => {
    const { droneId } = req.query as { droneId?: string };
    const rows = droneId
      ? await db.select().from(abTests).where(eq(abTests.droneId, Number(droneId))).orderBy(desc(abTests.createdAt))
      : await db.select().from(abTests).orderBy(desc(abTests.createdAt));
    return rows.map(toAbTest);
  });

  app.post("/api/ab-tests", async (req, reply) => {
    const body = createSchema.parse(req.body);
    const drone = await db.select({ id: drones.id }).from(drones).where(eq(drones.id, body.droneId)).get();
    if (!drone) return reply.code(404).send({ error: "Drone not found" });
    if (body.variants[0].slot === body.variants[1].slot) {
      return reply.code(400).send({ error: "A and B need two different profile slots" });
    }
    const [row] = await db
      .insert(abTests)
      .values({
        droneId: body.droneId,
        kind: body.kind,
        createdAt: Date.now(),
        variantsJson: body.variants as unknown as AbTestVariant[],
        notes: body.notes ?? null,
      })
      .returning();
    return toAbTest(row!);
  });

  app.delete("/api/ab-tests/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = await db.select({ id: abTests.id }).from(abTests).where(eq(abTests.id, id)).get();
    if (!row) return reply.code(404).send({ error: "A/B test not found" });
    await db.delete(abTests).where(eq(abTests.id, id));
    return reply.code(204).send();
  });
}

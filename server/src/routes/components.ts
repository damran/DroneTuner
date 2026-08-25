import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Component, ComponentCategory } from "@dronetuner/shared";
import { COMPONENT_CATEGORIES } from "@dronetuner/shared";
import type { AppContext } from "../context";
import { components } from "../db/schema";

const categoryEnum = z.enum([...COMPONENT_CATEGORIES] as [ComponentCategory, ...ComponentCategory[]]);

const createSchema = z.object({
  category: categoryEnum,
  name: z.string().min(1),
  specs: z.record(z.unknown()).optional().default({}),
  notes: z.string().nullable().optional(),
});

const updateSchema = z.object({
  category: categoryEnum.optional(),
  name: z.string().min(1).optional(),
  specs: z.record(z.unknown()).optional(),
  notes: z.string().nullable().optional(),
});

function toComponent(row: typeof components.$inferSelect): Component {
  return {
    id: row.id,
    category: row.category as ComponentCategory,
    name: row.name,
    specs: (row.specsJson ?? {}) as Record<string, unknown>,
    notes: row.notes,
  };
}

export default async function componentsRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db } = opts.ctx;

  app.get("/api/components", async (req) => {
    const { category } = req.query as { category?: string };
    const rows = category
      ? await db.select().from(components).where(eq(components.category, category)).orderBy(desc(components.id))
      : await db.select().from(components).orderBy(desc(components.id));
    return rows.map(toComponent);
  });

  app.get("/api/components/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = await db.select().from(components).where(eq(components.id, id)).get();
    if (!row) return reply.code(404).send({ error: "Component not found" });
    return toComponent(row);
  });

  app.post("/api/components", async (req) => {
    const body = createSchema.parse(req.body);
    const [row] = await db
      .insert(components)
      .values({
        category: body.category,
        name: body.name,
        specsJson: body.specs,
        notes: body.notes ?? null,
      })
      .returning();
    return toComponent(row!);
  });

  app.patch("/api/components/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = updateSchema.parse(req.body);
    const existing = await db.select().from(components).where(eq(components.id, id)).get();
    if (!existing) return reply.code(404).send({ error: "Component not found" });
    const [row] = await db
      .update(components)
      .set({
        category: body.category ?? existing.category,
        name: body.name ?? existing.name,
        specsJson: body.specs ?? existing.specsJson,
        notes: body.notes !== undefined ? body.notes : existing.notes,
      })
      .where(eq(components.id, id))
      .returning();
    return toComponent(row!);
  });

  app.delete("/api/components/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    await db.delete(components).where(eq(components.id, id));
    return reply.code(204).send();
  });
}

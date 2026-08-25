import type { FastifyInstance } from "fastify";
import { desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { FcConfig, Profile, ProfileSettings } from "@dronetuner/shared";
import { TUNE_GOALS } from "@dronetuner/shared";
import type { AppContext } from "../context";
import { profiles } from "../db/schema";
import { buildApplyPlan } from "../services/applyplan";

export const settingsSchema: z.ZodType<ProfileSettings> = z.lazy(() =>
  z.object({
    pids: z
      .object({
        roll: z
          .object({ p: z.number().int().min(0).max(255), i: z.number().int().min(0).max(255), d: z.number().int().min(0).max(255) })
          .partial()
          .optional(),
        pitch: z
          .object({ p: z.number().int().min(0).max(255), i: z.number().int().min(0).max(255), d: z.number().int().min(0).max(255) })
          .partial()
          .optional(),
        yaw: z
          .object({ p: z.number().int().min(0).max(255), i: z.number().int().min(0).max(255), d: z.number().int().min(0).max(255) })
          .partial()
          .optional(),
      })
      .optional(),
    filters: z.record(z.number().int().min(0)).optional(),
    rates: z.record(z.number().int().min(0).max(255)).optional(),
    advanced: z.record(z.number().int().min(0)).optional(),
  }),
);

/** Minimal shape of the decoded FC config needed for diff/apply-plan. */
const fcConfigSchema = z
  .object({
    apiVersion: z.string(),
    pids: z.object({
      roll: z.object({ p: z.number(), i: z.number(), d: z.number() }),
      pitch: z.object({ p: z.number(), i: z.number(), d: z.number() }),
      yaw: z.object({ p: z.number(), i: z.number(), d: z.number() }),
    }),
    filters: z.record(z.number()),
    rates: z.record(z.number()),
    advanced: z.record(z.number()),
  })
  .passthrough();

const createSchema = z.object({
  name: z.string().min(1),
  goal: z.enum([...TUNE_GOALS] as [string, ...string[]]),
  sizeClass: z.string().nullable().optional(),
  droneId: z.number().int().positive().nullable().optional(),
  settings: settingsSchema.optional().default({}),
  source: z.enum(["template", "generated", "snapshot"]).optional().default("template"),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  goal: z.enum([...TUNE_GOALS] as [string, ...string[]]).optional(),
  sizeClass: z.string().nullable().optional(),
  settings: settingsSchema.optional(),
});

function toProfile(row: typeof profiles.$inferSelect): Profile {
  return {
    id: row.id,
    droneId: row.droneId,
    name: row.name,
    goal: row.goal,
    sizeClass: row.sizeClass,
    settings: (row.settingsJson ?? {}) as ProfileSettings,
    source: row.source as Profile["source"],
    createdAt: row.createdAt,
  };
}

export default async function profilesRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db } = opts.ctx;

  app.get("/api/profiles", async (req) => {
    const { droneId, templates } = req.query as { droneId?: string; templates?: string };
    let rows;
    if (templates === "1") {
      rows = await db.select().from(profiles).where(isNull(profiles.droneId)).orderBy(desc(profiles.createdAt));
    } else if (droneId) {
      rows = await db
        .select()
        .from(profiles)
        .where(eq(profiles.droneId, Number(droneId)))
        .orderBy(desc(profiles.createdAt));
    } else {
      rows = await db.select().from(profiles).orderBy(desc(profiles.createdAt));
    }
    return rows.map(toProfile);
  });

  app.get("/api/profiles/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = await db.select().from(profiles).where(eq(profiles.id, id)).get();
    if (!row) return reply.code(404).send({ error: "Profile not found" });
    return toProfile(row);
  });

  app.post("/api/profiles", async (req) => {
    const body = createSchema.parse(req.body);
    const [row] = await db
      .insert(profiles)
      .values({
        name: body.name,
        goal: body.goal,
        sizeClass: body.sizeClass ?? null,
        droneId: body.droneId ?? null,
        settingsJson: body.settings,
        source: body.source,
        createdAt: Date.now(),
      })
      .returning();
    return toProfile(row!);
  });

  app.patch("/api/profiles/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = updateSchema.parse(req.body);
    const existing = await db.select().from(profiles).where(eq(profiles.id, id)).get();
    if (!existing) return reply.code(404).send({ error: "Profile not found" });
    const [row] = await db
      .update(profiles)
      .set({
        name: body.name ?? existing.name,
        goal: body.goal ?? existing.goal,
        sizeClass: body.sizeClass !== undefined ? body.sizeClass : existing.sizeClass,
        settingsJson: body.settings ?? existing.settingsJson,
      })
      .where(eq(profiles.id, id))
      .returning();
    return toProfile(row!);
  });

  app.delete("/api/profiles/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    await db.delete(profiles).where(eq(profiles.id, id));
    return reply.code(204).send();
  });

  app.post("/api/profiles/:id/duplicate", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = await db.select().from(profiles).where(eq(profiles.id, id)).get();
    if (!existing) return reply.code(404).send({ error: "Profile not found" });
    const [row] = await db
      .insert(profiles)
      .values({
        name: `${existing.name} (copy)`,
        goal: existing.goal,
        sizeClass: existing.sizeClass,
        droneId: existing.droneId,
        settingsJson: existing.settingsJson,
        source: existing.source,
        createdAt: Date.now(),
      })
      .returning();
    return toProfile(row!);
  });

  app.post("/api/profiles/:id/apply-plan", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const profile = await db.select().from(profiles).where(eq(profiles.id, id)).get();
    if (!profile) return reply.code(404).send({ error: "Profile not found" });
    const parsed = z.object({ current: fcConfigSchema }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "current FC config required (decoded pids/filters/rates/advanced)" });
    }
    return buildApplyPlan(parsed.data.current as unknown as FcConfig, (profile.settingsJson ?? {}) as ProfileSettings);
  });
}

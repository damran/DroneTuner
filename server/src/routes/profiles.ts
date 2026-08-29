import type { FastifyInstance } from "fastify";
import { desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { FcConfig, Profile, ProfileSettings } from "@dronetuner/shared";
import { TUNE_GOALS } from "@dronetuner/shared";
import type { AppContext } from "../context";
import { profiles } from "../db/schema";
import { buildApplyPlan } from "../services/applyplan";
import templatesData from "../seed/templates.json";

/**
 * Names of the managed seed templates. The seed refreshes these rows in place
 * on every run (so template fixes reach existing installs), which means
 * in-place user edits to them would be silently reverted — reject those edits
 * instead. Duplicated profiles get a " (copy)" name and stay editable.
 */
const SEED_TEMPLATE_NAMES = new Set(templatesData.map((t) => t.name));

const bounded = (min: number, max: number) => z.number().int().min(min).max(max);

/**
 * Key allowlists mirror the managed settings model (shared/types/fc.ts) and
 * bounds follow the BF 4.4/4.5 CLI-valid ranges (settings.c), with the MSP
 * field width as ceiling where BF is wider. Unknown keys are stripped here
 * instead of producing phantom diff rows that patchPayload would silently
 * skip — what the confirm dialog shows is what gets written.
 */
const filtersSchema = z
  .object({
    // LPF cutoffs: BF 4.5 LPF_MAX_HZ / DYN_LPF_MAX_HZ are both 1000.
    gyroLowpassHz: bounded(0, 1000),
    gyroLowpassDynMinHz: bounded(0, 1000),
    gyroLowpassDynMaxHz: bounded(0, 1000),
    gyroLowpassType: bounded(0, 3),
    gyroLowpass2Hz: bounded(0, 1000),
    gyroLowpass2Type: bounded(0, 3),
    yawLowpassHz: bounded(0, 1000),
    dtermLowpassHz: bounded(0, 1000),
    dtermLowpassDynMinHz: bounded(0, 1000),
    dtermLowpassDynMaxHz: bounded(0, 1000),
    dtermLowpassType: bounded(0, 3),
    dtermLowpass2Hz: bounded(0, 1000),
    dtermLowpass2Type: bounded(0, 3),
    dynNotchCount: bounded(0, 5),
    dynNotchMinHz: bounded(20, 250),
    dynNotchMaxHz: bounded(200, 1000),
    dynNotchQ: bounded(1, 1000),
    dynLpfCurveExpo: bounded(0, 10),
    rpmFilterHarmonics: bounded(0, 3),
    rpmFilterMinHz: bounded(30, 200),
    rpmFilterFadeRangeHz: bounded(0, 1000),
    rpmFilterQ: bounded(250, 3000),
    rpmFilterWeight1: bounded(0, 100),
    rpmFilterWeight2: bounded(0, 100),
    rpmFilterWeight3: bounded(0, 100),
  })
  .partial();

const ratesSchema = z
  .object({
    rcRate: bounded(0, 255),
    rcExpo: bounded(0, 255),
    rcRatePitch: bounded(0, 255),
    rcExpoPitch: bounded(0, 255),
    rcRateYaw: bounded(0, 255),
    rcExpoYaw: bounded(0, 255),
    rollRate: bounded(0, 255),
    pitchRate: bounded(0, 255),
    yawRate: bounded(0, 255),
    thrMid: bounded(0, 255),
    thrExpo: bounded(0, 255),
    ratesType: bounded(0, 4),
  })
  .partial();

const advancedSchema = z
  .object({
    // Per-axis feedforward gains: BF 4.5 F_GAIN_MAX is 1000.
    feedforwardRoll: bounded(0, 1000),
    feedforwardPitch: bounded(0, 1000),
    feedforwardYaw: bounded(0, 1000),
    feedforwardTransition: bounded(0, 100),
    feedforwardAveraging: bounded(0, 3),
    feedforwardSmoothFactor: bounded(0, 75),
    feedforwardBoost: bounded(0, 50),
    feedforwardMaxRateLimit: bounded(0, 200),
    feedforwardJitterFactor: bounded(0, 20),
    itermRelax: bounded(0, 4),
    itermRelaxCutoff: bounded(1, 100),
    dMinRoll: bounded(0, 255),
    dMinPitch: bounded(0, 255),
    dMaxGain: bounded(0, 100),
    dMaxAdvance: bounded(0, 200),
    thrustLinear: bounded(0, 100),
    antiGravityGain: bounded(0, 30000),
    tpaMode: bounded(0, 1),
    tpaRate: bounded(0, 100),
    tpaBreakpoint: bounded(1000, 2000),
    vbatSagCompensation: bounded(0, 100),
    idleMinRpm: bounded(0, 200),
  })
  .partial();

export const settingsSchema: z.ZodType<ProfileSettings> = z.lazy(() =>
  z.object({
    pids: z
      .object({
        roll: z
          .object({ p: bounded(0, 255), i: bounded(0, 255), d: bounded(0, 255) })
          .partial()
          .optional(),
        pitch: z
          .object({ p: bounded(0, 255), i: bounded(0, 255), d: bounded(0, 255) })
          .partial()
          .optional(),
        yaw: z
          .object({ p: bounded(0, 255), i: bounded(0, 255), d: bounded(0, 255) })
          .partial()
          .optional(),
      })
      .optional(),
    filters: filtersSchema.optional(),
    rates: ratesSchema.optional(),
    advanced: advancedSchema.optional(),
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
    if (existing.source === "template" && existing.droneId === null && SEED_TEMPLATE_NAMES.has(existing.name)) {
      return reply
        .code(409)
        .send({ error: "Built-in templates are read-only — duplicate the profile to customize it." });
    }
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

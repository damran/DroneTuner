import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ComponentCategory, DroneBaseline, FcConfig, ProfileSettings, VendorPreset } from "@dronetuner/shared";
import { looksLikeCliDump, parseCliDump } from "@dronetuner/shared";
import type { AppContext } from "../context";
import { components, droneComponents, drones, vendorPresets } from "../db/schema";
import { buildApplyPlan } from "../services/applyplan";
import { buildBaseline, type BomEntry } from "../services/baseline";
import { settingsSchema } from "./profiles";

const presetBodySchema = z.object({
  name: z.string().min(1),
  source: z.enum(["upload", "url", "manual"]).optional().default("manual"),
  boardTarget: z.string().nullable().optional(),
  componentId: z.number().int().positive().nullable().optional(),
  droneModel: z.string().nullable().optional(),
  settings: settingsSchema.optional().default({}),
  cliDump: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
});

const importSchema = z.object({
  text: z.string().min(1),
  name: z.string().min(1).optional(),
  componentId: z.number().int().positive().nullable().optional(),
  droneModel: z.string().nullable().optional(),
  boardTarget: z.string().nullable().optional(),
});

const fetchSchema = z.object({
  url: z.string().url(),
  name: z.string().min(1).optional(),
  componentId: z.number().int().positive().nullable().optional(),
  droneModel: z.string().nullable().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  boardTarget: z.string().nullable().optional(),
  componentId: z.number().int().positive().nullable().optional(),
  droneModel: z.string().nullable().optional(),
});

function toPreset(row: typeof vendorPresets.$inferSelect): VendorPreset {
  return {
    id: row.id,
    name: row.name,
    source: row.source as VendorPreset["source"],
    boardTarget: row.boardTarget,
    componentId: row.componentId,
    droneModel: row.droneModel,
    settings: (row.settingsJson ?? {}) as ProfileSettings,
    cliDump: row.cliDump,
    sourceUrl: row.sourceUrl,
    createdAt: row.createdAt,
    vendor: row.vendor,
    sizeClass: row.sizeClass,
    videoSystem: row.videoSystem,
    cells: row.cells,
    bfVersion: row.bfVersion,
    kind: (row.kind === "preset" ? "preset" : "factory") as VendorPreset["kind"],
    variant: row.variant,
    notes: row.notes,
  };
}

export default async function vendorPresetsRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db } = opts.ctx;

  app.get("/api/vendor-presets", async (req) => {
    const { componentId, boardTarget, sizeClass, kind, videoSystem, full } = req.query as {
      componentId?: string;
      boardTarget?: string;
      sizeClass?: string;
      kind?: string;
      videoSystem?: string;
      full?: string;
    };
    let rows = await db.select().from(vendorPresets).orderBy(desc(vendorPresets.createdAt));
    if (componentId) rows = rows.filter((r) => r.componentId === Number(componentId));
    if (boardTarget) rows = rows.filter((r) => r.boardTarget?.toLowerCase() === boardTarget.toLowerCase());
    // "any" catalogue entries (generic presets) match every class/video filter.
    if (sizeClass) rows = rows.filter((r) => !r.sizeClass || r.sizeClass === "any" || r.sizeClass === sizeClass);
    if (videoSystem) rows = rows.filter((r) => !r.videoSystem || r.videoSystem === "any" || r.videoSystem === videoSystem);
    if (kind) rows = rows.filter((r) => r.kind === kind);
    const presets = rows.map(toPreset);
    // The raw dumps are large (up to 40 KB each); list responses omit them unless asked.
    return full === "1" ? presets : presets.map((p) => ({ ...p, cliDump: p.cliDump ? "" : null }));
  });

  app.get("/api/vendor-presets/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = await db.select().from(vendorPresets).where(eq(vendorPresets.id, id)).get();
    if (!row) return reply.code(404).send({ error: "Preset not found" });
    return toPreset(row);
  });

  app.post("/api/vendor-presets", async (req) => {
    const body = presetBodySchema.parse(req.body);
    const [row] = await db
      .insert(vendorPresets)
      .values({
        name: body.name,
        source: body.source,
        boardTarget: body.boardTarget ?? null,
        componentId: body.componentId ?? null,
        droneModel: body.droneModel ?? null,
        settingsJson: body.settings,
        cliDump: body.cliDump ?? null,
        sourceUrl: body.sourceUrl ?? null,
        createdAt: Date.now(),
      })
      .returning();
    return toPreset(row!);
  });

  // Import a pasted/uploaded Betaflight CLI dump as a vendor preset.
  app.post("/api/vendor-presets/import", async (req, reply) => {
    const body = importSchema.parse(req.body);
    const parsed = parseCliDump(body.text);
    if (parsed.recognized.length === 0) {
      return reply.code(422).send({ error: "No recognizable Betaflight settings found in the text" });
    }
    const name =
      body.name ?? parsed.meta.craftName ?? parsed.meta.boardName ?? `Imported preset ${new Date().toLocaleDateString()}`;
    const [row] = await db
      .insert(vendorPresets)
      .values({
        name,
        source: "upload",
        boardTarget: body.boardTarget ?? parsed.meta.boardName ?? parsed.meta.targetName ?? null,
        componentId: body.componentId ?? null,
        droneModel: body.droneModel ?? parsed.meta.craftName ?? null,
        settingsJson: parsed.settings,
        cliDump: body.text,
        sourceUrl: null,
        createdAt: Date.now(),
      })
      .returning();
    return { preset: toPreset(row!), recognized: parsed.recognized, ignored: parsed.ignored, meta: parsed.meta };
  });

  // Fetch a vendor page (Flywoo, BetaFPV, …) and extract an embedded CLI dump.
  app.post("/api/vendor-presets/fetch", async (req, reply) => {
    const body = fetchSchema.parse(req.body);
    let text: string;
    try {
      const res = await fetch(body.url, {
        signal: AbortSignal.timeout(10_000),
        headers: { "user-agent": "DroneTuner/0.1 (+local)" },
      });
      if (!res.ok) return reply.code(502).send({ error: `Fetch failed: HTTP ${res.status}` });
      text = (await res.text()).slice(0, 2_000_000);
    } catch (err) {
      return reply.code(502).send({ error: `Fetch failed: ${(err as Error).message}` });
    }
    if (!looksLikeCliDump(text)) {
      return reply.code(422).send({ error: "No Betaflight CLI dump found on that page" });
    }
    const parsed = parseCliDump(text);
    const name = body.name ?? parsed.meta.craftName ?? parsed.meta.boardName ?? new URL(body.url).hostname;
    const [row] = await db
      .insert(vendorPresets)
      .values({
        name,
        source: "url",
        boardTarget: parsed.meta.boardName ?? parsed.meta.targetName ?? null,
        componentId: body.componentId ?? null,
        droneModel: body.droneModel ?? parsed.meta.craftName ?? null,
        settingsJson: parsed.settings,
        cliDump: text.slice(0, 200_000),
        sourceUrl: body.url,
        createdAt: Date.now(),
      })
      .returning();
    return { preset: toPreset(row!), recognized: parsed.recognized, ignored: parsed.ignored, meta: parsed.meta };
  });

  app.patch("/api/vendor-presets/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = updateSchema.parse(req.body);
    const existing = await db.select().from(vendorPresets).where(eq(vendorPresets.id, id)).get();
    if (!existing) return reply.code(404).send({ error: "Preset not found" });
    const [row] = await db
      .update(vendorPresets)
      .set({
        name: body.name ?? existing.name,
        boardTarget: body.boardTarget !== undefined ? body.boardTarget : existing.boardTarget,
        componentId: body.componentId !== undefined ? body.componentId : existing.componentId,
        droneModel: body.droneModel !== undefined ? body.droneModel : existing.droneModel,
      })
      .where(eq(vendorPresets.id, id))
      .returning();
    return toPreset(row!);
  });

  app.delete("/api/vendor-presets/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    await db.delete(vendorPresets).where(eq(vendorPresets.id, id));
    return reply.code(204).send();
  });

  async function loadBom(droneId: number): Promise<BomEntry[] | null> {
    const drone = await db.select().from(drones).where(eq(drones.id, droneId)).get();
    if (!drone) return null;
    const links = await db.select().from(droneComponents).where(eq(droneComponents.droneId, droneId));
    const bom: BomEntry[] = [];
    for (const link of links) {
      const comp = await db.select().from(components).where(eq(components.id, link.componentId)).get();
      if (comp) {
        bom.push({
          slot: link.slot,
          component: { id: comp.id, name: comp.name, category: comp.category as ComponentCategory },
        });
      }
    }
    return bom;
  }

  // Per-component vendor baselines for a drone, merged (hybrid-aware).
  app.get("/api/drones/:id/baseline", async (req, reply) => {
    const droneId = Number((req.params as { id: string }).id);
    const bom = await loadBom(droneId);
    if (!bom) return reply.code(404).send({ error: "Drone not found" });
    const presets = (await db.select().from(vendorPresets).orderBy(desc(vendorPresets.createdAt))).map(toPreset);
    const baseline: DroneBaseline = buildBaseline(bom, presets);
    return baseline;
  });

  // Diff the live FC config against the merged vendor baseline.
  app.post("/api/drones/:id/baseline-compare", async (req, reply) => {
    const droneId = Number((req.params as { id: string }).id);
    const bom = await loadBom(droneId);
    if (!bom) return reply.code(404).send({ error: "Drone not found" });
    const parsed = z.object({ current: z.record(z.unknown()) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "current FC config required" });
    const presets = (await db.select().from(vendorPresets).orderBy(desc(vendorPresets.createdAt))).map(toPreset);
    const baseline = buildBaseline(bom, presets);
    const plan = buildApplyPlan(parsed.data.current as unknown as FcConfig, baseline.merged);
    return { baseline, plan };
  });
}

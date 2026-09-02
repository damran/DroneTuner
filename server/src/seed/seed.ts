import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, isNull } from "drizzle-orm";
import { parseCliDump, resolvePreset } from "@dronetuner/shared";
import type { Db } from "../db";
import { components, profiles, vendorPresets } from "../db/schema";
import componentsData from "./components.json";
import templatesData from "./templates.json";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.join(__dirname, "vendor-presets");

/** One entry of seed/vendor-presets/index.json. */
export interface VendorSeedEntry {
  file: string;
  name: string;
  vendor: string;
  model: string;
  sizeClass: string;
  videoSystem: string;
  cells: string;
  bfVersion: string;
  sourceUrl: string;
  kind: "factory" | "preset";
  variant: string;
  notes: string;
}

export interface SeedSummary {
  componentsInserted: number;
  templatesInserted: number;
  templatesUpdated: number;
  templatesRemoved: number;
  vendorInserted: number;
  vendorUpdated: number;
  vendorSkipped: string[];
}

/**
 * Seed template names that were replaced by the class/goal/variant system.
 * They are removed on seed so stale rows don't keep matching the wizard.
 */
const OBSOLETE_TEMPLATE_NAMES = [
  "65mm Racing", "65mm Freestyle", "65mm Cinematic", "65mm Efficiency", "65mm Low Noise", "65mm Low Latency",
  "2.5in Racing", "2.5in Freestyle", "2.5in Cinematic", "2.5in Efficiency", "2.5in Low Noise", "2.5in Low Latency",
];

export function loadVendorSeedIndex(dir = VENDOR_DIR): VendorSeedEntry[] {
  const indexPath = path.join(dir, "index.json");
  if (!fs.existsSync(indexPath)) return [];
  return JSON.parse(fs.readFileSync(indexPath, "utf8")) as VendorSeedEntry[];
}

/**
 * Presets `#$ INCLUDE` each other by repo path. Map the include paths we ship
 * to their text so the resolver can inline them.
 */
function presetIncludes(entries: VendorSeedEntry[], dir: string): Record<string, string> {
  const map: Record<string, string> = {};
  const RAW = "https://raw.githubusercontent.com/betaflight/firmware-presets/master/";
  for (const e of entries) {
    if (e.kind !== "preset" || !e.sourceUrl.startsWith(RAW)) continue;
    const repoPath = e.sourceUrl.slice(RAW.length); // presets/4.5/tune/defaults.txt
    const file = path.join(dir, e.file);
    if (fs.existsSync(file)) map[repoPath] = fs.readFileSync(file, "utf8");
  }
  return map;
}

export async function seedVendorPresets(db: Db, dir = VENDOR_DIR): Promise<Pick<SeedSummary, "vendorInserted" | "vendorUpdated" | "vendorSkipped">> {
  const entries = loadVendorSeedIndex(dir);
  const includes = presetIncludes(entries, dir);
  let inserted = 0;
  let updated = 0;
  const skipped: string[] = [];
  for (const e of entries) {
    const file = path.join(dir, e.file);
    if (!fs.existsSync(file)) {
      skipped.push(`${e.file}: missing`);
      continue;
    }
    const raw = fs.readFileSync(file, "utf8");
    let text = e.kind === "preset" ? resolvePreset(raw, { includes }) : raw;
    let parsed = parseCliDump(text);
    let notes = e.notes || null;
    if (parsed.recognized.length === 0 && e.kind === "preset") {
      // Some BNF presets keep every setting inside (unchecked) option blocks;
      // fall back to applying all options so the tune is still extracted.
      text = resolvePreset(raw, { includes, keepUnchecked: true });
      parsed = parseCliDump(text);
      notes = [notes, "Settings extracted with all preset options applied (the preset ships them unchecked)."].filter(Boolean).join(" ");
    }
    if (parsed.recognized.length === 0) {
      skipped.push(`${e.file}: no recognizable settings`);
      continue;
    }
    const values = {
      name: e.name,
      source: "seed" as const,
      boardTarget: parsed.meta.boardName ?? parsed.meta.targetName ?? null,
      componentId: null,
      droneModel: e.model,
      settingsJson: parsed.settings,
      cliDump: raw,
      sourceUrl: e.sourceUrl,
      vendor: e.vendor,
      sizeClass: e.sizeClass,
      videoSystem: e.videoSystem,
      cells: e.cells,
      bfVersion: e.bfVersion,
      kind: e.kind,
      variant: e.variant || null,
      notes,
    };
    const existing = await db
      .select({ id: vendorPresets.id })
      .from(vendorPresets)
      .where(and(eq(vendorPresets.name, e.name), eq(vendorPresets.source, "seed")))
      .get();
    if (existing) {
      await db.update(vendorPresets).set(values).where(eq(vendorPresets.id, existing.id));
      updated++;
    } else {
      await db.insert(vendorPresets).values({ ...values, createdAt: Date.now() });
      inserted++;
    }
  }
  return { vendorInserted: inserted, vendorUpdated: updated, vendorSkipped: skipped };
}

export async function runSeed(db: Db, opts: { vendorDir?: string; log?: (msg: string) => void } = {}): Promise<SeedSummary> {
  const log = opts.log ?? (() => {});
  let componentsInserted = 0;
  const existingComponents = await db.select().from(components).limit(1);
  if (existingComponents.length === 0) {
    for (const c of componentsData) {
      await db.insert(components).values({
        category: c.category,
        name: c.name,
        specsJson: c.specs,
        notes: c.notes ?? null,
      });
      componentsInserted++;
    }
    log(`Seeded ${componentsInserted} components`);
  } else {
    log("Components already seeded, skipping");
  }

  // Templates are managed content: refresh them in place (matched by name)
  // so seed updates reach existing installs, without ever touching
  // user-created or drone-assigned profiles.
  let templatesInserted = 0;
  let templatesUpdated = 0;
  for (const t of templatesData) {
    const existing = await db
      .select()
      .from(profiles)
      .where(and(eq(profiles.name, t.name), eq(profiles.source, "template"), isNull(profiles.droneId)))
      .get();
    const videoSystem = (t as { videoSystem?: string | null }).videoSystem ?? null;
    const notes = (t as { notes?: string | null }).notes ?? null;
    if (existing) {
      await db
        .update(profiles)
        .set({ goal: t.goal, sizeClass: t.sizeClass ?? null, videoSystem, notes, settingsJson: t.settings })
        .where(eq(profiles.id, existing.id));
      templatesUpdated++;
    } else {
      await db.insert(profiles).values({
        name: t.name,
        goal: t.goal,
        sizeClass: t.sizeClass ?? null,
        videoSystem,
        notes,
        settingsJson: t.settings,
        source: "template",
        createdAt: Date.now(),
      });
      templatesInserted++;
    }
  }
  let templatesRemoved = 0;
  for (const name of OBSOLETE_TEMPLATE_NAMES) {
    const rows = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(and(eq(profiles.name, name), eq(profiles.source, "template"), isNull(profiles.droneId)));
    for (const r of rows) {
      await db.delete(profiles).where(eq(profiles.id, r.id));
      templatesRemoved++;
    }
  }
  log(`Profile templates: ${templatesInserted} inserted, ${templatesUpdated} updated, ${templatesRemoved} obsolete removed`);

  const vendor = await seedVendorPresets(db, opts.vendorDir);
  log(`Vendor presets: ${vendor.vendorInserted} inserted, ${vendor.vendorUpdated} updated${vendor.vendorSkipped.length ? `, skipped: ${vendor.vendorSkipped.join("; ")}` : ""}`);

  return { componentsInserted, templatesInserted, templatesUpdated, templatesRemoved, ...vendor };
}

import type {
  BaselineComponent,
  Component,
  ComponentCategory,
  DroneBaseline,
  ProfileSettings,
  VendorPreset,
} from "@dronetuner/shared";
import { COMPONENT_CATEGORIES } from "@dronetuner/shared";

export interface BomEntry {
  slot: string;
  component: Pick<Component, "id" | "name" | "category">;
}

/**
 * Pick the vendor preset for one BOM component: an explicit component
 * assignment wins; otherwise fall back to a drone-model name contained in
 * the component name (e.g. preset droneModel "Meteor65" matches component
 * "Meteor65 Frame"). Latest created preset wins ties.
 */
export function matchPresetForComponent(
  component: Pick<Component, "id" | "name">,
  presets: VendorPreset[],
): VendorPreset | null {
  const assigned = presets.filter((p) => p.componentId === component.id);
  if (assigned.length > 0) return assigned[assigned.length - 1]!;

  const name = component.name.toLowerCase();
  const fuzzy = presets.filter(
    (p) => p.droneModel && name.includes(p.droneModel.trim().toLowerCase()),
  );
  return fuzzy.length > 0 ? fuzzy[fuzzy.length - 1]! : null;
}

/** Merge `add` into `base` leaf-by-leaf, recording provenance in `sources`. */
function mergeSettings(
  base: ProfileSettings,
  add: ProfileSettings,
  presetName: string,
  sources: Record<string, string>,
): void {
  for (const axis of ["roll", "pitch", "yaw"] as const) {
    const terms = add.pids?.[axis];
    if (!terms) continue;
    for (const [term, v] of Object.entries(terms)) {
      if (v === undefined) continue;
      base.pids ??= {};
      base.pids[axis] = { ...base.pids[axis], [term]: v };
      sources[`pids.${axis}.${term}`] = presetName;
    }
  }
  for (const section of ["filters", "rates", "advanced"] as const) {
    const values = add[section];
    if (!values) continue;
    for (const [key, v] of Object.entries(values)) {
      if (v === undefined) continue;
      base[section] = { ...base[section], [key]: v };
      sources[`${section}.${key}`] = presetName;
    }
  }
}

/**
 * Build the merged vendor baseline for a drone. Components are merged in
 * canonical category order (frame first … camera last); on key conflicts
 * the later category's preset wins and `sources` records the winner.
 * This is what makes hybrid builds work: each slot pulls the baseline of
 * its own donor model.
 */
export function buildBaseline(bom: BomEntry[], presets: VendorPreset[]): DroneBaseline {
  const catOrder = (c: ComponentCategory) => COMPONENT_CATEGORIES.indexOf(c);
  const sorted = [...bom].sort((a, b) => catOrder(a.component.category) - catOrder(b.component.category));

  const components: BaselineComponent[] = sorted.map((entry) => ({
    slot: entry.slot,
    componentId: entry.component.id,
    componentName: entry.component.name,
    category: entry.component.category,
    preset: matchPresetForComponent(entry.component, presets),
  }));

  const merged: ProfileSettings = {};
  const sources: Record<string, string> = {};
  for (const c of components) {
    if (c.preset) mergeSettings(merged, c.preset.settings, c.preset.name, sources);
  }

  return { components, merged, sources };
}

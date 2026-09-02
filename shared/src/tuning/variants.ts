/**
 * Crisp / balanced / smooth variants of a tune for the in-flight A/B test.
 *
 * The variant only touches the FILTER chain (and nothing else), so flying
 * profile A, landing, switching to profile B (Betaflight 4.5 only switches
 * PID profiles while disarmed) and flying again isolates the latency-vs-noise
 * trade-off:
 *   - crisp  : fewer/narrower notches, higher cutoffs  → less group delay, less noise margin
 *   - smooth : one more notch, lower cutoffs            → more delay, more margin (cooler motors)
 * PIDs, feedforward, TPA and rates stay identical between variants.
 *
 * Cutoff scaling follows the Betaflight "simplified filter multiplier" idea
 * (one factor for the gyro chain, one for the D chain) rather than ad-hoc
 * per-key edits, so the delay estimator can quantify each variant.
 */
import type { FilterSettings, ProfileSettings } from "../types/fc";

export type TuneVariant = "crisp" | "balanced" | "smooth";
export const TUNE_VARIANTS: readonly TuneVariant[] = ["crisp", "balanced", "smooth"];
export const TUNE_VARIANT_LABELS: Record<TuneVariant, string> = {
  crisp: "Crisp (less filtering)",
  balanced: "Balanced",
  smooth: "Smooth (more filtering)",
};
export const TUNE_VARIANT_DESCRIPTIONS: Record<TuneVariant, string> = {
  crisp:
    "Higher cutoffs, one RPM harmonic, a single narrow notch. Lowest delay: sharper stick feel and better propwash handling if the build is clean; motors run warmer on a noisy build.",
  balanced: "The template as designed: Betaflight 4.5 defaults for the class.",
  smooth:
    "Lower cutoffs, all RPM harmonics, an extra notch. Highest noise margin: quieter motors and no hot-motor risk; ~1-2 ms more delay, slightly softer feel.",
};

interface VariantSpec {
  gyroMult: number;
  dtermMult: number;
  notchDelta: number;
  notchQ: number | null;
  rpmHarmonics: number | null;
  rpmWeights: [number, number, number] | null;
}

const SPECS: Record<TuneVariant, VariantSpec> = {
  crisp: { gyroMult: 1.4, dtermMult: 1.25, notchDelta: 0, notchQ: 600, rpmHarmonics: 1, rpmWeights: [100, 0, 0] },
  balanced: { gyroMult: 1, dtermMult: 1, notchDelta: 0, notchQ: null, rpmHarmonics: null, rpmWeights: null },
  smooth: { gyroMult: 0.8, dtermMult: 0.8, notchDelta: 1, notchQ: 350, rpmHarmonics: 3, rpmWeights: [100, 100, 100] },
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

/** Scale one cutoff (0 = disabled stays disabled). */
function scaleHz(v: number | undefined, mult: number, lo: number, hi: number): number | undefined {
  if (v === undefined || v === 0) return v;
  return clamp(v * mult, lo, hi);
}

/**
 * Which filter keys live in a Betaflight PID PROFILE (and can therefore
 * differ between profile A and B in one flight) versus the MASTER section
 * (gyro LPFs, dynamic notch, RPM filter — shared by every profile).
 */
export const PROFILE_SCOPED_FILTER_KEYS: readonly (keyof FilterSettings)[] = [
  "dtermLowpassHz",
  "dtermLowpassType",
  "dtermLowpassDynMinHz",
  "dtermLowpassDynMaxHz",
  "dtermLowpass2Hz",
  "dtermLowpass2Type",
  "yawLowpassHz",
  "dynLpfCurveExpo",
];

export type VariantScope = "all" | "profile";

/**
 * Apply a variant to a filter set. `scope: "profile"` limits the change to
 * the keys a PID profile owns (the D-term chain) — this is what an in-flight
 * A/B between two PID profiles can actually compare; the master gyro chain
 * would silently apply to both profiles.
 */
export function applyVariantToFilters(
  filters: FilterSettings | undefined,
  variant: TuneVariant,
  scope: VariantScope = "all",
): FilterSettings {
  const f: FilterSettings = { ...(filters ?? {}) };
  const spec = SPECS[variant];
  if (variant === "balanced") return f;

  if (scope === "all") {
    // Gyro chain: static/dynamic LPF1 (usually off with RPM filtering), LPF2 anti-alias.
    f.gyroLowpassHz = scaleHz(f.gyroLowpassHz, spec.gyroMult, 50, 1000);
    f.gyroLowpassDynMinHz = scaleHz(f.gyroLowpassDynMinHz, spec.gyroMult, 50, 1000);
    if (f.gyroLowpassDynMinHz) f.gyroLowpassDynMaxHz = scaleHz(f.gyroLowpassDynMaxHz, spec.gyroMult, 100, 1000);
    f.gyroLowpass2Hz = scaleHz(f.gyroLowpass2Hz, spec.gyroMult, 100, 1000);
  }

  // D chain — never below the 60 Hz floor the D-term needs to stay safe.
  f.dtermLowpassHz = scaleHz(f.dtermLowpassHz, spec.dtermMult, 60, 1000);
  f.dtermLowpassDynMinHz = scaleHz(f.dtermLowpassDynMinHz, spec.dtermMult, 60, 1000);
  f.dtermLowpassDynMaxHz = scaleHz(f.dtermLowpassDynMaxHz, spec.dtermMult, 100, 1000);
  f.dtermLowpass2Hz = scaleHz(f.dtermLowpass2Hz, spec.dtermMult, 80, 1000);

  if (scope === "profile") return f;

  // Dynamic notch: count/Q only — the min/max band is a property of the
  // airframe (frame resonance), not of the variant.
  if (f.dynNotchCount !== undefined) {
    const count = clamp(f.dynNotchCount + spec.notchDelta, 0, 5);
    if (variant === "smooth") f.dynNotchCount = Math.max(1, count);
    // Crisp runs a single notch: a real resonance still needs one, but a
    // second/third notch is delay the crisp side is meant to shed.
    else f.dynNotchCount = Math.min(1, f.dynNotchCount);
  }
  if (spec.notchQ !== null && (f.dynNotchCount ?? 0) > 0) f.dynNotchQ = spec.notchQ;

  // RPM filter: harmonics/weights are CLI-only on 4.5 for weights; harmonics is MSP-writable.
  if (spec.rpmHarmonics !== null && f.rpmFilterHarmonics !== undefined) f.rpmFilterHarmonics = spec.rpmHarmonics;
  if (spec.rpmWeights !== null && f.rpmFilterWeight1 !== undefined) {
    [f.rpmFilterWeight1, f.rpmFilterWeight2, f.rpmFilterWeight3] = spec.rpmWeights;
  }
  return f;
}

/** A copy of `settings` with the variant's filter chain; everything else untouched. */
export function applyVariant(settings: ProfileSettings, variant: TuneVariant, scope: VariantScope = "all"): ProfileSettings {
  if (variant === "balanced") return settings;
  return { ...settings, filters: applyVariantToFilters(settings.filters, variant, scope) };
}

/** Split filter settings into the profile-owned part and the master part. */
export function splitFilterScope(filters: FilterSettings | undefined): { profile: FilterSettings; master: FilterSettings } {
  const profile: FilterSettings = {};
  const master: FilterSettings = {};
  for (const [k, v] of Object.entries(filters ?? {})) {
    if (v === undefined) continue;
    if ((PROFILE_SCOPED_FILTER_KEYS as readonly string[]).includes(k)) (profile as Record<string, number>)[k] = v;
    else (master as Record<string, number>)[k] = v;
  }
  return { profile, master };
}

/** Keys that differ between two filter sets (for the A/B comparison table). */
export function filterDiffKeys(a: FilterSettings | undefined, b: FilterSettings | undefined): string[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...keys].filter((k) => (a as Record<string, unknown> | undefined)?.[k] !== (b as Record<string, unknown> | undefined)?.[k]).sort();
}

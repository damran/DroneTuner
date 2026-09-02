/**
 * In-flight A/B tests: the rate-profile variant and the header fingerprint
 * that tells which side of a test a blackbox session was flown on.
 *
 * Betaflight writes the active PID profile's D-term filters and the active
 * rate profile's curve into every log header (dterm_lpf1_dyn_hz, rc_rates,
 * rates, …) but not the profile index itself, so a session is matched by
 * comparing those values with the two variants that were written.
 */
import type { AbTest, AbTestKind } from "../types/entities";
import type { AdvancedSettings, FilterSettings, PidAxisSettings, ProfileSettings, RateSettings } from "../types/fc";
import { AXES, RATES_TYPE } from "../types/fc";
import { PROFILE_SCOPED_FILTER_KEYS } from "./variants";

/** B side of the rate A/B: centre sensitivity × this, same max rate and expo. */
export const AB_RATE_CENTRE_FACTOR = 1.3;

const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * The "B" rates for a centre-sensitivity A/B (ACTUAL rates only: there the
 * rc_rate IS the centre sensitivity in deg/s ÷ 10, so one knob changes
 * exactly what the pilot feels around centre). Each axis' centre is capped
 * at 90 % of its max rate so the curve keeps bending upward. Null when the
 * rates are not ACTUAL or carry no centre values.
 */
export function rateAbVariant(rates: RateSettings | undefined, factor = AB_RATE_CENTRE_FACTOR): RateSettings | null {
  if (!rates || rates.ratesType !== RATES_TYPE.ACTUAL) return null;
  const pairs: [keyof RateSettings, keyof RateSettings][] = [
    ["rcRate", "rollRate"],
    ["rcRatePitch", "pitchRate"],
    ["rcRateYaw", "yawRate"],
  ];
  const out: RateSettings = { ...rates };
  let changed = false;
  for (const [centreKey, maxKey] of pairs) {
    const centre = rates[centreKey];
    if (centre === undefined) continue;
    const max = rates[maxKey];
    const cap = max !== undefined ? max * 0.9 : 255;
    out[centreKey] = clampByte(Math.min(centre * factor, cap));
    changed = changed || out[centreKey] !== centre;
  }
  return changed ? out : null;
}

export interface AbFingerprint {
  filters: Partial<FilterSettings>;
  rates: Partial<RateSettings>;
  /** rollPID / pitchPID / yawPID headers */
  pids: PidAxisSettings;
  /** ff_weight, d_min, d_max_gain, dyn_idle_min_rpm headers */
  advanced: Partial<AdvancedSettings>;
}

/** PID-profile advanced keys a Betaflight 4.x log header carries (the PID pairs differ in these). */
export const PROFILE_SCOPED_ADVANCED_KEYS: readonly (keyof AdvancedSettings)[] = [
  "feedforwardRoll",
  "feedforwardPitch",
  "feedforwardYaw",
  "dMinRoll",
  "dMinPitch",
  "dMaxGain",
  "idleMinRpm",
];

function headerInt(headers: Record<string, string>, name: string): number | undefined {
  const raw = headers[name];
  if (raw === undefined) return undefined;
  const v = Number.parseInt(raw, 10);
  return Number.isNaN(v) ? undefined : v;
}

function headerTriple(headers: Record<string, string>, name: string): [number, number, number] | undefined {
  const raw = headers[name];
  if (raw === undefined) return undefined;
  const parts = raw.split(",").map((s) => Number.parseInt(s.trim(), 10));
  if (parts.length < 3 || parts.slice(0, 3).some((v) => Number.isNaN(v))) return undefined;
  return [parts[0]!, parts[1]!, parts[2]!];
}

/** The profile-scoped filter keys and the rate curve a Betaflight 4.x log header carries. */
export function abFingerprintFromHeaders(headers: Record<string, string>): AbFingerprint {
  const filters: Partial<FilterSettings> = {};
  const rates: Partial<RateSettings> = {};
  const put = <T extends object>(target: T, key: keyof T, v: number | undefined) => {
    if (v !== undefined) (target as Record<string, number>)[key as string] = v;
  };
  put(filters, "dtermLowpassHz", headerInt(headers, "dterm_lpf1_static_hz") ?? headerInt(headers, "dterm_lowpass_hz"));
  put(filters, "dtermLowpassType", headerInt(headers, "dterm_lpf1_type") ?? headerInt(headers, "dterm_lowpass_type"));
  const dyn = (headers["dterm_lpf1_dyn_hz"] ?? "").split(",").map((s) => Number.parseInt(s.trim(), 10));
  if (dyn.length >= 2 && !Number.isNaN(dyn[0]) && !Number.isNaN(dyn[1])) {
    filters.dtermLowpassDynMinHz = dyn[0]!;
    filters.dtermLowpassDynMaxHz = dyn[1]!;
  } else {
    put(filters, "dtermLowpassDynMinHz", headerInt(headers, "dterm_lpf1_dyn_min_hz"));
    put(filters, "dtermLowpassDynMaxHz", headerInt(headers, "dterm_lpf1_dyn_max_hz"));
  }
  put(filters, "dtermLowpass2Hz", headerInt(headers, "dterm_lpf2_static_hz") ?? headerInt(headers, "dterm_lowpass2_hz"));
  put(filters, "dtermLowpass2Type", headerInt(headers, "dterm_lpf2_type") ?? headerInt(headers, "dterm_lowpass2_type"));
  put(filters, "yawLowpassHz", headerInt(headers, "yaw_lowpass_hz"));
  put(filters, "dynLpfCurveExpo", headerInt(headers, "dterm_lpf1_dyn_expo") ?? headerInt(headers, "dyn_lpf_curve_expo"));

  const rc = headerTriple(headers, "rc_rates");
  if (rc) [rates.rcRate, rates.rcRatePitch, rates.rcRateYaw] = rc;
  const expo = headerTriple(headers, "rc_expo");
  if (expo) [rates.rcExpo, rates.rcExpoPitch, rates.rcExpoYaw] = expo;
  const sr = headerTriple(headers, "rates");
  if (sr) [rates.rollRate, rates.pitchRate, rates.yawRate] = sr;
  put(rates, "ratesType", headerInt(headers, "rates_type"));
  put(rates, "thrMid", headerInt(headers, "thr_mid"));
  put(rates, "thrExpo", headerInt(headers, "thr_expo"));

  const pids: PidAxisSettings = {};
  for (const axis of AXES) {
    const t = headerTriple(headers, `${axis}PID`);
    if (t) pids[axis] = { p: t[0], i: t[1], d: t[2] };
  }
  const advanced: Partial<AdvancedSettings> = {};
  const ff = headerTriple(headers, "ff_weight");
  if (ff) [advanced.feedforwardRoll, advanced.feedforwardPitch, advanced.feedforwardYaw] = ff;
  const dMin = (headers["d_min"] ?? "").split(",").map((v) => Number.parseInt(v.trim(), 10));
  if (dMin.length >= 2 && !Number.isNaN(dMin[0]) && !Number.isNaN(dMin[1])) {
    advanced.dMinRoll = dMin[0]!;
    advanced.dMinPitch = dMin[1]!;
  }
  put(advanced, "dMaxGain", headerInt(headers, "d_max_gain"));
  put(advanced, "idleMinRpm", headerInt(headers, "dyn_idle_min_rpm"));
  return { filters, rates, pids, advanced };
}

export interface AbMatch {
  testId: number;
  kind: AbTestKind;
  side: "A" | "B";
  label: string;
}

/**
 * The part of a variant's settings a log header can confirm for this kind of
 * test, flattened to dotted keys (filters.x, pids.roll.p, advanced.x, rates.x).
 */
function comparable(settings: ProfileSettings, kind: AbTestKind): Record<string, number> {
  const out: Record<string, number> = {};
  if (kind === "pid") {
    for (const [k, v] of Object.entries(settings.filters ?? {})) {
      if (v !== undefined && (PROFILE_SCOPED_FILTER_KEYS as readonly string[]).includes(k)) out[`filters.${k}`] = v;
    }
    for (const axis of AXES) {
      for (const term of ["p", "i", "d"] as const) {
        const v = settings.pids?.[axis]?.[term];
        if (v !== undefined) out[`pids.${axis}.${term}`] = v;
      }
    }
    for (const k of PROFILE_SCOPED_ADVANCED_KEYS) {
      const v = settings.advanced?.[k];
      if (v !== undefined) out[`advanced.${k}`] = v;
    }
  } else {
    for (const [k, v] of Object.entries(settings.rates ?? {})) if (v !== undefined) out[`rates.${k}`] = v;
  }
  return out;
}

/** The header fingerprint flattened the same way as `comparable`. */
function loggedValues(fp: AbFingerprint, kind: AbTestKind): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  if (kind === "pid") {
    for (const [k, v] of Object.entries(fp.filters)) out[`filters.${k}`] = v;
    for (const axis of AXES) {
      for (const term of ["p", "i", "d"] as const) out[`pids.${axis}.${term}`] = fp.pids[axis]?.[term];
    }
    for (const [k, v] of Object.entries(fp.advanced)) out[`advanced.${k}`] = v;
  } else {
    for (const [k, v] of Object.entries(fp.rates)) out[`rates.${k}`] = v;
  }
  return out;
}

/**
 * Which side of which A/B test a flight was flown on. Tests are tried newest
 * first. A variant matches when every value the header can confirm equals
 * the variant's; the two variants must differ in at least one confirmable
 * key, and exactly one of them must match — otherwise the flight is left
 * unlabelled rather than guessed.
 */
export function matchAbTest(headers: Record<string, string>, tests: readonly AbTest[]): AbMatch | null {
  if (tests.length === 0) return null;
  const fp = abFingerprintFromHeaders(headers);
  const sorted = [...tests].sort((a, b) => b.createdAt - a.createdAt);
  for (const test of sorted) {
    if (test.variants.length !== 2) continue;
    const logged = loggedValues(fp, test.kind);
    const [a, b] = test.variants.map((v) => comparable(v.settings, test.kind)) as [Record<string, number>, Record<string, number>];
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const differing = [...keys].filter((k) => a[k] !== b[k] && logged[k] !== undefined);
    if (differing.length === 0) continue;
    const matches = (v: Record<string, number>) =>
      Object.entries(v).every(([k, val]) => logged[k] === undefined || logged[k] === val);
    const ma = matches(a);
    const mb = matches(b);
    if (ma === mb) continue;
    const variant = test.variants[ma ? 0 : 1]!;
    return { testId: test.id, kind: test.kind, side: variant.side, label: variant.label };
  }
  return null;
}

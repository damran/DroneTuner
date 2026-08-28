import type { FilterSettings } from "../types/fc";

/**
 * Filter group-delay estimator — the "delay introduced by the system" number.
 *
 * Builds digital models of the Betaflight 4.4/4.5 filter chain (matching
 * filter.c: PT1, PT2/PT3 as corrected PT1 cascades, RBJ biquad LPF with
 * Q=1/√2, biquad notch) and evaluates the exact group delay (−dφ/dω) of the
 * cascade numerically. Anchors: digital PT1 group delay at its cutoff is
 * 1/(4π·fc), a Butterworth biquad √2/(2π·fc); each RPM notch adds a few
 * tenths of a ms in the control band, a dynamic notch ≈ 1 ms.
 *
 * Worst-case conventions: dynamic lowpasses are evaluated at their MINIMUM
 * cutoff (zero throttle = maximum delay), RPM notches at rpm_filter_min_hz,
 * dynamic notches at the detected resonance or dyn_notch_min_hz.
 */

/** BF filter type enum. */
export const FILTER_TYPE = { PT1: 0, BIQUAD: 1, PT2: 2, PT3: 3 } as const;

/** Cascade correction gains from BF filter.c (pt2FilterGain / pt3FilterGain). */
const PT2_GAIN = 1.553773974;
const PT3_GAIN = 1.961459177;

export interface DelayFilterConfig {
  gyroLowpassHz: number;
  gyroLowpassType: number;
  gyroLowpassDynMinHz: number;
  gyroLowpassDynMaxHz: number;
  gyroLowpass2Hz: number;
  gyroLowpass2Type: number;
  yawLowpassHz: number;
  dtermLowpassHz: number;
  dtermLowpassType: number;
  dtermLowpassDynMinHz: number;
  dtermLowpassDynMaxHz: number;
  dtermLowpass2Hz: number;
  dtermLowpass2Type: number;
  dynNotchCount: number;
  dynNotchMinHz: number;
  dynNotchMaxHz: number;
  dynNotchQ: number;
  dynLpfCurveExpo: number;
  rpmFilterHarmonics: number;
  rpmFilterMinHz: number;
  rpmFilterFadeRangeHz: number;
  rpmFilterQ: number;
  rpmFilterWeight1: number;
  rpmFilterWeight2: number;
  rpmFilterWeight3: number;
}

/** Betaflight 4.5 factory filter defaults. */
export const BF45_FILTER_DEFAULTS: DelayFilterConfig = {
  gyroLowpassHz: 0, // LPF1 disabled by default (dynamic LPF1 active instead)
  gyroLowpassType: FILTER_TYPE.PT1,
  gyroLowpassDynMinHz: 250,
  gyroLowpassDynMaxHz: 500,
  gyroLowpass2Hz: 500,
  gyroLowpass2Type: FILTER_TYPE.PT1,
  yawLowpassHz: 0,
  dtermLowpassHz: 0,
  dtermLowpassType: FILTER_TYPE.BIQUAD,
  dtermLowpassDynMinHz: 70,
  dtermLowpassDynMaxHz: 170,
  dtermLowpass2Hz: 150,
  dtermLowpass2Type: FILTER_TYPE.BIQUAD,
  dynNotchCount: 3,
  dynNotchMinHz: 100,
  dynNotchMaxHz: 600,
  dynNotchQ: 300,
  dynLpfCurveExpo: 5,
  rpmFilterHarmonics: 3,
  rpmFilterMinHz: 100,
  rpmFilterFadeRangeHz: 50,
  rpmFilterQ: 500,
  rpmFilterWeight1: 100,
  rpmFilterWeight2: 100,
  rpmFilterWeight3: 100,
};

/** Biquad/PT1 section: H(z) = (b0 + b1 z⁻¹ + b2 z⁻²) / (1 + a1 z⁻¹ + a2 z⁻²). */
interface Section {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function pt1Section(cutoffHz: number, sampleRateHz: number): Section {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRateHz;
  const alpha = dt / (rc + dt);
  return { b0: alpha, b1: 0, b2: 0, a1: -(1 - alpha), a2: 0 };
}

/** RBJ biquad lowpass, Q = 1/√2 (Butterworth), matching BF biquadFilterInitLPF. */
function biquadLpfSection(cutoffHz: number, sampleRateHz: number): Section {
  const omega = (2 * Math.PI * cutoffHz) / sampleRateHz;
  const sn = Math.sin(omega);
  const cs = Math.cos(omega);
  const alpha = sn / Math.SQRT2; // 2*Q with Q = 1/√2
  const a0 = 1 + alpha;
  return {
    b0: (1 - cs) / 2 / a0,
    b1: (1 - cs) / a0,
    b2: (1 - cs) / 2 / a0,
    a1: (-2 * cs) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** RBJ biquad notch at f0 with quality Q, matching BF's notch init. */
function biquadNotchSection(f0Hz: number, q: number, sampleRateHz: number): Section {
  const omega = (2 * Math.PI * f0Hz) / sampleRateHz;
  const sn = Math.sin(omega);
  const cs = Math.cos(omega);
  const alpha = sn / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: 1 / a0,
    b1: (-2 * cs) / a0,
    b2: 1 / a0,
    a1: (-2 * cs) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Sections for a lowpass stage of the given BF filter type. */
function lowpassSections(type: number, cutoffHz: number, sampleRateHz: number): Section[] {
  switch (type) {
    case FILTER_TYPE.BIQUAD:
      return [biquadLpfSection(cutoffHz, sampleRateHz)];
    case FILTER_TYPE.PT2: {
      const fc = cutoffHz * PT2_GAIN;
      return [pt1Section(fc, sampleRateHz), pt1Section(fc, sampleRateHz)];
    }
    case FILTER_TYPE.PT3: {
      const fc = cutoffHz * PT3_GAIN;
      return [pt1Section(fc, sampleRateHz), pt1Section(fc, sampleRateHz), pt1Section(fc, sampleRateHz)];
    }
    case FILTER_TYPE.PT1:
    default:
      return [pt1Section(cutoffHz, sampleRateHz)];
  }
}

/** H(e^{jω}) of a section; ω in rad/sample. */
function evalSection(s: Section, w: number): { re: number; im: number } {
  const c1 = Math.cos(w);
  const s1 = -Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = -Math.sin(2 * w);
  const nre = s.b0 + s.b1 * c1 + s.b2 * c2;
  const nim = s.b1 * s1 + s.b2 * s2;
  const dre = 1 + s.a1 * c1 + s.a2 * c2;
  const dim = s.a1 * s1 + s.a2 * s2;
  const denom = dre * dre + dim * dim;
  return { re: (nre * dre + nim * dim) / denom, im: (nim * dre - nre * dim) / denom };
}

function phaseOfSections(sections: Section[], w: number): number {
  let re = 1;
  let im = 0;
  for (const s of sections) {
    const h = evalSection(s, w);
    const tre = re * h.re - im * h.im;
    const tim = re * h.im + im * h.re;
    re = tre;
    im = tim;
  }
  return Math.atan2(im, re);
}

/**
 * Group delay of a section cascade at frequency f (Hz), in milliseconds.
 * Finite-difference of the phase response; accurate for smooth filter phase
 * curves (all BF filter types away from exact notch centers).
 */
export function groupDelayMs(sections: Section[], freqHz: number, sampleRateHz: number): number {
  if (sections.length === 0) return 0;
  const w = (2 * Math.PI * freqHz) / sampleRateHz;
  const eps = Math.max(1e-7, w * 1e-4);
  const phiPlus = phaseOfSections(sections, w + eps);
  const phiMinus = phaseOfSections(sections, Math.max(1e-7, w - eps));
  let dphi = phiPlus - phiMinus;
  // unwrap
  if (dphi > Math.PI) dphi -= 2 * Math.PI;
  if (dphi < -Math.PI) dphi += 2 * Math.PI;
  const delaySamples = -dphi / (2 * eps);
  return (delaySamples / sampleRateHz) * 1000;
}

export interface FilterDelayStage {
  name: string;
  ms: number;
  /** which signal path the stage belongs to */
  chain: "gyro" | "dterm" | "yaw";
}

export interface FilterDelayEstimate {
  /** reference frequency the headline numbers are evaluated at (Hz) */
  referenceFreqHz: number;
  /** total gyro-chain delay at the reference frequency, 0% throttle (P path) */
  gyroMs: number;
  /** gyro + D-term chain delay, 0% throttle (D path, worst case) */
  dtermMs: number;
  /** gyro + yaw LPF delay (yaw P path), 0% throttle */
  yawMs: number;
  /** same totals with dynamic LPFs at their MAX cutoff (100% throttle) */
  gyroMsMax: number;
  dtermMsMax: number;
  yawMsMax: number;
  stages: FilterDelayStage[];
  /** assumptions/fallbacks applied (missing rates, defaults used, …) */
  warnings: string[];
}

export interface DelayEstimateOptions {
  gyroRateHz?: number | null;
  pidLoopRateHz?: number | null;
  /** detected frame resonance to position the dynamic notch (defaults to dynNotchMinHz) */
  resonanceHz?: number | null;
  /** reference frequency for the headline numbers (default 50 Hz — mid control band) */
  referenceFreqHz?: number;
}

interface BuiltStage {
  name: string;
  sections: Section[];
  chain: "gyro" | "dterm" | "yaw";
}

function buildStages(
  config: DelayFilterConfig,
  gyroRate: number,
  pidRate: number,
  resonanceHz: number | null,
  /** false = dynamic LPFs at min cutoff (0% throttle), true = at max (100%) */
  dynMax: boolean,
): BuiltStage[] {
  const stages: BuiltStage[] = [];

  // RPM filter bank (gyro rate): one notch per active harmonic, worst case at
  // rpm_filter_min_hz (delay falls as the motor frequency rises).
  const harmonics = Math.round(config.rpmFilterHarmonics);
  const weights = [config.rpmFilterWeight1, config.rpmFilterWeight2, config.rpmFilterWeight3];
  if (harmonics > 0 && config.rpmFilterMinHz > 0) {
    const sections: Section[] = [];
    for (let h = 0; h < Math.min(3, harmonics); h++) {
      if (weights[h]! <= 0) continue;
      // CLI Q values are centi-Q (rpm_filter_q 500 → Q 5.0 in firmware)
      sections.push(biquadNotchSection(config.rpmFilterMinHz * (h + 1), config.rpmFilterQ / 100, gyroRate));
    }
    if (sections.length > 0) {
      stages.push({ name: `RPM filter (${sections.length} notch${sections.length > 1 ? "es" : ""})`, sections, chain: "gyro" });
    }
  }

  // Dynamic notch (gyro rate), positioned at the detected resonance or its
  // minimum frequency (worst case).
  const notchCount = Math.round(config.dynNotchCount);
  if (notchCount > 0) {
    const f0 = resonanceHz && resonanceHz >= config.dynNotchMinHz ? resonanceHz : config.dynNotchMinHz;
    const sections: Section[] = [];
    // dyn_notch_q is centi-Q (300 → Q 3.0)
    for (let k = 0; k < notchCount; k++) sections.push(biquadNotchSection(f0, config.dynNotchQ / 100, gyroRate));
    stages.push({ name: `Dynamic notch ×${notchCount} @ ${Math.round(f0)} Hz`, sections, chain: "gyro" });
  }

  // Gyro LPF1: dynamic (min..max) overrides the static value when active.
  const gyroDyn = config.gyroLowpassDynMinHz > 0 && config.gyroLowpassDynMaxHz > config.gyroLowpassDynMinHz;
  const gyroLpf1Hz = gyroDyn
    ? dynMax
      ? config.gyroLowpassDynMaxHz
      : config.gyroLowpassDynMinHz
    : config.gyroLowpassHz;
  if (gyroLpf1Hz > 0) {
    stages.push({
      name: gyroDyn
        ? `Gyro LPF1 (dyn, ${dynMax ? config.gyroLowpassDynMaxHz : config.gyroLowpassDynMinHz} Hz)`
        : `Gyro LPF1 (${gyroLpf1Hz} Hz)`,
      sections: lowpassSections(config.gyroLowpassType, gyroLpf1Hz, gyroRate),
      chain: "gyro",
    });
  }
  if (config.gyroLowpass2Hz > 0) {
    stages.push({
      name: `Gyro LPF2 (${config.gyroLowpass2Hz} Hz)`,
      sections: lowpassSections(config.gyroLowpass2Type, config.gyroLowpass2Hz, gyroRate),
      chain: "gyro",
    });
  }
  if (config.yawLowpassHz > 0) {
    stages.push({
      name: `Yaw LPF (${config.yawLowpassHz} Hz)`,
      sections: lowpassSections(FILTER_TYPE.PT1, config.yawLowpassHz, gyroRate),
      chain: "yaw",
    });
  }

  // D-term filters run at the PID loop rate.
  const dtermDyn = config.dtermLowpassDynMinHz > 0 && config.dtermLowpassDynMaxHz > config.dtermLowpassDynMinHz;
  const dtermLpf1Hz = dtermDyn
    ? dynMax
      ? config.dtermLowpassDynMaxHz
      : config.dtermLowpassDynMinHz
    : config.dtermLowpassHz;
  if (dtermLpf1Hz > 0) {
    stages.push({
      name: dtermDyn
        ? `D-term LPF1 (dyn, ${dynMax ? config.dtermLowpassDynMaxHz : config.dtermLowpassDynMinHz} Hz)`
        : `D-term LPF1 (${dtermLpf1Hz} Hz)`,
      sections: lowpassSections(config.dtermLowpassType, dtermLpf1Hz, pidRate),
      chain: "dterm",
    });
  }
  if (config.dtermLowpass2Hz > 0) {
    stages.push({
      name: `D-term LPF2 (${config.dtermLowpass2Hz} Hz)`,
      sections: lowpassSections(config.dtermLowpass2Type, config.dtermLowpass2Hz, pidRate),
      chain: "dterm",
    });
  }

  return stages;
}

export function estimateFilterDelay(
  config: DelayFilterConfig,
  options: DelayEstimateOptions = {},
): FilterDelayEstimate {
  const { resonanceHz = null, referenceFreqHz = 50 } = options;
  const warnings: string[] = [];
  let gyroRate = options.gyroRateHz ?? null;
  let pidRate = options.pidLoopRateHz ?? null;
  if (!gyroRate || gyroRate <= 0) {
    gyroRate = 8000;
    warnings.push("Gyro rate unknown — assuming 8 kHz.");
  }
  if (!pidRate || pidRate <= 0) {
    pidRate = 4000;
    warnings.push("PID loop rate unknown — assuming 4 kHz.");
  }

  const totals = (dynMax: boolean) => {
    const stages = buildStages(config, gyroRate!, pidRate!, resonanceHz, dynMax);
    const stageDelays: FilterDelayStage[] = stages.map((s) => ({
      name: s.name,
      ms: groupDelayMs(s.sections, referenceFreqHz, s.chain === "dterm" ? pidRate! : gyroRate!),
      chain: s.chain,
    }));
    const sum = (chain: "gyro" | "dterm" | "yaw") =>
      stageDelays.filter((s) => s.chain === chain).reduce((a, s) => a + s.ms, 0);
    const gyroMs = sum("gyro");
    return { stageDelays, gyroMs, dtermMs: gyroMs + sum("dterm"), yawMs: gyroMs + sum("yaw") };
  };

  const worst = totals(false);
  const best = totals(true);

  return {
    referenceFreqHz,
    gyroMs: worst.gyroMs,
    dtermMs: worst.dtermMs,
    yawMs: worst.yawMs,
    gyroMsMax: best.gyroMs,
    dtermMsMax: best.dtermMs,
    yawMsMax: best.yawMs,
    stages: worst.stageDelays,
    warnings,
  };
}

const FILTER_TYPE_NAMES: Record<string, number> = { PT1: 0, BIQUAD: 1, PT2: 2, PT3: 3 };

/** Clamp a parsed header int; returns null when absent or unparseable. */
function clampInt(v: number | null, min: number, max: number): number | null {
  if (v === null || Number.isNaN(v)) return null;
  return Math.max(min, Math.min(max, v));
}

function headerInt(headers: Record<string, string>, ...names: string[]): number | null {
  for (const name of names) {
    const raw = headers[name];
    if (raw === undefined) continue;
    const v = Number.parseFloat(raw);
    if (!Number.isNaN(v)) return Math.round(v);
  }
  return null;
}

function headerFilterType(headers: Record<string, string>, ...names: string[]): number | null {
  for (const name of names) {
    const raw = headers[name];
    if (raw === undefined) continue;
    const asInt = Number.parseInt(raw, 10);
    if (!Number.isNaN(asInt)) return asInt;
    const byName = FILTER_TYPE_NAMES[raw.trim().toUpperCase()];
    if (byName !== undefined) return byName;
  }
  return null;
}

/** Parse a "min,max" header pair (blackbox logs dyn LPF ranges as one pair). */
function headerPair(headers: Record<string, string>, name: string): [number, number] | null {
  const raw = headers[name];
  if (!raw) return null;
  const parts = raw.split(",").map((s) => Number.parseInt(s.trim(), 10));
  if (parts.length < 2 || parts.some((v) => Number.isNaN(v))) return null;
  return [parts[0]!, parts[1]!];
}

/**
 * Filter config in effect during a flight, from blackbox log headers.
 * Blackbox logs its own header names (e.g. `dterm_lpf1_dyn_hz:75,150` as a
 * pair, `dterm_lpf1_dyn_expo`), not the CLI names — those come first, then
 * CLI-style names, then BF 4.5 defaults.
 */
export function filterConfigFromHeaders(headers: Record<string, string>): DelayFilterConfig {
  const d = BF45_FILTER_DEFAULTS;
  const int = (...names: string[]) => headerInt(headers, ...names);
  const type = (...names: string[]) => headerFilterType(headers, ...names);
  const weights = (headers["rpm_filter_weights"] ?? "").split(",").map((s) => Number.parseInt(s.trim(), 10));
  const gyroDyn = headerPair(headers, "gyro_lpf1_dyn_hz");
  const dtermDyn = headerPair(headers, "dterm_lpf1_dyn_hz");

  // Headers are untrusted file content — clamp to BF-valid ranges so a
  // corrupt log can't trigger huge allocations or NaN filter math (Q=0
  // divides by zero in the notch model).
  const cutoff = (v: number | null) => clampInt(v, 0, 4000);
  return {
    gyroLowpassHz: cutoff(int("gyro_lpf1_static_hz", "gyro_lowpass_hz")) ?? d.gyroLowpassHz,
    gyroLowpassType: type("gyro_lpf1_type", "gyro_lowpass_type") ?? d.gyroLowpassType,
    gyroLowpassDynMinHz: cutoff(gyroDyn?.[0] ?? int("gyro_lpf1_dyn_min_hz", "dyn_lpf_gyro_min_hz", "gyro_lowpass_dyn_min_hz")) ?? d.gyroLowpassDynMinHz,
    gyroLowpassDynMaxHz: cutoff(gyroDyn?.[1] ?? int("gyro_lpf1_dyn_max_hz", "dyn_lpf_gyro_max_hz", "gyro_lowpass_dyn_max_hz")) ?? d.gyroLowpassDynMaxHz,
    gyroLowpass2Hz: cutoff(int("gyro_lpf2_static_hz", "gyro_lowpass2_hz")) ?? d.gyroLowpass2Hz,
    gyroLowpass2Type: type("gyro_lpf2_type", "gyro_lowpass2_type") ?? d.gyroLowpass2Type,
    yawLowpassHz: cutoff(int("yaw_lowpass_hz")) ?? d.yawLowpassHz,
    dtermLowpassHz: cutoff(int("dterm_lpf1_static_hz", "dterm_lowpass_hz")) ?? d.dtermLowpassHz,
    dtermLowpassType: type("dterm_lpf1_type", "dterm_lowpass_type") ?? d.dtermLowpassType,
    dtermLowpassDynMinHz: cutoff(dtermDyn?.[0] ?? int("dterm_lpf1_dyn_min_hz", "dterm_lowpass_dyn_min_hz")) ?? d.dtermLowpassDynMinHz,
    dtermLowpassDynMaxHz: cutoff(dtermDyn?.[1] ?? int("dterm_lpf1_dyn_max_hz", "dterm_lowpass_dyn_max_hz")) ?? d.dtermLowpassDynMaxHz,
    dtermLowpass2Hz: cutoff(int("dterm_lpf2_static_hz", "dterm_lowpass2_hz")) ?? d.dtermLowpass2Hz,
    dtermLowpass2Type: type("dterm_lpf2_type", "dterm_lowpass2_type") ?? d.dtermLowpass2Type,
    dynNotchCount: clampInt(int("dyn_notch_count"), 0, 5) ?? d.dynNotchCount,
    dynNotchMinHz: clampInt(int("dyn_notch_min_hz"), 20, 250) ?? d.dynNotchMinHz,
    dynNotchMaxHz: clampInt(int("dyn_notch_max_hz"), 200, 1000) ?? d.dynNotchMaxHz,
    dynNotchQ: clampInt(int("dyn_notch_q"), 1, 1000) ?? d.dynNotchQ,
    dynLpfCurveExpo: clampInt(int("dterm_lpf1_dyn_expo", "dyn_lpf_curve_expo"), 0, 10) ?? d.dynLpfCurveExpo,
    rpmFilterHarmonics: clampInt(int("rpm_filter_harmonics"), 0, 3) ?? d.rpmFilterHarmonics,
    rpmFilterMinHz: clampInt(int("rpm_filter_min_hz"), 30, 200) ?? d.rpmFilterMinHz,
    rpmFilterFadeRangeHz: clampInt(int("rpm_filter_fade_range_hz"), 0, 1000) ?? d.rpmFilterFadeRangeHz,
    rpmFilterQ: clampInt(int("rpm_filter_q"), 250, 3000) ?? d.rpmFilterQ,
    rpmFilterWeight1: clampInt(weights[0] ?? null, 0, 100) ?? d.rpmFilterWeight1,
    rpmFilterWeight2: clampInt(weights[1] ?? null, 0, 100) ?? d.rpmFilterWeight2,
    rpmFilterWeight3: clampInt(weights[2] ?? null, 0, 100) ?? d.rpmFilterWeight3,
  };
}

/** Delay config for a draft profile: profile filters merged over BF 4.5 defaults. */
export function filterConfigFromProfile(settings: { filters?: Partial<FilterSettings> }): DelayFilterConfig {
  const f = settings.filters ?? {};
  const out: DelayFilterConfig = { ...BF45_FILTER_DEFAULTS };
  for (const key of Object.keys(BF45_FILTER_DEFAULTS) as (keyof DelayFilterConfig)[]) {
    const v = f[key as keyof FilterSettings];
    if (typeof v === "number") out[key] = v;
  }
  return out;
}

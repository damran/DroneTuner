import { AXES } from "../types/fc";
import type { LogMetrics } from "./types";

/**
 * "Current vs previous blackbox" comparison: what changed in the config
 * (from log headers) and what changed in the measured results (metrics),
 * with direction-aware verdicts. This is the tuning loop's feedback view —
 * "I raised the RPM filter Q → motor noise went down, delay went down".
 */

export interface CompareInput {
  metrics: LogMetrics;
  headers: Record<string, string>;
}

export interface SettingChange {
  key: string;
  from: string;
  to: string;
}

export type Verdict = "better" | "worse" | "neutral";

export interface MetricDelta {
  label: string;
  from: string;
  to: string;
  /** signed numeric delta when meaningful (null for textual rows) */
  delta: number | null;
  verdict: Verdict;
  detail?: string;
}

export interface AnalysisComparison {
  /** tuning-relevant settings that changed between the two logs */
  settingChanges: SettingChange[];
  /** count of other header changes not in the tuning-relevant list */
  otherChangesCount: number;
  metricDeltas: MetricDelta[];
  /** caveats (e.g. one side predates a metric) */
  warnings: string[];
}

/** Header prefixes considered tuning-relevant for the settings diff. */
const TUNING_HEADER_PATTERNS: RegExp[] = [
  /^dyn_notch/,
  /^rpm_filter/,
  /^gyro_lpf/,
  /^gyro_lowpass/,
  /^dterm_lpf/,
  /^dterm_lowpass/,
  /^yaw_lowpass/,
  /^dyn_lpf/,
  /^rc_rates/,
  /^rc_expo/,
  /^rates/,
  /^rate_limits/,
  /^tpa/,
  /^feedforward/,
  /^d_min/,
  /^d_max/,
  /^iterm/,
  /^anti_gravity/,
  /^pids/,
  /^[pid]_(roll|pitch|yaw)/,
  /^throttle/,
  /^thr_/,
  /^rc_smoothing/,
  /^dyn_idle/,
  /^vbat_sag/,
  /^thrust_linear/,
];

function isTuningHeader(key: string): boolean {
  return TUNING_HEADER_PATTERNS.some((re) => re.test(key));
}

function deltaVerdict(delta: number, lowerIsBetter: boolean, deadband = 0): Verdict {
  if (Math.abs(delta) <= deadband) return "neutral";
  const improved = lowerIsBetter ? delta < 0 : delta > 0;
  return improved ? "better" : "worse";
}

function fmt(v: number | null | undefined, digits = 1, unit = ""): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${v.toFixed(digits)}${unit}`;
}

export function compareAnalyses(current: CompareInput, previous: CompareInput): AnalysisComparison {
  const warnings: string[] = [];

  // ---- Settings diff (headers) ----
  const settingChanges: SettingChange[] = [];
  let otherChangesCount = 0;
  const keys = new Set([...Object.keys(current.headers), ...Object.keys(previous.headers)]);
  for (const key of [...keys].sort()) {
    const from = previous.headers[key];
    const to = current.headers[key];
    if (from === to) continue;
    if (isTuningHeader(key)) {
      settingChanges.push({ key, from: from ?? "—", to: to ?? "—" });
    } else {
      otherChangesCount++;
    }
  }

  // ---- Metric deltas ----
  const metricDeltas: MetricDelta[] = [];
  const cm = current.metrics;
  const pm = previous.metrics;

  // Noise floor per axis (lower better)
  for (const axis of AXES) {
    const from = pm.noiseFloor[axis];
    const to = cm.noiseFloor[axis];
    if (from > 0 && to > 0) {
      const pct = ((to - from) / from) * 100;
      metricDeltas.push({
        label: `${axis} noise floor`,
        from: from.toFixed(2),
        to: to.toFixed(2),
        delta: pct,
        verdict: deltaVerdict(pct, true, 5),
        detail: `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`,
      });
    }
  }

  // Frame resonances: appeared / gone / moved
  const resOf = (m: LogMetrics) =>
    (m.spectral ?? [])
      .flatMap((s) => s.peaks)
      .filter((p) => p.kind === "frameResonance")
      .map((p) => p.freqHz);
  const curRes = resOf(cm);
  const prevRes = resOf(pm);
  if (cm.spectral && pm.spectral) {
    const gone = prevRes.filter((f) => !curRes.some((g) => Math.abs(g - f) < 25));
    const appeared = curRes.filter((f) => !prevRes.some((g) => Math.abs(g - f) < 25));
    if (gone.length > 0) {
      metricDeltas.push({
        label: "Frame resonance gone",
        from: gone.map((f) => `${Math.round(f)} Hz`).join(", "),
        to: "—",
        delta: null,
        verdict: "better",
      });
    }
    if (appeared.length > 0) {
      metricDeltas.push({
        label: "New frame resonance",
        from: "—",
        to: appeared.map((f) => `${Math.round(f)} Hz`).join(", "),
        delta: null,
        verdict: "worse",
      });
    }
  } else {
    warnings.push("One of the analyses predates spectral classification — resonance comparison skipped.");
  }

  // D-term RMS per axis (lower better)
  for (const axis of AXES) {
    const from = pm.dtermRms[axis];
    const to = cm.dtermRms[axis];
    if (from > 0 && to > 0) {
      const pct = ((to - from) / from) * 100;
      metricDeltas.push({
        label: `${axis} D-term RMS`,
        from: from.toFixed(0),
        to: to.toFixed(0),
        delta: pct,
        verdict: deltaVerdict(pct, true, 5),
        detail: `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`,
      });
    }
  }

  // Step response per axis: overshoot (target band 5–15%), rise time (lower better)
  for (const axis of AXES) {
    const cs = cm.stepResponse.find((s) => s.axis === axis);
    const ps = pm.stepResponse.find((s) => s.axis === axis);
    if (!cs || !ps || cs.stepCount === 0 || ps.stepCount === 0) continue;

    const dOver = cs.overshootPercent - ps.overshootPercent;
    // Overshoot verdict: closer to the 5–15% ideal band is better.
    const bandDist = (v: number) => (v < 5 ? 5 - v : v > 15 ? v - 15 : 0);
    const overVerdict = deltaVerdict(bandDist(cs.overshootPercent) - bandDist(ps.overshootPercent), true, 1);
    metricDeltas.push({
      label: `${axis} overshoot`,
      from: fmt(ps.overshootPercent, 0, "%"),
      to: fmt(cs.overshootPercent, 0, "%"),
      delta: dOver,
      verdict: overVerdict,
    });

    const dRise = cs.riseTimeMs - ps.riseTimeMs;
    metricDeltas.push({
      label: `${axis} rise time`,
      from: fmt(ps.riseTimeMs, 0, " ms"),
      to: fmt(cs.riseTimeMs, 0, " ms"),
      delta: dRise,
      verdict: deltaVerdict(dRise, true, 2),
    });
  }

  // Motor saturation (lower better)
  if (pm.motorSaturationPercent > 0 || cm.motorSaturationPercent > 0) {
    const d = cm.motorSaturationPercent - pm.motorSaturationPercent;
    metricDeltas.push({
      label: "Motor saturation",
      from: fmt(pm.motorSaturationPercent, 1, "%"),
      to: fmt(cm.motorSaturationPercent, 1, "%"),
      delta: d,
      verdict: deltaVerdict(d, true, 0.5),
    });
  }

  // Filter delay (lower better)
  if (cm.filterDelay && pm.filterDelay) {
    const d = cm.filterDelay.dtermMs - pm.filterDelay.dtermMs;
    metricDeltas.push({
      label: "Filter delay (D path)",
      from: fmt(pm.filterDelay.dtermMs, 2, " ms"),
      to: fmt(cm.filterDelay.dtermMs, 2, " ms"),
      delta: d,
      verdict: deltaVerdict(d, true, 0.05),
    });
  } else if (cm.filterDelay || pm.filterDelay) {
    warnings.push("One of the analyses predates the delay estimator — delay comparison skipped.");
  }

  // Battery sag (lower better)
  if (cm.vbatSagV !== null && pm.vbatSagV !== null) {
    const d = cm.vbatSagV - pm.vbatSagV;
    metricDeltas.push({
      label: "Battery sag",
      from: fmt(pm.vbatSagV, 2, " V"),
      to: fmt(cm.vbatSagV, 2, " V"),
      delta: d,
      verdict: deltaVerdict(d, true, 0.1),
    });
  }

  return { settingChanges, otherChangesCount, metricDeltas, warnings };
}

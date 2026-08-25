import type { Finding, LogMetrics, Recommendation } from "../analysis/types";
import type { ProfileSettings } from "../types/fc";
import { goalWeights } from "./goals";

export interface RuleOutput {
  findings: Finding[];
  recommendations: Recommendation[];
}

/**
 * Merge signed deltas onto a base profile. Numeric leaves are added (and
 * clamped to a sane per-key range); undefined base leaves take the delta
 * directly (negative deltas on an undefined base are skipped — we can't
 * lower a value we don't know).
 */
export function applyChanges(base: ProfileSettings, changes: ProfileSettings): ProfileSettings {
  const out: ProfileSettings = { ...base };

  if (changes.pids) {
    out.pids = { ...base.pids };
    for (const axis of ["roll", "pitch", "yaw"] as const) {
      const c = changes.pids[axis];
      if (!c) continue;
      out.pids[axis] = { ...base.pids?.[axis] };
      for (const term of ["p", "i", "d"] as const) {
        const delta = c[term];
        if (delta === undefined) continue;
        const cur = base.pids?.[axis]?.[term];
        if (cur === undefined) {
          if (delta < 0) continue;
          out.pids[axis]![term] = clamp(delta, 0, 255);
        } else {
          out.pids[axis]![term] = clamp(cur + delta, 0, 255);
        }
      }
    }
  }

  if (changes.filters) {
    out.filters = { ...base.filters };
    for (const [key, delta] of Object.entries(changes.filters)) {
      if (delta === undefined) continue;
      const cur = base.filters?.[key as keyof typeof base.filters];
      if (cur === undefined && delta < 0) continue;
      out.filters[key as keyof typeof out.filters] = clamp(
        cur === undefined ? delta : (cur as number) + delta,
        ...FILTER_BOUNDS(key),
      );
    }
  }

  if (changes.rates) {
    out.rates = { ...base.rates };
    for (const [key, delta] of Object.entries(changes.rates)) {
      if (delta === undefined) continue;
      const cur = base.rates?.[key as keyof typeof base.rates];
      if (cur === undefined && delta < 0) continue;
      out.rates[key as keyof typeof out.rates] = clamp(
        cur === undefined ? delta : (cur as number) + delta,
        0,
        255,
      );
    }
  }

  if (changes.advanced) {
    out.advanced = { ...base.advanced };
    for (const [key, delta] of Object.entries(changes.advanced)) {
      if (delta === undefined) continue;
      const cur = base.advanced?.[key as keyof typeof base.advanced];
      if (cur === undefined && delta < 0) continue;
      out.advanced[key as keyof typeof out.advanced] = clamp(
        cur === undefined ? delta : (cur as number) + delta,
        ...ADVANCED_BOUNDS(key),
      );
    }
  }

  return out;
}

/** [min, max] for filter settings (BF 4.4/4.5 valid ranges). */
function FILTER_BOUNDS(key: string): [number, number] {
  if (key === "dynNotchCount") return [0, 5];
  if (key === "dynNotchQ") return [20, 1000];
  if (key.endsWith("Type")) return [0, 3]; // PT1/BIQUAD/PT2/PT3 enum
  if (key.startsWith("dterm")) return [0, 500]; // D-term LPF cutoffs
  return [0, 1000]; // gyro cutoffs / notch frequencies
}

function ADVANCED_BOUNDS(key: string): [number, number] {
  if (key === "tpaBreakpoint") return [900, 2200];
  if (key === "antiGravityGain") return [0, 30000];
  return [0, 255];
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v)));
}

/**
 * Rule engine: metrics → findings → goal-weighted recommendations.
 * Recommendations carry signed deltas (applyChanges() turns them into a
 * concrete profile against a baseline).
 *
 * `base` is the profile the deltas will be applied to (e.g. the selected
 * template); absolute-style fixes (like widening the dynamic notch range to
 * cover a resonance) are expressed as deltas relative to `base`. When no
 * base is given, Betaflight 4.5 defaults are assumed (dyn_notch 3 ×
 * 150–600 Hz).
 */
export function runRules(metrics: LogMetrics, goal: string, base?: ProfileSettings): RuleOutput {
  const weights = goalWeights(goal);
  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];
  let id = 0;

  const add = (finding: Omit<Finding, "id">, rec?: Omit<Recommendation, "id">): void => {
    const fid = `f${id++}`;
    findings.push({ id: fid, ...finding });
    if (rec) recommendations.push({ id: `r${id++}`, findingId: fid, ...rec });
  };

  // 1. Frame resonances / gyro noise peaks
  const strongPeaks = metrics.noisePeaks
    .filter((p) => p.freqHz >= 40 && p.freqHz <= 500)
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, 2);
  const baseNotchMin = base?.filters?.dynNotchMinHz ?? 150;
  const baseNotchMax = base?.filters?.dynNotchMaxHz ?? 600;
  const baseNotchCount = base?.filters?.dynNotchCount ?? 3;
  for (const peak of strongPeaks) {
    const floor = metrics.noiseFloor[peak.axis] || 1;
    const ratio = peak.magnitude / floor;
    const severity = ratio > 8 ? "critical" : ratio > 4 ? "warning" : "info";
    const notchMin = Math.max(60, Math.round(peak.freqHz * 0.7));
    const notchMax = Math.max(notchMin + 40, Math.round(peak.freqHz * 1.5));
    // Widen the existing dynamic notch range to cover the resonance, as
    // deltas relative to the base profile (or BF defaults).
    const targetMin = Math.min(baseNotchMin, notchMin);
    const targetMax = Math.max(baseNotchMax, notchMax);
    const filters: Record<string, number> = {};
    if (targetMin !== baseNotchMin) filters.dynNotchMinHz = targetMin - baseNotchMin;
    if (targetMax !== baseNotchMax) filters.dynNotchMaxHz = targetMax - baseNotchMax;
    if (baseNotchCount < 3) filters.dynNotchCount = 3 - baseNotchCount;
    add(
      {
        severity,
        title: `${cap(peak.axis)} resonance ~${Math.round(peak.freqHz)} Hz`,
        detail: `A spectral peak at ~${Math.round(peak.freqHz)} Hz on the ${peak.axis} axis (${ratio.toFixed(
          1,
        )}× the noise floor) usually indicates a frame/prop resonance. A dynamic notch covering it will cut the noise without adding much latency.`,
        relatedMetrics: ["noisePeaks"],
      },
      Object.keys(filters).length > 0
        ? {
            rationale: `Widen the dynamic notch to ${targetMin}–${targetMax} Hz to cover the ${Math.round(peak.freqHz)} Hz resonance on ${peak.axis}.`,
            changes: { filters },
            score: 0.5 * weights.smoothness + 0.3 * weights.response,
          }
        : undefined,
    );
  }

  // 2. D-term noise (dtermRms is in raw PID-sum units — thresholds are
  // empirical for BF 4.x logs: a clean quad cruises below ~120 RMS)
  for (const axis of ["roll", "pitch", "yaw"] as const) {
    const rms = metrics.dtermRms[axis] ?? 0;
    if (rms > 120) {
      add(
        {
          severity: rms > 250 ? "critical" : "warning",
          title: `${cap(axis)} D-term is noisy`,
          detail: `D-term activity on ${axis} is high (RMS ${rms.toFixed(
            0,
          )} in PID-sum units), which shows up as hot motors and propwash oscillation. Lowering the D-term dynamic lowpass ceiling will smooth it.`,
          relatedMetrics: ["dtermRms"],
        },
        {
          rationale: `Reduce ${axis} D-term noise by filtering harder.`,
          changes: { filters: { dtermLowpassDynMaxHz: -30 } },
          score: 0.6 * weights.smoothness - 0.2 * weights.response,
        },
      );
    }
  }

  // 3. Under-damped step response
  for (const step of metrics.stepResponse) {
    if (step.stepCount === 0) continue;
    if (step.overshootPercent > 25) {
      add(
        {
          severity: "warning",
          title: `${cap(step.axis)} under-damped (${step.overshootPercent.toFixed(0)}% overshoot)`,
          detail: `Step responses on ${step.axis} overshoot by ${step.overshootPercent.toFixed(
            0,
          )}%. Reducing P slightly (or raising D) will tighten the response and reduce bounce-back.`,
          relatedMetrics: ["stepResponse"],
        },
        {
          rationale: `Tighten the ${step.axis} axis by reducing P.`,
          changes: { pids: { [step.axis]: { p: -3 } } },
          score: 0.5 * weights.response + 0.3 * weights.smoothness,
        },
      );
    }
  }

  // 4. Slow response. A healthy small quad rises in ~10–30 ms; beyond
  // ~50 ms the axis feels mushy (heavy filtering and/or low P).
  for (const step of metrics.stepResponse) {
    if (step.stepCount === 0) continue;
    if (step.riseTimeMs > 50) {
      add(
        {
          severity: "info",
          title: `${cap(step.axis)} response is slow (${step.riseTimeMs.toFixed(0)} ms rise)`,
          detail: `The ${step.axis} axis takes ${step.riseTimeMs.toFixed(
            0,
          )} ms to rise, suggesting heavy filtering or low P. Raising P or relaxing filters will sharpen it.`,
          relatedMetrics: ["stepResponse"],
        },
        {
          rationale: `Sharpen ${step.axis} by raising P.`,
          changes: { pids: { [step.axis]: { p: 3 } } },
          score: 0.5 * weights.response - 0.2 * weights.smoothness,
        },
      );
    }
  }

  // 5. Motor saturation
  if (metrics.motorSaturationPercent > 5) {
    add(
      {
        severity: metrics.motorSaturationPercent > 15 ? "critical" : "warning",
        title: `Motors saturating (${metrics.motorSaturationPercent.toFixed(0)}% of frames)`,
        detail: `Motors are at full output ${metrics.motorSaturationPercent.toFixed(
          0,
        )}% of the time, so the PID loop has no authority left. Reducing D (and P if needed) frees up headroom.`,
        relatedMetrics: ["motorSaturationPercent"],
      },
      {
        rationale: "Free motor headroom by reducing D.",
        changes: { pids: { roll: { d: -3 }, pitch: { d: -3 } } },
        score: 0.5 * weights.response + 0.3 * weights.efficiency,
      },
    );
  }

  // 6. Battery sag
  if (metrics.vbatSagV !== null && metrics.vbatSagV > 1.5) {
    add({
      severity: "info",
      title: `Battery sags ${metrics.vbatSagV.toFixed(2)} V under load`,
      detail: `Voltage drops ${metrics.vbatSagV.toFixed(
        2,
      )} V between idle and full throttle. Consider a higher C-rating pack or check for a tired battery.`,
      relatedMetrics: ["vbatSagV"],
    });
  }

  // 7. Filter latency
  if (metrics.filterLatencyMs !== null && metrics.filterLatencyMs > 25) {
    add({
      severity: "info",
      title: `Estimated filter latency ~${metrics.filterLatencyMs} ms`,
      detail: `Rough latency estimate of ~${metrics.filterLatencyMs} ms from step responses. For ${goal} flying, consider relaxing lowpass filters if noise levels allow.`,
      relatedMetrics: ["filterLatencyMs"],
    });
  }

  recommendations.sort((a, b) => b.score - a.score);
  return { findings, recommendations };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

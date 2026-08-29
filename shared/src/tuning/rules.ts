import type { Axis, PidTerms, ProfileSettings } from "../types/fc";
import { AXES } from "../types/fc";
import type { Finding, LogMetrics, Recommendation } from "../analysis/types";
import { BF45_FILTER_DEFAULTS } from "../analysis/delay";
import { settingsToCli } from "./cli";

/**
 * Deterministic tuning rules for Betaflight 4.4/4.5, following Chris Rosser's
 * filter/PID masterclass methodology and the official BF docs:
 *
 * - Motor noise (throttle-swept ridges) → RPM filter (min/fade/Q/weights).
 * - Frame resonances (fixed-frequency stripes) → dynamic notch; the notch
 *   never hunts below 100 Hz, is disabled entirely on quiet frames with RPM
 *   filtering, and its count matches the number of resonances.
 * - Gyro LPF2 is treated as the anti-aliasing filter it is (1000 Hz when gyro
 *   rate > PID rate, disabled when they're equal).
 * - D-term LPF dyn min is tuned against low-throttle noise, dyn max against
 *   high-throttle noise (Rosser's AOS two-stage method).
 * - PD balance is D-first (D is the shock absorber); FF is tuned from
 *   start-of-move lag / end-of-move overshoot; I from steady-state error.
 *
 * Rules emit deltas relative to `base` (or BF 4.5 factory defaults when
 * absent) and every recommendation carries absolute CLI lines so the user can
 * choose between the confirm-gated MSP apply flow and copying the config.
 */

export interface RuleOutput {
  findings: Finding[];
  recommendations: Recommendation[];
}

/** BF 4.5 factory PID defaults (used only to resolve CLI lines when no base). */
const BF45_PID_DEFAULTS: Record<Axis, PidTerms> = {
  roll: { p: 45, i: 80, d: 30 },
  pitch: { p: 47, i: 84, d: 32 },
  yaw: { p: 45, i: 80, d: 0 },
};

/** BF 4.5 factory defaults for the advanced keys the rules touch. */
const BF45_ADVANCED_DEFAULTS: Record<string, number> = {
  feedforwardRoll: 120,
  feedforwardPitch: 125,
  feedforwardYaw: 120,
  feedforwardBoost: 15,
  feedforwardMaxRateLimit: 90,
  itermRelaxCutoff: 15,
  dMinRoll: 30,
  dMinPitch: 32,
  dMaxGain: 37,
  dMaxAdvance: 20,
  antiGravityGain: 80,
  tpaRate: 65,
  tpaBreakpoint: 1350,
};

/** [min, max] for filter settings (BF 4.4/4.5 CLI-valid ranges). */
function FILTER_BOUNDS(key: string): [number, number] {
  if (key === "dynNotchCount") return [0, 5];
  if (key === "dynNotchQ") return [1, 1000];
  if (key === "dynNotchMinHz") return [20, 250];
  if (key === "dynNotchMaxHz") return [200, 1000];
  if (key === "rpmFilterHarmonics") return [0, 3];
  if (key === "rpmFilterMinHz") return [30, 200];
  if (key === "rpmFilterFadeRangeHz") return [0, 1000];
  if (key === "rpmFilterQ") return [250, 3000];
  if (key.startsWith("rpmFilterWeight")) return [0, 100];
  if (key === "dynLpfCurveExpo") return [0, 10];
  if (key.endsWith("Type")) return [0, 3]; // PT1/BIQUAD/PT2/PT3 enum
  return [0, 1000]; // gyro/D-term LPF cutoffs
}

function ADVANCED_BOUNDS(key: string): [number, number] {
  // BF 4.5 settings.c ranges — the clamp is the only guard between a rule
  // and the wire, so keep these faithful to the firmware.
  if (key === "tpaBreakpoint") return [1000, 2000];
  if (key === "tpaMode") return [0, 1];
  if (key === "tpaRate") return [0, 100]; // TPA_MAX
  if (key === "dMaxGain") return [0, 100];
  if (key === "dMaxAdvance") return [0, 200];
  if (key === "antiGravityGain") return [0, 30000];
  if (key === "idleMinRpm") return [0, 200]; // RPM/100
  // Per-axis feedforward gains: F_GAIN_MAX (u16 on the wire).
  if (key === "feedforwardRoll" || key === "feedforwardPitch" || key === "feedforwardYaw") return [0, 1000];
  return [0, 255];
}

/**
 * Apply recommendation changes to a settings object, clamping to valid
 * ranges. Changes are deltas for numeric fields (e.g. dtermLowpassDynMaxHz:
 * -30 lowers the cutoff by 30 Hz); when the base has no value the delta is
 * skipped unless it is a self-sufficient absolute (non-negative) value.
 */
export function applyChanges(base: ProfileSettings, changes: ProfileSettings): ProfileSettings {
  const out: ProfileSettings = { ...base };

  if (changes.pids) {
    out.pids = { ...base.pids };
    for (const axis of AXES) {
      const delta = changes.pids[axis];
      if (!delta) continue;
      const current: PidTerms = { p: 0, i: 0, d: 0, ...out.pids[axis] };
      const next: PidTerms = { ...current };
      for (const term of ["p", "i", "d"] as const) {
        const d = delta[term];
        if (d === undefined) continue;
        next[term] = Math.max(0, Math.min(255, (current[term] ?? 0) + d));
      }
      out.pids[axis] = next;
    }
  }

  if (changes.filters) {
    out.filters = { ...base.filters };
    for (const [key, delta] of Object.entries(changes.filters)) {
      if (delta === undefined) continue;
      const [min, max] = FILTER_BOUNDS(key);
      const current = out.filters[key as keyof typeof out.filters] ?? 0;
      const next = Math.max(min, Math.min(max, current + delta));
      // Skip deltas that have no base to apply to (would silently write the
      // delta as an absolute value). Exception: non-negative deltas are
      // self-sufficient absolute values (e.g. "set cutoff to 250").
      if (out.filters[key as keyof typeof out.filters] === undefined && delta < 0) continue;
      out.filters[key as keyof typeof out.filters] = next;
    }
  }

  if (changes.rates) {
    out.rates = { ...base.rates };
    for (const [key, delta] of Object.entries(changes.rates)) {
      if (delta === undefined) continue;
      // Same contract as filters/advanced: skip negative deltas with no base.
      if (out.rates[key as keyof typeof out.rates] === undefined && delta < 0) continue;
      const current = out.rates[key as keyof typeof out.rates] ?? 0;
      out.rates[key as keyof typeof out.rates] = Math.max(0, Math.min(255, current + delta));
    }
  }

  if (changes.advanced) {
    out.advanced = { ...base.advanced };
    for (const [key, delta] of Object.entries(changes.advanced)) {
      if (delta === undefined) continue;
      const [min, max] = ADVANCED_BOUNDS(key);
      const current = out.advanced[key as keyof typeof out.advanced] ?? 0;
      const next = Math.max(min, Math.min(max, current + delta));
      if (out.advanced[key as keyof typeof out.advanced] === undefined && delta < 0) continue;
      out.advanced[key as keyof typeof out.advanced] = next;
    }
  }

  return out;
}

const AXIS_LABEL: Record<Axis, string> = { roll: "Roll", pitch: "Pitch", yaw: "Yaw" };

/** D-term RMS above this (raw PID-sum units) is treated as noisy. */
const DTERM_NOISY = 120;
const DTERM_VERY_NOISY = 250;
/** Minimum dynamic-notch hunt frequency — below ~100 Hz the notch adds nasty
 * delay in the PID-relevant band (Rosser / BF docs). */
const DYN_NOTCH_MIN_FLOOR_HZ = 100;

interface Resonance {
  freqHz: number;
  ratio: number;
  spreadHz: number | null;
  axes: Axis[];
}

export function runRules(metrics: LogMetrics, goal: string, base?: ProfileSettings): RuleOutput {
  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];

  // Baseline precedence: BF 4.5 factory defaults < the config actually flown
  // (log headers) < the caller's base profile (wizard template).
  const flown = metrics.flownConfig;
  const effectiveBase: ProfileSettings = {
    pids: {
      roll: { ...BF45_PID_DEFAULTS.roll, ...flown?.pids?.roll, ...base?.pids?.roll },
      pitch: { ...BF45_PID_DEFAULTS.pitch, ...flown?.pids?.pitch, ...base?.pids?.pitch },
      yaw: { ...BF45_PID_DEFAULTS.yaw, ...flown?.pids?.yaw, ...base?.pids?.yaw },
    },
    filters: { ...BF45_FILTER_DEFAULTS, ...flown?.filters, ...base?.filters },
    advanced: { ...BF45_ADVANCED_DEFAULTS, ...flown?.advanced, ...base?.advanced },
  };

  const add = (
    finding: Finding,
    changes?: ProfileSettings,
    rationale?: string,
    score?: number,
  ): void => {
    findings.push(finding);
    if (changes && rationale) {
      const resolved = pickTouched(applyChanges(effectiveBase, changes), changes);
      recommendations.push({
        id: `rec-${recommendations.length + 1}`,
        findingId: finding.id,
        rationale,
        changes,
        score: score ?? 0.5,
        cliLines: settingsToCli(resolved),
      });
    }
  };

  const baseFilters = effectiveBase.filters!;
  const rpmActive = metrics.rpmFilterActive;

  // ------------------------------------------------------------------
  // 1. Noise sources: frame resonances (fixed frequency) vs motor harmonics
  //    (throttle-swept). Only fixed-frequency peaks may steer the dynamic
  //    notch — motor noise belongs to the RPM filter.
  // ------------------------------------------------------------------
  const resonances = collectResonances(metrics);
  const motorPeaks = collectMotorPeaks(metrics);

  if (resonances.length > 0) {
    const strongest = resonances.reduce((a, b) => (a.ratio > b.ratio ? a : b));
    const severity: Finding["severity"] = strongest.ratio > 8 ? "critical" : "warning";
    const baseCount = baseFilters.dynNotchCount ?? 3;
    const baseMin = baseFilters.dynNotchMinHz ?? 100;
    const baseMax = baseFilters.dynNotchMaxHz ?? 600;
    const baseQ = baseFilters.dynNotchQ ?? 300;

    add({
      id: "resonance",
      severity,
      title: `Frame resonance at ${resonances.map((r) => `${Math.round(r.freqHz)} Hz`).join(", ")}`,
      detail: `Fixed-frequency noise ${strongest.ratio.toFixed(1)}× above the noise floor on ${strongest.axes
        .map((a) => AXIS_LABEL[a])
        .join("/")}. Frame resonances are the dynamic notch's job — not the RPM filter's.`,
    });

    const filters: Record<string, number> = {};
    // The dyn-notch count is PER AXIS (each axis tracks its own peaks), so the
    // target is the max number of simultaneous resonances on any single axis.
    const maxPerAxis = Math.max(
      ...AXES.map((a) => resonances.filter((r) => r.axes.includes(a)).length),
    );
    if (baseCount === 0) {
      // Notch disabled but resonance present → enable with matching count.
      // dynNotchCount is safe as an absolute because the base is 0; the
      // min/max must be deltas like everywhere else (applyChanges resolves
      // every numeric change as base + delta when the base defines the key).
      const count = Math.min(maxPerAxis, rpmActive ? 2 : 3);
      filters.dynNotchCount = count;
      const targetMin = Math.max(
        DYN_NOTCH_MIN_FLOOR_HZ,
        Math.round(Math.min(...resonances.map((r) => r.freqHz)) - 25),
      );
      const targetMax = Math.min(1000, Math.round(Math.max(...resonances.map((r) => r.freqHz)) * 1.5));
      if (targetMin !== baseMin) filters.dynNotchMinHz = targetMin - baseMin;
      if (targetMax !== baseMax) filters.dynNotchMaxHz = targetMax - baseMax;
    } else {
      const minFreq = Math.min(...resonances.map((r) => r.freqHz));
      const maxFreq = Math.max(...resonances.map((r) => r.freqHz));
      const targetMin = Math.max(DYN_NOTCH_MIN_FLOOR_HZ, Math.round(minFreq - 25));
      const targetMax = Math.min(1000, Math.round(maxFreq * 1.5));
      if (targetMin < baseMin) filters.dynNotchMinHz = targetMin - baseMin;
      if (targetMax > baseMax) filters.dynNotchMaxHz = targetMax - baseMax;
      // Match the notch count to the per-axis resonance count (fewer = less delay).
      if (maxPerAxis < baseCount) filters.dynNotchCount = maxPerAxis - baseCount;
      else if (maxPerAxis > baseCount && baseCount < 3) {
        filters.dynNotchCount = Math.min(maxPerAxis, 3) - baseCount;
      }
      // Narrow, well-defined resonance → tighten the Q (less delay). Verify in
      // the next log that the resonance stays covered.
      const narrowest = resonances.reduce((a, b) =>
        (a.spreadHz ?? Infinity) < (b.spreadHz ?? Infinity) ? a : b,
      );
      if (narrowest.spreadHz !== null && narrowest.spreadHz < 8 && baseQ < 1000) {
        filters.dynNotchQ = Math.min(100, 1000 - baseQ);
      }
    }

    if (Object.keys(filters).length > 0) {
      add(
        {
          id: "resonance-notch",
          severity: "info",
          title: "Adjust dynamic notch to cover the resonance",
          detail: `Keep the notch minimum at/above ${DYN_NOTCH_MIN_FLOOR_HZ} Hz so it never hunts into the PID-relevant band.`,
        },
        { filters },
        "Cover the frame resonance with the dynamic notch; raise Q only while the resonance stays fully notched in follow-up logs.",
        0.9,
      );
    }
  } else if (rpmActive && (baseFilters.dynNotchCount ?? 3) > 0) {
    // Quiet frame + RPM filter: the dynamic notch is idle — disable it and
    // save ~1 ms of delay (Rosser / BF DShot RPM filtering docs).
    add(
      {
        id: "quiet-frame",
        severity: "info",
        title: "No frame resonance — dynamic notch can be disabled",
        detail:
          "With RPM filtering active and no fixed-frequency resonance stripes, the dynamic notch only adds delay (~1 ms) without benefit.",
      },
      { filters: { dynNotchCount: -(baseFilters.dynNotchCount ?? 3) } },
      "Disable the dynamic notch on this quiet frame to save filter delay. Re-check after the next flight — if a resonance stripe appears, re-enable it.",
      0.7,
    );
  } else if (!rpmActive) {
    add({
      id: "rpm-inactive",
      severity: "warning",
      title: "RPM filter inactive — enable bidirectional DShot",
      detail:
        "Without RPM filtering the dynamic notch has to chase motor noise, which costs far more delay than the RPM filter's targeted notches. Enable bidirectional DShot (and set the correct motor pole count) first.",
    });
  }

  // ------------------------------------------------------------------
  // 2. RPM filter tuning (motor noise onset/fade/Q/weights)
  // ------------------------------------------------------------------
  if (rpmActive && motorPeaks.length > 0 && metrics.spectral) {
    const onsets = metrics.spectral
      .map((s) => s.motorNoiseOnsetHz)
      .filter((v): v is number => v !== null);
    const strongs = metrics.spectral
      .map((s) => s.motorNoiseStrongHz)
      .filter((v): v is number => v !== null);

    if (onsets.length > 0) {
      const onset = Math.min(...onsets);
      const strong = strongs.length > 0 ? Math.min(...strongs) : onset + 50;
      const baseMin = baseFilters.rpmFilterMinHz ?? 100;
      const baseFade = baseFilters.rpmFilterFadeRangeHz ?? 50;

      const targetMin = clamp(Math.round((onset * 0.9) / 5) * 5, 30, 200);
      const targetFade = clamp(Math.round((strong - targetMin) / 5) * 5, 25, 200);

      const filters: Record<string, number> = {};
      if (Math.abs(targetMin - baseMin) >= 10) filters.rpmFilterMinHz = targetMin - baseMin;
      if (Math.abs(targetFade - baseFade) >= 25) filters.rpmFilterFadeRangeHz = targetFade - baseFade;
      if (Object.keys(filters).length > 0) {
        add(
          {
            id: "rpm-crossfade",
            severity: "info",
            title: `Motor noise starts near ${Math.round(onset)} Hz`,
            detail: `RPM filters should fade in where motor noise actually begins and reach full strength by ~${Math.round(strong)} Hz (crossfading).`,
          },
          { filters },
          "Fade the RPM filters in over the range where motor noise appears — full strength too late lets noise through, too early wastes delay. (Fade range is CLI-only on BF 4.4/4.5.)",
          0.6,
        );
      }
    }

    // Q: tighter notches = less delay. Official guidance: up to ~750 safely,
    // ~1000 on clean builds with verification.
    const baseQ = baseFilters.rpmFilterQ ?? 500;
    if (baseQ < 750) {
      add(
        {
          id: "rpm-q",
          severity: "info",
          title: "RPM filter Q can be tightened",
          detail: `Q ${baseQ} → 750 makes the RPM notches narrower, reducing delay. Verify in the next log that motor noise is still fully notched; clean builds can push toward 1000.`,
        },
        { filters: { rpmFilterQ: 750 - baseQ } },
        "Tighter RPM notches for less delay (CLI-only on BF 4.4/4.5). Back off if motor noise leaks through into the filtered gyro.",
        0.5,
      );
    }

    // Per-harmonic weights from the observed harmonic pattern (Rosser:
    // tri-blade ≈ 100,0,80 — almost no 2nd harmonic; bi-blade keeps the 2nd).
    const fundamental = motorPeaks.reduce((a, b) => (a.freqHz < b.freqHz ? a : b));
    const h2 = motorPeaks.find(
      (p) => Math.abs(p.freqHz / fundamental.freqHz - 2) < 0.2 && p.ratioToFloor > 4,
    );
    const baseW2 = baseFilters.rpmFilterWeight2 ?? 100;
    if (!h2 && baseW2 > 0) {
      add(
        {
          id: "rpm-weights",
          severity: "info",
          title: "No 2nd motor harmonic — dim its RPM notch",
          detail:
            "The log shows the tri-blade pattern (fundamental + 3rd harmonic, almost no 2nd). Dropping the 2nd harmonic's weight to 0 removes an unneeded notch and its delay.",
        },
        { filters: { rpmFilterWeight2: -baseW2, rpmFilterWeight3: -20 } },
        "Suggested weights 100,0,80 (tri-blade pattern). CLI-only on BF 4.4/4.5 — apply via the snippet.",
        0.5,
      );
    }
  }

  // ------------------------------------------------------------------
  // 3. Gyro LPF2 anti-aliasing (Rosser: push to 1 kHz, or disable when the
  //    gyro rate equals the PID loop rate)
  // ------------------------------------------------------------------
  const gyroRate = metrics.gyroRateHz ?? null;
  const pidRate = metrics.pidLoopRateHz ?? null;
  const baseLpf2 = baseFilters.gyroLowpass2Hz ?? 500;
  if (gyroRate && pidRate) {
    if (gyroRate > pidRate * 1.05 && baseLpf2 !== 1000) {
      add(
        {
          id: "gyro-lpf2",
          severity: "info",
          title: "Raise gyro LPF2 to 1000 Hz (anti-aliasing)",
          detail: `Gyro runs at ${gyroRate} Hz vs PID loop ${pidRate} Hz — LPF2 only needs to prevent aliasing into the loop. The 500 Hz default adds delay without benefit.`,
        },
        { filters: { gyroLowpass2Hz: 1000 - baseLpf2 } },
        "Gyro LPF2 at 1000 Hz still anti-aliases but adds far less delay.",
        0.6,
      );
    } else if (Math.abs(gyroRate - pidRate) <= pidRate * 0.05 && baseLpf2 > 0) {
      add(
        {
          id: "gyro-lpf2",
          severity: "info",
          title: "Gyro LPF2 can be disabled (gyro rate = PID rate)",
          detail: `Gyro and PID loop both run at ${gyroRate} Hz — no aliasing can occur, so the anti-aliasing filter is pure delay.`,
        },
        { filters: { gyroLowpass2Hz: -baseLpf2 } },
        "Disable gyro LPF2 when the gyro rate equals the PID loop rate.",
        0.6,
      );
    }
  }

  // ------------------------------------------------------------------
  // 4. D-term lowpass vs throttle band (Rosser's AOS method: dyn min is
  //    tuned at zero throttle, dyn max at full throttle)
  // ------------------------------------------------------------------
  // Optional fields: absent in analyses persisted before the band split.
  const dHigh = Math.max(...AXES.map((a) => metrics.dtermRmsHighThrottle?.[a] ?? 0));
  const dLow = Math.max(...AXES.map((a) => metrics.dtermRmsLowThrottle?.[a] ?? 0));
  const dAll = Math.max(...AXES.map((a) => metrics.dtermRms[a]));
  const bandsAvailable = dHigh > 0 || dLow > 0;

  if (bandsAvailable ? Math.max(dHigh, dLow) > DTERM_NOISY : dAll > DTERM_NOISY) {
    const peak = bandsAvailable ? Math.max(dHigh, dLow) : dAll;
    const severity: Finding["severity"] = peak > DTERM_VERY_NOISY ? "critical" : "warning";
    const filters: Record<string, number> = {};
    let detail: string;

    if (bandsAvailable && dHigh > DTERM_NOISY && dHigh > dLow * 1.3) {
      const baseMax = baseFilters.dtermLowpassDynMaxHz ?? 170;
      filters.dtermLowpassDynMaxHz = -Math.max(10, Math.round(baseMax * 0.1));
      detail =
        "D-term noise is concentrated at high throttle — lower the D-term dyn LPF MAX cutoff (full-throttle filtering).";
    } else if (bandsAvailable && dLow > DTERM_NOISY && dLow > dHigh * 1.3) {
      const baseMin = baseFilters.dtermLowpassDynMinHz ?? 70;
      filters.dtermLowpassDynMinHz = -Math.max(5, Math.round(baseMin * 0.1));
      detail =
        "D-term noise is concentrated at low throttle — lower the D-term dyn LPF MIN cutoff (zero-throttle filtering).";
    } else {
      const baseMax = baseFilters.dtermLowpassDynMaxHz ?? 170;
      const baseMin = baseFilters.dtermLowpassDynMinHz ?? 70;
      filters.dtermLowpassDynMaxHz = -Math.max(10, Math.round(baseMax * 0.1));
      filters.dtermLowpassDynMinHz = -Math.max(5, Math.round(baseMin * 0.1));
      detail = "D-term noise is high across the throttle range — lower both dynamic D-term cutoffs.";
    }

    add(
      {
        id: "dterm-noise",
        severity,
        title: "High D-term noise",
        detail: `${detail} D-term amplifies high-frequency noise (2× frequency = 2× gain) and heats motors. Lower cutoffs in ~10% steps and re-check motor temperatures after each flight.`,
      },
      { filters },
      "More D-term filtering where the noise actually is. D filtering is safety-critical — reduce gradually and hover-test between changes.",
      0.8,
    );
  }

  // TPA hint: noise only at high throttle with a clean low end.
  if (bandsAvailable && dHigh > 150 && dLow < 80) {
    add(
      {
        id: "tpa-hint",
        severity: "info",
        title: "High-throttle-only noise — consider TPA",
        detail:
          "Noise appears only at high throttle. TPA gracefully reduces PID gains as throttle rises; set the breakpoint just below where the noise starts and increase attenuation until it clears.",
      },
      { advanced: { tpaRate: -5 } },
      "Lower TPA rate slightly (more attenuation at full throttle). Alternative to lowering the D-term dyn max if the low-throttle tune feels perfect.",
      0.4,
    );
  }

  // ------------------------------------------------------------------
  // 5. Step response: PD balance (D-first), I from steady-state error,
  //    FF from start lag / end overshoot
  // ------------------------------------------------------------------
  for (const sr of metrics.stepResponse) {
    if (sr.stepCount < 3) continue;
    const axis = sr.axis;
    const label = AXIS_LABEL[axis];
    const basePid = effectiveBase.pids![axis]!;

    // Optional step fields are absent in pre-overhaul persisted analyses.
    const ringing = sr.ringingCycles ?? 0;
    // Track under-damped axes so the FF end-overshoot rule below doesn't
    // co-fire a contradictory change for what may be the same symptom.
    let dampingIssue = false;
    if (sr.overshootPercent > 25 || ringing >= 2) {
      dampingIssue = true;
      // Under-damped. D is the shock absorber — raise it first; only cut P
      // when D is already near the top of the healthy D/P band (0.45–0.85).
      const p = basePid.p ?? 0;
      const d = basePid.d ?? 0;
      const dpRatio = p > 0 ? d / p : 0;
      const raiseD = axis !== "yaw" && dpRatio < 0.85;
      add(
        {
          id: `overshoot-${axis}`,
          severity: "warning",
          title: `${label} under-damped (${sr.overshootPercent.toFixed(0)}% overshoot${ringing >= 2 ? ", ringing" : ""})`,
          detail: raiseD
            ? `${label} D/P ratio is ${dpRatio.toFixed(2)} — there is room to add damping before sacrificing P authority.`
            : `${label} D/P ratio is already ${dpRatio.toFixed(2)} — reduce P instead of adding more D.`,
        },
        { pids: { [axis]: raiseD ? { d: 3 } : { p: -3 } } },
        raiseD
          ? "Raise D to damp the overshoot (D-first PD balance). If motors come down hot, revert and reduce P instead."
          : "Reduce P to calm the overshoot; D is already high relative to P.",
        0.8,
      );
    } else if (sr.riseTimeMs > 50 && sr.overshootPercent < 10) {
      add(
        {
          id: `slow-${axis}`,
          severity: "info",
          title: `${label} response is slow (${sr.riseTimeMs.toFixed(0)} ms rise)`,
          detail: "Over-damped or low P — the quad takes too long to reach the setpoint.",
        },
        { pids: { [axis]: { p: 3 } } },
        "Raise P for a crisper response; stop if overshoot or oscillation appears.",
        0.6,
      );
    }

    const sse = sr.steadyStateErrorPercent ?? 0;
    if (sse > 5) {
      add(
        {
          id: `iterm-${axis}`,
          severity: "info",
          title: `${label} steady-state error ${sse.toFixed(0)}%`,
          detail:
            "The gyro settles away from the held setpoint — the I-term winds up too slowly to remove the systematic error.",
        },
        { pids: { [axis]: { i: 5 } } },
        "Raise I so persistent error is corrected faster. Back off if slow bounce-backs appear after fast moves.",
        0.55,
      );
    }

    // Feedforward: start-of-move lag vs end-of-move overshoot (Rosser).
    const ffLag = sr.ffStartLagMs ?? 0;
    if (ffLag > 15) {
      add(
        {
          id: `ff-lag-${axis}`,
          severity: "info",
          title: `${label} gyro lags the sticks (${ffLag.toFixed(0)} ms)`,
          detail:
            "At the start of sharp moves the gyro falls behind the setpoint — feedforward is too low to push the quad into the move.",
        },
        { advanced: { [`feedforward${label}`]: 10 } },
        "Raise feedforward for tighter stick tracking. If the gyro starts leading the setpoint instead, add FF boost rather than more FF.",
        0.6,
      );
    } else if (ffLag < -5) {
      add(
        {
          id: `ff-boost-${axis}`,
          severity: "info",
          title: `${label} gyro leads the sticks at move start`,
          detail: "The gyro gets ahead of the setpoint at the start of moves — feedforward boost ramps the push too aggressively.",
        },
        { advanced: { feedforwardBoost: -3 } },
        "Reduce FF boost so feedforward ramps up at the rate the quad can actually follow.",
        0.5,
      );
    }
    if (sr.ffEndOvershootPercent != null && sr.ffEndOvershootPercent > 20) {
      if (dampingIssue) {
        // Same physical symptom can explain both findings — don't co-fire a
        // contradictory FF cut on top of the D/P change. Fix damping first,
        // then re-evaluate from the next log.
        add({
          id: `ff-end-${axis}`,
          severity: "warning",
          title: `${label} overshoots at the end of moves (${sr.ffEndOvershootPercent.toFixed(0)}%)`,
          detail:
            "When the stick returns, the gyro sails past the setpoint and bounces back. This can be the same under-damping flagged above — fix the D/P balance first, then re-check before touching feedforward.",
        });
      } else {
        add(
          {
            id: `ff-end-${axis}`,
            severity: "warning",
            title: `${label} overshoots at the end of moves (${sr.ffEndOvershootPercent.toFixed(0)}%)`,
            detail:
              "When the stick returns, the gyro sails past the setpoint and bounces back — feedforward keeps pushing when it should let go.",
          },
          { advanced: { [`feedforward${label}`]: -10 } },
          "Reduce feedforward until the gyro returns cleanly onto the setpoint at the end of sharp moves.",
          0.65,
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // 6. Motor saturation
  // ------------------------------------------------------------------
  if (metrics.motorSaturationPercent > 5) {
    const severity: Finding["severity"] = metrics.motorSaturationPercent > 15 ? "critical" : "warning";
    add(
      {
        id: "motor-sat",
        severity,
        title: `Motors saturated ${metrics.motorSaturationPercent.toFixed(1)}% of the time`,
        detail:
          "At full motor output the PID loop has no authority left. Free headroom by reducing P and D slightly, or reduce max rates so full stick demands less.",
      },
      { pids: { roll: { p: -2, d: -2 }, pitch: { p: -2, d: -2 } } },
      "Small P/D reduction to free motor headroom. If the quad then feels soft, restore PIDs and lower max rates instead.",
      0.7,
    );
  }

  // ------------------------------------------------------------------
  // 7. Battery sag
  // ------------------------------------------------------------------
  if (metrics.vbatSagV !== null && metrics.vbatSagV > 0.8) {
    add({
      id: "vbat-sag",
      severity: "info",
      title: `Battery sag ${metrics.vbatSagV.toFixed(1)} V under load`,
      detail: "Large sag points to a weak or low-C battery — tune results will vary with pack quality.",
    });
  }

  // ------------------------------------------------------------------
  // 8. Estimated filter delay (true group delay of the configured chain)
  // ------------------------------------------------------------------
  if (metrics.filterDelay) {
    const d = metrics.filterDelay;
    if (d.dtermMs > 8) {
      const biggest = d.stages.reduce((a, b) => (a.ms > b.ms ? a : b));
      add({
        id: "filter-delay",
        severity: d.dtermMs > 15 ? "warning" : "info",
        title: `Estimated filter delay ${d.dtermMs.toFixed(1)}–${d.dtermMsMax.toFixed(1)} ms (D path, 0–100% throttle)`,
        detail: `Gyro path ${d.gyroMs.toFixed(1)} ms at ${d.referenceFreqHz} Hz; biggest contributor: ${biggest.name} (${biggest.ms.toFixed(1)} ms). Well-tuned builds land around 3–5 ms — factory filters are deliberately conservative.`,
      });
    }
  }

  // ------------------------------------------------------------------
  // Goal weighting
  // ------------------------------------------------------------------
  const weights: Record<string, Record<string, number>> = {
    race: { overshoot: 1, slow: 1, "ff-": 0.9, dterm: 0.8, resonance: 0.7, "motor-sat": 1 },
    freestyle: { overshoot: 0.8, slow: 0.7, "ff-": 0.8, dterm: 1, resonance: 0.9, "motor-sat": 0.8 },
    cinematic: { overshoot: 0.6, slow: 0.5, "ff-": 0.6, dterm: 1, resonance: 1, "motor-sat": 0.6 },
  };
  const w = weights[goal] ?? weights.freestyle!;
  for (const r of recommendations) {
    const key = Object.keys(w).find((k) => r.findingId?.startsWith(k));
    if (key) r.score *= w[key]!;
  }
  recommendations.sort((a, b) => b.score - a.score);

  return { findings, recommendations };
}

/** Merge frame-resonance peaks across axes; group frequencies within 25 Hz. */
function collectResonances(metrics: LogMetrics): Resonance[] {
  const groups: Resonance[] = [];
  const addPeak = (axis: Axis, freqHz: number, ratio: number, spreadHz: number | null) => {
    const g = groups.find((g) => Math.abs(g.freqHz - freqHz) < 25);
    if (g) {
      if (ratio > g.ratio) {
        g.ratio = ratio;
        g.freqHz = freqHz;
        g.spreadHz = spreadHz;
      }
      if (!g.axes.includes(axis)) g.axes.push(axis);
    } else {
      groups.push({ freqHz, ratio, spreadHz, axes: [axis] });
    }
  };

  if (metrics.spectral) {
    for (const s of metrics.spectral) {
      for (const p of s.peaks) {
        if (p.kind === "frameResonance" && p.ratioToFloor > 4 && p.freqHz >= 80) {
          addPeak(s.axis, p.freqHz, p.ratioToFloor, p.freqSpreadHz);
        }
      }
    }
  } else {
    // Legacy fallback for analyses persisted before spectral classification:
    // unclassified peaks — still floored at 100 Hz for notch targeting.
    for (const p of metrics.noisePeaks) {
      const floor = metrics.noiseFloor[p.axis];
      const ratio = floor > 0 ? p.magnitude / floor : 0;
      if (ratio > 4 && p.freqHz >= 80 && p.freqHz <= 500) {
        addPeak(p.axis, p.freqHz, ratio, null);
      }
    }
  }
  return groups.sort((a, b) => b.ratio - a.ratio).slice(0, 3);
}

function collectMotorPeaks(metrics: LogMetrics): { freqHz: number; ratioToFloor: number }[] {
  if (!metrics.spectral) return [];
  return metrics.spectral
    .flatMap((s) => s.peaks)
    .filter((p) => p.kind === "motorHarmonic" && p.ratioToFloor > 4)
    .sort((a, b) => a.freqHz - b.freqHz);
}

/** Resolve deltas against the base and keep only the touched keys (absolute). */
function pickTouched(resolved: ProfileSettings, changes: ProfileSettings): ProfileSettings {
  const out: ProfileSettings = {};
  if (changes.pids) {
    out.pids = {};
    for (const axis of AXES) {
      if (!changes.pids[axis]) continue;
      out.pids[axis] = {};
      for (const term of ["p", "i", "d"] as const) {
        if (changes.pids[axis]![term] !== undefined) {
          out.pids[axis]![term] = resolved.pids?.[axis]?.[term];
        }
      }
    }
  }
  for (const section of ["filters", "rates", "advanced"] as const) {
    const changed = changes[section];
    if (!changed) continue;
    out[section] = {};
    for (const key of Object.keys(changed)) {
      const v = (resolved[section] as Record<string, number | undefined>)[key];
      if (v !== undefined) (out[section] as Record<string, number>)[key] = v;
    }
  }
  return out;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

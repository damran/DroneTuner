import type { Axis, PidTerms, ProfileSettings } from "../types/fc";
import { AXES } from "../types/fc";
import type { Finding, LogMetrics, Recommendation } from "../analysis/types";
import { BF45_FILTER_DEFAULTS } from "../analysis/delay";
import { hasStepEvidence, stepEvidenceNote } from "../analysis/stepresponse";
import { settingsToCli } from "./cli";

/**
 * Deterministic tuning rules for Betaflight 4.4/4.5, following Chris Rosser's
 * Betaflight 4.5 tuning masterclass (filters / PIDs / rates, 2024), Brian
 * White's PIDtoolbox step-response method and the official BF docs. See
 * docs/tuning-research-2026-09.md ("Rosser masterclass reconciliation") for
 * the claim-by-claim table.
 *
 * - The RAW gyro (gyroUnfilt, `metrics.spectralRaw`) says which noise exists;
 *   the FILTERED gyro (`metrics.spectral`) says what leaks through. Rosser's
 *   filter flight reads the raw frequency-vs-throttle view.
 * - Motor noise (harmonics of the eRPM frequency) → RPM filter: fade in where
 *   the noise starts, push Q toward 1000 while nothing leaks, dim the
 *   harmonics the raw spectrum does not show (tri-blade: 100,0,80).
 * - Frame resonances (fixed-frequency stripes) → dynamic notch: one notch per
 *   stripe, minimum a little below the lowest stripe and never below 100 Hz
 *   (ideally ≥150), Q raised only while the stripe stays fully notched,
 *   count 0 when the raw gyro shows no stripe at all.
 * - Gyro LPF1 stays off; LPF2 is the anti-aliasing filter (1000 Hz when the
 *   gyro rate exceeds the PID rate; optional off when they are equal).
 * - D-term LPF: more filtering where the D-term noise is (dyn min at low
 *   throttle, dyn max at high throttle); less filtering is the crisp A/B.
 * - PIDs: fix the P:D ratio first (under-damped → lower P&I, Rosser's
 *   tracking slider; raise D only when D is abnormally low), I from a tail
 *   that droops (steady-state error) and from slow drawn-out overshoot,
 *   FF from start-of-move lag (boost when the lag is start-only) and
 *   end-of-move overshoot. TPA breakpoint just below the throttle where the
 *   high-throttle noise starts, rate up (more attenuation).
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
  // pid.h on 4.5-maintenance: PID_ROLL_DEFAULT {45,80,40,120}, PID_PITCH_DEFAULT {47,84,46,125}.
  roll: { p: 45, i: 80, d: 40 },
  pitch: { p: 47, i: 84, d: 46 },
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
  dMinPitch: 34, // D_MIN_DEFAULT {30, 34, 0}
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
const FF_KEY = { roll: "feedforwardRoll", pitch: "feedforwardPitch", yaw: "feedforwardYaw" } as const;

/** D-term RMS above this (raw PID-sum units) is treated as noisy. */
const DTERM_NOISY = 120;
const DTERM_VERY_NOISY = 250;
/** D-term RMS below this in every throttle band = filtering headroom (the
 * "raise the D-term multiplier until the motors get rough" direction). */
const DTERM_QUIET = 60;
/** Minimum dynamic-notch hunt frequency — below ~100 Hz the notch adds nasty
 * delay in the PID-relevant band (Rosser: "definitely more than 100 Hz,
 * ideally more than 150"). */
const DYN_NOTCH_MIN_FLOOR_HZ = 100;
/** Rosser / Brian White: neither notch is worth pushing past Q 1000. */
const NOTCH_Q_MAX = 1000;
/**
 * RC smoothing auto factor by goal. Betaflight's default 30 is a racing
 * setting (Rosser); freestyle 50–60, cinematic 90–100 (Rosser), racing 20–25
 * (Oscar Liang / the 500 Hz race preset). Indoor precision sits between.
 */
const RC_SMOOTHING_TARGET: Partial<Record<string, number>> = { racing: 25, freestyle: 50, cinematic: 90 };
/** Below this much flight the spectra/step statistics are noise, not evidence. */
const MIN_LOG_S = 10;

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
  // 0. Enough data? A 2 s arm/disarm blip has a zero noise floor and no
  //    steps — every rule below would "see" a quiet frame and a perfect tune.
  // ------------------------------------------------------------------
  const hasGyroData = AXES.some((a) => metrics.noiseFloor[a] > 0) || AXES.some((a) => metrics.dtermRms[a] > 0);
  if (metrics.durationS < MIN_LOG_S || !hasGyroData) {
    findings.push({
      id: "short-log",
      severity: "info",
      title:
        metrics.durationS < MIN_LOG_S
          ? `Log too short for tuning advice (${metrics.durationS.toFixed(1)} s)`
          : "No gyro activity in this log",
      detail: `Recommendations need at least ${MIN_LOG_S} s of flight with the quad airborne (hover, some stick moves, a few throttle changes). Pick a longer flight session or record a new log.`,
    });
    return { findings, recommendations };
  }

  // Loop-rate sanity: an 8 kHz gyro with pid_process_denom 4 runs the PID
  // loop at 2 kHz — the Nyquist limit drops to 1 kHz, filters see less
  // headroom and every filter stage adds proportionally more delay.
  const gyroRateHz = metrics.gyroRateHz ?? null;
  const pidLoopRateHz = metrics.pidLoopRateHz ?? null;
  if (gyroRateHz && pidLoopRateHz && pidLoopRateHz <= 2000 && gyroRateHz >= 2 * pidLoopRateHz) {
    findings.push({
      id: "pid-loop-rate",
      severity: "info",
      title: `PID loop runs at ${pidLoopRateHz} Hz (gyro ${gyroRateHz} Hz)`,
      detail:
        "pid_process_denom 4 halves the control bandwidth for no delay benefit on a G4/F4/F7 board. Whoop and micro targets run pid_process_denom 2 (4 kHz PID) comfortably; set it in the CLI (not MSP-writable here) and re-log.",
    });
  }

  // Dynamic-notch floor sanity (the flown value, not the template): a notch
  // hunting below 100 Hz sits inside the control band of a small quad.
  const flownNotchMin = flown?.filters?.dynNotchMinHz;
  const flownNotchCount = flown?.filters?.dynNotchCount ?? 1;
  if (flownNotchMin !== undefined && flownNotchCount > 0 && flownNotchMin < DYN_NOTCH_MIN_FLOOR_HZ) {
    const baseMin = baseFilters.dynNotchMinHz ?? flownNotchMin;
    add(
      {
        id: "notch-floor",
        severity: "warning",
        title: `Dynamic notch floor at ${flownNotchMin} Hz is inside the control band`,
        detail: `Rosser: set the notch minimum a little below the lowest frame stripe, "definitely more than 100 Hz, ideally more than 150"; Betaflight's own presets never go below 80 Hz and every whoop/micro tune uses 100-150 Hz. A notch that hunts into the 60-90 Hz band removes real control signal and can start a low-frequency oscillation (this fleet crashed at 60 Hz / Q 300). Stripes below 100 Hz are usually not the frame (a loose antenna, camera or canopy) — fix them mechanically and with D-term filtering instead.`,
      },
      baseMin < DYN_NOTCH_MIN_FLOOR_HZ ? { filters: { dynNotchMinHz: DYN_NOTCH_MIN_FLOOR_HZ - baseMin } } : undefined,
      baseMin < DYN_NOTCH_MIN_FLOOR_HZ ? `Raise dyn_notch_min_hz to ${DYN_NOTCH_MIN_FLOOR_HZ} Hz.` : undefined,
      0.95,
    );
  }

  // Idle-speed motor noise: dynamic idle parks the motors at a fixed RPM, so
  // its fundamental shows up as a "fixed" peak. It is the RPM filter's job
  // (or simply accepted) — never the dynamic notch's.
  const idlePeaks = [...(metrics.spectralRaw ?? []), ...(metrics.spectral ?? [])]
    .flatMap((sp) => sp.peaks.map((pk) => ({ axis: sp.axis, ...pk })))
    .filter((pk) => pk.kind === "motorIdle" && pk.ratioToFloor > 4);
  if (idlePeaks.length > 0) {
    const strongest = idlePeaks.reduce((a, b) => (a.ratioToFloor > b.ratioToFloor ? a : b));
    const rpmMin = baseFilters.rpmFilterMinHz ?? 100;
    const baseIdle = effectiveBase.advanced?.idleMinRpm ?? 0;
    // dyn_idle_min_rpm is mechanical rpm / 100: the idle line reaches the RPM
    // filter floor at rpm_filter_min_hz × 60 rpm.
    const idleForRpmFloor = Math.ceil((rpmMin * 60) / 100);
    const belowFloor = strongest.freqHz < rpmMin;
    const finding: Finding = {
      id: "motor-idle",
      severity: "info",
      title: `Idle-speed motor noise at ${Math.round(strongest.freqHz)} Hz`,
      detail: `A fixed peak at the motors' idle speed (${strongest.ratioToFloor.toFixed(1)}× the floor on ${AXIS_LABEL[strongest.axis]}). ${
        belowFloor
          ? `It sits below rpm_filter_min_hz (${rpmMin} Hz) where the RPM notches are faded out, so it is never filtered. Options: raise dynamic idle so the idle line reaches the RPM floor (dyn_idle_min_rpm ${idleForRpmFloor} = ${idleForRpmFloor * 100} rpm — Rosser's whoop presets run 6600-10000 rpm and he calls dynamic idle "critical for propwash on small quads"; the cost is less descent authority), lower rpm_filter_min_hz toward it (more delay at low throttle), or accept it: it disappears as soon as the throttle rises.`
          : "The RPM filter should cover it — check motor_poles and that bidirectional DShot reports RPM on all motors."
      } Do not widen the dynamic notch to chase it.`,
    };
    if (belowFloor && baseIdle > 0 && baseIdle < idleForRpmFloor) {
      add(
        finding,
        { advanced: { idleMinRpm: idleForRpmFloor - baseIdle } },
        `Raise dynamic idle to ${idleForRpmFloor * 100} rpm so the idle line lands inside the RPM filter's range (Rosser: higher idle = better propwash on small quads). Fly it as the "Dynamic idle" A/B pair before committing — it changes how the quad drops.`,
        0.4,
      );
    } else {
      findings.push(finding);
    }
  }

  // motor_poles sanity check: every RPM notch is placed from eRPM and the
  // pole count. If the strongest motor-like line sits where another pole
  // count predicts it, the notches are all off by that ratio and the
  // fundamental leaks straight through.
  const poleCheck = metrics.motorPoleCheck;
  if (poleCheck && poleCheck.status === "mismatch" && poleCheck.suggestedPoles) {
    const offPct = Math.abs(1 - poleCheck.headerPoles / poleCheck.suggestedPoles) * 100;
    const finding: Finding = {
      id: "motor-poles",
      severity: "warning",
      title: "RPM estimate does not match measured motor peak",
      detail: `The strongest motor-like peak sits at ${Math.round(poleCheck.peakHz ?? 0)} Hz, ${(poleCheck.ratio ?? 0).toFixed(2)}× the eRPM-derived motor frequency (motor_poles ${poleCheck.headerPoles}). With ${poleCheck.suggestedPoles} poles it would be exactly the ${ordinal(poleCheck.harmonic ?? 1)} harmonic${poleCheck.aliased ? " (folded at the log rate)" : ""}. A wrong pole count puts every RPM notch ${offPct.toFixed(0)}% off frequency, so the motor fundamental is not filtered at all. Count the magnets on one bell (9N12P whoop motors have 12) before changing it.`,
    };
    findings.push(finding);
    recommendations.push({
      id: `rec-${recommendations.length + 1}`,
      findingId: finding.id,
      rationale: `Set motor_poles to ${poleCheck.suggestedPoles} so the RPM filter tracks the measured motor lines.`,
      changes: {},
      score: 0.9,
      cliLines: [`set motor_poles = ${poleCheck.suggestedPoles}`, "save"],
    });
  } else if (poleCheck && poleCheck.status === "consistent") {
    findings.push({
      id: "motor-poles-ok",
      severity: "info",
      title: `Motor pole count confirmed (motor_poles ${poleCheck.headerPoles})`,
      detail: `A ${(poleCheck.ratioToFloor ?? 0).toFixed(0)}× peak at ${Math.round(poleCheck.peakHz ?? 0)} Hz sits on the ${ordinal(poleCheck.harmonic ?? 1)} motor harmonic (${(poleCheck.ratio ?? 1).toFixed(2)}× the eRPM estimate${poleCheck.aliased ? ", folded at the log rate" : ""}), so the RPM filter is aimed correctly.`,
    });
  }

  // Motor harmonics above the log's Nyquist fold back into the spectrum.
  // They are motor noise the log rate cannot display, not a resonance at
  // the folded frequency — say so before anyone aims a notch at it.
  const aliased = (metrics.spectral ?? [])
    .flatMap((sp) => sp.peaks.map((pk) => ({ axis: sp.axis, ...pk })))
    .filter((pk) => pk.kind === "motorHarmonic" && pk.aliased && pk.ratioToFloor > 4)
    .sort((a, b) => b.ratioToFloor - a.ratioToFloor);
  if (aliased.length > 0 && metrics.sampleRateHz > 0) {
    const strongest = aliased[0]!;
    const logRate = metrics.sampleRateHz;
    const pidRate = metrics.pidLoopRateHz ?? null;
    const interval = pidRate ? Math.round(pidRate / logRate) : null;
    const finding: Finding = {
      id: "aliased-motor-noise",
      severity: "info",
      title: `Motor harmonic folded by the ${Math.round(logRate)} Hz log rate (${Math.round(strongest.freqHz)} Hz)`,
      detail: `The ${ordinal(strongest.harmonic ?? 2)} motor harmonic lies above this log's Nyquist (${Math.round(logRate / 2)} Hz) and appears mirrored at ${Math.round(strongest.freqHz)} Hz on ${AXIS_LABEL[strongest.axis]} (${strongest.ratioToFloor.toFixed(0)}× the floor). It is not a frame resonance and no notch belongs there; the RPM filter handles it (more harmonics or a wider Q if it is strong). ${
        interval && interval >= 4
          ? `Log every 2nd PID loop (blackbox_sample_rate 1/2, ${Math.round((pidRate ?? 0) / 2)} Hz) to see the motor band at its true frequency.`
          : "Log at a higher rate to see the motor band at its true frequency."
      }`,
    };
    findings.push(finding);
    if (interval && interval >= 4) {
      recommendations.push({
        id: `rec-${recommendations.length + 1}`,
        findingId: finding.id,
        rationale: "Double the blackbox rate so motor harmonics up to the 3rd stay below Nyquist.",
        changes: {},
        score: 0.4,
        cliLines: ["set blackbox_sample_rate = 1/2", "save"],
      });
    }
  }

  // ------------------------------------------------------------------
  // 1. Noise sources: frame resonances (fixed frequency) vs motor harmonics
  //    (throttle-swept). Only fixed-frequency peaks may steer the dynamic
  //    notch — motor noise belongs to the RPM filter.
  // ------------------------------------------------------------------
  const resonances = collectResonances(metrics.spectral, metrics);
  const rawAvailable = !!metrics.spectralRaw;
  const resonancesRaw = rawAvailable ? collectResonances(metrics.spectralRaw) : [];
  const motorPeaks = collectMotorPeaks(metrics.spectral);
  const motorPeaksRaw = rawAvailable ? collectMotorPeaks(metrics.spectralRaw) : [];

  if (resonances.length > 0) {
    // A stripe in the FILTERED gyro: the notch is not covering it (wrong
    // range, too few notches, or a notch so tight the noise escapes beside it).
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
        .join("/")} — and it is still there in the filtered gyro, so the dynamic notch is not removing it. Frame resonances are the dynamic notch's job (one notch per stripe, Rosser), never the RPM filter's.`,
    });

    const filters: Record<string, number> = {};
    // The dyn-notch count is PER AXIS (each axis tracks its own peaks), so the
    // target is the max number of simultaneous resonances on any single axis.
    const maxPerAxis = Math.max(
      ...AXES.map((a) => resonances.filter((r) => r.axes.includes(a)).length),
    );
    const minFreq = Math.min(...resonances.map((r) => r.freqHz));
    const maxFreq = Math.max(...resonances.map((r) => r.freqHz));
    const targetMin = Math.max(DYN_NOTCH_MIN_FLOOR_HZ, Math.round(minFreq - 25));
    const targetMax = Math.min(1000, Math.round(maxFreq * 1.5));
    if (baseCount === 0) {
      // Notch disabled but resonance present → enable with matching count.
      // dynNotchCount is safe as an absolute because the base is 0; the
      // min/max must be deltas like everywhere else (applyChanges resolves
      // every numeric change as base + delta when the base defines the key).
      filters.dynNotchCount = Math.min(maxPerAxis, rpmActive ? 2 : 3);
      if (targetMin !== baseMin) filters.dynNotchMinHz = targetMin - baseMin;
      if (targetMax !== baseMax) filters.dynNotchMaxHz = targetMax - baseMax;
    } else {
      if (targetMin < baseMin) filters.dynNotchMinHz = targetMin - baseMin;
      if (targetMax > baseMax) filters.dynNotchMaxHz = targetMax - baseMax;
      // Match the notch count to the per-axis resonance count (fewer = less delay).
      if (maxPerAxis < baseCount) filters.dynNotchCount = maxPerAxis - baseCount;
      else if (maxPerAxis > baseCount && baseCount < 3) {
        filters.dynNotchCount = Math.min(maxPerAxis, 3) - baseCount;
      }
      // Range and count already cover the stripe, yet it leaks: the notch is
      // too tight and the noise escapes on either side of it (Rosser) —
      // widen it. Never tighten a notch whose stripe is visible.
      const rangeOrCountChanged = Object.keys(filters).length > 0;
      if (!rangeOrCountChanged && minFreq >= baseMin && maxFreq <= baseMax && baseQ > 300) {
        filters.dynNotchQ = -Math.min(100, baseQ - 300);
      }
    }

    if (Object.keys(filters).length > 0) {
      add(
        {
          id: "resonance-notch",
          severity: "info",
          title: filters.dynNotchQ !== undefined ? "Widen the dynamic notch (noise escapes beside it)" : "Adjust dynamic notch to cover the resonance",
          detail:
            filters.dynNotchQ !== undefined
              ? `The stripe sits inside the notch range with enough notches, so the notch is on it but too narrow (Q ${baseQ}) — lower Q in 100 steps until the filtered gyro is clean, then push it back up only while the stripe stays notched.`
              : `Keep the notch minimum at/above ${DYN_NOTCH_MIN_FLOOR_HZ} Hz (ideally 150) so it never hunts into the PID-relevant band; the maximum is not critical — just above the highest stripe keeps the notch focused.`,
        },
        { filters },
        filters.dynNotchQ !== undefined
          ? "Lower the dynamic notch Q so the resonance is fully removed; re-check the filtered gyro in the next log."
          : "Cover the frame resonance with the dynamic notch (min a little below the lowest stripe, one notch per stripe).",
        0.9,
      );
    }
  } else if (rpmActive && resonancesRaw.length > 0 && (baseFilters.dynNotchCount ?? 3) > 0) {
    // Stripe in the RAW gyro, none in the filtered gyro: the notch is doing
    // exactly its job. Rosser's next move is to tighten it (less delay)
    // until the stripe starts to show — one Q step at a time.
    const strongest = resonancesRaw.reduce((a, b) => (a.ratio > b.ratio ? a : b));
    const baseQ = baseFilters.dynNotchQ ?? 300;
    const finding: Finding = {
      id: "notch-working",
      severity: "info",
      title: `Dynamic notch removes the ${Math.round(strongest.freqHz)} Hz frame resonance`,
      detail: `The raw gyro shows a fixed stripe at ${resonancesRaw.map((r) => `${Math.round(r.freqHz)} Hz`).join(", ")} (${strongest.ratio.toFixed(1)}× the floor on ${strongest.axes.map((a) => AXIS_LABEL[a]).join("/")}) that is gone from the filtered gyro. Keep the notch; a tighter notch (higher Q) costs less delay as long as the stripe stays notched (Rosser: not much above 1000).`,
    };
    if (baseQ < NOTCH_Q_MAX) {
      add(
        finding,
        { filters: { dynNotchQ: Math.min(100, NOTCH_Q_MAX - baseQ) } },
        "Tighten the dynamic notch one step (+100 Q) for less delay; back off as soon as the resonance reappears in the filtered gyro.",
        0.3,
      );
    } else {
      findings.push(finding);
    }
  } else if (rpmActive && (baseFilters.dynNotchCount ?? 3) > 0) {
    // No stripe anywhere: the notch is idling and only adds delay. Rosser and
    // the Betaflight docs both switch it off on a quiet frame with RPM
    // filtering; without the raw gyro the evidence is weaker (the notch
    // itself could be hiding the stripe), so the recommendation is too.
    add(
      {
        id: "quiet-frame",
        severity: "info",
        title: rawAvailable ? "No frame resonance — the dynamic notch can be switched off" : "No frame resonance in the filtered gyro — the dynamic notch may be idle",
        detail: rawAvailable
          ? "Neither the raw nor the filtered gyro shows a fixed-frequency stripe. With RPM filtering handling the motors, a dynamic notch that finds nothing only costs delay (~1 ms); Rosser and the Betaflight docs disable it on quiet frames. Re-check after a crash, new props or a new frame — a stripe that appears then needs the notch back."
          : "The filtered gyro shows no fixed stripe, but this log has no raw gyro channel, so the notch itself may be what hides it. Log with Betaflight 4.5 (raw gyro is always recorded) before switching the notch off.",
      },
      { filters: { dynNotchCount: -(baseFilters.dynNotchCount ?? 3) } },
      "Disable the dynamic notch (count 0) on this quiet frame to save filter delay; re-enable it if a resonance appears in a later log.",
      rawAvailable ? 0.7 : 0.35,
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
  // The raw gyro shows the motor ridge from where it starts (the filtered one
  // only what the RPM notches miss), so it is the better source for the
  // crossfade — Rosser reads the onset off the unfiltered view.
  const onsetSource = metrics.spectralRaw ?? metrics.spectral;
  if (rpmActive && (motorPeaks.length > 0 || motorPeaksRaw.length > 0) && onsetSource) {
    const onsets = onsetSource
      .map((s) => s.motorNoiseOnsetHz)
      .filter((v): v is number => v !== null);
    const strongs = onsetSource
      .map((s) => s.motorNoiseStrongHz)
      .filter((v): v is number => v !== null);

    if (onsets.length > 0) {
      const onset = Math.min(...onsets);
      const strong = strongs.length > 0 ? Math.min(...strongs) : onset + 50;
      const baseMin = baseFilters.rpmFilterMinHz ?? 100;
      const baseFade = baseFilters.rpmFilterFadeRangeHz ?? 50;

      // Rosser: larger builds start the RPM filter lower and fade in faster;
      // smaller builds can start higher and fade in longer. Every whoop tune
      // (BetaFPV, AOS 65mm, Karate) keeps the minimum at 100 Hz and Karate
      // stretches the fade to 120, so the minimum is never raised above the
      // default and the fade is what grows.
      const targetMin = clamp(Math.round((onset * 0.9) / 5) * 5, 30, Math.max(100, baseMin));
      const targetFade = clamp(Math.round((strong - targetMin) / 5) * 5, 25, 120);

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
          "Fade the RPM filters in over the range where motor noise appears (Rosser: full strength by the time the noise gets strong; Brian White: minimum 25-30 Hz below the lowest motor line) — full strength too late lets noise through, too early wastes delay. (Fade range is CLI-only on BF 4.4/4.5.)",
          0.6,
        );
      }
    }

    // A harmonic above rpm_filter_harmonics is simply not notched yet — add
    // the harmonic before touching Q. (BF 4.5 caps at 3.)
    const baseHarmonics = baseFilters.rpmFilterHarmonics ?? 3;
    const unnotched = motorPeaks.filter((p) => p.harmonic !== undefined && p.harmonic > baseHarmonics && p.harmonic <= 3);
    if (unnotched.length > 0) {
      const top = unnotched.reduce((a, b) => (a.harmonic! > b.harmonic! ? a : b));
      add(
        {
          id: "rpm-harmonics",
          severity: top.ratioToFloor > 8 ? "warning" : "info",
          title: `${ordinal(top.harmonic!)} motor harmonic is not notched (rpm_filter_harmonics ${baseHarmonics})`,
          detail: `A ${top.ratioToFloor.toFixed(1)}× peak sits on the ${ordinal(top.harmonic!)} motor harmonic${top.aliased ? ` (folded to ${Math.round(top.freqHz)} Hz by the log rate)` : ` at ${Math.round(top.freqHz)} Hz`}, above the ${baseHarmonics} harmonic${baseHarmonics === 1 ? "" : "s"} the RPM filter covers. Each extra harmonic costs a little delay but removes a whole motor line.`,
        },
        { filters: { rpmFilterHarmonics: top.harmonic! - baseHarmonics } },
        `Notch ${top.harmonic} motor harmonics so the ${ordinal(top.harmonic!)} is filtered too.`,
        0.7,
      );
    }

    // Motor harmonics that ARE covered yet still visible in the FILTERED gyro
    // mean the RPM notches are too narrow (or the pole count is wrong) —
    // widen them; never tighten.
    const baseQ = baseFilters.rpmFilterQ ?? 500;
    const leaking = motorPeaks.filter((p) => p.harmonic === undefined || p.harmonic <= baseHarmonics);
    const strongestMotor = leaking.length > 0 ? leaking.reduce((a, b) => (a.ratioToFloor > b.ratioToFloor ? a : b)) : null;
    if (strongestMotor && baseQ > 300) {
      add(
        {
          id: "rpm-q",
          severity: strongestMotor.ratioToFloor > 8 ? "warning" : "info",
          title: `Motor noise leaks past the RPM notches (${Math.round(strongestMotor.freqHz)} Hz, ${strongestMotor.ratioToFloor.toFixed(1)}× floor)`,
          detail: `${strongestMotor.harmonic ? `The ${ordinal(strongestMotor.harmonic)} motor harmonic${strongestMotor.aliased ? " (folded by the log rate)" : ""}` : "A throttle-tracking peak"} is still visible in the filtered gyro, so the RPM notches (Q ${baseQ}) are narrower than the motor noise. Widen them (lower Q) in 100 steps, and double-check motor_poles (12 for 07xx/08xx/11xx whoop motors, 14 for 1103-1404) — a wrong pole count puts every notch at the wrong frequency.`,
        },
        { filters: { rpmFilterQ: -Math.min(100, baseQ - 300) } },
        "Wider RPM notches so the motor harmonics are actually removed (CLI-only on BF 4.4/4.5). Tighten again later only if the filtered gyro stays clean.",
        0.6,
      );
    }

    // Per-harmonic weights (BF 4.5 "RPM filter dimming") from the harmonic
    // pattern of the RAW gyro: Rosser's starting points are 100,0,80 for
    // tri-blades (almost no 2nd harmonic) and 100,80,0 for bi-blades; Brian
    // White dims a weak 2nd to ~50. A harmonic that still leaks into the
    // filtered gyro is never dimmed.
    const baseW = [
      baseFilters.rpmFilterWeight1 ?? 100,
      baseFilters.rpmFilterWeight2 ?? 100,
      baseFilters.rpmFilterWeight3 ?? 100,
    ];
    // Harmonic strengths are measured at the eRPM-predicted frequencies
    // (harmonicRatios), not taken from the peak list: the fundamental's
    // skirt crowds the 2nd/3rd out of the per-row peaks on a whoop. Needs a
    // ≥ 1.5 kHz log so the folded 2nd/3rd harmonics land on their own.
    const rawRatios = (metrics.spectralRaw ?? [])
      .map((sp) => sp.harmonicRatios)
      .filter((r): r is [number, number, number] => !!r);
    const filtRatios = (metrics.spectral ?? [])
      .map((sp) => sp.harmonicRatios)
      .filter((r): r is [number, number, number] => !!r);
    if (rawAvailable && rawRatios.length > 0 && baseHarmonics >= 2 && metrics.sampleRateHz >= 1500) {
      const strength = (k: number, set: [number, number, number][]) => Math.max(...set.map((r) => r[k - 1]!));
      const h1 = strength(1, rawRatios);
      const leaks = (k: number) => filtRatios.length > 0 && strength(k, filtRatios) > 4;
      const targetFor = (k: number): number => {
        if (leaks(k)) return 100;
        const hk = strength(k, rawRatios);
        if (hk <= 4) return 0; // not visible in the raw gyro → the notch removes nothing
        return h1 > 0 && hk < 0.5 * h1 ? 80 : 100;
      };
      if (h1 > 4) {
        const target = [100, targetFor(2), baseHarmonics >= 3 ? targetFor(3) : baseW[2]!];
        const changes: Record<string, number> = {};
        if (target[1] !== baseW[1]) changes.rpmFilterWeight2 = target[1]! - baseW[1]!;
        if (target[2] !== baseW[2]) changes.rpmFilterWeight3 = target[2]! - baseW[2]!;
        if (Object.keys(changes).length > 0) {
          const pattern = target[1] === 0 ? "tri-blade pattern (fundamental + 3rd, no 2nd)" : target[2] === 0 ? "bi-blade pattern (fundamental + 2nd, no 3rd)" : "harmonic pattern";
          add(
            {
              id: "rpm-weights",
              severity: "info",
              title: `RPM notch weights ${target.join(",")} match the raw gyro's ${pattern}`,
              detail: `In the raw gyro the fundamental is ${h1.toFixed(0)}× the floor, the 2nd harmonic ${strength(2, rawRatios).toFixed(0)}× and the 3rd ${strength(3, rawRatios).toFixed(0)}×. A notch on a harmonic that is not there only adds delay (Rosser: "decrease the weights as long as motor noise is not visible in the filtered gyro"; Brian White dims a weak 2nd to ~50).`,
            },
            { filters: changes },
            `Set rpm_filter_weights = ${target.join(",")} (CLI-only on BF 4.4/4.5). Back to 100 for any harmonic that reappears in the filtered gyro.`,
            0.5,
          );
        }
      }
    } else if (!rawAvailable) {
      // Legacy path (no raw gyro, no eRPM identification): the filtered gyro
      // cannot show a 2nd harmonic the RPM filter already notches, so only the
      // throttle-correlation classification can hint at the pattern.
      const fundamental = motorPeaks.length > 0 ? motorPeaks.reduce((a, b) => (a.freqHz < b.freqHz ? a : b)) : null;
      const known = motorPeaks.some((p) => p.harmonic !== undefined);
      const h2 = fundamental
        ? motorPeaks.find((p) => Math.abs(p.freqHz / fundamental.freqHz - 2) < 0.2 && p.ratioToFloor > 4)
        : undefined;
      if (fundamental && !h2 && baseW[1]! > 0 && !known && baseHarmonics >= 2) {
        add(
          {
            id: "rpm-weights",
            severity: "info",
            title: "No 2nd motor harmonic — dim its RPM notch",
            detail:
              "The log shows the tri-blade pattern (fundamental + 3rd harmonic, almost no 2nd). Dropping the 2nd harmonic's weight to 0 removes an unneeded notch and its delay.",
          },
          { filters: { rpmFilterWeight2: -baseW[1]!, rpmFilterWeight3: -20 } },
          "Suggested weights 100,0,80 (tri-blade pattern). CLI-only on BF 4.4/4.5 — apply via the snippet.",
          0.5,
        );
      }
    }
  }

  if (rpmActive && motorPeaks.length === 0 && (baseFilters.rpmFilterQ ?? 500) < 750 && metrics.spectral) {
    const baseQ = baseFilters.rpmFilterQ ?? 500;
    add(
      {
        id: "rpm-q-tighten",
        severity: "info",
        title: "RPM notches could be narrower",
        detail: `No motor harmonics leak into the filtered gyro, so Q ${baseQ} → 750 would trim delay (Rosser and Brian White both push the RPM Q toward 1000 and stop when motor noise reappears in the filtered gyro). Optional: verify in the next log that motor noise stays fully notched.`,
      },
      { filters: { rpmFilterQ: 750 - baseQ } },
      "Tighter RPM notches for less delay (CLI-only on BF 4.4/4.5). Back off if motor noise appears in the filtered gyro.",
      0.3,
    );
  }

  // ------------------------------------------------------------------
  // 3. Gyro LPF2 anti-aliasing (Rosser: push to 1 kHz, or disable when the
  //    gyro rate equals the PID loop rate)
  // ------------------------------------------------------------------
  const gyroRate = metrics.gyroRateHz ?? null;
  const pidRate = metrics.pidLoopRateHz ?? null;
  const baseLpf2 = baseFilters.gyroLowpass2Hz ?? 500;
  if (gyroRate && pidRate) {
    // 1000 Hz only makes sense when the PID loop's Nyquist limit is above it
    // (4 kHz loops and up). At 2 kHz the loop cannot even represent 1 kHz.
    if (gyroRate > pidRate * 1.05 && pidRate >= 4000 && baseLpf2 !== 1000 && baseLpf2 !== 0) {
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
    } else if (rpmActive && Math.abs(gyroRate - pidRate) <= pidRate * 0.05 && baseLpf2 > 0) {
      add(
        {
          id: "gyro-lpf2",
          severity: "info",
          title: "Gyro LPF2 could be disabled (gyro rate = PID rate)",
          detail: `Gyro and PID loop both run at ${gyroRate} Hz. Rosser: with equal rates there is no aliasing, so LPF2 can be switched off — "if in doubt leave it on at 1000 Hz". Brian White keeps it on always (a PT1 is not a hard wall). Optional, and only with the RPM filter handling the motors.`,
        },
        { filters: { gyroLowpass2Hz: -baseLpf2 } },
        "Optional: disable gyro LPF2 when the gyro rate equals the PID loop rate; raising it to 1000 Hz is the safe middle.",
        0.3,
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
      const baseMax = baseFilters.dtermLowpassDynMaxHz ?? 150;
      filters.dtermLowpassDynMaxHz = -Math.max(10, Math.round(baseMax * 0.1));
      detail =
        "D-term noise is concentrated at high throttle — lower the D-term dyn LPF MAX cutoff (full-throttle filtering).";
    } else if (bandsAvailable && dLow > DTERM_NOISY && dLow > dHigh * 1.3) {
      const baseMin = baseFilters.dtermLowpassDynMinHz ?? 75;
      filters.dtermLowpassDynMinHz = -Math.max(5, Math.round(baseMin * 0.1));
      detail =
        "D-term noise is concentrated at low throttle — lower the D-term dyn LPF MIN cutoff (zero-throttle filtering).";
    } else {
      const baseMax = baseFilters.dtermLowpassDynMaxHz ?? 150;
      const baseMin = baseFilters.dtermLowpassDynMinHz ?? 75;
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

  // TPA hint: noise only at high throttle with a clean low end. tpa_rate is
  // the attenuation at full throttle (65 = gains × 0.35), so MORE attenuation
  // is a HIGHER rate; the breakpoint goes just below the throttle where the
  // high-throttle noise starts (Rosser).
  if (bandsAvailable && dHigh > 150 && dLow < 80) {
    const baseRate = effectiveBase.advanced?.tpaRate ?? 65;
    const baseBreak = effectiveBase.advanced?.tpaBreakpoint ?? 1350;
    const changes: Record<string, number> = {};
    if (baseRate < 100) changes.tpaRate = Math.min(5, 100 - baseRate);
    const highStart = metrics.throttleBands?.highMinUs;
    if (highStart !== undefined) {
      const targetBreak = clamp(Math.round((highStart - 50) / 10) * 10, 1000, 2000);
      if (targetBreak < baseBreak) changes.tpaBreakpoint = targetBreak - baseBreak;
    }
    if (Object.keys(changes).length > 0) {
      add(
        {
          id: "tpa-hint",
          severity: "info",
          title: "High-throttle-only noise — let TPA attenuate it",
          detail: `D-term noise appears only in the top throttle band${highStart !== undefined ? ` (from about ${highStart} µs)` : ""} with a clean low end. TPA reduces the D gain as throttle rises: put the breakpoint just below where the noise starts and raise tpa_rate (more attenuation at full throttle) until it clears; switch tpa_mode to PD only if the P-term oscillates at high throttle too (Rosser).`,
        },
        { advanced: changes },
        "More TPA attenuation, starting just below the noisy throttle band. Alternative to lowering the D-term dyn max when the low-throttle tune feels perfect.",
        0.4,
      );
    }
  }

  // D-term filter headroom: the D-term is quiet in every throttle band, so
  // Rosser's "raise the D-term multiplier 0.1-0.2 at a time until the motors
  // get rough or warm" applies — the crisp A/B pair is that step.
  if (rpmActive && bandsAvailable && Math.max(dHigh, dLow, dAll) < DTERM_QUIET && metrics.motorSaturationPercent < 5) {
    findings.push({
      id: "dterm-headroom",
      severity: "info",
      title: "D-term is quiet — the D-term filtering has headroom",
      detail: `D-term noise stays below ${DTERM_QUIET} (raw units) at low and high throttle. Rosser tunes the D-term filters upward until the motors sound rough or come down warm, then backs off a step; fly the "Balanced vs Crisp" pair (D chain × 1.25) in the wizard, and if it wins raise dterm_lpf1_dyn_expo above 5 next (cutoffs rise faster at low throttle for less delay).`,
    });
  }

  // ------------------------------------------------------------------
  // 5. Step response (Rosser / Brian White): P:D ratio first, I from a
  //    drooping tail or slow overshoot, FF from start lag / end overshoot
  // ------------------------------------------------------------------
  for (const sr of metrics.stepResponse) {
    // Explicit steps or enough deconvolution windows — a couple of stick
    // flicks are not evidence either way.
    if (!hasStepEvidence(sr)) continue;
    const axis = sr.axis;
    const label = AXIS_LABEL[axis];
    const basePid = effectiveBase.pids![axis]!;
    const p = basePid.p ?? 0;
    const i = basePid.i ?? 0;
    const d = basePid.d ?? 0;
    const pct = (v: number, f: number) => Math.max(1, Math.round(v * f));

    // Optional step fields are absent in pre-overhaul persisted analyses.
    const ringing = sr.ringingCycles ?? 0;
    const peakTime = sr.peakTimeMs;
    // Brian White: a fast, sharp overshoot is the P:D ratio; a slow, drawn-out
    // one (peak well after the rise) is too much I-term.
    const slowPeak = peakTime !== undefined && peakTime > Math.max(60, sr.riseTimeMs * 3);
    // Track under-damped axes so the FF end-overshoot rule below doesn't
    // co-fire a contradictory change for what may be the same symptom.
    let dampingIssue = false;
    if ((sr.overshootPercent > 25 || ringing >= 2) && slowPeak && i > 0) {
      dampingIssue = true;
      add(
        {
          id: `iterm-high-${axis}`,
          severity: "warning",
          title: `${label} overshoots slowly (${sr.overshootPercent.toFixed(0)}%, peak at ${Math.round(peakTime!)} ms)`,
          detail:
            "The overshoot builds up long after the rise — the slow, drawn-out shape of too much I-term (Brian White), not the sharp overshoot of a P:D imbalance. Too much I also shows as bounce-back after fast moves.",
        },
        { pids: { [axis]: { i: -pct(i, 0.1) } } },
        "Lower I by 10 % (one slider step) and re-check; if the tail then droops below the setpoint, meet in the middle.",
        0.7,
      );
    } else if (sr.overshootPercent > 25 || ringing >= 2) {
      dampingIssue = true;
      // Under-damped: fix the P:D ratio. Rosser lowers P (and I with it —
      // the "tracking" slider) against a D set by the master multiplier;
      // Brian White raises D. Both move the ratio the same way; on 1S whoops
      // lowering P is the cooler option, so D is raised only when it is
      // abnormally low for the P it has to damp.
      const dpRatio = p > 0 ? d / p : 0;
      const raiseD = axis !== "yaw" && dpRatio < 0.6;
      add(
        {
          id: `overshoot-${axis}`,
          severity: "warning",
          title: `${label} under-damped (${sr.overshootPercent.toFixed(0)}% overshoot${ringing >= 2 ? ", ringing" : ""})`,
          detail: raiseD
            ? `${label} D/P ratio is ${dpRatio.toFixed(2)} — well below the 0.65-1.0 of every whoop and Betaflight tune, so there is damping missing rather than too much P.`
            : `${label} D/P ratio is ${dpRatio.toFixed(2)}, in the normal band: the loop has more P than its damping can hold. Rosser's fix is one tracking-slider step down (P and I −10 %); Brian White would raise D instead — the same ratio change, hotter motors. A tiny overshoot is fine, oscillation is not.${ringing >= 2 && sr.overshootPercent <= 25 ? " Sustained ringing at a high master multiplier is pure-P feedback and is not fixed by more D." : ""}`,
        },
        { pids: { [axis]: raiseD ? { d: pct(d || 10, 0.1) } : { p: -pct(p, 0.1), i: -pct(i, 0.1) } } },
        raiseD
          ? "Raise D to damp the overshoot (D is abnormally low for this P). If motors come down hot, revert and lower P and I instead."
          : "Lower P and I by 10 % on this axis (Rosser's tracking slider, one step) to calm the overshoot; fly the Tracking A/B pair to confirm.",
        0.8,
      );
    } else if (sr.overshootPercent > 15 && ringing >= 1) {
      dampingIssue = true;
      add(
        {
          id: `overshoot-${axis}`,
          severity: "info",
          title: `${label} slightly under-damped (${sr.overshootPercent.toFixed(0)}% overshoot, ${ringing} cycle)`,
          detail: "More than the hair of overshoot Rosser accepts, with one visible bounce. Half a tracking-slider step down brings the P:D ratio back; if the response was already crisp, leave it.",
        },
        { pids: { [axis]: { p: -pct(p, 0.05), i: -pct(i, 0.05) } } },
        "Lower P and I by 5 % on this axis; optional.",
        0.5,
      );
    } else if (sr.riseTimeMs > 50 && sr.overshootPercent < 10) {
      add(
        {
          id: `slow-${axis}`,
          severity: "info",
          title: `${label} response is slow (${sr.riseTimeMs.toFixed(0)} ms rise)`,
          detail:
            "Over-damped: the gyro takes too long to reach the setpoint with no overshoot. One tracking-slider step up (P and I +10 %) or, if the whole quad feels soft, one master step (fly the Master A/B pair). Brian White: a loop with too little gain also gives vague step-response data — raise it and re-log.",
        },
        { pids: { [axis]: { p: pct(p, 0.1), i: pct(i, 0.1) } } },
        "Raise P and I by 10 % on this axis for a crisper response; stop as soon as overshoot or oscillation appears.",
        0.6,
      );
    }

    const sse = sr.steadyStateErrorPercent ?? 0;
    if (sse > 5 && !dampingIssue) {
      add(
        {
          id: `iterm-${axis}`,
          severity: "info",
          title: `${label} steady-state error ${sse.toFixed(0)}%`,
          detail:
            "The gyro settles away from the held setpoint — the tail of the step response droops instead of holding flat, which Brian White reads as too little I-term (it winds up too slowly to remove the systematic error).",
        },
        { pids: { [axis]: { i: pct(i, 0.1) } } },
        "Raise I by 10 % so persistent error is corrected faster. Back off if slow bounce-backs appear after fast moves.",
        0.55,
      );
    }

    // Feedforward (Rosser): a lag through the whole move is too little FF;
    // a lag only at the start that the gyro then catches up is too little
    // FF boost; a lead at the start is too much boost; sailing past the
    // setpoint at the end of a move is too much FF (or a job for dynamic
    // damping). Brian White: with FF active on a 500 Hz link the step tool
    // exaggerates overshoot — judge FF on the raw setpoint/gyro overlay.
    const ffLag = sr.ffStartLagMs ?? 0;
    const ffKey = FF_KEY[axis];
    const baseFf = effectiveBase.advanced?.[ffKey] ?? 0;
    if (ffLag > 15 && sse > 5) {
      add(
        {
          id: `ff-lag-${axis}`,
          severity: "info",
          title: `${label} gyro lags the sticks (${ffLag.toFixed(0)} ms)`,
          detail:
            "The gyro falls behind the setpoint at the start of sharp moves and stays behind — feedforward is too low to push the quad into the move (Rosser: raise the stick-response slider until an overshoot appears at the start or end of a sharp move, then back off). Brian White: FF 0.5 buys roughly 6 ms, FF 1.0 roughly 12 ms.",
        },
        { advanced: { [ffKey]: baseFf === 0 ? 50 : 10 } },
        baseFf === 0
          ? "Add feedforward (50) for tighter stick tracking — fly the Feedforward A/B pair first; indoor precision tunes deliberately run 0."
          : "Raise feedforward for tighter stick tracking. If the gyro starts leading the setpoint instead, add FF boost rather than more FF.",
        0.6,
      );
    } else if (ffLag > 15) {
      add(
        {
          id: `ff-lag-${axis}`,
          severity: "info",
          title: `${label} gyro lags at the start of moves (${ffLag.toFixed(0)} ms) but catches up`,
          detail:
            "Only the start of the move is late — Rosser's cue for feedforward boost (it ramps FF up faster from stick acceleration) rather than more FF. If the quad is responsive, feedforward_max_rate_limit 92-95 also lets FF push a little longer.",
        },
        { advanced: { feedforwardBoost: 3 } },
        "Raise FF boost a step so feedforward ramps up faster at the start of a move.",
        0.5,
      );
    } else if (ffLag < -5) {
      add(
        {
          id: `ff-boost-${axis}`,
          severity: "info",
          title: `${label} gyro leads the sticks at move start`,
          detail: "The gyro gets ahead of the setpoint at the start of moves — feedforward boost ramps the push too aggressively (Rosser: reduce boost).",
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
            "When the stick returns, the gyro sails past the setpoint and bounces back. This can be the same under-damping flagged above — fix the P:D balance first, then re-check before touching feedforward.",
        });
      } else if (baseFf > 0) {
        add(
          {
            id: `ff-end-${axis}`,
            severity: "warning",
            title: `${label} overshoots at the end of moves (${sr.ffEndOvershootPercent.toFixed(0)}%)`,
            detail:
              "When the stick returns, the gyro sails past the setpoint and bounces back — feedforward keeps pushing when it should let go (Rosser). The alternative is to keep the FF and let dynamic damping boost D on sharp moves (raise d_max_gain). With a 500 Hz link the step tool exaggerates this; confirm on the raw setpoint/gyro trace.",
          },
          { advanced: { [ffKey]: -10 } },
          "Reduce feedforward until the gyro returns cleanly onto the setpoint at the end of sharp moves.",
          0.65,
        );
      }
    }
  }

  // Say where the step numbers come from (explicit stick steps vs system
  // identification), so a finding can be judged against its evidence.
  for (const f of findings) {
    const m = /^(overshoot|slow|iterm|iterm-high|ff-lag|ff-boost|ff-end)-(roll|pitch|yaw)$/.exec(f.id);
    if (!m) continue;
    const sr = metrics.stepResponse.find((s) => s.axis === m[2]);
    if (sr && !f.detail.includes("stick step") && !f.detail.includes("system identification")) {
      f.detail = `${f.detail} Measured by ${stepEvidenceNote(sr)}.`;
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
  // 9. Settings the masterclass calls out that only the log headers carry
  // ------------------------------------------------------------------
  const flownAdv = flown?.advanced ?? {};
  if ((flownAdv.dMaxAdvance ?? 0) > 0) {
    add(
      {
        id: "dmax-advance",
        severity: "info",
        title: `d_max_advance is ${flownAdv.dMaxAdvance} — Rosser sets it to 0`,
        detail:
          "Dynamic damping \"advance\" mixes a setpoint-derived component into the D-term. Rosser: \"should always, under all circumstances, be set to zero\" — D belongs to the gyro only. His AOS 65mm preset, whoop_justice and Happymodel's whoop dumps all run 0; Betaflight's default is 20.",
      },
      { advanced: { dMaxAdvance: -(effectiveBase.advanced?.dMaxAdvance ?? flownAdv.dMaxAdvance ?? 0) } },
      "Set d_max_advance to 0 (dynamic damping gain stays as it is).",
      0.5,
    );
  }
  const extras = metrics.flownExtras;
  if (extras?.absControlGain !== undefined && extras.absControlGain > 0) {
    findings.push({
      id: "abs-control",
      severity: "info",
      title: `Absolute control is on (abs_control_gain ${extras.absControlGain})`,
      detail:
        "Rosser tested absolute control and I-term rotation and found they do not reduce PID error and sometimes increase it; he recommends leaving both off. CLI: set abs_control_gain = 0.",
    });
  }
  if (
    extras?.pidsumLimit !== undefined &&
    extras.pidsumLimit < 1000 &&
    metrics.motorSaturationPercent < 5
  ) {
    const finding: Finding = {
      id: "pidsum-limit",
      severity: "info",
      title: `pidsum_limit ${extras.pidsumLimit}${extras.pidsumLimitYaw !== undefined ? ` / yaw ${extras.pidsumLimitYaw}` : ""} caps the PID controller`,
      detail:
        "Optional (Rosser: \"unleash your PID controller\"): pidsum_limit and pidsum_limit_yaw at 1000 let the loop ask the mixer for more on fast moves. UAV Tech's whoop presets and the Karate whoop tune (yaw) use 1000. Motors are not saturating in this log, so there is headroom to give; skip it if they start to.",
    };
    findings.push(finding);
    recommendations.push({
      id: `rec-${recommendations.length + 1}`,
      findingId: finding.id,
      rationale: "Raise the PID-sum limits to 1000 (CLI only) for more authority on sharp moves.",
      changes: {},
      score: 0.2,
      cliLines: ["set pidsum_limit = 1000", "set pidsum_limit_yaw = 1000", "save"],
    });
  }
  const rcTarget = RC_SMOOTHING_TARGET[goal];
  if (extras?.rcSmoothingAutoFactor !== undefined && rcTarget !== undefined && Math.abs(extras.rcSmoothingAutoFactor - rcTarget) >= 10) {
    const finding: Finding = {
      id: "rc-smoothing",
      severity: "info",
      title: `RC smoothing auto factor ${extras.rcSmoothingAutoFactor} (${goal} usually runs ~${rcTarget})`,
      detail:
        "Rosser: Betaflight's default 30 is a racing setting; freestyle wants 50-60 and cinematic 90-100 for a smooth setpoint without gimbal jitter. Each step of smoothing costs a few ms of stick delay (Brian White measured ~8 ms at a 30 Hz cutoff, ~12 ms at 20 Hz), so it is a feel choice, not a tune. Global setting: it cannot be A/B'd between profiles.",
    };
    findings.push(finding);
    recommendations.push({
      id: `rec-${recommendations.length + 1}`,
      findingId: finding.id,
      rationale: `Set rc_smoothing_auto_factor to ${rcTarget} for a ${goal} feel (CLI only; a feel choice, not a tuning fix).`,
      changes: {},
      score: 0.25,
      cliLines: [`set rc_smoothing_auto_factor = ${rcTarget}`, "save"],
    });
  }

  // ------------------------------------------------------------------
  // Goal weighting
  // ------------------------------------------------------------------
  const weights: Record<string, Record<string, number>> = {
    racing: { overshoot: 1, slow: 1, "ff-": 0.9, dterm: 0.8, resonance: 0.7, "motor-sat": 1 },
    freestyle: { overshoot: 0.8, slow: 0.7, "ff-": 0.8, dterm: 1, resonance: 0.9, "motor-sat": 0.8 },
    // Indoor precision: a quiet hover and clean step response matter more than snap.
    precision: { overshoot: 1, slow: 0.6, "ff-": 0.5, dterm: 1, resonance: 1, "motor-sat": 0.7 },
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
function collectResonances(spectral: AxisSpectralLike[] | undefined, legacy?: LogMetrics): Resonance[] {
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

  if (spectral) {
    for (const s of spectral) {
      for (const p of s.peaks) {
        if (p.kind === "frameResonance" && p.ratioToFloor > 4 && p.freqHz >= 80) {
          addPeak(s.axis, p.freqHz, p.ratioToFloor, p.freqSpreadHz);
        }
      }
    }
  } else if (legacy) {
    // Legacy fallback for analyses persisted before spectral classification:
    // unclassified peaks — still floored at 100 Hz for notch targeting.
    for (const p of legacy.noisePeaks) {
      const floor = legacy.noiseFloor[p.axis];
      const ratio = floor > 0 ? p.magnitude / floor : 0;
      if (ratio > 4 && p.freqHz >= 80 && p.freqHz <= 500) {
        addPeak(p.axis, p.freqHz, ratio, null);
      }
    }
  }
  return groups.sort((a, b) => b.ratio - a.ratio).slice(0, 3);
}

/** The subset of AxisSpectral the rules read (keeps the helpers free of the spectrogram module). */
type AxisSpectralLike = NonNullable<LogMetrics["spectral"]>[number];

function collectMotorPeaks(
  spectral: AxisSpectralLike[] | undefined,
): { freqHz: number; ratioToFloor: number; harmonic?: number; aliased?: boolean }[] {
  if (!spectral) return [];
  return spectral
    .flatMap((s) => s.peaks)
    .filter((p) => p.kind === "motorHarmonic" && p.ratioToFloor > 4)
    .map((p) => ({ freqHz: p.freqHz, ratioToFloor: p.ratioToFloor, harmonic: p.harmonic, aliased: p.aliased }))
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

function ordinal(n: number): string {
  const suffix = n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

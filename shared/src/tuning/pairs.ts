/**
 * In-flight A/B pairs: two versions of a draft that go into two Betaflight
 * PID profiles so one pack decides one question. The D-term pairs are the
 * filtering-vs-delay trade-off (see variants.ts); the PID pairs are Chris
 * Rosser's and Brian White's slider sweeps ("fly the same moves at several
 * slider values and compare the step responses") reduced to one step per
 * pack: master multiplier, tracking (P&I), feedforward, dynamic idle.
 *
 * Every key a pair touches lives in the PID profile (PIDs, D-min, FF gains,
 * dyn_idle_min_rpm, the D-term filter chain) and is written into the
 * blackbox headers, so the Log Lab can tell A from B (see ab.ts).
 */
import type { AdvancedSettings, Axis, PidAxisSettings, ProfileSettings } from "../types/fc";
import { AXES } from "../types/fc";
import { applyVariant } from "./variants";

export type AbPairId =
  | "dterm-crisp"
  | "dterm-smooth"
  | "dterm-crisp-smooth"
  | "dterm-aos"
  | "pid-master"
  | "pid-tracking"
  | "pid-ff"
  | "pid-idle";

export type TuningStepId = "log" | "filters" | "master" | "pd" | "iterm" | "ff" | "dmax" | "rates";

export interface AbPairDef {
  id: AbPairId;
  group: "filter" | "pid";
  /** e.g. "Balanced vs Crisp" */
  title: string;
  labelA: string;
  labelB: string;
  /** what B changes, in one sentence */
  change: string;
  /** what decides the winner in the Log Lab / on the ground */
  decides: string;
  /** who prescribes this step */
  source: string;
  /** the tuning-sequence step this pair belongs to */
  step: TuningStepId;
}

/** Factors of the PID pairs (one slider step each). */
export const AB_MASTER_FACTOR = 1.15;
export const AB_TRACKING_FACTOR = 1.1;
export const AB_FF_FACTOR = 1.5;
/** Feedforward B side for a tune that runs FF 0 (roll/pitch/yaw). */
export const AB_FF_FROM_ZERO: [number, number, number] = [50, 50, 45];
/** Dynamic idle B side (rpm/100): 6000 rpm puts a 12-pole whoop's idle line at 100 Hz, the RPM filter floor. */
export const AB_IDLE_MIN = 60;
export const AB_IDLE_STEP = 20;

export const AB_PAIRS: readonly AbPairDef[] = [
  {
    id: "dterm-crisp",
    group: "filter",
    title: "Balanced vs Crisp",
    labelA: "Balanced",
    labelB: "Crisp",
    change: "B raises the D-term low-pass cutoffs by 25 % (less filtering, less delay); PIDs, FF, rates unchanged.",
    decides: "Motor temperature first; then B should show the same or lower overshoot, a slightly faster rise and no rise in D-term noise.",
    source: "Rosser: raise the D-term filter multiplier 0.1-0.2 at a time until the motors sound rough or come down warm, then back off.",
    step: "filters",
  },
  {
    id: "dterm-smooth",
    group: "filter",
    title: "Balanced vs Smooth",
    labelA: "Balanced",
    labelB: "Smooth",
    change: "B lowers the D-term low-pass cutoffs by 20 % (more filtering, ~1 ms more delay).",
    decides: "B is right when A's motors come down warm or the D-term noise is high; otherwise A.",
    source: "Rosser / Oscar Liang: never run the D-term filters so open that motors heat — leave headroom for a bent prop.",
    step: "filters",
  },
  {
    id: "dterm-crisp-smooth",
    group: "filter",
    title: "Crisp vs Smooth",
    labelA: "Crisp",
    labelB: "Smooth",
    change: "The two ends of the D-term filtering range in one pack (×1.25 vs ×0.8 cutoffs).",
    decides: "The bigger the felt difference, the more the build cares about D-term delay; the winner sets the next Balanced pair.",
    source: "Rosser's filter masterclass.",
    step: "filters",
  },
  {
    id: "dterm-aos",
    group: "filter",
    title: "Karate PT1 pair vs AOS biquad",
    labelA: "Karate",
    labelB: "AOS",
    change: "B replaces the two PT1 D-term low-passes with Rosser's AOS chain: one dynamic BIQUAD 80-110 Hz, curve expo 7, LPF2 off.",
    decides: "B wins with lower D-term noise at high throttle and no worse propwash; Rosser's own 65mm preset keeps the PT1 pair, so on a whoop this is an experiment.",
    source: "Rosser: the AOS tune rejects motor noise better at high throttle and attenuates useful signals less; Karate is more forgiving on noisy builds.",
    step: "filters",
  },
  {
    id: "pid-master",
    group: "pid",
    title: "Master 1.0 vs 1.15",
    labelA: "Master",
    labelB: "Master +15 %",
    change: "B scales P, I, D, D-min and feedforward together by 15 % (one master-multiplier step).",
    decides: "Motor temperature and D-term noise first (Rosser: 'as much as the build tolerates without hot motors or oscillation'); then a shorter rise with no new ringing (Brian White: stop when the latency gain flattens).",
    source: "Rosser tunes the master first; Brian White after the P:D ratio. Powerful high-KV motors want a lower master.",
    step: "master",
  },
  {
    id: "pid-tracking",
    group: "pid",
    title: "Tracking 1.0 vs 1.1",
    labelA: "Tracking",
    labelB: "Tracking +10 %",
    change: "B raises P and I by 10 % on every axis (Rosser's tracking slider), D unchanged — the P:D ratio moves.",
    decides: "B wins with a faster rise and at most a hair of overshoot; any ringing on B means the ratio is past its optimum (Rosser's red line: quick to 1.0, tiny overshoot, no oscillation).",
    source: "Rosser: fly the tracking slider at 0.5-1.25 with FF, I and dynamic damping at 0 and pick per axis from the step responses. Brian White sweeps the damping (D) slider instead.",
    step: "pd",
  },
  {
    id: "pid-ff",
    group: "pid",
    title: "Feedforward off vs on",
    labelA: "FF",
    labelB: "FF +",
    change: "B adds feedforward (50/50/45 when A runs 0, else ×1.5); PIDs, filters, rates unchanged.",
    decides: "Judge on the raw setpoint/gyro overlay, not the step tool (Brian White): B should close the gap at the start of sharp moves without sailing past the setpoint at the end. Motor temperature after jerky inputs.",
    source: "Rosser: return the stick-response slider to 0.5 and raise it until an overshoot appears at the start or end of a sharp move. Apply the radio-link preset first.",
    step: "ff",
  },
  {
    id: "pid-idle",
    group: "pid",
    title: "Dynamic idle vendor vs 6000 rpm",
    labelA: "Idle",
    labelB: "Idle 6000",
    change: "B raises dyn_idle_min_rpm to 60 (6000 rpm; +20 if A is already there), which puts a 12-pole whoop's idle line at 100 Hz, inside the RPM filter's range.",
    decides: "B wins on propwash and low-throttle stability (Rosser: dynamic idle is critical for propwash on small quads); A wins if descents and inverted hang time matter more.",
    source: "Rosser's table: 1.5in props 6600-13300 rpm; his AOS 65mm preset and the Mobula6 V3 run 10000. BetaFPV ships 2500-3500.",
    step: "iterm",
  },
];

export const AB_PAIR_BY_ID: Record<AbPairId, AbPairDef> = Object.fromEntries(AB_PAIRS.map((p) => [p.id, p])) as Record<
  AbPairId,
  AbPairDef
>;

// +1e-9: 110 × 1.15 is 126.49999… in floating point and must round like 126.5 does.
const clampGain = (v: number, max = 250) => Math.max(0, Math.min(max, Math.round(v + 1e-9)));

function scalePids(pids: PidAxisSettings | undefined, f: { p?: number; i?: number; d?: number }): PidAxisSettings | undefined {
  if (!pids) return pids;
  const out: PidAxisSettings = {};
  for (const axis of AXES) {
    const t = pids[axis];
    if (!t) continue;
    out[axis] = {
      ...t,
      ...(t.p !== undefined && f.p ? { p: clampGain(t.p * f.p) } : {}),
      ...(t.i !== undefined && f.i ? { i: clampGain(t.i * f.i) } : {}),
      ...(t.d !== undefined && f.d ? { d: clampGain(t.d * f.d) } : {}),
    };
  }
  return out;
}

const FF_KEYS: readonly (keyof AdvancedSettings)[] = ["feedforwardRoll", "feedforwardPitch", "feedforwardYaw"];

/** B side of a pair, or null when the draft lacks what the pair changes. */
export function abPairB(draft: ProfileSettings, id: AbPairId): ProfileSettings | null {
  switch (id) {
    case "dterm-crisp":
      return applyVariant(draft, "crisp", "profile");
    case "dterm-smooth":
      return applyVariant(draft, "smooth", "profile");
    case "dterm-crisp-smooth":
      return applyVariant(draft, "smooth", "profile");
    case "dterm-aos": {
      if (!draft.filters) return null;
      return {
        ...draft,
        filters: {
          ...draft.filters,
          dtermLowpassType: 1, // BIQUAD
          dtermLowpassDynMinHz: 80,
          dtermLowpassDynMaxHz: 110,
          dynLpfCurveExpo: 7,
          dtermLowpass2Hz: 0,
        },
      };
    }
    case "pid-master": {
      if (!draft.pids) return null;
      const adv: AdvancedSettings = { ...(draft.advanced ?? {}) };
      for (const k of ["dMinRoll", "dMinPitch"] as const) {
        if (adv[k] !== undefined) adv[k] = clampGain(adv[k]! * AB_MASTER_FACTOR);
      }
      for (const k of FF_KEYS) {
        if (adv[k] !== undefined) adv[k] = clampGain(adv[k]! * AB_MASTER_FACTOR, 1000);
      }
      return {
        ...draft,
        pids: scalePids(draft.pids, { p: AB_MASTER_FACTOR, i: AB_MASTER_FACTOR, d: AB_MASTER_FACTOR }),
        advanced: adv,
      };
    }
    case "pid-tracking":
      if (!draft.pids) return null;
      return { ...draft, pids: scalePids(draft.pids, { p: AB_TRACKING_FACTOR, i: AB_TRACKING_FACTOR }) };
    case "pid-ff": {
      const adv: AdvancedSettings = { ...(draft.advanced ?? {}) };
      const current = FF_KEYS.map((k) => adv[k] ?? 0);
      if (current.every((v) => v === 0)) {
        [adv.feedforwardRoll, adv.feedforwardPitch, adv.feedforwardYaw] = AB_FF_FROM_ZERO;
      } else {
        FF_KEYS.forEach((k, i) => {
          adv[k] = clampGain(current[i]! * AB_FF_FACTOR, 1000);
        });
      }
      return { ...draft, advanced: adv };
    }
    case "pid-idle": {
      const base = draft.advanced?.idleMinRpm;
      if (base === undefined) return null;
      const next = base < AB_IDLE_MIN ? AB_IDLE_MIN : Math.min(200, base + AB_IDLE_STEP);
      return { ...draft, advanced: { ...draft.advanced, idleMinRpm: next } };
    }
  }
}

/** A side of a pair (the draft, or the crisp variant for the crisp-vs-smooth pair). */
export function abPairA(draft: ProfileSettings, id: AbPairId): ProfileSettings {
  return id === "dterm-crisp-smooth" ? applyVariant(draft, "crisp", "profile") : draft;
}

export interface AbPairVariant {
  side: "A" | "B";
  label: string;
  settings: ProfileSettings;
}

/** Both sides with their Log Lab labels ("A · Balanced", "B · Crisp"), or null when the pair does not apply to the draft. */
export function abPairVariants(draft: ProfileSettings, id: AbPairId): [AbPairVariant, AbPairVariant] | null {
  const def = AB_PAIR_BY_ID[id];
  const b = abPairB(draft, id);
  if (!b) return null;
  const a = abPairA(draft, id);
  return [
    { side: "A", label: `A · ${def.labelA}`, settings: a },
    { side: "B", label: `B · ${def.labelB}`, settings: b },
  ];
}

/** Dotted keys that differ between two settings objects (pids.roll.p, advanced.idleMinRpm, filters.dtermLowpass2Hz …). */
export function settingsDiffKeys(a: ProfileSettings, b: ProfileSettings): string[] {
  const out: string[] = [];
  for (const axis of AXES as readonly Axis[]) {
    for (const term of ["p", "i", "d"] as const) {
      if (a.pids?.[axis]?.[term] !== b.pids?.[axis]?.[term]) out.push(`pids.${axis}.${term}`);
    }
  }
  for (const section of ["filters", "rates", "advanced"] as const) {
    const keys = new Set([...Object.keys(a[section] ?? {}), ...Object.keys(b[section] ?? {})]);
    for (const k of [...keys].sort()) {
      const va = (a[section] as Record<string, number | undefined> | undefined)?.[k];
      const vb = (b[section] as Record<string, number | undefined> | undefined)?.[k];
      if (va !== vb) out.push(`${section}.${k}`);
    }
  }
  return out;
}

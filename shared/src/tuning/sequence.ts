/**
 * The tuning sequence the wizard walks the pilot through — Chris Rosser's
 * Betaflight 4.5 masterclass order (filters → master → P:D → I → FF →
 * dynamic damping → rates), with Brian White's PIDtoolbox variant noted
 * where it differs (P:D ratio before the master). Each step names the flight
 * to fly, what decides it, and which A/B pair in the wizard is that step.
 */
import type { AbTest } from "../types/entities";
import type { AbPairId, TuningStepId } from "./pairs";

export interface TuningStep {
  id: TuningStepId;
  title: string;
  /** what the step settles */
  goal: string;
  /** the flight to fly and how */
  fly: string;
  /** what decides the step */
  decide: string;
  /** wizard pairs that run this step (empty = manual/observational) */
  pairs: AbPairId[];
  /** who prescribes it */
  source: string;
}

export const TUNING_SEQUENCE: readonly TuningStep[] = [
  {
    id: "log",
    title: "Log a baseline",
    goal: "A clean 2 kHz blackbox log of the build as it is, before any change.",
    fly: "Fresh props, everything mounted as you fly it. Hover 30-40 s at a metre or more (no ground effect), three slow throttle sweeps to full, then normal flying with sharp roll and pitch moves. One arm per pack so each flight is its own log.",
    decide: "The Log Lab analysis exists: noise sources classified (raw and filtered gyro), motor pole count confirmed, step response with enough windows.",
    pairs: [],
    source: "Rosser (blackbox settings: 1.6-2 kHz, any debug mode on 4.5), Brian White (30-40 s hover at 3-4 ft).",
  },
  {
    id: "filters",
    title: "Filters",
    goal: "Gyro LPF1 off, LPF2 at 1000 Hz, RPM filter faded in where the motor noise starts with Q pushed while nothing leaks, one dynamic notch per frame stripe (none if there is no stripe), then the D-term filters opened until the motors get rough or warm.",
    fly: "Tick the filter recommendations from the baseline log, write them, fly the Balanced vs Crisp pair (and Karate vs AOS if you want to try Rosser's biquad chain).",
    decide: "Raw gyro shows the stripes and motor lines; filtered gyro shows nothing leaking; motors cool; D-term noise low in both throttle bands.",
    pairs: ["dterm-crisp", "dterm-smooth", "dterm-crisp-smooth", "dterm-aos"],
    source: "Rosser's filter masterclass; Brian White (D-term noise under -10 dB, prefer filtering the D-term over the gyro).",
  },
  {
    id: "master",
    title: "Master multiplier",
    goal: "As much overall gain as the build tolerates without hot motors, rough-sounding motors or oscillation.",
    fly: "Dynamic damping (D-max) at 0 for the sweep. Fly the Master pair: the same lines on A and B, sharp moves, throttle chops, touch the motors after each.",
    decide: "Motor temperature and D-term noise first; then the shorter rise without new ringing. Stop when the improvement stops (Rosser) or the latency gain flattens (Brian White). High-KV motors want a lower master.",
    pairs: ["pid-master"],
    source: "Rosser (master first, 'the volume'); Brian White does this after the P:D ratio.",
  },
  {
    id: "pd",
    title: "P:D balance",
    goal: "The P:D ratio per axis: quick to the setpoint, a hair of overshoot, no oscillation.",
    fly: "FF 0, I near 0, D-max 0 for the sweep. Angle mode is fine. Wobble test: hold the stick and wobble left-right / out-and-back, 20-25 moves per axis, never let the stick snap back. Fly the Tracking pair.",
    decide: "Per axis in the Log Lab step response: faster rise and at most a hair of overshoot wins; ringing means the ratio is past its optimum. Pitch often wants more than roll.",
    pairs: ["pid-tracking"],
    source: "Rosser (tracking slider 0.5-1.25 by step response); Brian White (damping slider in 0.2 steps, overshoot + rebound = not enough D).",
  },
  {
    id: "iterm",
    title: "I-term and dynamic idle",
    goal: "I high enough that the tail of the step holds flat and the quad feels precise through gaps, without slow bounce-back after fast moves; dynamic idle high enough for propwash.",
    fly: "Raise I in big steps (it is non-linear) until slow wobbles or bounce-back appear after sharp moves and throttle pumps, then back off. Fly the Dynamic idle pair once.",
    decide: "Steady-state error gone (no drooping tail), no slow drawn-out overshoot. Idle pair: propwash and low-throttle stability vs descent authority.",
    pairs: ["pid-idle"],
    source: "Rosser (I-term wider tuning window, bounce-back = too much); Brian White (drooping tail = too little I, slow overshoot = too much).",
  },
  {
    id: "ff",
    title: "Feedforward",
    goal: "Stick tracking without overshoot at the start or end of sharp moves. Indoor precision tunes may stay at 0.",
    fly: "Apply the ELRS 500 Hz radio preset first (FF smoothing/jitter/averaging). Fly the Feedforward pair with sharp 360° flips and rolls.",
    decide: "On the raw setpoint/gyro overlay: B should close the gap at the start of moves and return cleanly at the end. Gyro lagging at the start but catching up = raise FF boost; leading = lower boost. With a 500 Hz link do not judge FF from the step tool (Brian White).",
    pairs: ["pid-ff"],
    source: "Rosser (stick-response slider from 0.5 up; boost; max rate limit 92-95 on responsive quads); Brian White (FF 0.5 ≈ -6 ms, 1.0 ≈ -12 ms).",
  },
  {
    id: "dmax",
    title: "Dynamic damping",
    goal: "D boosts to its maximum on sharp moves only, and sits at its minimum in normal flight (advance stays 0).",
    fly: "Log with debug mode D_MIN, do normal flying then moderate and sharp moves; read the actual D in Blackbox Explorer.",
    decide: "Gain right when D does not boost in normal flight, a little on moderate moves, fully on the sharpest. Use it either to allow more FF, or to lower the resting D for cooler motors.",
    pairs: [],
    source: "Rosser (gain 37 is a good start, advance always 0); Brian White leaves D-max off unless the base D must be extreme.",
  },
  {
    id: "rates",
    title: "Rates and RC smoothing",
    goal: "Centre sensitivity for the flying you do, max rate as low as comfortable, RC smoothing for the style.",
    fly: "Fly the rate A/B (switchable in flight) on the lines you actually fly.",
    decide: "Precision: lower centre (50-100); dynamic flying ~150; max 500-700, raise it only when flips take an age. RC smoothing auto factor: racing 25, freestyle 50-60, cinematic 90-100.",
    pairs: [],
    source: "Rosser's rates masterclass; Brian White's RC-smoothing delay measurements.",
  },
];

export const TUNING_STEP_BY_ID: Record<TuningStepId, TuningStep> = Object.fromEntries(
  TUNING_SEQUENCE.map((s) => [s.id, s]),
) as Record<TuningStepId, TuningStep>;

export interface TuningProgressEntry {
  step: TuningStepId;
  done: boolean;
  updatedAt: number;
  notes: string | null;
}

export type TuningStepState = "done" | "flown" | "todo";

export interface TuningSequenceStatus {
  steps: { id: TuningStepId; state: TuningStepState; evidence: string | null }[];
  /** first step that is neither done nor flown */
  nextId: TuningStepId | null;
}

/**
 * Where a drone is in the sequence: a step is "done" when the pilot ticked
 * it, "flown" when the data shows it was run (an analysed log, an A/B pair
 * of that step recorded, a rate A/B recorded), "todo" otherwise.
 */
export function sequenceStatus(input: {
  hasAnalysis: boolean;
  abTests: readonly AbTest[];
  progress: readonly TuningProgressEntry[];
}): TuningSequenceStatus {
  const doneSteps = new Set(input.progress.filter((p) => p.done).map((p) => p.step));
  const pairsFlown = new Set(input.abTests.map((t) => t.pairId).filter((id): id is string => !!id));
  const rateFlown = input.abTests.some((t) => t.kind === "rate");
  const steps = TUNING_SEQUENCE.map((s) => {
    let evidence: string | null = null;
    if (s.id === "log" && input.hasAnalysis) evidence = "a log is analysed";
    else if (s.id === "rates" && rateFlown) evidence = "rate A/B recorded";
    else {
      const flown = s.pairs.filter((p) => pairsFlown.has(p));
      if (flown.length > 0) evidence = `${flown.length === 1 ? "pair" : "pairs"} ${flown.join(", ")} recorded`;
    }
    const state: TuningStepState = doneSteps.has(s.id) ? "done" : evidence ? "flown" : "todo";
    return { id: s.id, state, evidence };
  });
  const next = steps.find((s) => s.state === "todo");
  return { steps, nextId: next?.id ?? null };
}

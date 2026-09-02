/**
 * Betaflight 4.5 simplified tuning ("sliders") — the exact formulas of
 * src/main/config/simplified_tuning.c on the 4.5-maintenance branch, plus
 * their inverse so a template or vendor tune can be shown as slider
 * positions.
 *
 * Convention for the inverse: the master multiplier is fixed at 100 (the
 * Configurator default), so every gain is expressed relative to the
 * Betaflight defaults. Slider values are integers; the firmware clamps PID
 * sliders to 0–200 and filter sliders to 10–200.
 */
import type { AdvancedSettings, Axis, FilterSettings, PidTerms, ProfileSettings } from "../types/fc";

/** pid.h on 4.5-maintenance: PID_ROLL_DEFAULT / PID_PITCH_DEFAULT / PID_YAW_DEFAULT and D_MIN_DEFAULT. */
export const BF45_SLIDER_DEFAULTS: Record<Axis, { p: number; i: number; d: number; f: number; dMin: number }> = {
  roll: { p: 45, i: 80, d: 40, f: 120, dMin: 30 },
  pitch: { p: 47, i: 84, d: 46, f: 125, dMin: 34 },
  yaw: { p: 45, i: 80, d: 0, f: 120, dMin: 0 },
};
/** gyro.h / pid.h defaults the filter sliders scale. */
export const BF45_SLIDER_FILTER_DEFAULTS = {
  gyroLpf1DynMinHz: 250,
  gyroLpf1DynMaxHz: 500,
  gyroLpf2Hz: 500,
  dtermLpf1DynMinHz: 75,
  dtermLpf1DynMaxHz: 150,
  dtermLpf2Hz: 150,
  lpfMaxHz: 1000,
} as const;
const PID_GAIN_MAX = 250;
const F_GAIN_MAX = 1000;
export const SLIDER_PID_MIN = 0;
export const SLIDER_FILTER_MIN = 10;
export const SLIDER_MAX = 200;

export type SimplifiedPidsMode = "OFF" | "RP" | "RPY";

/** The PID slider set (Configurator names in comments; values are the CLI integers). */
export interface SimplifiedPidSliders {
  mode: SimplifiedPidsMode;
  /** simplified_master_multiplier */
  master: number;
  /** simplified_pi_gain ("PI gain") */
  piGain: number;
  /** simplified_i_gain ("I gain") */
  iGain: number;
  /** simplified_d_gain ("D gain") */
  dGain: number;
  /** simplified_dmin_ratio ("D max gain" in 4.3+, "D min ratio" in the CLI) */
  dminRatio: number;
  /** simplified_feedforward_gain */
  feedforwardGain: number;
  /** simplified_pitch_pi_gain ("Pitch:Roll PI ratio") */
  pitchPiGain: number;
  /** simplified_roll_pitch_ratio ("Pitch:Roll D ratio") */
  rollPitchRatio: number;
}

export interface SimplifiedFilterSliders {
  /** simplified_gyro_filter_multiplier (0 = simplified gyro filtering off) */
  gyroMultiplier: number;
  /** simplified_dterm_filter_multiplier (0 = off) */
  dtermMultiplier: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** C integer truncation of a positive float (constrain(float, 0, max) → uint8). */
const trunc = (v: number) => Math.trunc(v);

/**
 * calculateNewPidValues, verbatim: PIDs, D-min and FF per axis for a slider
 * set. Axes beyond the mode (RP → yaw untouched) are returned as null.
 */
export function simplifiedToPids(
  s: SimplifiedPidSliders,
): Record<Axis, { p: number; i: number; d: number; dMin: number; f: number } | null> {
  const out: Record<Axis, { p: number; i: number; d: number; dMin: number; f: number } | null> = {
    roll: null,
    pitch: null,
    yaw: null,
  };
  if (s.mode === "OFF") return out;
  const master = s.master / 100;
  const pi = s.piGain / 100;
  const dg = s.dGain / 100;
  const ff = s.feedforwardGain / 100;
  const ig = s.iGain / 100;
  const axes: Axis[] = s.mode === "RPY" ? ["roll", "pitch", "yaw"] : ["roll", "pitch"];
  for (const axis of axes) {
    const d = BF45_SLIDER_DEFAULTS[axis];
    const pitchDGain = axis === "pitch" ? s.rollPitchRatio / 100 : 1;
    const pitchPiGain = axis === "pitch" ? s.pitchPiGain / 100 : 1;
    const dminRatio = d.dMin > 0 ? 1 + ((d.d - d.dMin) / d.dMin) * (s.dminRatio / 100) : 1;
    out[axis] = {
      p: trunc(clamp(d.p * master * pi * pitchPiGain, 0, PID_GAIN_MAX)),
      i: trunc(clamp(d.i * master * pi * ig * pitchPiGain, 0, PID_GAIN_MAX)),
      d: trunc(clamp(d.dMin * master * dg * pitchDGain * dminRatio, 0, PID_GAIN_MAX)),
      dMin: trunc(clamp(d.dMin * master * dg * pitchDGain, 0, PID_GAIN_MAX)),
      f: trunc(clamp(d.f * master * pitchPiGain * ff, 0, F_GAIN_MAX)),
    };
  }
  return out;
}

/** calculateNewDTermFilterValues / calculateNewGyroFilterValues, verbatim (0 cutoffs stay 0). */
export function simplifiedToFilters(s: SimplifiedFilterSliders, current: FilterSettings): FilterSettings {
  const f = { ...current };
  const d = BF45_SLIDER_FILTER_DEFAULTS;
  if (s.dtermMultiplier > 0) {
    if (f.dtermLowpassDynMinHz) {
      f.dtermLowpassDynMinHz = trunc(clamp((d.dtermLpf1DynMinHz * s.dtermMultiplier) / 100, 0, d.lpfMaxHz));
      f.dtermLowpassDynMaxHz = trunc(clamp((d.dtermLpf1DynMaxHz * s.dtermMultiplier) / 100, 0, d.lpfMaxHz));
    }
    if (f.dtermLowpassHz) f.dtermLowpassHz = trunc(clamp((d.dtermLpf1DynMinHz * s.dtermMultiplier) / 100, 0, d.lpfMaxHz));
    if (f.dtermLowpass2Hz) f.dtermLowpass2Hz = trunc(clamp((d.dtermLpf2Hz * s.dtermMultiplier) / 100, 0, d.lpfMaxHz));
  }
  if (s.gyroMultiplier > 0) {
    if (f.gyroLowpassDynMinHz) {
      f.gyroLowpassDynMinHz = trunc(clamp((d.gyroLpf1DynMinHz * s.gyroMultiplier) / 100, 0, d.lpfMaxHz));
      f.gyroLowpassDynMaxHz = trunc(clamp((d.gyroLpf1DynMaxHz * s.gyroMultiplier) / 100, 0, d.lpfMaxHz));
    }
    if (f.gyroLowpassHz) f.gyroLowpassHz = trunc(clamp((d.gyroLpf1DynMinHz * s.gyroMultiplier) / 100, 0, d.lpfMaxHz));
    if (f.gyroLowpass2Hz) f.gyroLowpass2Hz = trunc(clamp((d.gyroLpf2Hz * s.gyroMultiplier) / 100, 0, d.lpfMaxHz));
  }
  return f;
}

export interface SliderFit {
  sliders: SimplifiedPidSliders;
  /** what the sliders reproduce, per axis */
  reproduced: Record<Axis, { p: number; i: number; d: number; dMin: number; f: number } | null>;
  /** largest |reproduced − actual| / actual over the fitted terms, in % */
  maxErrorPercent: number;
  /** terms whose reproduction is more than 5 % off (the tune was not made with sliders, or master ≠ 100) */
  offTerms: string[];
  /** true when every fitted term is within 1 gain unit or 2 % */
  exact: boolean;
}

/**
 * Slider positions that reproduce a tune as closely as possible, with the
 * master multiplier fixed at 100. Each slider is solved from the term that
 * defines it (roll P → PI gain, roll I → I gain, roll D-min → D gain, roll D
 * → D max gain, roll FF → FF gain, pitch P → pitch:roll PI, pitch D-min →
 * pitch:roll D), then the whole set is evaluated forward and the residuals
 * reported so a hand tune that no slider set can express is not passed off
 * as one. Yaw decides the mode: RPY when yaw P/I/FF fit the roll gains,
 * RP otherwise.
 */
export function fitSimplifiedSliders(settings: ProfileSettings): SliderFit | null {
  const pids = settings.pids;
  const roll = pids?.roll;
  const pitch = pids?.pitch;
  if (!roll || !pitch || roll.p === undefined || roll.i === undefined || roll.d === undefined) return null;
  const adv: Partial<AdvancedSettings> = settings.advanced ?? {};
  const D = BF45_SLIDER_DEFAULTS;
  const dMinRoll = adv.dMinRoll ?? roll.d; // D-min off (0) means D is flat: treat D-min as D
  const dMinPitch = adv.dMinPitch ?? pitch.d ?? 0;
  const ffRoll = adv.feedforwardRoll;
  const ffPitch = adv.feedforwardPitch;

  const piGain = roll.p / D.roll.p;
  const iGain = piGain > 0 ? roll.i / (D.roll.i * piGain) : 1;
  const dMinRollEff = dMinRoll > 0 ? dMinRoll : roll.d;
  const dGain = dMinRollEff / D.roll.dMin;
  // D = dMin·(1 + ((40−30)/30)·r/100)  →  r = 100·(D/dMin − 1)·(30/10)
  const dminRatio = dMinRollEff > 0 ? (100 * (roll.d / dMinRollEff - 1) * D.roll.dMin) / (D.roll.d - D.roll.dMin) : 100;
  const feedforwardGain = ffRoll !== undefined ? ffRoll / D.roll.f : 100 / 100;
  const pitchPiGain = piGain > 0 && pitch.p !== undefined ? pitch.p / (D.pitch.p * piGain) : 1;
  const dMinPitchEff = dMinPitch > 0 ? dMinPitch : (pitch.d ?? 0);
  const rollPitchRatio = dGain > 0 ? dMinPitchEff / (D.pitch.dMin * dGain) : 1;

  const sliderInt = (v: number, lo = SLIDER_PID_MIN) => clamp(Math.round(v * 100), lo, SLIDER_MAX);
  const base: SimplifiedPidSliders = {
    mode: "RP",
    master: 100,
    piGain: sliderInt(piGain),
    iGain: sliderInt(iGain),
    dGain: sliderInt(dGain),
    dminRatio: clamp(Math.round(dminRatio), SLIDER_PID_MIN, SLIDER_MAX),
    feedforwardGain: sliderInt(feedforwardGain),
    pitchPiGain: sliderInt(pitchPiGain),
    rollPitchRatio: sliderInt(rollPitchRatio),
  };

  // Yaw: RPY only when the roll gains reproduce yaw within 5 %.
  const yaw = pids?.yaw;
  let mode: SimplifiedPidsMode = "RP";
  if (yaw && yaw.p !== undefined && yaw.i !== undefined) {
    const y = simplifiedToPids({ ...base, mode: "RPY" }).yaw!;
    const fits =
      relErr(y.p, yaw.p) <= 0.05 &&
      relErr(y.i, yaw.i) <= 0.05 &&
      (adv.feedforwardYaw === undefined || relErr(y.f, adv.feedforwardYaw) <= 0.05);
    if (fits) mode = "RPY";
  }
  const sliders = { ...base, mode };
  const reproduced = simplifiedToPids(sliders);

  const checks: [string, number | undefined, number | undefined][] = [
    ["roll P", reproduced.roll?.p, roll.p],
    ["roll I", reproduced.roll?.i, roll.i],
    ["roll D", reproduced.roll?.d, roll.d],
    ["roll D-min", reproduced.roll?.dMin, dMinRoll > 0 ? dMinRoll : undefined],
    ["roll FF", reproduced.roll?.f, ffRoll],
    ["pitch P", reproduced.pitch?.p, pitch.p],
    ["pitch I", reproduced.pitch?.i, pitch.i],
    ["pitch D", reproduced.pitch?.d, pitch.d],
    ["pitch D-min", reproduced.pitch?.dMin, dMinPitch > 0 ? dMinPitch : undefined],
    ["pitch FF", reproduced.pitch?.f, ffPitch],
  ];
  if (mode === "RPY" && yaw) {
    checks.push(["yaw P", reproduced.yaw?.p, yaw.p], ["yaw I", reproduced.yaw?.i, yaw.i], ["yaw FF", reproduced.yaw?.f, adv.feedforwardYaw]);
  }
  let maxErr = 0;
  const offTerms: string[] = [];
  let exact = true;
  for (const [name, got, want] of checks) {
    if (got === undefined || want === undefined) continue;
    const err = relErr(got, want);
    maxErr = Math.max(maxErr, err);
    if (err > 0.05) offTerms.push(name);
    if (Math.abs(got - want) > 1 && err > 0.02) exact = false;
  }
  return { sliders, reproduced, maxErrorPercent: maxErr * 100, offTerms, exact };
}

/** Filter multipliers from the D-term / gyro low-pass cutoffs (100 = Betaflight defaults). */
export function fitFilterSliders(filters: FilterSettings | undefined): SimplifiedFilterSliders & { offTerms: string[] } {
  const d = BF45_SLIDER_FILTER_DEFAULTS;
  const offTerms: string[] = [];
  const ratio = (v: number | undefined, def: number) => (v && v > 0 ? v / def : null);
  const dterm = [
    ratio(filters?.dtermLowpassDynMinHz, d.dtermLpf1DynMinHz),
    ratio(filters?.dtermLowpassDynMaxHz, d.dtermLpf1DynMaxHz),
    ratio(filters?.dtermLowpassHz, d.dtermLpf1DynMinHz),
    ratio(filters?.dtermLowpass2Hz, d.dtermLpf2Hz),
  ].filter((v): v is number => v !== null);
  const gyro = [
    ratio(filters?.gyroLowpassDynMinHz, d.gyroLpf1DynMinHz),
    ratio(filters?.gyroLowpassDynMaxHz, d.gyroLpf1DynMaxHz),
    ratio(filters?.gyroLowpassHz, d.gyroLpf1DynMinHz),
    ratio(filters?.gyroLowpass2Hz, d.gyroLpf2Hz),
  ].filter((v): v is number => v !== null);
  const pick = (vals: number[], label: string): number => {
    if (vals.length === 0) return 0;
    const m = clamp(Math.round(median(vals) * 100), SLIDER_FILTER_MIN, SLIDER_MAX);
    // A chain whose cutoffs disagree by more than 10 % was not set by one slider.
    if (vals.some((v) => Math.abs(v * 100 - m) > 10)) offTerms.push(label);
    return m;
  };
  return { dtermMultiplier: pick(dterm, "D-term filters"), gyroMultiplier: pick(gyro, "gyro filters"), offTerms };
}

function relErr(got: number, want: number): number {
  if (want === 0) return got === 0 ? 0 : 1;
  return Math.abs(got - want) / Math.abs(want);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** CLI lines for a slider set (the same keys Configurator writes). */
export function simplifiedSlidersToCli(pids: SimplifiedPidSliders, filters?: SimplifiedFilterSliders): string[] {
  const lines = [
    `set simplified_pids_mode = ${pids.mode}`,
    `set simplified_master_multiplier = ${pids.master}`,
    `set simplified_i_gain = ${pids.iGain}`,
    `set simplified_d_gain = ${pids.dGain}`,
    `set simplified_pi_gain = ${pids.piGain}`,
    `set simplified_dmin_ratio = ${pids.dminRatio}`,
    `set simplified_feedforward_gain = ${pids.feedforwardGain}`,
    `set simplified_pitch_d_gain = ${pids.rollPitchRatio}`,
    `set simplified_pitch_pi_gain = ${pids.pitchPiGain}`,
  ];
  if (filters) {
    lines.push(
      `set simplified_dterm_filter = ${filters.dtermMultiplier > 0 ? "ON" : "OFF"}`,
      `set simplified_dterm_filter_multiplier = ${Math.max(SLIDER_FILTER_MIN, filters.dtermMultiplier)}`,
      `set simplified_gyro_filter = ${filters.gyroMultiplier > 0 ? "ON" : "OFF"}`,
      `set simplified_gyro_filter_multiplier = ${Math.max(SLIDER_FILTER_MIN, filters.gyroMultiplier)}`,
    );
  }
  return lines;
}

/** PidTerms helper for tests/UI: the reproduced values as ProfileSettings pids. */
export function reproducedPidTerms(fit: SliderFit): Record<Axis, PidTerms | null> {
  return {
    roll: fit.reproduced.roll ? { p: fit.reproduced.roll.p, i: fit.reproduced.roll.i, d: fit.reproduced.roll.d } : null,
    pitch: fit.reproduced.pitch ? { p: fit.reproduced.pitch.p, i: fit.reproduced.pitch.i, d: fit.reproduced.pitch.d } : null,
    yaw: fit.reproduced.yaw ? { p: fit.reproduced.yaw.p, i: fit.reproduced.yaw.i, d: fit.reproduced.yaw.d } : null,
  };
}

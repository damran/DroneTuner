import type { ProfileSettings } from "../types/fc";
import { RATES_TYPE_NAMES } from "../types/fc";

/**
 * ProfileSettings → Betaflight 4.5 CLI `set` lines. Used for the "Copy CLI"
 * path of every recommendation/draft — the user always chooses between the
 * confirm-gated MSP apply flow and a copy-pasteable config snippet.
 *
 * Values are absolute (resolve deltas against a base first via applyChanges).
 * Rates/TPA ints are written as-is: BF 4.3+ CLI uses the same integer format
 * as MSP (roll_rc_rate = deg/s ÷ 10, tpa_rate = percent).
 */

/** Keys that MSP cannot write on BF 4.4/4.5 (API 1.45/1.46) — CLI-only. */
export const CLI_ONLY_KEYS: ReadonlySet<string> = new Set([
  "rpmFilterFadeRangeHz",
  "rpmFilterQ",
  "rpmFilterWeight1",
  "rpmFilterWeight2",
  "rpmFilterWeight3",
]);

const FILTER_TYPE_NAMES = ["PT1", "BIQUAD", "PT2", "PT3"];
const ITERM_RELAX_NAMES = ["OFF", "RP", "RPY", "RP_INC", "RPY_INC"];
const FF_AVERAGING_NAMES = ["OFF", "2_POINT", "3_POINT", "4_POINT"];
// BF lookupTableTpaMode (settings.c): PD=0 (attenuate P and D), D=1 (D only).
// Exported so the CLI-dump parser derives its reverse lookup from the same
// table — the two must never drift.
export const TPA_MODE_NAMES = ["PD", "D"];

const PID_CLI: Record<string, string> = {
  "roll.p": "p_roll",
  "roll.i": "i_roll",
  "roll.d": "d_roll",
  "pitch.p": "p_pitch",
  "pitch.i": "i_pitch",
  "pitch.d": "d_pitch",
  "yaw.p": "p_yaw",
  "yaw.i": "i_yaw",
  "yaw.d": "d_yaw",
};

// BF 4.5 CLI names (verified against 4.5.2 settings.c / parameter_names.h).
// Note the 4.5 renames: dyn LPF ranges are gyro_lpf1_dyn_* / dterm_lpf1_dyn_*,
// the curve expo is per-filter (MSP carries the D-term one), and per-axis
// feedforward gains are f_roll/f_pitch/f_yaw (feedforward_* remains only for
// the non-axis settings).
const FILTER_CLI: Record<string, string> = {
  gyroLowpassHz: "gyro_lpf1_static_hz",
  gyroLowpassType: "gyro_lpf1_type",
  gyroLowpassDynMinHz: "gyro_lpf1_dyn_min_hz",
  gyroLowpassDynMaxHz: "gyro_lpf1_dyn_max_hz",
  gyroLowpass2Hz: "gyro_lpf2_static_hz",
  gyroLowpass2Type: "gyro_lpf2_type",
  yawLowpassHz: "yaw_lowpass_hz",
  dtermLowpassHz: "dterm_lpf1_static_hz",
  dtermLowpassType: "dterm_lpf1_type",
  dtermLowpassDynMinHz: "dterm_lpf1_dyn_min_hz",
  dtermLowpassDynMaxHz: "dterm_lpf1_dyn_max_hz",
  dtermLowpass2Hz: "dterm_lpf2_static_hz",
  dtermLowpass2Type: "dterm_lpf2_type",
  dynNotchCount: "dyn_notch_count",
  dynNotchMinHz: "dyn_notch_min_hz",
  dynNotchMaxHz: "dyn_notch_max_hz",
  dynNotchQ: "dyn_notch_q",
  dynLpfCurveExpo: "dterm_lpf1_dyn_expo",
  rpmFilterHarmonics: "rpm_filter_harmonics",
  rpmFilterMinHz: "rpm_filter_min_hz",
  rpmFilterFadeRangeHz: "rpm_filter_fade_range_hz",
  rpmFilterQ: "rpm_filter_q",
};

const FILTER_ENUM_CLI: Record<string, string[]> = {
  gyroLowpassType: FILTER_TYPE_NAMES,
  gyroLowpass2Type: FILTER_TYPE_NAMES,
  dtermLowpassType: FILTER_TYPE_NAMES,
  dtermLowpass2Type: FILTER_TYPE_NAMES,
};

const RATE_CLI: Record<string, string> = {
  rcRate: "roll_rc_rate",
  rcRatePitch: "pitch_rc_rate",
  rcRateYaw: "yaw_rc_rate",
  rcExpo: "roll_expo",
  rcExpoPitch: "pitch_expo",
  rcExpoYaw: "yaw_expo",
  rollRate: "roll_srate",
  pitchRate: "pitch_srate",
  yawRate: "yaw_srate",
  thrMid: "thr_mid",
  thrExpo: "thr_expo",
  ratesType: "rates_type",
};

const RATE_ENUM_CLI: Record<string, readonly string[]> = {
  ratesType: RATES_TYPE_NAMES,
};

const ADVANCED_CLI: Record<string, string> = {
  feedforwardRoll: "f_roll",
  feedforwardPitch: "f_pitch",
  feedforwardYaw: "f_yaw",
  feedforwardTransition: "feedforward_transition",
  feedforwardAveraging: "feedforward_averaging",
  feedforwardSmoothFactor: "feedforward_smooth_factor",
  feedforwardBoost: "feedforward_boost",
  feedforwardMaxRateLimit: "feedforward_max_rate_limit",
  feedforwardJitterFactor: "feedforward_jitter_factor",
  itermRelax: "iterm_relax",
  itermRelaxCutoff: "iterm_relax_cutoff",
  dMinRoll: "d_min_roll",
  dMinPitch: "d_min_pitch",
  dMaxGain: "d_max_gain",
  dMaxAdvance: "d_max_advance",
  thrustLinear: "thrust_linear",
  antiGravityGain: "anti_gravity_gain",
  tpaMode: "tpa_mode",
  tpaRate: "tpa_rate",
  tpaBreakpoint: "tpa_breakpoint",
  vbatSagCompensation: "vbat_sag_compensation",
  idleMinRpm: "dyn_idle_min_rpm",
};

const ADVANCED_ENUM_CLI: Record<string, string[]> = {
  itermRelax: ITERM_RELAX_NAMES,
  feedforwardAveraging: FF_AVERAGING_NAMES,
  tpaMode: TPA_MODE_NAMES,
};

function enumName(table: readonly string[], v: number): string {
  return table[v] ?? String(v);
}

/** Absolute settings → CLI lines. Only keys present in `settings` are emitted. */
export function settingsToCli(settings: ProfileSettings): string[] {
  const lines: string[] = [];

  if (settings.pids) {
    for (const axis of ["roll", "pitch", "yaw"] as const) {
      const terms = settings.pids[axis];
      if (!terms) continue;
      for (const term of ["p", "i", "d"] as const) {
        const v = terms[term];
        if (v === undefined) continue;
        lines.push(`set ${PID_CLI[`${axis}.${term}`]} = ${v}`);
      }
    }
  }

  if (settings.filters) {
    for (const [key, v] of Object.entries(settings.filters)) {
      if (v === undefined) continue;
      if (key.startsWith("rpmFilterWeight")) continue; // combined below
      const cli = FILTER_CLI[key];
      if (!cli) continue;
      const enumTable = FILTER_ENUM_CLI[key];
      lines.push(`set ${cli} = ${enumTable ? enumName(enumTable, v) : v}`);
    }
    const w1 = settings.filters.rpmFilterWeight1;
    const w2 = settings.filters.rpmFilterWeight2;
    const w3 = settings.filters.rpmFilterWeight3;
    if (w1 !== undefined || w2 !== undefined || w3 !== undefined) {
      lines.push(`set rpm_filter_weights = ${w1 ?? 100},${w2 ?? 100},${w3 ?? 100}`);
    }
  }

  if (settings.rates) {
    for (const [key, v] of Object.entries(settings.rates)) {
      if (v === undefined) continue;
      const cli = RATE_CLI[key];
      if (!cli) continue;
      const enumTable = RATE_ENUM_CLI[key];
      lines.push(`set ${cli} = ${enumTable ? enumName(enumTable, v) : v}`);
    }
  }

  if (settings.advanced) {
    for (const [key, v] of Object.entries(settings.advanced)) {
      if (v === undefined) continue;
      const cli = ADVANCED_CLI[key];
      if (!cli) continue;
      const enumTable = ADVANCED_ENUM_CLI[key];
      lines.push(`set ${cli} = ${enumTable ? enumName(enumTable, v) : v}`);
    }
  }

  return lines;
}

/** True when every changed key can be written via MSP on BF 4.4/4.5. */
export function isMspWritable(settings: ProfileSettings): boolean {
  for (const [section, obj] of Object.entries(settings)) {
    if (!obj) continue;
    for (const key of Object.keys(obj)) {
      if (CLI_ONLY_KEYS.has(key)) return false;
      void section;
    }
  }
  return true;
}

/** Keys of `changes` that are CLI-only (for per-recommendation badging). */
export function cliOnlyKeys(settings: ProfileSettings): string[] {
  const out: string[] = [];
  for (const obj of Object.values(settings)) {
    if (!obj) continue;
    for (const key of Object.keys(obj)) {
      if (CLI_ONLY_KEYS.has(key)) out.push(key);
    }
  }
  return out;
}

/**
 * Split settings into the MSP-writable part and the CLI-only keys that were
 * removed. Applied at the apply-flow boundary so the confirm diff never shows
 * a change the MSP write can't perform.
 */
export function partitionCliOnly(settings: ProfileSettings): { msp: ProfileSettings; stripped: string[] } {
  const stripped: string[] = [];
  const msp: ProfileSettings = {};
  for (const [section, obj] of Object.entries(settings) as [keyof ProfileSettings, Record<string, unknown>][]) {
    if (!obj) continue;
    if (section === "pids") {
      msp.pids = settings.pids; // PID leaves are never CLI-only
      continue;
    }
    const kept: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(obj)) {
      if (CLI_ONLY_KEYS.has(key)) stripped.push(key);
      else kept[key] = v;
    }
    (msp as Record<string, unknown>)[section] = kept;
  }
  return { msp, stripped };
}

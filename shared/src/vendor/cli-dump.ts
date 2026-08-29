import type { ProfileSettings } from "../types/fc";
import { RATES_TYPE_NAMES } from "../types/fc";
import { TPA_MODE_NAMES } from "../tuning/cli";

/**
 * Parser for Betaflight CLI dumps (`dump` / `diff all` output) as published
 * by BNF vendors (BetaFPV, Happymodel, Flywoo, …) or pasted by the user.
 * Maps the CLI keys DroneTuner manages onto ProfileSettings; everything else
 * is reported in `ignored` so the caller can see what was skipped.
 */

/** name → index map derived from a canonical BF lookup-name table. */
function namesToEnum(names: readonly string[]): Record<string, number> {
  return Object.fromEntries(names.map((n, i) => [n, i]));
}

export interface CliDumpMeta {
  boardName?: string;
  manufacturerId?: string;
  craftName?: string;
  /** FC target from the dump header comment, e.g. "BETAFPVF405". */
  targetName?: string;
  fcVersion?: string;
}

export interface CliDumpParseResult {
  settings: ProfileSettings;
  meta: CliDumpMeta;
  /** CLI keys that were mapped into settings. */
  recognized: string[];
  /** `set` keys present in the dump but not managed by DroneTuner. */
  ignored: string[];
}

const FILTER_TYPE_ENUM: Record<string, number> = { PT1: 0, BIQUAD: 1, PT2: 2, PT3: 3 };
const ITERM_RELAX_ENUM: Record<string, number> = { OFF: 0, RP: 1, RPY: 2, RP_INC: 3, RPY_INC: 4 };
const FF_AVERAGING_ENUM: Record<string, number> = { OFF: 0, "2_POINT": 1, "3_POINT": 2, "4_POINT": 3 };

const PID_KEYS: Record<string, readonly ["roll" | "pitch" | "yaw", "p" | "i" | "d"]> = {
  p_roll: ["roll", "p"],
  i_roll: ["roll", "i"],
  d_roll: ["roll", "d"],
  p_pitch: ["pitch", "p"],
  i_pitch: ["pitch", "i"],
  d_pitch: ["pitch", "d"],
  p_yaw: ["yaw", "p"],
  i_yaw: ["yaw", "i"],
  d_yaw: ["yaw", "d"],
};

/**
 * key → [settings field, enum map?]. BF renamed the gyro/D-term LPF settings
 * in 4.5 (`gyro_lowpass_hz` → `gyro_lpf1_static_hz`, `gyro_lowpass_dyn_min_hz`
 * → `gyro_lpf1_dyn_min_hz`, `dyn_lpf_curve_expo` → per-filter
 * `dterm_lpf1_dyn_expo`, …) — both generations are accepted so vendor dumps
 * from 4.3/4.4 and 4.5+ all parse.
 */
const FILTER_KEYS: Record<string, { field: string; enum?: Record<string, number> }> = {
  // BF 4.5+ canonical names
  gyro_lpf1_static_hz: { field: "gyroLowpassHz" },
  gyro_lpf1_type: { field: "gyroLowpassType", enum: FILTER_TYPE_ENUM },
  gyro_lpf1_dyn_min_hz: { field: "gyroLowpassDynMinHz" },
  gyro_lpf1_dyn_max_hz: { field: "gyroLowpassDynMaxHz" },
  gyro_lpf2_static_hz: { field: "gyroLowpass2Hz" },
  gyro_lpf2_type: { field: "gyroLowpass2Type", enum: FILTER_TYPE_ENUM },
  dterm_lpf1_static_hz: { field: "dtermLowpassHz" },
  dterm_lpf1_type: { field: "dtermLowpassType", enum: FILTER_TYPE_ENUM },
  dterm_lpf1_dyn_min_hz: { field: "dtermLowpassDynMinHz" },
  dterm_lpf1_dyn_max_hz: { field: "dtermLowpassDynMaxHz" },
  dterm_lpf1_dyn_expo: { field: "dynLpfCurveExpo" },
  dterm_lpf2_static_hz: { field: "dtermLowpass2Hz" },
  dterm_lpf2_type: { field: "dtermLowpass2Type", enum: FILTER_TYPE_ENUM },
  // BF ≤4.4 names (legacy dumps)
  gyro_lowpass_hz: { field: "gyroLowpassHz" },
  gyro_lowpass_dyn_min_hz: { field: "gyroLowpassDynMinHz" },
  gyro_lowpass_dyn_max_hz: { field: "gyroLowpassDynMaxHz" },
  gyro_lowpass_type: { field: "gyroLowpassType", enum: FILTER_TYPE_ENUM },
  gyro_lowpass2_hz: { field: "gyroLowpass2Hz" },
  gyro_lowpass2_type: { field: "gyroLowpass2Type", enum: FILTER_TYPE_ENUM },
  dterm_lowpass_hz: { field: "dtermLowpassHz" },
  dterm_lowpass_dyn_min_hz: { field: "dtermLowpassDynMinHz" },
  dterm_lowpass_dyn_max_hz: { field: "dtermLowpassDynMaxHz" },
  dterm_lowpass_type: { field: "dtermLowpassType", enum: FILTER_TYPE_ENUM },
  dterm_lowpass2_hz: { field: "dtermLowpass2Hz" },
  dterm_lowpass2_type: { field: "dtermLowpass2Type", enum: FILTER_TYPE_ENUM },
  dyn_lpf_curve_expo: { field: "dynLpfCurveExpo" },
  // unchanged across versions
  yaw_lowpass_hz: { field: "yawLowpassHz" },
  dyn_notch_count: { field: "dynNotchCount" },
  dyn_notch_min_hz: { field: "dynNotchMinHz" },
  dyn_notch_max_hz: { field: "dynNotchMaxHz" },
  dyn_notch_q: { field: "dynNotchQ" },
  rpm_filter_harmonics: { field: "rpmFilterHarmonics" },
  rpm_filter_min_hz: { field: "rpmFilterMinHz" },
  rpm_filter_fade_range_hz: { field: "rpmFilterFadeRangeHz" },
  rpm_filter_q: { field: "rpmFilterQ" },
};

/**
 * RC tuning keys. BF 4.3+ prints these as plain ints (deg/s ÷ 10 for rates,
 * ×100 for expo); pre-4.3 dumps may show 2-decimal floats — parseScaled
 * handles both. Both the modern per-axis names (`roll_rc_rate`, …) and the
 * legacy names (`rc_rate`, …) map onto the same MSP fields. `rates_type`
 * carries the curve convention the values are authored under.
 */
const RATE_KEYS: Record<string, { field: string; enum?: Record<string, number> }> = {
  // BF 4.3+ per-axis names (used by current dumps and official presets)
  roll_rc_rate: { field: "rcRate" },
  pitch_rc_rate: { field: "rcRatePitch" },
  yaw_rc_rate: { field: "rcRateYaw" },
  roll_expo: { field: "rcExpo" },
  pitch_expo: { field: "rcExpoPitch" },
  yaw_expo: { field: "rcExpoYaw" },
  // legacy (pre-4.3) names
  rc_rate: { field: "rcRate" },
  rc_expo: { field: "rcExpo" },
  rc_rate_pitch: { field: "rcRatePitch" },
  rc_expo_pitch: { field: "rcExpoPitch" },
  rc_rate_yaw: { field: "rcRateYaw" },
  rc_expo_yaw: { field: "rcExpoYaw" },
  // unchanged across versions
  roll_srate: { field: "rollRate" },
  pitch_srate: { field: "pitchRate" },
  yaw_srate: { field: "yawRate" },
  thr_mid: { field: "thrMid" },
  thr_expo: { field: "thrExpo" },
  rates_type: { field: "ratesType", enum: namesToEnum(RATES_TYPE_NAMES) },
};

const ADVANCED_KEYS: Record<string, { field: string; enum?: Record<string, number> }> = {
  // BF 4.5+ per-axis feedforward gains
  f_roll: { field: "feedforwardRoll" },
  f_pitch: { field: "feedforwardPitch" },
  f_yaw: { field: "feedforwardYaw" },
  // BF ≤4.4 names
  feedforward_roll: { field: "feedforwardRoll" },
  feedforward_pitch: { field: "feedforwardPitch" },
  feedforward_yaw: { field: "feedforwardYaw" },
  feedforward_transition: { field: "feedforwardTransition" },
  feedforward_averaging: { field: "feedforwardAveraging", enum: FF_AVERAGING_ENUM },
  feedforward_smooth_factor: { field: "feedforwardSmoothFactor" },
  feedforward_boost: { field: "feedforwardBoost" },
  feedforward_max_rate_limit: { field: "feedforwardMaxRateLimit" },
  feedforward_jitter_factor: { field: "feedforwardJitterFactor" },
  iterm_relax: { field: "itermRelax", enum: ITERM_RELAX_ENUM },
  iterm_relax_cutoff: { field: "itermRelaxCutoff" },
  d_min_roll: { field: "dMinRoll" },
  d_min_pitch: { field: "dMinPitch" },
  d_max_gain: { field: "dMaxGain" },
  d_max_advance: { field: "dMaxAdvance" },
  thrust_linear: { field: "thrustLinear" },
  anti_gravity_gain: { field: "antiGravityGain" },
  tpa_mode: { field: "tpaMode", enum: namesToEnum(TPA_MODE_NAMES) },
  tpa_rate: { field: "tpaRate" },
  tpa_breakpoint: { field: "tpaBreakpoint" },
  vbat_sag_compensation: { field: "vbatSagCompensation" },
  dyn_idle_min_rpm: { field: "idleMinRpm" },
};

function parseScaled(raw: string): number | null {
  const v = Number.parseFloat(raw);
  if (Number.isNaN(v)) return null;
  // CLI floats (e.g. "1.10") are stored ×100 in MSP; plain ints are used as-is.
  return raw.includes(".") ? Math.round(v * 100) : Math.round(v);
}

/** Enum lookup by CLI name, with a numeric fallback (`set tpa_mode = 1`). */
function enumValue(map: Record<string, number>, raw: string): number | null {
  const byName = map[raw.toUpperCase()];
  if (byName !== undefined) return byName;
  return parseInt(raw);
}

function parseInt(raw: string): number | null {
  const v = Number.parseFloat(raw);
  return Number.isNaN(v) ? null : Math.round(v);
}

/** Strip HTML tags/entities so dumps pasted into vendor pages still parse. */
export function extractText(htmlOrText: string): string {
  return htmlOrText
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|pre|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/** True when the text looks like it contains Betaflight CLI `set` lines. */
export function looksLikeCliDump(text: string): boolean {
  return /^\s*set\s+[a-z0-9_]+\s*=/gim.test(text);
}

export function parseCliDump(input: string): CliDumpParseResult {
  const text = extractText(input);
  const settings: ProfileSettings = {};
  const meta: CliDumpMeta = {};
  const recognized: string[] = [];
  const ignored: string[] = [];

  // Header comment: "# Betaflight / STM32F405 (S405) 4.5.0 ..." plus
  // "# board_name X" / "# manufacturer_id Y" lines from `diff all`.
  const versionMatch = /#\s*Betaflight\s*\/\s*\S+\s*\([^)]*\)\s*(\d+\.\d+\.\d+)/i.exec(text);
  if (versionMatch) meta.fcVersion = versionMatch[1];
  const boardMatch = /^#?\s*board_name\s+(\S+)\s*$/gim.exec(text);
  if (boardMatch) meta.boardName = boardMatch[1];
  const mfgMatch = /^#?\s*manufacturer_id\s+(\S+)\s*$/gim.exec(text);
  if (mfgMatch) meta.manufacturerId = mfgMatch[1];
  const targetMatch = /^#?\s*target_name\s+(\S+)\s*$/gim.exec(text);
  if (targetMatch) meta.targetName = targetMatch[1];

  const setRe = /^\s*set\s+([a-z0-9_]+)\s*=\s*(.+?)\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = setRe.exec(text)) !== null) {
    const key = m[1]!.toLowerCase();
    const raw = m[2]!.trim();

    if (key === "name") {
      meta.craftName = raw;
      recognized.push(key);
      continue;
    }

    // rpm_filter_weights is a CLI array ("100,100,100") — split into the
    // three scalar leaves the settings model uses.
    if (key === "rpm_filter_weights") {
      const parts = raw.split(",").map((s) => parseInt(s));
      if (parts.length === 3 && parts.every((v): v is number => v !== null)) {
        settings.filters = {
          ...settings.filters,
          rpmFilterWeight1: parts[0]!,
          rpmFilterWeight2: parts[1]!,
          rpmFilterWeight3: parts[2]!,
        };
        recognized.push(key);
      } else {
        ignored.push(key);
      }
      continue;
    }

    const pid = PID_KEYS[key];
    if (pid) {
      const v = parseInt(raw);
      if (v === null) {
        ignored.push(key);
        continue;
      }
      const [axis, term] = pid;
      settings.pids ??= {};
      settings.pids[axis] = { ...settings.pids[axis], [term]: v };
      recognized.push(key);
      continue;
    }

    const filter = FILTER_KEYS[key];
    if (filter) {
      const v = filter.enum ? enumValue(filter.enum, raw) : parseInt(raw);
      if (v === undefined || v === null) {
        ignored.push(key);
        continue;
      }
      settings.filters = { ...settings.filters, [filter.field]: v };
      recognized.push(key);
      continue;
    }

    const rate = RATE_KEYS[key];
    if (rate) {
      const v = rate.enum ? enumValue(rate.enum, raw) : parseScaled(raw);
      if (v === undefined || v === null) {
        ignored.push(key);
        continue;
      }
      settings.rates = { ...settings.rates, [rate.field]: v };
      recognized.push(key);
      continue;
    }

    const adv = ADVANCED_KEYS[key];
    if (adv) {
      const v = adv.enum ? enumValue(adv.enum, raw) : parseInt(raw);
      if (v === undefined || v === null) {
        ignored.push(key);
        continue;
      }
      settings.advanced = { ...settings.advanced, [adv.field]: v };
      recognized.push(key);
      continue;
    }

    ignored.push(key);
  }

  return { settings, meta, recognized, ignored };
}

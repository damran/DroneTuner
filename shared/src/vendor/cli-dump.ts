import type { ProfileSettings } from "../types/fc";

/**
 * Parser for Betaflight CLI dumps (`dump` / `diff all` output) as published
 * by BNF vendors (BetaFPV, Happymodel, Flywoo, …) or pasted by the user.
 * Maps the CLI keys DroneTuner manages onto ProfileSettings; everything else
 * is reported in `ignored` so the caller can see what was skipped.
 */

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

/** key → [settings field, enum map?] */
const FILTER_KEYS: Record<string, { field: string; enum?: Record<string, number> }> = {
  gyro_lowpass_hz: { field: "gyroLowpassHz" },
  gyro_lowpass_dyn_min_hz: { field: "gyroLowpassDynMinHz" },
  gyro_lowpass_dyn_max_hz: { field: "gyroLowpassDynMaxHz" },
  gyro_lowpass_type: { field: "gyroLowpassType", enum: FILTER_TYPE_ENUM },
  dterm_lowpass_hz: { field: "dtermLowpassHz" },
  dterm_lowpass_dyn_min_hz: { field: "dtermLowpassDynMinHz" },
  dterm_lowpass_dyn_max_hz: { field: "dtermLowpassDynMaxHz" },
  dterm_lowpass_type: { field: "dtermLowpassType", enum: FILTER_TYPE_ENUM },
  dyn_notch_count: { field: "dynNotchCount" },
  dyn_notch_min_hz: { field: "dynNotchMinHz" },
  dyn_notch_max_hz: { field: "dynNotchMaxHz" },
  dyn_notch_q: { field: "dynNotchQ" },
};

/** RC tuning keys. CLI prints these as 2-decimal floats; MSP stores them ×100. */
const RATE_KEYS: Record<string, string> = {
  rc_rate: "rcRate",
  rc_expo: "rcExpo",
  rc_rate_pitch: "rcRatePitch",
  rc_expo_pitch: "rcExpoPitch",
  rc_rate_yaw: "rcRateYaw",
  rc_expo_yaw: "rcExpoYaw",
  roll_srate: "rollRate",
  pitch_srate: "pitchRate",
  yaw_srate: "yawRate",
  thr_mid: "thrMid",
  thr_expo: "thrExpo",
};

const ADVANCED_KEYS: Record<string, { field: string; enum?: Record<string, number> }> = {
  feedforward_roll: { field: "feedforwardRoll" },
  feedforward_pitch: { field: "feedforwardPitch" },
  feedforward_yaw: { field: "feedforwardYaw" },
  feedforward_transition: { field: "feedforwardTransition" },
  feedforward_averaging: { field: "feedforwardAveraging", enum: FF_AVERAGING_ENUM },
  feedforward_smooth_factor: { field: "feedforwardSmoothFactor" },
  feedforward_boost: { field: "feedforwardBoost" },
  iterm_relax: { field: "itermRelax", enum: ITERM_RELAX_ENUM },
  iterm_relax_cutoff: { field: "itermRelaxCutoff" },
  d_min_roll: { field: "dMinRoll" },
  d_min_pitch: { field: "dMinPitch" },
  thrust_linear: { field: "thrustLinear" },
  anti_gravity_gain: { field: "antiGravityGain" },
  tpa_rate: { field: "tpaRate" },
  tpa_breakpoint: { field: "tpaBreakpoint" },
};

function parseScaled(raw: string): number | null {
  const v = Number.parseFloat(raw);
  if (Number.isNaN(v)) return null;
  // CLI floats (e.g. "1.10") are stored ×100 in MSP; plain ints are used as-is.
  return raw.includes(".") ? Math.round(v * 100) : Math.round(v);
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

    const pid = PID_KEYS[key];
    if (pid) {
      const v = parseInt(raw);
      if (v === null) break;
      const [axis, term] = pid;
      settings.pids ??= {};
      settings.pids[axis] = { ...settings.pids[axis], [term]: v };
      recognized.push(key);
      continue;
    }

    const filter = FILTER_KEYS[key];
    if (filter) {
      const v = filter.enum ? filter.enum[raw.toUpperCase()] : parseInt(raw);
      if (v === undefined || v === null) {
        ignored.push(key);
        continue;
      }
      settings.filters = { ...settings.filters, [filter.field]: v };
      recognized.push(key);
      continue;
    }

    const rateField = RATE_KEYS[key];
    if (rateField) {
      const v = parseScaled(raw);
      if (v === null) {
        ignored.push(key);
        continue;
      }
      settings.rates = { ...settings.rates, [rateField]: v };
      recognized.push(key);
      continue;
    }

    const adv = ADVANCED_KEYS[key];
    if (adv) {
      const v = adv.enum ? adv.enum[raw.toUpperCase()] : parseInt(raw);
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

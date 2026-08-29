import type { ConfigSection, DiffEntry, FcConfig, ProfileSettings } from "../types/fc";
import { CONFIG_SECTION_ORDER, RATES_TYPE, RATES_TYPE_NAMES } from "../types/fc";

export interface DiffResult {
  diff: DiffEntry[];
  sections: ConfigSection[];
  upToDate: boolean;
}

const PID_LABELS: Record<string, string> = {
  p: "P",
  i: "I",
  d: "D",
};

const FILTER_LABELS: Record<string, string> = {
  gyroLowpassHz: "Gyro LPF",
  gyroLowpassDynMinHz: "Gyro dyn LPF min",
  gyroLowpassDynMaxHz: "Gyro dyn LPF max",
  gyroLowpassType: "Gyro LPF type",
  gyroLowpass2Hz: "Gyro LPF2",
  gyroLowpass2Type: "Gyro LPF2 type",
  yawLowpassHz: "Yaw LPF",
  dtermLowpassHz: "D-term LPF",
  dtermLowpassDynMinHz: "D-term dyn LPF min",
  dtermLowpassDynMaxHz: "D-term dyn LPF max",
  dtermLowpassType: "D-term LPF type",
  dtermLowpass2Hz: "D-term LPF2",
  dtermLowpass2Type: "D-term LPF2 type",
  dynNotchCount: "Dyn notch count",
  dynNotchMinHz: "Dyn notch min",
  dynNotchMaxHz: "Dyn notch max",
  dynNotchQ: "Dyn notch Q",
  dynLpfCurveExpo: "Dyn LPF curve expo",
  rpmFilterHarmonics: "RPM filter harmonics",
  rpmFilterMinHz: "RPM filter min Hz",
  rpmFilterFadeRangeHz: "RPM filter fade range",
  rpmFilterQ: "RPM filter Q",
  rpmFilterWeight1: "RPM filter weight (1st harmonic)",
  rpmFilterWeight2: "RPM filter weight (2nd harmonic)",
  rpmFilterWeight3: "RPM filter weight (3rd harmonic)",
};

const RATE_LABELS: Record<string, string> = {
  rcRate: "RC rate",
  rcExpo: "RC expo",
  rcRatePitch: "RC rate (pitch)",
  rcExpoPitch: "RC expo (pitch)",
  rcRateYaw: "RC rate (yaw)",
  rcExpoYaw: "RC expo (yaw)",
  rollRate: "Roll super/max rate",
  pitchRate: "Pitch super/max rate",
  yawRate: "Yaw super/max rate",
  thrMid: "Throttle mid",
  thrExpo: "Throttle expo",
  ratesType: "Rates type",
};

const ADVANCED_LABELS: Record<string, string> = {
  feedforwardRoll: "Feedforward roll",
  feedforwardPitch: "Feedforward pitch",
  feedforwardYaw: "Feedforward yaw",
  feedforwardTransition: "FF transition",
  feedforwardAveraging: "FF averaging",
  feedforwardSmoothFactor: "FF smooth factor",
  feedforwardBoost: "FF boost",
  feedforwardMaxRateLimit: "FF max rate limit",
  feedforwardJitterFactor: "FF jitter factor",
  itermRelax: "I-term relax",
  itermRelaxCutoff: "I-term relax cutoff",
  dMinRoll: "D Min roll",
  dMinPitch: "D Min pitch",
  dMaxGain: "Dynamic damping gain",
  dMaxAdvance: "Dynamic damping advance",
  thrustLinear: "Thrust linear",
  antiGravityGain: "Anti-gravity gain",
  tpaMode: "TPA mode",
  tpaRate: "TPA rate",
  tpaBreakpoint: "TPA breakpoint",
  vbatSagCompensation: "VBAT sag compensation",
  idleMinRpm: "Dynamic idle min RPM",
};

/** Rate keys whose scale/meaning depends on rates_type (deg/s ÷ 10 under ACTUAL). */
const RATE_VALUE_KEYS = new Set(["rcRate", "rcRatePitch", "rcRateYaw", "rollRate", "pitchRate", "yawRate"]);

/**
 * Display formatting for a setting value. Rates, expo and TPA rate are stored
 * ×100 (e.g. 110 == 1.10) — except the rate keys under rates_type ACTUAL,
 * which are deg/s ÷ 10 (e.g. 67 == 670 °/s). Feedforward is displayed as a
 * raw integer, like Betaflight does.
 */
export function formatSettingValue(path: string, v: number, ratesType?: number): string {
  if (path === "rates.ratesType") return RATES_TYPE_NAMES[v] ?? String(v);
  if (path.startsWith("rates.")) {
    if (ratesType === RATES_TYPE.ACTUAL && RATE_VALUE_KEYS.has(path.slice(6))) {
      return `${v * 10} °/s`;
    }
    return (v / 100).toFixed(2);
  }
  if (path === "advanced.tpaRate") return (v / 100).toFixed(2);
  return String(v);
}

/** Human label for a setting key within its section (falls back to the raw key). */
export function settingLabel(section: "filters" | "rates" | "advanced", key: string): string {
  const map = section === "filters" ? FILTER_LABELS : section === "rates" ? RATE_LABELS : ADVANCED_LABELS;
  return map[key] ?? key;
}

const AXES = ["roll", "pitch", "yaw"] as const;

/** Compare a target profile against the current FC config. */
export function diffConfig(current: FcConfig, target: ProfileSettings): DiffResult {
  const diff: DiffEntry[] = [];
  const touched = new Set<ConfigSection>();

  const compare = (
    section: ConfigSection,
    path: string,
    label: string,
    from: number | undefined,
    to: number | undefined,
    fromRatesType?: number,
    toRatesType?: number,
  ): void => {
    if (to === undefined) return;
    if (from === to) return;
    // Never fabricate a baseline: keys the FC read didn't decode show "?".
    diff.push({
      path,
      label,
      from: from ?? null,
      to,
      fromDisplay: from === undefined ? "?" : formatSettingValue(path, from, fromRatesType),
      toDisplay: formatSettingValue(path, to, toRatesType ?? fromRatesType),
    });
    touched.add(section);
  };

  for (const axis of AXES) {
    const t = target.pids?.[axis];
    const c = current.pids[axis];
    if (!t) continue;
    for (const term of ["p", "i", "d"] as const) {
      if (t[term] !== undefined) {
        compare("pids", `pids.${axis}.${term}`, `${cap(axis)} ${PID_LABELS[term]}`, c[term], t[term]);
      }
    }
  }

  for (const [key, to] of Object.entries(target.filters ?? {})) {
    compare("filters", `filters.${key}`, FILTER_LABELS[key] ?? key, current.filters[key], to);
  }

  // Rate values are formatted under each side's own convention: when a
  // profile switches rates_type, "from" and "to" are in different units.
  const currentRatesType = current.rates.ratesType;
  const targetRatesType = target.rates?.ratesType ?? currentRatesType;
  for (const [key, to] of Object.entries(target.rates ?? {})) {
    compare("rates", `rates.${key}`, RATE_LABELS[key] ?? key, current.rates[key], to, currentRatesType, targetRatesType);
  }

  for (const [key, to] of Object.entries(target.advanced ?? {})) {
    compare("advanced", `advanced.${key}`, ADVANCED_LABELS[key] ?? key, current.advanced[key], to);
  }

  return {
    diff,
    sections: CONFIG_SECTION_ORDER.filter((s) => touched.has(s)),
    upToDate: diff.length === 0,
  };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

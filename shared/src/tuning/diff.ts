import type { ConfigSection, DiffEntry, FcConfig, ProfileSettings } from "../types/fc";
import { CONFIG_SECTION_ORDER } from "../types/fc";

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
  rollRate: "Roll super rate",
  pitchRate: "Pitch super rate",
  yawRate: "Yaw super rate",
  thrMid: "Throttle mid",
  thrExpo: "Throttle expo",
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

function formatValue(path: string, v: number): string {
  // Rates and TPA rate are stored x100 (e.g. 110 == 1.10); feedforward is
  // displayed as a raw integer in Betaflight, so leave it unscaled.
  if (path.startsWith("rates.")) return (v / 100).toFixed(2);
  if (path === "advanced.tpaRate") return (v / 100).toFixed(2);
  return String(v);
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
  ): void => {
    if (to === undefined) return;
    if (from === to) return;
    // Never fabricate a baseline: keys the FC read didn't decode show "?".
    diff.push({
      path,
      label,
      from: from ?? null,
      to,
      fromDisplay: from === undefined ? "?" : formatValue(path, from),
      toDisplay: formatValue(path, to),
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

  for (const [key, to] of Object.entries(target.rates ?? {})) {
    compare("rates", `rates.${key}`, RATE_LABELS[key] ?? key, current.rates[key], to);
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

/**
 * Flight-controller configuration model shared by the client MSP layer
 * (which owns the wire layouts) and the server (diff / apply-plan).
 *
 * Raw MSP integer units are used everywhere (e.g. rcRate 110 means 1.10)
 * to keep profile values exact and comparable across encode/decode.
 */

export type Axis = "roll" | "pitch" | "yaw";
export const AXES: readonly Axis[] = ["roll", "pitch", "yaw"];
export const AXIS_LABELS: Record<Axis, string> = { roll: "Roll", pitch: "Pitch", yaw: "Yaw" };

export interface PidTerms {
  p: number;
  i: number;
  d: number;
}

/** Filter fields the tuning system understands (subset of MSP_FILTER_CONFIG). */
export interface FilterSettings {
  gyroLowpassHz?: number;
  gyroLowpassDynMinHz?: number;
  gyroLowpassDynMaxHz?: number;
  gyroLowpassType?: number; // BF filter type enum index (PT1/BIQUAD/PT2/PT3)
  dtermLowpassHz?: number;
  dtermLowpassDynMinHz?: number;
  dtermLowpassDynMaxHz?: number;
  dtermLowpassType?: number;
  dynNotchCount?: number;
  dynNotchMinHz?: number;
  dynNotchMaxHz?: number;
  dynNotchQ?: number;
}

/** RC tuning fields the tuning system understands (subset of MSP_RC_TUNING). */
export interface RateSettings {
  rcRate?: number;
  rcExpo?: number;
  rcRatePitch?: number;
  rcExpoPitch?: number;
  rcRateYaw?: number;
  rcExpoYaw?: number;
  rollRate?: number; // super rate
  pitchRate?: number;
  yawRate?: number;
  thrMid?: number;
  thrExpo?: number;
}

/** PID-advanced fields the tuning system understands (subset of MSP_PID_ADVANCED). */
export interface AdvancedSettings {
  feedforwardRoll?: number;
  feedforwardPitch?: number;
  feedforwardYaw?: number;
  feedforwardTransition?: number;
  feedforwardAveraging?: number;
  feedforwardSmoothFactor?: number;
  feedforwardBoost?: number;
  itermRelax?: number;
  itermRelaxCutoff?: number;
  /** BF "d_min" values — the D floor at full throttle (Configurator "D Min"). */
  dMinRoll?: number;
  dMinPitch?: number;
  thrustLinear?: number;
  antiGravityGain?: number;
  tpaRate?: number;
  tpaBreakpoint?: number;
}

export interface PidAxisSettings {
  roll?: Partial<PidTerms>;
  pitch?: Partial<PidTerms>;
  yaw?: Partial<PidTerms>;
}

/**
 * The content of a tuning profile: any subset of the managed settings.
 * Stored as profiles.settings_json.
 */
export interface ProfileSettings {
  pids?: PidAxisSettings;
  filters?: FilterSettings;
  rates?: RateSettings;
  advanced?: AdvancedSettings;
}

/** Config sections in the order they are written to the FC. */
export type ConfigSection = "filters" | "pids" | "rates" | "advanced";
export const CONFIG_SECTION_ORDER: readonly ConfigSection[] = ["filters", "pids", "rates", "advanced"];

/**
 * Decoded view of the FC config. Layout-specific sections are keyed by
 * field name (the client MSP module is the single authority on layouts).
 */
export interface FcConfig {
  apiVersion: string;
  fcVariant: string;
  fcVersion: string;
  pids: { roll: PidTerms; pitch: PidTerms; yaw: PidTerms };
  filters: Record<string, number>;
  rates: Record<string, number>;
  advanced: Record<string, number>;
  featureMask: number;
}

/** One raw MSP section captured in a snapshot (payload replay for restore). */
export interface FcDumpSection {
  command: number;
  payloadHex: string;
}

/**
 * Full restorable snapshot. Restore replays raw section payloads, so it is
 * correct regardless of layout interpretation.
 */
export interface FcDump {
  apiVersion: string;
  fcVariant: string;
  fcVersion: string;
  capturedAt: number;
  sections: FcDumpSection[];
  decoded: FcConfig;
}

/**
 * Identity of a connected flight controller, read via MSP_BOARD_INFO /
 * MSP_NAME / MSP_UID. Used to auto-detect which fleet drone is plugged in.
 * All fields beyond the version triple are best-effort (older firmware or
 * non-Betaflight variants may not answer every command).
 */
export interface FcIdentity {
  apiVersion: string;
  fcVariant: string;
  fcVersion: string;
  /** 4-char board identifier from MSP_BOARD_INFO (e.g. "S405"). */
  boardId: string | null;
  /** Build target name (e.g. "MATEKF411", "BETAFPVF405"). */
  targetName: string | null;
  /** Human board name from MSP_BOARD_INFO (API >= 1.42). */
  boardName: string | null;
  /** Manufacturer ID from MSP_BOARD_INFO (e.g. "MTKS"). */
  manufacturerId: string | null;
  /** Pilot-set craft name (MSP_NAME). */
  craftName: string | null;
  /** 96-bit unique chip ID as hex (MSP_UID). */
  uid: string | null;
}

export interface DiffEntry {
  /** dotted path, e.g. "pids.roll.p" */
  path: string;
  label: string;
  from: number | null;
  to: number | null;
  /** formatted display values (client-independent formatting ok) */
  fromDisplay: string;
  toDisplay: string;
}

export interface ApplyPlan {
  diff: DiffEntry[];
  /** sections that need to be written, in write order */
  sections: ConfigSection[];
  /** full target settings (profile settings as applied) */
  target: ProfileSettings;
  upToDate: boolean;
}

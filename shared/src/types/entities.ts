import type { Finding, LogMetrics } from "../analysis/types";
import type { FcDump, ProfileSettings } from "./fc";

export type ComponentCategory =
  | "frame"
  | "motor"
  | "prop"
  | "battery"
  | "fc_esc"
  | "rx"
  | "vtx"
  | "camera";

export const COMPONENT_CATEGORIES: readonly ComponentCategory[] = [
  "frame",
  "motor",
  "prop",
  "battery",
  "fc_esc",
  "rx",
  "vtx",
  "camera",
];

export const COMPONENT_CATEGORY_LABELS: Record<ComponentCategory, string> = {
  frame: "Frame",
  motor: "Motors",
  prop: "Props",
  battery: "Batteries",
  fc_esc: "FC / ESC",
  rx: "Receiver",
  vtx: "VTX",
  camera: "Camera",
};

/** Per-category spec keys shown in the UI / seeded in the library. */
export const COMPONENT_SPEC_KEYS: Record<ComponentCategory, string[]> = {
  frame: ["wheelbase_mm", "weight_g", "prop_size_in", "material"],
  motor: ["size", "kv", "weight_g", "cells"],
  prop: ["size_in", "pitch_in", "blades", "material"],
  battery: ["cells", "capacity_mah", "c_rating", "connector", "weight_g"],
  fc_esc: ["mcu", "gyro", "esc_current_a", "esc_protocol", "uart_count"],
  rx: ["protocol", "diversity"],
  vtx: ["max_power_mw", "smartaudio"],
  camera: ["fov_deg", "ratio"],
};

export interface Component {
  id: number;
  category: ComponentCategory;
  name: string;
  specs: Record<string, unknown>;
  notes: string | null;
}

export interface Drone {
  id: number;
  name: string;
  sizeClass: string;
  notes: string | null;
  createdAt: number;
  /**
   * FC identity learned on connect (auto-detect). All nullable — a drone
   * that was never connected has no identity yet.
   */
  fcTarget: string | null;
  fcBoard: string | null;
  fcCraftName: string | null;
  fcUid: string | null;
  /** "analog" | "hd" | null (unknown) */
  videoSystem: string | null;
}

export interface DroneComponentLink {
  droneId: number;
  componentId: number;
  slot: string;
}

export interface DronePhoto {
  id: number;
  droneId: number;
  path: string;
  isPrimary: boolean;
}

export interface Flight {
  id: number;
  droneId: number;
  batteryComponentId: number | null;
  logId: number | null;
  date: number;
  durationS: number | null;
  styleTag: string | null;
}

export const FLIGHT_STYLE_TAGS = ["racing", "freestyle", "cinematic", "cruise", "test"] as const;

export interface FlightLog {
  id: number;
  droneId: number;
  filePath: string;
  headers: Record<string, string> | null;
  uploadedAt: number;
  /** 0-based flight session inside the uploaded file (a flash download holds one per arm). */
  sessionIndex: number;
  sessionCount: number;
  /** Name of the uploaded file, e.g. "BTFL_BLACKBOX_LOG_AIR65_R_20260518_125703_BETAFPVG473.BBL". */
  originalName: string | null;
  /** Flight duration from the log's own timestamps (seconds). */
  durationS: number | null;
  /** When the flight was recorded: log header datetime, else the filename timestamp, else null. */
  recordedAt: number | null;
}

/** Response of POST /api/logs: one row per kept flight session. */
export interface LogUploadResult {
  logs: FlightLog[];
  /** sessions in the file that were too short (arm/disarm blips) or unparsable */
  skippedSessions: number;
  sessionCount: number;
}

export interface Analysis {
  id: number;
  logId: number;
  metrics: LogMetrics;
  findings: Finding[];
  createdAt: number;
}

export type ProfileSource = "template" | "generated" | "snapshot";

/**
 * What the pilot wants from the tune. Latency-vs-filtering is NOT a goal any
 * more — it is the crisp/balanced/smooth variant chosen by the A/B flight test
 * (see shared/src/tuning/variants.ts).
 */
export type TuneGoal = "precision" | "freestyle" | "racing" | "cinematic";

export const TUNE_GOALS: readonly TuneGoal[] = ["precision", "freestyle", "racing", "cinematic"];

export const TUNE_GOAL_LABELS: Record<TuneGoal, string> = {
  precision: "Indoor precision",
  freestyle: "Freestyle",
  racing: "Racing",
  cinematic: "Cinematic",
};

export const TUNE_GOAL_DESCRIPTIONS: Record<TuneGoal, string> = {
  precision: "Tight indoor lines, gaps and powerloops: no feedforward, late TPA, D-min for a quiet hover.",
  freestyle: "Outdoor flips, rolls and dives: moderate feedforward, default filtering, higher rates.",
  racing: "Gates and fast lines: more P/D and feedforward, early TPA, lower max rates for precision.",
  cinematic: "Smooth footage: softer gains, no feedforward, low rates.",
};

/** Legacy goal names that older profiles may still carry. */
export const LEGACY_TUNE_GOALS: Record<string, TuneGoal> = {
  efficiency: "cinematic",
  low_noise: "freestyle",
  low_latency: "racing",
};

export const SIZE_CLASSES = ["65mm", "75mm", "85mm", "2in", "2.5in", "3in", "3.5in", "4in", "5in"] as const;

/** Video system of a build. HD payload (O3/O4/Walksnail/HDZero) adds mass and changes the tune. */
export const VIDEO_SYSTEMS = ["analog", "hd"] as const;
export type VideoSystem = (typeof VIDEO_SYSTEMS)[number];
export const VIDEO_SYSTEM_LABELS: Record<VideoSystem, string> = { analog: "Analog", hd: "HD (digital)" };

export interface Profile {
  id: number;
  droneId: number | null;
  name: string;
  goal: string;
  sizeClass: string | null;
  /** null = fits any video system */
  videoSystem: string | null;
  /** Plain-language rationale for the numbers (templates cite their sources here). */
  notes: string | null;
  settings: ProfileSettings;
  source: ProfileSource;
  createdAt: number;
}

export interface FcSnapshot {
  id: number;
  droneId: number;
  dump: FcDump;
  takenAt: number;
  reason: string | null;
}

export interface ChatMessageRecord {
  id: number;
  droneId: number | null;
  role: "user" | "assistant";
  content: string;
  toolCalls: unknown | null;
  createdAt: number;
}

// ---------- API DTOs ----------

export interface DroneSummary extends Drone {
  primaryPhotoPath: string | null;
  lastFlightDate: number | null;
  componentCount: number;
  activeProfileName: string | null;
}

export interface DroneComponentWithDetails extends DroneComponentLink {
  component: Component;
}

export interface DroneDetail extends Drone {
  components: DroneComponentWithDetails[];
  photos: DronePhoto[];
  profiles: Profile[];
  flights: Flight[];
  logs: FlightLog[];
}

export interface BatteryStat {
  componentId: number;
  name: string;
  flightCount: number;
  totalDurationS: number;
  lastFlown: number | null;
}

// ---------- Vendor presets & auto-detect ----------

export type VendorPresetSource = "upload" | "url" | "manual" | "seed";

/** "factory" = a vendor/BNF CLI dump; "preset" = a Betaflight community preset (firmware-presets repo). */
export type VendorPresetKind = "factory" | "preset";

/**
 * A vendor/BNF stock Betaflight config (parsed from a CLI dump). Can be
 * tied to a component library entry (hybrid builds pull one preset per
 * component) and/or a board target + drone model for loose matching.
 */
export interface VendorPreset {
  id: number;
  name: string;
  source: VendorPresetSource;
  /** FC build target this dump came from (e.g. "BETAFPVF405"), if known. */
  boardTarget: string | null;
  /** Component library entry this preset belongs to, if assigned. */
  componentId: number | null;
  /** BNF model name (e.g. "Meteor65", "Mobula6") for fuzzy matching. */
  droneModel: string | null;
  settings: ProfileSettings;
  /** Raw CLI dump text, kept for reference/re-parse. */
  cliDump: string | null;
  sourceUrl: string | null;
  createdAt: number;
  vendor: string | null;
  /** size class the config targets ("65mm", "2in", … or "any") */
  sizeClass: string | null;
  /** "analog" | "hd" | "any" */
  videoSystem: string | null;
  cells: string | null;
  bfVersion: string | null;
  kind: VendorPresetKind;
  variant: string | null;
  notes: string | null;
}

export interface DetectMatch {
  droneId: number;
  droneName: string;
  score: number;
  /** identity fields that matched, e.g. ["uid", "craftName"] */
  matchedOn: string[];
}

export interface DetectResponse {
  matches: DetectMatch[];
}

/** One BOM component and the vendor preset matched to it (if any). */
export interface BaselineComponent {
  slot: string;
  componentId: number;
  componentName: string;
  category: ComponentCategory;
  preset: VendorPreset | null;
}

/**
 * Per-component vendor baselines merged into a single settings object.
 * `sources` maps each merged dotted path (e.g. "pids.roll.p") to the
 * preset name that contributed it.
 */
export interface DroneBaseline {
  components: BaselineComponent[];
  merged: ProfileSettings;
  sources: Record<string, string>;
}

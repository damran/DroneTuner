import type { ConfigSection, FcConfig, FcDumpSection, PidTerms, ProfileSettings } from "@dronetuner/shared";
import {
  MSP_FILTER_CONFIG,
  MSP_PID,
  MSP_PID_ADVANCED,
  MSP_RC_TUNING,
  MSP_SET_FILTER_CONFIG,
  MSP_SET_PID,
  MSP_SET_PID_ADVANCED,
  MSP_SET_RC_TUNING,
} from "./commands";
import { fromHex } from "./codec";

export interface FieldDef {
  offset: number;
  size: 1 | 2;
}

/**
 * Byte offsets within each message for Betaflight 4.4/4.5 (MSP API 1.45/1.46),
 * derived from betaflight-configurator MSPHelper.js. Writes are gated to these
 * API versions; other versions are read-only.
 */
export const FILTER_FIELDS: Record<string, FieldDef> = {
  dtermLowpassHz: { offset: 1, size: 2 },
  yawLowpassHz: { offset: 3, size: 2 },
  dtermLowpassType: { offset: 17, size: 1 },
  gyroLowpassHz: { offset: 20, size: 2 },
  gyroLowpass2Hz: { offset: 22, size: 2 },
  gyroLowpassType: { offset: 24, size: 1 },
  gyroLowpass2Type: { offset: 25, size: 1 },
  dtermLowpass2Hz: { offset: 26, size: 2 },
  dtermLowpass2Type: { offset: 28, size: 1 },
  gyroLowpassDynMinHz: { offset: 29, size: 2 },
  gyroLowpassDynMaxHz: { offset: 31, size: 2 },
  dtermLowpassDynMinHz: { offset: 33, size: 2 },
  dtermLowpassDynMaxHz: { offset: 35, size: 2 },
  dynNotchQ: { offset: 39, size: 2 },
  dynNotchMinHz: { offset: 41, size: 2 },
  rpmFilterHarmonics: { offset: 43, size: 1 },
  rpmFilterMinHz: { offset: 44, size: 1 },
  dynNotchMaxHz: { offset: 45, size: 2 },
  dynLpfCurveExpo: { offset: 47, size: 1 },
  dynNotchCount: { offset: 48, size: 1 },
  // rpm_filter fade/Q/weights exist on the wire only from API 1.48 — on
  // 4.4/4.5 (writes are gated to 1.45/1.46) they are CLI-snippet-only.
};

export const RATE_FIELDS: Record<string, FieldDef> = {
  rcRate: { offset: 0, size: 1 },
  rcExpo: { offset: 1, size: 1 },
  rollRate: { offset: 2, size: 1 },
  pitchRate: { offset: 3, size: 1 },
  yawRate: { offset: 4, size: 1 },
  thrMid: { offset: 6, size: 1 },
  thrExpo: { offset: 7, size: 1 },
  rcExpoYaw: { offset: 10, size: 1 },
  rcRateYaw: { offset: 11, size: 1 },
  rcRatePitch: { offset: 12, size: 1 },
  rcExpoPitch: { offset: 13, size: 1 },
  // offsets 14/15: throttle limit type/percent; 16–21: per-axis rate_limit
  // u16 (unmanaged, preserved by patchPayload). rates_type follows at 22
  // (verified against BF 4.5 msp.c; MSP_SET_RC_TUNING reads it when the
  // payload is ≥23 bytes, which the 1.45/1.46 read always is).
  ratesType: { offset: 22, size: 1 },
};

export const ADVANCED_FIELDS: Record<string, FieldDef> = {
  feedforwardTransition: { offset: 8, size: 1 },
  antiGravityGain: { offset: 21, size: 2 },
  itermRelax: { offset: 27, size: 1 },
  feedforwardRoll: { offset: 32, size: 2 },
  feedforwardPitch: { offset: 34, size: 2 },
  feedforwardYaw: { offset: 36, size: 2 },
  dMinRoll: { offset: 39, size: 1 },
  dMinPitch: { offset: 40, size: 1 },
  dMaxGain: { offset: 42, size: 1 },
  dMaxAdvance: { offset: 43, size: 1 },
  itermRelaxCutoff: { offset: 46, size: 1 },
  idleMinRpm: { offset: 49, size: 1 },
  feedforwardAveraging: { offset: 50, size: 1 },
  feedforwardSmoothFactor: { offset: 51, size: 1 },
  feedforwardBoost: { offset: 52, size: 1 },
  feedforwardMaxRateLimit: { offset: 53, size: 1 },
  feedforwardJitterFactor: { offset: 54, size: 1 },
  vbatSagCompensation: { offset: 55, size: 1 },
  thrustLinear: { offset: 56, size: 1 },
  tpaMode: { offset: 57, size: 1 },
  tpaRate: { offset: 58, size: 1 },
  tpaBreakpoint: { offset: 59, size: 2 },
};

export const READ_COMMANDS: Record<ConfigSection, number> = {
  filters: MSP_FILTER_CONFIG,
  pids: MSP_PID,
  rates: MSP_RC_TUNING,
  advanced: MSP_PID_ADVANCED,
};

export const SET_COMMANDS: Record<ConfigSection, number> = {
  filters: MSP_SET_FILTER_CONFIG,
  pids: MSP_SET_PID,
  rates: MSP_SET_RC_TUNING,
  advanced: MSP_SET_PID_ADVANCED,
};

export function decodeApiVersion(payload: Uint8Array): { protocol: number; apiVersion: string } {
  const protocol = payload[0] ?? 0;
  const major = payload[1] ?? 0;
  const minor = payload[2] ?? 0;
  const patch = payload[3] ?? 0;
  return { protocol, apiVersion: `${major}.${minor}.${patch}` };
}

export function decodeFcVariant(payload: Uint8Array): string {
  let s = "";
  for (let i = 0; i < 4 && i < payload.length; i++) s += String.fromCharCode(payload[i]!);
  return s;
}

export function decodeFcVersion(payload: Uint8Array): string {
  const major = payload[0] ?? 0;
  if (major < 10) return `${major}.${payload[1] ?? 0}.${payload[2] ?? 0}`;
  let s = "";
  for (let i = 3; i < payload.length; i++) s += String.fromCharCode(payload[i]!);
  return s;
}

function readAscii(payload: Uint8Array, start: number, length: number): string {
  let s = "";
  for (let i = start; i < start + length && i < payload.length; i++) {
    const c = payload[i]!;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** Read a length-prefixed ASCII string; returns the string and next offset. */
function readLengthPrefixed(payload: Uint8Array, offset: number): [string, number] {
  if (offset >= payload.length) return ["", offset];
  const len = payload[offset]!;
  return [readAscii(payload, offset + 1, len), offset + 1 + len];
}

export interface BoardInfo {
  /** 4-char board identifier (e.g. "S405"). */
  boardId: string;
  targetName: string | null;
  boardName: string | null;
  manufacturerId: string | null;
}

/**
 * MSP_BOARD_INFO (API >= 1.37 layout, Betaflight 4.x). Extended fields
 * (target name, board name, manufacturer id) are length-prefixed and only
 * present on newer firmware — parse defensively and stop at buffer end.
 */
export function decodeBoardInfo(payload: Uint8Array): BoardInfo {
  const boardId = readAscii(payload, 0, 4);
  let offset = 7; // skip hw revision (u16) + fc type (u8)
  if (payload.length <= offset) return { boardId, targetName: null, boardName: null, manufacturerId: null };

  offset += 1; // comm capabilities (API >= 1.37)
  const [targetName, afterTarget] = readLengthPrefixed(payload, offset);
  offset = afterTarget;

  let boardName: string | null = null;
  let manufacturerId: string | null = null;
  if (offset < payload.length) {
    const [bn, afterBoard] = readLengthPrefixed(payload, offset);
    boardName = bn || null;
    offset = afterBoard;
    if (offset < payload.length) {
      const [mfg] = readLengthPrefixed(payload, offset);
      manufacturerId = mfg || null;
    }
  }
  return { boardId, targetName: targetName || null, boardName, manufacturerId };
}

/** MSP_NAME: pilot-set craft name as ASCII. */
export function decodeCraftName(payload: Uint8Array): string {
  return readAscii(payload, 0, payload.length).trim();
}

/** MSP_UID: 96-bit unique chip ID (3× u32 LE) rendered as hex. */
export function decodeUid(payload: Uint8Array): string {
  return Array.from(payload.slice(0, 12))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function decodePid(payload: Uint8Array): {
  roll: PidTerms;
  pitch: PidTerms;
  yaw: PidTerms;
  rows: number[][];
} {
  const rows: number[][] = [];
  for (let i = 0; i * 3 + 2 < payload.length; i++) {
    rows.push([payload[i * 3] ?? 0, payload[i * 3 + 1] ?? 0, payload[i * 3 + 2] ?? 0]);
  }
  const g = (i: number): PidTerms => ({ p: rows[i]?.[0] ?? 0, i: rows[i]?.[1] ?? 0, d: rows[i]?.[2] ?? 0 });
  return { roll: g(0), pitch: g(1), yaw: g(2), rows };
}

export function encodePid(rows: number[][]): Uint8Array {
  const out = new Uint8Array(rows.length * 3);
  rows.forEach((r, i) => {
    out[i * 3] = r[0] ?? 0;
    out[i * 3 + 1] = r[1] ?? 0;
    out[i * 3 + 2] = r[2] ?? 0;
  });
  return out;
}

export function decodeSection(payload: Uint8Array, fields: Record<string, FieldDef>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, f] of Object.entries(fields)) {
    if (f.offset + f.size > payload.length) continue;
    out[key] = f.size === 1 ? payload[f.offset]! : payload[f.offset]! | (payload[f.offset + 1]! << 8);
  }
  return out;
}

/** Patch a raw payload at known field offsets, preserving all other bytes. */
export function patchPayload(
  payload: Uint8Array,
  fields: Record<string, FieldDef>,
  values: Record<string, number>,
): Uint8Array {
  const out = new Uint8Array(payload);
  for (const [key, v] of Object.entries(values)) {
    const f = fields[key];
    if (!f || f.offset + f.size > out.length) continue;
    // Clamp to the field width — never let an out-of-range value wrap around.
    const max = f.size === 1 ? 0xff : 0xffff;
    const clamped = Math.max(0, Math.min(max, Math.round(v)));
    if (f.size === 1) {
      out[f.offset] = clamped;
    } else {
      out[f.offset] = clamped & 0xff;
      out[f.offset + 1] = (clamped >> 8) & 0xff;
    }
  }
  return out;
}

export function readU32(payload: Uint8Array): number {
  return (payload[0] ?? 0) | ((payload[1] ?? 0) << 8) | ((payload[2] ?? 0) << 16) | ((payload[3] ?? 0) << 24);
}

/** Writes are only allowed on Betaflight 4.4/4.5 (MSP API 1.45/1.46). */
export function isWritableApi(apiVersion: string): boolean {
  const [major, minor] = apiVersion.split(".").map((n) => Number.parseInt(n, 10));
  return major === 1 && (minor === 45 || minor === 46);
}

/** The only MSP commands a stored snapshot may replay (the four tuning writes). */
export const RESTORABLE_COMMANDS: ReadonlySet<number> = new Set(Object.values(SET_COMMANDS));

/**
 * Decode a snapshot's raw section payloads into profile settings. The restore
 * confirm diff is built from THIS — the actual bytes that will be replayed —
 * never from the snapshot's free-form `decoded` field, so what the user
 * confirms is exactly what gets written. Returns null when a section uses an
 * unknown command (nothing honest to diff).
 */
export function decodeDumpSections(sections: FcDumpSection[]): ProfileSettings | null {
  const settings: ProfileSettings = {};
  for (const section of sections) {
    if (!RESTORABLE_COMMANDS.has(section.command)) return null;
    if (!section.payloadHex) continue;
    const payload = fromHex(section.payloadHex);
    switch (section.command) {
      case MSP_SET_PID: {
        const pid = decodePid(payload);
        settings.pids = { roll: pid.roll, pitch: pid.pitch, yaw: pid.yaw };
        break;
      }
      case MSP_SET_FILTER_CONFIG:
        settings.filters = decodeSection(payload, FILTER_FIELDS);
        break;
      case MSP_SET_RC_TUNING:
        settings.rates = decodeSection(payload, RATE_FIELDS);
        break;
      case MSP_SET_PID_ADVANCED:
        settings.advanced = decodeSection(payload, ADVANCED_FIELDS);
        break;
    }
  }
  return settings;
}

/** Merge target profile settings into the current config for one section. */
export function mergeSection(
  current: FcConfig,
  target: ProfileSettings,
  section: ConfigSection,
): Record<string, number> | { roll: PidTerms; pitch: PidTerms; yaw: PidTerms } {
  switch (section) {
    case "pids":
      return {
        roll: { ...current.pids.roll, ...target.pids?.roll },
        pitch: { ...current.pids.pitch, ...target.pids?.pitch },
        yaw: { ...current.pids.yaw, ...target.pids?.yaw },
      };
    case "filters":
      return { ...current.filters, ...target.filters };
    case "rates":
      return { ...current.rates, ...target.rates };
    case "advanced":
      return { ...current.advanced, ...target.advanced };
  }
}

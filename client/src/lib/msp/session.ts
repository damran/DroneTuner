import { create } from "zustand";
import type {
  ConfigSection,
  FcConfig,
  FcDump,
  FcDumpSection,
  FcIdentity,
  PidTerms,
  ProfileSettings,
} from "@dronetuner/shared";
import { CONFIG_SECTION_ORDER } from "@dronetuner/shared";
import { MspSerial } from "./serial";
import { fromHex, toHex } from "./codec";
import {
  ADVANCED_FIELDS,
  FILTER_FIELDS,
  RATE_FIELDS,
  READ_COMMANDS,
  SET_COMMANDS,
  decodeApiVersion,
  decodeBoardInfo,
  decodeCraftName,
  decodeFcVariant,
  decodeFcVersion,
  decodePid,
  decodeSection,
  decodeUid,
  encodePid,
  isWritableApi,
  mergeSection,
  patchPayload,
  readU32,
} from "./config";
import {
  MSP_API_VERSION,
  MSP_BOARD_INFO,
  MSP_EEPROM_WRITE,
  MSP_FC_VARIANT,
  MSP_FC_VERSION,
  MSP_FEATURE_CONFIG,
  MSP_NAME,
  MSP_UID,
} from "./commands";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "readonly" | "error";

interface MspStore {
  state: ConnectionState;
  error: string | null;
  info: { apiVersion: string; fcVariant: string; fcVersion: string } | null;
  identity: FcIdentity | null;
  config: FcConfig | null;
  writable: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
  takeSnapshot: () => FcDump | null;
  applySections: (sections: ConfigSection[], target: ProfileSettings) => Promise<void>;
  saveEeprom: () => Promise<void>;
  restore: (dump: FcDump) => Promise<void>;
}

const serial = new MspSerial();
let rawPayloads = new Map<number, Uint8Array>();

export const useMspStore = create<MspStore>((set, get) => ({
  state: "disconnected",
  error: null,
  info: null,
  identity: null,
  config: null,
  writable: false,

  connect: async () => {
    set({ state: "connecting", error: null });
    try {
      await serial.connect();
      await get().refresh();
    } catch (err) {
      set({ state: "error", error: String(err) });
      await serial.disconnect();
    }
  },

  disconnect: async () => {
    await serial.disconnect();
    set({ state: "disconnected", info: null, identity: null, config: null, writable: false, error: null });
  },

  refresh: async () => {
    const api = await serial.query(MSP_API_VERSION);
    const { apiVersion } = decodeApiVersion(api);
    const variant = decodeFcVariant(await serial.query(MSP_FC_VARIANT));
    const version = decodeFcVersion(await serial.query(MSP_FC_VERSION));

    // Identity commands are best-effort: older firmware / non-BF variants
    // may not answer them, and detection should degrade gracefully.
    const identity: FcIdentity = {
      apiVersion,
      fcVariant: variant,
      fcVersion: version,
      boardId: null,
      targetName: null,
      boardName: null,
      manufacturerId: null,
      craftName: null,
      uid: null,
    };
    try {
      const board = decodeBoardInfo(await serial.query(MSP_BOARD_INFO));
      identity.boardId = board.boardId || null;
      identity.targetName = board.targetName;
      identity.boardName = board.boardName;
      identity.manufacturerId = board.manufacturerId;
    } catch {
      /* unsupported */
    }
    try {
      identity.craftName = decodeCraftName(await serial.query(MSP_NAME)) || null;
    } catch {
      /* unsupported */
    }
    try {
      identity.uid = decodeUid(await serial.query(MSP_UID)) || null;
    } catch {
      /* unsupported */
    }

    const pidPayload = await serial.query(READ_COMMANDS.pids);
    const advancedPayload = await serial.query(READ_COMMANDS.advanced);
    const filterPayload = await serial.query(READ_COMMANDS.filters);
    const ratesPayload = await serial.query(READ_COMMANDS.rates);
    const featurePayload = await serial.query(MSP_FEATURE_CONFIG);

    rawPayloads = new Map([
      [READ_COMMANDS.pids, pidPayload],
      [READ_COMMANDS.advanced, advancedPayload],
      [READ_COMMANDS.filters, filterPayload],
      [READ_COMMANDS.rates, ratesPayload],
    ]);

    const pid = decodePid(pidPayload);
    const writable = isWritableApi(apiVersion);
    const config: FcConfig = {
      apiVersion,
      fcVariant: variant,
      fcVersion: version,
      pids: { roll: pid.roll, pitch: pid.pitch, yaw: pid.yaw },
      filters: decodeSection(filterPayload, FILTER_FIELDS),
      rates: decodeSection(ratesPayload, RATE_FIELDS),
      advanced: decodeSection(advancedPayload, ADVANCED_FIELDS),
      featureMask: readU32(featurePayload),
    };

    set({
      state: writable ? "connected" : "readonly",
      info: { apiVersion, fcVariant: variant, fcVersion: version },
      identity,
      config,
      writable,
      error: null,
    });
  },

  takeSnapshot: (): FcDump | null => {
    const { config } = get();
    if (!config) return null;
    const sections: FcDumpSection[] = CONFIG_SECTION_ORDER.map((section) => {
      const payload = rawPayloads.get(READ_COMMANDS[section]);
      return { command: SET_COMMANDS[section], payloadHex: payload ? toHex(payload) : "" };
    });
    return {
      apiVersion: config.apiVersion,
      fcVariant: config.fcVariant,
      fcVersion: config.fcVersion,
      capturedAt: Date.now(),
      sections,
      decoded: config,
    };
  },

  applySections: async (sections: ConfigSection[], target: ProfileSettings) => {
    const { config, writable } = get();
    if (!config) throw new Error("Not connected to a flight controller");
    if (!writable) throw new Error("Writes are disabled for this firmware version (read-only mode)");

    for (const section of sections) {
      const merged = mergeSection(config, target, section);
      const raw = rawPayloads.get(READ_COMMANDS[section]);
      if (!raw) throw new Error(`Missing raw payload for section ${section}`);

      let payload: Uint8Array;
      if (section === "pids") {
        const v = merged as { roll: PidTerms; pitch: PidTerms; yaw: PidTerms };
        const rows = decodePid(raw).rows;
        rows[0] = [v.roll.p, v.roll.i, v.roll.d];
        rows[1] = [v.pitch.p, v.pitch.i, v.pitch.d];
        rows[2] = [v.yaw.p, v.yaw.i, v.yaw.d];
        payload = encodePid(rows);
      } else if (section === "filters") {
        payload = patchPayload(raw, FILTER_FIELDS, merged as Record<string, number>);
      } else if (section === "rates") {
        payload = patchPayload(raw, RATE_FIELDS, merged as Record<string, number>);
      } else {
        payload = patchPayload(raw, ADVANCED_FIELDS, merged as Record<string, number>);
      }

      await serial.query(SET_COMMANDS[section], payload);
    }

    // Re-read so config/rawPayloads match what's actually on the FC now —
    // subsequent snapshots and diff computations must not use stale data.
    await get().refresh();
  },

  saveEeprom: async () => {
    await serial.query(MSP_EEPROM_WRITE);
  },

  restore: async (dump: FcDump) => {
    const { writable } = get();
    if (!writable) throw new Error("Writes are disabled for this firmware version (read-only mode)");
    for (const section of dump.sections) {
      if (!section.payloadHex) continue;
      await serial.query(section.command, fromHex(section.payloadHex));
    }
    await get().saveEeprom();
    await get().refresh();
  },
}));

export function isSerialSupported(): boolean {
  return MspSerial.isSupported();
}

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
  RESTORABLE_COMMANDS,
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
  translateSettingsForApi,
} from "./config";
import {
  MSP_API_VERSION,
  MSP_BOARD_INFO,
  MSP_EEPROM_WRITE,
  MSP_FC_VARIANT,
  MSP_FC_VERSION,
  MSP_FEATURE_CONFIG,
  MSP_NAME,
  MSP_SELECT_SETTING,
  MSP_STATUS_EX,
  MSP_UID,
  RATEPROFILE_MASK,
} from "./commands";
import { decodeStatusEx, type FcStatus } from "./config";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "readonly" | "error";

interface MspStore {
  state: ConnectionState;
  error: string | null;
  info: { apiVersion: string; fcVariant: string; fcVersion: string } | null;
  identity: FcIdentity | null;
  config: FcConfig | null;
  /** Active profile / arming state from MSP_STATUS_EX (refreshed with the config). */
  status: FcStatus | null;
  writable: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
  takeSnapshot: () => FcDump | null;
  applySections: (sections: ConfigSection[], target: ProfileSettings) => Promise<void>;
  saveEeprom: () => Promise<void>;
  restore: (dump: FcDump) => Promise<void>;
  /**
   * Make PID profile `index` active (MSP_SELECT_SETTING) and re-read the
   * config. Refused while armed. The selection is stored by the next EEPROM
   * save, exactly like Configurator's profile dropdown.
   */
  selectPidProfile: (index: number) => Promise<void>;
  /**
   * Make rate profile `index` active (MSP_SELECT_SETTING with the
   * RATEPROFILE_MASK bit). Betaflight itself allows this while armed (that is
   * how an adjustment switch works); DroneTuner never sends it armed.
   */
  selectRateProfile: (index: number) => Promise<void>;
}

/** Betaflight 4.x CONTROL_RATE_PROFILE_COUNT (MSP_STATUS_EX does not report it). */
export const RATE_PROFILE_COUNT = 4;

const serial = new MspSerial();
let rawPayloads = new Map<number, Uint8Array>();

export const useMspStore = create<MspStore>((set, get) => {
  /**
   * Fresh arming check for every write path. The cached `status` can be
   * minutes old by the time the user clicks Confirm, so MSP_STATUS_EX is
   * re-read here; a failed read refuses too (fail closed) — an unknown
   * arming state is never treated as "disarmed".
   */
  const assertDisarmed = async (action: string): Promise<FcStatus> => {
    let status: FcStatus;
    try {
      status = decodeStatusEx(await serial.query(MSP_STATUS_EX));
    } catch (err) {
      throw new Error(`Could not read the arming state (MSP_STATUS_EX failed: ${String(err)}) — refusing to ${action}.`, {
        cause: err,
      });
    }
    set({ status });
    if (status.armed) {
      throw new Error(`The flight controller reports ARMED — refusing to ${action}. Disarm (and remove props) first.`);
    }
    return status;
  };

  return {
  state: "disconnected",
  error: null,
  info: null,
  identity: null,
  config: null,
  status: null,
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
    set({ state: "disconnected", info: null, identity: null, config: null, status: null, writable: false, error: null });
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

    let status: FcStatus | null = null;
    try {
      status = decodeStatusEx(await serial.query(MSP_STATUS_EX));
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
      status,
      writable,
      error: null,
    });
  },

  takeSnapshot: (): FcDump | null => {
    const { config, status } = get();
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
      pidProfile: status?.pidProfile,
      rateProfile: status?.rateProfile,
    };
  },

  applySections: async (sections: ConfigSection[], target: ProfileSettings) => {
    const { config, writable } = get();
    if (!config) throw new Error("Not connected to a flight controller");
    if (!writable) throw new Error("Writes are disabled for this firmware version (read-only mode)");
    await assertDisarmed("write");

    // 2025.12 (API 1.47) swaps the meaning of D / D-min on the wire.
    const effectiveTarget = translateSettingsForApi(target, config.apiVersion);
    for (const section of sections) {
      const merged = mergeSection(config, effectiveTarget, section);
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
    await assertDisarmed("save to EEPROM");
    await serial.query(MSP_EEPROM_WRITE);
  },

  selectPidProfile: async (index: number) => {
    const { config } = get();
    if (!config) throw new Error("Not connected to a flight controller");
    const status = await assertDisarmed("switch profiles");
    const count = status.pidProfileCount || 3;
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new Error(`PID profile ${index + 1} does not exist (this FC has ${count})`);
    }
    // Plain index = PID profile; index | RATEPROFILE_MASK would select a RATE profile.
    await serial.query(MSP_SELECT_SETTING, new Uint8Array([index & ~RATEPROFILE_MASK & 0xff]));
    await get().refresh();
    const after = get().status;
    if (after && after.pidProfile !== index) {
      throw new Error(`FC did not switch to PID profile ${index + 1} (still on ${after.pidProfile + 1})`);
    }
  },

  selectRateProfile: async (index: number) => {
    const { config } = get();
    if (!config) throw new Error("Not connected to a flight controller");
    await assertDisarmed("switch rate profiles");
    if (!Number.isInteger(index) || index < 0 || index >= RATE_PROFILE_COUNT) {
      throw new Error(`Rate profile ${index + 1} does not exist (Betaflight has ${RATE_PROFILE_COUNT})`);
    }
    await serial.query(MSP_SELECT_SETTING, new Uint8Array([(RATEPROFILE_MASK | index) & 0xff]));
    await get().refresh();
    const after = get().status;
    if (after && after.rateProfile !== index) {
      throw new Error(`FC did not switch to rate profile ${index + 1} (still on ${after.rateProfile + 1})`);
    }
  },

  restore: async (dump: FcDump) => {
    const { info, writable } = get();
    if (!writable) throw new Error("Writes are disabled for this firmware version (read-only mode)");
    // Unconditional: the profile-select and EEPROM steps below check too, but
    // the section replay itself must never reach an armed FC.
    await assertDisarmed("restore a snapshot");
    // Raw payload replay is only meaningful on the firmware the snapshot was
    // taken from — a variant/API mismatch would write bytes at wrong offsets.
    if (info && (dump.fcVariant !== info.fcVariant || dump.apiVersion !== info.apiVersion)) {
      throw new Error(
        `Snapshot is from ${dump.fcVariant} API ${dump.apiVersion}, but the connected FC is ` +
          `${info.fcVariant} API ${info.apiVersion}. Restoring across firmware versions is refused.`,
      );
    }
    // Profile-aware: the sections were read from a specific PID profile, so
    // make that profile active before replaying (selection is a separate,
    // non-replayed step; the allowlist below still governs the replay).
    const current = get().status?.pidProfile;
    if (dump.pidProfile !== undefined && current !== undefined && dump.pidProfile !== current) {
      await get().selectPidProfile(dump.pidProfile);
    }
    const currentRate = get().status?.rateProfile;
    if (dump.rateProfile !== undefined && currentRate !== undefined && dump.rateProfile !== currentRate) {
      await get().selectRateProfile(dump.rateProfile);
    }
    // Replay is limited to the four tuning SET commands, no matter where the
    // dump came from — a stored row must never become a way to send arming,
    // feature, or reboot commands to the FC.
    for (const section of dump.sections) {
      if (!RESTORABLE_COMMANDS.has(section.command)) {
        throw new Error(`Snapshot contains non-restorable MSP command ${section.command} — refusing to replay it.`);
      }
      if (!section.payloadHex) continue;
      await serial.query(section.command, fromHex(section.payloadHex));
    }
    await get().saveEeprom();
    await get().refresh();
  },
  };
});

export function isSerialSupported(): boolean {
  return MspSerial.isSupported();
}

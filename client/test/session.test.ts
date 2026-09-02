import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FcConfig, FcDump } from "@dronetuner/shared";

/**
 * Drives the MSP store against a fake serial link. What matters here is the
 * arming safety net: every write path must re-read MSP_STATUS_EX and refuse
 * when the FC is armed or the state cannot be read — regardless of what the
 * cached status says.
 */
const sent: { command: number; payload?: Uint8Array }[] = [];
const fake = {
  armed: false,
  pidProfile: 0,
  rateProfile: 0,
  statusFails: false,
};
const MSP_STATUS_EX_CMD = 150;
const MSP_SELECT_SETTING_CMD = 210;

vi.mock("../src/lib/msp/serial", () => {
  class MspSerial {
    static isSupported(): boolean {
      return false;
    }
    async connect(): Promise<void> {}
    async disconnect(): Promise<void> {}
    async query(command: number, payload?: Uint8Array): Promise<Uint8Array> {
      sent.push({ command, payload });
      if (command === MSP_STATUS_EX_CMD) {
        if (fake.statusFails) throw new Error("timeout");
        const p = new Uint8Array(22);
        p[6] = fake.armed ? 1 : 0; // flightModeFlags bit 0 = ARMED
        p[10] = fake.pidProfile;
        p[13] = 3; // PID profile count
        p[14] = fake.rateProfile;
        return p;
      }
      if (command === MSP_SELECT_SETTING_CMD) {
        const v = payload?.[0] ?? 0;
        if (v & 0x80) fake.rateProfile = v & 0x7f;
        else fake.pidProfile = v & 0x7f;
        return new Uint8Array(0);
      }
      return new Uint8Array(64);
    }
  }
  return { MspSerial };
});

import { useMspStore } from "../src/lib/msp/session";
import { MSP_EEPROM_WRITE, MSP_SET_FILTER_CONFIG, MSP_SET_PID } from "../src/lib/msp/commands";

const pid = { p: 40, i: 80, d: 30 };
const config: FcConfig = {
  apiVersion: "1.46",
  fcVariant: "BTFL",
  fcVersion: "4.5.1",
  pids: { roll: pid, pitch: pid, yaw: pid },
  filters: {},
  rates: {},
  advanced: {},
  featureMask: 0,
};
const dump = (pidProfile: number | undefined): FcDump => ({
  apiVersion: "1.46",
  fcVariant: "BTFL",
  fcVersion: "4.5.1",
  capturedAt: 0,
  sections: [{ command: MSP_SET_FILTER_CONFIG, payloadHex: "0102" }],
  decoded: config,
  pidProfile,
});
const commandsSent = () => sent.map((s) => s.command);

beforeEach(() => {
  sent.length = 0;
  fake.armed = false;
  fake.pidProfile = 0;
  fake.rateProfile = 0;
  fake.statusFails = false;
  useMspStore.setState({
    config,
    writable: true,
    info: { apiVersion: "1.46", fcVariant: "BTFL", fcVersion: "4.5.1" },
    // Cached status says disarmed — the FC may have been armed since.
    status: { armed: false, pidProfile: 0, pidProfileCount: 3, rateProfile: 0, cpuLoadPercent: 0 },
  });
});

describe("msp session arming guard", () => {
  it("saveEeprom re-reads the arming state and refuses when armed", async () => {
    fake.armed = true;
    await expect(useMspStore.getState().saveEeprom()).rejects.toThrow(/ARMED/);
    expect(commandsSent()).toEqual([MSP_STATUS_EX_CMD]);
    expect(commandsSent()).not.toContain(MSP_EEPROM_WRITE);
  });

  it("selectPidProfile refuses when armed and sends no MSP_SELECT_SETTING", async () => {
    fake.armed = true;
    await expect(useMspStore.getState().selectPidProfile(1)).rejects.toThrow(/ARMED/);
    expect(commandsSent()).not.toContain(MSP_SELECT_SETTING_CMD);
  });

  it("applySections refuses when armed before touching any SET command", async () => {
    fake.armed = true;
    await expect(useMspStore.getState().applySections(["pids"], { pids: { roll: pid, pitch: pid, yaw: pid } })).rejects.toThrow(
      /ARMED/,
    );
    expect(commandsSent()).not.toContain(MSP_SET_PID);
  });

  it("restore refuses when armed even if the dump is for the current profile", async () => {
    // The profile-select step is skipped when the profile already matches —
    // the replay itself must still be guarded.
    fake.armed = true;
    await expect(useMspStore.getState().restore(dump(0))).rejects.toThrow(/ARMED/);
    expect(commandsSent()).toEqual([MSP_STATUS_EX_CMD]);
  });

  it("fails closed when MSP_STATUS_EX cannot be read", async () => {
    fake.statusFails = true;
    await expect(useMspStore.getState().restore(dump(undefined))).rejects.toThrow(/arming state/);
    await expect(useMspStore.getState().saveEeprom()).rejects.toThrow(/arming state/);
    expect(commandsSent().filter((c) => c !== MSP_STATUS_EX_CMD)).toEqual([]);
  });

  it("selectRateProfile sets the rate-profile bit and refuses when armed", async () => {
    await useMspStore.getState().selectRateProfile(1);
    const select = sent.find((s) => s.command === MSP_SELECT_SETTING_CMD);
    expect(select?.payload?.[0]).toBe(0x80 | 1);
    expect(fake.rateProfile).toBe(1);
    sent.length = 0;
    fake.armed = true;
    await expect(useMspStore.getState().selectRateProfile(2)).rejects.toThrow(/ARMED/);
    expect(commandsSent()).not.toContain(MSP_SELECT_SETTING_CMD);
  });

  it("restore selects the dump's rate profile before replaying the rates section", async () => {
    const d = { ...dump(undefined), rateProfile: 2 };
    await useMspStore.getState().restore(d);
    const select = sent.find((s) => s.command === MSP_SELECT_SETTING_CMD);
    expect(select?.payload?.[0]).toBe(0x80 | 2);
    expect(commandsSent().indexOf(MSP_SET_FILTER_CONFIG)).toBeGreaterThan(commandsSent().indexOf(MSP_SELECT_SETTING_CMD));
  });

  it("restore selects the dump's profile before replaying, then saves", async () => {
    await useMspStore.getState().restore(dump(1));
    const cmds = commandsSent();
    const select = cmds.indexOf(MSP_SELECT_SETTING_CMD);
    const replay = cmds.indexOf(MSP_SET_FILTER_CONFIG);
    const save = cmds.indexOf(MSP_EEPROM_WRITE);
    expect(select).toBeGreaterThanOrEqual(0);
    expect(replay).toBeGreaterThan(select);
    expect(save).toBeGreaterThan(replay);
    expect(sent[select]!.payload?.[0]).toBe(1);
    expect(fake.pidProfile).toBe(1);
  });
});

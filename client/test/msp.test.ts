import { describe, expect, it } from "vitest";
import { buildMspV2Request, crc8DvbS2, ResponseParser } from "../src/lib/msp/codec";
import {
  FILTER_FIELDS,
  RESTORABLE_COMMANDS,
  decodeDumpSections,
  decodePid,
  decodeStatusEx,
  translateSettingsForApi,
  encodePid,
  isWritableApi,
  patchPayload,
} from "../src/lib/msp/config";
import { MSP_SET_PID, MSP_SET_RC_TUNING, MSP_SET_FILTER_CONFIG, MSP_SET_PID_ADVANCED } from "../src/lib/msp/commands";
import { toHex } from "../src/lib/msp/codec";

describe("msp codec", () => {
  it("crc8 is a byte", () => {
    const crc = crc8DvbS2(new Uint8Array([1, 2, 3, 4, 5]));
    expect(crc).toBeGreaterThanOrEqual(0);
    expect(crc).toBeLessThan(256);
  });

  it("parses a complete response frame", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const resp = new Uint8Array(9 + payload.length);
    resp[0] = 0x24;
    resp[1] = 0x58;
    resp[2] = 0x3e; // '>'
    resp[3] = 0;
    resp[4] = 112;
    resp[5] = 0;
    resp[6] = payload.length;
    resp[7] = 0;
    resp.set(payload, 8);
    resp[8 + payload.length] = crc8DvbS2(resp, 3, 5 + payload.length);

    const parser = new ResponseParser();
    parser.push(resp);
    const parsed = parser.tryParse();
    expect(parsed).not.toBeNull();
    expect(parsed!.command).toBe(112);
    expect([...parsed!.payload]).toEqual([1, 2, 3]);
  });

  it("builds a valid request frame", () => {
    const req = buildMspV2Request(112, new Uint8Array([9, 8]));
    expect(req[0]).toBe(0x24);
    expect(req[1]).toBe(0x58);
    expect(req[2]).toBe(0x3c);
    expect(req[4]).toBe(112);
    expect(req[6]).toBe(2);
    expect(req[8]).toBe(9);
    expect(req[9]).toBe(8);
    expect(req[10]).toBe(crc8DvbS2(req, 3, 7));
  });

  it("pid encode/decode round-trip", () => {
    const rows = [
      [46, 90, 40],
      [48, 90, 40],
      [80, 100, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const encoded = encodePid(rows);
    const decoded = decodePid(encoded);
    expect(decoded.roll).toEqual({ p: 46, i: 90, d: 40 });
    expect(decoded.yaw).toEqual({ p: 80, i: 100, d: 0 });
    expect(decoded.rows.length).toBe(10);
  });

  it("patchPayload preserves untouched bytes", () => {
    const payload = new Uint8Array(49).fill(0xaa);
    const patched = patchPayload(payload, FILTER_FIELDS, { dtermLowpassHz: 100 });
    expect(patched[1]).toBe(100);
    expect(patched[2]).toBe(0);
    expect(patched[0]).toBe(0xaa);
    expect(patched[48]).toBe(0xaa);
  });

  it("version gate", () => {
    expect(isWritableApi("1.45.0")).toBe(true);
    expect(isWritableApi("1.46.0")).toBe(true);
    expect(isWritableApi("1.44.0")).toBe(false);
    expect(isWritableApi("1.47.0")).toBe(true);
    expect(isWritableApi("2.0.0")).toBe(false);
  });

  it("restorable commands are exactly the four tuning SET commands", () => {
    expect([...RESTORABLE_COMMANDS].sort((a, b) => a - b)).toEqual([
      MSP_SET_FILTER_CONFIG,
      MSP_SET_PID_ADVANCED,
      MSP_SET_PID,
      MSP_SET_RC_TUNING,
    ]);
  });

  it("decodeDumpSections decodes the actual payloads to be replayed", () => {
    const pidPayload = encodePid([
      [46, 90, 40],
      [48, 90, 40],
      [80, 100, 0],
    ]);
    const ratesPayload = new Uint8Array(23);
    ratesPayload[0] = 100; // rcRate
    ratesPayload[22] = 3; // ratesType = ACTUAL
    const settings = decodeDumpSections([
      { command: MSP_SET_PID, payloadHex: toHex(pidPayload) },
      { command: MSP_SET_RC_TUNING, payloadHex: toHex(ratesPayload) },
    ]);
    expect(settings?.pids?.roll).toEqual({ p: 46, i: 90, d: 40 });
    expect(settings?.rates?.rcRate).toBe(100);
    expect(settings?.rates?.ratesType).toBe(3);
  });

  it("decodeDumpSections refuses unknown commands", () => {
    expect(decodeDumpSections([{ command: 68, payloadHex: "00" }])).toBeNull(); // MSP_REBOOT
    expect(decodeDumpSections([{ command: 250, payloadHex: "" }])).toBeNull(); // MSP_EEPROM_WRITE
  });

  it("decodes MSP_STATUS_EX profile and arming fields", () => {
    // cycleTime 250, i2c 0, sensors 0x23, flightModeFlags 0x00000001 (ARM),
    // pidProfile 1, cpuload 12, profileCount 4, rateProfile 2
    const p = new Uint8Array([250, 0, 0, 0, 0x23, 0, 1, 0, 0, 0, 1, 12, 0, 4, 2, 0, 0, 0, 0, 0]);
    const st = decodeStatusEx(p);
    expect(st.pidProfile).toBe(1);
    expect(st.pidProfileCount).toBe(4);
    expect(st.rateProfile).toBe(2);
    expect(st.cpuLoadPercent).toBe(12);
    expect(st.armed).toBe(true);
    p[6] = 0;
    expect(decodeStatusEx(p).armed).toBe(false);
  });

  it("allows writes on API 1.45–1.47 and swaps D/D-min for 2025.12", () => {
    expect(isWritableApi("1.46.0")).toBe(true);
    expect(isWritableApi("1.47.0")).toBe(true);
    expect(isWritableApi("1.48.0")).toBe(false);
    const t = { pids: { roll: { p: 61, i: 110, d: 41 }, pitch: { d: 51 } }, advanced: { dMinRoll: 24, dMinPitch: 30, tpaRate: 40 } };
    expect(translateSettingsForApi(t, "1.46.0")).toBe(t);
    const x = translateSettingsForApi(t, "1.47.0");
    expect(x.pids?.roll?.d).toBe(24);
    expect(x.pids?.pitch?.d).toBe(30);
    expect(x.advanced?.dMinRoll).toBe(41);
    expect(x.advanced?.dMinPitch).toBe(51);
    expect(x.advanced?.tpaRate).toBe(40);
    expect(x.pids?.roll?.p).toBe(61);
  });
});

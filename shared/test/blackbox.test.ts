import { describe, expect, it } from "vitest";
import { parseBlackboxLog } from "../src/blackbox/parser";

// ---- Minimal blackbox encoder (mirrors the Betaflight firmware) ----

function writeUnsignedVB(out: number[], value: number): void {
  while (value > 127) {
    out.push((value & 0x7f) | 0x80);
    value >>= 7;
  }
  out.push(value);
}

function writeSignedVB(out: number[], value: number): void {
  writeUnsignedVB(out, ((value << 1) ^ (value >> 31)) >>> 0);
}

function writeTag2_3S32(out: number[], values: number[]): void {
  const max = Math.max(...values.map((v) => Math.abs(v)));
  if (max < 2) {
    out.push(((values[0]! & 3) << 4) | ((values[1]! & 3) << 2) | (values[2]! & 3));
  } else if (max < 8) {
    out.push((1 << 6) | (values[0]! & 0x0f));
    out.push(((values[1]! & 0x0f) << 4) | (values[2]! & 0x0f));
  } else if (max < 32) {
    out.push((2 << 6) | (values[0]! & 0x3f));
    out.push(values[1]! & 0xff);
    out.push(values[2]! & 0xff);
  } else {
    throw new Error("test value too large for tag2_3s32");
  }
}

function writeTag8_4S16(out: number[], values: number[]): void {
  let selector = 0;
  for (let x = 3; x >= 0; x--) {
    selector <<= 2;
    const v = values[x]!;
    if (v === 0) selector |= 0;
    else if (v >= -8 && v < 8) selector |= 1;
    else if (v >= -128 && v < 128) selector |= 2;
    else selector |= 3;
  }
  out.push(selector);
  let nibbleIndex = 0;
  let buffer = 0;
  for (let x = 0; x < 4; x++) {
    const v = values[x]!;
    switch ((selector >> (2 * x)) & 3) {
      case 0:
        break;
      case 1:
        if (nibbleIndex === 0) {
          buffer = (v & 0x0f) << 4;
          nibbleIndex = 1;
        } else {
          out.push(buffer | (v & 0x0f));
          nibbleIndex = 0;
        }
        break;
      case 2:
        if (nibbleIndex === 0) out.push(v & 0xff);
        else {
          out.push(buffer | ((v >> 4) & 0x0f));
          buffer = (v & 0x0f) << 4;
        }
        break;
      case 3:
        if (nibbleIndex === 0) {
          out.push((v >> 8) & 0xff);
          out.push(v & 0xff);
        } else {
          out.push(buffer | ((v >> 12) & 0x0f));
          out.push((v >> 4) & 0xff);
          buffer = (v & 0x0f) << 4;
        }
        break;
    }
  }
  if (nibbleIndex === 1) out.push(buffer);
}

function writeTag8_8SVB(out: number[], values: number[]): void {
  let header = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    header <<= 1;
    if (values[i] !== 0) header |= 1;
  }
  out.push(header);
  for (const v of values) if (v !== 0) writeSignedVB(out, v);
}

interface MainFrame {
  loopIteration: number;
  time: number;
  axisP: [number, number, number];
  axisI: [number, number, number];
  axisD: [number, number, number];
  axisF: [number, number, number];
  rcCommand: [number, number, number, number];
  setpoint: [number, number, number, number];
  vbatLatest: number;
  amperageLatest: number;
  rssi: number;
  gyroADC: [number, number, number];
  motor: [number, number, number, number];
}

const VBATREF = 4095;
const MOTOR_MIN = 48;

function encodeIFrame(out: number[], f: MainFrame): void {
  out.push(0x49); // 'I'
  writeUnsignedVB(out, f.loopIteration);
  writeUnsignedVB(out, f.time);
  for (const v of f.axisP) writeSignedVB(out, v);
  for (const v of f.axisI) writeSignedVB(out, v);
  for (const v of f.axisD) writeSignedVB(out, v);
  for (const v of f.axisF) writeSignedVB(out, v);
  for (let i = 0; i < 3; i++) writeSignedVB(out, f.rcCommand[i]!);
  writeUnsignedVB(out, f.rcCommand[3]!);
  for (const v of f.setpoint) writeSignedVB(out, v);
  writeUnsignedVB(out, (VBATREF - f.vbatLatest) & 0x3fff);
  writeSignedVB(out, f.amperageLatest);
  writeUnsignedVB(out, f.rssi);
  for (const v of f.gyroADC) writeSignedVB(out, v);
  writeUnsignedVB(out, f.motor[0]! - MOTOR_MIN);
  for (let i = 1; i < 4; i++) writeSignedVB(out, f.motor[i]! - f.motor[0]!);
}

function encodePFrame(out: number[], f: MainFrame, prev: MainFrame, prev2: MainFrame): void {
  out.push(0x50); // 'P'
  writeSignedVB(out, f.time - 2 * prev.time + prev2.time);
  for (let i = 0; i < 3; i++) writeSignedVB(out, f.axisP[i]! - prev.axisP[i]!);
  writeTag2_3S32(out, [
    f.axisI[0]! - prev.axisI[0]!,
    f.axisI[1]! - prev.axisI[1]!,
    f.axisI[2]! - prev.axisI[2]!,
  ]);
  for (let i = 0; i < 3; i++) writeSignedVB(out, f.axisD[i]! - prev.axisD[i]!);
  for (let i = 0; i < 3; i++) writeSignedVB(out, f.axisF[i]! - prev.axisF[i]!);
  writeTag8_4S16(out, [
    f.rcCommand[0]! - prev.rcCommand[0]!,
    f.rcCommand[1]! - prev.rcCommand[1]!,
    f.rcCommand[2]! - prev.rcCommand[2]!,
    f.rcCommand[3]! - prev.rcCommand[3]!,
  ]);
  writeTag8_4S16(out, [
    f.setpoint[0]! - prev.setpoint[0]!,
    f.setpoint[1]! - prev.setpoint[1]!,
    f.setpoint[2]! - prev.setpoint[2]!,
    f.setpoint[3]! - prev.setpoint[3]!,
  ]);
  writeTag8_8SVB(out, [
    f.vbatLatest - prev.vbatLatest,
    f.amperageLatest - prev.amperageLatest,
    f.rssi - prev.rssi,
  ]);
  for (let i = 0; i < 3; i++) {
    const pred = Math.trunc((prev.gyroADC[i]! + prev2.gyroADC[i]!) / 2);
    writeSignedVB(out, f.gyroADC[i]! - pred);
  }
  for (let i = 0; i < 4; i++) {
    const pred = Math.trunc((prev.motor[i]! + prev2.motor[i]!) / 2);
    writeSignedVB(out, f.motor[i]! - pred);
  }
}

const FIELD_NAMES = [
  "loopIteration", "time",
  "axisP[0]", "axisP[1]", "axisP[2]",
  "axisI[0]", "axisI[1]", "axisI[2]",
  "axisD[0]", "axisD[1]", "axisD[2]",
  "axisF[0]", "axisF[1]", "axisF[2]",
  "rcCommand[0]", "rcCommand[1]", "rcCommand[2]", "rcCommand[3]",
  "setpoint[0]", "setpoint[1]", "setpoint[2]", "setpoint[3]",
  "vbatLatest", "amperageLatest", "rssi",
  "gyroADC[0]", "gyroADC[1]", "gyroADC[2]",
  "motor[0]", "motor[1]", "motor[2]", "motor[3]",
];

const I_PREDICTOR = "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,9,0,0,0,0,0,11,5,5,5";
const I_ENCODING = "1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,3,0,1,0,0,0,1,0,0,0";
const P_PREDICTOR = "6,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,3,3,3,3,3,3,3";
const P_ENCODING = "9,0,0,0,0,7,7,7,0,0,0,0,0,0,8,8,8,8,8,8,8,8,6,6,6,0,0,0,0,0,0,0";
const SIGNED = "0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,1,1,1,1,0,1,0,1,1,1,0,0,0,0";

function header(): string {
  return [
    "H Product:Blackbox flight data recorder by Nicholas Sherlock",
    "H Data version:2",
    "H Firmware revision:Betaflight 4.5.1 (test)",
    "H Firmware type:Betaflight",
    "H I interval:32",
    "H P interval:1/1",
    "H minthrottle:1070",
    "H maxthrottle:2000",
    "H motorOutput:48,2047",
    "H vbatref:4095",
    "H gyro.scale:0x1.000000p-14",
    "H looptime:500",
    `H Field I name:${FIELD_NAMES.join(",")}`,
    `H Field I predictor:${I_PREDICTOR}`,
    `H Field I encoding:${I_ENCODING}`,
    `H Field I signed:${SIGNED}`,
    `H Field P name:${FIELD_NAMES.join(",")}`,
    `H Field P predictor:${P_PREDICTOR}`,
    `H Field P encoding:${P_ENCODING}`,
    `H Field P signed:${SIGNED}`,
    "",
  ].join("\n");
}

function buildLog(): Uint8Array {
  const out: number[] = [];
  for (const ch of header()) out.push(ch.charCodeAt(0));

  const f0: MainFrame = {
    loopIteration: 0, time: 0,
    axisP: [45, 47, 80], axisI: [90, 90, 100], axisD: [40, 40, 0], axisF: [120, 120, 120],
    rcCommand: [1500, 1500, 1500, 1000], setpoint: [0, 0, 0, 0],
    vbatLatest: 1250, amperageLatest: 100, rssi: 50,
    gyroADC: [100, -50, 20], motor: [1100, 1100, 1100, 1100],
  };
  const f1: MainFrame = {
    loopIteration: 1, time: 500,
    axisP: [45, 47, 80], axisI: [91, 91, 100], axisD: [41, 40, 0], axisF: [120, 120, 120],
    rcCommand: [1600, 1500, 1500, 1100], setpoint: [300, 0, 0, 0],
    vbatLatest: 1248, amperageLatest: 150, rssi: 50,
    gyroADC: [150, -40, 25], motor: [1200, 1200, 1200, 1200],
  };
  const f2: MainFrame = {
    loopIteration: 2, time: 1000,
    axisP: [45, 47, 80], axisI: [92, 92, 100], axisD: [42, 40, 0], axisF: [120, 120, 120],
    rcCommand: [1700, 1500, 1500, 1200], setpoint: [500, 0, 0, 0],
    vbatLatest: 1246, amperageLatest: 200, rssi: 49,
    gyroADC: [180, -30, 30], motor: [1300, 1300, 1300, 1300],
  };

  encodeIFrame(out, f0);
  encodePFrame(out, f1, f0, f0);
  encodePFrame(out, f2, f1, f0);

  return new Uint8Array(out);
}

describe("blackbox parser", () => {
  it("parses a synthetic log end-to-end", () => {
    const parsed = parseBlackboxLog(buildLog());

    expect(parsed.headers["Firmware revision"]).toBe("Betaflight 4.5.1 (test)");
    expect(parsed.frameCount).toBe(3);
    expect(parsed.gyroScale).toBeCloseTo(1 / 16384, 10);

    const gyro0 = parsed.channels["gyroADC[0]"]!;
    expect([...gyro0]).toEqual([100, 150, 180]);

    const motor0 = parsed.channels["motor[0]"]!;
    expect([...motor0]).toEqual([1100, 1200, 1300]);

    const vbat = parsed.channels["vbatLatest"]!;
    expect([...vbat]).toEqual([1250, 1248, 1246]);

    const time = parsed.timeUs;
    expect([...time]).toEqual([0, 500, 1000]);

    const rc3 = parsed.channels["rcCommand[3]"]!;
    expect([...rc3]).toEqual([1000, 1100, 1200]);

    const setpoint0 = parsed.channels["setpoint[0]"]!;
    expect([...setpoint0]).toEqual([0, 300, 500]);
  });

  it("rejects non-blackbox data", () => {
    expect(() => parseBlackboxLog(new Uint8Array([1, 2, 3, 4, 5]))).toThrow();
  });

  it("records truncation at the maxFrames cap", () => {
    const parsed = parseBlackboxLog(buildLog(), { maxFrames: 2 });
    expect(parsed.frameCount).toBe(2);
    expect(parsed.truncated).toBe(true);
    expect(parsed.warnings.some((w) => w.includes("truncated"))).toBe(true);
  });

  it("is not truncated when the log fits under the cap", () => {
    const parsed = parseBlackboxLog(buildLog());
    expect(parsed.truncated).toBe(false);
  });

  it("surfaces unsupported encodings as warnings instead of swallowing them", () => {
    // Corrupt the P-frame encoding table: field 1 (time, predictor
    // STRAIGHT_LINE) gets encoding 99. Field 0 would not exercise it — its
    // P_INC predictor never consults the encoding table.
    const parts = P_ENCODING.split(",");
    parts[1] = "99";
    const bad = header().replace(`H Field P encoding:${P_ENCODING}`, `H Field P encoding:${parts.join(",")}`);
    const out: number[] = [];
    for (const ch of bad) out.push(ch.charCodeAt(0));
    const f0: MainFrame = {
      loopIteration: 0, time: 0,
      axisP: [45, 47, 80], axisI: [90, 90, 100], axisD: [40, 40, 0], axisF: [120, 120, 120],
      rcCommand: [1500, 1500, 1500, 1000], setpoint: [0, 0, 0, 0],
      vbatLatest: 1250, amperageLatest: 100, rssi: 50,
      gyroADC: [100, -50, 20], motor: [1100, 1100, 1100, 1100],
    };
    encodeIFrame(out, f0);
    encodePFrame(out, f0, f0, f0); // triggers the corrupted P encoding
    const parsed = parseBlackboxLog(new Uint8Array(out));
    expect(parsed.warnings.some((w) => w.includes("Unsupported field encoding 99"))).toBe(true);
  });
});

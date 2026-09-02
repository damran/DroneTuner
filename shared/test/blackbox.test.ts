import { describe, expect, it } from "vitest";
import { listBlackboxSessions, parseBlackboxLog } from "../src/blackbox/parser";
import { buildLog, encodeIFrame, encodePFrame, header, P_ENCODING, type MainFrame } from "./helpers/synthetic-log";

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

describe("multi-session files", () => {
  function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  it("lists every session with its byte range", () => {
    const one = buildLog();
    const two = buildLog({ firmware: "Betaflight 4.5.1 (second)" });
    const data = concat(one, two);
    expect(listBlackboxSessions(data).map((s) => [s.index, s.start, s.end])).toEqual([
      [0, 0, one.length],
      [1, one.length, data.length],
    ]);
    expect(listBlackboxSessions(new Uint8Array([1, 2, 3]))).toEqual([]);
  });

  it("parses the requested session only and reports the count", () => {
    const data = concat(buildLog(), buildLog({ firmware: "Betaflight 4.5.1 (second)" }));

    const first = parseBlackboxLog(data);
    expect(first.sessionIndex).toBe(0);
    expect(first.sessionCount).toBe(2);
    expect(first.frameCount).toBe(3);
    expect(first.headers["Firmware revision"]).toBe("Betaflight 4.5.1 (test)");
    expect(first.warnings.some((w) => w.includes("2 flight sessions"))).toBe(true);

    const second = parseBlackboxLog(data, { sessionIndex: 1 });
    expect(second.sessionIndex).toBe(1);
    expect(second.frameCount).toBe(3);
    expect(second.headers["Firmware revision"]).toBe("Betaflight 4.5.1 (second)");
    expect(second.warnings.some((w) => w.includes("only the first"))).toBe(false);

    expect(() => parseBlackboxLog(data, { sessionIndex: 2 })).toThrow(/only holds 2/);
  });

  it("a single-session file parses without the multi-session warning", () => {
    const parsed = parseBlackboxLog(buildLog());
    expect(parsed.sessionCount).toBe(1);
    expect(parsed.warnings.some((w) => w.includes("sessions"))).toBe(false);
  });
});

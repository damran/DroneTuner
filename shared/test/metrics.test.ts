import { describe, expect, it } from "vitest";
import { computeMetrics } from "../src/analysis/metrics";
import type { ParsedLog } from "../src/blackbox/types";

/**
 * Minimal parsed-log fabrication. Channels are constant-valued unless
 * overridden; the airborne mask needs throttle above idle, so rcCommand[3]
 * defaults to 1500.
 */
function makeLog(overrides: { headers?: Record<string, string>; channels?: Record<string, Float32Array> } = {}): ParsedLog {
  const n = 4000;
  const channels: Record<string, Float32Array> = {
    "rcCommand[3]": new Float32Array(n).fill(1500),
    ...overrides.channels,
  };
  return {
    headers: overrides.headers ?? {},
    sessionIndex: 0,
    sessionCount: 1,
    frameCount: n,
    timeUs: Float32Array.from({ length: n }, (_, i) => i * 500),
    channels,
    looptimeUs: 500,
    gyroScale: null,
    firmware: null,
    truncated: false,
    warnings: [],
  };
}

describe("computeMetrics battery", () => {
  it("converts vbatLatest from centivolts to volts", () => {
    // Blackbox logs vbatLatest in 0.01 V units (same scale as the
    // vbatref/vbatcellvoltage headers): 429 raw == 4.29 V on a 1S whoop.
    const log = makeLog({ channels: { vbatLatest: new Float32Array(4000).fill(429) } });
    const m = computeMetrics(log);
    expect(m.vbatMinV).toBeCloseTo(4.29, 2);
    expect(m.vbatAvgV).toBeCloseTo(4.29, 2);
  });

  it("computes sag from the airborne throttle quartiles (scale-independent)", () => {
    const n = 4000;
    // Bottom quartile at 1000 (rest), top at 2000 (loaded) — works whether
    // the channel is rcCommand-scaled or setpoint-scaled.
    const throttle = new Float32Array(n);
    const vbat = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const q = i % 4;
      throttle[i] = q === 0 ? 1000 : q === 3 ? 2000 : 1500;
      vbat[i] = (q === 3 ? 320 : 420) as number; // 4.20 V rest, 3.20 V loaded
    }
    const log = makeLog({ channels: { "rcCommand[3]": throttle, vbatLatest: vbat } });
    const m = computeMetrics(log);
    expect(m.vbatSagV).toBeCloseTo(1.0, 1);
  });
});

describe("computeMetrics rpm filter detection", () => {
  it("reads dshot_bidir/debug_mode as the integers blackbox logs", () => {
    expect(computeMetrics(makeLog({ headers: { dshot_bidir: "1" } })).rpmFilterActive).toBe(true);
    // DEBUG_RPM_FILTER is enum value 6 in BF's build/debug.h
    expect(computeMetrics(makeLog({ headers: { debug_mode: "6" } })).rpmFilterActive).toBe(true);
    expect(computeMetrics(makeLog({ headers: { dshot_bidir: "0", debug_mode: "0" } })).rpmFilterActive).toBe(false);
  });
});

describe("computeMetrics step response", () => {
  it("falls back to deconvolution on a smooth flight without stick plateaus", () => {
    // 60 s at 1 kHz: a low-passed random stick trace through a 2nd-order
    // loop — no plateau is ever held, so the edge detector finds (almost)
    // nothing, yet the deconvolution estimate is available.
    const sr = 1000;
    const n = sr * 60;
    const setpoint = new Float32Array(n);
    const gyro = new Float32Array(n);
    let seed = 99;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5;
    let walk = 0;
    let lp = 0;
    const a = Math.exp((-2 * Math.PI * 3) / sr);
    for (let i = 0; i < n; i++) {
      walk += rnd() * 40;
      walk *= 0.995;
      if (i % 1700 === 0) walk += rnd() * 600;
      lp = a * lp + (1 - a) * walk;
      setpoint[i] = lp;
    }
    const wn = 2 * Math.PI * 8;
    let y = 0;
    let v = 0;
    for (let i = 0; i < n; i++) {
      const u = i >= 8 ? setpoint[i - 8]! : 0;
      v += (wn * wn * (u - y) - 2 * 0.6 * wn * v) / sr;
      y += v / sr;
      gyro[i] = y + rnd() * 20;
    }
    const log = makeLog({ channels: { "rcCommand[3]": new Float32Array(n).fill(1500), "setpoint[0]": setpoint, "gyroADC[0]": gyro } });
    log.timeUs = Float32Array.from({ length: n }, (_, i) => i * 1000);
    log.frameCount = n;
    const m = computeMetrics(log);
    const roll = m.stepResponse.find((s) => s.axis === "roll");
    expect(roll).toBeDefined();
    expect(roll!.method).toBe("deconvolution");
    expect(roll!.windowCount).toBeGreaterThan(10);
    expect(roll!.overshootPercent).toBeGreaterThan(3);
    expect(roll!.overshootPercent).toBeLessThan(20);
    expect(roll!.riseTimeMs).toBeGreaterThan(25);
    expect(roll!.riseTimeMs).toBeLessThan(50);
  });
});

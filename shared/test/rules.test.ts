import { describe, expect, it } from "vitest";
import { applyChanges, runRules } from "../src/tuning/rules";
import type { LogMetrics } from "../src/analysis/types";

const baseMetrics: LogMetrics = {
  durationS: 60,
  sampleRateHz: 1000,
  frameCount: 60000,
  noisePeaks: [],
  noiseFloor: { roll: 1, pitch: 1, yaw: 1 },
  stepResponse: [],
  dtermRms: { roll: 1, pitch: 1, yaw: 1 },
  motorSaturationPercent: 0,
  throttleAvg: 1500,
  vbatMinV: 11,
  vbatAvgV: 12,
  vbatSagV: 0.5,
  filterLatencyMs: 15,
  rpmFilterActive: false,
  warnings: [],
};

describe("runRules", () => {
  it("detects a resonance peak and widens the notch range to cover it", () => {
    const metrics: LogMetrics = {
      ...baseMetrics,
      // 80 Hz is below the default dyn-notch range (150-600 Hz)
      noisePeaks: [{ axis: "roll", freqHz: 80, magnitude: 50 }],
    };
    const { findings, recommendations } = runRules(metrics, "racing");
    expect(findings.some((f) => f.title.includes("80"))).toBe(true);
    const rec = recommendations.find((r) => r.changes.filters?.dynNotchMinHz !== undefined);
    expect(rec).toBeDefined();
    // default min 150 -> target 60 (0.7 * 80, floored at 60) => delta -90
    expect(rec!.changes.filters!.dynNotchMinHz).toBe(60 - 150);
  });

  it("does not recommend notch changes when defaults already cover the peak", () => {
    const metrics: LogMetrics = {
      ...baseMetrics,
      noisePeaks: [{ axis: "roll", freqHz: 220, magnitude: 50 }],
    };
    const { findings, recommendations } = runRules(metrics, "racing");
    expect(findings.some((f) => f.title.includes("220"))).toBe(true);
    expect(recommendations.some((r) => r.changes.filters?.dynNotchMinHz !== undefined)).toBe(false);
  });

  it("computes notch deltas relative to the base profile", () => {
    const metrics: LogMetrics = {
      ...baseMetrics,
      noisePeaks: [{ axis: "pitch", freqHz: 80, magnitude: 50 }],
    };
    const base = { filters: { dynNotchMinHz: 100, dynNotchMaxHz: 350, dynNotchCount: 3 } };
    const { recommendations } = runRules(metrics, "freestyle", base);
    const rec = recommendations.find((r) => r.changes.filters?.dynNotchMinHz !== undefined);
    expect(rec).toBeDefined();
    // base min 100 -> target 60 => delta -40
    expect(rec!.changes.filters!.dynNotchMinHz).toBe(60 - 100);
  });

  it("flags noisy D-term (raw PID-sum units)", () => {
    const metrics: LogMetrics = {
      ...baseMetrics,
      dtermRms: { roll: 300, pitch: 50, yaw: 10 },
    };
    const { findings, recommendations } = runRules(metrics, "freestyle");
    expect(findings.some((f) => f.title.includes("Roll D-term"))).toBe(true);
    const rec = recommendations.find((r) => r.changes.filters?.dtermLowpassDynMaxHz !== undefined);
    expect(rec).toBeDefined();
    expect(rec!.changes.filters!.dtermLowpassDynMaxHz).toBeLessThan(0);
  });

  it("flags under-damped step response", () => {
    const metrics: LogMetrics = {
      ...baseMetrics,
      stepResponse: [{ axis: "roll", overshootPercent: 40, riseTimeMs: 20, settlingTimeMs: 80, stepCount: 5 }],
    };
    const { findings } = runRules(metrics, "freestyle");
    expect(findings.some((f) => f.title.includes("under-damped"))).toBe(true);
  });

  it("flags slow step response (realistic rise-time scale)", () => {
    const metrics: LogMetrics = {
      ...baseMetrics,
      stepResponse: [{ axis: "pitch", overshootPercent: 5, riseTimeMs: 80, settlingTimeMs: 200, stepCount: 5 }],
    };
    const { findings, recommendations } = runRules(metrics, "racing");
    expect(findings.some((f) => f.title.includes("slow"))).toBe(true);
    const rec = recommendations.find((r) => r.changes.pids?.pitch?.p !== undefined);
    expect(rec).toBeDefined();
    expect(rec!.changes.pids!.pitch!.p).toBeGreaterThan(0);
  });

  it("flags motor saturation", () => {
    const metrics: LogMetrics = { ...baseMetrics, motorSaturationPercent: 12 };
    const { findings } = runRules(metrics, "racing");
    expect(findings.some((f) => f.title.includes("saturating"))).toBe(true);
  });
});

describe("applyChanges", () => {
  it("adds deltas to a base profile", () => {
    const base = { pids: { roll: { p: 46, i: 90, d: 40 } }, filters: { dtermLowpassHz: 100 } };
    const changes = { pids: { roll: { p: -3 } }, filters: { dtermLowpassHz: -20 } };
    const out = applyChanges(base, changes);
    expect(out.pids?.roll?.p).toBe(43);
    expect(out.filters?.dtermLowpassHz).toBe(80);
  });

  it("clamps to zero", () => {
    const out = applyChanges({ filters: { dtermLowpassHz: 10 } }, { filters: { dtermLowpassHz: -50 } });
    expect(out.filters?.dtermLowpassHz).toBe(0);
  });

  it("clamps PIDs to the MSP u8 range", () => {
    const out = applyChanges({ pids: { roll: { p: 250 } } }, { pids: { roll: { p: 20 } } });
    expect(out.pids?.roll?.p).toBe(255);
  });

  it("skips negative deltas when the base has no value to lower", () => {
    const out = applyChanges({}, { filters: { dtermLowpassDynMaxHz: -30 } });
    expect(out.filters?.dtermLowpassDynMaxHz).toBeUndefined();
  });
});

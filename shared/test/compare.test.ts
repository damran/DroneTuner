import { describe, expect, it } from "vitest";
import { compareAnalyses, type CompareInput } from "../src/analysis/compare";
import type { LogMetrics } from "../src/analysis/types";

function metrics(overrides: Partial<LogMetrics> = {}): LogMetrics {
  return {
    durationS: 60,
    sampleRateHz: 2000,
    frameCount: 120000,
    noisePeaks: [],
    noiseFloor: { roll: 2, pitch: 2, yaw: 2 },
    stepResponse: [],
    dtermRms: { roll: 100, pitch: 100, yaw: 50 },
    dtermRmsLowThrottle: { roll: 60, pitch: 60, yaw: 40 },
    dtermRmsHighThrottle: { roll: 140, pitch: 140, yaw: 60 },
    motorSaturationPercent: 2,
    throttleAvg: 1300,
    vbatMinV: 15,
    vbatAvgV: 15.8,
    vbatSagV: 0.5,
    filterLatencyMs: null,
    rpmFilterActive: true,
    warnings: [],
    ...overrides,
  };
}

function input(m: LogMetrics, headers: Record<string, string>): CompareInput {
  return { metrics: m, headers };
}

describe("compareAnalyses", () => {
  it("diffs tuning-relevant headers and collapses the rest", () => {
    const prev = input(metrics(), {
      dyn_notch_q: "300",
      rpm_filter_min_hz: "100",
      blackbox_sample_rate: "1/1",
      craft_name: "whoop",
    });
    const cur = input(metrics(), {
      dyn_notch_q: "500",
      rpm_filter_min_hz: "100",
      blackbox_sample_rate: "1/2",
      craft_name: "whoop",
    });
    const cmp = compareAnalyses(cur, prev);
    expect(cmp.settingChanges).toEqual([{ key: "dyn_notch_q", from: "300", to: "500" }]);
    expect(cmp.otherChangesCount).toBe(1); // blackbox_sample_rate
  });

  it("marks reduced noise floor and D-term RMS as better", () => {
    const prev = input(metrics(), {});
    const cur = input(
      metrics({
        noiseFloor: { roll: 1, pitch: 1, yaw: 1 },
        dtermRms: { roll: 50, pitch: 50, yaw: 25 },
      }),
      {},
    );
    const cmp = compareAnalyses(cur, prev);
    const floor = cmp.metricDeltas.find((d) => d.label === "roll noise floor");
    expect(floor!.verdict).toBe("better");
    const dterm = cmp.metricDeltas.find((d) => d.label === "roll D-term RMS");
    expect(dterm!.verdict).toBe("better");
  });

  it("marks increased noise as worse", () => {
    const prev = input(metrics(), {});
    const cur = input(metrics({ noiseFloor: { roll: 4, pitch: 2, yaw: 2 } }), {});
    const cmp = compareAnalyses(cur, prev);
    expect(cmp.metricDeltas.find((d) => d.label === "roll noise floor")!.verdict).toBe("worse");
    expect(cmp.metricDeltas.find((d) => d.label === "pitch noise floor")!.verdict).toBe("neutral");
  });

  it("compares filter delay when both sides have it", () => {
    const delay = (dtermMs: number) => ({
      referenceFreqHz: 50,
      gyroMs: 2,
      dtermMs,
      yawMs: 2,
      gyroMsMax: 1,
      dtermMsMax: dtermMs / 2,
      yawMsMax: 1,
      stages: [],
      warnings: [],
    });
    const prev = input(metrics({ filterDelay: delay(10) }), {});
    const cur = input(metrics({ filterDelay: delay(6) }), {});
    const cmp = compareAnalyses(cur, prev);
    const row = cmp.metricDeltas.find((d) => d.label === "Filter delay (D path)");
    expect(row!.verdict).toBe("better");
    expect(row!.delta).toBeCloseTo(-4);
  });

  it("warns when one side predates the delay estimator", () => {
    const prev = input(metrics(), {});
    const cur = input(metrics(), {});
    const cmp = compareAnalyses(cur, prev);
    expect(cmp.warnings.some((w) => w.includes("spectral") || w.includes("delay"))).toBe(true);
  });
});

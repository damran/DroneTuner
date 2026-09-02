import { describe, expect, it } from "vitest";
import { applyChanges, runRules } from "../src/tuning/rules";
import type { AxisStepMetrics, LogMetrics } from "../src/analysis/types";
import type { AxisSpectral, ClassifiedPeak } from "../src/analysis/spectrogram";
import type { Axis, ProfileSettings } from "../src/types/fc";

function baseMetrics(overrides: Partial<LogMetrics> = {}): LogMetrics {
  return {
    durationS: 60,
    sampleRateHz: 2000,
    frameCount: 120000,
    noisePeaks: [],
    noiseFloor: { roll: 1, pitch: 1, yaw: 1 },
    stepResponse: [],
    dtermRms: { roll: 50, pitch: 50, yaw: 50 },
    dtermRmsLowThrottle: { roll: 50, pitch: 50, yaw: 50 },
    dtermRmsHighThrottle: { roll: 50, pitch: 50, yaw: 50 },
    motorSaturationPercent: 0,
    throttleAvg: 1200,
    vbatMinV: 15.2,
    vbatAvgV: 15.8,
    vbatSagV: 0.3,
    filterLatencyMs: null,
    rpmFilterActive: true,
    warnings: [],
    ...overrides,
  };
}

function step(axis: Axis, overrides: Partial<AxisStepMetrics> = {}): AxisStepMetrics {
  return {
    axis,
    overshootPercent: 5,
    riseTimeMs: 30,
    settlingTimeMs: 80,
    latencyMs: 8,
    ringingCycles: 0,
    steadyStateErrorPercent: 2,
    ffStartLagMs: 5,
    ffEndOvershootPercent: 8,
    stepCount: 10,
    ...overrides,
  };
}

function peak(overrides: Partial<ClassifiedPeak> = {}): ClassifiedPeak {
  return {
    kind: "frameResonance",
    freqHz: 230,
    magnitude: 10,
    ratioToFloor: 10,
    freqSpreadHz: 3,
    throttleCorr: 0.1,
    ...overrides,
  };
}

function spectral(axis: Axis, peaks: ClassifiedPeak[], extras: Partial<AxisSpectral> = {}): AxisSpectral {
  return { axis, floor: 1, peaks, motorNoiseOnsetHz: null, motorNoiseStrongHz: null, ...extras };
}

describe("runRules", () => {
  it("targets the dynamic notch at frame resonances only, floored at 100 Hz", () => {
    const m = baseMetrics({
      spectral: [spectral("roll", [peak({ freqHz: 230 })])],
      noisePeaks: [{ axis: "roll", freqHz: 230, magnitude: 10 }],
    });
    const out = runRules(m, "freestyle");
    const rec = out.recommendations.find((r) => r.findingId === "resonance-notch");
    expect(rec).toBeDefined();
    // resonance at 230 → target min = 230-25 = 205, default min is 100 → no change needed
    // count 3 → 1 resonance → recommend count 1 (delta -2)
    expect(rec!.changes.filters?.dynNotchCount).toBe(-2);
    // narrow resonance (spread 3 Hz) → Q raised from default 300
    expect(rec!.changes.filters?.dynNotchQ).toBe(100);
    // never lets the notch hunt below 100 Hz
    const low = runRules(
      baseMetrics({ spectral: [spectral("roll", [peak({ freqHz: 120 })])] }),
      "freestyle",
    ).recommendations.find((r) => r.findingId === "resonance-notch");
    if (low?.changes.filters?.dynNotchMinHz !== undefined) {
      const abs = 100 + low.changes.filters.dynNotchMinHz;
      expect(abs).toBeGreaterThanOrEqual(100);
    }
  });

  it("never widens the dynamic notch onto motor harmonics", () => {
    const m = baseMetrics({
      spectral: [
        spectral("roll", [peak({ kind: "motorHarmonic", freqHz: 300, throttleCorr: 0.95, freqSpreadHz: 60 })], {
          motorNoiseOnsetHz: 140,
          motorNoiseStrongHz: 200,
        }),
      ],
    });
    const out = runRules(m, "freestyle");
    expect(out.recommendations.find((r) => r.findingId === "resonance-notch")).toBeUndefined();
    // but the RPM filter crossfade should be tuned to the onset
    const rpm = out.recommendations.find((r) => r.findingId === "rpm-crossfade");
    expect(rpm).toBeDefined();
    // onset 140 → target min = round(126/5)*5 = 125; default 100 → delta +25
    expect(rpm!.changes.filters?.rpmFilterMinHz).toBe(25);
  });

  it("keeps a single dynamic notch on quiet frames with RPM filtering", () => {
    const out = runRules(baseMetrics(), "freestyle");
    const rec = out.recommendations.find((r) => r.findingId === "quiet-frame");
    expect(rec).toBeDefined();
    expect(rec!.changes.filters?.dynNotchCount).toBe(-2); // BF default 3 → 1
    expect(rec!.cliLines?.join("\n")).toContain("set dyn_notch_count = 1");
    // already at one notch → nothing to trim
    const one = runRules(baseMetrics(), "freestyle", { filters: { dynNotchCount: 1 } });
    expect(one.recommendations.find((r) => r.findingId === "quiet-frame")).toBeUndefined();
  });

  it("gives no recommendations for a log that is too short or has no gyro data", () => {
    const short = runRules(baseMetrics({ durationS: 1.8 }), "freestyle");
    expect(short.recommendations).toEqual([]);
    expect(short.findings.map((f) => f.id)).toEqual(["short-log"]);
    const empty = runRules(baseMetrics({ noiseFloor: { roll: 0, pitch: 0, yaw: 0 }, dtermRms: { roll: 0, pitch: 0, yaw: 0 } }), "freestyle");
    expect(empty.recommendations).toEqual([]);
    expect(empty.findings[0]?.id).toBe("short-log");
  });

  it("does not push gyro LPF2 to 1000 Hz on a 2 kHz PID loop and flags the loop rate", () => {
    const out = runRules(baseMetrics({ gyroRateHz: 8000, pidLoopRateHz: 2000 }), "freestyle");
    expect(out.recommendations.find((r) => r.findingId === "gyro-lpf2")).toBeUndefined();
    expect(out.findings.find((f) => f.id === "pid-loop-rate")).toBeDefined();
    const fast = runRules(baseMetrics({ gyroRateHz: 8000, pidLoopRateHz: 4000 }), "freestyle");
    expect(fast.findings.find((f) => f.id === "pid-loop-rate")).toBeUndefined();
  });

  it("warns when the flown dynamic notch floor is below 100 Hz and raises it", () => {
    const flown = {
      filters: { ...runRules(baseMetrics(), "freestyle") && {} } as never,
    };
    void flown;
    const m = baseMetrics({
      flownConfig: {
        filters: { dynNotchMinHz: 80, dynNotchCount: 2 } as never,
        pids: null,
        advanced: null,
      },
    });
    const out = runRules(m, "precision");
    const f = out.findings.find((x) => x.id === "notch-floor");
    expect(f?.severity).toBe("warning");
    const rec = out.recommendations.find((r) => r.findingId === "notch-floor");
    expect(rec?.changes.filters?.dynNotchMinHz).toBe(20); // 80 → 100
    expect(rec?.cliLines?.join("\n")).toContain("set dyn_notch_min_hz = 100");
  });

  it("widens the RPM notches when motor harmonics leak into the filtered gyro", () => {
    const m = baseMetrics({
      spectral: [spectral("roll", [peak({ kind: "motorHarmonic", freqHz: 320, ratioToFloor: 9, onsetHz: 140, strongHz: 200 })], { motorNoiseOnsetHz: 140, motorNoiseStrongHz: 200 })],
    });
    const out = runRules(m, "freestyle");
    const q = out.recommendations.find((r) => r.findingId === "rpm-q");
    expect(q).toBeDefined();
    expect(q!.changes.filters?.rpmFilterQ).toBe(-100); // 500 → 400
    expect(out.recommendations.find((r) => r.findingId === "rpm-q-tighten")).toBeUndefined();
    // and the optional tightening only appears on a clean spectrum
    const clean = runRules(baseMetrics({ spectral: [spectral("roll", [])] }), "freestyle");
    expect(clean.recommendations.find((r) => r.findingId === "rpm-q-tighten")?.changes.filters?.rpmFilterQ).toBe(250);
  });

  it("treats idle-speed motor peaks as motor noise, never as a notch target", () => {
    const m = baseMetrics({
      spectral: [spectral("roll", [peak({ kind: "motorIdle", freqHz: 44, ratioToFloor: 12 })])],
    });
    const out = runRules(m, "freestyle");
    expect(out.recommendations.find((r) => r.findingId === "resonance-notch")).toBeUndefined();
    const f = out.findings.find((x) => x.id === "motor-idle");
    expect(f).toBeDefined();
    expect(f!.detail).toContain("rpm_filter_min_hz");
  });

  it("does NOT recommend disabling the notch without RPM filtering", () => {
    const out = runRules(baseMetrics({ rpmFilterActive: false }), "freestyle");
    expect(out.recommendations.find((r) => r.findingId === "quiet-frame")).toBeUndefined();
    expect(out.findings.find((f) => f.id === "rpm-inactive")).toBeDefined();
  });

  it("raises gyro LPF2 to 1000 Hz when gyro rate exceeds PID rate", () => {
    const out = runRules(baseMetrics({ gyroRateHz: 8000, pidLoopRateHz: 4000 }), "freestyle");
    const rec = out.recommendations.find((r) => r.findingId === "gyro-lpf2");
    expect(rec).toBeDefined();
    expect(rec!.changes.filters?.gyroLowpass2Hz).toBe(500); // 500 → 1000
    expect(rec!.cliLines?.join("\n")).toContain("set gyro_lpf2_static_hz = 1000");
  });

  it("suggests disabling gyro LPF2 when gyro rate equals PID rate", () => {
    const out = runRules(baseMetrics({ gyroRateHz: 8000, pidLoopRateHz: 8000 }), "freestyle");
    const rec = out.recommendations.find((r) => r.findingId === "gyro-lpf2");
    expect(rec).toBeDefined();
    expect(rec!.changes.filters?.gyroLowpass2Hz).toBe(-500);
    expect(rec!.cliLines?.join("\n")).toContain("set gyro_lpf2_static_hz = 0");
  });

  it("keeps gyro LPF2 when the RPM filter is off, even with gyro rate = PID rate", () => {
    // Without RPM filtering LPF2 is the only motor-noise low-pass — the
    // anti-aliasing argument alone must not remove it.
    const out = runRules(baseMetrics({ gyroRateHz: 8000, pidLoopRateHz: 8000, rpmFilterActive: false }), "freestyle");
    expect(out.recommendations.find((r) => r.findingId === "gyro-lpf2")).toBeUndefined();
  });

  it("lowers D-term dyn max for high-throttle noise, dyn min for low-throttle noise", () => {
    const high = runRules(
      baseMetrics({
        dtermRms: { roll: 200, pitch: 190, yaw: 60 },
        dtermRmsHighThrottle: { roll: 200, pitch: 190, yaw: 60 },
        dtermRmsLowThrottle: { roll: 40, pitch: 40, yaw: 30 },
      }),
      "freestyle",
    );
    const recHigh = high.recommendations.find((r) => r.findingId === "dterm-noise");
    expect(recHigh!.changes.filters?.dtermLowpassDynMaxHz).toBeLessThan(0);
    expect(recHigh!.changes.filters?.dtermLowpassDynMinHz).toBeUndefined();

    const low = runRules(
      baseMetrics({
        dtermRms: { roll: 200, pitch: 190, yaw: 60 },
        dtermRmsHighThrottle: { roll: 40, pitch: 40, yaw: 30 },
        dtermRmsLowThrottle: { roll: 200, pitch: 190, yaw: 60 },
      }),
      "freestyle",
    );
    const recLow = low.recommendations.find((r) => r.findingId === "dterm-noise");
    expect(recLow!.changes.filters?.dtermLowpassDynMinHz).toBeLessThan(0);
    expect(recLow!.changes.filters?.dtermLowpassDynMaxHz).toBeUndefined();
  });

  it("raises D first on under-damped axes, cuts P when D/P is already high", () => {
    const m = baseMetrics({
      stepResponse: [step("roll", { overshootPercent: 40, ringingCycles: 2 })],
    });
    // default D/P = 30/45 = 0.67 → raise D
    const out = runRules(m, "freestyle");
    const rec = out.recommendations.find((r) => r.findingId === "overshoot-roll");
    expect(rec!.changes.pids?.roll?.d).toBe(3);
    expect(rec!.changes.pids?.roll?.p).toBeUndefined();

    // base with D/P = 40/45 ≈ 0.89 → cut P
    const base: ProfileSettings = { pids: { roll: { p: 45, d: 40 } } };
    const out2 = runRules(m, "freestyle", base);
    const rec2 = out2.recommendations.find((r) => r.findingId === "overshoot-roll");
    expect(rec2!.changes.pids?.roll?.p).toBe(-3);
    expect(rec2!.changes.pids?.roll?.d).toBeUndefined();
  });

  it("tunes feedforward from start lag and end overshoot", () => {
    const m = baseMetrics({
      stepResponse: [step("pitch", { ffStartLagMs: 25 })],
    });
    const out = runRules(m, "freestyle");
    const lag = out.recommendations.find((r) => r.findingId === "ff-lag-pitch");
    expect(lag!.changes.advanced?.feedforwardPitch).toBe(10);
    expect(lag!.cliLines?.join("\n")).toContain("set f_pitch = 135"); // default 125 + 10
  });

  it("does not co-fire an FF cut on an axis already flagged under-damped", () => {
    // Overshoot during the step AND overshoot at move end can be the same
    // physical symptom — the D/P fix goes first, FF is re-evaluated after.
    const m = baseMetrics({
      stepResponse: [step("roll", { overshootPercent: 40, ffEndOvershootPercent: 35 })],
    });
    const out = runRules(m, "freestyle");
    expect(out.recommendations.some((r) => r.findingId === "overshoot-roll")).toBe(true);
    expect(out.recommendations.some((r) => r.findingId === "ff-end-roll")).toBe(false);
    // …but the finding is still reported.
    expect(out.findings.some((f) => f.id === "ff-end-roll")).toBe(true);
  });

  it("lowers feedforward on end-of-move overshoot", () => {
    const m2 = baseMetrics({
      stepResponse: [step("pitch", { ffEndOvershootPercent: 35 })],
    });
    const out2 = runRules(m2, "freestyle");
    const end = out2.recommendations.find((r) => r.findingId === "ff-end-pitch");
    expect(end!.changes.advanced?.feedforwardPitch).toBe(-10);
  });

  it("raises I on steady-state error", () => {
    const m = baseMetrics({
      stepResponse: [step("roll", { steadyStateErrorPercent: 9 })],
    });
    const out = runRules(m, "freestyle");
    const rec = out.recommendations.find((r) => r.findingId === "iterm-roll");
    expect(rec!.changes.pids?.roll?.i).toBe(5);
  });

  it("flags high-throttle-only noise as a TPA candidate", () => {
    const m = baseMetrics({
      dtermRms: { roll: 180, pitch: 170, yaw: 60 },
      dtermRmsHighThrottle: { roll: 180, pitch: 170, yaw: 60 },
      dtermRmsLowThrottle: { roll: 50, pitch: 50, yaw: 40 },
    });
    const out = runRules(m, "freestyle");
    const tpa = out.recommendations.find((r) => r.findingId === "tpa-hint");
    expect(tpa).toBeDefined();
    expect(tpa!.changes.advanced?.tpaRate).toBe(-5);
    expect(tpa!.cliLines?.join("\n")).toContain("set tpa_rate = 60"); // default 65 - 5
  });

  it("legacy path (no spectral) still targets notches but never below 100 Hz", () => {
    const m = baseMetrics({
      noisePeaks: [{ axis: "roll", freqHz: 130, magnitude: 12 }],
      noiseFloor: { roll: 1, pitch: 1, yaw: 1 },
    });
    const out = runRules(m, "freestyle");
    const rec = out.recommendations.find((r) => r.findingId === "resonance-notch");
    expect(rec).toBeDefined();
    if (rec!.changes.filters?.dynNotchMinHz !== undefined) {
      expect(100 + rec!.changes.filters.dynNotchMinHz).toBeGreaterThanOrEqual(100);
    }
  });

  it("resolves notch min/max as deltas when the notch was disabled (base count 0)", () => {
    const base: ProfileSettings = { filters: { dynNotchCount: 0 } };
    const m = baseMetrics({
      spectral: [spectral("roll", [peak({ freqHz: 230, freqSpreadHz: 12 })])],
    });
    const out = runRules(m, "freestyle", base);
    const rec = out.recommendations.find((r) => r.findingId === "resonance-notch");
    expect(rec).toBeDefined();
    const cli = rec!.cliLines?.join("\n") ?? "";
    // target min = 230-25 = 205 — must not be inflated by the base (100+205)
    expect(cli).toContain("set dyn_notch_min_hz = 205");
    expect(cli).toContain("set dyn_notch_count = 1");
  });

  it("does not throw on pre-overhaul persisted analyses (regression)", () => {
    // Shape of metrics_json rows persisted before the band/spectral/step
    // fields existed: no spectral, no bands, old step-metric shape.
    const legacy = baseMetrics();
    delete legacy.dtermRmsLowThrottle;
    delete legacy.dtermRmsHighThrottle;
    legacy.stepResponse = [
      {
        axis: "roll",
        overshootPercent: 30,
        riseTimeMs: 40,
        settlingTimeMs: 120,
        stepCount: 5,
      } as AxisStepMetrics,
    ];
    legacy.dtermRms = { roll: 200, pitch: 50, yaw: 50 };
    expect(() => runRules(legacy, "freestyle")).not.toThrow();
    const out = runRules(legacy, "freestyle");
    // legacy whole-log D-term rule still fires
    expect(out.recommendations.find((r) => r.findingId === "dterm-noise")).toBeDefined();
    // old step shape still feeds the PD-balance rule
    expect(out.recommendations.find((r) => r.findingId === "overshoot-roll")).toBeDefined();
  });

  it("attaches absolute CLI lines resolved against the base profile", () => {
    const base: ProfileSettings = { filters: { dtermLowpassDynMaxHz: 200 } };
    const m = baseMetrics({
      dtermRms: { roll: 300, pitch: 300, yaw: 300 },
      dtermRmsHighThrottle: { roll: 300, pitch: 300, yaw: 300 },
      dtermRmsLowThrottle: { roll: 300, pitch: 300, yaw: 300 },
    });
    const out = runRules(m, "freestyle", base);
    const rec = out.recommendations.find((r) => r.findingId === "dterm-noise");
    expect(rec!.cliLines?.join("\n")).toContain("set dterm_lpf1_dyn_max_hz = 180"); // 200 - 20
  });
});

describe("applyChanges", () => {
  it("applies PID deltas with clamping", () => {
    const base: ProfileSettings = { pids: { roll: { p: 45, i: 80, d: 30 } } };
    const out = applyChanges(base, { pids: { roll: { p: 5 } } });
    expect(out.pids?.roll?.p).toBe(50);
    expect(out.pids?.roll?.i).toBe(80);
  });

  it("clamps filter values to BF 4.5 CLI ranges", () => {
    const base: ProfileSettings = { filters: { dynNotchMinHz: 100, dynNotchQ: 300 } };
    const out = applyChanges(base, { filters: { dynNotchMinHz: -500, dynNotchQ: 5000 } });
    expect(out.filters?.dynNotchMinHz).toBe(20); // CLI range floor
    expect(out.filters?.dynNotchQ).toBe(1000);
  });

  it("clamps tpaBreakpoint to 1000–2000", () => {
    const base: ProfileSettings = { advanced: { tpaBreakpoint: 1350 } };
    expect(applyChanges(base, { advanced: { tpaBreakpoint: -800 } }).advanced?.tpaBreakpoint).toBe(1000);
    expect(applyChanges(base, { advanced: { tpaBreakpoint: 900 } }).advanced?.tpaBreakpoint).toBe(2000);
  });

  it("skips negative deltas without a base value", () => {
    const out = applyChanges({}, { filters: { dtermLowpassDynMaxHz: -30 } });
    expect(out.filters?.dtermLowpassDynMaxHz).toBeUndefined();
  });
});

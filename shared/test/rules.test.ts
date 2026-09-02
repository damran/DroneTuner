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
    // a stripe that is still visible in the filtered gyro is never a reason
    // to tighten the notch (Rosser: raise Q only while the stripe stays notched)
    expect(rec!.changes.filters?.dynNotchQ).toBeUndefined();
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
    // onset 140 → the minimum is never raised above the 100 Hz every whoop
    // tune uses; the fade grows instead: strong 200 − 100 = 100 (default 50 → +50)
    expect(rpm!.changes.filters?.rpmFilterMinHz).toBeUndefined();
    expect(rpm!.changes.filters?.rpmFilterFadeRangeHz).toBe(50);
  });

  it("switches the dynamic notch off on quiet frames with RPM filtering (Rosser / BF docs)", () => {
    // Filtered gyro only: weaker evidence (the notch could be hiding the stripe).
    const out = runRules(baseMetrics(), "freestyle");
    const rec = out.recommendations.find((r) => r.findingId === "quiet-frame");
    expect(rec).toBeDefined();
    expect(rec!.changes.filters?.dynNotchCount).toBe(-3); // BF default 3 → 0
    expect(rec!.cliLines?.join("\n")).toContain("set dyn_notch_count = 0");
    expect(rec!.score).toBeLessThan(0.5);
    // Raw gyro clean too → confident.
    const raw = runRules(baseMetrics({ spectralRaw: [spectral("roll", []), spectral("pitch", [])] }), "freestyle");
    const recRaw = raw.recommendations.find((r) => r.findingId === "quiet-frame");
    expect(recRaw!.score).toBeGreaterThan(0.5);
    // already off → nothing to do
    const off = runRules(baseMetrics(), "freestyle", { filters: { dynNotchCount: 0 } });
    expect(off.recommendations.find((r) => r.findingId === "quiet-frame")).toBeUndefined();
  });

  it("reads the raw gyro: a stripe removed by the notch means keep it and tighten one step", () => {
    const m = baseMetrics({
      spectral: [spectral("roll", [])],
      spectralRaw: [spectral("roll", [peak({ freqHz: 230, ratioToFloor: 9 })])],
    });
    const out = runRules(m, "freestyle", { filters: { dynNotchCount: 1, dynNotchQ: 500 } });
    expect(out.recommendations.find((r) => r.findingId === "quiet-frame")).toBeUndefined();
    const rec = out.recommendations.find((r) => r.findingId === "notch-working");
    expect(rec).toBeDefined();
    expect(rec!.changes.filters?.dynNotchQ).toBe(100); // 500 → 600
    // at Q 1000 the finding stays but nothing is recommended
    const capped = runRules(m, "freestyle", { filters: { dynNotchCount: 1, dynNotchQ: 1000 } });
    expect(capped.findings.some((f) => f.id === "notch-working")).toBe(true);
    expect(capped.recommendations.find((r) => r.findingId === "notch-working")).toBeUndefined();
  });

  it("widens a notch whose stripe leaks although range and count cover it", () => {
    const m = baseMetrics({ spectral: [spectral("roll", [peak({ freqHz: 230 })])] });
    const out = runRules(m, "freestyle", { filters: { dynNotchCount: 1, dynNotchMinHz: 150, dynNotchMaxHz: 500, dynNotchQ: 600 } });
    const rec = out.recommendations.find((r) => r.findingId === "resonance-notch");
    expect(rec!.changes.filters?.dynNotchQ).toBe(-100);
    expect(rec!.changes.filters?.dynNotchMinHz).toBeUndefined();
  });

  it("derives RPM notch weights from the raw gyro's measured harmonic strengths", () => {
    const rawRoll = spectral("roll", [peak({ kind: "motorHarmonic", freqHz: 300, ratioToFloor: 20, harmonic: 1, throttleCorr: 0.9, freqSpreadHz: 60 })], {
      harmonicRatios: [20, 2, 6],
    });
    const m = baseMetrics({
      spectral: [spectral("roll", [], { harmonicRatios: [1.2, 1.1, 1.3] })],
      spectralRaw: [rawRoll],
    });
    const out = runRules(m, "freestyle");
    const rec = out.recommendations.find((r) => r.findingId === "rpm-weights");
    expect(rec).toBeDefined();
    expect(rec!.cliLines?.join("\n")).toContain("set rpm_filter_weights = 100,0,80");
    // a harmonic that leaks in the filtered gyro is never dimmed
    const leaking = runRules({ ...m, spectral: [spectral("roll", [], { harmonicRatios: [1.2, 1.1, 5] })] }, "freestyle");
    expect(leaking.recommendations.find((r) => r.findingId === "rpm-weights")?.cliLines?.join("\n")).toContain("100,0,100");
    // a 1 kHz log cannot judge the folded harmonics → no weights advice
    expect(runRules({ ...m, sampleRateHz: 1000 }, "freestyle").recommendations.find((r) => r.findingId === "rpm-weights")).toBeUndefined();
  });

  it("offers a higher dynamic idle when the idle line sits below the RPM filter floor", () => {
    const m = baseMetrics({
      spectral: [spectral("roll", [peak({ kind: "motorIdle", freqHz: 42, ratioToFloor: 12 })])],
      flownConfig: { filters: {} as never, pids: null, advanced: { idleMinRpm: 25 } },
    });
    const out = runRules(m, "freestyle");
    const rec = out.recommendations.find((r) => r.findingId === "motor-idle");
    expect(rec!.changes.advanced?.idleMinRpm).toBe(35); // 25 → 60 (= 100 Hz × 60 / 100)
    expect(rec!.cliLines?.join("\n")).toContain("set dyn_idle_min_rpm = 60");
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

  it("fixes the P:D ratio on under-damped axes: P and I down (Rosser), D up only when D is abnormally low", () => {
    const m = baseMetrics({
      stepResponse: [step("roll", { overshootPercent: 40, ringingCycles: 2 })],
    });
    // BF 4.5 default D/P = 40/45 ≈ 0.89 → one tracking step down (P and I −10 %)
    const out = runRules(m, "freestyle");
    const rec = out.recommendations.find((r) => r.findingId === "overshoot-roll");
    expect(rec!.changes.pids?.roll?.p).toBe(-5); // round(45 × 0.1)
    expect(rec!.changes.pids?.roll?.i).toBe(-8); // round(80 × 0.1)
    expect(rec!.changes.pids?.roll?.d).toBeUndefined();

    // D/P = 20/45 ≈ 0.44 → damping is missing → raise D
    const base: ProfileSettings = { pids: { roll: { p: 45, i: 80, d: 20 } } };
    const out2 = runRules(m, "freestyle", base);
    const rec2 = out2.recommendations.find((r) => r.findingId === "overshoot-roll");
    expect(rec2!.changes.pids?.roll?.d).toBe(2);
    expect(rec2!.changes.pids?.roll?.p).toBeUndefined();
  });

  it("reads a slow, drawn-out overshoot as too much I-term (Brian White)", () => {
    const m = baseMetrics({
      stepResponse: [step("pitch", { overshootPercent: 30, ringingCycles: 2, riseTimeMs: 15, peakTimeMs: 120 })],
    });
    const out = runRules(m, "freestyle");
    expect(out.recommendations.find((r) => r.findingId === "overshoot-pitch")).toBeUndefined();
    const rec = out.recommendations.find((r) => r.findingId === "iterm-high-pitch");
    expect(rec!.changes.pids?.pitch?.i).toBe(-8); // round(84 × 0.1)
    // a sharp overshoot (peak right after the rise) stays a P:D problem
    const sharp = runRules(baseMetrics({ stepResponse: [step("pitch", { overshootPercent: 30, ringingCycles: 2, riseTimeMs: 15, peakTimeMs: 25 })] }), "freestyle");
    expect(sharp.recommendations.find((r) => r.findingId === "overshoot-pitch")).toBeDefined();
  });

  it("raises P and I together on an over-damped axis", () => {
    const out = runRules(baseMetrics({ stepResponse: [step("roll", { riseTimeMs: 70, overshootPercent: 2 })] }), "freestyle");
    const rec = out.recommendations.find((r) => r.findingId === "slow-roll");
    expect(rec!.changes.pids?.roll?.p).toBe(5);
    expect(rec!.changes.pids?.roll?.i).toBe(8);
  });

  it("tunes feedforward from start lag: more FF when the lag persists, FF boost when the gyro catches up", () => {
    // lag through the whole move (steady-state error stays) → more FF
    const persistent = runRules(baseMetrics({ stepResponse: [step("pitch", { ffStartLagMs: 25, steadyStateErrorPercent: 8 })] }), "freestyle");
    const lag = persistent.recommendations.find((r) => r.findingId === "ff-lag-pitch");
    expect(lag!.changes.advanced?.feedforwardPitch).toBe(10);
    expect(lag!.cliLines?.join("\n")).toContain("set f_pitch = 135"); // default 125 + 10
    // start-only lag → boost, not FF (Rosser)
    const startOnly = runRules(baseMetrics({ stepResponse: [step("pitch", { ffStartLagMs: 25, steadyStateErrorPercent: 2 })] }), "freestyle");
    const boost = startOnly.recommendations.find((r) => r.findingId === "ff-lag-pitch");
    expect(boost!.changes.advanced?.feedforwardBoost).toBe(3);
    expect(boost!.changes.advanced?.feedforwardPitch).toBeUndefined();
    // a tune without FF gets FF 50 as its first step (the FF A/B pair)
    const noFf = runRules(
      baseMetrics({ stepResponse: [step("pitch", { ffStartLagMs: 25, steadyStateErrorPercent: 8 })] }),
      "freestyle",
      { advanced: { feedforwardPitch: 0 } },
    );
    expect(noFf.recommendations.find((r) => r.findingId === "ff-lag-pitch")!.changes.advanced?.feedforwardPitch).toBe(50);
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
    expect(rec!.changes.pids?.roll?.i).toBe(8); // +10 % of the default 80
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
    // tpa_rate is the attenuation at full throttle: MORE attenuation = higher value
    expect(tpa!.changes.advanced?.tpaRate).toBe(5);
    expect(tpa!.cliLines?.join("\n")).toContain("set tpa_rate = 70"); // default 65 + 5
    // with throttle bands the breakpoint moves just below the noisy band
    const banded = runRules({ ...m, throttleBands: { lowMaxUs: 1150, highMinUs: 1520 } }, "freestyle", { advanced: { tpaRate: 40, tpaBreakpoint: 1600 } });
    const rec = banded.recommendations.find((r) => r.findingId === "tpa-hint");
    expect(rec!.cliLines?.join("\n")).toContain("set tpa_breakpoint = 1470");
    expect(rec!.cliLines?.join("\n")).toContain("set tpa_rate = 45");
  });

  it("flags the header-only settings Rosser calls out", () => {
    const m = baseMetrics({
      flownConfig: { filters: {} as never, pids: null, advanced: { dMaxAdvance: 20 } },
      flownExtras: { pidsumLimit: 500, pidsumLimitYaw: 400, rcSmoothingAutoFactor: 30, absControlGain: 5 },
    });
    const out = runRules(m, "freestyle");
    const adv = out.recommendations.find((r) => r.findingId === "dmax-advance");
    expect(adv!.cliLines?.join("\n")).toContain("set d_max_advance = 0");
    expect(out.recommendations.find((r) => r.findingId === "pidsum-limit")?.cliLines).toContain("set pidsum_limit = 1000");
    expect(out.recommendations.find((r) => r.findingId === "rc-smoothing")?.cliLines).toContain("set rc_smoothing_auto_factor = 50");
    expect(out.findings.some((f) => f.id === "abs-control")).toBe(true);
    // racing at 30 is close enough to its 25 target, and precision has no Rosser number → no smoothing finding
    expect(runRules(m, "racing").findings.some((f) => f.id === "rc-smoothing")).toBe(false);
    expect(runRules(m, "precision").findings.some((f) => f.id === "rc-smoothing")).toBe(false);
  });

  it("points at the crisp A/B when the D-term is quiet everywhere", () => {
    const quiet = runRules(baseMetrics({ dtermRms: { roll: 30, pitch: 30, yaw: 20 }, dtermRmsLowThrottle: { roll: 30, pitch: 30, yaw: 20 }, dtermRmsHighThrottle: { roll: 40, pitch: 35, yaw: 20 } }), "freestyle");
    expect(quiet.findings.some((f) => f.id === "dterm-headroom")).toBe(true);
    const busy = baseMetrics({ dtermRms: { roll: 90, pitch: 90, yaw: 60 }, dtermRmsLowThrottle: { roll: 70, pitch: 70, yaw: 50 }, dtermRmsHighThrottle: { roll: 90, pitch: 90, yaw: 60 } });
    expect(runRules(busy, "freestyle").findings.some((f) => f.id === "dterm-headroom")).toBe(false);
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

describe("motor pole check and aliased motor noise findings", () => {
  it("warns with a motor_poles CLI line when the measured motor line fits another pole count", () => {
    const out = runRules(
      baseMetrics({
        motorPoleCheck: { headerPoles: 12, status: "mismatch", suggestedPoles: 14, harmonic: 1, aliased: false, peakHz: 303, ratioToFloor: 9, ratio: 0.86 },
      }),
      "freestyle",
    );
    const f = out.findings.find((f) => f.id === "motor-poles");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
    expect(f!.title).toBe("RPM estimate does not match measured motor peak");
    const rec = out.recommendations.find((r) => r.findingId === "motor-poles");
    expect(rec?.cliLines).toContain("set motor_poles = 14");
  });

  it("confirms the pole count as an info finding when a harmonic matches", () => {
    const out = runRules(
      baseMetrics({
        motorPoleCheck: { headerPoles: 12, status: "consistent", harmonic: 2, aliased: false, peakHz: 690, ratioToFloor: 12, ratio: 2.01 },
      }),
      "freestyle",
    );
    expect(out.findings.find((f) => f.id === "motor-poles")).toBeUndefined();
    expect(out.findings.find((f) => f.id === "motor-poles-ok")).toBeDefined();
  });

  it("explains a folded motor harmonic and suggests a higher blackbox rate on 1/4 logs", () => {
    const out = runRules(
      baseMetrics({
        sampleRateHz: 1000,
        pidLoopRateHz: 4000,
        gyroRateHz: 8000,
        spectral: [spectral("roll", [peak({ kind: "motorHarmonic", freqHz: 111, harmonic: 2, aliased: true, ratioToFloor: 8 })])],
      }),
      "freestyle",
    );
    const f = out.findings.find((f) => f.id === "aliased-motor-noise");
    expect(f).toBeDefined();
    expect(f!.detail).toContain("not a frame resonance");
    expect(out.recommendations.find((r) => r.findingId === "aliased-motor-noise")?.cliLines).toContain("set blackbox_sample_rate = 1/2");
    // and it never becomes a dynamic-notch target
    expect(out.recommendations.find((r) => r.findingId === "resonance-notch")).toBeUndefined();
  });

  it("uses deconvolution evidence for the step rules when explicit steps are scarce", () => {
    const out = runRules(
      baseMetrics({
        stepResponse: [step("roll", { stepCount: 1, method: "deconvolution", windowCount: 20, overshootPercent: 35, ringingCycles: 2 })],
      }),
      "freestyle",
    );
    expect(out.findings.some((f) => f.title.includes("under-damped"))).toBe(true);
    const scarce = runRules(baseMetrics({ stepResponse: [step("roll", { stepCount: 1, method: "steps", overshootPercent: 35 })] }), "freestyle");
    expect(scarce.findings.some((f) => f.title.includes("under-damped"))).toBe(false);
  });
});

describe("RPM filter rules with identified harmonics", () => {
  it("adds a harmonic instead of widening Q when the visible line is above rpm_filter_harmonics", () => {
    const out = runRules(
      baseMetrics({
        spectral: [spectral("roll", [peak({ kind: "motorHarmonic", freqHz: 976, harmonic: 3, aliased: true, ratioToFloor: 12 })])],
        flownConfig: { filters: { rpmFilterHarmonics: 2, rpmFilterQ: 500 } as never, pids: null, advanced: null },
      }),
      "freestyle",
    );
    const rec = out.recommendations.find((r) => r.findingId === "rpm-harmonics");
    expect(rec).toBeDefined();
    expect(rec!.changes.filters?.rpmFilterHarmonics).toBe(1); // 2 → 3
    expect(out.recommendations.find((r) => r.findingId === "rpm-q")).toBeUndefined();
    expect(out.recommendations.find((r) => r.findingId === "rpm-weights")).toBeUndefined();
  });

  it("widens Q for a covered harmonic that still leaks", () => {
    const out = runRules(
      baseMetrics({
        spectral: [spectral("roll", [peak({ kind: "motorHarmonic", freqHz: 81, harmonic: 2, aliased: true, ratioToFloor: 9 })])],
        flownConfig: { filters: { rpmFilterHarmonics: 3, rpmFilterQ: 500 } as never, pids: null, advanced: null },
      }),
      "freestyle",
    );
    expect(out.recommendations.find((r) => r.findingId === "rpm-harmonics")).toBeUndefined();
    const q = out.recommendations.find((r) => r.findingId === "rpm-q");
    expect(q).toBeDefined();
    expect(q!.changes.filters?.rpmFilterQ).toBeLessThan(0);
  });
});

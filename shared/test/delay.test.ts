import { describe, expect, it } from "vitest";
import {
  BF45_FILTER_DEFAULTS,
  estimateFilterDelay,
  filterConfigFromHeaders,
  filterConfigFromProfile,
} from "../src/analysis/delay";

// Group-delay anchors (the estimator reports group delay, −dφ/dω):
// - digital PT1 at its cutoff: 1/(4π·fc) ≈ 0.64 ms at 125 Hz (analog value;
//   BF's Euler PT1 lands slightly lower)
// - 2nd-order Butterworth biquad at its cutoff: √2/(2π·fc) ≈ 1.8 ms at 125 Hz
// (The BF-wiki "1 ms at 125 Hz" figure is PHASE delay — a different metric.)

describe("groupDelayMs anchors", () => {
  it("PT1 group delay at its cutoff is ~1/(4π·fc)", () => {
    const fc = 125;
    const fs = 8000;
    // build a PT1 section via estimateFilterDelay with only gyro LPF2 set
    const est = estimateFilterDelay(
      {
        ...BF45_FILTER_DEFAULTS,
        gyroLowpassHz: 0,
        gyroLowpassDynMinHz: 0,
        gyroLowpassDynMaxHz: 0,
        gyroLowpass2Hz: fc,
        gyroLowpass2Type: 0, // PT1
        dtermLowpassDynMinHz: 0,
        dtermLowpassDynMaxHz: 0,
        dtermLowpass2Hz: 0,
        dynNotchCount: 0,
        rpmFilterHarmonics: 0,
      },
      { gyroRateHz: fs, pidLoopRateHz: fs, referenceFreqHz: fc },
    );
    expect(est.gyroMs).toBeGreaterThan(0.45);
    expect(est.gyroMs).toBeLessThan(0.75);
  });

  it("biquad group delay at its cutoff is ~√2/(2π·fc)", () => {
    const fc = 125;
    const fs = 8000;
    const mk = (type: number) =>
      estimateFilterDelay(
        {
          ...BF45_FILTER_DEFAULTS,
          gyroLowpassHz: 0,
          gyroLowpassDynMinHz: 0,
          gyroLowpassDynMaxHz: 0,
          gyroLowpass2Hz: fc,
          gyroLowpass2Type: type,
          dtermLowpassDynMinHz: 0,
          dtermLowpassDynMaxHz: 0,
          dtermLowpass2Hz: 0,
          dynNotchCount: 0,
          rpmFilterHarmonics: 0,
        },
        { gyroRateHz: fs, pidLoopRateHz: fs, referenceFreqHz: fc },
      ).gyroMs;
    const pt1 = mk(0);
    const biquad = mk(1);
    expect(biquad).toBeGreaterThan(1.5);
    expect(biquad).toBeLessThan(2.1);
    expect(biquad / pt1).toBeGreaterThan(2.3);
  });

  it("a notch far above the reference frequency adds little delay", () => {
    const est = estimateFilterDelay(
      {
        ...BF45_FILTER_DEFAULTS,
        gyroLowpassHz: 0,
        gyroLowpassDynMinHz: 0,
        gyroLowpassDynMaxHz: 0,
        gyroLowpass2Hz: 0,
        dtermLowpassDynMinHz: 0,
        dtermLowpassDynMaxHz: 0,
        dtermLowpass2Hz: 0,
        dynNotchCount: 1,
        dynNotchMinHz: 300,
        dynNotchQ: 300,
        rpmFilterHarmonics: 0,
      },
      { gyroRateHz: 8000, pidLoopRateHz: 8000, referenceFreqHz: 50 },
    );
    expect(est.gyroMs).toBeGreaterThan(0);
    expect(est.gyroMs).toBeLessThan(0.6);
  });
});

describe("estimateFilterDelay", () => {
  it("default BF 4.5 chain lands in a sane band and drops when the notch is disabled", () => {
    const full = estimateFilterDelay(BF45_FILTER_DEFAULTS, { gyroRateHz: 8000, pidLoopRateHz: 4000 });
    const noNotch = estimateFilterDelay(
      { ...BF45_FILTER_DEFAULTS, dynNotchCount: 0 },
      { gyroRateHz: 8000, pidLoopRateHz: 4000 },
    );
    expect(full.dtermMs).toBeGreaterThan(1);
    expect(full.dtermMs).toBeLessThan(15);
    expect(noNotch.dtermMs).toBeLessThan(full.dtermMs);
    expect(full.stages.length).toBeGreaterThan(3);
  });

  it("warns when rates are unknown", () => {
    const est = estimateFilterDelay(BF45_FILTER_DEFAULTS, {});
    expect(est.warnings.length).toBeGreaterThan(0);
  });
});

describe("filterConfigFromHeaders", () => {
  it("parses BF 4.5 header names with defaults as fallback", () => {
    const cfg = filterConfigFromHeaders({
      dyn_notch_min_hz: "150",
      dyn_notch_q: "500",
      rpm_filter_q: "750",
      gyro_lpf2_static_hz: "1000",
      dterm_lpf1_type: "1",
      rpm_filter_weights: "100,0,80",
    });
    expect(cfg.dynNotchMinHz).toBe(150);
    expect(cfg.dynNotchQ).toBe(500);
    expect(cfg.rpmFilterQ).toBe(750);
    expect(cfg.gyroLowpass2Hz).toBe(1000);
    expect(cfg.dtermLowpassType).toBe(1);
    expect(cfg.rpmFilterWeight2).toBe(0);
    // untouched keys fall back to BF 4.5 defaults
    expect(cfg.dynNotchMaxHz).toBe(600);
  });

  it("accepts legacy header names", () => {
    const cfg = filterConfigFromHeaders({ gyro_lowpass2_hz: "250", dterm_lowpass_dyn_min_hz: "90" });
    expect(cfg.gyroLowpass2Hz).toBe(250);
    expect(cfg.dtermLowpassDynMinHz).toBe(90);
  });
});

describe("filterConfigFromProfile", () => {
  it("merges profile filters over defaults", () => {
    const cfg = filterConfigFromProfile({ filters: { dynNotchCount: 0, rpmFilterQ: 900 } });
    expect(cfg.dynNotchCount).toBe(0);
    expect(cfg.rpmFilterQ).toBe(900);
    expect(cfg.dynNotchMinHz).toBe(100);
  });
});

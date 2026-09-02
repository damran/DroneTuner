import { describe, expect, it } from "vitest";
import {
  fitFilterSliders,
  fitSimplifiedSliders,
  simplifiedSlidersToCli,
  simplifiedToFilters,
  simplifiedToPids,
  type SimplifiedPidSliders,
} from "../src/tuning/simplified";

const DEFAULT_SLIDERS: SimplifiedPidSliders = {
  mode: "RPY",
  master: 100,
  piGain: 100,
  iGain: 100,
  dGain: 100,
  dminRatio: 100,
  feedforwardGain: 100,
  pitchPiGain: 100,
  rollPitchRatio: 100,
};

describe("simplifiedToPids (simplified_tuning.c)", () => {
  it("reproduces the Betaflight 4.5 defaults at 100 everywhere", () => {
    const r = simplifiedToPids(DEFAULT_SLIDERS);
    expect(r.roll).toEqual({ p: 45, i: 80, d: 40, dMin: 30, f: 120 });
    expect(r.pitch).toEqual({ p: 47, i: 84, d: 46, dMin: 34, f: 125 });
    expect(r.yaw).toEqual({ p: 45, i: 80, d: 0, dMin: 0, f: 120 });
  });

  it("scales exactly like the firmware: master 120, D gain 80, D max gain 50", () => {
    // roll: P = 45·1.2 = 54, I = 80·1.2 = 96, D-min = 30·1.2·0.8 = 28.8 → 28,
    // D = 28.8·(1 + (10/30)·0.5) = 33.6 → 33, F = 120·1.2 = 144
    const r = simplifiedToPids({ ...DEFAULT_SLIDERS, master: 120, dGain: 80, dminRatio: 50 });
    expect(r.roll).toEqual({ p: 54, i: 96, d: 33, dMin: 28, f: 144 });
    // RP mode leaves yaw alone
    expect(simplifiedToPids({ ...DEFAULT_SLIDERS, mode: "RP" }).yaw).toBeNull();
    expect(simplifiedToPids({ ...DEFAULT_SLIDERS, mode: "OFF" }).roll).toBeNull();
  });

  it("filter multipliers scale the defaults and leave disabled stages at 0", () => {
    const f = simplifiedToFilters(
      { dtermMultiplier: 120, gyroMultiplier: 80 },
      { dtermLowpassDynMinHz: 75, dtermLowpassDynMaxHz: 150, dtermLowpass2Hz: 150, gyroLowpassHz: 0, gyroLowpass2Hz: 500 },
    );
    expect(f.dtermLowpassDynMinHz).toBe(90);
    expect(f.dtermLowpassDynMaxHz).toBe(180);
    expect(f.dtermLowpass2Hz).toBe(180);
    expect(f.gyroLowpassHz).toBe(0);
    expect(f.gyroLowpass2Hz).toBe(400);
  });
});

describe("fitSimplifiedSliders (master fixed at 100)", () => {
  it("recovers a slider-made tune exactly", () => {
    const target: SimplifiedPidSliders = { ...DEFAULT_SLIDERS, piGain: 135, iGain: 90, dGain: 115, dminRatio: 60, feedforwardGain: 40, pitchPiGain: 110, rollPitchRatio: 120 };
    const pids = simplifiedToPids(target);
    const fit = fitSimplifiedSliders({
      pids: { roll: pids.roll!, pitch: pids.pitch!, yaw: pids.yaw! },
      advanced: { dMinRoll: pids.roll!.dMin, dMinPitch: pids.pitch!.dMin, feedforwardRoll: pids.roll!.f, feedforwardPitch: pids.pitch!.f, feedforwardYaw: pids.yaw!.f },
    })!;
    expect(fit.sliders.mode).toBe("RPY");
    for (const k of ["piGain", "iGain", "dGain", "feedforwardGain", "pitchPiGain", "rollPitchRatio"] as const) {
      expect(Math.abs(fit.sliders[k] - target[k])).toBeLessThanOrEqual(2);
    }
    expect(Math.abs(fit.sliders.dminRatio - target.dminRatio)).toBeLessThanOrEqual(8); // integer truncation of D/D-min
    expect(fit.exact).toBe(true);
    expect(fit.offTerms).toEqual([]);
  });

  it("expresses the Air65 R 'HQ 31mm' tune and reports what no slider can reach", () => {
    // P 61/67, I 110/121, D 41/51, D-min 24/30, FF 0 (BetaFPV factory + pilot).
    const fit = fitSimplifiedSliders({
      pids: { roll: { p: 61, i: 110, d: 41 }, pitch: { p: 67, i: 121, d: 51 }, yaw: { p: 61, i: 110, d: 0 } },
      advanced: { dMinRoll: 24, dMinPitch: 30, feedforwardRoll: 0, feedforwardPitch: 0, feedforwardYaw: 0 },
    })!;
    expect(fit.sliders.master).toBe(100);
    expect(fit.sliders.piGain).toBe(136); // 61/45
    expect(fit.sliders.iGain).toBe(101); // 110/(80·1.356)
    expect(fit.sliders.dGain).toBe(80); // 24/30
    expect(fit.sliders.feedforwardGain).toBe(0);
    expect(fit.sliders.mode).toBe("RPY"); // yaw 61/110 = roll gains
    expect(fit.maxErrorPercent).toBeLessThan(6);
  });

  it("flags a hand tune the sliders cannot express and returns null without PIDs", () => {
    const fit = fitSimplifiedSliders({
      pids: { roll: { p: 45, i: 80, d: 40 }, pitch: { p: 47, i: 30, d: 46 }, yaw: { p: 90, i: 10, d: 0 } },
      advanced: { dMinRoll: 30, dMinPitch: 34 },
    })!;
    expect(fit.offTerms).toContain("pitch I");
    expect(fit.sliders.mode).toBe("RP");
    expect(fitSimplifiedSliders({ filters: {} })).toBeNull();
  });

  it("fits filter multipliers and flags chains not set by one slider", () => {
    const even = fitFilterSliders({ dtermLowpassDynMinHz: 90, dtermLowpassDynMaxHz: 180, dtermLowpass2Hz: 180, gyroLowpass2Hz: 500 });
    expect(even.dtermMultiplier).toBe(120);
    expect(even.gyroMultiplier).toBe(100);
    expect(even.offTerms).toEqual([]);
    const uneven = fitFilterSliders({ dtermLowpassDynMinHz: 50, dtermLowpassDynMaxHz: 150, dtermLowpass2Hz: 100 });
    expect(uneven.offTerms).toContain("D-term filters");
  });

  it("emits the CLI keys Configurator writes", () => {
    const lines = simplifiedSlidersToCli(DEFAULT_SLIDERS, { dtermMultiplier: 110, gyroMultiplier: 0 });
    expect(lines).toContain("set simplified_pids_mode = RPY");
    expect(lines).toContain("set simplified_dmin_ratio = 100");
    expect(lines).toContain("set simplified_gyro_filter = OFF");
    expect(lines).toContain("set simplified_dterm_filter_multiplier = 110");
  });
});

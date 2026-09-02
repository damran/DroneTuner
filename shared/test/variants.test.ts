import { describe, expect, it } from "vitest";
import { applyVariant, filterDiffKeys, splitFilterScope } from "../src/tuning/variants";
import { estimateFilterDelay, filterConfigFromProfile } from "../src/analysis/delay";
import type { ProfileSettings } from "../src/types/fc";

const base: ProfileSettings = {
  pids: { roll: { p: 61, i: 110, d: 41 } },
  filters: {
    gyroLowpassHz: 0,
    gyroLowpassDynMinHz: 0,
    gyroLowpassDynMaxHz: 500,
    gyroLowpass2Hz: 500,
    dtermLowpassDynMinHz: 75,
    dtermLowpassDynMaxHz: 150,
    dtermLowpass2Hz: 150,
    dynNotchCount: 1,
    dynNotchQ: 500,
    dynNotchMinHz: 120,
    dynNotchMaxHz: 500,
    rpmFilterHarmonics: 3,
    rpmFilterWeight1: 100,
    rpmFilterWeight2: 100,
    rpmFilterWeight3: 100,
  },
  advanced: { feedforwardRoll: 0, tpaRate: 40 },
};

describe("tune variants", () => {
  it("balanced returns the template untouched", () => {
    expect(applyVariant(base, "balanced")).toBe(base);
  });

  it("only the filter chain differs between crisp and smooth", () => {
    const crisp = applyVariant(base, "crisp");
    const smooth = applyVariant(base, "smooth");
    expect(crisp.pids).toEqual(base.pids);
    expect(crisp.advanced).toEqual(base.advanced);
    expect(smooth.pids).toEqual(base.pids);
    expect(filterDiffKeys(crisp.filters, smooth.filters).length).toBeGreaterThan(4);
    // disabled gyro LPF1 stays disabled; the notch band is airframe-specific and stays
    expect(crisp.filters?.gyroLowpassHz).toBe(0);
    expect(crisp.filters?.dynNotchMinHz).toBe(120);
    expect(smooth.filters?.dynNotchMinHz).toBe(120);
    expect(crisp.filters?.rpmFilterHarmonics).toBe(1);
    expect(smooth.filters?.dynNotchCount).toBe(2);
    expect(smooth.filters?.dtermLowpassDynMinHz).toBe(60);
    expect(crisp.filters?.dtermLowpass2Hz).toBe(188);
  });

  it("crisp has less group delay than balanced, smooth has more", () => {
    const delay = (s: ProfileSettings) => estimateFilterDelay(filterConfigFromProfile(s), {}).dtermMs;
    const b = delay(base);
    expect(delay(applyVariant(base, "crisp"))).toBeLessThan(b);
    expect(delay(applyVariant(base, "smooth"))).toBeGreaterThan(b);
  });

  it("profile scope only touches the D-term chain (what two PID profiles can differ in)", () => {
    const crisp = applyVariant(base, "crisp", "profile");
    expect(crisp.filters?.gyroLowpass2Hz).toBe(500);
    expect(crisp.filters?.dynNotchQ).toBe(500);
    expect(crisp.filters?.rpmFilterHarmonics).toBe(3);
    expect(crisp.filters?.dtermLowpassDynMinHz).toBe(94);
    expect(crisp.filters?.dtermLowpass2Hz).toBe(188);
    const { profile, master } = splitFilterScope(crisp.filters);
    expect(Object.keys(profile).sort()).toEqual(["dtermLowpass2Hz", "dtermLowpassDynMaxHz", "dtermLowpassDynMinHz"]);
    expect(master.dynNotchCount).toBe(1);
  });
});

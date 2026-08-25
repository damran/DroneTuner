import { describe, expect, it } from "vitest";
import { diffConfig } from "../src/tuning/diff";
import type { FcConfig } from "../src/types/fc";

const current: FcConfig = {
  apiVersion: "1.46.0",
  fcVariant: "BTFL",
  fcVersion: "4.5.1",
  pids: { roll: { p: 46, i: 90, d: 40 }, pitch: { p: 48, i: 90, d: 40 }, yaw: { p: 80, i: 100, d: 0 } },
  filters: { gyroLowpassDynMinHz: 250, dtermLowpassHz: 100 },
  rates: { rcRate: 100, rollRate: 70 },
  advanced: { feedforwardRoll: 120 },
  featureMask: 0,
};

describe("diffConfig", () => {
  it("detects changes across sections", () => {
    const result = diffConfig(current, {
      pids: { roll: { p: 50 } },
      filters: { gyroLowpassDynMinHz: 300 },
      rates: { rcRate: 110 },
    });
    expect(result.diff.length).toBe(3);
    expect(result.sections).toContain("pids");
    expect(result.sections).toContain("filters");
    expect(result.sections).toContain("rates");
    expect(result.upToDate).toBe(false);
  });

  it("is upToDate when equal", () => {
    const result = diffConfig(current, { pids: { roll: { p: 46 } } });
    expect(result.upToDate).toBe(true);
    expect(result.diff.length).toBe(0);
  });

  it("formats rate values as x/100", () => {
    const result = diffConfig(current, { rates: { rcRate: 110 } });
    expect(result.diff[0]!.toDisplay).toBe("1.10");
  });
});

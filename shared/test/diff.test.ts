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

  it("formats rates_type as its enum name", () => {
    const fc: FcConfig = { ...current, rates: { ...current.rates, ratesType: 3 } };
    const result = diffConfig(fc, { rates: { ratesType: 0, rcRate: 100 } });
    const typeRow = result.diff.find((d) => d.path === "rates.ratesType");
    expect(typeRow?.fromDisplay).toBe("ACTUAL");
    expect(typeRow?.toDisplay).toBe("BETAFLIGHT");
  });

  it("formats ACTUAL-convention rate values as deg/s", () => {
    // FC on ACTUAL (rates_type 3): rcRate 19 means 190 °/s center sensitivity.
    const fc: FcConfig = { ...current, rates: { rcRate: 19, rollRate: 67, ratesType: 3 } };
    const result = diffConfig(fc, { rates: { rcRate: 22, ratesType: 3 } });
    const row = result.diff.find((d) => d.path === "rates.rcRate");
    expect(row?.fromDisplay).toBe("190 °/s");
    expect(row?.toDisplay).toBe("220 °/s");
  });

  it("formats each side under its own convention when the type switches", () => {
    const fc: FcConfig = { ...current, rates: { rcRate: 19, ratesType: 3 } };
    const result = diffConfig(fc, { rates: { ratesType: 0, rcRate: 100 } });
    const row = result.diff.find((d) => d.path === "rates.rcRate");
    expect(row?.fromDisplay).toBe("190 °/s"); // FC side: ACTUAL
    expect(row?.toDisplay).toBe("1.00"); // profile side: BETAFLIGHT
  });
});

import { describe, expect, it } from "vitest";
import type { ParsedLog } from "../src/blackbox/types";
import {
  computeRatesUsage,
  parseLoggedRates,
  shareInRange,
  zoneShares,
  type AxisRateUsage,
  type RatesUsage,
} from "../src/analysis/rates";
import {
  actualRateDegS,
  bendRegionDegS,
  rateCurvePoints,
  ratesSizeGroup,
  recommendRates,
  stickForDegS,
  zoneStickTravel,
} from "../src/tuning/rates";
import { parseCliDump } from "../src/vendor/cli-dump";
import type { Axis } from "../src/types/fc";

// ---- synthetic log builder ----

function makeLog(opts: {
  setpoint: [number[], number[], number[]];
  gyro?: [number[], number[], number[]];
  throttle?: number[];
  headers?: Record<string, string>;
}): ParsedLog {
  const n = opts.setpoint[0].length;
  const channels: Record<string, Float32Array> = {
    "setpoint[0]": new Float32Array(opts.setpoint[0]),
    "setpoint[1]": new Float32Array(opts.setpoint[1]),
    "setpoint[2]": new Float32Array(opts.setpoint[2]),
  };
  if (opts.gyro) {
    channels["gyroADC[0]"] = new Float32Array(opts.gyro[0]);
    channels["gyroADC[1]"] = new Float32Array(opts.gyro[1]);
    channels["gyroADC[2]"] = new Float32Array(opts.gyro[2]);
  }
  if (opts.throttle) channels["rcCommand[3]"] = new Float32Array(opts.throttle);
  return {
    headers: opts.headers ?? {},
    frameCount: n,
    timeUs: new Float32Array(n).map((_, i) => i * 1000),
    channels,
    looptimeUs: 1000,
    gyroScale: opts.gyro ? 1 : null, // gyroScale 1 → gyro values are already deg/s
    firmware: "Betaflight",
    warnings: [],
  };
}

function constLog(value: number, frames = 1000, headers: Record<string, string> = {}): ParsedLog {
  return makeLog({
    setpoint: [Array(frames).fill(value), Array(frames).fill(0), Array(frames).fill(0)],
    throttle: Array(frames).fill(1500),
    headers,
  });
}

// ---- usage builder (for recommendRates) ----

function makeAxisUsage(axis: Axis, over: Partial<AxisRateUsage> = {}): AxisRateUsage {
  return {
    axis,
    histogram: new Array(49).fill(0),
    zones: { precision: 0.1, normal: 0.6, deadspace: 0.2, trick: 0.1 },
    p50: 150,
    p90: 400,
    p99: 500,
    maxDegS: 800,
    saturationPercent: 0,
    achievedP99DegS: null,
    highDeflectionTracking: null,
    ...over,
  };
}

function makeUsage(over: Partial<Record<Axis, Partial<AxisRateUsage>>> = {}, usageOver: Partial<RatesUsage> = {}): RatesUsage {
  return {
    binWidthDegS: 25,
    binCount: 49,
    airborneShare: 0.8,
    axes: [
      makeAxisUsage("roll", over.roll),
      makeAxisUsage("pitch", over.pitch),
      makeAxisUsage("yaw", over.yaw),
    ],
    loggedRates: null,
    ...usageOver,
  };
}

// ---- Actual rates curve ----

describe("actualRateDegS", () => {
  it("hits exactly max at full stick and 0 at center", () => {
    expect(actualRateDegS(1, 70, 670, 0.5)).toBe(670);
    expect(actualRateDegS(-1, 70, 670, 0.5)).toBe(-670);
    expect(actualRateDegS(0, 70, 670, 0.5)).toBe(0);
  });

  it("has slope ≈ center sensitivity at the center", () => {
    // finite difference at 0.001 — the quadratic expo term contributes ~0.3 here
    const slope = (actualRateDegS(0.001, 70, 670, 0.5) - actualRateDegS(0, 70, 670, 0.5)) / 0.001;
    expect(slope).toBeGreaterThan(69.5);
    expect(slope).toBeLessThan(71);
  });

  it("matches the RateCurve.js formula on hand-computed points", () => {
    // expo 0: 0.5*70 + 600 * (0.5 * 0.5) = 35 + 150
    expect(actualRateDegS(0.5, 70, 670, 0)).toBeCloseTo(185, 6);
    // expo 1: 0.5*70 + 600 * (0.5 * 0.5^5) = 35 + 9.375
    expect(actualRateDegS(0.5, 70, 670, 1)).toBeCloseTo(44.375, 6);
  });

  it("is monotonic on [0,1] when center < max", () => {
    let prev = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const v = actualRateDegS(i / 100, 170, 850, 0.55);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("stickForDegS", () => {
  it("round-trips with actualRateDegS", () => {
    for (const s of [0.05, 0.2, 0.45, 0.7, 0.95]) {
      const degS = actualRateDegS(s, 170, 850, 0.55);
      expect(stickForDegS(degS, 170, 850, 0.55)).toBeCloseTo(s, 2);
    }
  });

  it("clamps outside the curve range", () => {
    expect(stickForDegS(0, 170, 850, 0.55)).toBe(0);
    expect(stickForDegS(9999, 170, 850, 0.55)).toBe(1);
  });
});

describe("rateCurvePoints", () => {
  it("spans 0..100% stick and ends at max", () => {
    const pts = rateCurvePoints(70, 670, 0.5, 50);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[50]![0]).toBe(100);
    expect(pts[50]![1]).toBe(670);
  });
});

describe("zoneStickTravel", () => {
  it("sums to 1", () => {
    const z = zoneStickTravel(170, 850, 0.55);
    expect(z.precision + z.normal + z.deadspace + z.trick).toBeCloseTo(1, 9);
  });

  it("grows the precision zone when center sensitivity drops", () => {
    const soft = zoneStickTravel(70, 670, 0.5);
    const stiff = zoneStickTravel(250, 670, 0.5);
    expect(soft.precision).toBeGreaterThan(stiff.precision);
  });

  it("has no trick zone when max rate is below 600", () => {
    const z = zoneStickTravel(200, 500, 0.5);
    expect(z.trick).toBe(0);
    expect(z.precision + z.normal + z.deadspace).toBeCloseTo(1, 9);
  });
});

describe("bendRegionDegS", () => {
  it("finds the elbow on a high-expo curve", () => {
    const bend = bendRegionDegS(70, 670, 0.8);
    expect(bend).not.toBeNull();
    expect(bend![0]).toBeLessThan(bend![1]);
    expect(bend![1]).toBeLessThanOrEqual(670);
  });

  it("returns null when max <= center", () => {
    expect(bendRegionDegS(670, 670, 0.5)).toBeNull();
  });

  it("returns null on a flat high-center curve (no steep region)", () => {
    expect(bendRegionDegS(600, 670, 0)).toBeNull();
  });
});

// ---- usage extraction ----

describe("computeRatesUsage", () => {
  it("bins a constant setpoint into the right histogram bin and zone", () => {
    const usage = computeRatesUsage(constLog(100))!;
    const roll = usage.axes[0]!;
    const total = roll.histogram.reduce((a, b) => a + b, 0);
    expect(total).toBe(1000);
    expect(roll.histogram[4]).toBe(1000); // 100 deg/s → bin 4 (100-125)
    expect(roll.zones.normal).toBe(1);
    expect(roll.zones.precision).toBe(0);
    expect(roll.p50).toBe(112.5); // bin midpoint
    expect(roll.maxDegS).toBe(100);
    expect(usage.airborneShare).toBe(1);
  });

  it("excludes idle frames (throttle low, no stick input)", () => {
    const log = makeLog({
      setpoint: [Array(1000).fill(0), Array(1000).fill(0), Array(1000).fill(0)],
      throttle: Array(1000).fill(1000),
    });
    const usage = computeRatesUsage(log)!;
    expect(usage.airborneShare).toBe(0);
    expect(usage.axes[0]!.histogram.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("counts frames with stick movement even at idle throttle", () => {
    const log = makeLog({
      setpoint: [Array(500).fill(30), Array(500).fill(0), Array(500).fill(0)],
      throttle: Array(500).fill(1000),
    });
    const usage = computeRatesUsage(log)!;
    expect(usage.airborneShare).toBe(1);
  });

  it("measures saturation against the logged max rate", () => {
    const usage = computeRatesUsage(constLog(650, 1000, { rates: "67,67,67", rc_rates: "7,7,7", rc_expo: "50,50,50" }))!;
    expect(usage.axes[0]!.saturationPercent).toBe(100); // 650 >= 0.9*670
  });

  it("computes achieved rate and high-deflection tracking from gyro", () => {
    const log = makeLog({
      setpoint: [Array(1000).fill(700), Array(1000).fill(0), Array(1000).fill(0)],
      gyro: [Array(1000).fill(630), Array(1000).fill(0), Array(1000).fill(0)],
      throttle: Array(1000).fill(1500),
      headers: { rates: "70,70,70", rc_rates: "7,7,7", rc_expo: "50,50,50" },
    });
    const roll = computeRatesUsage(log)!.axes[0]!;
    expect(roll.highDeflectionTracking).toBeCloseTo(0.9, 6);
    expect(roll.achievedP99DegS).toBe(637.5); // bin 25 midpoint
  });

  it("returns null tracking when too few high-deflection frames", () => {
    const log = constLog(100); // below 50% of default max 670
    const usage = computeRatesUsage({ ...log, channels: { ...log.channels } })!;
    expect(usage.axes[0]!.highDeflectionTracking).toBeNull();
  });

  it("returns null when setpoint channels are missing", () => {
    const log = makeLog({ setpoint: [[], [], []] });
    log.channels = {};
    expect(computeRatesUsage(log)).toBeNull();
  });
});

describe("zoneShares / shareInRange", () => {
  it("splits counts across the four zones", () => {
    // bins: 0-25 (precision), 100-125 (normal), 300-325 (deadspace), 600-625 (trick)
    const hist = new Array(49).fill(0);
    hist[0] = 10;
    hist[4] = 40;
    hist[12] = 30;
    hist[24] = 20;
    const z = zoneShares(hist);
    expect(z).toEqual({ precision: 0.1, normal: 0.4, deadspace: 0.3, trick: 0.2 });
  });

  it("computes share within a deg/s range by bin midpoint", () => {
    const hist = new Array(49).fill(0);
    hist[4] = 50; // midpoint 112.5
    hist[12] = 50; // midpoint 312.5
    expect(shareInRange(hist, 50, 300)).toBe(0.5);
  });
});

describe("parseLoggedRates", () => {
  it("parses BF 4.3+ per-axis triples", () => {
    const r = parseLoggedRates({
      rc_rates: "7,8,9",
      rc_expo: "50,55,60",
      rates: "67,70,75",
      rate_limits: "1998,1998,1998",
    })!;
    expect(r.roll).toEqual({ center: 70, max: 670, expo: 0.5 });
    expect(r.pitch).toEqual({ center: 80, max: 700, expo: 0.55 });
    expect(r.yaw).toEqual({ center: 90, max: 750, expo: 0.6 });
    expect(r.rateLimits).toEqual([1998, 1998, 1998]);
    expect(r.legacyType).toBe(false);
  });

  it("flags a non-ACTUAL rates_type", () => {
    expect(parseLoggedRates({ rc_rates: "7,7,7", rates_type: "0" })!.legacyType).toBe(true);
    expect(parseLoggedRates({ rc_rates: "7,7,7", rates_type: "3" })!.legacyType).toBe(false);
  });

  it("falls back to legacy single-value headers", () => {
    const r = parseLoggedRates({ rcRate: "11", rcExpo: "65", rcYawExpo: "60" })!;
    expect(r.roll.center).toBe(110);
    expect(r.roll.expo).toBe(0.65);
    expect(r.yaw.expo).toBe(0.6);
    expect(r.roll.max).toBe(670); // default fill
  });

  it("returns null when no rate headers exist", () => {
    expect(parseLoggedRates({})).toBeNull();
  });
});

// ---- recommendation engine ----

describe("ratesSizeGroup", () => {
  it("maps size classes", () => {
    expect(ratesSizeGroup("65mm")).toBe("whoop");
    expect(ratesSizeGroup("75mm")).toBe("whoop");
    expect(ratesSizeGroup("2.5in")).toBe("micro");
    expect(ratesSizeGroup("3.5in")).toBe("micro");
    expect(ratesSizeGroup("5in")).toBe("full");
    expect(ratesSizeGroup("unknown")).toBe("full");
  });
});

describe("recommendRates", () => {
  it("returns the pure baseline when there is no log data", () => {
    const rec = recommendRates(null, "freestyle", "65mm");
    const roll = rec.axes.find((a) => a.axis === "roll")!;
    expect(roll.center).toBe(220);
    expect(roll.max).toBe(1000);
    expect(roll.expo).toBe(0.55);
    // yaw derived from roll: +20 center, 0.75x max, -0.10 expo
    const yaw = rec.axes.find((a) => a.axis === "yaw")!;
    expect(yaw.center).toBe(240);
    expect(yaw.max).toBe(750);
    expect(yaw.expo).toBe(0.45);
    expect(rec.warnings.some((w) => w.includes("No log data"))).toBe(true);
  });

  it("maps recommendations to MSP ints", () => {
    const rec = recommendRates(null, "freestyle", "65mm");
    expect(rec.settings.rates).toEqual({
      rcRate: 22,
      rcExpo: 55,
      rollRate: 100,
      rcRatePitch: 22,
      rcExpoPitch: 55,
      pitchRate: 100,
      rcRateYaw: 24,
      rcExpoYaw: 45,
      yawRate: 75,
    });
  });

  it("clamps extreme measured usage to 1.2x the baseline max", () => {
    const usage = makeUsage({ roll: { p99: 2000, saturationPercent: 0 } });
    const rec = recommendRates(usage, "freestyle", "5in");
    expect(rec.axes.find((a) => a.axis === "roll")!.max).toBe(1020); // 1.2 * 850
  });

  it("raises max to the upper clamp when the pilot saturates the cap", () => {
    const usage = makeUsage({ roll: { p99: 700, saturationPercent: 12 } });
    const rec = recommendRates(usage, "freestyle", "5in");
    const roll = rec.axes.find((a) => a.axis === "roll")!;
    expect(roll.max).toBe(1020);
    expect(roll.rationale.some((r) => r.includes("rate cap"))).toBe(true);
  });

  it("lowers max (within bounds) when the pilot rarely uses the trick range", () => {
    const usage = makeUsage({ roll: { p99: 300, saturationPercent: 0 } });
    const rec = recommendRates(usage, "freestyle", "5in");
    const roll = rec.axes.find((a) => a.axis === "roll")!;
    expect(roll.max).toBe(680); // 0.8 * 850 floor
    expect(roll.rationale.some((r) => r.includes("rarely exceed"))).toBe(true);
  });

  it("clamps max to the physical cap when tracking is poor", () => {
    const usage = makeUsage({
      roll: { p99: 700, saturationPercent: 0, highDeflectionTracking: 0.8, achievedP99DegS: 500 },
    });
    const rec = recommendRates(usage, "freestyle", "5in");
    const roll = rec.axes.find((a) => a.axis === "roll")!;
    expect(roll.max).toBe(530); // round10(500 * 1.05)
    expect(rec.warnings.some((w) => w.includes("physically reaches"))).toBe(true);
  });

  it("nudges center down for slow precision-heavy flying", () => {
    const usage = makeUsage({ roll: { zones: { precision: 0.2, normal: 0.7, deadspace: 0.05, trick: 0.05 }, p50: 80 } });
    const rec = recommendRates(usage, "freestyle", "5in");
    expect(rec.axes.find((a) => a.axis === "roll")!.center).toBe(150); // 170 - 20
  });

  it("adds expo when the dead zone dominates", () => {
    const usage = makeUsage({ roll: { zones: { precision: 0.1, normal: 0.4, deadspace: 0.4, trick: 0.1 } } });
    const rec = recommendRates(usage, "freestyle", "5in");
    expect(rec.axes.find((a) => a.axis === "roll")!.expo).toBe(0.6); // 0.55 + 0.05
  });

  it("warns about logged rate limits below the recommendation", () => {
    const usage = makeUsage({}, {
      loggedRates: {
        roll: { center: 70, max: 670, expo: 0.5 },
        pitch: { center: 70, max: 670, expo: 0.5 },
        yaw: { center: 70, max: 670, expo: 0.5 },
        rateLimits: [500, 1998, 1998],
        legacyType: false,
      },
    });
    const rec = recommendRates(usage, "freestyle", "5in");
    expect(rec.warnings.some((w) => w.includes("rate limit") && w.includes("Roll"))).toBe(true);
  });

  it("warns on legacy rates_type and near-default freestyle rates", () => {
    const defaults = { center: 70, max: 670, expo: 0.5 };
    const usage = makeUsage({}, {
      loggedRates: { roll: defaults, pitch: defaults, yaw: defaults, rateLimits: null, legacyType: true },
    });
    const rec = recommendRates(usage, "freestyle", "5in");
    expect(rec.warnings.some((w) => w.includes("isn't ACTUAL"))).toBe(true);
    expect(rec.warnings.some((w) => w.includes("near-Betaflight-default"))).toBe(true);
  });

  it("falls back to baseline when airborne time is negligible", () => {
    const usage = makeUsage({ roll: { p99: 2000 } }, { airborneShare: 0.01 });
    const rec = recommendRates(usage, "freestyle", "5in");
    expect(rec.axes.find((a) => a.axis === "roll")!.max).toBe(850); // untouched baseline
    expect(rec.warnings.some((w) => w.includes("airborne"))).toBe(true);
  });

  it("generates a CLI block that round-trips through parseCliDump", () => {
    const rec = recommendRates(null, "racing", "2.5in");
    expect(rec.cliBlock).toContain("set rates_type = ACTUAL");
    const parsed = parseCliDump(rec.cliBlock);
    expect(parsed.settings.rates).toEqual(rec.settings.rates);
  });
});

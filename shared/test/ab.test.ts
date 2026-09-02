import { describe, expect, it } from "vitest";
import { abFingerprintFromHeaders, matchAbTest, rateAbVariant } from "../src/tuning/ab";
import { applyVariant } from "../src/tuning/variants";
import type { AbTest } from "../src/types/entities";
import type { ProfileSettings } from "../src/types/fc";

const base: ProfileSettings = {
  filters: {
    gyroLowpass2Hz: 500,
    dynNotchCount: 1,
    dtermLowpassType: 0,
    dtermLowpassDynMinHz: 70,
    dtermLowpassDynMaxHz: 150,
    dtermLowpass2Hz: 120,
    dtermLowpass2Type: 0,
    yawLowpassHz: 100,
    dynLpfCurveExpo: 5,
  },
  rates: { ratesType: 3, rcRate: 19, rcRatePitch: 19, rcRateYaw: 20, rcExpo: 20, rcExpoPitch: 20, rcExpoYaw: 15, rollRate: 90, pitchRate: 90, yawRate: 67, thrMid: 50, thrExpo: 45 },
};

function pidTest(): AbTest {
  const crisp = applyVariant(base, "crisp", "profile");
  const smooth = applyVariant(base, "smooth", "profile");
  return {
    id: 7,
    droneId: 11,
    kind: "pid",
    createdAt: 1000,
    notes: null,
    variants: [
      { side: "A", label: "A · Crisp", slot: 0, settings: crisp },
      { side: "B", label: "B · Smooth", slot: 1, settings: smooth },
    ],
  };
}

/** Headers Betaflight 4.5 writes for a given D-term chain / rate curve. */
function headersFor(s: ProfileSettings): Record<string, string> {
  const f = s.filters!;
  const r = s.rates!;
  return {
    dterm_lpf1_type: String(f.dtermLowpassType ?? 0),
    dterm_lpf1_static_hz: String(f.dtermLowpassHz ?? 0),
    dterm_lpf1_dyn_hz: `${f.dtermLowpassDynMinHz},${f.dtermLowpassDynMaxHz}`,
    dterm_lpf2_type: String(f.dtermLowpass2Type ?? 0),
    dterm_lpf2_static_hz: String(f.dtermLowpass2Hz),
    yaw_lowpass_hz: String(f.yawLowpassHz),
    dterm_lpf1_dyn_expo: String(f.dynLpfCurveExpo),
    rc_rates: `${r.rcRate},${r.rcRatePitch},${r.rcRateYaw}`,
    rc_expo: `${r.rcExpo},${r.rcExpoPitch},${r.rcExpoYaw}`,
    rates: `${r.rollRate},${r.pitchRate},${r.yawRate}`,
    rates_type: String(r.ratesType),
    thr_mid: String(r.thrMid),
    thr_expo: String(r.thrExpo),
  };
}

describe("rateAbVariant", () => {
  it("raises centre sensitivity by 30 % on ACTUAL rates and keeps max/expo", () => {
    const b = rateAbVariant(base.rates)!;
    expect(b.rcRate).toBe(25); // 19 × 1.3 = 24.7
    expect(b.rcRateYaw).toBe(26);
    expect(b.rollRate).toBe(90);
    expect(b.rcExpo).toBe(20);
  });

  it("caps the centre at 90 % of the max rate and refuses non-ACTUAL rates", () => {
    const b = rateAbVariant({ ratesType: 3, rcRate: 80, rollRate: 90 })!;
    expect(b.rcRate).toBe(81);
    expect(rateAbVariant({ ratesType: 0, rcRate: 100, rollRate: 70 })).toBeNull();
    expect(rateAbVariant(undefined)).toBeNull();
  });
});

describe("matchAbTest", () => {
  it("labels a session by the D-term chain it was flown with", () => {
    const test = pidTest();
    const flownA = headersFor(test.variants[0]!.settings);
    const flownB = headersFor(test.variants[1]!.settings);
    expect(matchAbTest(flownA, [test])?.label).toBe("A · Crisp");
    expect(matchAbTest(flownB, [test])?.side).toBe("B");
    // A flight on the untouched template matches neither variant.
    expect(matchAbTest(headersFor(base), [test])).toBeNull();
  });

  it("labels rate-profile sessions and prefers the newest test", () => {
    const b = rateAbVariant(base.rates)!;
    const rateTest: AbTest = {
      id: 8,
      droneId: 11,
      kind: "rate",
      createdAt: 2000,
      notes: null,
      variants: [
        { side: "A", label: "A · Rates", slot: 0, settings: { rates: base.rates } },
        { side: "B", label: "B · Centre +30 %", slot: 1, settings: { rates: b } },
      ],
    };
    const flownB = headersFor({ ...base, rates: b });
    expect(matchAbTest(flownB, [pidTest(), rateTest])?.label).toBe("B · Centre +30 %");
    expect(matchAbTest(headersFor(base), [rateTest])?.side).toBe("A");
  });

  it("stays silent when the header cannot tell the variants apart", () => {
    const test = pidTest();
    const headers = headersFor(test.variants[0]!.settings);
    // No D-term headers at all (old firmware) → nothing to compare.
    const stripped = Object.fromEntries(Object.entries(headers).filter(([k]) => !k.startsWith("dterm") && k !== "yaw_lowpass_hz"));
    expect(matchAbTest(stripped, [test])).toBeNull();
    expect(abFingerprintFromHeaders(stripped).filters).toEqual({});
  });
});

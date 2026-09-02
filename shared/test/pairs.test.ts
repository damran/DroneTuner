import { describe, expect, it } from "vitest";
import { AB_PAIRS, abPairVariants, settingsDiffKeys } from "../src/tuning/pairs";
import { matchAbTest } from "../src/tuning/ab";
import { sequenceStatus, TUNING_SEQUENCE } from "../src/tuning/sequence";
import type { AbTest } from "../src/types/entities";
import type { ProfileSettings } from "../src/types/fc";

const draft: ProfileSettings = {
  pids: { roll: { p: 61, i: 110, d: 41 }, pitch: { p: 67, i: 121, d: 51 }, yaw: { p: 61, i: 110, d: 0 } },
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
  advanced: { feedforwardRoll: 0, feedforwardPitch: 0, feedforwardYaw: 0, dMinRoll: 24, dMinPitch: 30, dMaxGain: 45, idleMinRpm: 25, tpaRate: 40 },
  rates: { ratesType: 3, rcRate: 19, rollRate: 90 },
};

/** Headers Betaflight 4.5 writes for a PID profile. */
function headersFor(s: ProfileSettings): Record<string, string> {
  const f = s.filters!;
  const p = s.pids!;
  const a = s.advanced!;
  return {
    dterm_lpf1_type: String(f.dtermLowpassType ?? 0),
    dterm_lpf1_dyn_hz: `${f.dtermLowpassDynMinHz},${f.dtermLowpassDynMaxHz}`,
    dterm_lpf2_type: String(f.dtermLowpass2Type ?? 0),
    dterm_lpf2_static_hz: String(f.dtermLowpass2Hz),
    yaw_lowpass_hz: String(f.yawLowpassHz),
    dterm_lpf1_dyn_expo: String(f.dynLpfCurveExpo),
    rollPID: `${p.roll!.p},${p.roll!.i},${p.roll!.d}`,
    pitchPID: `${p.pitch!.p},${p.pitch!.i},${p.pitch!.d}`,
    yawPID: `${p.yaw!.p},${p.yaw!.i},${p.yaw!.d}`,
    ff_weight: `${a.feedforwardRoll},${a.feedforwardPitch},${a.feedforwardYaw}`,
    d_min: `${a.dMinRoll},${a.dMinPitch},0`,
    d_max_gain: String(a.dMaxGain),
    dyn_idle_min_rpm: String(a.idleMinRpm),
  };
}

describe("A/B pairs", () => {
  it("every pair changes only PID-profile keys and leaves the rest of the draft alone", () => {
    for (const def of AB_PAIRS) {
      const pair = abPairVariants(draft, def.id);
      expect(pair, def.id).not.toBeNull();
      const [a, b] = pair!;
      expect(a.label.startsWith("A ·")).toBe(true);
      expect(b.label.startsWith("B ·")).toBe(true);
      const diff = settingsDiffKeys(a.settings, b.settings);
      expect(diff.length, def.id).toBeGreaterThan(0);
      // nothing outside the PID profile: no rates, no master filters
      expect(diff.some((k) => k.startsWith("rates.")), def.id).toBe(false);
      expect(diff.some((k) => k === "filters.gyroLowpass2Hz" || k === "filters.dynNotchCount"), def.id).toBe(false);
    }
  });

  it("master scales P, I, D, D-min and FF together; tracking only P and I", () => {
    const [, master] = abPairVariants(draft, "pid-master")!;
    expect(master.settings.pids?.roll).toEqual({ p: 70, i: 127, d: 47 }); // × 1.15, rounded
    expect(master.settings.advanced?.dMinPitch).toBe(35);
    expect(master.settings.pids?.yaw?.d).toBe(0);
    const [, tracking] = abPairVariants(draft, "pid-tracking")!;
    expect(tracking.settings.pids?.pitch).toEqual({ p: 74, i: 133, d: 51 });
  });

  it("feedforward pair starts from 50/50/45 on an FF-0 tune and scales an existing FF", () => {
    const [, ff] = abPairVariants(draft, "pid-ff")!;
    expect(ff.settings.advanced?.feedforwardRoll).toBe(50);
    expect(ff.settings.advanced?.feedforwardYaw).toBe(45);
    const withFf = { ...draft, advanced: { ...draft.advanced, feedforwardRoll: 60, feedforwardPitch: 60, feedforwardYaw: 50 } };
    expect(abPairVariants(withFf, "pid-ff")![1].settings.advanced?.feedforwardRoll).toBe(90);
  });

  it("dynamic idle goes to 6000 rpm first, then +2000 per step; AOS swaps the D-term chain", () => {
    expect(abPairVariants(draft, "pid-idle")![1].settings.advanced?.idleMinRpm).toBe(60);
    const high = { ...draft, advanced: { ...draft.advanced, idleMinRpm: 60 } };
    expect(abPairVariants(high, "pid-idle")![1].settings.advanced?.idleMinRpm).toBe(80);
    expect(abPairVariants({ ...draft, advanced: {} }, "pid-idle")).toBeNull();
    const [, aos] = abPairVariants(draft, "dterm-aos")!;
    expect(aos.settings.filters).toMatchObject({ dtermLowpassType: 1, dtermLowpassDynMinHz: 80, dtermLowpassDynMaxHz: 110, dynLpfCurveExpo: 7, dtermLowpass2Hz: 0 });
  });

  it("the Log Lab tells the PID pairs apart from the PID / FF / idle headers", () => {
    for (const id of ["pid-master", "pid-tracking", "pid-ff", "pid-idle"] as const) {
      const [a, b] = abPairVariants(draft, id)!;
      const test: AbTest = {
        id: 1,
        droneId: 11,
        kind: "pid",
        createdAt: 1,
        notes: null,
        pairId: id,
        variants: [
          { side: "A", label: a.label, slot: 0, settings: a.settings },
          { side: "B", label: b.label, slot: 1, settings: b.settings },
        ],
      };
      expect(matchAbTest(headersFor(a.settings), [test])?.side, id).toBe("A");
      expect(matchAbTest(headersFor(b.settings), [test])?.label, id).toBe(b.label);
    }
  });
});

describe("tuning sequence", () => {
  it("infers flown steps from analyses and recorded pairs, ticks win, next = first todo", () => {
    const tests: AbTest[] = [
      { id: 1, droneId: 11, kind: "pid", createdAt: 1, notes: null, pairId: "dterm-crisp", variants: [] },
      { id: 2, droneId: 11, kind: "rate", createdAt: 2, notes: null, variants: [] },
    ];
    const status = sequenceStatus({ hasAnalysis: true, abTests: tests, progress: [{ step: "pd", done: true, updatedAt: 1, notes: null }] });
    const by = Object.fromEntries(status.steps.map((s) => [s.id, s.state]));
    expect(by.log).toBe("flown");
    expect(by.filters).toBe("flown");
    expect(by.master).toBe("todo");
    expect(by.pd).toBe("done");
    expect(by.rates).toBe("flown");
    expect(status.nextId).toBe("master");
    expect(TUNING_SEQUENCE.map((s) => s.id)).toEqual(["log", "filters", "master", "pd", "iterm", "ff", "dmax", "rates"]);
  });
});

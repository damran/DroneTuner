import { describe, expect, it } from "vitest";
import { cliOnlyKeys, isMspWritable, partitionCliOnly, settingsToCli } from "../src/tuning/cli";

describe("settingsToCli", () => {
  it("maps all sections to BF 4.5 CLI names", () => {
    const lines = settingsToCli({
      pids: { roll: { p: 50, d: 33 }, yaw: { i: 85 } },
      filters: {
        dynNotchCount: 1,
        dtermLowpassType: 1,
        gyroLowpass2Hz: 1000,
        gyroLowpassDynMinHz: 300,
        dynLpfCurveExpo: 7,
      },
      rates: { rcRate: 7, rollRate: 67 },
      advanced: { feedforwardRoll: 130, itermRelax: 2, tpaMode: 1, tpaRate: 60 },
    });
    const text = lines.join("\n");
    expect(text).toContain("set p_roll = 50");
    expect(text).toContain("set d_roll = 33");
    expect(text).toContain("set i_yaw = 85");
    expect(text).toContain("set dyn_notch_count = 1");
    expect(text).toContain("set dterm_lpf1_type = BIQUAD");
    expect(text).toContain("set gyro_lpf2_static_hz = 1000");
    // BF 4.5 canonical names (4.5 renamed these settings)
    expect(text).toContain("set gyro_lpf1_dyn_min_hz = 300");
    expect(text).toContain("set dterm_lpf1_dyn_expo = 7");
    expect(text).toContain("set f_roll = 130");
    expect(text).toContain("set roll_rc_rate = 7");
    expect(text).toContain("set roll_srate = 67");
    expect(text).toContain("set iterm_relax = RPY");
    expect(text).toContain("set tpa_mode = D"); // tpaMode 1 = D-only (BF lookupTableTpaMode: PD=0, D=1)
    expect(text).toContain("set tpa_rate = 60");
  });

  it("combines RPM filter weights into one CLI array", () => {
    const lines = settingsToCli({ filters: { rpmFilterWeight1: 100, rpmFilterWeight2: 0, rpmFilterWeight3: 80 } });
    expect(lines).toContain("set rpm_filter_weights = 100,0,80");
    expect(lines.find((l) => l.includes("rpmFilterWeight"))).toBeUndefined();
  });

  it("emits rates_type as its enum name", () => {
    const lines = settingsToCli({ rates: { ratesType: 3, rcRate: 19, rollRate: 67 } });
    expect(lines).toContain("set rates_type = ACTUAL");
    expect(lines).toContain("set roll_rc_rate = 19");
  });

  it("emits nothing for empty settings", () => {
    expect(settingsToCli({})).toEqual([]);
  });
});

describe("MSP writability", () => {
  it("flags CLI-only keys", () => {
    expect(isMspWritable({ filters: { dynNotchCount: 1 } })).toBe(true);
    expect(isMspWritable({ filters: { rpmFilterQ: 750 } })).toBe(false);
    expect(cliOnlyKeys({ filters: { rpmFilterQ: 750, dynNotchCount: 1 } })).toEqual(["rpmFilterQ"]);
  });

  it("partitionCliOnly strips CLI-only keys at the apply boundary", () => {
    const { msp, stripped } = partitionCliOnly({
      filters: { dynNotchCount: 1, rpmFilterQ: 750, rpmFilterWeight2: 0 },
      advanced: { feedforwardBoost: 15 },
      pids: { roll: { p: 50 } },
    });
    expect(stripped.sort()).toEqual(["rpmFilterQ", "rpmFilterWeight2"]);
    expect(msp.filters).toEqual({ dynNotchCount: 1 });
    expect(msp.advanced).toEqual({ feedforwardBoost: 15 });
    expect(msp.pids).toEqual({ roll: { p: 50 } });
  });
});

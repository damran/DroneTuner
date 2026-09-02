import { describe, expect, it } from "vitest";
import { extractText, looksLikeCliDump, parseCliDump } from "../src/vendor/cli-dump";

const SAMPLE_DUMP = `
# Betaflight / STM32F411 (S411) 4.5.0 Jan  1 2025 / 12:00:00 (abc1234) MSP API: 1.46
# board_name BETAFPVF411
# manufacturer_id BEFH

set name = Meteor65
set p_roll = 45
set i_roll = 80
set d_roll = 40
set p_pitch = 47
set i_pitch = 84
set d_pitch = 46
set p_yaw = 45
set i_yaw = 80
set d_yaw = 0
set d_min_roll = 30
set d_min_pitch = 34
set gyro_lowpass_hz = 250
set gyro_lowpass_type = PT1
set dterm_lowpass_hz = 150
set dterm_lowpass_type = PT2
set dyn_notch_count = 2
set dyn_notch_min_hz = 150
set dyn_notch_max_hz = 600
set dyn_notch_q = 300
set rc_rate = 1.10
set rc_expo = 0.70
set roll_srate = 0.67
set pitch_srate = 0.67
set yaw_srate = 0.65
set thr_mid = 0.50
set thr_expo = 0.20
set rates_type = ACTUAL
set feedforward_roll = 95
set feedforward_averaging = 2_POINT
set feedforward_transition = 30
set iterm_relax = RPY
set iterm_relax_cutoff = 15
set tpa_mode = D
set tpa_rate = 65
set tpa_breakpoint = 1350
set motor_pwm_protocol = DSHOT300
set osd_units = METRIC
`;

describe("parseCliDump", () => {
  it("parses pids, filters, rates and advanced settings", () => {
    const { settings } = parseCliDump(SAMPLE_DUMP);
    expect(settings.pids?.roll).toEqual({ p: 45, i: 80, d: 40 });
    expect(settings.pids?.pitch).toEqual({ p: 47, i: 84, d: 46 });
    expect(settings.pids?.yaw).toEqual({ p: 45, i: 80, d: 0 });
    expect(settings.filters?.gyroLowpassHz).toBe(250);
    expect(settings.filters?.dtermLowpassHz).toBe(150);
    expect(settings.filters?.dynNotchCount).toBe(2);
    expect(settings.advanced?.dMinRoll).toBe(30);
    expect(settings.advanced?.tpaRate).toBe(65);
    expect(settings.advanced?.tpaBreakpoint).toBe(1350);
  });

  it("scales CLI float rates to MSP integer units", () => {
    const { settings } = parseCliDump(SAMPLE_DUMP);
    expect(settings.rates?.rcRate).toBe(110);
    expect(settings.rates?.rcExpo).toBe(70);
    expect(settings.rates?.rollRate).toBe(67);
    expect(settings.rates?.thrMid).toBe(50);
  });

  it("parses rates_type as its enum index", () => {
    const { settings } = parseCliDump(SAMPLE_DUMP);
    expect(settings.rates?.ratesType).toBe(3); // ACTUAL
  });

  it("maps CLI enum names to indexes", () => {
    const { settings } = parseCliDump(SAMPLE_DUMP);
    expect(settings.filters?.gyroLowpassType).toBe(0); // PT1
    expect(settings.filters?.dtermLowpassType).toBe(2); // PT2
    expect(settings.advanced?.itermRelax).toBe(2); // RPY
    expect(settings.advanced?.feedforwardAveraging).toBe(1); // 2_POINT
    expect(settings.advanced?.tpaMode).toBe(1); // D (BF lookupTableTpaMode: PD=0, D=1)
  });

  it("extracts metadata from the dump header", () => {
    const { meta } = parseCliDump(SAMPLE_DUMP);
    expect(meta.craftName).toBe("Meteor65");
    expect(meta.boardName).toBe("BETAFPVF411");
    expect(meta.manufacturerId).toBe("BEFH");
    expect(meta.fcVersion).toBe("4.5.0");
  });

  it("reports unmanaged keys as ignored", () => {
    const { ignored, recognized } = parseCliDump(SAMPLE_DUMP);
    expect(ignored).toContain("motor_pwm_protocol");
    expect(ignored).toContain("osd_units");
    expect(recognized).toContain("p_roll");
    expect(recognized).toContain("name");
  });

  it("parses dumps embedded in HTML pages", () => {
    const html = `<div class="product"><p>set p_roll = 45<br>set rc_rate = 1.20</p></div>`;
    const { settings } = parseCliDump(html);
    expect(settings.pids?.roll?.p).toBe(45);
    expect(settings.rates?.rcRate).toBe(120);
  });

  it("looksLikeCliDump detects set lines", () => {
    expect(looksLikeCliDump(SAMPLE_DUMP)).toBe(true);
    expect(looksLikeCliDump("<html><body>no dump here</body></html>")).toBe(false);
  });

  it("extractText strips tags and entities", () => {
    expect(extractText("<b>a</b> &amp; b")).toBe("a & b");
  });

  it("uses the selected PID profile and rate profile of a multi-profile dump", () => {
    const dump = [
      "# Betaflight / STM32G47X (SG47) 4.5.0 May 16 2024 / 01:17:04 (c155f5830) MSP API: 1.46",
      "set dyn_notch_count = 2",
      "profile 0",
      "set p_pitch = 71",
      "set d_pitch = 60",
      "profile 1",
      "set p_pitch = 67",
      "set d_pitch = 51",
      "profile 2",
      "set p_pitch = 47",
      "profile 3",
      "set p_pitch = 47",
      "# restore original profile selection",
      "profile 1",
      "rateprofile 0",
      "set roll_srate = 90",
      "rateprofile 1",
      "set roll_srate = 67",
      "rateprofile 0",
      "save",
    ].join("\n");
    const r = parseCliDump(dump);
    expect(r.meta.selectedProfile).toBe(1);
    expect(r.meta.selectedRateProfile).toBe(0);
    expect(r.settings.pids?.pitch?.p).toBe(67);
    expect(r.settings.pids?.pitch?.d).toBe(51);
    expect(r.settings.rates?.rollRate).toBe(90);
    expect(r.settings.filters?.dynNotchCount).toBe(2);

    // A diff without the trailing selection falls back to the first profile listed.
    const noRestore = ["profile 0", "set p_pitch = 71", "profile 1", "set p_pitch = 67"].join("\n");
    expect(parseCliDump(noRestore).settings.pids?.pitch?.p).toBe(67); // last "profile N" line selects 1
    const single = ["profile 2", "set p_pitch = 47"].join("\n");
    expect(parseCliDump(single).meta.selectedProfile).toBe(2);
  });

  it("never substitutes another profile when the selected one has no overrides (all-default profile)", () => {
    // A `diff` omits the section body of a profile left at defaults. The FC
    // flies profile 1's defaults here, so profile 0's PIDs must not leak in.
    const dump = [
      "profile 0",
      "set p_pitch = 71",
      "set d_pitch = 60",
      "profile 1",
      "# restore original profile selection",
      "profile 1",
      "rateprofile 0",
      "set roll_srate = 90",
      "rateprofile 2",
      "save",
    ].join("\n");
    const r = parseCliDump(dump);
    expect(r.meta.selectedProfile).toBe(1);
    expect(r.meta.selectedRateProfile).toBe(2);
    expect(r.settings.pids?.pitch).toBeUndefined();
    expect(r.settings.rates?.rollRate).toBeUndefined();
  });
});

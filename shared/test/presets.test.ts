import { describe, expect, it } from "vitest";
import { presetMeta, resolvePreset } from "../src/vendor/presets";
import { parseCliDump } from "../src/vendor/cli-dump";

const DEFAULTS = "#$ TITLE: defaults\nset dyn_notch_count = 3\nset p_roll = 45\n";
const PRESET = [
  "#$ TITLE: Whoop tune",
  "#$ FIRMWARE_VERSION: 4.5",
  "#$ INCLUDE: presets/4.5/tune/defaults.txt",
  "set p_roll = 60",
  "#$ OPTION_GROUP BEGIN:Motor protocol",
  "#$ OPTION BEGIN (CHECKED): Dshot300",
  "set motor_pwm_protocol = DSHOT300",
  "#$ OPTION END",
  "#$ OPTION BEGIN (UNCHECKED): Dshot600",
  "set motor_pwm_protocol = DSHOT600",
  "set dyn_notch_count = 1",
  "#$ OPTION END",
  "#$ OPTION_GROUP END",
].join("\n");

describe("firmware presets", () => {
  it("reads metadata", () => {
    expect(presetMeta(PRESET)).toMatchObject({ TITLE: "Whoop tune", FIRMWARE_VERSION: "4.5" });
  });

  it("inlines includes, keeps checked options and drops unchecked ones", () => {
    const flat = resolvePreset(PRESET, { includes: { "presets/4.5/tune/defaults.txt": DEFAULTS } });
    expect(flat).toContain("set motor_pwm_protocol = DSHOT300");
    expect(flat).not.toContain("DSHOT600");
    expect(flat).not.toContain("#$");
    // the include comes first, so the preset's own value wins when parsed
    const parsed = parseCliDump(flat);
    expect(parsed.settings.pids?.roll?.p).toBe(60);
    expect(parsed.settings.filters?.dynNotchCount).toBe(3);
  });

  it("notes unresolved includes instead of failing", () => {
    const flat = resolvePreset(PRESET);
    expect(flat).toContain("# include not resolved: presets/4.5/tune/defaults.txt");
  });
});

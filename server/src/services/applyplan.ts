import type { FcConfig, ProfileSettings } from "@dronetuner/shared";
import { diffConfig } from "@dronetuner/shared/tuning";
import type { ApplyPlan } from "@dronetuner/shared";

/** Build an ordered MSP write plan + diff from a target profile vs current FC config. */
export function buildApplyPlan(current: FcConfig, target: ProfileSettings): ApplyPlan {
  const { diff, sections, upToDate } = diffConfig(current, target);
  return { diff, sections, target, upToDate };
}

/** Convert a full decoded FC config into profile-settings shape (for restore diffs). */
export function fcConfigToSettings(cfg: FcConfig): ProfileSettings {
  return {
    pids: { roll: cfg.pids.roll, pitch: cfg.pids.pitch, yaw: cfg.pids.yaw },
    filters: { ...cfg.filters },
    rates: { ...cfg.rates },
    advanced: { ...cfg.advanced },
  };
}

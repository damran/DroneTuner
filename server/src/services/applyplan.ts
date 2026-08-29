import type { FcConfig, ProfileSettings } from "@dronetuner/shared";
import { diffConfig } from "@dronetuner/shared/tuning";
import type { ApplyPlan } from "@dronetuner/shared";

/** Build an ordered MSP write plan + diff from a target profile vs current FC config. */
export function buildApplyPlan(current: FcConfig, target: ProfileSettings): ApplyPlan {
  const { diff, sections, upToDate } = diffConfig(current, target);
  return { diff, sections, target, upToDate };
}

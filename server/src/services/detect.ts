import type { DetectMatch, FcIdentity } from "@dronetuner/shared";

export interface DroneIdentityRow {
  id: number;
  name: string;
  fcTarget: string | null;
  fcBoard: string | null;
  fcCraftName: string | null;
  fcUid: string | null;
}

const eq = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Score how well a stored drone identity matches a connected FC.
 * UID is a hardware-unique certain match; craft name is pilot-set and
 * strong; target/board only prove same-FC-model, so they score lower.
 */
export function scoreDroneIdentity(drone: DroneIdentityRow, identity: FcIdentity): DetectMatch | null {
  let score = 0;
  const matchedOn: string[] = [];

  if (eq(drone.fcUid, identity.uid)) {
    score += 100;
    matchedOn.push("uid");
  }
  if (eq(drone.fcCraftName, identity.craftName)) {
    score += 50;
    matchedOn.push("craftName");
  }
  if (eq(drone.fcTarget, identity.targetName)) {
    score += 30;
    matchedOn.push("target");
  }
  if (eq(drone.fcBoard, identity.boardName) || eq(drone.fcBoard, identity.boardId)) {
    score += 20;
    matchedOn.push("board");
  }

  if (score === 0) return null;
  return { droneId: drone.id, droneName: drone.name, score, matchedOn };
}

/** Rank all fleet drones against a connected FC identity, best first. */
export function detectDrones(drones: DroneIdentityRow[], identity: FcIdentity): DetectMatch[] {
  return drones
    .map((d) => scoreDroneIdentity(d, identity))
    .filter((m): m is DetectMatch => m !== null)
    .sort((a, b) => b.score - a.score);
}

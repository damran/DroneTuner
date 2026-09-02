import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Fingerprint, Link2 } from "lucide-react";
import type { DetectResponse, DroneDetail, FcIdentity } from "@dronetuner/shared";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const MATCH_LABELS: Record<string, string> = {
  uid: "chip UID",
  craftName: "craft name",
  target: "FC target",
  board: "board",
};

function matchSummary(matchedOn: string[]): string {
  return matchedOn.map((m) => MATCH_LABELS[m] ?? m).join(" + ");
}

/**
 * Auto-detect banner shown after MSP connect: matches the FC identity
 * (chip UID, craft name, target, board) against drones already in the
 * fleet and offers to open the match or link the FC to the current drone.
 */
export default function DetectBanner({ droneId, identity }: { droneId: number; identity: FcIdentity }) {
  const qc = useQueryClient();

  const { data: drone } = useQuery({
    queryKey: ["drone", droneId],
    queryFn: () => apiGet<DroneDetail>(`/api/drones/${droneId}`),
  });

  const { data: detection } = useQuery({
    queryKey: ["detect", identity.uid, identity.craftName, identity.targetName, identity.boardName],
    queryFn: () => apiPost<DetectResponse>("/api/detect", { identity }),
  });

  const link = useMutation({
    mutationFn: () =>
      apiPatch(`/api/drones/${droneId}`, {
        fcTarget: identity.targetName,
        fcBoard: identity.boardName ?? identity.boardId,
        fcCraftName: identity.craftName,
        fcUid: identity.uid,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["drone", droneId] });
      void qc.invalidateQueries({ queryKey: ["detect"] });
      void qc.invalidateQueries({ queryKey: ["drones"] });
    },
  });

  if (!detection || !drone) return null;

  const best = detection.matches[0] ?? null;
  const hasStoredIdentity = !!(drone.fcUid || drone.fcCraftName || drone.fcTarget || drone.fcBoard);

  // 1. Best match is the drone we're already looking at.
  if (best && best.droneId === droneId) {
    return (
      <Banner tone="success">
        <Fingerprint className="h-4 w-4 shrink-0" />
        <span>
          Recognized this flight controller as <strong>{best.droneName}</strong> (matched:{" "}
          {matchSummary(best.matchedOn)}).
        </span>
        {!best.matchedOn.includes("uid") && identity.uid && (
          <Button size="sm" variant="outline" onClick={() => link.mutate()} disabled={link.isPending}>
            <Link2 className="h-3.5 w-3.5" /> Save chip UID for certain detection
          </Button>
        )}
      </Banner>
    );
  }

  // 2. Best match is a different drone in the fleet.
  if (best) {
    return (
      <Banner tone="warning">
        <Fingerprint className="h-4 w-4 shrink-0" />
        <span>
          This flight controller looks like <strong>{best.droneName}</strong> (matched:{" "}
          {matchSummary(best.matchedOn)}).
        </span>
        <Link to={`/drones/${best.droneId}`}>
          <Button size="sm" variant="outline">
            Open {best.droneName}
          </Button>
        </Link>
        <Button size="sm" variant="ghost" onClick={() => link.mutate()} disabled={link.isPending}>
          <Link2 className="h-3.5 w-3.5" /> Link to {drone.name} instead
        </Button>
      </Banner>
    );
  }

  // 3. No match — offer to learn this FC.
  if (!hasStoredIdentity) {
    return (
      <Banner tone="info">
        <Fingerprint className="h-4 w-4 shrink-0" />
        <span>
          New flight controller
          {identity.targetName ? ` (${identity.targetName})` : ""} — link it to{" "}
          <strong>{drone.name}</strong> so it's recognized automatically next time.
        </span>
        <Button size="sm" variant="outline" onClick={() => link.mutate()} disabled={link.isPending}>
          <Link2 className="h-3.5 w-3.5" /> Link to this drone
        </Button>
      </Banner>
    );
  }

  // 4. Stored identity disagrees with the plugged-in FC.
  return (
    <Banner tone="warning">
      <Fingerprint className="h-4 w-4 shrink-0" />
      <span>
        The connected FC doesn't match the identity stored for <strong>{drone.name}</strong> — a different
        board may be installed.
      </span>
      <Button size="sm" variant="ghost" onClick={() => link.mutate()} disabled={link.isPending}>
        <Link2 className="h-3.5 w-3.5" /> Update stored identity
      </Button>
    </Banner>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "success" | "warning" | "info";
  children: React.ReactNode;
}) {
  const colors = {
    success: "border-success/40 bg-success/10",
    warning: "border-warning/40 bg-warning/10",
    info: "border-info/40 bg-info/10",
  }[tone];
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm ${colors}`}>
      {children}
      {tone === "success" && <Badge variant="success">Auto-detected</Badge>}
    </div>
  );
}

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ConfigSection, DiffEntry, FcDump, Profile, ProfileSettings } from "@dronetuner/shared";
import { diffConfig } from "@dronetuner/shared/tuning";
import { apiGet, apiPost } from "@/lib/api";
import { useApplyStore } from "@/lib/apply-store";
import { isSerialSupported, useMspStore } from "@/lib/msp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import DiffView from "./DiffView";

type Step = "connect" | "review" | "apply" | "done";

export default function ApplyFlow() {
  const { open, payload, close } = useApplyStore();
  const msp = useMspStore();
  const [step, setStep] = useState<Step>("connect");
  const [diff, setDiff] = useState<DiffEntry[]>([]);
  const [sections, setSections] = useState<ConfigSection[]>([]);
  const [target, setTarget] = useState<ProfileSettings | null>(null);
  const [snapshot, setSnapshot] = useState<FcDump | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const profileQuery = useQuery({
    queryKey: ["profile", payload?.profileId],
    enabled: open && !!payload?.profileId,
    queryFn: () => apiGet<Profile>(`/api/profiles/${payload!.profileId}`),
  });

  const targetSettings: ProfileSettings | null = useMemo(() => {
    if (!payload) return null;
    if (payload.profileId && profileQuery.data) return profileQuery.data.settings;
    return payload.settings ?? null;
  }, [payload, profileQuery.data]);

  const connected = !!msp.config;

  const reset = () => {
    setStep("connect");
    setDiff([]);
    setSections([]);
    setTarget(null);
    setSnapshot(null);
    setError(null);
  };

  const handleClose = (o: boolean) => {
    if (!o) {
      reset();
      close();
    }
  };

  const review = async () => {
    if (!msp.config || !targetSettings || !payload) return;
    setBusy(true);
    setError(null);
    try {
      const dump = msp.takeSnapshot();
      if (!dump) throw new Error("Could not capture a snapshot");
      setSnapshot(dump);
      // Persist the restore point
      await apiPost("/api/snapshots", { droneId: payload.droneId, dump, reason: "apply-flow" });
      const result = diffConfig(msp.config, targetSettings);
      setDiff(result.diff);
      setSections(result.sections);
      setTarget(targetSettings);
      setStep(result.upToDate ? "done" : "review");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    setStep("apply");
    try {
      await msp.applySections(sections, target);
      await msp.saveEeprom();
      setStep("done");
    } catch (e) {
      setError(String(e));
      setStep("review");
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!snapshot) return;
    setBusy(true);
    setError(null);
    try {
      await msp.restore(snapshot);
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Apply {payload?.profileName ?? "tuning changes"}</DialogTitle>
          <DialogDescription>
            Every write flow: snapshot → diff of every changed value → confirm → apply → EEPROM save.
          </DialogDescription>
        </DialogHeader>

        {!isSerialSupported() && (
          <p className="text-sm text-destructive">
            WebSerial is not supported in this browser. Use Chrome or Edge on desktop.
          </p>
        )}

        {!connected && isSerialSupported() && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Connect to the flight controller first, then review the diff.
            </p>
            <Button onClick={() => void msp.connect()}>Connect over WebSerial</Button>
          </div>
        )}

        {connected && step === "connect" && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Connected to {msp.info?.fcVariant} {msp.info?.fcVersion} (API {msp.info?.apiVersion}).
            </p>
            {!msp.writable && (
              <Badge variant="warning">Read-only — writes are gated to Betaflight 4.4/4.5</Badge>
            )}
            <Button onClick={() => void review()} disabled={!msp.writable || busy}>
              {busy ? "Capturing snapshot…" : "Capture snapshot & review diff"}
            </Button>
          </div>
        )}

        {connected && step === "review" && (
          <div className="space-y-3">
            <DiffView diff={diff} />
            {payload?.cliOnlyStripped && payload.cliOnlyStripped.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Not MSP-writable on BF 4.4/4.5, excluded from this apply:{" "}
                {payload.cliOnlyStripped.join(", ")} — use the CLI snippet for those.
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button onClick={() => void apply()} disabled={busy || diff.length === 0}>
                Confirm &amp; apply to FC
              </Button>
              <Button variant="outline" onClick={reset}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {connected && step === "apply" && (
          <p className="text-sm text-muted-foreground">Writing to the flight controller…</p>
        )}

        {connected && step === "done" && (
          <div className="space-y-3">
            <p className="text-sm">
              {diff.length === 0 ? (
                <span className="text-muted-foreground">The FC already matches this profile.</span>
              ) : (
                <span className="text-emerald-400">Settings applied and saved to EEPROM.</span>
              )}
            </p>
            {snapshot && (
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => void restore()} disabled={busy}>
                  Restore snapshot
                </Button>
                <Button onClick={() => void msp.refresh()}>Re-read config</Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

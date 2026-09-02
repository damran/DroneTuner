import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ConfigSection, DiffEntry, FcDump, Profile, ProfileSettings } from "@dronetuner/shared";
import { RATES_TYPE_NAMES } from "@dronetuner/shared";
import { diffConfig } from "@dronetuner/shared/tuning";
import { apiGet, apiPost } from "@/lib/api";
import { useApplyStore } from "@/lib/apply-store";
import { isDMaxApi, isSerialSupported, translateSettingsForApi, useMspStore } from "@/lib/msp";
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

interface AbPlan {
  label: string;
  profile: number;
  settings: ProfileSettings;
  snapshot: FcDump;
  diff: DiffEntry[];
  sections: ConfigSection[];
  cliOnlyStripped?: string[];
}

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
  const [abPlans, setAbPlans] = useState<AbPlan[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  /** An A/B write stopped part-way: the FC may hold a half-written, unsaved slot. */
  const [abWriteFailed, setAbWriteFailed] = useState(false);
  const isAb = !!payload?.ab && payload.ab.length > 0;
  const abKind = payload?.abKind ?? "pid";
  const slotName = abKind === "rate" ? "rate profile" : "PID profile";
  const selectSlot = (index: number) => (abKind === "rate" ? msp.selectRateProfile(index) : msp.selectPidProfile(index));

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

  // Rate values are meaningless without their curve convention (rates_type).
  // A profile that declares it writes the type along with the values (shown
  // in the diff); one that doesn't gets this loud warning instead.
  const ratesConventionWarning = useMemo(() => {
    if (!targetSettings?.rates || !msp.config) return null;
    const rateKeys = Object.keys(targetSettings.rates).filter((k) => k !== "ratesType");
    if (rateKeys.length === 0 || targetSettings.rates.ratesType !== undefined) return null;
    const fcType = msp.config.rates.ratesType;
    const fcName = (fcType !== undefined && RATES_TYPE_NAMES[fcType]) || "unknown";
    return `This profile sets rates but doesn't declare a rates type — the values will be interpreted under the FC's current convention (${fcName}).`;
  }, [targetSettings, msp.config]);

  const reset = () => {
    setStep("connect");
    setDiff([]);
    setSections([]);
    setTarget(null);
    setSnapshot(null);
    setError(null);
    setAbPlans([]);
    setProgress(null);
    setAbWriteFailed(false);
  };

  // A/B: select each slot, snapshot it (restore point per profile), diff the
  // variant against what that slot holds now.
  const reviewAb = async () => {
    if (!msp.config || !payload?.ab) return;
    setBusy(true);
    setError(null);
    try {
      const plans: AbPlan[] = [];
      for (const v of payload.ab) {
        setProgress(`Reading ${slotName} ${v.profile + 1} (${v.label})…`);
        await selectSlot(v.profile);
        const cfg = useMspStore.getState().config;
        const dump = useMspStore.getState().takeSnapshot();
        if (!cfg || !dump) throw new Error("Could not capture a snapshot");
        await apiPost("/api/snapshots", { droneId: payload.droneId, dump, reason: `ab-flow ${slotName} ${v.profile + 1}` });
        const result = diffConfig(cfg, translateSettingsForApi(v.settings, cfg.apiVersion));
        plans.push({ ...v, snapshot: dump, diff: result.diff, sections: result.sections });
      }
      setAbPlans(plans);
      setStep("review");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const applyAb = async () => {
    if (abPlans.length === 0) return;
    setBusy(true);
    setError(null);
    setStep("apply");
    try {
      for (const plan of abPlans) {
        setProgress(`Writing ${plan.label} into ${slotName} ${plan.profile + 1}…`);
        await selectSlot(plan.profile);
        if (plan.sections.length > 0) await msp.applySections(plan.sections, plan.settings);
      }
      // Leave the pilot on A, then persist everything (incl. the selection).
      setProgress("Selecting profile A and saving to EEPROM…");
      await selectSlot(abPlans[0]!.profile);
      await msp.saveEeprom();
      // Remember the pair so Log Lab can label each session A or B.
      if (payload) {
        await apiPost("/api/ab-tests", {
          droneId: payload.droneId,
          kind: abKind,
          variants: payload.ab!.map((v) => ({ side: v.side, label: v.label, slot: v.profile, settings: v.settings })),
          notes: `written via MSP ${new Date().toISOString()}`,
        }).catch(() => {
          /* the FC write succeeded; the label record is a convenience */
        });
      }
      setStep("done");
    } catch (e) {
      // The FC may now sit on a partially written, unsaved slot. Go back to
      // A on a best-effort basis and say so plainly — the pilot must not arm
      // on this state without a power cycle or a restore.
      const stage = progress ?? "an unknown step";
      let note = "";
      try {
        await selectSlot(abPlans[0]!.profile);
      } catch {
        note = " Re-selecting profile A also failed.";
      }
      setAbWriteFailed(true);
      setError(
        `${String(e)} — the write stopped during "${stage}". The FC may hold half-written, unsaved settings in that slot: ` +
          `restore both snapshots below, or power-cycle the FC (unsaved changes are dropped) before flying.${note}`,
      );
      setStep("review");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const restoreAb = async () => {
    if (abPlans.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Each snapshot carries its profile; restore() selects it before replay.
      for (const plan of abPlans) {
        setProgress(`Restoring PID profile ${plan.profile + 1}…`);
        await msp.restore(plan.snapshot);
      }
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
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
      const result = diffConfig(msp.config, translateSettingsForApi(targetSettings, msp.config.apiVersion));
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
          <DialogTitle>{isAb ? `Write A/B ${slotName}s` : `Apply ${payload?.profileName ?? "tuning changes"}`}</DialogTitle>
          <DialogDescription>
            {isAb
              ? `Each ${slotName} slot is snapshotted before it is overwritten. Profile A stays active; fly it, land, switch to B and fly again.`
              : "Every write flow: snapshot → diff of every changed value → confirm → apply → EEPROM save."}
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
              <Badge variant="warning">Read-only — writes are gated to Betaflight 4.4 / 4.5 / 2025.12</Badge>
            )}
            {msp.status?.armed && <Badge variant="warning">FC reports ARMED — disarm first</Badge>}
            {isAb && msp.status && (
              <p className="text-xs text-muted-foreground">
                FC is on {abKind === "rate" ? `rate profile ${msp.status.rateProfile + 1}` : `PID profile ${msp.status.pidProfile + 1} of ${msp.status.pidProfileCount}`}. Slots to write:{" "}
                {payload!.ab!.map((v) => `${v.label} → ${slotName} ${v.profile + 1}`).join(", ")}.
              </p>
            )}
            <Button onClick={() => void (isAb ? reviewAb() : review())} disabled={!msp.writable || busy || !!msp.status?.armed}>
              {busy ? (progress ?? "Capturing snapshot…") : isAb ? "Snapshot both slots & review" : "Capture snapshot & review diff"}
            </Button>
          </div>
        )}

        {connected && step === "review" && isAb && (
          <div className="space-y-4">
            {abPlans.map((plan) => (
              <div key={plan.profile} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{plan.label}</span>
                  <Badge variant="secondary">{slotName} {plan.profile + 1}</Badge>
                </div>
                {plan.diff.length === 0 ? (
                  <p className="text-xs text-muted-foreground">This slot already matches the variant.</p>
                ) : (
                  <DiffView diff={plan.diff} />
                )}
                {plan.cliOnlyStripped && plan.cliOnlyStripped.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    CLI-only on BF 4.4/4.5, excluded: {plan.cliOnlyStripped.join(", ")}.
                  </p>
                )}
              </div>
            ))}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void applyAb()} disabled={busy || abPlans.every((p) => p.diff.length === 0)}>
                {abWriteFailed ? "Retry: write both profiles" : "Confirm & write both profiles"}
              </Button>
              {abWriteFailed && (
                <Button variant="outline" onClick={() => void restoreAb()} disabled={busy}>
                  {busy ? (progress ?? "Restoring…") : "Restore both snapshots"}
                </Button>
              )}
              <Button variant="outline" onClick={reset}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {connected && step === "review" && !isAb && (
          <div className="space-y-3">
            <DiffView diff={diff} />
            {ratesConventionWarning && <p className="text-xs text-warning">{ratesConventionWarning}</p>}
            {msp.config && isDMaxApi(msp.config.apiVersion) && (
              <p className="text-xs text-muted-foreground">
                Betaflight 2025.12 (API {msp.config.apiVersion}): rows labelled D are the resting D and “D min” rows are the D max ceiling — the 4.5 values were swapped to keep the same behaviour.
              </p>
            )}
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
          <p className="text-sm text-muted-foreground">{progress ?? "Writing to the flight controller…"}</p>
        )}

        {connected && step === "done" && isAb && (
          <div className="space-y-3">
            <p className="text-sm text-success">
              Both profiles written and saved. The FC is on {abPlans[0]?.label} ({slotName} {(abPlans[0]?.profile ?? 0) + 1}).
            </p>
            {abKind === "rate" ? (
              <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
                <li>
                  Put "Rate Profile Selection" on a 3-position switch once: Configurator → Adjustments, or CLI{" "}
                  <code>adjrange 0 0 &lt;aux&gt; 900 2100 12 &lt;aux&gt; 0 0</code> (function 12; switch low = rate profile 1, middle = 2,
                  high = 3). Rate profiles switch in flight.
                </li>
                <li>Fly A for at least 30 s with the usual moves, then land and disarm. Flip the switch to B, arm and fly the same lines.</li>
                <li>Every arm is its own blackbox session; the Log Lab labels them A and B from the rates in the headers.</li>
              </ol>
            ) : (
              <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
                <li>Fly A for at least 30 s: the same lines, a few sharp stick moves, some throttle chops. Land and disarm.</li>
                <li>
                  Switch to B while disarmed: stick command with throttle down and yaw left, then roll left = PID profile 1, pitch up = profile 2,
                  roll right = profile 3 (the FC LED flickers) — or OSD menu → Profiles. Betaflight 4.5 has no in-flight switch for PID profiles.
                </li>
                <li>Fly B the same way in the same pack. Every arm starts a new blackbox session — upload the file; the Log Lab labels A and B and "Compare with" puts them side by side.</li>
              </ol>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void restoreAb()} disabled={busy}>
                {busy ? (progress ?? "Restoring…") : "Restore both snapshots"}
              </Button>
              <Button onClick={() => void msp.refresh()}>Re-read config</Button>
            </div>
          </div>
        )}

        {connected && step === "done" && !isAb && (
          <div className="space-y-3">
            <p className="text-sm">
              {diff.length === 0 ? (
                <span className="text-muted-foreground">The FC already matches this profile.</span>
              ) : (
                <span className="text-success">Settings applied and saved to EEPROM.</span>
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

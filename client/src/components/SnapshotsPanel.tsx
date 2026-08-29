import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Trash2 } from "lucide-react";
import type { FcSnapshot } from "@dronetuner/shared";
import { diffConfig } from "@dronetuner/shared/tuning";
import { apiDelete, apiGet } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { decodeDumpSections, useMspStore } from "@/lib/msp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import DiffView from "@/components/DiffView";

/**
 * Snapshot restore points. Every write flow (and the manual Snapshot button)
 * stores one; restoring replays the raw MSP payloads through the same
 * confirm-gated path. The confirm diff is decoded client-side from the exact
 * section payloads that will be replayed (never from the snapshot's free-form
 * `decoded` field), replay is limited to the four tuning SET commands, and
 * restore is refused on a firmware variant/API mismatch (enforced in the MSP
 * session, surfaced here).
 */
export default function SnapshotsPanel({ droneId }: { droneId: number }) {
  const qc = useQueryClient();
  const msp = useMspStore();
  const [target, setTarget] = useState<FcSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: snapshots } = useQuery({
    queryKey: ["snapshots", droneId],
    queryFn: () => apiGet<FcSnapshot[]>(`/api/snapshots?droneId=${droneId}`),
  });

  const connected = (msp.state === "connected" || msp.state === "readonly") && !!msp.config;

  // Diff of "current FC vs snapshot", decoded from the actual payloads to be
  // replayed — the same review step every other write flow has. Null when a
  // section can't be decoded (unknown command) — the restore is then blocked.
  const plan = useMemo(() => {
    if (!target || !msp.config) return null;
    const settings = decodeDumpSections(target.dump.sections);
    if (!settings) return null;
    return diffConfig(msp.config, settings);
  }, [target, msp.config]);

  const versionMismatch = (s: FcSnapshot): string | null => {
    if (!msp.info) return null;
    if (s.dump.fcVariant !== msp.info.fcVariant || s.dump.apiVersion !== msp.info.apiVersion) {
      return `taken on ${s.dump.fcVariant} API ${s.dump.apiVersion}`;
    }
    return null;
  };

  const restore = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await msp.restore(target.dump);
      setTarget(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const remove = (id: number) => {
    void apiDelete(`/api/snapshots/${id}`).then(() =>
      qc.invalidateQueries({ queryKey: ["snapshots", droneId] }),
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Snapshots</CardTitle>
        <CardDescription>
          Restore points captured before every apply (and manually). Restoring replays the exact MSP
          payloads, then saves to EEPROM.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {(snapshots ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No snapshots yet — one is captured automatically before every apply.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Taken</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Firmware</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(snapshots ?? []).map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{formatDateTime(s.takenAt)}</TableCell>
                  <TableCell className="text-muted-foreground">{s.reason ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {s.dump.fcVariant} {s.dump.fcVersion}
                    </Badge>
                  </TableCell>
                  <TableCell className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!connected || !msp.writable}
                      title={
                        !connected
                          ? "Connect the flight controller first"
                          : !msp.writable
                            ? "Writes are gated to Betaflight 4.4/4.5"
                            : undefined
                      }
                      onClick={() => {
                        setError(null);
                        setTarget(s);
                      }}
                    >
                      <History className="h-3.5 w-3.5" /> Restore
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(s.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Restore snapshot?</DialogTitle>
            <DialogDescription>
              This writes the snapshot&apos;s raw config payloads back to the connected flight
              controller and saves to EEPROM. Current settings are overwritten — take a fresh
              snapshot first if you might want them back.
            </DialogDescription>
          </DialogHeader>
          {target && (
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                Snapshot from {formatDateTime(target.takenAt)} ({target.dump.fcVariant}{" "}
                {target.dump.fcVersion}, API {target.dump.apiVersion}).
              </p>
              {versionMismatch(target) ? (
                <p className="text-amber-500">
                  Version mismatch: this snapshot was {versionMismatch(target)}. The restore will be
                  refused — connect the FC running the matching firmware.
                </p>
              ) : plan === null ? (
                <p className="text-destructive">
                  Could not decode this snapshot&apos;s payloads — restoring it is blocked.
                </p>
              ) : plan.upToDate ? (
                <p className="text-muted-foreground">The FC already matches this snapshot.</p>
              ) : (
                <DiffView diff={plan.diff} />
              )}
              {error && <p className="text-destructive">{error}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => void restore()}
              disabled={busy || !target || versionMismatch(target) !== null || plan === null}
            >
              {busy ? "Restoring…" : "Confirm restore"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

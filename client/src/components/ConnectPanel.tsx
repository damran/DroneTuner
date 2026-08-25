import { useState } from "react";
import { Camera, Plug, RefreshCw, Unplug } from "lucide-react";
import { apiPost } from "@/lib/api";
import { formatFeedforward, formatRate } from "@/lib/format";
import { isSerialSupported, useMspStore } from "@/lib/msp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import DetectBanner from "@/components/DetectBanner";

export default function ConnectPanel({ droneId }: { droneId: number }) {
  const msp = useMspStore();
  const [snapshotSaved, setSnapshotSaved] = useState(false);

  const saveSnapshot = async () => {
    const dump = msp.takeSnapshot();
    if (!dump) return;
    await apiPost("/api/snapshots", { droneId, dump, reason: "manual" });
    setSnapshotSaved(true);
    setTimeout(() => setSnapshotSaved(false), 2000);
  };

  if (!isSerialSupported()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Connect</CardTitle>
          <CardDescription>
            WebSerial is not supported in this browser. Open DroneTuner in Chrome or Edge on desktop.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const { config, info, identity, state, writable } = msp;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Flight controller</CardTitle>
            <CardDescription>WebSerial · MSP v2 · 115200 baud</CardDescription>
          </div>
          <div className="flex gap-2">
            {state === "connected" || state === "readonly" ? (
              <>
                <Button size="sm" variant="outline" onClick={() => void msp.refresh()}>
                  <RefreshCw className="h-3.5 w-3.5" /> Re-read
                </Button>
                <Button size="sm" variant="outline" onClick={() => void saveSnapshot()}>
                  <Camera className="h-3.5 w-3.5" /> {snapshotSaved ? "Saved" : "Snapshot"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void msp.disconnect()}>
                  <Unplug className="h-3.5 w-3.5" /> Disconnect
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => void msp.connect()} disabled={state === "connecting"}>
                <Plug className="h-3.5 w-3.5" /> {state === "connecting" ? "Connecting…" : "Connect"}
              </Button>
            )}
          </div>
        </div>
        {state === "error" && <p className="text-sm text-destructive">{msp.error}</p>}
      </CardHeader>

      {config && info && (
        <CardContent className="space-y-4">
          {identity && <DetectBanner droneId={droneId} identity={identity} />}

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="secondary">{info.fcVariant}</Badge>
            <Badge variant="secondary">v{info.fcVersion}</Badge>
            <Badge variant="secondary">API {info.apiVersion}</Badge>
            {identity?.targetName && <Badge variant="outline">{identity.targetName}</Badge>}
            {identity?.craftName && <Badge variant="outline">“{identity.craftName}”</Badge>}
            {writable ? <Badge variant="success">Writable</Badge> : <Badge variant="warning">Read-only (BF 4.4/4.5 only)</Badge>}
          </div>

          <div>
            <h4 className="mb-1 text-sm font-semibold">PID</h4>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Axis</TableHead>
                  <TableHead>P</TableHead>
                  <TableHead>I</TableHead>
                  <TableHead>D</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(["roll", "pitch", "yaw"] as const).map((axis) => (
                  <TableRow key={axis}>
                    <TableCell className="capitalize">{axis}</TableCell>
                    <TableCell>{config.pids[axis].p}</TableCell>
                    <TableCell>{config.pids[axis].i}</TableCell>
                    <TableCell>{config.pids[axis].d}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div>
            <h4 className="mb-1 text-sm font-semibold">Filters</h4>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
              <FilterRow label="Gyro LPF" value={formatHzValue(config.filters.gyroLowpassHz)} />
              <FilterRow
                label="Gyro dyn LPF"
                value={formatHzRange(config.filters.gyroLowpassDynMinHz, config.filters.gyroLowpassDynMaxHz)}
              />
              <FilterRow label="D-term LPF" value={formatHzValue(config.filters.dtermLowpassHz)} />
              <FilterRow
                label="D-term dyn LPF"
                value={formatHzRange(config.filters.dtermLowpassDynMinHz, config.filters.dtermLowpassDynMaxHz)}
              />
              <FilterRow
                label="Dyn notch"
                value={formatHzRange(config.filters.dynNotchMinHz, config.filters.dynNotchMaxHz, config.filters.dynNotchCount)}
              />
            </div>
          </div>

          <div>
            <h4 className="mb-1 text-sm font-semibold">Rates</h4>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
              <FilterRow label="RC rate" value={formatRate(config.rates.rcRate)} />
              <FilterRow label="RC expo" value={formatRate(config.rates.rcExpo)} />
              <FilterRow label="Super rate" value={formatRate(config.rates.rollRate)} />
              <FilterRow label="Throttle mid" value={formatRate(config.rates.thrMid)} />
              <FilterRow label="FF roll" value={formatFeedforward(config.advanced.feedforwardRoll)} />
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function formatHzValue(v: number | undefined): string | undefined {
  return v === undefined ? undefined : `${v} Hz`;
}

function formatHzRange(min: number | undefined, max: number | undefined, count?: number): string | undefined {
  if (min === undefined && max === undefined) return undefined;
  const range = `${min ?? "?"}–${max ?? "?"} Hz`;
  return count === undefined ? range : `${count} × ${range}`;
}

function FilterRow({ label, value }: { label: string; value: number | string | undefined }) {
  return (
    <div className="flex justify-between border-b border-border/50 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value ?? "—"}</span>
    </div>
  );
}

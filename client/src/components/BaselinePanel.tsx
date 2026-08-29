import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitCompareArrows, Globe, Trash2, Upload } from "lucide-react";
import type { ApplyPlan, Component, DroneBaseline, DroneDetail, VendorPreset } from "@dronetuner/shared";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { useMspStore } from "@/lib/msp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

interface ImportResult {
  preset: VendorPreset;
  recognized: string[];
  ignored: string[];
}

/**
 * Vendor baseline tab: import vendor/BNF Betaflight configs (CLI dumps),
 * assign them to BOM components (hybrid builds mix donors), and diff the
 * merged baseline against the live FC config.
 */
export default function BaselinePanel({ drone }: { drone: DroneDetail }) {
  const qc = useQueryClient();
  const msp = useMspStore();
  const droneId = drone.id;

  const { data: baseline } = useQuery({
    queryKey: ["baseline", droneId],
    queryFn: () => apiGet<DroneBaseline>(`/api/drones/${droneId}/baseline`),
  });
  const { data: presets } = useQuery({
    queryKey: ["vendor-presets"],
    queryFn: () => apiGet<VendorPreset[]>("/api/vendor-presets"),
  });
  const { data: library } = useQuery({
    queryKey: ["components"],
    queryFn: () => apiGet<Component[]>("/api/components"),
  });

  const [dumpText, setDumpText] = useState("");
  const [dumpName, setDumpName] = useState("");
  const [dumpComponentId, setDumpComponentId] = useState("none");
  const [fetchUrl, setFetchUrl] = useState("");
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ baseline: DroneBaseline; plan: ApplyPlan } | null>(null);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["vendor-presets"] });
    void qc.invalidateQueries({ queryKey: ["baseline", droneId] });
  };

  const onImported = (r: ImportResult) => {
    setImportMsg(
      `Imported "${r.preset.name}" — ${r.recognized.length} settings recognized, ${r.ignored.length} skipped.`,
    );
    setDumpText("");
    setDumpName("");
    setFetchUrl("");
    invalidate();
  };

  const importDump = useMutation({
    mutationFn: () =>
      apiPost<ImportResult>("/api/vendor-presets/import", {
        text: dumpText,
        name: dumpName || undefined,
        componentId: dumpComponentId === "none" ? null : Number(dumpComponentId),
      }),
    onSuccess: onImported,
    onError: (e) => setImportMsg(`Import failed: ${(e as Error).message}`),
  });

  const fetchPreset = useMutation({
    mutationFn: () =>
      apiPost<ImportResult>("/api/vendor-presets/fetch", {
        url: fetchUrl,
        name: dumpName || undefined,
        componentId: dumpComponentId === "none" ? null : Number(dumpComponentId),
      }),
    onSuccess: onImported,
    onError: (e) => setImportMsg(`Fetch failed: ${(e as Error).message}`),
  });

  const assign = (presetId: number, componentId: number | null) => {
    void apiPatch(`/api/vendor-presets/${presetId}`, { componentId }).then(invalidate);
  };

  const removePreset = (id: number) => {
    void apiDelete(`/api/vendor-presets/${id}`).then(invalidate);
  };

  const runCompare = useMutation({
    mutationFn: () =>
      apiPost<{ baseline: DroneBaseline; plan: ApplyPlan }>(`/api/drones/${droneId}/baseline-compare`, {
        current: msp.config,
      }),
    onSuccess: setCompare,
  });

  const connected = (msp.state === "connected" || msp.state === "readonly") && !!msp.config;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Import vendor config</CardTitle>
          <CardDescription>
            Paste a Betaflight CLI dump from the vendor (BetaFPV, Happymodel, Flywoo…) or fetch a
            vendor page that embeds one. Assign it to a component so hybrid builds can mix donors.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            rows={6}
            placeholder={"# Betaflight / ...\nset p_roll = 45\nset rc_rate = 1.10\n…"}
            value={dumpText}
            onChange={(e) => setDumpText(e.target.value)}
            className="font-mono text-xs"
          />
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label>Name (optional)</Label>
              <Input
                className="w-48"
                placeholder="e.g. Meteor65 stock"
                value={dumpName}
                onChange={(e) => setDumpName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Component</Label>
              <Select value={dumpComponentId} onValueChange={setDumpComponentId}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unassigned</SelectItem>
                  {(library ?? []).map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" onClick={() => importDump.mutate()} disabled={!dumpText.trim() || importDump.isPending}>
              <Upload className="h-3.5 w-3.5" /> Import dump
            </Button>
          </div>
          <div className="flex items-end gap-2 border-t border-border/50 pt-3">
            <div className="grow space-y-1">
              <Label>Fetch from vendor URL</Label>
              <Input
                placeholder="https://flywoo.net/… or any page embedding a CLI dump"
                value={fetchUrl}
                onChange={(e) => setFetchUrl(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => fetchPreset.mutate()}
              disabled={!fetchUrl.trim() || fetchPreset.isPending}
            >
              <Globe className="h-3.5 w-3.5" /> {fetchPreset.isPending ? "Fetching…" : "Fetch & import"}
            </Button>
          </div>
          {importMsg && <p className="text-sm text-muted-foreground">{importMsg}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Build baseline</CardTitle>
          <CardDescription>
            Vendor preset matched to each component of this build. The merged baseline combines all
            donors; on conflicts the later category wins.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Slot</TableHead>
                <TableHead>Component</TableHead>
                <TableHead>Vendor preset</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(baseline?.components ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground">
                    No components in this build yet — add them in the Overview tab.
                  </TableCell>
                </TableRow>
              )}
              {(baseline?.components ?? []).map((c) => (
                <TableRow key={c.slot}>
                  <TableCell className="capitalize">{c.slot}</TableCell>
                  <TableCell>{c.componentName}</TableCell>
                  <TableCell>
                    {c.preset ? (
                      <span className="flex items-center gap-2">
                        <Badge variant="info">{c.preset.name}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {Object.keys(c.preset.settings).length} sections
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              disabled={!connected || runCompare.isPending}
              onClick={() => runCompare.mutate()}
              title={connected ? undefined : "Connect a flight controller in the Connect tab first"}
            >
              <GitCompareArrows className="h-3.5 w-3.5" />
              {runCompare.isPending ? "Comparing…" : "Compare live config vs baseline"}
            </Button>
            {!connected && (
              <span className="text-xs text-muted-foreground">
                Connect a flight controller (Connect tab) to diff against the baseline.
              </span>
            )}
            {runCompare.isError && (
              <span className="text-xs text-destructive">{(runCompare.error as Error).message}</span>
            )}
          </div>

          {compare && (
            <div>
              {compare.plan.upToDate ? (
                <p className="text-sm text-muted-foreground">
                  Live config matches the merged vendor baseline.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Setting</TableHead>
                      <TableHead>Live</TableHead>
                      <TableHead>Baseline</TableHead>
                      <TableHead>From preset</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {compare.plan.diff.map((d) => (
                      <TableRow key={d.path}>
                        <TableCell>{d.label}</TableCell>
                        <TableCell>{d.fromDisplay}</TableCell>
                        <TableCell>{d.toDisplay}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {compare.baseline.sources[d.path] ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preset library</CardTitle>
          <CardDescription>All imported vendor configs. Assign them to components here.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Board target</TableHead>
                <TableHead>Assigned component</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(presets ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    No vendor presets yet — import a CLI dump above.
                  </TableCell>
                </TableRow>
              )}
              {(presets ?? []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    {p.name}
                    {p.droneModel && (
                      <span className="ml-2 text-xs text-muted-foreground">model: {p.droneModel}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{p.source}</Badge>
                    {p.sourceUrl && (
                      <a
                        href={p.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-2 text-xs text-muted-foreground underline"
                      >
                        link
                      </a>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.boardTarget ?? "—"}</TableCell>
                  <TableCell>
                    <Select
                      value={p.componentId ? String(p.componentId) : "none"}
                      onValueChange={(v) => assign(p.id, v === "none" ? null : Number(v))}
                    >
                      <SelectTrigger className="h-7 w-48 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Unassigned</SelectItem>
                        {(library ?? []).map((c) => (
                          <SelectItem key={c.id} value={String(c.id)}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => removePreset(p.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

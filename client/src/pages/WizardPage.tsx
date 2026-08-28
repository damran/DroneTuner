import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Analysis, DroneSummary, FlightLog, Profile, ProfileSettings, TuneGoal } from "@dronetuner/shared";
import { TUNE_GOALS, TUNE_GOAL_LABELS } from "@dronetuner/shared";
import { applyChanges, cliOnlyKeys, runRules, settingsToCli } from "@dronetuner/shared/tuning";
import { estimateFilterDelay, filterConfigFromProfile } from "@dronetuner/shared/analysis";
import { apiGet, apiPost } from "@/lib/api";
import { useApplyStore } from "@/lib/apply-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function WizardPage() {
  const [droneId, setDroneId] = useState<string>("");
  const [goal, setGoal] = useState<TuneGoal>("freestyle");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  // Nothing is applied by default: the user opts into each recommendation.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const start = useApplyStore((s) => s.start);

  const { data: drones } = useQuery({
    queryKey: ["drones"],
    queryFn: () => apiGet<DroneSummary[]>("/api/drones"),
  });
  const { data: templates } = useQuery({
    queryKey: ["templates"],
    queryFn: () => apiGet<Profile[]>("/api/profiles?templates=1"),
  });

  const drone = drones?.find((d) => String(d.id) === droneId);

  const { data: logs } = useQuery({
    queryKey: ["logs", droneId],
    enabled: !!droneId,
    queryFn: () => apiGet<FlightLog[]>(`/api/logs?droneId=${droneId}`),
  });
  const latestLogId = logs?.[0]?.id;
  const { data: analysis } = useQuery({
    queryKey: ["analysis", latestLogId],
    enabled: !!latestLogId,
    queryFn: () => apiGet<Analysis>(`/api/logs/${latestLogId}/analysis`),
    retry: false,
  });

  const template = useMemo(() => {
    if (!drone) return undefined;
    return (
      templates?.find((t) => t.sizeClass === drone.sizeClass && t.goal === goal) ??
      templates?.find((t) => t.goal === goal)
    );
  }, [templates, drone, goal]);

  const recommendations = useMemo(() => {
    if (!analysis) return [];
    // Recommendations are signed deltas; pass the template as the base so
    // absolute-style fixes (e.g. dynamic notch range) come out right.
    return runRules(analysis.metrics, goal, template?.settings).recommendations;
  }, [analysis, goal, template]);

  // Reset the selection when the underlying analysis/goal/template changes.
  const recKey = recommendations.map((r) => r.id).join("|");
  const [prevRecKey, setPrevRecKey] = useState(recKey);
  if (recKey !== prevRecKey) {
    setPrevRecKey(recKey);
    setSelected(new Set());
  }

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const draftSettings: ProfileSettings | null = useMemo(() => {
    if (!template) return null;
    let settings = template.settings;
    for (const r of recommendations) {
      if (selected.has(r.id)) settings = applyChanges(settings, r.changes);
    }
    return settings;
  }, [template, recommendations, selected]);

  // Predicted filter delay of the draft (BF 4.5 defaults fill the gaps).
  const draftDelay = useMemo(() => {
    if (!draftSettings) return null;
    return estimateFilterDelay(filterConfigFromProfile(draftSettings), {});
  }, [draftSettings]);

  const draftCli = useMemo(() => (draftSettings ? settingsToCli(draftSettings) : []), [draftSettings]);

  const copyCli = async (lines: string[], done: () => void) => {
    await navigator.clipboard.writeText(lines.join("\n") + "\nsave\n");
    done();
  };

  const saveDraft = async () => {
    if (!draftSettings || !drone) return;
    await apiPost("/api/profiles", {
      name: `${drone.name} ${TUNE_GOAL_LABELS[goal]}`,
      goal,
      sizeClass: drone.sizeClass,
      droneId: drone.id,
      settings: draftSettings,
      source: "generated",
    });
    setSaved(true);
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Tuning Wizard</h1>
        <p className="text-sm text-muted-foreground">
          Pick a drone and goal, start from a baseline template, then choose which analysis-driven
          recommendations to include — nothing is applied unless you select it.
        </p>
      </div>

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label>Drone</Label>
          <Select value={droneId} onValueChange={setDroneId}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Select drone…" />
            </SelectTrigger>
            <SelectContent>
              {(drones ?? []).map((d) => (
                <SelectItem key={d.id} value={String(d.id)}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Goal</Label>
          <Select value={goal} onValueChange={(v) => setGoal(v as TuneGoal)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TUNE_GOALS.map((g) => (
                <SelectItem key={g} value={g}>
                  {TUNE_GOAL_LABELS[g]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!drone && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Select a drone and goal to begin.
          </CardContent>
        </Card>
      )}

      {drone && !template && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No baseline template matches this drone class and goal yet.
          </CardContent>
        </Card>
      )}

      {drone && template && (
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between p-4">
              <CardTitle className="text-sm">Baseline: {template.name}</CardTitle>
              <Badge variant="secondary">template</Badge>
            </CardHeader>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">
                {analysis
                  ? `${recommendations.length} analysis-driven recommendation(s) available — tick the ones you want in the draft.`
                  : "No analysis available for this drone — the baseline template is used as-is. Upload a log to get data-driven tweaks."}
              </p>
            </CardContent>
          </Card>

          {analysis && (!analysis.metrics.spectral || analysis.metrics.gyroRateHz == null) && (
            <Card>
              <CardContent className="p-4 text-sm text-muted-foreground">
                This analysis predates the current tuning analysis — re-analyze the log in Log Lab to
                unlock the RPM-filter, gyro-LPF2 and flown-config-baselined recommendations.
              </CardContent>
            </Card>
          )}

          {recommendations.length > 0 && (
            <Card>
              <CardHeader className="p-4">
                <CardTitle className="text-sm">Recommendations (opt-in)</CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <div className="space-y-2">
                  {recommendations.map((r) => {
                    const cliOnly = cliOnlyKeys(r.changes);
                    const isSelected = selected.has(r.id);
                    return (
                      <label
                        key={r.id}
                        className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                          isSelected ? "border-primary bg-accent/40" : "hover:bg-accent/20"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggle(r.id)}
                          className="mt-1 h-4 w-4 accent-[hsl(var(--primary))]"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                            {r.rationale}
                            {cliOnly.length > 0 && (
                              <Badge variant="outline" title={`Not MSP-writable on BF 4.4/4.5: ${cliOnly.join(", ")}`}>
                                CLI only
                              </Badge>
                            )}
                          </div>
                          {r.cliLines && r.cliLines.length > 0 && (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-xs text-muted-foreground">
                                View config ({r.cliLines.length} line{r.cliLines.length > 1 ? "s" : ""})
                              </summary>
                              <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">
                                {r.cliLines.join("\n")}
                              </pre>
                              <Button
                                size="sm"
                                variant="outline"
                                className="mt-1"
                                onClick={(e) => {
                                  e.preventDefault();
                                  void navigator.clipboard.writeText(r.cliLines!.join("\n") + "\nsave\n");
                                }}
                              >
                                Copy CLI
                              </Button>
                            </details>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {draftSettings && (
            <Card>
              <CardHeader className="flex-row items-center justify-between p-4">
                <CardTitle className="text-sm">Draft settings</CardTitle>
                {draftDelay && (
                  <span
                    className="text-xs text-muted-foreground"
                    title="Predicted group delay of the draft filter chain at 50 Hz, 0%–100% throttle (BF 4.5 defaults fill unset fields; 8k gyro / 4k PID assumed)"
                  >
                    predicted filter delay ≈ {draftDelay.dtermMs.toFixed(1)}–{draftDelay.dtermMsMax.toFixed(1)} ms
                  </span>
                )}
              </CardHeader>
              <CardContent className="p-4">
                <SettingsTable settings={draftSettings} />
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    onClick={() => {
                      if (drone) start({ droneId: drone.id, settings: draftSettings, profileName: "draft" });
                    }}
                  >
                    Review &amp; apply to FC
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void copyCli(draftCli, () => setCopied(true))}
                    disabled={draftCli.length === 0}
                  >
                    {copied ? "Copied" : "Copy CLI config"}
                  </Button>
                  <Button variant="outline" onClick={() => void saveDraft()} disabled={saved}>
                    {saved ? "Saved" : "Save as generated profile"}
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Apply goes through snapshot → diff → confirm → EEPROM save. Copy CLI gives you the same
                  config as Betaflight CLI commands to paste yourself.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function SettingsTable({ settings }: { settings: ProfileSettings }) {
  const rows: { label: string; value: string }[] = [];
  if (settings.pids) {
    for (const axis of ["roll", "pitch", "yaw"] as const) {
      const p = settings.pids[axis];
      if (p) rows.push({ label: `${axis} P/I/D`, value: `${p.p ?? "—"}/${p.i ?? "—"}/${p.d ?? "—"}` });
    }
  }
  for (const [k, v] of Object.entries(settings.filters ?? {})) rows.push({ label: k, value: String(v) });
  for (const [k, v] of Object.entries(settings.rates ?? {})) rows.push({ label: k, value: String(v) });
  for (const [k, v] of Object.entries(settings.advanced ?? {})) rows.push({ label: k, value: String(v) });

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Setting</TableHead>
          <TableHead>Value</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.label}>
            <TableCell>{r.label}</TableCell>
            <TableCell>{r.value}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

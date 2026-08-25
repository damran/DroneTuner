import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Analysis, DroneSummary, FlightLog, Profile, ProfileSettings, TuneGoal } from "@dronetuner/shared";
import { TUNE_GOALS, TUNE_GOAL_LABELS } from "@dronetuner/shared";
import { applyChanges, runRules } from "@dronetuner/shared/tuning";
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

  const draftSettings: ProfileSettings | null = useMemo(() => {
    if (!template) return null;
    let settings = template.settings;
    for (const r of recommendations) settings = applyChanges(settings, r.changes);
    return settings;
  }, [template, recommendations]);

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
          Pick a drone and goal, start from a baseline template, and fold in analysis-driven recommendations.
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
              <CardTitle className="text-sm">
                Baseline: {template.name}
              </CardTitle>
              <Badge variant="secondary">template</Badge>
            </CardHeader>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">
                {analysis
                  ? `Applied ${recommendations.length} analysis-driven recommendation(s) on top of the baseline.`
                  : "No analysis available for this drone — the baseline template is used as-is. Upload a log to get data-driven tweaks."}
              </p>
            </CardContent>
          </Card>

          {recommendations.length > 0 && (
            <Card>
              <CardHeader className="p-4">
                <CardTitle className="text-sm">Recommendations</CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <div className="space-y-2">
                  {recommendations.map((r) => (
                    <div key={r.id} className="rounded-lg border p-3">
                      <div className="text-sm font-medium">{r.rationale}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {JSON.stringify(r.changes)}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {draftSettings && (
            <Card>
              <CardHeader className="p-4">
                <CardTitle className="text-sm">Draft settings</CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <SettingsTable settings={draftSettings} />
                <div className="mt-4 flex gap-2">
                  <Button
                    onClick={() => {
                      if (drone) start({ droneId: drone.id, settings: draftSettings, profileName: "draft" });
                    }}
                  >
                    Review &amp; apply to FC
                  </Button>
                  <Button variant="outline" onClick={() => void saveDraft()} disabled={saved}>
                    {saved ? "Saved" : "Save as generated profile"}
                  </Button>
                </div>
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

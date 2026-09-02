import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AbTestKind, Analysis, DroneSummary, FlightLog, Profile, ProfileSettings, RateSettings, TuneGoal } from "@dronetuner/shared";
import { TUNE_GOALS, TUNE_GOAL_LABELS } from "@dronetuner/shared";
import {
  applyChanges,
  applyVariant,
  cliOnlyKeys,
  filterDiffKeys,
  formatSettingValue,
  rateAbVariant,
  runRules,
  settingLabel,
  settingsToCli,
  splitFilterScope,
  TUNE_VARIANT_DESCRIPTIONS,
  TUNE_VARIANT_LABELS,
  TUNE_VARIANTS,
  type TuneVariant,
} from "@dronetuner/shared/tuning";
import { estimateFilterDelay, filterConfigFromProfile } from "@dronetuner/shared/analysis";
import { useMspStore } from "@/lib/msp";
import { useAdvanced } from "@/lib/ui-store";
import SimplifiedSliders from "@/components/SimplifiedSliders";
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

/** Every unordered pair of variants, crisp-first, for the A/B picker. */
const AB_PAIRS: [TuneVariant, TuneVariant][] = TUNE_VARIANTS.flatMap((a, i) =>
  TUNE_VARIANTS.slice(i + 1).map((b) => [a, b] as [TuneVariant, TuneVariant]),
);

const shortVariantLabel = (v: TuneVariant): string => TUNE_VARIANT_LABELS[v].split(" (")[0]!;

/** "190 / 190 / 200" style cell for a per-axis rate triple, scaled to display units. */
function rateTriple(rates: RateSettings, r: keyof RateSettings, p: keyof RateSettings, y: keyof RateSettings, scale: number): string {
  const fmt = (v: number | undefined) => (v === undefined ? "—" : scale >= 1 ? String(Math.round(v * scale)) : (v * scale).toFixed(2));
  return `${fmt(rates[r])} / ${fmt(rates[p])} / ${fmt(rates[y])}`;
}

/**
 * What the two profiles actually differ in, and which filter settings are
 * master settings both profiles share (so the pilot does not credit a gyro
 * LPF or notch change to "A vs B").
 */
function AbScopeNote({ a, b }: { a: ProfileSettings; b: ProfileSettings }) {
  const differs = filterDiffKeys(a.filters, b.filters);
  const { master } = splitFilterScope(a.filters);
  const masterKeys = Object.keys(master).filter((k) => (master as Record<string, number>)[k] !== undefined);
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>
        <span className="font-medium text-foreground">Differs between A and B:</span>{" "}
        {differs.length > 0 ? differs.map((k) => settingLabel("filters", k)).join(", ") : "nothing (same variant on both sides)"}.
      </p>
      {masterKeys.length > 0 && (
        <p>
          <span className="font-medium text-foreground">Shared by both profiles (master settings):</span>{" "}
          {masterKeys
            .map((k) => `${settingLabel("filters", k)} ${formatSettingValue(`filters.${k}`, (master as Record<string, number>)[k]!)}`)
            .join(" · ")}
          .
        </p>
      )}
    </div>
  );
}

export default function WizardPage() {
  const [droneId, setDroneId] = useState<string>("");
  const [goal, setGoal] = useState<TuneGoal>("freestyle");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Recommendations are opt-in: none is folded into the draft until ticked.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const start = useApplyStore((s) => s.start);
  const fcStatus = useMspStore((s) => s.status);
  const advanced = useAdvanced();
  // In-flight A/B: which two variants, and which PID profile slot each gets.
  const [abPair, setAbPair] = useState<[TuneVariant, TuneVariant]>(["crisp", "balanced"]);
  const [abSlots, setAbSlots] = useState<[number, number]>([0, 1]);
  const [copiedVariant, setCopiedVariant] = useState<string | null>(null);
  // Rate-profile A/B (switchable in flight): which two rate profile slots.
  const [rateSlots, setRateSlots] = useState<[number, number]>([0, 1]);
  const [pairSaved, setPairSaved] = useState<AbTestKind | null>(null);

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

  // Match on size class + video system (HD whoops carry more mass and get their
  // own templates); a template with videoSystem null fits any build.
  const template = useMemo(() => {
    if (!drone) return undefined;
    const byGoal = (templates ?? []).filter((t) => t.goal === goal);
    const sameClass = byGoal.filter((t) => t.sizeClass === drone.sizeClass);
    return (
      sameClass.find((t) => t.videoSystem === (drone.videoSystem ?? "analog")) ??
      sameClass.find((t) => !t.videoSystem) ??
      sameClass[0] ??
      byGoal.find((t) => !t.sizeClass)
    );
  }, [templates, drone, goal]);

  const recommendations = useMemo(() => {
    if (!analysis) return [];
    // Recommendations are signed deltas; pass the template as the base so
    // absolute-style fixes (e.g. dynamic notch range) come out right.
    return runRules(analysis.metrics, goal, template?.settings).recommendations;
  }, [analysis, goal, template]);

  // Reset the selection when the underlying drone/goal/template/analysis
  // changes. Recommendation ids are positional (rec-1, rec-2, …), so the key
  // must include the analysis identity — otherwise a re-analyzed log with the
  // same recommendation count would keep stale ticks that now fold DIFFERENT
  // recommendations into the draft.
  const recKey = recommendations.map((r) => r.id).join("|");
  const contextKey = `${droneId}|${goal}|${template?.id ?? "none"}|${latestLogId ?? "none"}|${recKey}`;
  const [prevContextKey, setPrevContextKey] = useState(contextKey);
  if (contextKey !== prevContextKey) {
    setPrevContextKey(contextKey);
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

  // …and reset the action-button state whenever the draft CONTENT changes
  // (including ticking a recommendation) — "Saved"/"Copied" must not linger
  // on a draft they no longer describe.
  const draftContentKey = JSON.stringify(draftSettings);
  const [prevContentKey, setPrevContentKey] = useState(draftContentKey);
  if (draftContentKey !== prevContentKey) {
    setPrevContentKey(draftContentKey);
    setSaved(false);
    setCopied(false);
    setSaveError(null);
  }

  // Predicted filter delay of the draft (BF 4.5 defaults fill the gaps).
  const draftDelay = useMemo(() => {
    if (!draftSettings) return null;
    return estimateFilterDelay(filterConfigFromProfile(draftSettings), {});
  }, [draftSettings]);

  const draftCli = useMemo(() => (draftSettings ? settingsToCli(draftSettings) : []), [draftSettings]);

  // Variant settings for the A/B: only the D-term chain differs (gyro
  // filters, dyn notch and RPM filter are master settings shared by every
  // PID profile — see shared/src/tuning/variants.ts).
  const abVariants = useMemo(() => {
    if (!draftSettings) return null;
    return (["A", "B"] as const).map((side, i) => {
      const variant = abPair[i]!;
      const settings = applyVariant(draftSettings, variant, "profile");
      const delay = estimateFilterDelay(filterConfigFromProfile(settings), {});
      return { side, variant, settings, delay, label: `${side} · ${shortVariantLabel(variant)}` };
    });
  }, [draftSettings, abPair]);
  const profileCount = fcStatus?.pidProfileCount ?? 3;

  // Rate A/B: A = the draft's rates, B = centre sensitivity × 1.3 (ACTUAL only).
  const rateVariants = useMemo(() => {
    if (!draftSettings?.rates) return null;
    const b = rateAbVariant(draftSettings.rates);
    if (!b) return null;
    const a = draftSettings.rates;
    return [
      { side: "A" as const, label: "A · Rates", rates: a },
      { side: "B" as const, label: "B · Centre +30 %", rates: b },
    ];
  }, [draftSettings]);

  const savePair = async (kind: AbTestKind) => {
    if (!drone) return;
    const variants =
      kind === "pid"
        ? abVariants?.map((v, i) => ({ side: v.side, label: v.label, slot: abSlots[i]!, settings: v.settings }))
        : rateVariants?.map((v, i) => ({ side: v.side, label: v.label, slot: rateSlots[i]!, settings: { rates: v.rates } }));
    if (!variants) return;
    await apiPost("/api/ab-tests", { droneId: drone.id, kind, variants, notes: "saved from the wizard (CLI write)" });
    setPairSaved(kind);
    setTimeout(() => setPairSaved(null), 2500);
  };

  const copyCli = async (lines: string[], done: () => void) => {
    await navigator.clipboard.writeText(lines.join("\n") + "\nsave\n");
    done();
    setTimeout(() => setCopied(false), 2000);
  };

  const saveDraft = async () => {
    if (!draftSettings || !drone) return;
    setSaveError(null);
    try {
      await apiPost("/api/profiles", {
        name: `${drone.name} ${TUNE_GOAL_LABELS[goal]}`,
        goal,
        sizeClass: drone.sizeClass,
        droneId: drone.id,
        settings: draftSettings,
        source: "generated",
      });
      setSaved(true);
    } catch (e) {
      setSaveError(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Tuning Wizard</h1>
        <p className="text-sm text-muted-foreground">
          Pick a drone and goal to draft from a baseline template, then tick the analysis-driven
          recommendations to fold in. Applying writes the whole draft — baseline plus everything you
          ticked — through the confirm-gated review flow.
        </p>
      </div>

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label>Drone</Label>
          <Select value={droneId} onValueChange={setDroneId}>
            <SelectTrigger className="w-72 max-w-full">
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
            <CardContent className="space-y-2 p-4">
              {template.notes && <p className="text-sm">{template.notes}</p>}
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
                          {advanced && r.cliLines && r.cliLines.length > 0 && (
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

          {draftSettings && abVariants && (
            <Card>
              <CardHeader className="p-4">
                <CardTitle className="text-sm">Compare in flight (A/B)</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Two versions of this draft are written into two PID profiles. They share PIDs, feedforward, rates and the
                  gyro filters (those are global); only the D-term filter chain differs, so what you feel on the switch is the
                  filtering-vs-delay trade-off itself.
                </p>
              </CardHeader>
              <CardContent className="space-y-3 p-4 pt-0">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1">
                    <Label>Pair</Label>
                    <Select
                      value={abPair.join("|")}
                      onValueChange={(v) => setAbPair(v.split("|") as [TuneVariant, TuneVariant])}
                    >
                      <SelectTrigger className="w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {AB_PAIRS.map(([a, b]) => (
                          <SelectItem key={`${a}|${b}`} value={`${a}|${b}`}>
                            {shortVariantLabel(a)} vs {shortVariantLabel(b)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {(["A", "B"] as const).map((side, i) => (
                    <div key={side} className="space-y-1">
                      <Label>Profile slot for {side}</Label>
                      <Select
                        value={String(abSlots[i])}
                        onValueChange={(v) => {
                          const next: [number, number] = [...abSlots] as [number, number];
                          next[i] = Number(v);
                          setAbSlots(next);
                        }}
                      >
                        <SelectTrigger className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Array.from({ length: profileCount }, (_, n) => (
                            <SelectItem key={n} value={String(n)}>
                              PID profile {n + 1}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Variant</TableHead>
                      <TableHead>D-term LPF1 (dyn)</TableHead>
                      <TableHead>D-term LPF2</TableHead>
                      <TableHead title="Predicted group delay of the D-term path at 50 Hz, min–max throttle">D-path delay</TableHead>
                      <TableHead>Feel</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {abVariants.map((v) => (
                      <TableRow key={v.side}>
                        <TableCell className="font-medium">{v.label}</TableCell>
                        <TableCell>
                          {v.settings.filters?.dtermLowpassDynMinHz ?? "—"}–{v.settings.filters?.dtermLowpassDynMaxHz ?? "—"} Hz
                        </TableCell>
                        <TableCell>{v.settings.filters?.dtermLowpass2Hz ?? "—"} Hz</TableCell>
                        <TableCell>
                          {v.delay.dtermMs.toFixed(1)}–{v.delay.dtermMsMax.toFixed(1)} ms
                        </TableCell>
                        <TableCell className="max-w-xs text-xs text-muted-foreground">{TUNE_VARIANT_DESCRIPTIONS[v.variant]}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <AbScopeNote a={abVariants[0]!.settings} b={abVariants[1]!.settings} />
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={abSlots[0] === abSlots[1]}
                    onClick={() => {
                      if (!drone) return;
                      start({
                        droneId: drone.id,
                        profileName: "A/B",
                        abKind: "pid",
                        ab: abVariants.map((v, i) => ({ side: v.side, label: v.label, profile: abSlots[i]!, settings: v.settings })),
                      });
                    }}
                  >
                    Write A and B to the FC
                  </Button>
                  {abVariants.map((v, i) => (
                    <Button
                      key={v.side}
                      variant="outline"
                      onClick={() =>
                        void navigator.clipboard
                          .writeText([`profile ${abSlots[i]}`, ...settingsToCli(v.settings), "save", ""].join("\n"))
                          .then(() => {
                            setCopiedVariant(v.side);
                            setTimeout(() => setCopiedVariant(null), 2000);
                          })
                      }
                    >
                      {copiedVariant === v.side ? "Copied" : `Copy CLI for ${v.side}`}
                    </Button>
                  ))}
                  <Button
                    variant="ghost"
                    disabled={abSlots[0] === abSlots[1]}
                    title="Record this pair so the Log Lab can label each flight A or B (done automatically when written over MSP)"
                    onClick={() => void savePair("pid")}
                  >
                    {pairSaved === "pid" ? "Pair saved" : "Save pair for log labels"}
                  </Button>
                </div>
                {abSlots[0] === abSlots[1] && (
                  <p className="text-xs text-destructive">A and B need two different PID profile slots.</p>
                )}
                <p className="text-xs text-muted-foreground">
                  After writing: fly A, land and disarm, switch to profile B (Betaflight 4.5 cannot change PID profiles from a
                  switch in flight — stick command with throttle down and yaw left, then roll left = profile 1, pitch up =
                  profile 2, roll right = profile 3, or the OSD menu → Profiles), fly the same lines again in the same pack.
                  Every arm starts a new blackbox session, so the Log Lab labels A and B and compares them side by side.
                </p>
              </CardContent>
            </Card>
          )}

          {draftSettings && (
            <Card>
              <CardHeader className="p-4">
                <CardTitle className="text-sm">Rate A/B: centre sensitivity (switchable in flight)</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Rate profiles can be switched from a switch mid-flight. A keeps the draft's rates, B raises the centre
                  sensitivity by 30 % with the same max rate and expo — the twitchy-vs-calm-around-centre feel, nothing else.
                </p>
              </CardHeader>
              <CardContent className="space-y-3 p-4 pt-0">
                {!rateVariants ? (
                  <p className="text-xs text-muted-foreground">
                    Needs ACTUAL rates in the draft (the templates use them); with BETAFLIGHT/RACEFLIGHT/KISS rates the
                    centre sensitivity is not one knob.
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-end gap-3">
                      {(["A", "B"] as const).map((side, i) => (
                        <div key={side} className="space-y-1">
                          <Label>Rate profile slot for {side}</Label>
                          <Select
                            value={String(rateSlots[i])}
                            onValueChange={(v) => {
                              const next: [number, number] = [...rateSlots] as [number, number];
                              next[i] = Number(v);
                              setRateSlots(next);
                            }}
                          >
                            <SelectTrigger className="w-36">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {[0, 1, 2, 3].map((n) => (
                                <SelectItem key={n} value={String(n)}>
                                  Rate profile {n + 1}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Variant</TableHead>
                          <TableHead>Centre (deg/s) R / P / Y</TableHead>
                          <TableHead>Max (deg/s) R / P / Y</TableHead>
                          <TableHead>Expo R / P / Y</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rateVariants.map((v) => (
                          <TableRow key={v.side}>
                            <TableCell className="font-medium">{v.label}</TableCell>
                            <TableCell>{rateTriple(v.rates, "rcRate", "rcRatePitch", "rcRateYaw", 10)}</TableCell>
                            <TableCell>{rateTriple(v.rates, "rollRate", "pitchRate", "yawRate", 10)}</TableCell>
                            <TableCell>{rateTriple(v.rates, "rcExpo", "rcExpoPitch", "rcExpoYaw", 0.01)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={rateSlots[0] === rateSlots[1]}
                        onClick={() => {
                          if (!drone) return;
                          start({
                            droneId: drone.id,
                            profileName: "Rate A/B",
                            abKind: "rate",
                            ab: rateVariants.map((v, i) => ({
                              side: v.side,
                              label: v.label,
                              profile: rateSlots[i]!,
                              settings: { rates: v.rates },
                            })),
                          });
                        }}
                      >
                        Write rate A and B to the FC
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() =>
                          void navigator.clipboard
                            .writeText(
                              [
                                ...rateVariants.flatMap((v, i) => [`rateprofile ${rateSlots[i]}`, ...settingsToCli({ rates: v.rates })]),
                                `rateprofile ${rateSlots[0]}`,
                                "save",
                                "",
                              ].join("\n"),
                            )
                            .then(() => {
                              setCopiedVariant("rates");
                              setTimeout(() => setCopiedVariant(null), 2000);
                            })
                        }
                      >
                        {copiedVariant === "rates" ? "Copied" : "Copy CLI for both"}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={rateSlots[0] === rateSlots[1]}
                        title="Record this pair so the Log Lab can label each flight A or B (done automatically when written over MSP)"
                        onClick={() => void savePair("rate")}
                      >
                        {pairSaved === "rate" ? "Pair saved" : "Save pair for log labels"}
                      </Button>
                    </div>
                    {rateSlots[0] === rateSlots[1] && (
                      <p className="text-xs text-destructive">A and B need two different rate profile slots.</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      In flight: put "Rate Profile Selection" (adjustment function 12) on a 3-position switch in Configurator →
                      Adjustments, or CLI <code>adjrange 0 0 &lt;aux&gt; 900 2100 12 &lt;aux&gt; 0 0</code>; low = rate profile 1,
                      middle = 2, high = 3. Fly A, land and disarm, flip, arm and fly B — one blackbox session each, labelled
                      A/B in the Log Lab.
                    </p>
                  </>
                )}
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
                {advanced ? (
                  <>
                    <SettingsTable settings={draftSettings} />
                    <div className="mt-3 rounded-md bg-muted/50 px-3 py-2">
                      <SimplifiedSliders settings={draftSettings} />
                    </div>
                  </>
                ) : (
                  <DraftSummary settings={draftSettings} />
                )}
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
                {saveError && <p className="mt-2 text-sm text-destructive">{saveError}</p>}
                <p className="mt-2 text-xs text-muted-foreground">
                  The draft is the full baseline template{selected.size > 0 ? ` plus ${selected.size} recommendation(s)` : ""} — apply goes
                  through snapshot → diff → confirm → EEPROM save. Copy CLI gives you the same config as
                  Betaflight CLI commands to paste yourself.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

/** Plain-language summary of a draft for Simple mode. */
function DraftSummary({ settings }: { settings: ProfileSettings }) {
  const p = settings.pids;
  const f = settings.filters ?? {};
  const a = settings.advanced ?? {};
  const r = settings.rates ?? {};
  const items: string[] = [];
  if (p?.roll && p.pitch) items.push(`PIDs roll ${p.roll.p}/${p.roll.i}/${p.roll.d}, pitch ${p.pitch.p}/${p.pitch.i}/${p.pitch.d}`);
  if (a.feedforwardRoll !== undefined) items.push(a.feedforwardRoll === 0 ? "No feedforward" : `Feedforward ${a.feedforwardRoll}/${a.feedforwardPitch}`);
  if (f.dynNotchCount !== undefined) items.push(`${f.dynNotchCount} dynamic notch${f.dynNotchCount === 1 ? "" : "es"} ${f.dynNotchMinHz ?? "?"}–${f.dynNotchMaxHz ?? "?"} Hz`);
  if (f.rpmFilterHarmonics !== undefined) items.push(`RPM filter ${f.rpmFilterHarmonics} harmonic${f.rpmFilterHarmonics === 1 ? "" : "s"}`);
  if (f.dtermLowpassDynMinHz !== undefined) items.push(`D-term filtering ${f.dtermLowpassDynMinHz}–${f.dtermLowpassDynMaxHz} Hz + ${f.dtermLowpass2Hz ?? "—"} Hz`);
  if (a.tpaRate !== undefined) items.push(`TPA ${a.tpaRate}% from ${a.tpaBreakpoint}`);
  if (r.rcRate !== undefined && r.rollRate !== undefined) items.push(`Rates ${r.rcRate * 10}°/s centre, ${r.rollRate * 10}°/s max, expo ${((r.rcExpo ?? 0) / 100).toFixed(2)}`);
  return (
    <ul className="grid gap-1 text-sm sm:grid-cols-2">
      {items.map((t) => (
        <li key={t} className="rounded-md bg-muted/50 px-3 py-2">
          {t}
        </li>
      ))}
      <li className="rounded-md px-3 py-2 text-xs text-muted-foreground">Switch on Advanced mode for every value.</li>
    </ul>
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
  // Human labels + display formatting shared with the apply-flow diff.
  for (const [k, v] of Object.entries(settings.filters ?? {})) {
    if (v === undefined) continue;
    rows.push({ label: settingLabel("filters", k), value: formatSettingValue(`filters.${k}`, v) });
  }
  const ratesType = settings.rates?.ratesType;
  for (const [k, v] of Object.entries(settings.rates ?? {})) {
    if (v === undefined) continue;
    rows.push({ label: settingLabel("rates", k), value: formatSettingValue(`rates.${k}`, v, ratesType) });
  }
  for (const [k, v] of Object.entries(settings.advanced ?? {})) {
    if (v === undefined) continue;
    rows.push({ label: settingLabel("advanced", k), value: formatSettingValue(`advanced.${k}`, v) });
  }

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

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { FileUp, Loader2 } from "lucide-react";
import type { AbTest, Analysis, DroneSummary, Flight, FlightLog, LogUploadResult } from "@dronetuner/shared";
import { compareAnalyses, type AnalysisComparison } from "@dronetuner/shared/analysis";
import { matchAbTest } from "@dronetuner/shared/tuning";
import type { SpectrumSeries, TracesResult, WorkerOut } from "@/lib/loglab/traces-worker";
import { apiGet, apiPost } from "@/lib/api";
import {
  formatDate,
  formatDateTime,
  formatDuration,
  formatLogName,
  formatPercent,
  formatSession,
  formatVolts,
} from "@/lib/format";
import { EChart } from "@/components/charts/EChart";
import { useChartTheme, type ChartTheme } from "@/lib/chart-theme";
import { useAdvanced } from "@/lib/ui-store";
import { UplotChart } from "@/components/charts/UplotChart";
import FindingsPanel from "@/components/FindingsPanel";
import RatesAdvisor from "@/components/RatesAdvisor";
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

/** Parse + analyze a log off the main thread; resolves with chart-ready data. */
function runTracesWorker(
  buffer: ArrayBuffer,
  sessionIndex: number,
  onStage: (stage: string) => void,
): Promise<TracesResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../lib/loglab/traces-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data;
      if (msg.type === "progress") {
        onStage(msg.stage);
        return;
      }
      worker.terminate();
      if (msg.type === "done") resolve(msg.result);
      else reject(new Error(msg.message));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "Trace worker failed"));
    };
    worker.postMessage({ buffer, maxFrames: 300_000, sessionIndex }, [buffer]);
  });
}

export default function LogLabPage() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [droneId, setDroneId] = useState<string>("");
  const [selectedLog, setSelectedLog] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceStage, setTraceStage] = useState<string | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [traces, setTraces] = useState<TracesResult | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);

  // Deep link from the drone page: /logs?log=<id>
  useEffect(() => {
    const logParam = searchParams.get("log");
    if (!logParam) return;
    const id = Number(logParam);
    if (!Number.isFinite(id)) return;
    void apiGet<FlightLog>(`/api/logs/${id}`)
      .then((log) => {
        setDroneId(String(log.droneId));
        setSelectedLog(log.id);
      })
      .catch(() => {})
      .finally(() => {
        searchParams.delete("log");
        setSearchParams(searchParams, { replace: true });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: drones } = useQuery({
    queryKey: ["drones"],
    queryFn: () => apiGet<DroneSummary[]>("/api/drones"),
  });
  const { data: logs } = useQuery({
    queryKey: ["logs", droneId],
    enabled: !!droneId,
    queryFn: () => apiGet<FlightLog[]>(`/api/logs?droneId=${droneId}`),
  });
  const analysisQuery = useQuery({
    queryKey: ["analysis", selectedLog],
    enabled: !!selectedLog,
    queryFn: () => apiGet<Analysis>(`/api/logs/${selectedLog}/analysis`),
    retry: false,
  });
  const { data: flights } = useQuery({
    queryKey: ["flights", droneId],
    enabled: !!droneId,
    queryFn: () => apiGet<Flight[]>(`/api/flights?droneId=${droneId}`),
  });

  const drone = drones?.find((d) => String(d.id) === droneId);
  const flightForLog = flights?.find((f) => f.logId === selectedLog);

  // A/B tests written for this drone: each flight's headers are matched
  // against the two variants (D-term chain or rate curve) for an A/B badge.
  const { data: abTests } = useQuery({
    queryKey: ["ab-tests", droneId],
    enabled: !!droneId,
    queryFn: () => apiGet<AbTest[]>(`/api/ab-tests?droneId=${droneId}`),
  });
  const abLabels = useMemo(() => {
    const out = new Map<number, string>();
    if (!logs || !abTests || abTests.length === 0) return out;
    for (const l of logs) {
      const m = matchAbTest(l.headers ?? {}, abTests);
      if (m) out.set(l.id, m.label);
    }
    return out;
  }, [logs, abTests]);

  // Comparison partner: by default the previous flight of the same drone
  // (logs arrive newest-first); for an A/B test the pilot picks the other
  // profile's session explicitly.
  const selectedLogEntry = logs?.find((l) => l.id === selectedLog) ?? null;
  // The partner choice is remembered per selected log: a partner picked for
  // one log makes no sense for the next (it may even be the newly selected
  // log itself), so any other log falls back to "previous".
  const [compareChoice, setCompareChoice] = useState<{ forLog: number | null; value: number | "previous" }>({
    forLog: null,
    value: "previous",
  });
  const compareWith: number | "previous" = compareChoice.forLog === selectedLog ? compareChoice.value : "previous";
  const setCompareWith = (value: number | "previous") => setCompareChoice({ forLog: selectedLog, value });
  const previousLog = useMemo(() => {
    if (!logs || selectedLog === null) return null;
    if (compareWith !== "previous") return logs.find((l) => l.id === compareWith && l.id !== selectedLog) ?? null;
    const idx = logs.findIndex((l) => l.id === selectedLog);
    return idx >= 0 && idx + 1 < logs.length ? logs[idx + 1]! : null;
  }, [logs, selectedLog, compareWith]);
  const prevAnalysisQuery = useQuery({
    queryKey: ["analysis", previousLog?.id],
    enabled: !!previousLog && !!analysisQuery.data,
    queryFn: () => apiGet<Analysis>(`/api/logs/${previousLog!.id}/analysis`),
    retry: false,
  });
  const comparison: AnalysisComparison | null = useMemo(() => {
    if (!analysisQuery.data || !prevAnalysisQuery.data || !selectedLogEntry || !previousLog) return null;
    return compareAnalyses(
      { metrics: analysisQuery.data.metrics, headers: selectedLogEntry.headers ?? {} },
      { metrics: prevAnalysisQuery.data.metrics, headers: previousLog.headers ?? {} },
    );
  }, [analysisQuery.data, prevAnalysisQuery.data, selectedLogEntry, previousLog]);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      form.append("droneId", droneId);
      const res = await fetch("/api/logs", { method: "POST", body: form });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: (result: LogUploadResult) => {
      void qc.invalidateQueries({ queryKey: ["logs", droneId] });
      setUploadNote(
        result.sessionCount > 1
          ? `${result.logs.length} flight${result.logs.length === 1 ? "" : "s"} imported from this file` +
              (result.skippedSessions > 0 ? ` (${result.skippedSessions} short arm/disarm blip${result.skippedSessions === 1 ? "" : "s"} skipped)` : "")
          : null,
      );
      const first = result.logs[0];
      if (first) setSelectedLog(first.id);
    },
  });

  const analyze = (logId: number) => {
    void apiPost(`/api/logs/${logId}/analyze`).then(() =>
      qc.invalidateQueries({ queryKey: ["analysis", logId] }),
    );
  };

  const loadTraces = async (logId: number) => {
    setTraceLoading(true);
    setTraceError(null);
    setTraces(null);
    try {
      const entry = logs?.find((l) => l.id === logId);
      const res = await fetch(`/api/logs/${logId}/file`);
      if (!res.ok) throw new Error(`Log download failed (${res.status})`);
      const buf = await res.arrayBuffer();
      setTraces(await runTracesWorker(buf, entry?.sessionIndex ?? 0, setTraceStage));
    } catch (e) {
      setTraceError(String(e instanceof Error ? e.message : e));
    } finally {
      setTraceLoading(false);
      setTraceStage(null);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Log Lab</h1>
        <p className="text-sm text-muted-foreground">
          Upload a .bbl/.bfl blackbox log, analyze it, and inspect traces, noise spectra and findings.
        </p>
      </div>

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label>Drone</Label>
          <Select value={droneId} onValueChange={(v) => { setDroneId(v); setSelectedLog(null); setTraces(null); setTraceError(null); }}>
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
        <input
          ref={fileRef}
          type="file"
          accept=".bbl,.bfl,.TXT,.txt"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f && droneId) {
              setUploading(true);
              upload.mutate(f, { onSettled: () => setUploading(false) });
            }
          }}
        />
        <Button onClick={() => fileRef.current?.click()} disabled={!droneId || uploading}>
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />} Upload log
        </Button>
        <p className="text-xs text-muted-foreground">
          Don&apos;t have a log yet? See the <a href="/guide" className="text-primary underline">Guide</a>.
        </p>
        {uploadNote && <p className="basis-full text-xs text-muted-foreground">{uploadNote}</p>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">Logs</CardTitle>
          </CardHeader>
          <CardContent className="p-2">
            {!droneId && <p className="p-2 text-sm text-muted-foreground">Select a drone first.</p>}
            {(logs ?? []).length === 0 && droneId && (
              <p className="p-2 text-sm text-muted-foreground">No logs for this drone.</p>
            )}
            <div className="space-y-1">
              {(logs ?? []).map((l) => (
                <button
                  key={l.id}
                  onClick={() => setSelectedLog(l.id)}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    selectedLog === l.id ? "bg-accent" : "hover:bg-accent/50"
                  }`}
                  aria-current={selectedLog === l.id ? "true" : undefined}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium" title={l.originalName ?? undefined}>
                      {formatLogName(l.originalName) ?? formatDate(l.uploadedAt)}
                    </span>
                    {abLabels.get(l.id) && (
                      <Badge variant={abLabels.get(l.id)!.startsWith("A") ? "info" : "success"} className="shrink-0">
                        {abLabels.get(l.id)}
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[formatSession(l.sessionIndex, l.sessionCount), l.durationS != null ? formatDuration(l.durationS) : null, formatDateTime(l.recordedAt ?? l.uploadedAt)]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          {!selectedLog && (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                Select a log to analyze it.
              </CardContent>
            </Card>
          )}

          {selectedLog && (
            <Card>
              <CardHeader className="flex-row items-center justify-between p-4">
                <CardTitle className="text-sm">Analysis</CardTitle>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => analyze(selectedLog)}>
                    {analysisQuery.data ? "Re-analyze" : "Analyze"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void loadTraces(selectedLog)} disabled={traceLoading}>
                    {traceLoading ? (traceStage ?? "Loading…") : "Load traces"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-4">
                {analysisQuery.isLoading && <p className="text-sm text-muted-foreground">Analyzing…</p>}
                {analysisQuery.isError && (
                  <p className="text-sm text-muted-foreground">
                    No analysis yet — click Analyze. (Requires the server to parse the log.)
                  </p>
                )}
                {analysisQuery.data && (
                  <div className="space-y-4">
                    <MetricsCards analysis={analysisQuery.data} />
                    <FilterDelayCard analysis={analysisQuery.data} />
                    <NoiseSourcesCard analysis={analysisQuery.data} />
                    <FindingsPanel findings={analysisQuery.data.findings} />
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {analysisQuery.data && drone && analysisQuery.data.metrics.ratesUsage && (
            <RatesAdvisor
              key={selectedLog}
              usage={analysisQuery.data.metrics.ratesUsage}
              sizeClass={drone.sizeClass}
              initialStyle={flightForLog?.styleTag}
            />
          )}

          {analysisQuery.data && drone && analysisQuery.data.metrics.ratesUsage === undefined && (
            <Card>
              <CardContent className="p-4 text-sm text-muted-foreground">
                Rates advisor: this analysis predates rates-usage extraction — click Re-analyze to compute it.
              </CardContent>
            </Card>
          )}

          {analysisQuery.data && logs && logs.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Label className="text-xs">Compare with</Label>
              <Select value={String(compareWith)} onValueChange={(v) => setCompareWith(v === "previous" ? "previous" : Number(v))}>
                <SelectTrigger className="h-8 w-72 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="previous">Previous flight</SelectItem>
                  {logs
                    .filter((l) => l.id !== selectedLog)
                    .map((l) => (
                      <SelectItem key={l.id} value={String(l.id)}>
                        {[formatLogName(l.originalName) ?? formatDate(l.uploadedAt), formatSession(l.sessionIndex, l.sessionCount)]
                          .filter(Boolean)
                          .join(" · ")}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {previousLog && prevAnalysisQuery.isError && (
                <span className="text-xs text-muted-foreground">That flight has no analysis yet — analyze it first.</span>
              )}
            </div>
          )}

          {comparison && previousLog && (
            <ComparisonCard
              comparison={comparison}
              previousLog={previousLog}
              labels={{ current: abLabels.get(selectedLog!) ?? null, previous: abLabels.get(previousLog.id) ?? null }}
            />
          )}

          {traceError && (
            <Card>
              <CardContent className="p-4 text-sm text-destructive">{traceError}</CardContent>
            </Card>
          )}

          {traces && (traces.truncated || traces.warnings.length > 0) && (
            <Card>
              <CardContent className="space-y-1 p-4">
                {traces.truncated && (
                  <p className="text-sm text-warning">
                    Long log — parsing stopped at the 300k frame cap. Traces and spectra cover the
                    first portion only.
                  </p>
                )}
                {traces.warnings
                  .filter((w) => !w.startsWith("Log truncated"))
                  .map((w) => (
                    <p key={w} className="text-xs text-muted-foreground">
                      {w}
                    </p>
                  ))}
              </CardContent>
            </Card>
          )}

          {traces && <TracesView data={traces} />}
        </div>
      </div>
    </div>
  );
}

function MetricsCards({ analysis }: { analysis: Analysis }) {
  const m = analysis.metrics;
  const cards: { label: string; value: string }[] = [
    { label: "Duration", value: formatDuration(m.durationS) },
    { label: "Sample rate", value: `${m.sampleRateHz} Hz` },
    { label: "Motor saturation", value: formatPercent(m.motorSaturationPercent) },
    { label: "Battery min", value: formatVolts(m.vbatMinV) },
    { label: "Battery sag", value: formatVolts(m.vbatSagV) },
    {
      label: "Filter delay (D path)",
      value: m.filterDelay
        ? `${m.filterDelay.dtermMs.toFixed(1)}–${m.filterDelay.dtermMsMax.toFixed(1)} ms`
        : "—",
    },
    { label: "RPM filter", value: m.rpmFilterActive ? "Active" : "—" },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cards.map((c) => (
        <div key={c.label} className="rounded-lg border p-3">
          <div className="text-xs text-muted-foreground">{c.label}</div>
          <div className="text-sm font-medium">{c.value}</div>
        </div>
      ))}
    </div>
  );
}

/** Pure renderer — all parsing/FFT/step math arrived chart-ready from the worker. */
function TracesView({ data }: { data: TracesResult }) {
  // Rosser's filter view: the raw gyro shows what the filters have to remove,
  // the filtered gyro what still leaks through.
  const hasRaw = data.spectrum.some((s) => s.source === "raw");
  const [spectrumSource, setSpectrumSource] = useState<"raw" | "filtered">(hasRaw ? "raw" : "filtered");
  const shownSpectrum = data.spectrum.filter((s) => s.source === (hasRaw ? spectrumSource : "filtered"));
  const theme = useChartTheme();
  return (
    <div className="space-y-4">
      {data.gyroSeries.map((s) => (
        <Card key={s.axis}>
          <CardHeader className="p-4">
            <CardTitle className="text-sm capitalize">{s.axis} — gyro vs setpoint vs D-term</CardTitle>
          </CardHeader>
          <CardContent className="p-2">
            <UplotChart
              x={s.x}
              yLabel="deg/s"
              series={[
                { label: "gyro", data: s.gyro, stroke: theme.series[0] },
                { label: "setpoint", data: s.setpoint, stroke: theme.series[1] },
                { label: "D-term (raw)", data: s.dterm, stroke: theme.series[2], scale: "d" },
              ]}
            />
          </CardContent>
        </Card>
      ))}

      {data.stepSeries.length > 0 && (
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">Step response (normalized)</CardTitle>
            <p className="text-xs text-muted-foreground">
              {data.stepSeries
                .map((s) =>
                  s.method === "deconvolution"
                    ? `${s.axis}: system identification over ${s.count} windows`
                    : `${s.axis}: ${s.count} stick step${s.count === 1 ? "" : "s"}`,
                )
                .join(" · ")}
            </p>
          </CardHeader>
          <CardContent className="p-2">
            <UplotChart
              x={data.stepSeries[0]!.tMs}
              xLabel="t (ms)"
              yLabel="× setpoint"
              series={data.stepSeries.map((s, i) => ({
                label: s.axis,
                data: s.response,
                stroke: theme.series[i % theme.series.length],
              }))}
            />
          </CardContent>
        </Card>
      )}

      {shownSpectrum.length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center justify-between p-4">
            <CardTitle className="text-sm">
              Gyro noise spectrum (airborne average, {spectrumSource === "raw" && hasRaw ? "raw gyro" : "filtered gyro"})
            </CardTitle>
            {hasRaw && (
              <div className="flex gap-1">
                {(["raw", "filtered"] as const).map((src) => (
                  <Button
                    key={src}
                    size="sm"
                    variant={spectrumSource === src ? "default" : "outline"}
                    onClick={() => setSpectrumSource(src)}
                  >
                    {src === "raw" ? "Raw" : "Filtered"}
                  </Button>
                ))}
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-2 p-2">
            <EChart option={buildSpectrumOption(shownSpectrum, theme)} height={300} />
            <p className="px-2 text-xs text-muted-foreground">
              {spectrumSource === "raw" && hasRaw
                ? "The pre-filter gyro (gyroUnfilt): the noise the filters must remove — motor lines for the RPM filter, fixed stripes for the dynamic notch (Rosser's frequency-vs-throttle view)."
                : "The filtered gyro (gyroADC): what still gets through the filter chain — anything marked here is leaking."}{" "}
              Markers: <span className="text-warning">frame resonance → dynamic notch</span>,{" "}
              <span className="text-info">motor harmonic → RPM filter</span>,{" "}
              <span className="text-chart-2">idle-speed motor noise → rpm_filter_min_hz / dynamic idle</span>.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Averaged airborne spectrum per axis with classified-peak markers. */
function buildSpectrumOption(spectrum: SpectrumSeries[], t: ChartTheme) {
  const colors = t.series;
  return {
    backgroundColor: "transparent",
    textStyle: { color: t.text },
    tooltip: { trigger: "axis" as const },
    legend: { textStyle: { color: t.text }, data: spectrum.map((s) => s.axis) },
    grid: { left: 60, right: 20, top: 40, bottom: 40 },
    xAxis: { type: "value" as const, name: "Hz", nameTextStyle: { color: t.text }, axisLabel: { color: t.text }, splitLine: { lineStyle: { color: t.grid } } },
    yAxis: { type: "value" as const, name: "amplitude", nameTextStyle: { color: t.text }, axisLabel: { color: t.text }, splitLine: { lineStyle: { color: t.grid } } },
    series: spectrum.map((s, i) => ({
      name: s.axis,
      type: "line" as const,
      data: s.freqs.map((f, j) => [f, s.mags[j]!] as [number, number]),
      showSymbol: false,
      lineStyle: { color: colors[i] },
      itemStyle: { color: colors[i] },
      markLine: {
        silent: true,
        symbol: "none",
        data: s.peaks
          .filter((p) => p.kind !== "unknown")
          .map((p) => ({
            xAxis: p.freqHz,
            label: { formatter: `${p.freqHz} Hz`, color: t.text },
            lineStyle: {
              color: p.kind === "frameResonance" ? t.warning : p.kind === "motorIdle" ? t.accent : t.info,
              type: "dashed" as const,
            },
          })),
      },
    })),
  };
}

/** Per-stage group-delay breakdown of the filter chain flown in this log. */
function FilterDelayCard({ analysis }: { analysis: Analysis }) {
  const advanced = useAdvanced();
  const d = analysis.metrics.filterDelay;
  if (!d) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Filter delay: this analysis predates the delay estimator — click Re-analyze to compute it.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="p-4">
        <CardTitle className="text-sm">
          Filter delay @ {d.referenceFreqHz} Hz — gyro {d.gyroMs.toFixed(1)}–{d.gyroMsMax.toFixed(1)} ms, D path{" "}
          {d.dtermMs.toFixed(1)}–{d.dtermMsMax.toFixed(1)} ms
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <p className="mb-2 text-xs text-muted-foreground">
          Group delay of the filter chain from this log&apos;s config (ranges span 0–100% throttle for dynamic
          lowpasses). Lower = snappier; well-tuned builds land around 3–5 ms on the D path.
        </p>
        {advanced ? (
          <div className="space-y-1">
            {d.stages.map((s) => (
              <div key={s.name} className="flex items-center justify-between text-sm">
                <span>{s.name}</span>
                <span className="text-muted-foreground">{s.ms.toFixed(2)} ms</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {d.stages.length > 0
              ? `Biggest contributor: ${d.stages.reduce((a, b) => (a.ms > b.ms ? a : b)).name}.`
              : "No filter stage is active."}{" "}
            Switch on Advanced mode for the per-stage breakdown.
          </p>
        )}
        {d.warnings.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">{d.warnings.join(" ")}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** Classified noise sources: frame resonances (dyn notch) vs motor harmonics (RPM filter), raw and filtered. */
function NoiseSourcesCard({ analysis }: { analysis: Analysis }) {
  const spectral = analysis.metrics.spectral;
  if (!spectral) return null;
  const raw = analysis.metrics.spectralRaw;
  const rows = spectral.flatMap((s) =>
    s.peaks.map((p) => ({ axis: s.axis, ...p })),
  );
  const rawRows = (raw ?? []).flatMap((s) => s.peaks.filter((p) => p.ratioToFloor > 4).map((p) => ({ axis: s.axis, ...p })));
  const onsets = (raw ?? spectral).map((s) => s.motorNoiseOnsetHz).filter((v): v is number => v !== null);
  const harmonics = (raw ?? []).map((s) => s.harmonicRatios).filter((h): h is [number, number, number] => !!h);
  if (rows.length === 0 && rawRows.length === 0 && onsets.length === 0) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          No significant noise sources classified — clean log.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="p-4">
        <CardTitle className="text-sm">Noise sources (frequency vs throttle)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        {raw && (
          <div>
            <p className="mb-1 text-xs font-medium">Raw gyro — what the filters have to remove</p>
            {rawRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">No motor line or frame stripe above 4× the floor in the raw gyro.</p>
            ) : (
              <div className="space-y-1">
                {rawRows.map((p, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 text-sm">
                    <span className="capitalize">{p.axis}</span>
                    <span>{Math.round(p.freqHz)} Hz</span>
                    <span className="text-muted-foreground">{p.ratioToFloor.toFixed(0)}× floor</span>
                    <span className={p.kind === "frameResonance" ? "text-warning" : p.kind === "motorHarmonic" ? "text-info" : "text-muted-foreground"}>
                      {p.kind === "frameResonance"
                        ? "frame stripe → dynamic notch"
                        : p.kind === "motorHarmonic"
                          ? `motor ${p.harmonic ? `${p.harmonic}${p.harmonic === 1 ? "st" : p.harmonic === 2 ? "nd" : "rd"} harmonic` : "line"}${p.aliased ? " (folded)" : ""} → RPM filter`
                          : p.kind === "motorIdle"
                            ? "idle-speed motor noise"
                            : "unclassified"}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {harmonics.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Motor harmonics 1st / 2nd / 3rd at{" "}
                {[0, 1, 2].map((k) => Math.max(...harmonics.map((h) => h[k]!)).toFixed(0)).join(" / ")}× the floor (raw) — the
                weights the RPM filter needs.
              </p>
            )}
          </div>
        )}
        <div>
          <p className="mb-1 text-xs font-medium">{raw ? "Filtered gyro — what still leaks through" : "Filtered gyro"}</p>
          {rows.length === 0 && <p className="text-xs text-muted-foreground">Nothing above 4× the floor leaks through the filter chain.</p>}
        <div className="space-y-1">
          {rows.map((p, i) => (
            <div key={i} className="flex items-center justify-between gap-2 text-sm">
              <span className="capitalize">{p.axis}</span>
              <span>{Math.round(p.freqHz)} Hz</span>
              <span className="text-muted-foreground">{p.ratioToFloor.toFixed(1)}× floor</span>
              <span
                className={
                  p.kind === "frameResonance"
                    ? "text-warning"
                    : p.kind === "motorHarmonic"
                      ? "text-info"
                      : "text-muted-foreground"
                }
              >
                {p.kind === "frameResonance" ? "frame resonance leaks → notch not covering it" : p.kind === "motorHarmonic" ? "motor harmonic leaks → RPM notch too narrow / few" : p.kind === "motorIdle" ? "idle-speed motor noise" : "unclassified"}
              </span>
            </div>
          ))}
        </div>
        </div>
        {onsets.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Motor noise onset ≈ {Math.round(Math.min(...onsets))} Hz{raw ? " (raw gyro)" : ""} — RPM filters should be at full strength
            just above this.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Current vs previous blackbox: settings that changed + resulting metric movement. */
function ComparisonCard({
  comparison,
  previousLog,
  labels,
}: {
  comparison: AnalysisComparison;
  previousLog: FlightLog;
  /** A/B labels of the selected and the partner flight, when they belong to a recorded A/B test */
  labels?: { current: string | null; previous: string | null };
}) {
  const isAb = !!labels?.current && !!labels?.previous;
  return (
    <Card>
      <CardHeader className="p-4">
        <CardTitle className="text-sm">
          {isAb ? (
            <span className="flex flex-wrap items-center gap-2">
              <Badge variant={labels!.current!.startsWith("A") ? "info" : "success"}>{labels!.current}</Badge>
              <span>vs</span>
              <Badge variant={labels!.previous!.startsWith("A") ? "info" : "success"}>{labels!.previous}</Badge>
              <span className="font-normal text-muted-foreground">
                ({formatSession(previousLog.sessionIndex, previousLog.sessionCount) ?? formatLogName(previousLog.originalName) ?? formatDate(previousLog.uploadedAt)}
                {previousLog.recordedAt ? `, ${formatDateTime(previousLog.recordedAt)}` : ""})
              </span>
            </span>
          ) : (
            <>
              vs previous flight ({formatSession(previousLog.sessionIndex, previousLog.sessionCount) ?? formatLogName(previousLog.originalName) ?? formatDate(previousLog.uploadedAt)}
              {previousLog.recordedAt ? `, ${formatDateTime(previousLog.recordedAt)}` : ""})
            </>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        {comparison.settingChanges.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Settings changed</div>
            <div className="space-y-1">
              {comparison.settingChanges.map((c) => (
                <div key={c.key} className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-mono text-xs">{c.key}</span>
                  <span>
                    {c.from} → <span className="font-medium">{c.to}</span>
                  </span>
                </div>
              ))}
            </div>
            {comparison.otherChangesCount > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                + {comparison.otherChangesCount} other setting(s) changed
              </p>
            )}
          </div>
        )}
        {comparison.metricDeltas.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              Results — {comparison.metricDeltas.filter((d) => d.verdict === "better").length} better,{" "}
              {comparison.metricDeltas.filter((d) => d.verdict === "worse").length} worse
            </div>
            <div className="space-y-1">
              {comparison.metricDeltas.map((d) => (
                <div key={d.label} className="flex items-center justify-between gap-2 text-sm">
                  <span className="capitalize">{d.label}</span>
                  <span>
                    {d.from} → {d.to}{" "}
                    <span
                      className={
                        d.verdict === "better"
                          ? "text-success"
                          : d.verdict === "worse"
                            ? "text-destructive"
                            : "text-muted-foreground"
                      }
                    >
                      {d.verdict === "better" ? "▲ better" : d.verdict === "worse" ? "▼ worse" : "•"}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {comparison.settingChanges.length === 0 && comparison.metricDeltas.length === 0 && (
          <p className="text-sm text-muted-foreground">No comparable changes between these two logs.</p>
        )}
        {comparison.warnings.map((w) => (
          <p key={w} className="text-xs text-muted-foreground">
            {w}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

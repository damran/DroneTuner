import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { FileUp, Loader2 } from "lucide-react";
import type { Analysis, DroneSummary, Flight, FlightLog } from "@dronetuner/shared";
import { compareAnalyses, type AnalysisComparison } from "@dronetuner/shared/analysis";
import type { SpectrumSeries, TracesResult, WorkerOut } from "@/lib/loglab/traces-worker";
import { apiGet, apiPost } from "@/lib/api";
import { formatDate, formatDuration, formatPercent, formatVolts } from "@/lib/format";
import { EChart } from "@/components/charts/EChart";
import { UplotChart } from "@/components/charts/UplotChart";
import FindingsPanel from "@/components/FindingsPanel";
import RatesAdvisor from "@/components/RatesAdvisor";
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
function runTracesWorker(buffer: ArrayBuffer, onStage: (stage: string) => void): Promise<TracesResult> {
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
    worker.postMessage({ buffer, maxFrames: 300_000 }, [buffer]);
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

  // Previous log of the same drone (logs arrive newest-first) for the
  // "current vs last blackbox" comparison.
  const selectedLogEntry = logs?.find((l) => l.id === selectedLog) ?? null;
  const previousLog = useMemo(() => {
    if (!logs || selectedLog === null) return null;
    const idx = logs.findIndex((l) => l.id === selectedLog);
    return idx >= 0 && idx + 1 < logs.length ? logs[idx + 1]! : null;
  }, [logs, selectedLog]);
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
    onSuccess: (log: FlightLog) => {
      void qc.invalidateQueries({ queryKey: ["logs", droneId] });
      setSelectedLog(log.id);
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
      const res = await fetch(`/api/logs/${logId}/file`);
      if (!res.ok) throw new Error(`Log download failed (${res.status})`);
      const buf = await res.arrayBuffer();
      setTraces(await runTracesWorker(buf, setTraceStage));
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
                  className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                    selectedLog === l.id ? "bg-accent" : "hover:bg-accent/50"
                  }`}
                >
                  <div className="font-medium">{formatDate(l.uploadedAt)}</div>
                  <div className="text-xs text-muted-foreground">{l.headers?.["Firmware revision"] ?? "unknown firmware"}</div>
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

          {comparison && previousLog && (
            <ComparisonCard comparison={comparison} previousLog={previousLog} />
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
                  <p className="text-sm text-amber-500">
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
                { label: "gyro", data: s.gyro, stroke: "#22d3ee" },
                { label: "setpoint", data: s.setpoint, stroke: "#a78bfa" },
                { label: "D-term (raw)", data: s.dterm, stroke: "#f472b6", scale: "d" },
              ]}
            />
          </CardContent>
        </Card>
      ))}

      {data.stepSeries.length > 0 && (
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">Step response (normalized, averaged over stick steps)</CardTitle>
          </CardHeader>
          <CardContent className="p-2">
            <UplotChart
              x={data.stepSeries[0]!.tMs}
              xLabel="t (ms)"
              yLabel="× setpoint"
              series={data.stepSeries.map((s, i) => ({
                label: s.axis,
                data: s.response,
                stroke: ["#22d3ee", "#a78bfa", "#f472b6"][i],
              }))}
            />
          </CardContent>
        </Card>
      )}

      {data.spectrum.length > 0 && (
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">Gyro noise spectrum (airborne average)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 p-2">
            <EChart option={buildSpectrumOption(data.spectrum)} height={300} />
            <p className="px-2 text-xs text-muted-foreground">
              Averaged over airborne spectrogram windows — the same analysis the findings use.
              Markers: <span className="text-amber-500">frame resonance → dynamic notch</span>,{" "}
              <span className="text-sky-400">motor harmonic → RPM filter</span>.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Averaged airborne spectrum per axis with classified-peak markers. */
function buildSpectrumOption(spectrum: SpectrumSeries[]) {
  const colors = ["#22d3ee", "#a78bfa", "#f472b6"];
  return {
    backgroundColor: "transparent",
    textStyle: { color: "#9ca3af" },
    tooltip: { trigger: "axis" as const },
    legend: { textStyle: { color: "#9ca3af" }, data: spectrum.map((s) => s.axis) },
    grid: { left: 60, right: 20, top: 40, bottom: 40 },
    xAxis: { type: "value" as const, name: "Hz", nameTextStyle: { color: "#9ca3af" }, axisLabel: { color: "#9ca3af" } },
    yAxis: { type: "value" as const, name: "amplitude", nameTextStyle: { color: "#9ca3af" }, axisLabel: { color: "#9ca3af" } },
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
            label: { formatter: `${p.freqHz} Hz`, color: "#9ca3af" },
            lineStyle: {
              color: p.kind === "frameResonance" ? "#f59e0b" : "#38bdf8",
              type: "dashed" as const,
            },
          })),
      },
    })),
  };
}

/** Per-stage group-delay breakdown of the filter chain flown in this log. */
function FilterDelayCard({ analysis }: { analysis: Analysis }) {
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
        <div className="space-y-1">
          {d.stages.map((s) => (
            <div key={s.name} className="flex items-center justify-between text-sm">
              <span>{s.name}</span>
              <span className="text-muted-foreground">{s.ms.toFixed(2)} ms</span>
            </div>
          ))}
        </div>
        {d.warnings.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">{d.warnings.join(" ")}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** Classified noise sources: frame resonances (dyn notch) vs motor harmonics (RPM filter). */
function NoiseSourcesCard({ analysis }: { analysis: Analysis }) {
  const spectral = analysis.metrics.spectral;
  if (!spectral) return null;
  const rows = spectral.flatMap((s) =>
    s.peaks.map((p) => ({ axis: s.axis, ...p })),
  );
  const onsets = spectral.map((s) => s.motorNoiseOnsetHz).filter((v): v is number => v !== null);
  if (rows.length === 0 && onsets.length === 0) {
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
      <CardContent className="p-4 pt-0">
        <div className="space-y-1">
          {rows.map((p, i) => (
            <div key={i} className="flex items-center justify-between gap-2 text-sm">
              <span className="capitalize">{p.axis}</span>
              <span>{Math.round(p.freqHz)} Hz</span>
              <span className="text-muted-foreground">{p.ratioToFloor.toFixed(1)}× floor</span>
              <span
                className={
                  p.kind === "frameResonance"
                    ? "text-amber-500"
                    : p.kind === "motorHarmonic"
                      ? "text-sky-400"
                      : "text-muted-foreground"
                }
              >
                {p.kind === "frameResonance" ? "frame resonance → dyn notch" : p.kind === "motorHarmonic" ? "motor harmonic → RPM filter" : "unclassified"}
              </span>
            </div>
          ))}
        </div>
        {onsets.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Motor noise onset ≈ {Math.round(Math.min(...onsets))} Hz — RPM filters should be at full strength
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
}: {
  comparison: AnalysisComparison;
  previousLog: FlightLog;
}) {
  return (
    <Card>
      <CardHeader className="p-4">
        <CardTitle className="text-sm">vs previous log ({formatDate(previousLog.uploadedAt)})</CardTitle>
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
            <div className="mb-1 text-xs font-medium text-muted-foreground">Results</div>
            <div className="space-y-1">
              {comparison.metricDeltas.map((d) => (
                <div key={d.label} className="flex items-center justify-between gap-2 text-sm">
                  <span className="capitalize">{d.label}</span>
                  <span>
                    {d.from} → {d.to}{" "}
                    <span
                      className={
                        d.verdict === "better"
                          ? "text-emerald-500"
                          : d.verdict === "worse"
                            ? "text-red-500"
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

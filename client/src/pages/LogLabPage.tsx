import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { FileUp, Loader2 } from "lucide-react";
import type { Analysis, DroneSummary, FlightLog } from "@dronetuner/shared";
import { parseBlackboxLog } from "@dronetuner/shared/blackbox";
import { amplitudeSpectrum, averageStepResponse, detectSteps, findPeaks } from "@dronetuner/shared/analysis";
import type { ParsedLog } from "@dronetuner/shared/blackbox";
import { apiGet, apiPost } from "@/lib/api";
import { formatDate, formatDuration, formatPercent, formatVolts } from "@/lib/format";
import { EChart } from "@/components/charts/EChart";
import { UplotChart } from "@/components/charts/UplotChart";
import FindingsPanel from "@/components/FindingsPanel";
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

const AXES = ["roll", "pitch", "yaw"] as const;

export default function LogLabPage() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [droneId, setDroneId] = useState<string>("");
  const [selectedLog, setSelectedLog] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [traceLoading, setTraceLoading] = useState(false);
  const [parsed, setParsed] = useState<ParsedLog | null>(null);

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
    setParsed(null);
    try {
      const res = await fetch(`/api/logs/${logId}/file`);
      const buf = await res.arrayBuffer();
      const p = parseBlackboxLog(new Uint8Array(buf), { maxFrames: 300_000 });
      setParsed(p);
    } catch (e) {
      alert(`Could not parse log: ${String(e)}`);
    } finally {
      setTraceLoading(false);
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
          <Select value={droneId} onValueChange={(v) => { setDroneId(v); setSelectedLog(null); setParsed(null); }}>
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
                    {traceLoading ? "Loading…" : "Load traces"}
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
                    <FindingsPanel findings={analysisQuery.data.findings} />
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {parsed && <TracesView parsed={parsed} />}
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
    { label: "Filter latency (est.)", value: m.filterLatencyMs != null ? `${m.filterLatencyMs} ms` : "—" },
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

function TracesView({ parsed }: { parsed: ParsedLog }) {
  // Heavy computations (downsampling, FFT, step detection) run once per log.
  const data = useMemo(() => {
    const gyroScale = parsed.gyroScale ?? 1;
    const sampleRate = 1e6 / medianDt(parsed.timeUs);

    const gyroSeries = AXES.map((axis, i) => {
      const raw = parsed.channels[`gyroADC[${i}]`];
      const setpoint = parsed.channels[`setpoint[${i}]`];
      const dterm = parsed.channels[`axisD[${i}]`];
      if (!raw && !setpoint && !dterm) return null;
      // Build a shared x axis from whichever channel is present; missing
      // channels become null-filled so uPlot always gets equal lengths.
      const base = raw ?? setpoint ?? dterm;
      const { x } = downsample(base, sampleRate, 4000, 1);
      const withNulls = (y: number[], present: boolean): (number | null)[] =>
        present ? y : new Array<number | null>(x.length).fill(null);
      const gyro = withNulls(downsample(raw, sampleRate, 4000, gyroScale).y, !!raw);
      const sp = withNulls(downsample(setpoint, sampleRate, 4000, 1).y, !!setpoint);
      // axisD is in raw PID-sum units — plot unscaled on its own axis.
      const d = withNulls(downsample(dterm, sampleRate, 4000, 1).y, !!dterm);
      return { axis, x, gyro, sp, d };
    }).filter((s): s is NonNullable<typeof s> => s !== null && s.x.length > 0);

    const stepSeries = AXES.map((axis, i) => {
      const raw = parsed.channels[`gyroADC[${i}]`];
      const setpoint = parsed.channels[`setpoint[${i}]`];
      if (!raw || !setpoint || sampleRate <= 0) return null;
      const gyro = parsed.gyroScale ? raw.map((v) => v * parsed.gyroScale!) : raw;
      const steps = detectSteps(setpoint, sampleRate);
      const avg = averageStepResponse(gyro, setpoint, steps, sampleRate);
      return avg ? { axis, avg } : null;
    }).filter((s): s is NonNullable<typeof s> => s !== null);

    const fftOption = buildFftOption(parsed, sampleRate);
    return { gyroSeries, stepSeries, fftOption };
  }, [parsed]);

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
                { label: "setpoint", data: s.sp, stroke: "#a78bfa" },
                { label: "D-term (raw)", data: s.d, stroke: "#f472b6", scale: "d" },
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
              x={data.stepSeries[0]!.avg.tMs}
              xLabel="t (ms)"
              yLabel="× setpoint"
              series={data.stepSeries.map((s, i) => ({
                label: s.axis,
                data: s.avg.response,
                stroke: ["#22d3ee", "#a78bfa", "#f472b6"][i],
              }))}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="p-4">
          <CardTitle className="text-sm">Gyro noise spectrum (FFT)</CardTitle>
        </CardHeader>
        <CardContent className="p-2">
          <EChart option={data.fftOption} height={300} />
        </CardContent>
      </Card>
    </div>
  );
}

function medianDt(timeUs: Float32Array): number {
  if (timeUs.length < 8) return 1000;
  const dts: number[] = [];
  for (let i = 1; i < Math.min(timeUs.length, 2000); i++) {
    const dt = timeUs[i]! - timeUs[i - 1]!;
    if (dt > 0) dts.push(dt);
  }
  dts.sort((a, b) => a - b);
  return dts[dts.length >> 1] ?? 1000;
}

function downsample(
  data: Float32Array | undefined,
  sampleRate: number,
  maxPoints: number,
  scale: number,
): { x: number[]; y: number[] } {
  if (!data || data.length === 0) return { x: [], y: [] };
  const step = Math.max(1, Math.floor(data.length / maxPoints));
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < data.length; i += step) {
    x.push(i / sampleRate);
    y.push(data[i]! * scale);
  }
  return { x, y };
}

function buildFftOption(parsed: ParsedLog, sampleRate: number) {
  const gyroScale = parsed.gyroScale ?? 1;
  const series: { name: string; type: "line"; data: [number, number][]; showSymbol: false }[] = [];
  const colors = ["#22d3ee", "#a78bfa", "#f472b6"];
  AXES.forEach((axis, i) => {
    const raw = parsed.channels[`gyroADC[${i}]`];
    if (!raw || raw.length < 256 || sampleRate <= 0) return;
    const gyro = new Float32Array(raw.length);
    for (let j = 0; j < raw.length; j++) gyro[j] = raw[j]! * gyroScale;
    // Same middle-of-flight window the server-side metrics use, so the chart
    // matches the reported peaks.
    const fftSize = Math.min(16384, gyro.length);
    const spec = amplitudeSpectrum(gyro, sampleRate, {
      maxSize: fftSize,
      offset: Math.max(0, Math.floor((gyro.length - fftSize) / 2)),
    });
    const peaks = findPeaks(spec, {
      minFreqHz: 20,
      maxFreqHz: Math.min(600, sampleRate / 2),
      maxPeaks: 3,
      prominenceRatio: 4,
    });
    const data: [number, number][] = [];
    for (let b = 1; b < spec.binCount; b++) {
      if (spec.freqs[b]! > 600) break;
      data.push([Number(spec.freqs[b]!.toFixed(1)), Number(spec.magnitudes[b]!.toFixed(2))]);
    }
    series.push({ name: `${axis}${peaks.length ? ` (peaks: ${peaks.map((p) => `${Math.round(p.freqHz)}Hz`).join(", ")})` : ""}`, type: "line", data, showSymbol: false });
  });
  return {
    backgroundColor: "transparent",
    textStyle: { color: "#9ca3af" },
    tooltip: { trigger: "axis" as const },
    legend: { textStyle: { color: "#9ca3af" }, data: series.map((s) => s.name) },
    grid: { left: 60, right: 20, top: 40, bottom: 40 },
    xAxis: { type: "value" as const, name: "Hz", nameTextStyle: { color: "#9ca3af" }, axisLabel: { color: "#9ca3af" } },
    yAxis: { type: "value" as const, name: "amplitude", nameTextStyle: { color: "#9ca3af" }, axisLabel: { color: "#9ca3af" } },
    series: series.map((s, i) => ({ ...s, lineStyle: { color: colors[i] }, itemStyle: { color: colors[i] } })),
  };
}

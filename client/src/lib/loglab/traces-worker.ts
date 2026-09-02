/// <reference lib="webworker" />
/**
 * Log Lab trace worker: parsing a blackbox log (up to 300k frames) plus the
 * FFT/step analysis is far too heavy for the render path — it runs here off
 * the main thread and posts back plain, chart-ready arrays.
 */
import { parseBlackboxLog } from "@dronetuner/shared/blackbox";
import type { PeakKind } from "@dronetuner/shared/analysis";
import {
  airborneMask,
  averageStepResponse,
  classifyPeaks,
  computeSpectrogram,
  detectSteps,
  meanErpmHzChannel,
  scaledGyroChannel,
  throttleChannel,
} from "@dronetuner/shared/analysis";

const AXES = ["roll", "pitch", "yaw"] as const;
type AxisName = (typeof AXES)[number];

export interface TraceSeries {
  axis: AxisName;
  x: number[];
  gyro: (number | null)[];
  setpoint: (number | null)[];
  dterm: (number | null)[];
}

export interface StepSeries {
  axis: AxisName;
  tMs: number[];
  response: number[];
}

export interface SpectrumPeak {
  freqHz: number;
  kind: PeakKind;
}

export interface SpectrumSeries {
  axis: AxisName;
  freqs: number[];
  mags: number[];
  peaks: SpectrumPeak[];
}

export interface TracesResult {
  /** true when parsing stopped at the frame cap — drives the truncation banner */
  truncated: boolean;
  warnings: string[];
  gyroSeries: TraceSeries[];
  stepSeries: StepSeries[];
  spectrum: SpectrumSeries[];
}

export type WorkerOut =
  | { type: "progress"; stage: string }
  | { type: "done"; result: TracesResult }
  | { type: "error"; message: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<{ buffer: ArrayBuffer; maxFrames: number; sessionIndex: number }>) => void) | null;
  postMessage: (msg: WorkerOut, transfer?: Transferable[]) => void;
};

/**
 * Min/max decimation: exactly two points per bucket (min then max). Stride
 * sampling an 8 kHz gyro trace down to a few thousand points aliases —
 * oscillations vanish or appear where none exist. The min/max envelope
 * preserves them. The fixed 2-points-per-bucket shape matters: channels are
 * decimated independently but rendered against a shared x, so lengths must
 * be identical even for piecewise-constant channels (setpoint pinned at 0).
 */
function minMaxDecimate(
  data: Float32Array | undefined,
  sampleRate: number,
  maxBuckets: number,
  scale: number,
): { x: number[]; y: number[] } {
  if (!data || data.length === 0 || sampleRate <= 0) return { x: [], y: [] };
  const buckets = Math.min(maxBuckets, Math.ceil(data.length / 2));
  const per = data.length / buckets;
  const x: number[] = [];
  const y: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(data.length, Math.max(start + 1, Math.floor((b + 1) * per)));
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = start; i < end; i++) {
      const v = data[i]! * scale;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    x.push(start / sampleRate, (end - 1) / sampleRate);
    y.push(mn, mx);
  }
  return { x, y };
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

ctx.onmessage = (e) => {
  try {
    ctx.postMessage({ type: "progress", stage: "Parsing log…" });
    const parsed = parseBlackboxLog(new Uint8Array(e.data.buffer), {
      maxFrames: e.data.maxFrames,
      sessionIndex: e.data.sessionIndex,
    });

    ctx.postMessage({ type: "progress", stage: "Computing traces…" });
    const sampleRate = 1e6 / medianDt(parsed.timeUs);

    const gyroSeries: TraceSeries[] = [];
    for (let i = 0; i < AXES.length; i++) {
      // Shared channel helpers keep the chart and the server-side findings
      // on the same scaling/selection rules as computeMetrics.
      const gyro = scaledGyroChannel(parsed, i);
      const setpoint = parsed.channels[`setpoint[${i}]`];
      const dterm = parsed.channels[`axisD[${i}]`];
      if (!gyro && !setpoint && !dterm) continue;
      // Shared x axis from whichever channel is present; missing channels
      // become null-filled so uPlot always gets equal lengths.
      const base = gyro ?? setpoint ?? dterm!;
      const { x } = minMaxDecimate(base, sampleRate, 4000, 1);
      const withNulls = (y: number[], present: boolean): (number | null)[] =>
        present ? y : new Array<number | null>(x.length).fill(null);
      gyroSeries.push({
        axis: AXES[i]!,
        x,
        gyro: withNulls(minMaxDecimate(gyro, sampleRate, 4000, 1).y, !!gyro),
        setpoint: withNulls(minMaxDecimate(setpoint, sampleRate, 4000, 1).y, !!setpoint),
        // axisD is in raw PID-sum units — plot unscaled on its own axis.
        dterm: withNulls(minMaxDecimate(dterm, sampleRate, 4000, 1).y, !!dterm),
      });
    }

    const stepSeries: StepSeries[] = [];
    for (let i = 0; i < AXES.length; i++) {
      const gyro = scaledGyroChannel(parsed, i);
      const setpoint = parsed.channels[`setpoint[${i}]`];
      if (!gyro || !setpoint || sampleRate <= 0) continue;
      const steps = detectSteps(setpoint, sampleRate);
      const avg = averageStepResponse(gyro, setpoint, steps, sampleRate);
      if (avg) stepSeries.push({ axis: AXES[i]!, tMs: avg.tMs, response: avg.response });
    }

    ctx.postMessage({ type: "progress", stage: "Computing noise spectrum…" });
    // Averaged airborne spectrogram per axis — the same data source the
    // server-side findings come from, so the chart and the findings agree.
    // (A single mid-flight FFT smears throttle-swept motor ridges into
    // fake "peaks"; the spectrogram keeps them separate.)
    const mask = airborneMask(parsed);
    const throttle = throttleChannel(parsed);
    const erpmHz = meanErpmHzChannel(parsed);
    const spectrum: SpectrumSeries[] = [];
    for (let i = 0; i < AXES.length; i++) {
      const gyro = scaledGyroChannel(parsed, i);
      if (!gyro || gyro.length < 256 || sampleRate <= 0) continue;
      const sg = computeSpectrogram(gyro, sampleRate, {
        mask,
        throttle,
        erpmHz: erpmHz ?? undefined,
      });
      if (sg.rows.length === 0) continue;
      const bins = sg.rows[0]!.mags.length;
      const avg = new Float64Array(bins);
      for (const row of sg.rows) {
        for (let b = 0; b < bins; b++) avg[b] += row.mags[b]!;
      }
      const freqs: number[] = [];
      const mags: number[] = [];
      for (let b = 1; b < bins; b++) {
        const f = sg.rows[0]!.freqs[b]!;
        if (f > 600) break;
        freqs.push(Number(f.toFixed(1)));
        mags.push(Number((avg[b]! / sg.rows.length).toFixed(2)));
      }
      const classified = classifyPeaks(AXES[i]!, sg, {
        minFreqHz: 40,
        maxFreqHz: Math.min(800, sampleRate / 2),
      });
      spectrum.push({
        axis: AXES[i]!,
        freqs,
        mags,
        peaks: classified.peaks.map((p) => ({ freqHz: Math.round(p.freqHz), kind: p.kind })),
      });
    }

    ctx.postMessage({
      type: "done",
      result: {
        truncated: parsed.truncated,
        warnings: parsed.warnings,
        gyroSeries,
        stepSeries,
        spectrum,
      },
    });
  } catch (err) {
    ctx.postMessage({ type: "error", message: String(err instanceof Error ? err.message : err) });
  }
};

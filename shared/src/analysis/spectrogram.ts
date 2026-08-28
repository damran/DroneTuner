import type { ParsedLog } from "../blackbox/types";
import type { Axis } from "../types/fc";
import { amplitudeSpectrum, findPeaks, hannWindow, median } from "./fft";

/**
 * Time–frequency ("frequency vs throttle") analysis — the primary filter-
 * tuning view in Blackbox Explorer / Chris Rosser's filter methodology.
 *
 * A single whole-flight FFT smears throttle-dependent motor noise into broad
 * "peaks" that look like frame resonances; computing one spectrum per time
 * window lets us classify each peak:
 * - fixed frequency across throttle  → frame resonance (dynamic notch job)
 * - frequency scales with throttle/eRPM → motor harmonic (RPM filter job)
 */

export interface SpectrogramRow {
  /** mean throttle over the window (rcCommand scale 1000–2000, or null) */
  throttle: number | null;
  /** mean motor fundamental frequency over the window (Hz, from eRPM), or null */
  erpmHz: number | null;
  freqs: Float64Array;
  mags: Float64Array;
}

export interface Spectrogram {
  rows: SpectrogramRow[];
  sampleRate: number;
  windowSize: number;
}

export type PeakKind = "frameResonance" | "motorHarmonic" | "unknown";

export interface ClassifiedPeak {
  kind: PeakKind;
  /** mean frequency across rows (Hz) */
  freqHz: number;
  /** magnitude in the averaged spectrum (linear FFT amplitude) */
  magnitude: number;
  /** magnitude / noise floor */
  ratioToFloor: number;
  /** stddev of the per-row peak frequency (Hz) — low for frame resonances */
  freqSpreadHz: number;
  /** Pearson correlation of per-row peak frequency vs throttle (-1..1) */
  throttleCorr: number | null;
  /** lowest cluster-member frequency exceeding 4× floor (motor ridges only) */
  onsetHz?: number;
  /** lowest cluster-member frequency exceeding 8× floor (motor ridges only) */
  strongHz?: number;
}

export interface AxisSpectral {
  axis: Axis;
  /** median magnitude of the averaged spectrum over the pass band */
  floor: number;
  peaks: ClassifiedPeak[];
  /** lowest frequency where a motor-noise ridge exceeds 4× the floor */
  motorNoiseOnsetHz: number | null;
  /** frequency where motor noise reaches full strength (≥8× floor) */
  motorNoiseStrongHz: number | null;
}

/**
 * Per-sample airborne mask, same rule as the rates-usage analysis: throttle
 * above idle (rcCommand > 1050 or setpoint throttle > 50) or any axis
 * actively commanded (|setpoint| > 20 deg/s). Null when no throttle/setpoint
 * channels exist (caller then analyzes the whole log).
 */
export function airborneMask(log: ParsedLog): Uint8Array | null {
  const n = log.timeUs.length;
  if (n === 0) return null;
  const rcThrottle = log.channels["rcCommand[3]"];
  const spThrottle = log.channels["setpoint[3]"];
  const sp0 = log.channels["setpoint[0]"];
  const sp1 = log.channels["setpoint[1]"];
  const sp2 = log.channels["setpoint[2]"];
  if (!rcThrottle && !spThrottle && !sp0) return null;

  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const thrHigh =
      (rcThrottle && i < rcThrottle.length && rcThrottle[i]! > 1050) ||
      (spThrottle && i < spThrottle.length && spThrottle[i]! > 50);
    const moving =
      (sp0 && i < sp0.length && Math.abs(sp0[i]!) > 20) ||
      (sp1 && i < sp1.length && Math.abs(sp1[i]!) > 20) ||
      (sp2 && i < sp2.length && Math.abs(sp2[i]!) > 20);
    mask[i] = thrHigh || moving ? 1 : 0;
  }
  return mask;
}

export interface SpectrogramOptions {
  windowSize?: number;
  /** fraction of overlap between windows (default 0.5) */
  overlap?: number;
  /** cap on the number of rows (hop is widened to fit, default 96) */
  maxRows?: number;
  /** airborne mask per sample; windows not fully airborne are skipped */
  mask?: Uint8Array | null;
  throttle?: Float32Array;
  /** motor fundamental in Hz per sample (e.g. mean of eRPM channels / 60) */
  erpmHz?: Float32Array;
}

/** One spectrum per time window over the airborne portions of a channel. */
export function computeSpectrogram(
  samples: Float32Array,
  sampleRate: number,
  options: SpectrogramOptions = {},
): Spectrogram {
  const { overlap = 0.5, maxRows = 96, mask = null, throttle, erpmHz } = options;
  let windowSize = options.windowSize ?? 4096;
  windowSize = Math.min(windowSize, 1 << Math.floor(Math.log2(samples.length)));
  if (samples.length < 256 || sampleRate <= 0 || windowSize < 256) {
    return { rows: [], sampleRate, windowSize: 0 };
  }

  let hop = Math.max(1, Math.round(windowSize * (1 - overlap)));
  const maxPossible = Math.floor((samples.length - windowSize) / hop) + 1;
  if (maxPossible > maxRows) {
    hop = Math.ceil((samples.length - windowSize) / (maxRows - 1));
  }

  // The Hann window is identical for every row — derive it once instead of
  // per-FFT (4096 trig calls × ~96 rows × 3 axes otherwise).
  const win = hannWindow(windowSize);
  const precomputedWindow = { win, winGain: win.reduce((a, b) => a + b, 0) / windowSize };

  const rows: SpectrogramRow[] = [];
  for (let start = 0; start + windowSize <= samples.length; start += hop) {
    if (mask) {
      let airborne = true;
      for (let i = start; i < start + windowSize; i++) {
        if (!mask[i]) {
          airborne = false;
          break;
        }
      }
      if (!airborne) continue;
    }
    const spec = amplitudeSpectrum(samples, sampleRate, {
      offset: start,
      length: windowSize,
      maxSize: windowSize,
      precomputedWindow,
    });
    rows.push({
      throttle: throttle ? meanRange(throttle, start, windowSize) : null,
      erpmHz: erpmHz ? meanRange(erpmHz, start, windowSize) : null,
      freqs: spec.freqs,
      mags: spec.magnitudes,
    });
  }
  return { rows, sampleRate, windowSize };
}

export interface ClassifyOptions {
  minFreqHz?: number;
  maxFreqHz?: number;
  prominenceRatio?: number;
  maxPeaks?: number;
}

interface RowPeak {
  freqHz: number;
  magnitude: number;
  throttle: number | null;
  /** mean motor fundamental (Hz) over the row, from eRPM telemetry */
  erpmHz: number | null;
}

/**
 * Classify noise peaks by tracking each row's dominant spectral peaks across
 * time. Averaging the spectrogram would smear throttle-swept motor ridges
 * into a flat plateau (no detectable peak), so candidates come from per-row
 * peaks clustered by frequency instead:
 * - tight cluster, throttle-independent → frame resonance (dynamic notch job)
 * - frequency scales with throttle/eRPM → motor harmonic (RPM filter job)
 */
export function classifyPeaks(axis: Axis, sg: Spectrogram, options: ClassifyOptions = {}): AxisSpectral {
  const { minFreqHz = 40, maxFreqHz = Math.min(800, sg.sampleRate / 2), prominenceRatio = 4, maxPeaks = 6 } =
    options;
  const empty: AxisSpectral = {
    axis,
    floor: 0,
    peaks: [],
    motorNoiseOnsetHz: null,
    motorNoiseStrongHz: null,
  };
  if (sg.rows.length < 4) return empty;

  // Per-row noise floor and prominent peaks.
  const rowFloors: number[] = [];
  const rowPeaks: RowPeak[] = [];
  for (const row of sg.rows) {
    const band: number[] = [];
    for (let b = 1; b < row.mags.length; b++) {
      const f = row.freqs[b]!;
      if (f >= minFreqHz && f <= maxFreqHz) band.push(row.mags[b]!);
    }
    if (band.length < 16) continue;
    const rowFloor = median(band);
    rowFloors.push(rowFloor);
    const peaks = findPeaks(
      { freqs: row.freqs, magnitudes: row.mags, sampleRate: sg.sampleRate, binCount: row.mags.length },
      { minFreqHz, maxFreqHz, prominenceRatio, maxPeaks: 3, minSeparationHz: 15 },
    );
    for (const p of peaks) {
      if (rowFloor > 0 && p.magnitude >= prominenceRatio * rowFloor) {
        rowPeaks.push({ freqHz: p.freqHz, magnitude: p.magnitude, throttle: row.throttle, erpmHz: row.erpmHz });
      }
    }
  }
  if (rowFloors.length < 4) return empty;
  const floor = median(rowFloors);

  // Cluster row peaks by frequency proximity. Single-linkage (distance to the
  // cluster's latest member) so a throttle-swept motor ridge chains into one
  // cluster instead of fragmenting as the running mean lags behind.
  rowPeaks.sort((a, b) => a.freqHz - b.freqHz);
  const clusters: RowPeak[][] = [];
  for (const p of rowPeaks) {
    const cluster = clusters[clusters.length - 1];
    if (cluster) {
      const last = cluster[cluster.length - 1]!.freqHz;
      if (Math.abs(p.freqHz - last) < Math.max(15, last * 0.08)) {
        cluster.push(p);
        continue;
      }
    }
    clusters.push([p]);
  }

  const peaks: ClassifiedPeak[] = [];
  for (const cluster of clusters) {
    const present = cluster.length / sg.rows.length;
    if (present < 0.25 || cluster.length < 2) continue;
    const n = cluster.length;
    const meanFreq = cluster.reduce((a, r) => a + r.freqHz, 0) / n;
    const meanMag = cluster.reduce((a, r) => a + r.magnitude, 0) / n;
    const spread = Math.sqrt(cluster.reduce((a, r) => a + (r.freqHz - meanFreq) ** 2, 0) / n);
    // Correlate the ridge against throttle, and against eRPM when available —
    // eRPM is the more direct motor-speed signal and still discriminates when
    // the throttle trace is flat but RPM varies (e.g. descents).
    const withThrottle = cluster.filter((r) => r.throttle !== null);
    const corrThrottle =
      withThrottle.length >= 3
        ? pearson(
            withThrottle.map((r) => r.freqHz),
            withThrottle.map((r) => r.throttle!),
          )
        : null;
    const withErpm = cluster.filter((r) => r.erpmHz !== null && r.erpmHz > 0);
    const corrErpm =
      withErpm.length >= 3
        ? pearson(
            withErpm.map((r) => r.freqHz),
            withErpm.map((r) => r.erpmHz!),
          )
        : null;
    const corr =
      corrErpm !== null && (corrThrottle === null || Math.abs(corrErpm) > Math.abs(corrThrottle))
        ? corrErpm
        : corrThrottle;

    let kind: PeakKind = "unknown";
    const swept = corr !== null && corr > 0.7 && spread > Math.max(15, meanFreq * 0.1);
    const stable = spread < Math.max(10, meanFreq * 0.05) && (corr === null || Math.abs(corr) < 0.5);
    if (swept) kind = "motorHarmonic";
    else if (stable) kind = "frameResonance";

    const peak: ClassifiedPeak = {
      kind,
      freqHz: meanFreq,
      magnitude: meanMag,
      ratioToFloor: floor > 0 ? meanMag / floor : 0,
      freqSpreadHz: spread,
      throttleCorr: corr,
    };
    // Onset/strength from the cluster's own members (the ridge sweeps, so the
    // cluster spans the full frequency range — not just around the mean).
    if (kind === "motorHarmonic") {
      for (const r of cluster) {
        if (r.magnitude >= 4 * floor && (peak.onsetHz === undefined || r.freqHz < peak.onsetHz)) {
          peak.onsetHz = r.freqHz;
        }
        if (r.magnitude >= 8 * floor && (peak.strongHz === undefined || r.freqHz < peak.strongHz)) {
          peak.strongHz = r.freqHz;
        }
      }
      if (peak.onsetHz === undefined) {
        peak.onsetHz = Math.min(...cluster.map((r) => r.freqHz));
      }
    }
    peaks.push(peak);
  }
  peaks.sort((a, b) => b.magnitude - a.magnitude);
  const top = peaks.slice(0, maxPeaks);

  // Motor-noise onset/strength from the fundamental (lowest) motor ridge.
  const motor = top.filter((p) => p.kind === "motorHarmonic");
  let onset: number | null = null;
  let strong: number | null = null;
  if (motor.length > 0) {
    const fundamental = motor.reduce((a, b) => (a.freqHz < b.freqHz ? a : b));
    onset = fundamental.onsetHz ?? null;
    strong = fundamental.strongHz ?? null;
  }

  return { axis, floor, peaks: top, motorNoiseOnsetHz: onset, motorNoiseStrongHz: strong ?? onset };
}

function meanRange(arr: Float32Array, start: number, len: number): number {
  let s = 0;
  const end = Math.min(arr.length, start + len);
  for (let i = start; i < end; i++) s += arr[i]!;
  return end > start ? s / (end - start) : 0;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Convenience: mean motor fundamental (Hz) across the logged eRPM channels. */
export function meanErpmHzChannel(log: ParsedLog): Float32Array | null {
  const channels = [0, 1, 2, 3]
    .map((i) => log.channels[`eRPM[${i}]`])
    .filter((c): c is Float32Array => !!c && c.length > 0);
  if (channels.length === 0) return null;
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const c of channels) s += c[i]!;
    out[i] = s / channels.length / 60; // eRPM is logged in RPM
  }
  return out;
}

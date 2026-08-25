/**
 * Small dependency-free radix-2 FFT + spectral helpers used for
 * blackbox noise analysis in both the browser and the server.
 */

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place iterative radix-2 Cooley-Tukey FFT. Length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0 || n < 2) {
    throw new Error("fft: length must be a power of two >= 2");
  }

  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const angle = step * k;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const i = start + k;
        const j = i + half;
        const xr = re[j]! * wr - im[j]! * wi;
        const xi = re[j]! * wi + im[j]! * wr;
        re[j] = re[i]! - xr;
        im[j] = im[i]! - xi;
        re[i] = re[i]! + xr;
        im[i] = im[i]! + xi;
      }
    }
  }
}

export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return w;
}

export interface Spectrum {
  /** one-sided bin frequencies in Hz */
  freqs: Float64Array;
  /** one-sided linear amplitudes (2/N scaled) */
  magnitudes: Float64Array;
  sampleRate: number;
  binCount: number;
}

export interface SpectrumOptions {
  /** apply Hann window (default true) */
  window?: boolean;
  /** remove DC mean before transform (default true) */
  detrend?: boolean;
  /** cap the FFT size (default 16384); larger inputs are truncated to a pow2 window */
  maxSize?: number;
  /** offset into the sample array */
  offset?: number;
  /** number of samples to use (defaults to remaining length, truncated to pow2) */
  length?: number;
}

/** One-sided amplitude spectrum of a real signal. */
export function amplitudeSpectrum(
  samples: ArrayLike<number>,
  sampleRate: number,
  options: SpectrumOptions = {},
): Spectrum {
  const { window = true, detrend = true, maxSize = 16384, offset = 0 } = options;
  const available = samples.length - offset;
  if (available < 16) throw new Error("amplitudeSpectrum: not enough samples");

  let n = options.length ?? available;
  n = Math.min(n, maxSize);
  // largest power of two <= n
  n = nextPow2(n + 1) >> 1;

  const re = new Float64Array(n);
  const im = new Float64Array(n);

  let mean = 0;
  if (detrend) {
    for (let i = 0; i < n; i++) mean += samples[offset + i]!;
    mean /= n;
  }

  const win = window ? hannWindow(n) : null;
  // coherent gain correction so amplitudes stay comparable
  const winGain = win ? win.reduce((a, b) => a + b, 0) / n : 1;

  for (let i = 0; i < n; i++) {
    re[i] = (samples[offset + i]! - mean) * (win ? win[i]! : 1);
  }

  fft(re, im);

  const bins = n >> 1;
  const freqs = new Float64Array(bins);
  const magnitudes = new Float64Array(bins);
  const scale = 2 / (n * winGain);
  for (let i = 0; i < bins; i++) {
    freqs[i] = (i * sampleRate) / n;
    magnitudes[i] = Math.hypot(re[i]!, im[i]!) * scale;
  }
  return { freqs, magnitudes, sampleRate, binCount: bins };
}

export interface Peak {
  freqHz: number;
  magnitude: number;
  bin: number;
}

/**
 * Find local maxima above `minMagnitude` (absolute) and at least
 * `prominenceRatio` × the local median floor, strongest first.
 */
export function findPeaks(
  spectrum: Spectrum,
  options: {
    minFreqHz?: number;
    maxFreqHz?: number;
    minMagnitude?: number;
    prominenceRatio?: number;
    maxPeaks?: number;
    /** merge bins closer than this (Hz) keeping the strongest */
    minSeparationHz?: number;
  } = {},
): Peak[] {
  const {
    minFreqHz = 20,
    maxFreqHz = spectrum.sampleRate / 2,
    minMagnitude = 0,
    prominenceRatio = 3,
    maxPeaks = 8,
    minSeparationHz = 12,
  } = options;

  const { freqs, magnitudes } = spectrum;
  const n = freqs.length;

  // median floor over the pass band
  const band: number[] = [];
  for (let i = 1; i < n; i++) {
    if (freqs[i]! >= minFreqHz && freqs[i]! <= maxFreqHz) band.push(magnitudes[i]!);
  }
  if (band.length < 16) return [];
  band.sort((a, b) => a - b);
  const floor = band[band.length >> 1]!;

  const peaks: Peak[] = [];
  for (let i = 2; i < n - 2; i++) {
    const f = freqs[i]!;
    if (f < minFreqHz || f > maxFreqHz) continue;
    const m = magnitudes[i]!;
    if (m < minMagnitude) continue;
    if (floor > 0 && m < floor * prominenceRatio) continue;
    // strict local maximum over ±1 bins
    if (m >= magnitudes[i - 1]! && m > magnitudes[i + 1]!) {
      peaks.push({ freqHz: f, magnitude: m, bin: i });
    }
  }

  peaks.sort((a, b) => b.magnitude - a.magnitude);

  const hzPerBin = n > 1 ? freqs[1]! - freqs[0]! : 1;
  const sepBins = Math.max(1, Math.round(minSeparationHz / hzPerBin));
  const selected: Peak[] = [];
  for (const p of peaks) {
    if (selected.length >= maxPeaks) break;
    if (selected.every((s) => Math.abs(s.bin - p.bin) >= sepBins)) selected.push(p);
  }
  return selected;
}

export function median(values: ArrayLike<number>): number {
  const arr = Array.from(values as ArrayLike<number>).sort((a, b) => a - b);
  if (arr.length === 0) return 0;
  const mid = arr.length >> 1;
  return arr.length % 2 ? arr[mid]! : (arr[mid - 1]! + arr[mid]!) / 2;
}

export function rms(values: ArrayLike<number>): number {
  let sum = 0;
  const n = values.length;
  if (n === 0) return 0;
  for (let i = 0; i < n; i++) sum += values[i]! * values[i]!;
  return Math.sqrt(sum / n);
}

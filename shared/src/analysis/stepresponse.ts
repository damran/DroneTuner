import { fft, hannWindow, nextPow2 } from "./fft";
import { averageStepResponse, detectSteps, stepResponseMetrics } from "./steps";
import type { AxisStepMetrics } from "./types";
import type { Axis } from "../types/fc";

/**
 * Step response by system identification (Wiener deconvolution), the method
 * PIDtoolbox and Blackbox Explorer use: treat the closed loop as a linear
 * system setpoint → gyro, estimate its impulse response from every 2 s
 * window that contains stick input, integrate to the step response and
 * average the windows. Unlike the explicit edge detector this needs no
 * literal stick steps, so it works on smooth indoor flights and on 1 kHz
 * logs where a 50 ms plateau never occurs.
 *
 * Per-window responses are normalised to their own low-frequency gain
 * (PIDtoolbox's "Y correction") before averaging: on whoops flown indoors
 * the gyro follows small corrective inputs with a gain well below 1 (the
 * pilot is mostly reacting to disturbances, which biases the estimate), and
 * without the correction overshoot and rise time would be measured against
 * the wrong plateau. The raw gain is reported separately as `trackingGain`.
 */

export interface DeconvolutionOptions {
  /** analysis window (s, default 2) */
  windowS?: number;
  /** length of the returned step response (s, default 0.5) */
  responseS?: number;
  /** hop between windows (s, default 0.5) */
  hopS?: number;
  /** a window needs at least this much |setpoint| somewhere inside (deg/s, default 40) */
  minInputDegS?: number;
  /**
   * Tikhonov regularisation relative to the window's peak setpoint power
   * (default 1e-5). Larger values damp the response (steady state drifts
   * below 1, rise time inflates); smaller ones let gyro noise through.
   */
  lambdaRel?: number;
  /** per-sample airborne mask; windows that are not fully airborne are skipped */
  mask?: Uint8Array | null;
  /** accept a window only when its low-frequency gain lies in this range (default 0.5–1.5) */
  gainRange?: [number, number];
  /** minimum number of accepted windows for a result (default 3) */
  minWindows?: number;
}

export interface DeconvolvedStep {
  /** time since the step (ms) */
  tMs: number[];
  /** mean normalised response (1.0 == commanded rate reached) */
  response: number[];
  windowsUsed: number;
  windowsTotal: number;
  /** median low-frequency gain of the accepted windows before normalisation */
  trackingGain: number;
  /** peak of the normalised response above 1, in % (0 when none) */
  overshootPercent: number;
  /** 10–90 % rise time (ms) */
  riseTimeMs: number;
  /** time until the response first exceeds 5 % (ms) */
  latencyMs: number;
  /** time until the response stays within ±5 % of 1 for 50 ms (ms) */
  settlingTimeMs: number;
  /** full oscillation cycles around 1 after first reaching it */
  ringingCycles: number;
  /** time of the response peak (ms) */
  peakTimeMs: number;
}

/**
 * Estimate the setpoint → gyro step response of one axis. Returns null when
 * fewer than `minWindows` windows carry usable stick input.
 */
export function deconvolvedStepResponse(
  gyro: Float32Array,
  setpoint: Float32Array,
  sampleRate: number,
  options: DeconvolutionOptions = {},
): DeconvolvedStep | null {
  const {
    windowS = 2,
    responseS = 0.5,
    hopS = 0.5,
    minInputDegS = 40,
    lambdaRel = 1e-5,
    mask = null,
    gainRange = [0.5, 1.5],
    minWindows = 3,
  } = options;
  if (sampleRate <= 0) return null;
  const n = Math.min(gyro.length, setpoint.length);
  const winLen = Math.round(windowS * sampleRate);
  const respLen = Math.round(responseS * sampleRate);
  const hop = Math.max(1, Math.round(hopS * sampleRate));
  if (winLen < 64 || respLen < 16 || n < winLen) return null;

  // Zero-pad to 2× so the circular deconvolution is a linear one.
  const size = nextPow2(winLen * 2);
  const win = hannWindow(winLen);
  const xr = new Float64Array(size);
  const xi = new Float64Array(size);
  const yr = new Float64Array(size);
  const yi = new Float64Array(size);
  const sum = new Float64Array(respLen);
  const gains: number[] = [];
  const steadyFrom = Math.round(0.2 * sampleRate);
  let total = 0;

  for (let start = 0; start + winLen <= n; start += hop) {
    total++;
    if (mask) {
      let airborne = true;
      for (let i = start; i < start + winLen; i++) {
        if (!mask[i]) {
          airborne = false;
          break;
        }
      }
      if (!airborne) continue;
    }
    let maxAbs = 0;
    for (let i = 0; i < winLen; i++) maxAbs = Math.max(maxAbs, Math.abs(setpoint[start + i]!));
    if (maxAbs < minInputDegS) continue;

    xr.fill(0);
    xi.fill(0);
    yr.fill(0);
    yi.fill(0);
    for (let i = 0; i < winLen; i++) {
      const w = win[i]!;
      xr[i] = setpoint[start + i]! * w;
      yr[i] = gyro[start + i]! * w;
    }
    fft(xr, xi);
    fft(yr, yi);

    let peakPower = 0;
    for (let k = 0; k < size; k++) peakPower = Math.max(peakPower, xr[k]! * xr[k]! + xi[k]! * xi[k]!);
    if (peakPower <= 0) continue;
    const lambda = lambdaRel * peakPower;

    // H = Y·conj(X) / (|X|² + λ); the inverse FFT is done with the
    // conjugate trick (conjugate, forward FFT, divide by N).
    const hr = new Float64Array(size);
    const hi = new Float64Array(size);
    for (let k = 0; k < size; k++) {
      const a = xr[k]!;
      const b = xi[k]!;
      const c = yr[k]!;
      const d = yi[k]!;
      const den = a * a + b * b + lambda;
      hr[k] = (c * a + d * b) / den;
      hi[k] = -((d * a - c * b) / den);
    }
    fft(hr, hi);

    const step = new Float64Array(respLen);
    let acc = 0;
    for (let i = 0; i < respLen; i++) {
      acc += hr[i]! / size;
      step[i] = acc;
    }
    let gain = 0;
    for (let i = steadyFrom; i < respLen; i++) gain += step[i]!;
    gain /= respLen - steadyFrom;
    if (!(gain >= gainRange[0] && gain <= gainRange[1])) continue;
    let wild = false;
    for (let i = 0; i < respLen; i++) {
      if (Math.abs(step[i]! / gain) > 3) {
        wild = true;
        break;
      }
    }
    if (wild) continue;

    gains.push(gain);
    for (let i = 0; i < respLen; i++) sum[i] += step[i]! / gain;
  }

  const used = gains.length;
  if (used < minWindows) return null;

  const response: number[] = new Array(respLen);
  const tMs: number[] = new Array(respLen);
  for (let i = 0; i < respLen; i++) {
    response[i] = sum[i]! / used;
    tMs[i] = (i / sampleRate) * 1000;
  }
  gains.sort((a, b) => a - b);
  const trackingGain = gains[Math.floor(used / 2)]!;

  // Metrics on the averaged response. The overshoot peak is searched in the
  // first 200 ms — later excursions are slow drift, not the step peak.
  const peakWindow = Math.min(respLen, Math.round(0.2 * sampleRate));
  let peak = -Infinity;
  let peakIdx = 0;
  let i05 = -1;
  let i10 = -1;
  let i90 = -1;
  for (let i = 0; i < respLen; i++) {
    const v = response[i]!;
    if (i < peakWindow && v > peak) {
      peak = v;
      peakIdx = i;
    }
    if (i05 === -1 && v >= 0.05) i05 = i;
    if (i10 === -1 && v >= 0.1) i10 = i;
    if (i90 === -1 && v >= 0.9) i90 = i;
  }
  const toMs = (i: number) => (i / sampleRate) * 1000;

  return {
    tMs,
    response,
    windowsUsed: used,
    windowsTotal: total,
    trackingGain,
    overshootPercent: Math.max(0, (peak - 1) * 100),
    riseTimeMs: i10 >= 0 && i90 >= 0 ? toMs(i90 - i10) : toMs(respLen),
    latencyMs: i05 >= 0 ? toMs(i05) : toMs(respLen),
    settlingTimeMs: settlingTime(response, sampleRate),
    ringingCycles: ringing(response),
    peakTimeMs: toMs(peakIdx),
  };
}

/** Time until the response stays within ±5 % of 1.0 for 50 ms. */
function settlingTime(resp: number[], sampleRate: number): number {
  const holdSamples = Math.max(1, Math.round(0.05 * sampleRate));
  let inBand = 0;
  for (let i = 0; i < resp.length; i++) {
    if (Math.abs(resp[i]! - 1) <= 0.05) {
      inBand++;
      if (inBand >= holdSamples) return (i / sampleRate) * 1000;
    } else {
      inBand = 0;
    }
  }
  return (resp.length / sampleRate) * 1000;
}

/** Full oscillation cycles around 1.0 after first reaching it (<5 % = noise). */
function ringing(resp: number[]): number {
  let firstReach = -1;
  for (let i = 0; i < resp.length; i++) {
    if (resp[i]! >= 1) {
      firstReach = i;
      break;
    }
  }
  if (firstReach === -1) return 0;
  let cycles = 0;
  let side = 0;
  for (let i = firstReach; i < resp.length; i++) {
    const dev = resp[i]! - 1;
    if (Math.abs(dev) < 0.05) continue;
    const s = Math.sign(dev);
    if (side !== 0 && s !== side) cycles += 0.5;
    side = s;
  }
  return Math.floor(cycles);
}

/** Explicit steps are used as a fallback from this many onwards. */
export const MIN_EXPLICIT_STEPS = 5;
/** Deconvolution windows needed before the estimate is the primary result. */
export const MIN_DECONV_WINDOWS = 8;

export interface AxisStepAnalysis {
  metrics: AxisStepMetrics;
  /** chart curve of the chosen method (null when neither method has data) */
  curve: { tMs: number[]; response: number[] } | null;
}

/**
 * Step response of one axis. The deconvolution estimate is primary whenever
 * it has ≥ MIN_DECONV_WINDOWS windows: on real logs the "explicit" stick
 * steps are RC-smoothed ramps of 50–100 ms, so averaging the gyro over them
 * measures the pilot's thumb, not the loop (an Air65 flight gave 60 ms rise
 * by explicit steps and 13 ms by deconvolution, the latter matching the
 * ≥150 deg/s subset and PIDtoolbox). Explicit steps are the fallback when
 * the flight has too little stick input for system identification. The FF
 * start-lag / end-overshoot / steady-state metrics only exist for explicit
 * steps and are kept from them whenever at least one was found. Server
 * metrics and the Log Lab worker both go through here, so the chart and the
 * findings always describe the same estimate.
 */
export function analyzeAxisStepResponse(
  axis: Axis,
  gyro: Float32Array,
  setpoint: Float32Array,
  sampleRate: number,
  options: { mask?: Uint8Array | null } = {},
): AxisStepAnalysis {
  const steps = detectSteps(setpoint, sampleRate);
  const explicit = stepResponseMetrics(gyro, setpoint, steps, sampleRate);
  explicit.axis = axis;
  const deconv = deconvolvedStepResponse(gyro, setpoint, sampleRate, { mask: options.mask ?? null });

  const useExplicit = !deconv || (deconv.windowsUsed < MIN_DECONV_WINDOWS && explicit.stepCount >= MIN_EXPLICIT_STEPS);
  if (useExplicit) {
    const metrics: AxisStepMetrics = {
      ...explicit,
      method: "steps",
      windowCount: deconv?.windowsUsed ?? 0,
    };
    if (deconv) metrics.trackingGain = deconv.trackingGain;
    return { metrics, curve: averageStepResponse(gyro, setpoint, steps, sampleRate) };
  }

  const hasSteps = explicit.stepCount > 0;
  const metrics: AxisStepMetrics = {
    axis,
    overshootPercent: deconv!.overshootPercent,
    riseTimeMs: deconv!.riseTimeMs,
    settlingTimeMs: deconv!.settlingTimeMs,
    latencyMs: deconv!.latencyMs,
    ringingCycles: deconv!.ringingCycles,
    steadyStateErrorPercent: hasSteps ? explicit.steadyStateErrorPercent : undefined,
    ffStartLagMs: hasSteps ? explicit.ffStartLagMs : undefined,
    ffEndOvershootPercent: hasSteps ? explicit.ffEndOvershootPercent : null,
    stepCount: explicit.stepCount,
    method: "deconvolution",
    windowCount: deconv!.windowsUsed,
    trackingGain: deconv!.trackingGain,
  };
  return { metrics, curve: { tMs: deconv!.tMs, response: deconv!.response } };
}

/** True when an axis has enough evidence (steps or windows) for tuning rules. */
export function hasStepEvidence(m: AxisStepMetrics): boolean {
  if (m.method === "deconvolution") return (m.windowCount ?? 0) >= MIN_DECONV_WINDOWS;
  return m.stepCount >= 3;
}

/** Short provenance note for findings ("system identification over 31 windows"). */
export function stepEvidenceNote(m: AxisStepMetrics): string {
  return m.method === "deconvolution"
    ? `system identification over ${m.windowCount ?? 0} windows of stick input${m.trackingGain !== undefined ? `, tracking gain ${m.trackingGain.toFixed(2)}` : ""}`
    : `${m.stepCount} stick step${m.stepCount === 1 ? "" : "s"}`;
}

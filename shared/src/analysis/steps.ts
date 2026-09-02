import type { AxisStepMetrics } from "./types";

export interface StepWindow {
  /** index of the first sample of the setpoint edge */
  start: number;
  /** end of the response window (capped at the next edge or windowMs) */
  end: number;
  /** signed setpoint change (deg/s) from pre-level to plateau */
  amplitude: number;
  /** setpoint value during the post-step plateau (deg/s) */
  plateau: number;
  /** index where the plateau hold starts */
  plateauStart: number;
  /** index where the plateau hold ends (next edge or window cap) */
  plateauEnd: number;
}

export interface DetectStepsOptions {
  /** minimum |setpoint change| to count as a step (deg/s, default 100) */
  minAmplitude?: number;
  /** required plateau hold after the edge (ms, default 30) */
  minHoldMs?: number;
  /** required quiet time before the edge (ms, default 20) — the step must
   *  start from a steady state so the response is attributable */
  preQuietMs?: number;
  /** response window cap (ms, default 300) */
  windowMs?: number;
  /**
   * Edge threshold on the setpoint derivative (deg/s², default 3000). A sharp
   * stick move ramps the setpoint over a few ms even with RC smoothing, so a
   * derivative threshold catches smoothed steps that a per-sample jump
   * threshold would miss.
   */
  edgeThresholdDegS2?: number;
}

/**
 * Detect stick steps in a setpoint trace (deg/s), PTB/fpvpidlab style:
 * flag samples where the setpoint derivative exceeds a threshold, group
 * consecutive flags into one edge, then require a real amplitude change and a
 * short post-step plateau hold. This deliberately accepts the quick
 * out-and-back "wiggle" moves used for PID tuning flights (≥30 ms holds).
 * Real whoop flights rarely hold a plateau at all, so the defaults are
 * lenient; when fewer than a handful of steps survive, the metrics pipeline
 * falls back to the deconvolution estimate (see stepresponse.ts).
 */
export function detectSteps(
  setpoint: Float32Array,
  sampleRate: number,
  options: DetectStepsOptions = {},
): StepWindow[] {
  const {
    minAmplitude = 100,
    minHoldMs = 30,
    preQuietMs = 20,
    windowMs = 300,
    edgeThresholdDegS2 = 3000,
  } = options;
  const n = setpoint.length;
  if (n < 64 || sampleRate <= 0) return [];

  // Light 3-sample smoothing to reject single-sample noise spikes.
  const smooth = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = setpoint[Math.max(0, i - 1)]!;
    const b = setpoint[i]!;
    const c = setpoint[Math.min(n - 1, i + 1)]!;
    smooth[i] = (a + b + c) / 3;
  }

  // Derivative in deg/s².
  const deriv = new Float64Array(n);
  for (let i = 1; i < n; i++) deriv[i] = (smooth[i]! - smooth[i - 1]!) * sampleRate;

  const holdSamples = Math.max(2, Math.round((minHoldMs / 1000) * sampleRate));
  const preQuietSamples = Math.max(2, Math.round((preQuietMs / 1000) * sampleRate));
  const windowSamples = Math.round((windowMs / 1000) * sampleRate);
  const preSamples = Math.round(0.02 * sampleRate);
  const gapTol = Math.max(2, Math.round(0.005 * sampleRate)); // bridge tiny dips in the edge

  // Collect edge runs: contiguous |deriv| >= threshold, bridging short gaps.
  const edges: [number, number][] = [];
  let i = 1;
  while (i < n) {
    if (Math.abs(deriv[i]!) < edgeThresholdDegS2) {
      i++;
      continue;
    }
    const start = i;
    let lastHot = i;
    while (i < n && (Math.abs(deriv[i]!) >= edgeThresholdDegS2 || i - lastHot <= gapTol)) {
      if (Math.abs(deriv[i]!) >= edgeThresholdDegS2) lastHot = i;
      i++;
    }
    edges.push([start, lastHot]);
  }

  const steps: StepWindow[] = [];

  for (let e = 0; e < edges.length; e++) {
    const [e0, e1] = edges[e]!;

    const preLevel = mean(smooth, Math.max(0, e0 - preSamples), e0);
    // Plateau estimate: mean over the hold region right after the edge.
    const plateauStart = e1 + 1;
    const plateauHoldEnd = plateauStart + holdSamples;
    if (plateauHoldEnd >= n) continue;
    const plateau = mean(smooth, plateauStart, plateauHoldEnd);
    const amplitude = plateau - preLevel;
    if (Math.abs(amplitude) < minAmplitude) continue;

    // The step must start from a steady state and hold the new level —
    // otherwise the gyro response can't be attributed to this edge. These
    // two checks (not a time-based cooldown) are what reject blips and
    // double-counted edges while still accepting quick out-and-back wiggles.
    const tol = Math.max(20, Math.abs(amplitude) * 0.1);
    let valid = true;
    for (let j = plateauStart; j < plateauHoldEnd; j++) {
      if (Math.abs(smooth[j]! - plateau) > tol) {
        valid = false;
        break;
      }
    }
    if (valid) {
      const quietStart = Math.max(0, e0 - preQuietSamples);
      for (let j = quietStart; j < e0; j++) {
        if (Math.abs(smooth[j]! - preLevel) > tol) {
          valid = false;
          break;
        }
      }
    }
    if (!valid) continue;

    // Response window ends at the next edge (a return move) or the cap.
    const nextEdgeStart = e + 1 < edges.length ? edges[e + 1]![0] : n;
    const end = Math.min(n, e0 + windowSamples, nextEdgeStart);
    if (end - e0 < 16) continue;

    steps.push({
      start: e0,
      end,
      amplitude,
      plateau,
      plateauStart,
      plateauEnd: Math.min(plateauHoldEnd, end),
    });
  }
  return steps;
}

/**
 * Average step-response metrics over all detected steps for one axis.
 * Responses are normalized so 1.0 == gyro reached the new setpoint (the
 * setpoint plateau amplitude is the reference, not the end-of-window gyro
 * mean, so out-and-back moves normalize correctly).
 */
export function stepResponseMetrics(
  gyro: Float32Array,
  setpoint: Float32Array,
  steps: StepWindow[],
  sampleRate: number,
): AxisStepMetrics {
  const empty: AxisStepMetrics = {
    axis: "roll",
    overshootPercent: 0,
    riseTimeMs: 0,
    settlingTimeMs: 0,
    latencyMs: 0,
    ringingCycles: 0,
    steadyStateErrorPercent: 0,
    ffStartLagMs: 0,
    ffEndOvershootPercent: null,
    stepCount: 0,
  };
  if (steps.length === 0 || sampleRate <= 0) return empty;

  let overshootSum = 0;
  let riseSum = 0;
  let settleSum = 0;
  let latencySum = 0;
  let ringingSum = 0;
  let sseSum = 0;
  let sseCount = 0;
  let ffLagSum = 0;
  let ffEndSum = 0;
  let ffEndCount = 0;
  let peakTimeSum = 0;
  let used = 0;

  for (let s = 0; s < steps.length; s++) {
    const step = steps[s]!;
    const len = step.end - step.start;
    if (len < 16 || Math.abs(step.amplitude) < 1e-6) continue;
    const base = mean(gyro, Math.max(0, step.start - 5), step.start);
    const sign = step.amplitude > 0 ? 1 : -1;
    const amp = Math.abs(step.amplitude);

    const resp = new Float64Array(len);
    for (let j = 0; j < len; j++) {
      resp[j] = ((gyro[step.start + j]! - base) * sign) / amp;
    }

    // Overshoot: peak beyond 1.0 while the setpoint holds at the plateau.
    const plateauLen = Math.max(1, step.plateauEnd - step.start);
    let peak = 0;
    let peakIdx = 0;
    for (let j = 0; j < Math.min(plateauLen, len); j++) {
      if (resp[j]! > peak) {
        peak = resp[j]!;
        peakIdx = j;
      }
    }
    overshootSum += Math.max(0, (peak - 1) * 100);
    peakTimeSum += (peakIdx / sampleRate) * 1000;

    riseSum += riseTime(resp, sampleRate);
    settleSum += settlingTime(resp, sampleRate);
    latencySum += latency(resp, sampleRate);
    ringingSum += ringing(resp);
    const sse = steadyStateError(resp, step, sampleRate);
    if (sse !== null) {
      sseSum += sse;
      sseCount++;
    }
    ffLagSum += ffStartLag(gyro, setpoint, step, base, sign, amp, sampleRate);

    // End-of-move overshoot: this step is a return move when the previous
    // step on this axis went the opposite way shortly before it.
    const prev = s > 0 ? steps[s - 1]! : null;
    if (prev && Math.sign(prev.amplitude) !== Math.sign(step.amplitude)) {
      ffEndSum += Math.max(0, (peak - 1) * 100);
      ffEndCount++;
    }

    used++;
  }

  if (used === 0) return empty;

  return {
    axis: "roll",
    overshootPercent: overshootSum / used,
    riseTimeMs: riseSum / used,
    settlingTimeMs: settleSum / used,
    latencyMs: latencySum / used,
    ringingCycles: ringingSum / used,
    peakTimeMs: peakTimeSum / used,
    steadyStateErrorPercent: sseCount > 0 ? sseSum / sseCount : 0,
    ffStartLagMs: ffLagSum / used,
    ffEndOvershootPercent: ffEndCount > 0 ? ffEndSum / ffEndCount : null,
    stepCount: used,
  };
}

/**
 * Average normalized step response for charting: x = time since step (ms),
 * y = gyro response normalized so 1.0 == reached the new setpoint.
 * Returns null when no usable steps were found.
 */
export function averageStepResponse(
  gyro: Float32Array,
  setpoint: Float32Array,
  steps: StepWindow[],
  sampleRate: number,
  windowMs = 200,
): { tMs: number[]; response: number[] } | null {
  if (steps.length === 0 || sampleRate <= 0) return null;
  const len = Math.round((windowMs / 1000) * sampleRate);
  if (len < 16) return null;

  const sum = new Float64Array(len);
  const count = new Int32Array(len);
  for (const step of steps) {
    if (Math.abs(step.amplitude) < 1e-6) continue;
    const avail = Math.min(len, step.end - step.start, gyro.length - step.start);
    if (avail < 16) continue;
    const base = mean(gyro, Math.max(0, step.start - 5), step.start);
    const sign = step.amplitude > 0 ? 1 : -1;
    const amp = Math.abs(step.amplitude);
    for (let j = 0; j < avail; j++) {
      sum[j] += ((gyro[step.start + j]! - base) * sign) / amp;
      count[j] = count[j]! + 1;
    }
  }
  if (count[0] === 0) return null;

  // Truncate at the last sample covered by any step (windows are capped at
  // the next edge, so the tail would otherwise be NaN-padded).
  let last = 0;
  for (let j = len - 1; j >= 0; j--) {
    if (count[j]! > 0) {
      last = j;
      break;
    }
  }

  const tMs: number[] = [];
  const response: number[] = [];
  for (let j = 0; j <= last; j++) {
    tMs.push((j / sampleRate) * 1000);
    response.push(count[j]! > 0 ? sum[j]! / count[j]! : NaN);
  }
  return { tMs, response };
}

function mean(arr: ArrayLike<number>, start: number, end: number): number {
  const s = Math.max(0, start);
  const e = Math.min(arr.length, end);
  if (e <= s) return 0;
  let sum = 0;
  for (let i = s; i < e; i++) sum += arr[i]!;
  return sum / (e - s);
}

/** Time from 10% to 90% of the normalized response. */
function riseTime(resp: Float64Array, sampleRate: number): number {
  let i10 = -1;
  let i90 = -1;
  for (let i = 0; i < resp.length; i++) {
    const v = resp[i]!;
    if (i10 === -1 && v >= 0.1) i10 = i;
    if (v >= 0.9) {
      i90 = i;
      break;
    }
  }
  if (i10 === -1 || i90 === -1) return 0;
  return ((i90 - i10) / sampleRate) * 1000;
}

/** Time until the response first moves ≥5% — the "latency" PTB reports. */
function latency(resp: Float64Array, sampleRate: number): number {
  for (let i = 0; i < resp.length; i++) {
    if (resp[i]! >= 0.05) return (i / sampleRate) * 1000;
  }
  return (resp.length / sampleRate) * 1000;
}

/** Time until the response stays within ±5% of 1.0 for 50 ms. */
function settlingTime(resp: Float64Array, sampleRate: number): number {
  const holdSamples = Math.round(0.05 * sampleRate);
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

/** Full oscillation cycles around 1.0 after first reaching it (<5% = noise). */
function ringing(resp: Float64Array): number {
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
    if (side !== 0 && s !== side) cycles += 0.5; // each zero-cross with amplitude = half cycle
    side = s;
  }
  return Math.floor(cycles);
}

/**
 * Mean |response − 1| over the settled part of the plateau hold, in %. The
 * window starts once the response has reached 90 % (plus 10 ms) and never
 * before the second half of the hold — the rise itself is not steady state.
 * Null when the hold is too short to contain a settled stretch (short
 * wiggles), so such steps do not drag the average.
 */
function steadyStateError(resp: Float64Array, step: StepWindow, sampleRate: number): number | null {
  const holdFrom = Math.max(0, step.plateauStart - step.start);
  const holdTo = Math.min(resp.length, step.plateauEnd - step.start);
  let i90 = -1;
  for (let j = 0; j < holdTo; j++) {
    if (resp[j]! >= 0.9) {
      i90 = j;
      break;
    }
  }
  if (i90 === -1) return null;
  const from = Math.max(holdFrom + Math.floor((holdTo - holdFrom) / 2), i90 + Math.round(0.01 * sampleRate));
  if (holdTo - from < 4) return null;
  let sum = 0;
  for (let j = from; j < holdTo; j++) sum += Math.abs(resp[j]! - 1);
  return (sum / (holdTo - from)) * 100;
}

/**
 * Feedforward start-of-move lag: time between the setpoint reaching 50% of
 * the step amplitude and the gyro reaching 50%. Positive = gyro lags (FF too
 * low); negative = gyro leads (FF boost too high).
 */
function ffStartLag(
  gyro: Float32Array,
  setpoint: Float32Array,
  step: StepWindow,
  gyroBase: number,
  sign: number,
  amp: number,
  sampleRate: number,
): number {
  const len = step.end - step.start;
  const spBase = mean(setpoint, Math.max(0, step.start - 5), step.start);
  let spHalf = -1;
  let gyHalf = -1;
  for (let j = 0; j < len; j++) {
    const spNorm = ((setpoint[step.start + j]! - spBase) * sign) / amp;
    const gyNorm = ((gyro[step.start + j]! - gyroBase) * sign) / amp;
    if (spHalf === -1 && spNorm >= 0.5) spHalf = j;
    if (gyHalf === -1 && gyNorm >= 0.5) gyHalf = j;
    if (spHalf !== -1 && gyHalf !== -1) break;
  }
  if (spHalf === -1 || gyHalf === -1) return 0;
  return ((gyHalf - spHalf) / sampleRate) * 1000;
}

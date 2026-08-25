import type { AxisStepMetrics } from "./types";

export interface StepWindow {
  start: number;
  end: number;
  amplitude: number;
}

/**
 * Detect stick steps in a setpoint trace (deg/s). Returns windows around each
 * rising/falling step, sorted by start index.
 */
export function detectSteps(
  setpoint: Float32Array,
  sampleRate: number,
  options: { minAmplitude?: number; minGapSamples?: number } = {},
): StepWindow[] {
  const { minAmplitude = 150, minGapSamples = 20 } = options;
  const n = setpoint.length;
  if (n < 64) return [];

  const windowSamples = Math.round(0.4 * sampleRate);
  const preSamples = Math.round(0.05 * sampleRate);
  const steps: StepWindow[] = [];
  let lastStepEnd = -1;

  for (let i = 1; i < n - 1; i++) {
    const delta = setpoint[i]! - setpoint[i - 1]!;
    if (Math.abs(delta) < minAmplitude) continue;
    if (i < lastStepEnd) continue;

    const end = Math.min(n, i + windowSamples);
    const before = setpoint[Math.max(0, i - preSamples)]!;
    const after = setpoint[Math.min(n - 1, i + windowSamples)]!;
    const amplitude = after - before;
    if (Math.abs(amplitude) < minAmplitude) continue;

    steps.push({ start: i, end, amplitude });
    lastStepEnd = end + minGapSamples;
  }
  return steps;
}

/**
 * Average step-response metrics over all detected steps for one axis.
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
    stepCount: 0,
  };
  if (steps.length === 0) return empty;

  const windowSamples = Math.round(0.4 * sampleRate);
  const normSum = new Float64Array(windowSamples);
  const normCount = new Int32Array(windowSamples);
  let overshootSum = 0;
  let riseSum = 0;
  let settleSum = 0;
  let used = 0;

  for (const step of steps) {
    const len = step.end - step.start;
    if (len < 16 || Math.abs(step.amplitude) < 1e-6) continue;
    const base = mean(gyro, step.start - 5, step.start);
    const sign = step.amplitude > 0 ? 1 : -1;

    const resp = new Float64Array(len);
    for (let j = 0; j < len; j++) {
      resp[j] = (gyro[step.start + j]! - base) * sign;
    }

    // normalize by |amplitude| (setpoint change)
    const amp = Math.abs(step.amplitude);
    const final = mean(resp, Math.floor(len * 0.8), len);
    if (Math.abs(final) < 1e-6) continue;

    for (let j = 0; j < len; j++) {
      normSum[j] += resp[j]! / final;
      normCount[j] = normCount[j]! + 1;
    }

    const peak = maxAbs(resp, 0, len);
    const overshoot = ((peak - Math.abs(final)) / Math.abs(final)) * 100;
    overshootSum += Math.max(0, overshoot);

    const rise = riseTime(resp, final, sampleRate);
    riseSum += rise;

    const settle = settlingTime(resp, final, sampleRate);
    settleSum += settle;

    used++;
  }

  if (used === 0) return empty;

  return {
    axis: "roll",
    overshootPercent: overshootSum / used,
    riseTimeMs: riseSum / used,
    settlingTimeMs: settleSum / used,
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
  windowMs = 150,
): { tMs: number[]; response: number[] } | null {
  if (steps.length === 0 || sampleRate <= 0) return null;
  const len = Math.round((windowMs / 1000) * sampleRate);
  if (len < 16) return null;

  const sum = new Float64Array(len);
  const count = new Int32Array(len);
  for (const step of steps) {
    if (Math.abs(step.amplitude) < 1e-6) continue;
    const avail = Math.min(len, setpoint.length - step.start, gyro.length - step.start);
    if (avail < 16) continue;
    const base = mean(gyro, step.start - 5, step.start);
    const sign = step.amplitude > 0 ? 1 : -1;
    const final = meanFromDelta(gyro, step.start, Math.floor(avail * 0.8), avail, base, sign);
    if (Math.abs(final) < 1e-6) continue;
    for (let j = 0; j < avail; j++) {
      sum[j] += ((gyro[step.start + j]! - base) * sign) / final;
      count[j] = count[j]! + 1;
    }
  }
  if (count[0] === 0) return null;

  const tMs: number[] = [];
  const response: number[] = [];
  for (let j = 0; j < len; j++) {
    tMs.push((j / sampleRate) * 1000);
    response.push(count[j]! > 0 ? sum[j]! / count[j]! : NaN);
  }
  return { tMs, response };
}

function meanFromDelta(
  arr: ArrayLike<number>,
  startIdx: number,
  from: number,
  to: number,
  base: number,
  sign: number,
): number {
  let s = 0;
  let n = 0;
  for (let i = from; i < to; i++) {
    s += (arr[startIdx + i]! - base) * sign;
    n++;
  }
  return n > 0 ? s / n : 0;
}

function mean(arr: ArrayLike<number>, start: number, end: number): number {
  const s = Math.max(0, start);
  const e = Math.min(arr.length, end);
  if (e <= s) return 0;
  let sum = 0;
  for (let i = s; i < e; i++) sum += arr[i]!;
  return sum / (e - s);
}

function maxAbs(arr: ArrayLike<number>, start: number, end: number): number {
  let m = 0;
  for (let i = start; i < end; i++) m = Math.max(m, Math.abs(arr[i]!));
  return m;
}

function riseTime(resp: Float64Array, final: number, sampleRate: number): number {
  const target = Math.abs(final);
  const t10 = target * 0.1;
  const t90 = target * 0.9;
  let i10 = -1;
  let i90 = -1;
  for (let i = 0; i < resp.length; i++) {
    const v = Math.abs(resp[i]!);
    if (i10 === -1 && v >= t10) i10 = i;
    if (v >= t90) {
      i90 = i;
      break;
    }
  }
  if (i10 === -1 || i90 === -1) return 0;
  return ((i90 - i10) / sampleRate) * 1000;
}

function settlingTime(resp: Float64Array, final: number, sampleRate: number): number {
  const target = Math.abs(final);
  const band = target * 0.05;
  const holdSamples = Math.round(0.1 * sampleRate);
  let inBand = 0;
  for (let i = 0; i < resp.length; i++) {
    if (Math.abs(resp[i]! - Math.abs(final)) <= band) {
      inBand++;
      if (inBand >= holdSamples) return (i / sampleRate) * 1000;
    } else {
      inBand = 0;
    }
  }
  return (resp.length / sampleRate) * 1000;
}

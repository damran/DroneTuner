import { describe, expect, it } from "vitest";
import { deconvolvedStepResponse } from "../src/analysis/stepresponse";

/**
 * Synthetic closed loop: a smooth random stick trace (low-passed random walk
 * with occasional flicks, never a held plateau) drives a second-order system
 * with known damping, so the analytic overshoot and rise time are known.
 */
function synthetic(
  sampleRate: number,
  seconds: number,
  sys: { zeta: number; fnHz: number; delayMs: number; gain: number; noise: number },
): { setpoint: Float32Array; gyro: Float32Array; expected: { peak: number; riseMs: number } } {
  const n = Math.round(sampleRate * seconds);
  const setpoint = new Float64Array(n);
  let seed = 4242;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5;
  let walk = 0;
  let lp = 0;
  const a = Math.exp((-2 * Math.PI * 3) / sampleRate);
  for (let i = 0; i < n; i++) {
    walk += rnd() * 40;
    walk *= 0.995;
    if (i % Math.round(sampleRate * 1.7) === 0) walk += rnd() * 800;
    lp = a * lp + (1 - a) * walk;
    setpoint[i] = lp;
  }
  const wn = 2 * Math.PI * sys.fnHz;
  const dt = 1 / sampleRate;
  const delay = Math.round((sys.delayMs / 1000) * sampleRate);
  const gyro = new Float64Array(n);
  let y = 0;
  let v = 0;
  let drift = 0;
  const ad = Math.exp((-2 * Math.PI * 0.7) / sampleRate);
  for (let i = 0; i < n; i++) {
    const u = (i - delay >= 0 ? setpoint[i - delay]! : 0) * sys.gain;
    v += (wn * wn * (u - y) - 2 * sys.zeta * wn * v) * dt;
    y += v * dt;
    drift = ad * drift + (1 - ad) * rnd() * sys.noise * 40; // slow uncorrelated disturbance
    gyro[i] = y + rnd() * sys.noise * 30 + drift;
  }
  // Analytic (numerical) unit step of the same system for the reference.
  let sy = 0;
  let sv = 0;
  let peak = 0;
  let i10 = -1;
  let i90 = -1;
  for (let i = 0; i < sampleRate; i++) {
    sv += (wn * wn * (1 - sy) - 2 * sys.zeta * wn * sv) * dt;
    sy += sv * dt;
    peak = Math.max(peak, sy);
    if (i10 < 0 && sy >= 0.1) i10 = i;
    if (i90 < 0 && sy >= 0.9) i90 = i;
  }
  return {
    setpoint: Float32Array.from(setpoint),
    gyro: Float32Array.from(gyro),
    expected: { peak, riseMs: ((i90 - i10) / sampleRate) * 1000 },
  };
}

describe("deconvolvedStepResponse", () => {
  it("recovers overshoot and rise time from a smooth 1 kHz flight without plateaus", () => {
    const { setpoint, gyro, expected } = synthetic(1000, 90, { zeta: 0.6, fnHz: 8, delayMs: 8, gain: 1, noise: 2 });
    const r = deconvolvedStepResponse(gyro, setpoint, 1000);
    expect(r).not.toBeNull();
    expect(r!.windowsUsed).toBeGreaterThan(20);
    expect(r!.overshootPercent).toBeCloseTo((expected.peak - 1) * 100, -1); // within ±5 points
    expect(Math.abs(r!.riseTimeMs - expected.riseMs)).toBeLessThan(6);
    expect(r!.trackingGain).toBeGreaterThan(0.9);
    expect(r!.trackingGain).toBeLessThan(1.1);
    // The normalised response settles at 1 in the plateau region.
    const tail = r!.response.slice(Math.round(r!.response.length * 0.6));
    const mean = tail.reduce((s, v) => s + v, 0) / tail.length;
    expect(mean).toBeCloseTo(1, 1);
  });

  it("works at 2 kHz and reports a low tracking gain without distorting the shape", () => {
    // Underdamped loop that only reaches 70 % of the commanded rate at low
    // frequency (the indoor-whoop case): the shape is measured against its
    // own plateau, the gain deficit is reported separately.
    const { setpoint, gyro, expected } = synthetic(2000, 90, { zeta: 0.35, fnHz: 12, delayMs: 10, gain: 0.7, noise: 2 });
    const r = deconvolvedStepResponse(gyro, setpoint, 2000);
    expect(r).not.toBeNull();
    expect(r!.overshootPercent).toBeGreaterThan(20);
    expect(Math.abs(r!.overshootPercent - (expected.peak - 1) * 100)).toBeLessThan(8);
    expect(Math.abs(r!.riseTimeMs - expected.riseMs)).toBeLessThan(6);
    expect(r!.trackingGain).toBeGreaterThan(0.6);
    expect(r!.trackingGain).toBeLessThan(0.8);
  });

  it("returns null when the sticks never move enough", () => {
    const n = 20_000;
    const setpoint = new Float32Array(n);
    const gyro = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      setpoint[i] = 10 * Math.sin(i / 300);
      gyro[i] = setpoint[i]! + (i % 7) - 3;
    }
    expect(deconvolvedStepResponse(gyro, setpoint, 1000)).toBeNull();
  });

  it("skips windows that are not fully airborne", () => {
    const { setpoint, gyro } = synthetic(1000, 60, { zeta: 0.6, fnHz: 8, delayMs: 8, gain: 1, noise: 1 });
    const mask = new Uint8Array(setpoint.length).fill(1);
    mask.fill(0, 0, 30_000); // first 30 s on the ground
    const r = deconvolvedStepResponse(gyro, setpoint, 1000, { mask });
    const all = deconvolvedStepResponse(gyro, setpoint, 1000);
    expect(r).not.toBeNull();
    expect(r!.windowsUsed).toBeLessThan(all!.windowsUsed);
    expect(r!.windowsTotal).toBe(all!.windowsTotal);
  });
});

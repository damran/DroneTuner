import { describe, expect, it } from "vitest";
import { averageStepResponse, detectSteps, stepResponseMetrics } from "../src/analysis/steps";

const FS = 2000;

/** Build a setpoint/gyro pair with wiggle moves; gyro follows with a 1st-order lag. */
function makeLog(opts: { holdMs?: number; rampMs?: number; tauMs?: number; amplitude?: number } = {}) {
  const { holdMs = 80, rampMs = 4, tauMs = 15, amplitude = 600 } = opts;
  const n = FS * 2; // 2 s
  const sp = new Float32Array(n);
  const gy = new Float32Array(n);

  const ramp = Math.max(1, Math.round((rampMs / 1000) * FS));
  const hold = Math.round((holdMs / 1000) * FS);

  // three out-and-back wiggles at 0.4 s, 0.9 s, 1.4 s
  const starts = [0.4, 0.9, 1.4].map((t) => Math.round(t * FS));
  for (const s of starts) {
    for (let i = 0; i < ramp; i++) sp[s + i] = (amplitude * i) / ramp;
    for (let i = 0; i < hold; i++) sp[s + ramp + i] = amplitude;
    for (let i = 0; i < ramp; i++) sp[s + ramp + hold + i] = amplitude * (1 - i / ramp);
  }

  // gyro: first-order lag toward setpoint
  const dt = 1 / FS;
  const tau = tauMs / 1000;
  for (let i = 1; i < n; i++) {
    gy[i] = gy[i - 1]! + (sp[i]! - gy[i - 1]!) * Math.min(1, dt / tau);
  }
  return { sp, gy };
}

describe("detectSteps", () => {
  it("detects quick out-and-back wiggle moves (Rosser tuning inputs)", () => {
    const { sp } = makeLog();
    const steps = detectSteps(sp, FS);
    // 3 wiggles × 2 edges (out + return)
    expect(steps.length).toBe(6);
    expect(Math.abs(steps[0]!.amplitude)).toBeCloseTo(600, -1);
    expect(steps[0]!.plateau).toBeCloseTo(600, -1);
    // return move has negative amplitude
    expect(steps[1]!.amplitude).toBeLessThan(0);
  });

  it("detects RC-smoothed steps that never jump 150 deg/s in one sample", () => {
    // 25 ms ramp → per-sample delta = 600/50 = 12 deg/s — invisible to a
    // single-sample jump detector, trivially caught by the derivative.
    const { sp } = makeLog({ rampMs: 25 });
    const steps = detectSteps(sp, FS);
    expect(steps.length).toBe(6);
  });

  it("rejects blips shorter than the hold requirement", () => {
    const { sp } = makeLog({ holdMs: 10 });
    const steps = detectSteps(sp, FS);
    expect(steps.length).toBe(0);
  });

  it("finds nothing during slow flying", () => {
    const n = FS * 2;
    const sp = new Float32Array(n);
    for (let i = 0; i < n; i++) sp[i] = 100 * Math.sin((2 * Math.PI * i) / FS); // 1 Hz gentle
    expect(detectSteps(sp, FS).length).toBe(0);
  });
});

describe("stepResponseMetrics", () => {
  it("normalizes by the setpoint plateau and reports near-zero overshoot for a lagged follow", () => {
    const { sp, gy } = makeLog();
    const steps = detectSteps(sp, FS);
    const m = stepResponseMetrics(gy, sp, steps, FS);
    expect(m.stepCount).toBe(6);
    expect(m.overshootPercent).toBeLessThan(10);
    expect(m.riseTimeMs).toBeGreaterThan(5);
    expect(m.latencyMs).toBeGreaterThan(0);
    // gyro lags the setpoint → positive FF start lag
    expect(m.ffStartLagMs).toBeGreaterThan(3);
    // steady-state error small (gyro reaches the plateau)
    expect(m.steadyStateErrorPercent).toBeLessThan(10);
  });

  it("reports overshoot for an under-damped response", () => {
    const { sp } = makeLog();
    const n = sp.length;
    const gy = new Float32Array(n);
    // under-damped: overshoot the target by ~30% then settle
    const tau = 0.008;
    const dt = 1 / FS;
    for (let i = 1; i < n; i++) {
      const target = sp[i]!;
      gy[i] = gy[i - 1]! + (target - gy[i - 1]!) * Math.min(1, dt / tau);
      // add a decaying oscillation after each edge
      gy[i] = gy[i]! + 40 * Math.sin(i / 3) * 0; // placeholder, oscillation via lag below
    }
    // crude under-damped: second-order-ish via leaky integrator pair
    let v = 0;
    for (let i = 1; i < n; i++) {
      const err = sp[i]! - gy[i - 1]!;
      v += err * 0.02;
      v *= 0.94;
      gy[i] = gy[i - 1]! + v;
    }
    const steps = detectSteps(sp, FS);
    const m = stepResponseMetrics(gy, sp, steps, FS);
    expect(m.stepCount).toBeGreaterThan(0);
    expect(m.overshootPercent).toBeGreaterThan(15);
  });
});

describe("averageStepResponse", () => {
  it("produces a normalized curve approaching 1.0 at the plateau", () => {
    const { sp, gy } = makeLog();
    const steps = detectSteps(sp, FS);
    const curve = averageStepResponse(gy, sp, steps, FS, 150);
    expect(curve).not.toBeNull();
    const tail = curve!.response.slice(-10).filter((v) => !Number.isNaN(v));
    const meanTail = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(meanTail).toBeGreaterThan(0.7);
    expect(meanTail).toBeLessThan(1.3);
  });
});

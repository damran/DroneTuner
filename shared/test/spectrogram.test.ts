import { describe, expect, it } from "vitest";
import { classifyPeaks, computeSpectrogram } from "../src/analysis/spectrogram";

const FS = 2000;
const DURATION_S = 8;

/** throttle ramps 1000→2000 across the log */
function makeThrottle(n: number): Float32Array {
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = 1000 + (1000 * i) / n;
  return t;
}

describe("spectrogram peak classification", () => {
  it("classifies a fixed-frequency sine as a frame resonance", () => {
    const n = FS * DURATION_S;
    const gyro = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      gyro[i] = 5 * Math.sin((2 * Math.PI * 230 * i) / FS) + 0.05 * Math.sin((2 * Math.PI * 37 * i) / FS);
    }
    const sg = computeSpectrogram(gyro, FS, { throttle: makeThrottle(n) });
    const res = classifyPeaks("roll", sg);
    const p = res.peaks.find((p) => Math.abs(p.freqHz - 230) < 10);
    expect(p).toBeDefined();
    expect(p!.kind).toBe("frameResonance");
    expect(res.motorNoiseOnsetHz).toBeNull();
  });

  it("classifies a throttle-swept sine as a motor harmonic with an onset", () => {
    const n = FS * DURATION_S;
    const gyro = new Float32Array(n);
    const throttle = makeThrottle(n);
    // motor fundamental sweeps 100 → 300 Hz following the throttle
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const f = 100 + 0.2 * (throttle[i]! - 1000);
      phase += (2 * Math.PI * f) / FS;
      gyro[i] = 8 * Math.sin(phase);
    }
    const sg = computeSpectrogram(gyro, FS, { throttle, windowSize: 1024 });
    const res = classifyPeaks("roll", sg);
    const motor = res.peaks.filter((p) => p.kind === "motorHarmonic");
    expect(motor.length).toBeGreaterThan(0);
    expect(res.motorNoiseOnsetHz).not.toBeNull();
    expect(res.motorNoiseOnsetHz!).toBeGreaterThan(60);
    expect(res.motorNoiseOnsetHz!).toBeLessThan(180);
  });

  it("keeps a fixed resonance separate from a swept ridge crossing it", () => {
    const n = FS * DURATION_S;
    const gyro = new Float32Array(n);
    const throttle = makeThrottle(n);
    // Motor ridge sweeps 100→300 Hz with the throttle, crossing a fixed
    // 230 Hz frame resonance. Single-linkage chaining alone would absorb the
    // resonance into the ridge and misclassify it as motor noise.
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const f = 100 + 0.2 * (throttle[i]! - 1000);
      phase += (2 * Math.PI * f) / FS;
      gyro[i] = 8 * Math.sin(phase) + 5 * Math.sin((2 * Math.PI * 230 * i) / FS);
    }
    const sg = computeSpectrogram(gyro, FS, { throttle, windowSize: 1024 });
    const res = classifyPeaks("roll", sg);
    const fixed = res.peaks.find((p) => Math.abs(p.freqHz - 230) < 15);
    expect(fixed).toBeDefined();
    expect(fixed!.kind).toBe("frameResonance");
    expect(res.peaks.some((p) => p.kind === "motorHarmonic")).toBe(true);
  });

  it("reports no peaks on a quiet signal", () => {
    const n = FS * DURATION_S;
    const gyro = new Float32Array(n);
    // deterministic broadband noise (LCG) — no persistent spectral lines
    let seed = 12345;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      gyro[i] = (seed / 0x7fffffff - 0.5) * 0.1;
    }
    const sg = computeSpectrogram(gyro, FS, { throttle: makeThrottle(n) });
    const res = classifyPeaks("roll", sg);
    expect(res.peaks.length).toBe(0);
  });

  it("handles short/empty input gracefully", () => {
    const sg = computeSpectrogram(new Float32Array(100), FS);
    expect(sg.rows.length).toBe(0);
    const res = classifyPeaks("roll", sg);
    expect(res.peaks.length).toBe(0);
    expect(res.floor).toBe(0);
  });

  it("labels a fixed peak at the motors' idle speed as motorIdle, not a frame resonance", () => {
    const n = FS * DURATION_S;
    const gyro = new Float32Array(n);
    // Dynamic idle parks the motors at 2500 rpm (41.7 Hz) for the first half
    // of the log (hover at idle throttle), then the throttle ramps up.
    const throttle = new Float32Array(n);
    const erpm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      throttle[i] = i < n / 2 ? 1000 : 1000 + (2000 * (i - n / 2)) / n;
      erpm[i] = 42 + 0.25 * (throttle[i]! - 1000);
      gyro[i] = 6 * Math.sin((2 * Math.PI * 42 * i) / FS) + 5 * Math.sin((2 * Math.PI * 230 * i) / FS);
    }
    const sg = computeSpectrogram(gyro, FS, { throttle, erpmHz: erpm });
    const res = classifyPeaks("roll", sg, { minFreqHz: 30 });
    const idle = res.peaks.find((p) => Math.abs(p.freqHz - 42) < 8);
    const frame = res.peaks.find((p) => Math.abs(p.freqHz - 230) < 10);
    expect(idle?.kind).toBe("motorIdle");
    expect(frame?.kind).toBe("frameResonance");
  });
});

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
});

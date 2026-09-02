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

/** Constant-throttle hover: eRPM sits near `fmHz` with a little wander. */
function hoverMotors(n: number, fmHz: number, wanderHz = 6): { throttle: Float32Array; motorsHz: Float32Array[] } {
  const throttle = new Float32Array(n).fill(1350);
  const motorsHz = [0, 1, 2, 3].map(() => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const wander = wanderHz * Math.sin((2 * Math.PI * i) / (n / 3));
    for (let m = 0; m < 4; m++) motorsHz[m]![i] = fmHz + wander + (m - 1.5) * 2;
  }
  return { throttle, motorsHz };
}

/** Deterministic broadband noise so the spectra have a real floor (pure tones leave leakage "peaks"). */
function noise(n: number, amp: number): Float32Array {
  const out = new Float32Array(n);
  let seed = 4321;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed / 0x7fffffff - 0.5) * amp;
  }
  return out;
}

/** Sine that follows k × the mean motor frequency sample by sample, over a noise floor. */
function harmonicTone(motorsHz: Float32Array[], k: number, amp: number, fs: number): Float32Array {
  const n = motorsHz[0]!.length;
  const out = noise(n, 0.5);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    let fm = 0;
    for (const m of motorsHz) fm += m[i]!;
    fm /= motorsHz.length;
    phase += (2 * Math.PI * k * fm) / fs;
    out[i] += amp * Math.sin(phase);
  }
  return out;
}

/** 1 s windows: enough rows in an 8 s fixture for the presence/tracking tests. */
const HARMONIC_SG = { windowSize: 1024 } as const;

describe("spectrogram classification with eRPM harmonics", () => {
  it("labels a high-throttle ridge at 2× the motor frequency as a motor harmonic even when the throttle never moves", () => {
    // The Meteor75 Pro case: hovering at one throttle, motors near 345 Hz,
    // the unfiltered 2nd harmonic sits stable at ~690 Hz. Stability alone
    // used to make this a "frame resonance".
    const n = FS * DURATION_S;
    const { throttle, motorsHz } = hoverMotors(n, 345);
    const gyro = harmonicTone(motorsHz, 2, 6, FS);
    const sg = computeSpectrogram(gyro, FS, { throttle, motorsHz, ...HARMONIC_SG });
    const res = classifyPeaks("roll", sg, { maxFreqHz: 1000, headerPoles: 12 });
    const p = res.peaks.find((p) => Math.abs(p.freqHz - 690) < 25);
    expect(p).toBeDefined();
    expect(p!.kind).toBe("motorHarmonic");
    expect(p!.harmonic).toBe(2);
    expect(p!.aliased).toBe(false);
    expect(res.motorPoleCheck?.status).toBe("consistent");
  });

  it("recognises a 3rd harmonic folded at the log Nyquist as motor noise", () => {
    // 3 × 340 Hz = 1020 Hz lands at 2000 − 1020 = 980 Hz in a 2 kHz log.
    const n = FS * DURATION_S;
    const { throttle, motorsHz } = hoverMotors(n, 340, 4);
    const gyro = harmonicTone(motorsHz, 3, 6, FS); // sampled at FS it aliases by itself
    const sg = computeSpectrogram(gyro, FS, { throttle, motorsHz, ...HARMONIC_SG });
    const res = classifyPeaks("roll", sg, { maxFreqHz: 1000, headerPoles: 12 });
    const p = res.peaks.find((p) => p.freqHz > 940 && p.freqHz < 1000);
    expect(p).toBeDefined();
    expect(p!.kind).toBe("motorHarmonic");
    expect(p!.harmonic).toBe(3);
    expect(p!.aliased).toBe(true);
  });

  it("keeps a fixed resonance a frame resonance when the motors wander past it", () => {
    const n = FS * DURATION_S;
    const { throttle, motorsHz } = hoverMotors(n, 450, 25); // 2nd harmonic 850–950 Hz, alias 1050–1150 → out of band
    const gyro = noise(n, 0.5);
    for (let i = 0; i < n; i++) gyro[i] += 5 * Math.sin((2 * Math.PI * 233 * i) / FS);
    const sg = computeSpectrogram(gyro, FS, { throttle, motorsHz, ...HARMONIC_SG });
    const res = classifyPeaks("roll", sg, { maxFreqHz: 1000, headerPoles: 12 });
    const p = res.peaks.find((p) => Math.abs(p.freqHz - 233) < 10);
    expect(p?.kind).toBe("frameResonance");
    expect(p?.harmonic).toBeUndefined();
  });

  it("uses the header idle floor: a line at dyn_idle_min_rpm is motorIdle, not a resonance", () => {
    // 2500 rpm floor = 41.7 Hz while the mean motor speed hovers at 450 Hz.
    const n = FS * DURATION_S;
    const { throttle, motorsHz } = hoverMotors(n, 450, 5);
    const gyro = noise(n, 0.5);
    for (let i = 0; i < n; i++) gyro[i] += 6 * Math.sin((2 * Math.PI * 42 * i) / FS);
    const sg = computeSpectrogram(gyro, FS, { throttle, motorsHz, ...HARMONIC_SG });
    const res = classifyPeaks("roll", sg, { minFreqHz: 30, idleFloorHz: 2500 / 60, headerPoles: 12 });
    const p = res.peaks.find((p) => Math.abs(p.freqHz - 42) < 8);
    expect(p?.kind).toBe("motorIdle");
  });

  it("flags a pole-count mismatch when the strongest line sits at 12/14 of the expected fundamental", () => {
    // Header says 12 poles, the motors really have 14: eRPM-derived f is
    // 7/6 too high, so the true fundamental shows at 6/7 × f (≈ 0.857).
    const n = FS * DURATION_S;
    const { throttle, motorsHz } = hoverMotors(n, 400, 20);
    const trueMotors = motorsHz.map((c) => c.map((v) => (v * 12) / 14));
    const gyro = harmonicTone(trueMotors, 1, 8, FS);
    const sg = computeSpectrogram(gyro, FS, { throttle, motorsHz, ...HARMONIC_SG });
    const res = classifyPeaks("roll", sg, { maxFreqHz: 1000, headerPoles: 12 });
    expect(res.motorPoleCheck?.status).toBe("mismatch");
    expect(res.motorPoleCheck?.suggestedPoles).toBe(14);
    expect(res.motorPoleCheck?.harmonic).toBe(1);
  });
});

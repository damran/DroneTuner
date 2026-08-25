import { describe, expect, it } from "vitest";
import { amplitudeSpectrum, findPeaks, nextPow2, rms } from "../src/analysis/fft";

describe("fft", () => {
  it("nextPow2", () => {
    expect(nextPow2(1000)).toBe(1024);
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(1024)).toBe(1024);
  });

  it("detects a 100 Hz sine peak", () => {
    const sr = 1000;
    const n = 1024;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * 100 * i) / sr);
    const spec = amplitudeSpectrum(samples, sr, { maxSize: 2048 });
    const peaks = findPeaks(spec, { minFreqHz: 20, maxFreqHz: 500, maxPeaks: 3 });
    expect(peaks.length).toBeGreaterThan(0);
    expect(Math.round(peaks[0]!.freqHz)).toBe(100);
  });

  it("rms", () => {
    expect(rms([3, 4])).toBeCloseTo(3.5355, 2);
  });
});

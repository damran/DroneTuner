import type { ParsedLog } from "../blackbox/types";
import { amplitudeSpectrum, findPeaks, median, rms } from "./fft";
import { detectSteps, stepResponseMetrics } from "./steps";
import type { AxisStepMetrics, LogMetrics, NoisePeak } from "./types";
import { AXES, type Axis } from "../types/fc";
const AXIS_INDEX: Record<Axis, number> = { roll: 0, pitch: 1, yaw: 2 };

function channel(log: ParsedLog, name: string): Float32Array | undefined {
  return log.channels[name];
}

function sampleRateOf(log: ParsedLog): number {
  const t = log.timeUs;
  if (t.length < 8) return 0;
  const dts: number[] = [];
  for (let i = 1; i < Math.min(t.length, 2000); i++) {
    const dt = t[i]! - t[i - 1]!;
    if (dt > 0) dts.push(dt);
  }
  if (dts.length === 0) return 0;
  const med = median(dts);
  return med > 0 ? 1e6 / med : 0;
}

export function computeMetrics(log: ParsedLog): LogMetrics {
  const warnings = [...log.warnings];
  const sampleRate = sampleRateOf(log);
  const frameCount = log.frameCount;
  const durationS = log.timeUs.length > 1 ? (log.timeUs[log.timeUs.length - 1]! - log.timeUs[0]!) / 1e6 : 0;

  const gyroScale = log.gyroScale ?? null;

  const noisePeaks: NoisePeak[] = [];
  const noiseFloor = { roll: 0, pitch: 0, yaw: 0 } as Record<Axis, number>;
  const dtermRms = { roll: 0, pitch: 0, yaw: 0 } as Record<Axis, number>;
  const stepResponse: AxisStepMetrics[] = [];

  const nyquist = sampleRate / 2;

  for (const axis of AXES) {
    const idx = AXIS_INDEX[axis];
    const gyroRaw = channel(log, `gyroADC[${idx}]`);
    if (gyroRaw && gyroRaw.length > 256 && sampleRate > 0) {
      const gyro = gyroScale ? gyroRaw.map((v) => v * gyroScale) : gyroRaw;
      // Analyze a window from the middle of the flight — the start of a log
      // contains arming/spool-up transients that skew the noise spectrum.
      const fftSize = Math.min(16384, gyro.length);
      const spec = amplitudeSpectrum(gyro, sampleRate, {
        maxSize: fftSize,
        offset: Math.max(0, Math.floor((gyro.length - fftSize) / 2)),
      });
      const maxFreq = Math.min(nyquist, 600);
      const peaks = findPeaks(spec, { minFreqHz: 20, maxFreqHz: maxFreq, maxPeaks: 3, prominenceRatio: 4 });
      for (const p of peaks) noisePeaks.push({ axis, freqHz: p.freqHz, magnitude: p.magnitude });
      noiseFloor[axis] = median(spec.magnitudes.subarray(1));

      const setpoint = channel(log, `setpoint[${idx}]`);
      if (setpoint && setpoint.length > 256) {
        const steps = detectSteps(setpoint, sampleRate);
        const m = stepResponseMetrics(gyro, setpoint, steps, sampleRate);
        m.axis = axis;
        stepResponse.push(m);
      }
    }

    const dterm = channel(log, `axisD[${idx}]`);
    if (dterm && dterm.length > 64) {
      // axisD is logged in raw PID-sum units, NOT gyro units — do not apply
      // gyroScale here; the value is a relative activity indicator only.
      dtermRms[axis] = rms(dterm);
    }
  }

  // Motor saturation
  let motorSaturationPercent = 0;
  const motorMax = parseMotorMax(log);
  const motorChannels = [0, 1, 2, 3].map((i) => channel(log, `motor[${i}]`)).filter(Boolean) as Float32Array[];
  if (motorChannels.length > 0 && motorMax > 0) {
    let sat = 0;
    const n = Math.min(...motorChannels.map((c) => c.length));
    for (let i = 0; i < n; i++) {
      for (const c of motorChannels) {
        if (c[i]! >= motorMax) {
          sat++;
          break;
        }
      }
    }
    motorSaturationPercent = n > 0 ? (sat / n) * 100 : 0;
  }

  // Throttle
  const throttle = channel(log, "rcCommand[3]") ?? channel(log, "setpoint[3]");
  let throttleAvg = 0;
  if (throttle && throttle.length > 0) {
    let sum = 0;
    for (let i = 0; i < throttle.length; i++) sum += throttle[i]!;
    throttleAvg = sum / throttle.length;
  }

  // Battery
  const vbat = channel(log, "vbatLatest");
  let vbatMinV: number | null = null;
  let vbatAvgV: number | null = null;
  let vbatSagV: number | null = null;
  if (vbat && vbat.length > 0) {
    let min = Infinity;
    let sum = 0;
    for (let i = 0; i < vbat.length; i++) {
      const v = vbat[i]! / 10;
      if (v < min) min = v;
      sum += v;
    }
    vbatMinV = min;
    vbatAvgV = sum / vbat.length;

    // sag: high-throttle vs low-throttle voltage
    if (throttle && throttle.length > 0) {
      const loaded: number[] = [];
      const rest: number[] = [];
      const n = Math.min(vbat.length, throttle.length);
      for (let i = 0; i < n; i++) {
        const v = vbat[i]! / 10;
        if (throttle[i]! > 1500) loaded.push(v);
        else rest.push(v);
      }
      if (loaded.length > 32 && rest.length > 32) {
        const restV = median(rest);
        const loadedV = median(loaded);
        vbatSagV = Math.max(0, restV - loadedV);
      }
    }
  }

  // Filter latency (rough): half the average rise time
  let filterLatencyMs: number | null = null;
  const rises = stepResponse.map((s) => s.riseTimeMs).filter((r) => r > 0);
  if (rises.length > 0) {
    filterLatencyMs = Math.round(median(rises) / 2);
  }

  const rpmFilterActive =
    channel(log, "eRPM[0]") !== undefined ||
    log.headers["dshot_bidir"] === "ON" ||
    log.headers["debug_mode"] === "RPM_FILTER";

  return {
    durationS,
    sampleRateHz: Math.round(sampleRate),
    frameCount,
    noisePeaks,
    noiseFloor,
    stepResponse,
    dtermRms,
    motorSaturationPercent,
    throttleAvg,
    vbatMinV,
    vbatAvgV,
    vbatSagV,
    filterLatencyMs,
    rpmFilterActive,
    warnings,
  };
}

function parseMotorMax(log: ParsedLog): number {
  const mo = log.headers["motorOutput"];
  if (mo) {
    const parts = mo.split(",").map((s) => Number.parseInt(s.trim(), 10));
    if (parts.length >= 2 && !Number.isNaN(parts[1])) return parts[1]!;
  }
  const maxthrottle = log.headers["maxthrottle"];
  if (maxthrottle) {
    const v = Number.parseInt(maxthrottle, 10);
    if (!Number.isNaN(v)) return v;
  }
  return 2047;
}

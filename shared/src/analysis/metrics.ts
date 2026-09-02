import type { ParsedLog } from "../blackbox/types";
import { median } from "./fft";
import { computeRatesUsage } from "./rates";
import { analyzeAxisStepResponse } from "./stepresponse";
import {
  airborneMask,
  classifyPeaks,
  computeSpectrogram,
  estimateIdleFloorHz,
  motorHzChannels,
  motorPolesFromHeaders,
  type AxisSpectral,
  type MotorPoleCheck,
} from "./spectrogram";
import { estimateFilterDelay, filterConfigFromHeaders } from "./delay";
import type { AxisStepMetrics, LogMetrics, NoisePeak } from "./types";
import { AXES, type Axis } from "../types/fc";
const AXIS_INDEX: Record<Axis, number> = { roll: 0, pitch: 1, yaw: 2 };

function channel(log: ParsedLog, name: string): Float32Array | undefined {
  return log.channels[name];
}

/**
 * The log's throttle channel: rcCommand[3] (1000–2000) with setpoint[3]
 * (~0–1000) as fallback. Shared by the metrics pipeline and the Log Lab
 * worker so traces and findings always describe the same signal.
 */
export function throttleChannel(log: ParsedLog): Float32Array | undefined {
  return channel(log, "rcCommand[3]") ?? channel(log, "setpoint[3]");
}

/** Gyro channel for an axis, scaled to deg/s when the log carries a gyroScale. */
export function scaledGyroChannel(log: ParsedLog, axisIndex: number): Float32Array | undefined {
  const raw = channel(log, `gyroADC[${axisIndex}]`);
  if (!raw) return undefined;
  return log.gyroScale ? raw.map((v) => v * log.gyroScale!) : raw;
}

/**
 * The pre-filter gyro (gyroUnfilt, logged by Betaflight 4.5 regardless of
 * debug mode), scaled like gyroADC. Undefined on older logs.
 */
export function scaledRawGyroChannel(log: ParsedLog, axisIndex: number): Float32Array | undefined {
  const raw = channel(log, `gyroUnfilt[${axisIndex}]`);
  if (!raw || raw.length < 256) return undefined;
  return log.gyroScale ? raw.map((v) => v * log.gyroScale!) : raw;
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

/** RMS over the airborne mask and both throttle-band masks in ONE pass. */
function maskedRms3(
  values: Float32Array,
  mask: Uint8Array | null,
  lowMask: Uint8Array | null,
  highMask: Uint8Array | null,
): [number, number, number] {
  let sum = 0;
  let n = 0;
  let sumLo = 0;
  let nLo = 0;
  let sumHi = 0;
  let nHi = 0;
  const len = values.length;
  for (let i = 0; i < len; i++) {
    const v = values[i]!;
    const v2 = v * v;
    if (!mask || (i < mask.length && mask[i])) {
      sum += v2;
      n++;
    }
    if (lowMask && i < lowMask.length && lowMask[i]) {
      sumLo += v2;
      nLo++;
    }
    if (highMask && i < highMask.length && highMask[i]) {
      sumHi += v2;
      nHi++;
    }
  }
  return [n > 0 ? Math.sqrt(sum / n) : 0, nLo > 0 ? Math.sqrt(sumLo / nLo) : 0, nHi > 0 ? Math.sqrt(sumHi / nHi) : 0];
}

/**
 * Approximate quartiles of airborne throttle values via a fixed-bucket
 * histogram — O(n) without materializing or sorting a copy of the log.
 * Throttle channels are bounded (rcCommand 1000–2000, setpoint ~0–1000).
 */
function throttleQuartiles(
  throttle: Float32Array,
  mask: Uint8Array,
): { q1: number; q3: number; count: number } | null {
  const BUCKETS = 2048;
  const hist = new Uint32Array(BUCKETS);
  const n = Math.min(throttle.length, mask.length);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const v = throttle[i]!;
    const b = v <= 0 ? 0 : v >= BUCKETS - 1 ? BUCKETS - 1 : Math.round(v);
    hist[b]!++;
    count++;
  }
  if (count < 64) return null;
  const pick = (rank: number): number => {
    let acc = 0;
    for (let b = 0; b < BUCKETS; b++) {
      acc += hist[b]!;
      if (acc >= rank) return b;
    }
    return BUCKETS - 1;
  };
  return { q1: pick(Math.floor(count * 0.25)), q3: pick(Math.floor(count * 0.75)), count };
}

export function computeMetrics(log: ParsedLog): LogMetrics {
  const warnings = [...log.warnings];
  const sampleRate = sampleRateOf(log);
  const frameCount = log.frameCount;
  const durationS = log.timeUs.length > 1 ? (log.timeUs[log.timeUs.length - 1]! - log.timeUs[0]!) / 1e6 : 0;

  const mask = airborneMask(log);
  const throttle = throttleChannel(log);
  const motorsHz = motorHzChannels(log);
  const erpmHz = motorsHz ? meanOfChannels(motorsHz) : null;
  const idleFloorHz = estimateIdleFloorHz(log.headers, motorsHz);
  const headerPoles = motorsHz ? motorPolesFromHeaders(log.headers) : null;

  const noisePeaks: NoisePeak[] = [];
  const noiseFloor = { roll: 0, pitch: 0, yaw: 0 } as Record<Axis, number>;
  const dtermRms = { roll: 0, pitch: 0, yaw: 0 } as Record<Axis, number>;
  const dtermRmsLowThrottle = { roll: 0, pitch: 0, yaw: 0 } as Record<Axis, number>;
  const dtermRmsHighThrottle = { roll: 0, pitch: 0, yaw: 0 } as Record<Axis, number>;
  const stepResponse: AxisStepMetrics[] = [];
  const spectral: AxisSpectral[] = [];
  const spectralRaw: AxisSpectral[] = [];

  const nyquist = sampleRate / 2;

  // Low/high-throttle masks for the D-term band split (Rosser's AOS method:
  // dyn min is tuned at zero throttle, dyn max at full throttle). Bands are
  // relative to THIS log's airborne throttle quartiles so quads that never
  // see full throttle still get a meaningful split.
  let lowMask: Uint8Array | null = null;
  let highMask: Uint8Array | null = null;
  let throttleBands: LogMetrics["throttleBands"] = null;
  if (throttle && mask) {
    const quartiles = throttleQuartiles(throttle, mask);
    if (quartiles) {
      const n = Math.min(throttle.length, mask.length);
      lowMask = new Uint8Array(n);
      highMask = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (!mask[i]) continue;
        if (throttle[i]! <= quartiles.q1) lowMask[i] = 1;
        else if (throttle[i]! >= quartiles.q3) highMask[i] = 1;
      }
      // rcCommand[3] is already 1000–2000; setpoint[3] is ~0–1000.
      const toUs = (v: number) => (channel(log, "rcCommand[3]") ? v : 1000 + v);
      throttleBands = { lowMaxUs: Math.round(toUs(quartiles.q1)), highMinUs: Math.round(toUs(quartiles.q3)) };
    }
  }

  for (const axis of AXES) {
    const idx = AXIS_INDEX[axis];
    const gyro = scaledGyroChannel(log, idx);
    if (gyro && gyro.length > 256 && sampleRate > 0) {
      // Time–frequency analysis over airborne windows: frame resonances are
      // throttle-independent (vertical stripes), motor harmonics sweep with
      // throttle (diagonal ridges) — the classification drives which filter
      // the rule engine targets.
      const sg = computeSpectrogram(gyro, sampleRate, {
        mask,
        throttle,
        erpmHz: erpmHz ?? undefined,
        motorsHz: motorsHz ?? undefined,
      });
      // Peaks are looked for up to the log's Nyquist: with eRPM the classifier
      // recognises folded motor harmonics there, and cutting at 800 Hz would
      // hide exactly the high-throttle ridges a 2 kHz log shows.
      const spec = classifyPeaks(axis, sg, {
        minFreqHz: 40,
        maxFreqHz: Math.min(nyquist, motorsHz ? 1000 : 800),
        idleFloorHz,
        headerPoles,
      });
      spectral.push(spec);
      noiseFloor[axis] = spec.floor;
      for (const p of spec.peaks) {
        noisePeaks.push({ axis, freqHz: p.freqHz, magnitude: p.magnitude });
      }

      // Same analysis on the pre-filter gyro: the noise the filter chain has
      // to remove (motor lines the RPM filter should notch, stripes the
      // dynamic notch should cover). Classifying both sides is what lets the
      // rules say "the notch works — push its Q" versus "no stripe at all —
      // switch the notch off" (Rosser's filter method reads the raw view).
      const rawGyro = scaledRawGyroChannel(log, idx);
      if (rawGyro) {
        const sgRaw = computeSpectrogram(rawGyro, sampleRate, {
          mask,
          throttle,
          erpmHz: erpmHz ?? undefined,
          motorsHz: motorsHz ?? undefined,
        });
        spectralRaw.push(
          classifyPeaks(axis, sgRaw, {
            minFreqHz: 40,
            maxFreqHz: Math.min(nyquist, motorsHz ? 1000 : 800),
            idleFloorHz,
            headerPoles,
          }),
        );
      }

      const setpoint = channel(log, `setpoint[${idx}]`);
      if (setpoint && setpoint.length > 256) {
        stepResponse.push(analyzeAxisStepResponse(axis, gyro, setpoint, sampleRate, { mask }).metrics);
      }
    }

    const dterm = channel(log, `axisD[${idx}]`);
    if (dterm && dterm.length > 64) {
      // axisD is logged in raw PID-sum units, NOT gyro units — do not apply
      // gyroScale here; the value is a relative activity indicator only.
      const [all, lo, hi] = maskedRms3(dterm, mask, lowMask, highMask);
      dtermRms[axis] = all;
      if (lowMask && highMask) {
        dtermRmsLowThrottle[axis] = lo;
        dtermRmsHighThrottle[axis] = hi;
      }
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
      if (mask && i < mask.length && !mask[i]) continue;
      for (const c of motorChannels) {
        if (c[i]! >= motorMax) {
          sat++;
          break;
        }
      }
    }
    const airborneFrames = mask ? mask.reduce((a, b) => a + b, 0) : n;
    motorSaturationPercent = airborneFrames > 0 ? (sat / airborneFrames) * 100 : 0;
  }

  // Throttle average over airborne frames only — idle/ground time would skew it.
  let throttleAvg = 0;
  if (throttle && throttle.length > 0) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < throttle.length; i++) {
      if (mask && (i >= mask.length || !mask[i])) continue;
      sum += throttle[i]!;
      n++;
    }
    throttleAvg = n > 0 ? sum / n : 0;
  }

  // Battery — blackbox logs vbatLatest in centivolts (0.01 V units, same
  // scale as the vbatref/vbatcellvoltage headers), so /100 for volts.
  const vbat = channel(log, "vbatLatest");
  let vbatMinV: number | null = null;
  let vbatAvgV: number | null = null;
  let vbatSagV: number | null = null;
  if (vbat && vbat.length > 0) {
    let min = Infinity;
    let sum = 0;
    for (let i = 0; i < vbat.length; i++) {
      const v = vbat[i]! / 100;
      if (v < min) min = v;
      sum += v;
    }
    vbatMinV = min;
    vbatAvgV = sum / vbat.length;

    // Sag: loaded vs resting voltage, split by THIS log's airborne throttle
    // quartiles — scale-independent, so it works whether the throttle channel
    // is rcCommand (1000–2000) or setpoint[3] (~0–1000).
    if (throttle && mask) {
      const quartiles = throttleQuartiles(throttle, mask);
      if (quartiles) {
        const loaded: number[] = [];
        const rest: number[] = [];
        const n = Math.min(vbat.length, throttle.length, mask.length);
        for (let i = 0; i < n; i++) {
          if (!mask[i]) continue;
          const t = throttle[i]!;
          const v = vbat[i]! / 100;
          if (t >= quartiles.q3) loaded.push(v);
          else if (t <= quartiles.q1) rest.push(v);
        }
        if (loaded.length > 32 && rest.length > 32) {
          const restV = median(rest);
          const loadedV = median(loaded);
          vbatSagV = Math.max(0, restV - loadedV);
        }
      }
    }
  }

  // Deprecated proxy (kept for backward compat with persisted analyses):
  // half the median rise time. The real delay estimate is `filterDelay`.
  let filterLatencyMs: number | null = null;
  const rises = stepResponse.map((s) => s.riseTimeMs).filter((r) => r > 0);
  if (rises.length > 0) {
    filterLatencyMs = Math.round(median(rises) / 2);
  }

  // Blackbox logs these headers as integers (e.g. dshot_bidir:1,
  // debug_mode:6) — DEBUG_RPM_FILTER is enum value 6 in BF's build/debug.h.
  const debugMode = Number.parseInt(log.headers["debug_mode"] ?? "", 10);
  const rpmFilterActive =
    channel(log, "eRPM[0]") !== undefined ||
    log.headers["dshot_bidir"] === "1" ||
    debugMode === 6;

  // Gyro/PID rates from headers: the blackbox `looptime` header is the gyro
  // task period (µs); the PID loop runs at gyro / pid_process_denom.
  let pidLoopRateHz: number | null = null;
  let gyroRateHz: number | null = null;
  const looptimeUs = log.looptimeUs ?? Number.parseFloat(log.headers["looptime"] ?? "");
  if (Number.isFinite(looptimeUs) && looptimeUs > 0) {
    gyroRateHz = 1e6 / looptimeUs;
    const denom = Number.parseInt(log.headers["pid_process_denom"] ?? "", 10);
    pidLoopRateHz = gyroRateHz / (Number.isFinite(denom) && denom > 0 ? denom : 1);
  }

  // Group delay of the filter chain in effect during this flight.
  const flownFilters = filterConfigFromHeaders(log.headers);
  const strongestResonance = spectral
    .flatMap((s) => s.peaks)
    .filter((p) => p.kind === "frameResonance")
    .sort((a, b) => b.ratioToFloor - a.ratioToFloor)[0];
  const filterDelay = estimateFilterDelay(flownFilters, {
    gyroRateHz,
    pidLoopRateHz,
    resonanceHz: strongestResonance?.freqHz ?? null,
  });

  // PIDs flown, from "H rollPID:p,i,d" style headers.
  const flownPids = (() => {
    const parse = (name: string) => {
      const raw = log.headers[name];
      if (!raw) return null;
      const parts = raw.split(",").map((s) => Number.parseInt(s.trim(), 10));
      if (parts.length < 3 || parts.some((v) => Number.isNaN(v))) return null;
      return { p: parts[0]!, i: parts[1]!, d: parts[2]! };
    };
    const roll = parse("rollPID");
    const pitch = parse("pitchPID");
    const yaw = parse("yawPID");
    return roll && pitch && yaw ? { roll, pitch, yaw } : null;
  })();

  // Advanced settings flown (blackbox logs these as ints; enum fields arrive
  // as their index). Per-axis feedforward gains are NOT logged by blackbox.
  const flownAdvanced = (() => {
    const h = log.headers;
    const int = (name: string) => {
      const raw = h[name];
      if (raw === undefined) return null;
      const v = Number.parseInt(raw, 10);
      return Number.isNaN(v) ? null : v;
    };
    const dMin = h["d_min"]?.split(",").map((s) => Number.parseInt(s.trim(), 10));
    const out: Record<string, number> = {};
    const put = (field: string, v: number | null) => {
      if (v !== null) out[field] = v;
    };
    put("feedforwardTransition", int("feedforward_transition"));
    put("feedforwardAveraging", int("feedforward_averaging"));
    put("feedforwardSmoothFactor", int("feedforward_smooth_factor"));
    put("feedforwardBoost", int("feedforward_boost"));
    put("feedforwardMaxRateLimit", int("feedforward_max_rate_limit"));
    put("feedforwardJitterFactor", int("feedforward_jitter_factor"));
    put("itermRelax", int("iterm_relax"));
    put("itermRelaxCutoff", int("iterm_relax_cutoff"));
    put("antiGravityGain", int("anti_gravity_gain"));
    put("tpaMode", int("tpa_mode"));
    put("tpaRate", int("tpa_rate"));
    put("tpaBreakpoint", int("tpa_breakpoint"));
    put("dMaxGain", int("d_max_gain"));
    put("dMaxAdvance", int("d_max_advance"));
    put("thrustLinear", int("thrust_linear"));
    put("vbatSagCompensation", int("vbat_sag_compensation"));
    put("idleMinRpm", int("dyn_idle_min_rpm"));
    if (dMin && dMin.length >= 2 && !dMin.slice(0, 2).some((v) => Number.isNaN(v))) {
      out.dMinRoll = dMin[0]!;
      out.dMinPitch = dMin[1]!;
    }
    return Object.keys(out).length > 0 ? out : null;
  })();

  // Header-only settings the rules read (never MSP-written).
  const flownExtras = (() => {
    const h = log.headers;
    const int = (name: string) => {
      const raw = h[name];
      if (raw === undefined) return undefined;
      const v = Number.parseInt(raw, 10);
      return Number.isNaN(v) ? undefined : v;
    };
    const out: NonNullable<LogMetrics["flownExtras"]> = {};
    const pidsumLimit = int("pidsum_limit");
    const pidsumLimitYaw = int("pidsum_limit_yaw");
    const rcSmoothingAutoFactor = int("rc_smoothing_auto_factor");
    const absControlGain = int("abs_control_gain");
    if (pidsumLimit !== undefined) out.pidsumLimit = pidsumLimit;
    if (pidsumLimitYaw !== undefined) out.pidsumLimitYaw = pidsumLimitYaw;
    if (rcSmoothingAutoFactor !== undefined) out.rcSmoothingAutoFactor = rcSmoothingAutoFactor;
    if (absControlGain !== undefined) out.absControlGain = absControlGain;
    return Object.keys(out).length > 0 ? out : undefined;
  })();

  // Strongest pole-count evidence across axes and both gyro views (the raw
  // gyro shows the motor lines the filters remove, so its evidence is the
  // stronger one): a confirmed harmonic beats a mismatch candidate (a wrong
  // pole count leaves no integer harmonics).
  const poleChecks = [...spectralRaw, ...spectral]
    .map((s) => s.motorPoleCheck)
    .filter((c): c is MotorPoleCheck => !!c);
  const pickStrongest = (status: MotorPoleCheck["status"]) =>
    poleChecks
      .filter((c) => c.status === status)
      .sort((a, b) => (b.ratioToFloor ?? 0) - (a.ratioToFloor ?? 0))[0] ?? null;
  const motorPoleCheck: MotorPoleCheck | null = !motorsHz
    ? null
    : (pickStrongest("consistent") ?? pickStrongest("mismatch") ?? poleChecks[0] ?? null);

  const ratesUsage = computeRatesUsage(log);
  if (!ratesUsage) {
    warnings.push("No setpoint channels in this log — rates usage analysis unavailable.");
  }

  return {
    durationS,
    sampleRateHz: Math.round(sampleRate),
    frameCount,
    noisePeaks,
    noiseFloor,
    stepResponse,
    dtermRms,
    dtermRmsLowThrottle,
    dtermRmsHighThrottle,
    motorSaturationPercent,
    throttleAvg,
    vbatMinV,
    vbatAvgV,
    vbatSagV,
    filterLatencyMs,
    rpmFilterActive,
    spectral,
    spectralRaw: spectralRaw.length > 0 ? spectralRaw : undefined,
    throttleBands,
    flownExtras,
    filterDelay,
    gyroRateHz: gyroRateHz ? Math.round(gyroRateHz) : null,
    pidLoopRateHz: pidLoopRateHz ? Math.round(pidLoopRateHz) : null,
    flownConfig: { filters: flownFilters, pids: flownPids, advanced: flownAdvanced },
    motorPoleCheck,
    ratesUsage,
    warnings,
  };
}

function meanOfChannels(channels: Float32Array[]): Float32Array {
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const c of channels) s += c[i]!;
    out[i] = s / channels.length;
  }
  return out;
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

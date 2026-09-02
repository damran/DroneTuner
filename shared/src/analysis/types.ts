import type { AdvancedSettings, Axis, ProfileSettings } from "../types/fc";
import type { RatesUsage } from "./rates";
import type { AxisSpectral, MotorPoleCheck } from "./spectrogram";
import type { DelayFilterConfig, FilterDelayEstimate } from "./delay";

export interface NoisePeak {
  axis: Axis;
  freqHz: number;
  /** relative magnitude (linear, FFT amplitude) */
  magnitude: number;
}

export interface AxisStepMetrics {
  axis: Axis;
  /** averaged step-response overshoot in % (0 when no steps found) */
  overshootPercent: number;
  riseTimeMs: number;
  settlingTimeMs: number;
  /** time until the gyro first moves ≥5% of the step (PTB "latency") */
  latencyMs?: number;
  /** full oscillation cycles around the setpoint after first reaching it */
  ringingCycles?: number;
  /** mean |gyro−setpoint| over the plateau hold, in % of the step */
  steadyStateErrorPercent?: number;
  /**
   * FF start-of-move lag: gyro 50%-rise time minus setpoint 50%-rise time.
   * Positive = gyro lags (FF/boost too low); negative = gyro leads (boost
   * too high).
   */
  ffStartLagMs?: number;
  /** overshoot on return moves (end of a wiggle) — high means FF too high */
  ffEndOvershootPercent?: number | null;
  /** explicit stick steps found by the edge detector */
  stepCount: number;
  /**
   * Where overshoot/rise/latency/settling/ringing come from: "steps" =
   * averaged explicit stick steps; "deconvolution" = system identification
   * over 2 s windows with stick input (PIDtoolbox method), used when explicit
   * steps are scarce. Absent in analyses persisted before this existed.
   */
  method?: "steps" | "deconvolution";
  /** windows that fed the deconvolution estimate */
  windowCount?: number;
  /**
   * Low-frequency gyro/setpoint gain before normalisation (deconvolution
   * only). Well below 1 on disturbance-heavy indoor flights.
   */
  trackingGain?: number;
}

export interface LogMetrics {
  durationS: number;
  sampleRateHz: number;
  frameCount: number;
  /** strongest spectral peaks per gyro axis */
  noisePeaks: NoisePeak[];
  /** median noise floor per axis (linear magnitude) */
  noiseFloor: Record<Axis, number>;
  stepResponse: AxisStepMetrics[];
  /**
   * RMS of the D-term trace per axis over airborne frames, in raw PID-sum
   * units (as logged in axisD[n]). Not deg/s — use as a relative
   * activity/noise indicator only.
   */
  dtermRms: Record<Axis, number>;
  /** D-term RMS restricted to the low-throttle quartile of airborne frames.
   *  Optional: absent in analyses persisted before the band split existed. */
  dtermRmsLowThrottle?: Record<Axis, number>;
  /** D-term RMS restricted to the high-throttle quartile of airborne frames */
  dtermRmsHighThrottle?: Record<Axis, number>;
  /** % of frames with any motor at/above max */
  motorSaturationPercent: number;
  throttleAvg: number;
  vbatMinV: number | null;
  vbatAvgV: number | null;
  /** drop from resting to loaded voltage */
  vbatSagV: number | null;
  /**
   * @deprecated Rough rise-time-derived proxy kept for backward compat with
   * persisted analyses — use `filterDelay` (true group-delay estimate).
   */
  filterLatencyMs: number | null;
  rpmFilterActive: boolean;
  /**
   * Per-axis time–frequency noise analysis (frame resonances vs motor
   * harmonics). Absent in analyses persisted before the spectrogram existed.
   */
  spectral?: AxisSpectral[];
  /**
   * Group-delay estimate of the configured filter chain (from log headers).
   * Absent in analyses persisted before the delay estimator existed.
   */
  filterDelay?: FilterDelayEstimate | null;
  /**
   * motor_poles sanity check against the eRPM-derived motor frequency (the
   * strongest evidence across axes). Null when the log has no eRPM channels;
   * absent in analyses persisted before the check existed.
   */
  motorPoleCheck?: MotorPoleCheck | null;
  /** gyro sample rate / PID loop rate from log headers (null when unknown) */
  gyroRateHz?: number | null;
  pidLoopRateHz?: number | null;
  /**
   * The config actually flown in this log (from blackbox headers) — the
   * correct baseline for recommendations when no profile base is given.
   * Note: blackbox does not log per-axis feedforward gains, so
   * `advanced.feedforwardRoll/Pitch/Yaw` are never present here.
   */
  flownConfig?: {
    filters: DelayFilterConfig;
    pids: Record<Axis, { p: number; i: number; d: number }> | null;
    advanced: Partial<AdvancedSettings> | null;
  };
  /**
   * Stick/rate usage stats (setpoint histogram, zones, achieved-vs-commanded).
   * Absent in analyses persisted before the rates advisor existed — the UI
   * offers to re-analyze in that case. Null when the log lacks setpoint data.
   */
  ratesUsage?: RatesUsage | null;
  /** non-fatal caveats discovered while parsing/analyzing */
  warnings: string[];
}

export type FindingSeverity = "info" | "warning" | "critical";

export interface Finding {
  id: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  relatedMetrics?: string[];
}

export interface Recommendation {
  id: string;
  findingId?: string;
  rationale: string;
  changes: ProfileSettings;
  /** goal-weighted score 0..1 */
  score: number;
  /**
   * Absolute BF 4.5 CLI lines for this change (deltas resolved against the
   * base profile or BF defaults) — the "give me the config" path. Keys that
   * MSP can't write on 4.4/4.5 (CLI_ONLY_KEYS) only ever appear here.
   */
  cliLines?: string[];
}

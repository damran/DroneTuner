import type { Axis, ProfileSettings } from "../types/fc";

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
  stepCount: number;
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
   * RMS of the D-term trace per axis, in raw PID-sum units (as logged in
   * axisD[n]). Not deg/s — use as a relative activity/noise indicator only.
   */
  dtermRms: Record<Axis, number>;
  /** % of frames with any motor at/above max */
  motorSaturationPercent: number;
  throttleAvg: number;
  vbatMinV: number | null;
  vbatAvgV: number | null;
  /** drop from resting to loaded voltage */
  vbatSagV: number | null;
  /** rough estimate from step-response rise time */
  filterLatencyMs: number | null;
  rpmFilterActive: boolean;
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
}

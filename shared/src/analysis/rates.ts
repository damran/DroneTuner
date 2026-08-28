import type { ParsedLog } from "../blackbox/types";
import { AXES, type Axis } from "../types/fc";
import { median } from "./fft";

/**
 * Rates usage extraction: how the pilot actually uses the stick range, built
 * from the blackbox `setpoint[n]` channels (logged in deg/s on BF 4.x).
 *
 * Methodology follows nils vo's "Perfect FPV Rates with Science?" (four
 * rotation zones, rate-usage histogram) and Joshua Bardwell's "Find YOUR
 * perfect rates!" (achieved vs commanded rates — the gyro channel shows what
 * the quad physically does, not just what it was asked to do).
 */

export const RATE_ZONE_BOUNDS = [50, 300, 600] as const;
export type RateZone = "precision" | "normal" | "deadspace" | "trick";

export const RATES_BIN_WIDTH = 25;
/** 48 bins cover 0..1200 deg/s; the last bin is the >=1200 overflow bin. */
export const RATES_BIN_COUNT = 49;

/** Betaflight 4.5 factory defaults (Actual rates). */
export const BF_DEFAULT_RATES: AxisRates = { center: 70, max: 670, expo: 0.5 };

export interface AxisRateUsage {
  axis: Axis;
  /** counts per bin, airborne frames only */
  histogram: number[];
  /** share of airborne frames per zone (0..1) */
  zones: Record<RateZone, number>;
  p50: number;
  p90: number;
  p99: number;
  maxDegS: number;
  /** % of airborne frames with |setpoint| >= 90% of the logged max rate */
  saturationPercent: number;
  /** p99 of |gyro| (deg/s) on airborne frames — what the quad physically achieves */
  achievedP99DegS: number | null;
  /**
   * median |gyro| / |setpoint| over airborne frames where |setpoint| >= 50% of
   * the logged max rate. Below ~0.9 the quad physically can't reach the
   * commanded rate (motor/inertia cap).
   */
  highDeflectionTracking: number | null;
}

/** Actual-rates triple in real units (deg/s, deg/s, 0..1). */
export interface AxisRates {
  center: number;
  max: number;
  expo: number;
}

export interface LoggedRates {
  roll: AxisRates;
  pitch: AxisRates;
  yaw: AxisRates;
  /** per-axis rate limits in deg/s (roll, pitch, yaw), when logged */
  rateLimits: [number, number, number] | null;
  /** true when a rates_type header exists and isn't ACTUAL */
  legacyType: boolean;
}

export interface RatesUsage {
  binWidthDegS: number;
  binCount: number;
  /** fraction of frames that counted as airborne */
  airborneShare: number;
  axes: AxisRateUsage[];
  loggedRates: LoggedRates | null;
}

const AXIS_INDEX: Record<Axis, number> = { roll: 0, pitch: 1, yaw: 2 };

function zoneFor(binStart: number): RateZone {
  if (binStart < RATE_ZONE_BOUNDS[0]) return "precision";
  if (binStart < RATE_ZONE_BOUNDS[1]) return "normal";
  if (binStart < RATE_ZONE_BOUNDS[2]) return "deadspace";
  return "trick";
}

function binFor(degS: number): number {
  return Math.min(RATES_BIN_COUNT - 1, Math.floor(degS / RATES_BIN_WIDTH));
}

/** Percentile estimate from a histogram CDF; returns the bin midpoint. */
export function percentileFromHist(hist: number[], total: number, p: number, binWidth = RATES_BIN_WIDTH): number {
  if (total <= 0) return 0;
  const target = total * p;
  let cum = 0;
  for (let b = 0; b < hist.length; b++) {
    cum += hist[b]!;
    if (cum >= target) return b * binWidth + binWidth / 2;
  }
  return (hist.length - 1) * binWidth + binWidth / 2;
}

export function zoneShares(hist: number[], binWidth = RATES_BIN_WIDTH): Record<RateZone, number> {
  const zones: Record<RateZone, number> = { precision: 0, normal: 0, deadspace: 0, trick: 0 };
  let total = 0;
  for (let b = 0; b < hist.length; b++) {
    const c = hist[b]!;
    zones[zoneFor(b * binWidth)] += c;
    total += c;
  }
  if (total > 0) {
    for (const z of Object.keys(zones) as RateZone[]) zones[z] /= total;
  }
  return zones;
}

/** Share of histogram counts whose bin midpoint falls in [lo, hi] deg/s. */
export function shareInRange(hist: number[], lo: number, hi: number, binWidth = RATES_BIN_WIDTH): number {
  let total = 0;
  let inRange = 0;
  for (let b = 0; b < hist.length; b++) {
    const c = hist[b]!;
    total += c;
    const mid = b * binWidth + binWidth / 2;
    if (mid >= lo && mid <= hi) inRange += c;
  }
  return total > 0 ? inRange / total : 0;
}

function parseTriple(headers: Record<string, string>, name: string): [number, number, number] | null {
  const raw = headers[name];
  if (!raw) return null;
  const parts = raw.split(",").map((s) => Number.parseFloat(s.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((v) => Number.isNaN(v))) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}

/**
 * Rates in effect at log time, from the blackbox headers. BF 4.3+ logs carry
 * per-axis triples (`rc_rates`, `rc_expo`, `rates`, `rate_limits`) stored as
 * the raw config ints: center deg/s = rc_rates x10, max deg/s = rates x10,
 * expo = rc_expo / 100. Older logs may only have single-value `rcRate` /
 * `rcExpo` / `rcYawExpo` headers (roll value applied to roll/pitch).
 * Interpreted as Actual rates (the BF 4.3+ default); a non-ACTUAL rates_type
 * header sets `legacyType` so the UI can warn.
 */
export function parseLoggedRates(headers: Record<string, string>): LoggedRates | null {
  const rcRates = parseTriple(headers, "rc_rates");
  const rcExpos = parseTriple(headers, "rc_expo");
  const srates = parseTriple(headers, "rates");
  const limits = parseTriple(headers, "rate_limits");

  const legacyRcRate = Number.parseFloat(headers["rcRate"] ?? "");
  const legacyRcExpo = Number.parseFloat(headers["rcExpo"] ?? "");
  const legacyRcYawExpo = Number.parseFloat(headers["rcYawExpo"] ?? "");

  if (!rcRates && !rcExpos && !srates && Number.isNaN(legacyRcRate)) return null;

  const centerFor = (i: number): number =>
    rcRates ? rcRates[i]! * 10 : !Number.isNaN(legacyRcRate) ? legacyRcRate * 10 : BF_DEFAULT_RATES.center;
  const expoFor = (i: number): number => {
    if (rcExpos) return rcExpos[i]! / 100;
    if (i === 2 && !Number.isNaN(legacyRcYawExpo)) return legacyRcYawExpo / 100;
    if (!Number.isNaN(legacyRcExpo)) return legacyRcExpo / 100;
    return BF_DEFAULT_RATES.expo;
  };
  const maxFor = (i: number): number => (srates ? srates[i]! * 10 : BF_DEFAULT_RATES.max);

  // rates_type enum: 0 BETAFLIGHT, 1 RACEFLIGHT, 2 KISS, 3 ACTUAL, 4 QUICK.
  let legacyType = false;
  const rtRaw = headers["rates_type"];
  if (rtRaw !== undefined) {
    const v = Number.parseInt(rtRaw, 10);
    if (!Number.isNaN(v) && v !== 3) legacyType = true;
  }

  return {
    roll: { center: centerFor(0), max: maxFor(0), expo: expoFor(0) },
    pitch: { center: centerFor(1), max: maxFor(1), expo: expoFor(1) },
    yaw: { center: centerFor(2), max: maxFor(2), expo: expoFor(2) },
    rateLimits: limits,
    legacyType,
  };
}

/**
 * Build the per-axis rate-usage stats from a parsed log. Returns null when
 * the setpoint channels are missing (very old firmware) — the caller surfaces
 * that as a warning.
 */
export function computeRatesUsage(log: ParsedLog): RatesUsage | null {
  const setpoints = AXES.map((axis) => log.channels[`setpoint[${AXIS_INDEX[axis]}]`]);
  if (setpoints.some((c) => !c || c.length === 0)) return null;
  const sp = setpoints as Float32Array[];

  const gyroScale = log.gyroScale ?? null;
  const gyros = AXES.map((axis) => log.channels[`gyroADC[${AXIS_INDEX[axis]}]`]);
  const hasGyro = gyros.every((c) => c && c.length > 0) && gyroScale !== null;

  const rcThrottle = log.channels["rcCommand[3]"];
  const spThrottle = log.channels["setpoint[3]"];

  const loggedRates = parseLoggedRates(log.headers);

  const n = Math.min(sp[0]!.length, sp[1]!.length, sp[2]!.length);
  if (n < 64) return null;

  const histograms: number[][] = AXES.map(() => new Array<number>(RATES_BIN_COUNT).fill(0));
  const gyroHistograms: number[][] = AXES.map(() => new Array<number>(RATES_BIN_COUNT).fill(0));
  const satCounts = [0, 0, 0];
  const maxSeen = [0, 0, 0];
  const trackingRatios: number[][] = [[], [], []];
  const loggedMax = AXES.map((axis) => loggedRates?.[axis].max ?? BF_DEFAULT_RATES.max);

  let airborne = 0;
  for (let i = 0; i < n; i++) {
    // Airborne filter: throttle above idle, or any axis actively commanded.
    // Drops disarmed/idle time which would otherwise swamp the precision bin.
    const thrHigh =
      (rcThrottle && i < rcThrottle.length && rcThrottle[i]! > 1050) ||
      (spThrottle && i < spThrottle.length && spThrottle[i]! > 50);
    const moving = Math.abs(sp[0]![i]!) > 20 || Math.abs(sp[1]![i]!) > 20 || Math.abs(sp[2]![i]!) > 20;
    if (!thrHigh && !moving) continue;
    airborne++;

    for (let a = 0; a < 3; a++) {
      const v = Math.abs(sp[a]![i]!);
      histograms[a]![binFor(v)]!++;
      if (v > maxSeen[a]!) maxSeen[a] = v;
      if (v >= 0.9 * loggedMax[a]!) satCounts[a]!++;

      if (hasGyro) {
        const g = Math.abs(gyros[a]![i]!) * gyroScale!;
        gyroHistograms[a]![binFor(g)]!++;
        if (v >= 0.5 * loggedMax[a]!) trackingRatios[a]!.push(g / v);
      }
    }
  }

  const axes: AxisRateUsage[] = AXES.map((axis, a) => {
    const hist = histograms[a]!;
    const gyroHist = gyroHistograms[a]!;
    const ratios = trackingRatios[a]!;
    return {
      axis,
      histogram: hist,
      zones: zoneShares(hist),
      p50: percentileFromHist(hist, airborne, 0.5),
      p90: percentileFromHist(hist, airborne, 0.9),
      p99: percentileFromHist(hist, airborne, 0.99),
      maxDegS: maxSeen[a]!,
      saturationPercent: airborne > 0 ? (satCounts[a]! / airborne) * 100 : 0,
      achievedP99DegS: hasGyro && airborne > 0 ? percentileFromHist(gyroHist, airborne, 0.99) : null,
      highDeflectionTracking: hasGyro && ratios.length >= 50 ? median(ratios) : null,
    };
  });

  return {
    binWidthDegS: RATES_BIN_WIDTH,
    binCount: RATES_BIN_COUNT,
    airborneShare: airborne / n,
    axes,
    loggedRates,
  };
}

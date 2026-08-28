import {
  BF_DEFAULT_RATES,
  RATE_ZONE_BOUNDS,
  shareInRange,
  type AxisRateUsage,
  type AxisRates,
  type RatesUsage,
} from "../analysis/rates";
import { AXES, type Axis, type ProfileSettings } from "../types/fc";
import { settingsToCli } from "./cli";

/**
 * Rates recommendation engine: given the measured stick usage from a blackbox
 * log, a user-selected target style and the drone's size class, recommend
 * Betaflight Actual rates (center sensitivity / max rate / expo per axis).
 *
 * Methodology:
 * - nils vo, "Perfect FPV Rates with Science?": four rotation zones
 *   (precision 0-50 / normal 50-300 / dead space 300-600 / trick 600+ deg/s),
 *   keep max rate as low as comfortably possible, avoid sharp "bendy"
 *   transitions, histogram should spread evenly with a dip in the dead zone.
 * - Joshua Bardwell, "Find YOUR perfect rates!": center from normal flying,
 *   max from trick needs, yaw tuned separately, pitch/roll matched by
 *   *measured* rotation speed, adjust in small (±20-30 deg/s) steps.
 * - Baselines cross-checked against Oscar Liang's guide and the official
 *   Betaflight community rates presets (AOS, RubberQuads, QuadMcFly).
 */

export type RatesStyle = "racing" | "freestyle" | "cinematic" | "cruise";
export const RATES_STYLES: readonly RatesStyle[] = ["racing", "freestyle", "cinematic", "cruise"];
export const RATES_STYLE_LABELS: Record<RatesStyle, string> = {
  racing: "Racing",
  freestyle: "Freestyle",
  cinematic: "Cinematic",
  cruise: "Cruise",
};

export type RatesSizeGroup = "whoop" | "micro" | "full";

export function ratesSizeGroup(sizeClass: string): RatesSizeGroup {
  if (sizeClass === "65mm" || sizeClass === "75mm") return "whoop";
  if (sizeClass === "2.5in" || sizeClass === "3in" || sizeClass === "3.5in") return "micro";
  return "full";
}

/**
 * Style x size baselines (center/max deg/s, expo). Starting points synthesized
 * from the sources above — tunable; the log data nudges within bounds.
 */
export const RATES_BASELINES: Record<RatesStyle, Record<RatesSizeGroup, AxisRates>> = {
  freestyle: {
    whoop: { center: 220, max: 1000, expo: 0.55 },
    micro: { center: 190, max: 900, expo: 0.55 },
    full: { center: 170, max: 850, expo: 0.55 },
  },
  racing: {
    whoop: { center: 220, max: 700, expo: 0.45 },
    micro: { center: 200, max: 650, expo: 0.45 },
    full: { center: 200, max: 600, expo: 0.45 },
  },
  cinematic: {
    whoop: { center: 70, max: 450, expo: 0.7 },
    micro: { center: 80, max: 450, expo: 0.68 },
    full: { center: 90, max: 500, expo: 0.65 },
  },
  cruise: {
    whoop: { center: 120, max: 600, expo: 0.55 },
    micro: { center: 120, max: 600, expo: 0.55 },
    full: { center: 120, max: 600, expo: 0.55 },
  },
};

export interface AxisRatesRecommendation extends AxisRates {
  axis: Axis;
  rationale: string[];
}

export interface RatesRecommendation {
  style: RatesStyle;
  sizeClass: string;
  axes: AxisRatesRecommendation[];
  /** rates section in MSP ints, ready for display/diff reuse */
  settings: ProfileSettings;
  /** Betaflight CLI block (4.3+ int format, same as official presets) */
  cliBlock: string;
  warnings: string[];
}

/**
 * Betaflight "Actual" rates curve — exact port of getActualRates() from
 * betaflight-configurator RateCurve.js. `stick` in -1..1, result in deg/s.
 * At full stick the result is exactly `max`; the slope at center is `center`.
 */
export function actualRateDegS(stick: number, center: number, max: number, expo: number): number {
  const abs = Math.abs(stick);
  const expof = abs * (Math.pow(stick, 5) * expo + stick * (1 - expo));
  return stick * center + Math.max(0, max - center) * expof;
}

/** Inverse of actualRateDegS for stick in 0..1 (bisection; curve is monotonic). */
export function stickForDegS(target: number, center: number, max: number, expo: number): number {
  if (target <= 0) return 0;
  if (target >= max) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (actualRateDegS(mid, center, max, expo) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Curve samples as [stickPercent 0..100, deg/s] pairs for charting. */
export function rateCurvePoints(center: number, max: number, expo: number, n = 50): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    pts.push([s * 100, Math.round(actualRateDegS(s, center, max, expo))]);
  }
  return pts;
}

/**
 * nils vo's "boxes": fraction (0..1) of stick travel allocated to each zone,
 * computed via the inverse curve at the zone bounds. Zone edges above `max`
 * clamp to full stick, so the four shares always sum to 1.
 */
export function zoneStickTravel(center: number, max: number, expo: number): Record<"precision" | "normal" | "deadspace" | "trick", number> {
  const s0 = stickForDegS(0, center, max, expo);
  const s1 = stickForDegS(RATE_ZONE_BOUNDS[0], center, max, expo);
  const s2 = stickForDegS(RATE_ZONE_BOUNDS[1], center, max, expo);
  const s3 = stickForDegS(RATE_ZONE_BOUNDS[2], center, max, expo);
  return {
    precision: s1 - s0,
    normal: s2 - s1,
    deadspace: s3 - s2,
    trick: 1 - s3,
  };
}

/**
 * The deg/s range where the curve is "bendy" (slope exceeds 2x the center
 * slope) — nils vo's inconsistent-feel region. Null when the curve has no
 * such region (e.g. max <= center, or very low expo).
 */
export function bendRegionDegS(center: number, max: number, expo: number): [number, number] | null {
  if (max <= center || center <= 0) return null;
  const N = 200;
  const threshold = 2 * center;
  let start: number | null = null;
  let end: number | null = null;
  for (let i = 0; i < N; i++) {
    const s0 = i / N;
    const s1 = (i + 1) / N;
    const slope = (actualRateDegS(s1, center, max, expo) - actualRateDegS(s0, center, max, expo)) / (s1 - s0);
    if (slope > threshold) {
      if (start === null) start = s0;
      end = s1;
    }
  }
  if (start === null || end === null) return null;
  return [actualRateDegS(start, center, max, expo), actualRateDegS(end, center, max, expo)];
}

function round10(v: number): number {
  return Math.round(v / 10) * 10;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Data-driven nudges for one axis, bounded around the baseline. */
function adjustAxis(
  axis: Axis,
  base: AxisRates,
  u: AxisRateUsage | null,
  usage: RatesUsage | null,
  warnings: string[],
): AxisRatesRecommendation {
  const rationale: string[] = [];
  let center = base.center;
  let max = base.max;
  let expo = base.expo;

  if (u) {
    // --- Max rate: cover actual usage with ~10% headroom, bounded to ±20% of baseline ---
    const dataMax = round10(u.p99 * 1.1);
    const loMax = round10(base.max * 0.8);
    const hiMax = round10(base.max * 1.2);
    if (u.saturationPercent > 5) {
      max = hiMax;
      rationale.push(
        `You hit the current rate cap ${u.saturationPercent.toFixed(0)}% of the time on ${axis} — raising max rate.`,
      );
    } else if (u.p99 < 0.6 * base.max) {
      max = clamp(dataMax, loMax, base.max);
      rationale.push(
        `You rarely exceed ${Math.round(u.p99)} deg/s on ${axis} — a lower max rate gives more stick resolution everywhere else.`,
      );
    } else {
      max = clamp(dataMax, loMax, hiMax);
    }
    max = round10(max);

    // --- Physical cap: commanded vs achieved (Bardwell's "asked vs actual") ---
    if (u.highDeflectionTracking !== null && u.highDeflectionTracking < 0.9 && u.achievedP99DegS !== null) {
      const physCap = round10(u.achievedP99DegS * 1.05);
      if (physCap < max) {
        max = physCap;
        warnings.push(
          `${cap(axis)} physically reaches only ~${Math.round(u.achievedP99DegS)} deg/s at full stick ` +
            `(tracking ${(u.highDeflectionTracking * 100).toFixed(0)}%). Max rate clamped to ${physCap} — ` +
            `higher values just waste stick resolution.`,
        );
      }
    }

    // --- Center sensitivity: nudge by measured usage (Bardwell's ±20-30 steps) ---
    if (u.zones.normal > 0.6 && u.p50 < 100) {
      center = base.center - 20;
      rationale.push(
        `Most of your ${axis} flying is slow and precise (median ${Math.round(u.p50)} deg/s) — lowering center sensitivity for finer control.`,
      );
    } else if (u.p50 > 200) {
      center = base.center + 20;
      rationale.push(
        `Your ${axis} flying is fast-paced (median ${Math.round(u.p50)} deg/s) — raising center sensitivity so you don't have to move the stick as far.`,
      );
    }
    center = clamp(center, base.center - 30, base.center + 30);

    // --- Expo: minimize dead space / soften the elbow ---
    if (u.zones.deadspace > 0.25) {
      expo += 0.05;
      rationale.push(
        `${(u.zones.deadspace * 100).toFixed(0)}% of your ${axis} airtime is in the 300-600 deg/s dead zone — ` +
          `adding expo to pull that resolution into your normal flying range.`,
      );
    }
    if (u.zones.trick > 0.1 && u.saturationPercent > 5) {
      expo -= 0.05;
      rationale.push(`You use the trick range a lot on ${axis} — slightly less expo keeps full-stick response more predictable.`);
    }
    expo = clamp(expo, 0.4, 0.8);

    // --- Histogram fit vs the current curve (nils vo's "bendy part") ---
    const current = usage?.loggedRates?.[axis];
    if (current) {
      const bend = bendRegionDegS(current.center, current.max, current.expo);
      if (bend && usage) {
        const share = shareInRange(u.histogram, bend[0], bend[1], usage.binWidthDegS);
        if (share > 0.3) {
          rationale.push(
            `About ${(share * 100).toFixed(0)}% of your ${axis} flying sits on the current curve's steep elbow ` +
              `(${Math.round(bend[0])}-${Math.round(bend[1])} deg/s) — corrections there feel inconsistent.`,
          );
        }
      }
    }
  }

  return { axis, center: round10(center), max, expo: Math.round(expo * 100) / 100, rationale };
}

export function recommendRates(usage: RatesUsage | null, style: RatesStyle, sizeClass: string): RatesRecommendation {
  const group = ratesSizeGroup(sizeClass);
  const base = RATES_BASELINES[style][group];
  const warnings: string[] = [];

  const dataUsable = usage !== null && usage.airborneShare >= 0.05;
  if (usage === null) {
    warnings.push("No log data — showing the style/size baseline only. Analyze a log to tailor these numbers to your flying.");
  } else if (!dataUsable) {
    warnings.push("Very little airborne time in this log — the recommendation is mostly baseline.");
  }

  const usageFor = (axis: Axis): AxisRateUsage | null =>
    dataUsable ? (usage.axes.find((a) => a.axis === axis) ?? null) : null;

  const roll = adjustAxis("roll", base, usageFor("roll"), usage, warnings);
  const pitch = adjustAxis("pitch", base, usageFor("pitch"), usage, warnings);

  // Yaw: derived from the adjusted roll (Oscar Liang's pattern: slightly higher
  // center, ~75% max, a bit less expo), then nudged by its own usage data.
  const yawBase: AxisRates = {
    center: roll.center + 20,
    max: round10(roll.max * 0.75),
    expo: clamp(roll.expo - 0.1, 0.4, 0.8),
  };
  const yaw = adjustAxis("yaw", yawBase, usageFor("yaw"), usage, warnings);

  // Pitch/roll physical mismatch note (Bardwell step 4, measured from gyro).
  const rollU = usageFor("roll");
  const pitchU = usageFor("pitch");
  if (rollU?.achievedP99DegS && pitchU?.achievedP99DegS) {
    const hi = Math.max(rollU.achievedP99DegS, pitchU.achievedP99DegS);
    const lo = Math.min(rollU.achievedP99DegS, pitchU.achievedP99DegS);
    if ((hi - lo) / hi > 0.1) {
      const slower = rollU.achievedP99DegS < pitchU.achievedP99DegS ? "roll" : "pitch";
      warnings.push(
        `${cap(slower)} physically rotates ~${(((hi - lo) / hi) * 100).toFixed(0)}% slower than the other axis ` +
          `(${Math.round(lo)} vs ${Math.round(hi)} deg/s achieved) — max rates are set independently per axis.`,
      );
    }
  }

  // Rate limits logged below a recommended max.
  const limits = usage?.loggedRates?.rateLimits;
  if (limits) {
    for (const axis of AXES) {
      const rec = axis === "roll" ? roll : axis === "pitch" ? pitch : yaw;
      const limit = limits[axis === "roll" ? 0 : axis === "pitch" ? 1 : 2]!;
      if (limit < rec.max) {
        warnings.push(
          `${cap(axis)} rate limit (${limit} deg/s) is below the recommended max (${rec.max}) — raise rate_limits in Configurator or the limit wins.`,
        );
      }
    }
  }

  const logged = usage?.loggedRates ?? null;
  if (usage !== null && !logged) {
    warnings.push("Log headers don't include rates — the 'current' column shows Betaflight 4.5 defaults.");
  }
  if (logged?.legacyType) {
    warnings.push("The log's rates_type isn't ACTUAL — values are interpreted as Actual rates.");
  }
  if (
    style === "freestyle" &&
    logged &&
    Math.abs(logged.roll.center - BF_DEFAULT_RATES.center) <= 15 &&
    Math.abs(logged.roll.max - BF_DEFAULT_RATES.max) <= 30 &&
    Math.abs(logged.roll.expo - BF_DEFAULT_RATES.expo) <= 0.08
  ) {
    warnings.push(
      "You're flying near-Betaflight-default rates: they leave little resolution in the 150-250 deg/s band where trippy spins and orbits live.",
    );
  }

  const axes = [roll, pitch, yaw];

  const settings: ProfileSettings = {
    rates: {
      rcRate: Math.round(roll.center / 10),
      rcExpo: Math.round(roll.expo * 100),
      rollRate: Math.round(roll.max / 10),
      rcRatePitch: Math.round(pitch.center / 10),
      rcExpoPitch: Math.round(pitch.expo * 100),
      pitchRate: Math.round(pitch.max / 10),
      rcRateYaw: Math.round(yaw.center / 10),
      rcExpoYaw: Math.round(yaw.expo * 100),
      yawRate: Math.round(yaw.max / 10),
    },
  };

  // CLI block in the BF 4.3+ int format used by the official presets —
  // generated from the same settings object so the two never drift.
  const cliBlock = ["set rates_type = ACTUAL", ...settingsToCli(settings)].join("\n");

  return { style, sizeClass, axes, settings, cliBlock, warnings };
}

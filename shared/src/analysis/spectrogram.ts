import type { ParsedLog } from "../blackbox/types";
import type { Axis } from "../types/fc";
import { amplitudeSpectrum, findPeaks, hannWindow, median } from "./fft";

/**
 * Time–frequency ("frequency vs throttle") analysis — the primary filter-
 * tuning view in Blackbox Explorer / Chris Rosser's filter methodology.
 *
 * A single whole-flight FFT smears throttle-dependent motor noise into broad
 * "peaks" that look like frame resonances; computing one spectrum per time
 * window lets us classify each peak:
 * - sits on k × motor frequency (eRPM) in most windows, directly or folded
 *   at the log's Nyquist → motor harmonic (RPM filter job)
 * - fixed frequency across throttle → frame resonance (dynamic notch job)
 * - frequency scales with throttle/eRPM → motor harmonic (fallback when no
 *   eRPM channels exist)
 */

export interface SpectrogramRow {
  /** mean throttle over the window (rcCommand scale 1000–2000, or null) */
  throttle: number | null;
  /** mean motor fundamental frequency over the window (Hz, from eRPM), or null */
  erpmHz: number | null;
  /** mean fundamental of each motor over the window (Hz, from eRPM), or null */
  motorsHz: number[] | null;
  freqs: Float64Array;
  mags: Float64Array;
}

export interface Spectrogram {
  rows: SpectrogramRow[];
  sampleRate: number;
  windowSize: number;
}

/**
 * - frameResonance: fixed frequency, throttle-independent → dynamic notch
 * - motorHarmonic: k × motor frequency (or its alias) / follows throttle → RPM filter
 * - motorIdle: fixed frequency that sits at the motors' lowest (idle) speed —
 *   dynamic idle holds the motors there, so it looks like a resonance but is
 *   motor noise below rpm_filter_min_hz. Never a dynamic-notch target.
 */
export type PeakKind = "frameResonance" | "motorHarmonic" | "motorIdle" | "unknown";

export interface ClassifiedPeak {
  kind: PeakKind;
  /** mean frequency across rows (Hz) */
  freqHz: number;
  /** magnitude in the averaged spectrum (linear FFT amplitude) */
  magnitude: number;
  /** magnitude / noise floor */
  ratioToFloor: number;
  /** stddev of the per-row peak frequency (Hz) — low for frame resonances */
  freqSpreadHz: number;
  /** Pearson correlation of per-row peak frequency vs throttle (-1..1) */
  throttleCorr: number | null;
  /** lowest cluster-member frequency exceeding 4× floor (motor ridges only) */
  onsetHz?: number;
  /** lowest cluster-member frequency exceeding 8× floor (motor ridges only) */
  strongHz?: number;
  /** which motor harmonic the peak sits on (1 = fundamental), when matched against eRPM */
  harmonic?: number;
  /**
   * The harmonic lies above the log's Nyquist and shows up folded
   * (|k·f_motor − n·f_log|). It is motor noise the log rate is too low to
   * display at its true frequency — not a resonance at the folded frequency.
   */
  aliased?: boolean;
}

/**
 * Sanity check of the header's motor_poles against the spectrum. The RPM
 * filter places its notches at eRPM × 100 / 60 / (motor_poles / 2); if the
 * pole count is wrong every notch sits off-frequency by the pole ratio and
 * the true motor lines leak through at (header / true) × the expected
 * frequency.
 */
export interface MotorPoleCheck {
  headerPoles: number;
  /**
   * consistent: a strong peak sits on an integer harmonic of the eRPM-derived
   * motor frequency; mismatch: no such peak, but a strong one sits exactly
   * where an alternative pole count predicts; unknown: no motor-like peaks.
   */
  status: "consistent" | "mismatch" | "unknown";
  /** harmonic number of the evidence peak */
  harmonic?: number;
  aliased?: boolean;
  /** evidence peak (Hz) and its strength */
  peakHz?: number;
  ratioToFloor?: number;
  /** measured peak frequency / (harmonic × eRPM-derived motor frequency) */
  ratio?: number;
  /** pole count that would put the evidence peak on an integer harmonic (mismatch only) */
  suggestedPoles?: number;
}

export interface AxisSpectral {
  axis: Axis;
  /** median magnitude of the averaged spectrum over the pass band */
  floor: number;
  peaks: ClassifiedPeak[];
  /** lowest frequency where a motor-noise ridge exceeds 4× the floor */
  motorNoiseOnsetHz: number | null;
  /** frequency where motor noise reaches full strength (≥8× floor) */
  motorNoiseStrongHz: number | null;
  /** motor_poles sanity check (absent when the log has no eRPM channels) */
  motorPoleCheck?: MotorPoleCheck | null;
}

/**
 * Per-sample airborne mask, same rule as the rates-usage analysis: throttle
 * above idle (rcCommand > 1050 or setpoint throttle > 50) or any axis
 * actively commanded (|setpoint| > 20 deg/s). Null when no throttle/setpoint
 * channels exist (caller then analyzes the whole log).
 */
export function airborneMask(log: ParsedLog): Uint8Array | null {
  const n = log.timeUs.length;
  if (n === 0) return null;
  const rcThrottle = log.channels["rcCommand[3]"];
  const spThrottle = log.channels["setpoint[3]"];
  const sp0 = log.channels["setpoint[0]"];
  const sp1 = log.channels["setpoint[1]"];
  const sp2 = log.channels["setpoint[2]"];
  if (!rcThrottle && !spThrottle && !sp0) return null;

  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const thrHigh =
      (rcThrottle && i < rcThrottle.length && rcThrottle[i]! > 1050) ||
      (spThrottle && i < spThrottle.length && spThrottle[i]! > 50);
    const moving =
      (sp0 && i < sp0.length && Math.abs(sp0[i]!) > 20) ||
      (sp1 && i < sp1.length && Math.abs(sp1[i]!) > 20) ||
      (sp2 && i < sp2.length && Math.abs(sp2[i]!) > 20);
    mask[i] = thrHigh || moving ? 1 : 0;
  }
  return mask;
}

export interface SpectrogramOptions {
  windowSize?: number;
  /** fraction of overlap between windows (default 0.5) */
  overlap?: number;
  /** cap on the number of rows (hop is widened to fit, default 96) */
  maxRows?: number;
  /** airborne mask per sample; windows not fully airborne are skipped */
  mask?: Uint8Array | null;
  throttle?: Float32Array;
  /** motor fundamental in Hz per sample (e.g. mean of eRPM channels / 60) */
  erpmHz?: Float32Array;
  /** per-motor fundamental in Hz per sample (see motorHzChannels) */
  motorsHz?: Float32Array[];
}

/** One spectrum per time window over the airborne portions of a channel. */
export function computeSpectrogram(
  samples: Float32Array,
  sampleRate: number,
  options: SpectrogramOptions = {},
): Spectrogram {
  const { overlap = 0.5, maxRows = 96, mask = null, throttle, erpmHz, motorsHz } = options;
  let windowSize = options.windowSize ?? 4096;
  windowSize = Math.min(windowSize, 1 << Math.floor(Math.log2(samples.length)));
  if (samples.length < 256 || sampleRate <= 0 || windowSize < 256) {
    return { rows: [], sampleRate, windowSize: 0 };
  }

  let hop = Math.max(1, Math.round(windowSize * (1 - overlap)));
  const maxPossible = Math.floor((samples.length - windowSize) / hop) + 1;
  if (maxPossible > maxRows) {
    hop = Math.ceil((samples.length - windowSize) / (maxRows - 1));
  }

  // The Hann window is identical for every row — derive it once instead of
  // per-FFT (4096 trig calls × ~96 rows × 3 axes otherwise).
  const win = hannWindow(windowSize);
  const precomputedWindow = { win, winGain: win.reduce((a, b) => a + b, 0) / windowSize };

  const rows: SpectrogramRow[] = [];
  for (let start = 0; start + windowSize <= samples.length; start += hop) {
    if (mask) {
      let airborne = true;
      for (let i = start; i < start + windowSize; i++) {
        if (!mask[i]) {
          airborne = false;
          break;
        }
      }
      if (!airborne) continue;
    }
    const spec = amplitudeSpectrum(samples, sampleRate, {
      offset: start,
      length: windowSize,
      maxSize: windowSize,
      precomputedWindow,
    });
    const rowMotors = motorsHz && motorsHz.length > 0 ? motorsHz.map((c) => meanRange(c, start, windowSize)) : null;
    rows.push({
      throttle: throttle ? meanRange(throttle, start, windowSize) : null,
      erpmHz: erpmHz
        ? meanRange(erpmHz, start, windowSize)
        : rowMotors
          ? rowMotors.reduce((a, b) => a + b, 0) / rowMotors.length
          : null,
      motorsHz: rowMotors,
      freqs: spec.freqs,
      mags: spec.magnitudes,
    });
  }
  return { rows, sampleRate, windowSize };
}

export interface ClassifyOptions {
  minFreqHz?: number;
  maxFreqHz?: number;
  prominenceRatio?: number;
  maxPeaks?: number;
  /**
   * Motor speed floor held by dynamic idle (dyn_idle_min_rpm × 100 / 60 Hz).
   * Falls back to the lowest airborne motor speed seen in the log.
   */
  idleFloorHz?: number | null;
  /** motor_poles from the log header; enables the pole-count sanity check */
  headerPoles?: number | null;
}

interface RowPeak {
  freqHz: number;
  magnitude: number;
  /** spectrogram row the peak came from (presence is counted in rows) */
  row: number;
  throttle: number | null;
  /** mean motor fundamental (Hz) over the row, from eRPM telemetry */
  erpmHz: number | null;
  motorsHz: number[] | null;
}

export interface MotorMatch {
  /** harmonic number (1 = fundamental) */
  harmonic: number;
  /** true when the harmonic lies above Nyquist and was matched folded */
  aliased: boolean;
  /** frequency the harmonic is expected at in this log (folded if aliased) */
  expectedHz: number;
  errorHz: number;
}

/**
 * Does `freqHz` sit on a harmonic k·f_motor (k = 1..maxHarmonic) of any of
 * the motors, either directly or folded at the log rate (|k·f − n·f_log|
 * for n = 1, 2)? Blackbox decimates the filtered gyro without an anti-alias
 * stage, so harmonics above f_log / 2 land in the spectrum mirrored. The
 * tolerance scales with the harmonic (the eRPM error does too).
 */
export function matchMotorHarmonic(
  freqHz: number,
  motorsHz: readonly number[],
  sampleRate: number,
  options: { tolerance?: number; maxHarmonic?: number } = {},
): MotorMatch | null {
  const { tolerance = 0.03, maxHarmonic = 4 } = options;
  const nyquist = sampleRate / 2;
  let best: MotorMatch | null = null;
  for (const fm of motorsHz) {
    if (!(fm > 0)) continue;
    for (let k = 1; k <= maxHarmonic; k++) {
      const h = k * fm;
      // eRPM is good to ~1 %, so the window is a few % of the harmonic but
      // never so wide that a high alias swallows unrelated lines.
      const tol = Math.min(25, Math.max(6, h * tolerance));
      for (let n = 0; n <= 2; n++) {
        const expected = Math.abs(h - n * sampleRate);
        if (expected > nyquist + 1) continue;
        const err = Math.abs(freqHz - expected);
        if (err <= tol && (best === null || err < best.errorHz)) {
          best = { harmonic: k, aliased: n > 0, expectedHz: expected, errorHz: err };
        }
      }
    }
  }
  return best;
}

/** Pole counts a small brushless motor can plausibly have (12 = 9N12P whoop motors, 14 = 12N14P). */
const CANDIDATE_POLES = [12, 14, 16] as const;

/**
 * Classify noise peaks by tracking each row's dominant spectral peaks across
 * time. Averaging the spectrogram would smear throttle-swept motor ridges
 * into a flat plateau (no detectable peak), so candidates come from per-row
 * peaks clustered by frequency instead. With eRPM channels every cluster is
 * first tested against the motors' harmonics (aliases included) — a motor
 * line is a motor line even when the pilot hovers at one throttle and the
 * ridge never sweeps; without eRPM the throttle correlation decides.
 */
export function classifyPeaks(axis: Axis, sg: Spectrogram, options: ClassifyOptions = {}): AxisSpectral {
  const {
    minFreqHz = 40,
    maxFreqHz = Math.min(800, sg.sampleRate / 2),
    prominenceRatio = 4,
    maxPeaks = 6,
    headerPoles = null,
  } = options;
  const empty: AxisSpectral = {
    axis,
    floor: 0,
    peaks: [],
    motorNoiseOnsetHz: null,
    motorNoiseStrongHz: null,
  };
  if (sg.rows.length < 4) return empty;

  // Idle speed: the header's dynamic-idle floor when known (exact: also
  // tested at 2×), else the lowest motor speed seen while airborne (2nd
  // percentile of the slowest motor — fuzzy, so only tested at 1×).
  const idleFromHeader = !!options.idleFloorHz && options.idleFloorHz > 0;
  const hasErpm = sg.rows.some((r) => (r.erpmHz !== null && r.erpmHz > 0) || (r.motorsHz !== null && r.motorsHz.length > 0));
  let idleHz: number | null = options.idleFloorHz && options.idleFloorHz > 0 ? options.idleFloorHz : null;
  if (idleHz === null) {
    const lows = sg.rows
      .map((r) => (r.motorsHz && r.motorsHz.length > 0 ? Math.min(...r.motorsHz) : r.erpmHz))
      .filter((v): v is number => v !== null && v > 0)
      .sort((a, b) => a - b);
    idleHz = lows.length >= 4 ? lows[Math.floor(lows.length * 0.02)]! : null;
  }

  // Per-row noise floor and prominent peaks.
  const rowFloors: number[] = [];
  const rowPeaks: RowPeak[] = [];
  for (let rowIdx = 0; rowIdx < sg.rows.length; rowIdx++) {
    const row = sg.rows[rowIdx]!;
    const band: number[] = [];
    for (let b = 1; b < row.mags.length; b++) {
      const f = row.freqs[b]!;
      if (f >= minFreqHz && f <= maxFreqHz) band.push(row.mags[b]!);
    }
    if (band.length < 16) continue;
    const rowFloor = median(band);
    rowFloors.push(rowFloor);
    const peaks = findPeaks(
      { freqs: row.freqs, magnitudes: row.mags, sampleRate: sg.sampleRate, binCount: row.mags.length },
      { minFreqHz, maxFreqHz, prominenceRatio, maxPeaks: 3, minSeparationHz: 15 },
    );
    for (const p of peaks) {
      if (rowFloor > 0 && p.magnitude >= prominenceRatio * rowFloor) {
        rowPeaks.push({
          freqHz: p.freqHz,
          magnitude: p.magnitude,
          row: rowIdx,
          throttle: row.throttle,
          erpmHz: row.erpmHz,
          motorsHz: row.motorsHz,
        });
      }
    }
  }
  if (rowFloors.length < 4) return empty;
  const floor = median(rowFloors);

  // Cluster row peaks by frequency proximity. Single-linkage (distance to the
  // cluster's latest member) so a throttle-swept motor ridge chains into one
  // cluster instead of fragmenting as the running mean lags behind.
  rowPeaks.sort((a, b) => a.freqHz - b.freqHz);
  const chained: RowPeak[][] = [];
  for (const p of rowPeaks) {
    const cluster = chained[chained.length - 1];
    if (cluster) {
      const last = cluster[cluster.length - 1]!.freqHz;
      if (Math.abs(p.freqHz - last) < Math.max(15, last * 0.08)) {
        cluster.push(p);
        continue;
      }
    }
    chained.push([p]);
  }

  // Single-linkage has a failure mode: a ridge sweeping across a fixed frame
  // resonance absorbs it, and the combined cluster gets classified as motor
  // noise — sending the user to the RPM filter for the dynamic notch's
  // problem. Split any tight fixed-frequency sub-cluster back out first.
  // …unless the whole chain AND its tight window are the same motor
  // harmonic: a hover parks a motor line in a narrow band, and cutting that
  // band out would leave two fragments that no longer track the motors.
  const clusters: RowPeak[][] = [];
  for (const cluster of chained) {
    const { fixed, rest } = splitFixedSubcluster(cluster, sg.rows.length);
    if (fixed && matchClusterToMotors(cluster, sg.sampleRate) && matchClusterToMotors(fixed, sg.sampleRate)) {
      clusters.push(cluster);
      continue;
    }
    if (fixed) clusters.push(fixed);
    if (rest.length > 0) clusters.push(rest);
  }

  const peaks: ClassifiedPeak[] = [];
  let poleConsistent: MotorPoleCheck | null = null;
  let poleMismatch: MotorPoleCheck | null = null;
  for (const cluster of clusters) {
    // Presence is counted in distinct rows — each row can contribute up to
    // maxPeaks peaks, so cluster.length / rows could exceed 1.
    const rowsPresent = new Set(cluster.map((r) => r.row)).size;
    const present = rowsPresent / sg.rows.length;
    if (present < 0.25 || rowsPresent < 2) continue;
    const n = cluster.length;
    const meanFreq = cluster.reduce((a, r) => a + r.freqHz, 0) / n;
    const meanMag = cluster.reduce((a, r) => a + r.magnitude, 0) / n;
    const spread = Math.sqrt(cluster.reduce((a, r) => a + (r.freqHz - meanFreq) ** 2, 0) / n);
    // Correlate the ridge against throttle, and against eRPM when available —
    // eRPM is the more direct motor-speed signal and still discriminates when
    // the throttle trace is flat but RPM varies (e.g. descents).
    const withThrottle = cluster.filter((r) => r.throttle !== null);
    const corrThrottle =
      withThrottle.length >= 3
        ? pearson(
            withThrottle.map((r) => r.freqHz),
            withThrottle.map((r) => r.throttle!),
          )
        : null;
    const withErpm = cluster.filter((r) => r.erpmHz !== null && r.erpmHz > 0);
    const corrErpm =
      withErpm.length >= 3
        ? pearson(
            withErpm.map((r) => r.freqHz),
            withErpm.map((r) => r.erpmHz!),
          )
        : null;
    const corr =
      corrErpm !== null && (corrThrottle === null || Math.abs(corrErpm) > Math.abs(corrThrottle))
        ? corrErpm
        : corrThrottle;

    // Harmonic test against the motors' own frequencies (aliases included).
    const harmonicMatch = matchClusterToMotors(cluster, sg.sampleRate);

    let kind: PeakKind = "unknown";
    const swept = corr !== null && corr > 0.7 && spread > Math.max(15, meanFreq * 0.1);
    const stable = spread < Math.max(10, meanFreq * 0.05) && (corr === null || Math.abs(corr) < 0.5);
    const idleTol = idleHz !== null ? Math.max(6, idleHz * (idleFromHeader ? 0.12 : 0.15)) : 0;
    const atIdle =
      idleHz !== null &&
      (Math.abs(meanFreq - idleHz) <= idleTol || (idleFromHeader && Math.abs(meanFreq - 2 * idleHz) <= idleTol));
    if (harmonicMatch) {
      kind = harmonicMatch.harmonic <= 2 && !harmonicMatch.aliased && atIdle ? "motorIdle" : "motorHarmonic";
    } else if (swept) kind = "motorHarmonic";
    else if (stable && atIdle) kind = "motorIdle";
    else if (stable) kind = "frameResonance";

    const peak: ClassifiedPeak = {
      kind,
      freqHz: meanFreq,
      magnitude: meanMag,
      ratioToFloor: floor > 0 ? meanMag / floor : 0,
      freqSpreadHz: spread,
      throttleCorr: corr,
    };
    if (harmonicMatch) {
      peak.harmonic = harmonicMatch.harmonic;
      peak.aliased = harmonicMatch.aliased;
    }
    // Onset/strength from the cluster's own members (the ridge sweeps, so the
    // cluster spans the full frequency range — not just around the mean).
    if (kind === "motorHarmonic") {
      for (const r of cluster) {
        if (r.magnitude >= 4 * floor && (peak.onsetHz === undefined || r.freqHz < peak.onsetHz)) {
          peak.onsetHz = r.freqHz;
        }
        if (r.magnitude >= 8 * floor && (peak.strongHz === undefined || r.freqHz < peak.strongHz)) {
          peak.strongHz = r.freqHz;
        }
      }
      if (peak.onsetHz === undefined) {
        peak.onsetHz = Math.min(...cluster.map((r) => r.freqHz));
      }
    }
    peaks.push(peak);

    // Pole-count evidence. A harmonic match confirms the header; an
    // unexplained strong stable peak is tested against the other pole counts.
    if (headerPoles && hasErpm && peak.ratioToFloor >= 5) {
      if (harmonicMatch) {
        if (!poleConsistent || peak.ratioToFloor > (poleConsistent.ratioToFloor ?? 0)) {
          poleConsistent = {
            headerPoles,
            status: "consistent",
            harmonic: harmonicMatch.harmonic,
            aliased: harmonicMatch.aliased,
            peakHz: meanFreq,
            ratioToFloor: peak.ratioToFloor,
            ratio: harmonicMatch.ratio,
          };
        }
      } else if (kind === "frameResonance" || kind === "unknown") {
        for (const alt of CANDIDATE_POLES) {
          if (alt === headerPoles) continue;
          const scaled = cluster.map((r) => ({
            ...r,
            motorsHz: r.motorsHz ? r.motorsHz.map((f) => (f * headerPoles) / alt) : null,
            erpmHz: r.erpmHz !== null ? (r.erpmHz * headerPoles) / alt : null,
          }));
          // A real harmonic sits within a few tenths of a percent of its
          // prediction (the confirmed lines above land at 0.999–1.001), so
          // the alternative-pole test may be strict: 1.5 % instead of 3 %.
          const m = matchClusterToMotors(scaled, sg.sampleRate, { tolerance: 0.015, floorHz: 4, capHz: 12, perMotor: false });
          // Only a direct fundamental/2nd harmonic is evidence: a leaked
          // fundamental is the physical signature of a wrong pole count,
          // while folded high harmonics coincide with fixed lines too easily.
          if (
            m &&
            !m.aliased &&
            m.harmonic <= 2 &&
            Math.abs(m.ratio - 1) <= 0.015 &&
            present >= 0.4 &&
            peak.ratioToFloor >= 6 &&
            (!poleMismatch || peak.ratioToFloor > (poleMismatch.ratioToFloor ?? 0))
          ) {
            poleMismatch = {
              headerPoles,
              status: "mismatch",
              harmonic: m.harmonic,
              aliased: m.aliased,
              peakHz: meanFreq,
              ratioToFloor: peak.ratioToFloor,
              ratio: (m.ratio * headerPoles) / alt,
              suggestedPoles: alt,
            };
          }
        }
      }
    }
  }
  peaks.sort((a, b) => b.magnitude - a.magnitude);
  const top = peaks.slice(0, maxPeaks);

  // Motor-noise onset/strength from the fundamental ridge only: a folded or
  // higher harmonic says nothing about where the fundamental starts.
  const motor = top.filter((p) => p.kind === "motorHarmonic" && !p.aliased && (p.harmonic === undefined || p.harmonic === 1));
  let onset: number | null = null;
  let strong: number | null = null;
  if (motor.length > 0) {
    const fundamental = motor.reduce((a, b) => (a.freqHz < b.freqHz ? a : b));
    onset = fundamental.onsetHz ?? null;
    strong = fundamental.strongHz ?? null;
  }

  const motorPoleCheck: MotorPoleCheck | null =
    !headerPoles || !hasErpm
      ? null
      : (poleConsistent ?? poleMismatch ?? { headerPoles, status: "unknown" });

  return { axis, floor, peaks: top, motorNoiseOnsetHz: onset, motorNoiseStrongHz: strong ?? onset, motorPoleCheck };
}

interface ClusterMotorMatch {
  harmonic: number;
  aliased: boolean;
  /** median of measured / expected (1.0 = exactly on the harmonic) */
  ratio: number;
  fraction: number;
}

/** Fold a frequency at the log rate n times (n = 0: direct). */
function folded(h: number, n: number, sampleRate: number): number {
  return Math.abs(h - n * sampleRate);
}

/**
 * A cluster is a motor line when ONE harmonic hypothesis (k, folded n times)
 * explains most of its members AND, where the predicted frequency moves
 * across the rows, the measured frequency moves with it. Both tests run over
 * every member of the cluster, never only over the members that happen to
 * match: a fixed frame resonance always "matches" in the rows where an
 * alias passes through it, and judging tracking on those rows alone would
 * let it through. Hypotheses are evaluated per row against each motor (a
 * harmonic of the slowest motor is as real as one of the mean), the tracking
 * correlation against the mean motor speed.
 */
function matchClusterToMotors(
  cluster: RowPeak[],
  sampleRate: number,
  options: { tolerance?: number; floorHz?: number; capHz?: number; perMotor?: boolean } = {},
): ClusterMotorMatch | null {
  const { tolerance = 0.03, floorHz = 6, capHz = 25, perMotor = true } = options;
  // Group members by row: one row can hold several lines of the same
  // harmonic (one per motor when the motors run at different speeds), and
  // that within-row scatter must not be mistaken for a failure to track.
  const byRow = new Map<number, RowPeak[]>();
  for (const r of cluster) {
    if (!r.motorsHz || r.motorsHz.length === 0) continue;
    (byRow.get(r.row) ?? byRow.set(r.row, []).get(r.row)!).push(r);
  }
  const rows = [...byRow.values()];
  if (rows.length < 3) return null;
  const nyquist = sampleRate / 2;
  let best: ClusterMotorMatch | null = null;
  for (let k = 1; k <= 3; k++) {
    for (let n = 0; n <= 2; n++) {
      const measured: number[] = [];
      const predicted: number[] = [];
      const ratios: number[] = [];
      let hits = 0;
      let inBand = 0;
      for (const members of rows) {
        const all = members[0]!.motorsHz!;
        const meanHz = all.reduce((a, b) => a + b, 0) / all.length;
        const motors = perMotor ? all : [meanHz];
        const p = folded(k * meanHz, n, sampleRate);
        if (p > nyquist + 1) continue;
        inBand++;
        // Row representative: the member closest to the row's prediction,
        // tracked against the prediction of the motor nearest to it (each
        // motor leaves its own line; the mean would add the motors' spread
        // as scatter — 3× so for a folded 3rd harmonic).
        const rep = members.reduce((a, b) => (Math.abs(b.freqHz - p) < Math.abs(a.freqHz - p) ? b : a));
        let nearest = p;
        for (const fm of motors) {
          const pm = folded(k * fm, n, sampleRate);
          if (Math.abs(rep.freqHz - pm) < Math.abs(rep.freqHz - nearest)) nearest = pm;
        }
        measured.push(rep.freqHz);
        predicted.push(nearest);
        // Per-motor tolerance window: eRPM is good to ~1 %, folded lines are
        // more sensitive, and a high alias must never get a huge window.
        let hit = false;
        let bestRatio = rep.freqHz / p;
        let bestErr = Infinity;
        for (const m of members) {
          for (const fm of motors) {
            const h = k * fm;
            const pm = folded(h, n, sampleRate);
            const tol =
              n === 0
                ? Math.min(capHz, Math.max(floorHz, h * tolerance))
                : Math.min(capHz * 0.8, Math.max(floorHz, h * tolerance * 0.85));
            const err = Math.abs(m.freqHz - pm);
            if (err <= tol && err < bestErr) {
              hit = true;
              bestErr = err;
              bestRatio = m.freqHz / pm;
            }
          }
        }
        if (hit) {
          hits++;
          ratios.push(bestRatio);
        }
      }
      if (inBand < 3) continue;
      const fraction = hits / rows.length;
      if (fraction < 0.6) continue;
      // Where the prediction moves across rows, the line must move with it —
      // a fixed frame resonance fails here as soon as the motors move. The
      // four motors each leave their own line, so the row representative
      // scatters around the mean prediction; that scatter lowers the
      // correlation but not the regression slope, which stays near 1 for a
      // real harmonic and near 0 for a fixed line.
      const span = Math.max(...predicted) - Math.min(...predicted);
      if (span > 10) {
        const fit = regress(predicted, measured);
        if (fit === null) continue;
        const tracks = fit.corr >= 0.5 || (fit.corr >= 0.3 && fit.slope >= 0.5 && fit.slope <= 2);
        if (!tracks) continue;
      }
      ratios.sort((a, b) => a - b);
      const candidate: ClusterMotorMatch = { harmonic: k, aliased: n > 0, ratio: ratios[Math.floor(ratios.length / 2)]!, fraction };
      // Prefer the hypothesis explaining more rows; direct over folded on a tie.
      if (!best || candidate.fraction > best.fraction + 1e-9 || (candidate.fraction === best.fraction && !candidate.aliased && best.aliased)) {
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * Split a tight fixed-frequency sub-cluster out of a loosely chained cluster.
 * A frame resonance contributes a peak at nearly the same frequency in a
 * large share of rows; a throttle-swept motor ridge visits each frequency
 * only briefly. Returns { fixed: null } when no such sub-structure exists.
 */
function splitFixedSubcluster(
  cluster: RowPeak[],
  totalRows: number,
): { fixed: RowPeak[] | null; rest: RowPeak[] } {
  if (cluster.length < 6) return { fixed: null, rest: cluster };
  const sorted = [...cluster].sort((a, b) => a.freqHz - b.freqHz);

  // Densest window whose span stays within the fixed-frequency tolerance.
  let bestStart = 0;
  let bestLen = 0;
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi]!.freqHz - sorted[lo]!.freqHz > Math.max(12, sorted[lo]!.freqHz * 0.06)) lo++;
    const len = hi - lo + 1;
    if (len > bestLen) {
      bestStart = lo;
      bestLen = len;
    }
  }
  const window = sorted.slice(bestStart, bestStart + bestLen);
  if (window.length === cluster.length) return { fixed: null, rest: cluster };

  // The tight window must cover a solid share of rows on its own…
  const windowRows = new Set(window.map((r) => r.row)).size;
  const clusterRows = new Set(cluster.map((r) => r.row)).size;
  if (windowRows < Math.max(3, 0.4 * totalRows) || windowRows < 0.5 * clusterRows) {
    return { fixed: null, rest: cluster };
  }
  // …and must not itself sweep with throttle (else it is just a slow segment
  // of the ridge, not an independent fixed resonance).
  const withT = window.filter((r) => r.throttle !== null);
  const corr =
    withT.length >= 3
      ? pearson(
          withT.map((r) => r.freqHz),
          withT.map((r) => r.throttle!),
        )
      : null;
  if (corr !== null && Math.abs(corr) >= 0.5) return { fixed: null, rest: cluster };

  const inWindow = new Set(window);
  return { fixed: window, rest: cluster.filter((r) => !inWindow.has(r)) };
}

function meanRange(arr: Float32Array, start: number, len: number): number {
  let s = 0;
  const end = Math.min(arr.length, start + len);
  for (let i = start; i < end; i++) s += arr[i]!;
  return end > start ? s / (end - start) : 0;
}

/** Least-squares fit y = a + slope·x with its Pearson correlation; null when either side is constant. */
function regress(xs: number[], ys: number[]): { slope: number; corr: number } | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return { slope: sxy / sxx, corr: sxy / Math.sqrt(sxx * syy) };
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** motor_poles from the log header (Betaflight default 14 when absent). */
export function motorPolesFromHeaders(headers: Record<string, string>): number {
  const raw = Number.parseInt(headers["motor_poles"] ?? "", 10);
  return Number.isFinite(raw) && raw >= 2 ? raw : 14;
}

/** Dynamic-idle floor in Hz (dyn_idle_min_rpm is in units of 100 rpm), or null when off/absent. */
export function idleFloorHzFromHeaders(headers: Record<string, string>): number | null {
  const raw = Number.parseInt(headers["dyn_idle_min_rpm"] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? (raw * 100) / 60 : null;
}

/**
 * The motors' idle speed in Hz: the dynamic-idle floor when the header has
 * one, else the 0.5th percentile of the slowest motor over the whole log
 * (static idle: the motors sit there on the ground after arming and drop
 * back to it in every throttle chop — moments the airborne mask excludes,
 * so the mask is deliberately not applied). Null without eRPM.
 */
export function estimateIdleFloorHz(headers: Record<string, string>, motorsHz: Float32Array[] | null): number | null {
  const fromHeader = idleFloorHzFromHeaders(headers);
  if (fromHeader !== null) return fromHeader;
  if (!motorsHz || motorsHz.length === 0) return null;
  const n = Math.min(...motorsHz.map((c) => c.length));
  const stride = Math.max(1, Math.floor(n / 20000));
  const lows: number[] = [];
  for (let i = 0; i < n; i += stride) {
    let lo = Infinity;
    for (const c of motorsHz) lo = Math.min(lo, c[i]!);
    if (lo > 0) lows.push(lo);
  }
  if (lows.length < 200) return null;
  lows.sort((a, b) => a - b);
  // 0.5th percentile: the idle floor itself (reached on the ground and in
  // chops) but not a single spin-down sample; the 1st percentile already
  // sits on the lowest flight speed in an active log.
  return lows[Math.floor(lows.length * 0.005)]!;
}

/**
 * Per-motor mechanical frequency (Hz) from the logged eRPM channels.
 * Blackbox logs eRPM in units of 100 electrical RPM (BF dshot.c: the
 * telemetry period is converted to "erpm * 100"), so the mechanical
 * fundamental is value × 100 / 60 / (motor_poles / 2) — the same erpmToHz
 * conversion the firmware's RPM filter uses. motor_poles comes from the log
 * header, defaulting to 14. Null when the log has no eRPM channels.
 */
export function motorHzChannels(log: ParsedLog): Float32Array[] | null {
  const channels = [0, 1, 2, 3]
    .map((i) => log.channels[`eRPM[${i}]`])
    .filter((c): c is Float32Array => !!c && c.length > 0);
  if (channels.length === 0) return null;
  const toHz = 100 / 60 / (motorPolesFromHeaders(log.headers) / 2);
  return channels.map((c) => {
    const out = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) out[i] = c[i]! * toHz;
    return out;
  });
}

/** Mean motor fundamental frequency (Hz) across the logged eRPM channels (see motorHzChannels). */
export function meanErpmHzChannel(log: ParsedLog): Float32Array | null {
  const motors = motorHzChannels(log);
  if (!motors) return null;
  const n = Math.min(...motors.map((c) => c.length));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const c of motors) s += c[i]!;
    out[i] = s / motors.length;
  }
  return out;
}

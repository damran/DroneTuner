# Rates Advisor — find the best rates for drone + flight style

## Goal

Add a **Rates Advisor** to the Log Lab: after analyzing a blackbox log, the app reviews how the
pilot actually uses the sticks (rate-usage histogram per axis), and recommends Betaflight
**Actual rates** (Center Sensitivity / Max Rate / Expo per axis) based on:

1. the **measured flight style** in the log (setpoint usage in deg/s),
2. the **user-selected target style** (racing / freestyle / cinematic / cruise),
3. the **drone's size class** (65mm whoop ≠ 5" freestyle).

Methodology follows nils vo ("Perfect FPV Rates with Science?") and Joshua Bardwell
("Find YOUR perfect rates! With science!") — full verbatim transcripts reviewed — with
baseline values cross-checked against Oscar Liang's published recommendations
(oscarliang.com/rates) and the official Betaflight community rates presets.

Two diagnostics taken directly from the full transcripts:

- **Achieved vs commanded rates (Bardwell step 4, data-driven):** "the rates are what the
  quadcopter is being *asked* to do… but the distribution of weight can mean the actual
  speed doesn't match." Logs carry both `setpoint` (commanded deg/s) and `gyroADC`
  (achieved deg/s), so the advisor measures the physical cap per axis and matches
  pitch/roll from *achieved* rates instead of frame-by-frame video review.
- **Histogram-fit score (nils vo's sim histogram):** correctly-matched rates show an even
  usage spread with a dip in the dead zone; a mismatched setup piles usage into the dead
  zone / the curve's steep "bendy" region. The advisor scores the *current* curve this way
  ("you spend X% of airtime in dead space — your rates don't match your flying style").

## Locked decisions (from user)

- **Placement:** new "Rates advisor" panel in the **Log Lab** page, below the existing
  analysis findings. No new page, no wizard step.
- **Style:** **manual selection** by the user (racing / freestyle / cinematic / cruise),
  modulated by the drone's `sizeClass`. Log data tailors the numbers within the style's ranges.
  No auto-classification.
- **Apply path:** **display only**. No MSP write, no apply-store integration, no "save as
  profile". The panel shows current vs recommended values, curve charts, rationale, and a
  copy-to-clipboard CLI `set` block for manual entry in Betaflight Configurator.

## Verified technical facts (do not re-derive)

- **BF 4.4/4.5 blackbox headers** carry per-axis rate triples (from `blackbox.c`):
  `H rc_rates:r,p,y`, `H rc_expo:r,p,y`, `H rates:r,p,y`, `H rate_limits:r,p,y`.
  Our parser already stores all headers raw in `ParsedLog.headers` and `FlightLog.headers`.
- **`setpoint[0..2]` channels are logged in deg/s** (the existing metrics/step-response code
  already relies on this). The usage histogram needs no rate-curve math.
- **Actual rates curve** (exact port of `getActualRates` from betaflight-configurator
  `RateCurve.js`):
  ```
  deg/s = stick*center + max(0, max-center) * |stick| * (stick^5 * expo + stick*(1-expo))
  ```
  with `stick` in −1..1. At full stick the result is exactly `max`; slope at center = `center`.
- **Unit scaling** (confirmed against `client/src/lib/msp/config.ts` RATE_FIELDS,
  `shared/src/vendor/cli-dump.ts` RATE_KEYS, and the official BF presets below):
  - center deg/s = int × 10 (MSP `rcRate`/`rcRatePitch`/`rcRateYaw`, CLI `roll_rc_rate` etc.)
  - max deg/s = int × 10 (MSP `rollRate`/`pitchRate`/`yawRate`, CLI `roll_srate` etc.)
  - expo 0..1 = int / 100 (MSP `rcExpo*`, CLI `roll_expo` etc.)
  - **BF 4.3+ CLI prints these as plain ints** (`set roll_srate = 67` ↔ 670 deg/s,
    `set roll_expo = 50` ↔ 0.50). Pre-4.3 legacy dumps may show 2-decimal floats
    (`0.67`); `parseScaled` in cli-dump.ts already handles both forms.
  - BF 4.5 defaults: center 70, max 670, expo 0.50.
- **Expert baselines** (Actual rates, deg/s, center/max/expo):
  - nils vo: freestyle 250/700/0.70; racing 400/600/0.70. Zones: precision 0–50, normal
    50–300, dead space 300–600, trick 600+. "Keep max rate as low as comfortably possible."
  - Bardwell: center cinewhoop/indoor 50–100, freestyle/racing 150–300; max freestyle
    700–1200, racing 600–700; tune yaw separately (slightly higher yaw center OK); match
    pitch/roll independently for combination tricks; adjust center in ±20–30 steps.
  - Oscar Liang: max — cinematic/racing 600–800, freestyle 800–1000; center — cinematic
    50–150, freestyle 100–200, racing 150–250; expo — cinematic 0.6–0.8, freestyle 0.5–0.7,
    racing 0.4–0.6. Personal: freestyle 180/950/0.70 (yaw 200/650/0.55); tiny whoop
    250/1100/0.55 (yaw 300/900/0.55). Whoops run *higher* max rates than full-size.
- **Official BF community rates presets** (github.com/betaflight/firmware-presets,
  `presets/4.5/rates/` + `presets/4.4/rates/`; R/P/Y):
  - AOS (Chris Rosser): Default Freestyle 70/700 (expo = BF default 0.50); HD Freestyle
    50/550; Cinematic 40/400. Ships yaw-matching variants scaled to camera uptilt.
  - RubberQuads Volker (thumber): freestyle 60/700,700,550/0.40; race 60/550,550,400/0.40.
  - RubberQuads Settek (hybrid grip): 110/700,700,650/0.50.
  - QuadMcFly (pincher, snappy freestyle): 200/1100,1100,930/0.35 (yaw expo 0.54).
  - Takeaways: preset expo is lower (0.35–0.55) than nils vo's 0.70; centers span 40–200;
    yaw max is consistently ~75–85% of roll/pitch max. All presets `set rates_type = ACTUAL`.

## Implementation

### 1. `shared/src/analysis/rates.ts` (new) — usage extraction

Types (exported via `shared/src/analysis/index.ts`):

```ts
export interface AxisRateUsage {
  axis: Axis;
  histogram: number[];          // counts per bin, airborne frames only
  zones: { precision: number; normal: number; deadspace: number; trick: number }; // shares 0..1
  p50: number; p90: number; p99: number; maxDegS: number;
  saturationPercent: number;    // % airborne frames with |setpoint| >= 90% of logged max rate
  /** p99 of |gyro| (deg/s, gyroScale applied) on airborne frames — what the quad physically achieves */
  achievedP99DegS: number | null;
  /**
   * median |gyro| / |setpoint| over airborne frames where |setpoint| >= 50% of the
   * logged max rate. < ~0.9 means the quad physically can't reach the commanded rate
   * (motor/inertia cap) — Bardwell's "asked vs actual" gap, measured instead of
   * frame-by-frame video review.
   */
  highDeflectionTracking: number | null;
}
export interface AxisRates { center: number; max: number; expo: number } // deg/s, deg/s, 0..1
export interface LoggedRates { roll: AxisRates; pitch: AxisRates; yaw: AxisRates; rateLimits: [number, number, number] | null }
export interface RatesUsage {
  binWidthDegS: number;         // 25
  binCount: number;             // 49 (48 × 0..1200 + overflow)
  airborneShare: number;        // fraction of frames counted
  axes: AxisRateUsage[];        // roll, pitch, yaw
  loggedRates: LoggedRates | null;
}
```

- `computeRatesUsage(log: ParsedLog): RatesUsage | null`
  - Returns null (with a pushed warning) if `setpoint[0..2]` channels are missing.
  - **Airborne filter:** count a frame only if `rcCommand[3] > 1050` OR any
    `|setpoint[0..2]| > 20` deg/s (drops disarmed/idle time which would swamp the precision bin).
  - Histogram of `|setpoint[axis]|`, 25 deg/s bins, ≥1200 into overflow bin.
  - Zone shares from histogram CDF using zone bounds `[50, 300, 600]` (named constant
    `RATE_ZONE_BOUNDS`). p50/p90/p99 from histogram CDF; `maxDegS` = observed max.
  - `saturationPercent` uses logged max rate when known, else 670 (BF default).
  - Achieved-rate metrics per axis from `gyroADC[n]` (× `gyroScale`, same airborne frames):
    `achievedP99DegS` and `highDeflectionTracking` (null when gyro or setpoint missing, or
    fewer than ~50 qualifying high-deflection frames).
- `parseLoggedRates(headers: Record<string,string>): LoggedRates | null`
  - Parse `rc_rates` / `rc_expo` / `rates` / `rate_limits` comma triples (center = v×10,
    max = v×10, expo = v/100). Fallback for older logs: single-value `rcRate`, `rcExpo`,
    `rcYawExpo` headers (roll value applied to roll/pitch). Null when nothing found.
  - Assume ACTUAL rates type (BF 4.3+ default; app targets 4.4/4.5). If a `rates_type`
    header exists and is not ACTUAL, still parse but set a flag the UI warns about.

### 2. Extend `LogMetrics` (`shared/src/analysis/types.ts` + `metrics.ts`)

- Add optional `ratesUsage?: RatesUsage` to `LogMetrics` (optional → old persisted analyses
  still deserialize; UI shows "Re-analyze to get rates usage" when absent).
- `computeMetrics` calls `computeRatesUsage(log)` and attaches it. No server route changes:
  `analyzeLog` persists it into `metrics_json` automatically.

### 3. `shared/src/tuning/rates.ts` (new) — recommendation engine

```ts
export type RatesStyle = "racing" | "freestyle" | "cinematic" | "cruise";
export const RATES_STYLES / RATES_STYLE_LABELS
export interface AxisRatesRecommendation { axis: Axis; center: number; max: number; expo: number; rationale: string[] }
export interface RatesRecommendation {
  style: RatesStyle; sizeClass: string;
  axes: AxisRatesRecommendation[];
  settings: ProfileSettings;    // { rates: {...} } in MSP ints — for display/diff reuse
  cliBlock: string;             // "set rates_type = ACTUAL\nset roll_rc_rate = 17\nset roll_srate = 85\n..."
  warnings: string[];
}
export function recommendRates(usage: RatesUsage | null, style: RatesStyle, sizeClass: string): RatesRecommendation
export function actualRateDegS(stick: number, center: number, max: number, expo: number): number
export function stickForDegS(target: number, center: number, max: number, expo: number): number  // bisection inverse
export function rateCurvePoints(center: number, max: number, expo: number, n?: number): [number, number][]
/**
 * nils vo's "boxes": fraction (0..1) of stick travel allocated to each zone, computed
 * via stickForDegS at the zone bounds. Zone edges beyond `max` clamp to full stick.
 * This is the core optimization metric: maximize precision+normal, minimize deadspace.
 */
export function zoneStickTravel(center: number, max: number, expo: number): Record<"precision" | "normal" | "deadspace" | "trick", number>
```

- **Curve math:** exact port of `getActualRates` above.
- **Baseline matrix** `RATES_BASELINES: Record<RatesStyle, Record<SizeGroup, AxisRates>>` with
  `SizeGroup = "whoop" (65mm/75mm) | "micro" (2.5in/3in/3.5in) | "full" (4in/5in)`, mapped from
  `SIZE_CLASSES`. Initial constants (center/max/expo, deg/s), synthesized from the expert
  sources + official presets above — mark as tunable:

  | style | whoop | micro | full |
  |---|---|---|---|
  | freestyle | 220/1000/0.55 | 190/900/0.55 | 170/850/0.55 |
  | racing | 220/700/0.45 | 200/650/0.45 | 200/600/0.45 |
  | cinematic | 70/450/0.70 | 80/450/0.68 | 90/500/0.65 |
  | cruise | 120/600/0.55 | 120/600/0.55 | 120/600/0.55 |

- **Data-driven adjustments** per axis (each bounded and appended to `rationale`):
  - Max: `dataMax = round10(p99 × 1.1)`; result = `clamp(dataMax, 0.8×base, 1.2×base)`.
    If `saturationPercent > 5` → bias to upper clamp ("you hit the current cap X% of the time").
    If `p99 < 0.6×base` → lower toward dataMax ("you rarely exceed Y deg/s — lower max = more
    stick resolution", nils vo's rule).
  - Center: nudge baseline by measured usage: normal-zone share > 60% and p50 < 100 → −20;
    p50 > 200 → +20. Clamp to ±30 of baseline (Bardwell's increment rule).
  - Expo: deadspace share > 25% → +0.05 ("pull resolution into your normal flying range");
    trick share > 10% and saturation high → −0.05. Clamp 0.40–0.80.
  - Yaw: start from `center = rollCenter + 20`, `max = 0.75 × rollMax`, `expo = rollExpo − 0.10`
    (Oscar Liang's pattern), then apply the same data nudges from yaw usage.
  - Pitch and roll computed **independently** from their own histograms (Bardwell step 4).
  - **Physical cap (achieved vs commanded):** if `highDeflectionTracking < 0.9` on an axis,
    clamp that axis' recommended max to `round10(achievedP99 × 1.05)` and add a warning:
    "the quad physically reaches only ~X deg/s on pitch — a higher max rate just wastes
    stick resolution" (nils vo's max-rate rule enforced by physics). If roll and pitch
    achieved rates differ by >10% at high deflection, note it and set each axis' max from
    its own achieved data (Bardwell's pitch/roll matching, measured from gyro).
  - **Histogram-fit score (nils vo):** compute dead-zone share and the share of usage that
    falls inside the *current* curve's steep region (stick range where the curve's slope
    exceeds 2× the center slope — the "bendy part"). Surface as rationale/finding text,
    e.g. "22% of your airtime is in the 300–600 deg/s dead zone" / "your normal flying
    sits right on the curve's elbow — expect inconsistent feel".
  - `usage === null` → pure baseline recommendation with a "no log data" note.
- **MSP/CLI mapping:** center→`rcRate` ints (÷10), max→`rollRate`/`pitchRate`/`yawRate` (÷10),
  expo→`rcExpo*` (×100). Round deg/s to nearest 10 first. `cliBlock` uses the exact CLI key
  names from `cli-dump.ts` RATE_KEYS reversed (`rc_rate`, `rc_expo`, `rc_rate_pitch`,
  `rc_expo_pitch`, `rc_rate_yaw`, `rc_expo_yaw`, `roll_srate`, `pitch_srate`, `yaw_srate`),
  **printed as plain ints** matching the official BF 4.3+ presets
  (`set roll_rc_rate = 17`, `set roll_srate = 85`, `set roll_expo = 55`), preceded by
  `set rates_type = ACTUAL` (same as every official preset; the UI warns when the log shows
  a legacy rates type).
- **Warnings:** missing logged rates (current column falls back to BF defaults 70/670/0.50);
  `rate_limits` below a recommended max; legacy `rates_type`; log without setpoint channels.

### 4. Client: `client/src/components/RatesAdvisor.tsx` (new), wired into `LogLabPage`

Rendered inside the existing Analysis card area when `analysis.metrics.ratesUsage` exists
(below `FindingsPanel`). All computation client-side from shared functions — style changes are
instant, no new API calls.

- **Controls:** style `Select` (Racing/Freestyle/Cinematic/Cruise, default "freestyle"; if the
  linked flight has a `styleTag` matching, use it as initial value) + size class badge from the
  selected drone.
- **"Your stick usage"**: per-axis ECharts bar histogram (deg/s on X, % of airtime on Y) with
  `markArea` bands for the 4 zones (0–50 / 50–300 / 300–600 / 600+) and `markLine`s for p50 /
  p90 / p99 and the logged max rate. Zone share % listed per axis, plus the histogram-fit
  callouts (dead-zone share, bend-region share) and the achieved-vs-commanded note per axis
  ("commanded 700, physically reaches ~610").
- **"Recommended rates"**: table per axis — current (from log headers, else BF defaults) vs
  recommended Center / Max / Expo, with delta highlighting; rationale bullets under the table;
  warnings (rate-limit conflict, physical cap, legacy rates type) as a warning list.
- **"Curves"**: ECharts line chart, stick deflection % → deg/s, current vs recommended per axis
  (axis selector tabs), zone bands on the Y axis, the current curve's "bendy" region shaded
  (where slope > 2× center slope), and markers showing where the pilot's p50/p90 usage sits on
  the recommended curve (via `stickForDegS`).
- **"Resolution per zone"** (nils vo's "boxes"): small table showing, for current vs
  recommended, the % of stick travel allocated to each zone (`zoneStickTravel`) — e.g.
  "precision: 7% → 18% of stick travel". Includes the freestyle-on-defaults callout when
  logged rates ≈ BF defaults and style is freestyle: "defaults leave little resolution in
  the 150–250 deg/s band where trippy spins and orbits live".
- **"Apply manually"**: read-only CLI block with a Copy button (`navigator.clipboard`).
  Caption makes clear the advisor is display-only; FC writes stay in the existing
  wizard/profile apply flow.

### 5. Tests — `shared/test/rates.test.ts` (new)

- Curve: `actualRateDegS(1, c, m, e) === m`; `actualRateDegS(0, …) === 0`; near-center slope ≈
  center; monotonic for c < m; matches the RateCurve.js formula on a few hand-computed points.
- Inverse: `stickForDegS` round-trips with `actualRateDegS` (±0.01).
- `zoneStickTravel`: four zones sum to 1.0; lowering center (max/expo fixed) grows the
  precision share; zones above `max` clamp correctly (e.g. max 500 → no trick zone).
- Usage: synthetic `ParsedLog` (setpoint + rcCommand + gyroADC channels) → histogram bins,
  zone shares, percentiles, airborne filter (idle frames excluded), saturation vs logged max,
  `achievedP99DegS` and `highDeflectionTracking` (including the <50-frames → null case).
- Physical cap: `recommendRates` clamps max and warns when tracking < 0.9; pitch/roll mismatch
  >10% produces per-axis max from achieved data.
- Header parsing: `rc_rates:7,7,7` + `rc_expo:50,50,50` + `rates:67,67,67` → 70/670/0.50 per
  axis; legacy single-value headers; missing → null.
- `recommendRates`: deterministic per style×size; data adjustments respect clamps (extreme
  p99 cannot exceed 1.2× baseline); yaw derived from roll; MSP ints correct (250 deg/s →
  `rcRate: 25`); `usage: null` → pure baseline.
- CLI round-trip: `parseCliDump(cliBlock)` yields the same `ProfileSettings.rates` ints.

## Edge cases

- Analysis predates this feature (no `ratesUsage`) → panel shows "Re-analyze this log to get
  rates usage" hint; nothing breaks (field is optional).
- Log without setpoint channels → advisor hidden with explanation.
- Very short logs / almost no airborne frames (`airborneShare` < 5%) → warning, baseline-only
  recommendation.
- User never exceeds ~300 deg/s but selects "freestyle" → recommendation still clamps to style
  floor; rationale explains the tension.
- `rate_limits` header lower than recommended max → warning to raise limits in Configurator.

## Out of scope (explicit)

- Writing rates to the FC from the advisor (user chose display-only; the existing
  snapshot→diff→confirm apply flow remains the only write path).
- Flight-style auto-classification.
- Aggregating usage across multiple logs (v1 analyzes the selected log).
- Chatbot tool for rates proposals.
- Throttle mid/expo advice (Oscar Liang covers it, but keep v1 to R/P/Y rates).
- Yaw-rate matching to camera uptilt (AOS preset idea) — possible future enhancement.
- Legacy (non-ACTUAL) rate systems — assumed ACTUAL, warned otherwise.
- No `AGENTS.md` change needed (follows existing shared/analysis + tuning conventions).

## Validation

1. `pnpm test` (new shared tests + existing suite green), `pnpm typecheck`, `pnpm build`.
2. Manual: `pnpm dev`, re-analyze a real 65mm and a 2.5" log → histogram shape and peaks match
   the setpoint view on blackbox.betaflight.com; recommended values sane per style; CLI block
   pastes cleanly into Configurator (`diff all` shows the same values).

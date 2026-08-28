# Filter/PID Tuning Overhaul — Rosser Methodology, Delay Readout, Log Comparison, Opt-in Apply

## Goal

Fix correctness mistakes in the blackbox-driven filter/PID tuning logic (aligned to the Chris
Rosser Betaflight 4.5 masterclass transcripts + official BF 4.5 docs), add a real filter-delay
readout (per-stage + total, à la PIDToolbox), add "current vs previous blackbox" comparison, and
make every recommendation opt-in: the user picks each suggestion, then chooses **Apply** (existing
snapshot → diff → confirm flow) or **Copy CLI config**. Nothing is folded into a draft by default.

Out of scope: rates advisor (`shared/src/tuning/rates.ts`) — user scope is filters + PID tuning.
BLE, auto-tune loop, prop-wash detection: unchanged/out.

## Research findings that drive the fixes (verified)

**BF 4.5 CLI defaults/ranges** (betaflight.com CLI docs + 4.5 CLI reference):
- `dyn_notch_count` 3 (0–5), `dyn_notch_q` 300 (1–1000), `dyn_notch_min_hz` 100 (20–250),
  `dyn_notch_max_hz` 600 (200–1000). Guidance: never let the notch hunt below ~100 Hz
  (ideally ≥150–200 with RPM filter on); set min ~25 Hz below the target resonance; disable
  (count=0) when no frame resonance; with RPM filter 1–2 notches suffice.
- `rpm_filter_q` 500 (250–3000, target ~1000 clean builds), `rpm_filter_min_hz` 100 (30–200),
  `rpm_filter_fade_range_hz` 50 (0–1000), `rpm_filter_harmonics` 3 (0–3),
  `rpm_filter_weights` 100,100,100 (tri-blade props → e.g. 100,0,80; bi-blade → 100,80+,x).
- `gyro_lpf2_static_hz` 500 (0–1000): anti-aliasing filter — raise to 1000 when gyro rate > PID
  rate; set 0 when gyro rate == PID rate.
- `tpa_breakpoint` valid 1000–2000 (current code allows 900–2200 — wrong).
- Rosser AOS D-term tune: dynamic biquad, tune dyn min at zero throttle, dyn max at full throttle,
  `dyn_lpf_curve_expo` (default 5) raises cutoff faster at low throttle.

**MSP layouts (verified against betaflight-configurator MSPHelper.js, API 1.45/1.46):**
- All existing `FILTER_FIELDS`/`ADVANCED_FIELDS` offsets in `client/src/lib/msp/config.ts` are correct.
- Missing but MSP-writable on 1.45/1.46: `yawLowpassHz` (FILTER_CONFIG off 3, u16),
  `gyroLowpass2Hz` (22, u16), `gyroLowpass2Type` (25, u8), `dtermLowpass2Hz` (26, u16),
  `dtermLowpass2Type` (28, u8), `rpmFilterHarmonics` (43, u8), `rpmFilterMinHz` (44, u8),
  `dynLpfCurveExpo` (47, u8); PID_ADVANCED: `dMaxYaw` (41), `dMaxGain` (42), `dMaxAdvance` (43),
  `idleMinRpm` (49), `feedforwardMaxRateLimit` (53), `feedforwardJitterFactor` (54),
  `vbatSagCompensation` (55), `tpaMode` (57).
- `rpm_filter_fade_range_hz`/`rpm_filter_q`/`rpm_filter_weights` are **API 1.48-only** in MSP → on
  BF 4.4/4.5 they must be delivered as CLI snippets, never MSP writes.

**Filter delay anchors (BF wiki, ctzsnooze/r.a.v.):** PT1 phase delay at cutoff = 1/(8·fc)
(45° = ⅛ wavelength; fc=125 Hz → 1 ms); biquad ≈ 2× PT1; each RPM notch ≈ 0.2–0.3 ms; dyn notch
≈ 1 ms; total stack ~4 ms crisp / ~11 ms mushy. Compute exact group delay numerically from digital
filter models; unit-test against these anchors.

**Step detection (PTB/fpvpidlab method):** detect edges on the setpoint *derivative*, group
consecutive edge samples into one step, require magnitude ≥150 deg/s and post-step hold ≥50 ms
(not 400 ms), cooldown ≥100 ms, response window ~300 ms, normalize by the held plateau.

## Mistakes found in current code (to fix)

1. `rules.ts` assumes dyn-notch defaults 150–600 Hz — actual default min is **100 Hz**.
2. Rule 1 floors notch min at 60 Hz (`Math.max(60, peak*0.7)`) — lets the dyn notch hunt into the
   PID-relevant band; floor must be 100 Hz. It also recommends widening for *any* peak ≥40 Hz,
   even sub-4× "info" peaks.
3. Rule 1 cannot distinguish motor noise from frame resonance: one mid-flight FFT smears the
   throttle-swept motor ridge into "peaks" and then widens the dyn notch onto motor frequencies
   (adds delay, fights the RPM filter). Needs time-frequency classification.
4. No "quiet frame → disable dyn notch" rule (Rosser + BF docs both recommend count=0 then).
5. No RPM filter rules at all (min/fade/Q/weights/harmonics); no gyro LPF2 anti-alias rule; no yaw
   LPF field; no dyn-notch Q/count tuning; no `dyn_lpf_curve_expo`.
6. D-term noise rule applies a flat −30 to dyn max only; should target dyn min (low-throttle noise)
   vs dyn max (high-throttle noise) using per-throttle-band D-term RMS, proportionally.
7. `detectSteps` requires a single-sample jump ≥150 deg/s (misses RC-smoothed steps) and a 400 ms
   hold (discards exactly the out-and-back wiggle moves Rosser prescribes); normalization by the
   last-20% mean breaks on those same moves.
8. `filterLatencyMs = riseTime/2` is pseudo-science (rise time is dominated by P/rates) — replace
   with a true group-delay computation of the configured filter chain.
9. `FILTER_BOUNDS`: dterm cutoffs capped at 500 (too low; allow 1000), `dynNotchQ` min 20 (CLI min
   1); `ADVANCED_BOUNDS.tpaBreakpoint` 900–2200 (should be 1000–2000).
10. `dtermRms` is computed over the whole log including idle/arm time — restrict to airborne frames
    (same airborne test as `computeRatesUsage`).
11. `WizardPage` folds **all** recommendations into the draft automatically — violates the user's
    "never apply by default" requirement.
12. Server `analyzeLog` runs rules with hardcoded goal "freestyle" and no base — fine for findings
    (base-independent), but keep in mind findings improve automatically once metrics/rules improve.

## Work items (ordered)

### 1. Shared model + MSP fields (`shared/src/types/fc.ts`, `client/src/lib/msp/config.ts`, `shared/src/vendor/cli-dump.ts`, `shared/src/tuning/diff.ts`)

- Add to `FilterSettings`: `yawLowpassHz`, `gyroLowpass2Hz`, `gyroLowpass2Type`,
  `dtermLowpass2Hz`, `dtermLowpass2Type`, `rpmFilterHarmonics`, `rpmFilterMinHz`,
  `dynLpfCurveExpo`, plus CLI-only `rpmFilterFadeRangeHz`, `rpmFilterQ`, `rpmFilterWeights`
  (weights as a number triple — see note below).
- Add to `AdvancedSettings`: `dMaxGain`, `dMaxAdvance`, `idleMinRpm`, `feedforwardMaxRateLimit`,
  `feedforwardJitterFactor`, `vbatSagCompensation`, `tpaMode`.
- Add the MSP-writable offsets above to `FILTER_FIELDS`/`ADVANCED_FIELDS` (offsets verified in
  research; writes stay gated to API 1.45/1.46 by `isWritableApi`). Do NOT add the 1.48-only RPM
  fields to MSP — they are CLI-only on 4.4/4.5.
- `rpmFilterWeights` triple: MSP can't carry it on 4.5 and `ProfileSettings` leaves are numeric;
  store as three keys `rpmFilterWeight1/2/3` (CLI-only) to keep `applyChanges`/diff simple.
- Extend the CLI-dump parser mapping (`cli-dump.ts`) for all new keys (`yaw_lowpass_hz`,
  `gyro_lpf2_static_hz`, `gyro_lpf2_type`, `dterm_lpf2_static_hz`, `dterm_lpf2_type`,
  `rpm_filter_harmonics`, `rpm_filter_min_hz`, `dyn_lpf_curve_expo`, `rpm_filter_fade_range_hz`,
  `rpm_filter_q`, `rpm_filter_weights` → split into the 3 weight keys; advanced: `d_max_gain`,
  `d_max_advance`, `dyn_idle_min_rpm`→`idleMinRpm` (note units: MSP u8 vs CLI RPM — mark
  CLI-only/display-only, do not MSP-write from a CLI-derived profile), `feedforward_max_rate_limit`,
  `feedforward_jitter_factor`, `vbat_sag_compensation`, `tpa_mode`).
- Add labels for all new keys in `diff.ts` (`FILTER_LABELS`, `ADVANCED_LABELS`).
- Fix bounds in `rules.ts`: `FILTER_BOUNDS` — dterm/gyro cutoffs [0,1000], `dynNotchMinHz`
  [20,250], `dynNotchMaxHz` [200,1000], `dynNotchQ` [1,1000], `dynNotchCount` [0,5],
  `rpmFilterMinHz` [30,200], `rpmFilterHarmonics` [0,3], `dynLpfCurveExpo` [0,10],
  rpm weights [0,100]; `ADVANCED_BOUNDS.tpaBreakpoint` [1000,2000].

### 2. Spectrogram + noise classification (`shared/src/analysis/spectrogram.ts`, new)

- `computeSpectrogram(samples, sampleRate, throttle, {windowSize=4096, hop=windowSize/2})`:
  Hann-windowed amplitude spectra per hop (reuse `fft.ts`), restricted to airborne frames (same
  airborne rule as rates usage: throttle > idle or any axis moving), each row tagged with mean
  throttle (and mean eRPM if `eRPM[n]` channels exist).
- `classifyPeaks(spectrogram)`: averaged spectrum → candidate peaks (reuse `findPeaks`); per peak,
  measure per-row peak-frequency stability: low variance & no throttle correlation →
  `frameResonance`; frequency scales with throttle/eRPM → `motorHarmonic` (record onset frequency =
  lowest frequency where the ridge exceeds 4× floor, and strong frequency = where it exceeds 8×).
- Output per axis: `{ peaks: ClassifiedPeak[], floor, motorNoiseOnsetHz|null, motorNoiseStrongHz|null }`.
- `LogMetrics` gains `spectral: AxisSpectral[]` (keep existing `noisePeaks` populated from the
  frame-resonance subset for backward compat) and `gyroRateHz`/`pidLoopRateHz` (from
  `looptimeUs` + `headers["pid_process_denom"]`; gyro = denom × 1e6/looptime).

### 3. Step detection rewrite (`shared/src/analysis/steps.ts`)

- Replace edge rule: smooth setpoint lightly (3-sample moving average), compute per-sample
  derivative in deg/s², flag |d/dt| ≥ threshold (default ~15k deg/s², tune in tests), group
  consecutive flags into one edge; a step = edge with total setpoint change ≥150 deg/s, post-step
  plateau hold ≥50 ms (plateau = setpoint stays within 10% of step amplitude), cooldown 100 ms.
- Response window 300 ms; normalize gyro by the **setpoint plateau value** (mean setpoint over the
  hold region), not end-of-window gyro mean.
- Extend `AxisStepMetrics` with `latencyMs` (time to 5% of plateau) and `ringingCycles`
  (zero crossings around plateau after first crossing, <5% amplitude ignored). Keep existing fields
  and the `averageStepResponse` signature (used by LogLabPage).
- `stepResponseMetrics` must no longer hardcode `axis: "roll"` for the empty case (cosmetic bug).

### 4. New PID-quality metrics (`shared/src/analysis/metrics.ts`)

- Airborne-only `dtermRms`, plus `dtermRmsLowThrottle`/`dtermRmsHighThrottle` per axis (split at
  50% throttle) to drive dyn-min vs dyn-max D-term LPF rules.
- `feedforward`: per axis over detected steps — `startLagMs` (gyro 50% rise time minus setpoint 50%
  rise time) and `endOvershootPercent` (gyro excursion past setpoint in the 100 ms after the
  setpoint returns toward center). Lag > ~15 ms → FF/boost too low; end overshoot > ~15% → FF or
  FF boost too high.
- `iterm`: `steadyStateErrorPercent` (mean |gyro−setpoint|/|setpoint| over plateau) and
  `bounceBack` (slow <20 Hz reversal after step end) — drive I-gain findings.
- Keep `filterLatencyMs` field for DB compat but stop surfacing it in UI once item 5 lands.

### 5. Filter delay estimator (`shared/src/analysis/delay.ts`, new)

- Digital filter models matching BF `filter.c`: PT1 (`α=dt/(RC+dt)`), PT2/PT3 as cascaded PT1s at
  BF's corrected cutoffs (constants pt2 ≈1.5538, pt3 ≈1.9615 — verify against firmware source
  during implementation), biquad LPF (RBJ, Q=1/√2), biquad notch (f0, Q).
- `buildFilterChain(config, gyroRateHz, pidLoopRateHz)`: gyro chain = RPM notches (harmonics ×
  weight>0, at `rpmFilterMinHz` as conservative worst case) + dyn notches (count × at detected
  resonance or min_hz) + gyro LPF1 (dyn min..max → evaluate at min = worst case) + gyro LPF2;
  D chain = D LPF1 (dyn min) + D LPF2. Config sources: log headers (`filterConfigFromHeaders`) or
  `ProfileSettings` merged over BF 4.5 defaults (wizard preview).
- Group delay via finite-difference of ∠H(e^{jω}); report per-stage and total at 30/50/100 Hz;
  headline = total at 50 Hz. Validate: PT1 fc=125 Hz → ~1 ms at 125 Hz; biquad ≈ 2×; notch away
  from f0 ≈ 0.
- `LogMetrics.filterDelay` = `{ gyroMs, dtermMs, perStage: {name, ms}[] }` (at 50 Hz).

### 6. Rule engine rework (`shared/src/tuning/rules.ts`)

Keep the `runRules(metrics, goal, base)` signature and delta/`applyChanges` mechanism. Correct
assumed defaults to BF 4.5 (dyn notch 100/600/3/300, rpm 100/50/500/3, gyro LPF2 500 PT1, dterm
dyn 70/170 biquad, expo 5). Rules:

- **Frame resonance** (only `frameResonance`-classified peaks, ratio >4× floor): widen dyn-notch
  range to cover it — target min = max(100, peak−25), max = min(1000, peak×1.5); if notch disabled
  (count 0) recommend count = number of resonances (≤3, or ≤2 when RPM filter active).
- **Quiet frame**: no frame resonance AND base count >0 → recommend `dynNotchCount` → 0 (saves
  ~1 ms); note delay saving in rationale.
- **Notch Q**: resonance narrow (peak width measurable from spectrogram) and Q < 1000 → raise Q
  (+100 steps, cap 1000); if noise escapes around a high Q → lower.
- **RPM filter**: motor harmonics present → min = clamp(onset, 30, 200), fade so full strength at
  strong-frequency; Q → 1000 if no leakage past current Q (CLI-only); weights by blade count when
  known from the drone's prop component (tri-blade 100,0,80 / bi-blade 100,80,80 starting points,
  CLI-only); `rpmFilterActive === false` → info finding "enable bidirectional DShot + RPM filter".
- **Gyro LPF2**: gyroRate > pidLoop and LPF2 < 1000 → raise toward 1000; gyroRate == pidLoop →
  suggest 0 (disable). Never recommend disabling both gyro LPFs.
- **D-term LPF**: high-throttle-band D noise → lower dyn max ~10–15% of current; low-throttle-band
  → lower dyn min similarly; optionally suggest `dynLpfCurveExpo` increase when only mid-throttle
  is clean. Never below 70 Hz dyn min floor; warn D filtering is safety-critical.
- **PD balance**: overshoot >25% with ringing → raise D first (+3..+5) unless D already ≥60% of
  per-axis typical cap, else lower P; overshoot 10–25% → small D raise; rise time >50 ms and
  overshoot <10% → raise P. (Anchored to fpvpidlab decision table, simplified.)
- **Feedforward**: startLagMs high → raise FF (or `feedforwardBoost`); endOvershoot high → lower
  FF boost first, then FF.
- **I-term**: steady-state error >5% → raise I; bounce-back → lower I or tighten `itermRelaxCutoff`.
- **TPA**: oscillation/noise only in the high-throttle band → info finding suggesting TPA
  breakpoint just below onset throttle + rate increase.
- Keep battery-sag and motor-saturation findings; saturation recommendation becomes "reduce P and D
  slightly or reduce max rates" (not D-only).
- Every `Recommendation` gains `cliLines: string[]` (from the new mapper, item 7) and the UI — not
  the engine — decides apply vs copy.

### 7. CLI snippet mapper (`shared/src/tuning/cli.ts`, new)

- `settingsToCli(changes: ProfileSettings): string[]` — full key→CLI-name map for pids
  (`p_roll`…), filters, rates (reuse the format in `tuning/rates.ts`), advanced; deltas must be
  resolved against a base first (`applyChanges`) so snippets carry absolute values.
- `CLI_ONLY_KEYS` = { rpmFilterFadeRangeHz, rpmFilterQ, rpmFilterWeight1/2/3, idleMinRpm } — these
  never enter an MSP apply plan; wizard shows them snippet-only.

### 8. Log comparison (`shared/src/analysis/compare.ts`, new + Log Lab UI)

- `compareAnalyses(current, previous)` where each side = `{ metrics: LogMetrics, headers: Record<string,string> }`:
  - **Settings diff**: diff all headers; surface tuning-relevant ones (prefix list: `dyn_notch`,
    `rpm_filter`, `*lpf*`, `gyro_lpf`, `dterm`, `rc_rates`, `rates`, `rc_expo`, `tpa`,
    `feedforward`, `d_min`, `iterm`, `anti_gravity`, pids if present) as label/from/to rows;
    collapse the rest into "N other settings changed".
  - **Metric deltas**: noise floor/axis, classified peaks (new/gone/moved), dterm RMS/axis,
    step overshoot & rise time/axis, motor saturation, vbat sag, filter delay total — each with
    direction-aware verdict (better/worse/neutral).
- Client-side only: LogLabPage already has the drone's log list; fetch the previous log's analysis
  (`/api/logs/:id/analysis`) + both logs' headers and compute in the browser. No new endpoint.
- Render a "vs previous log" card under Analysis when a previous analyzed log exists; handle stale
  pre-overhaul analyses by comparing only shared keys with a note.

### 9. UI: delay readout + opt-in wizard

- **Log Lab**: new "Filter delay" card (per-stage table + gyro/D totals at 50 Hz, from
  `metrics.filterDelay`); remove/replace the old "Filter latency (est.)" card. Optional stretch:
  spectrogram heatmap (ECharts heatmap, frequency-vs-throttle) from `computeSpectrogram` — the
  primary Rosser workflow view.
- **Wizard** (`WizardPage.tsx`): recommendations render with unchecked checkboxes; draft =
  template + selected only. Per recommendation and on the draft: "Review & apply to FC" (existing
  apply-store flow — unchanged snapshot→diff→confirm→EEPROM) and "Copy CLI" (snippet from item 7;
  CLI-only keys are snippet-only with a note). Show predicted filter delay of the draft (item 5 via
  ProfileSettings) next to the draft table.
- **Chat**: already propose-only via action cards — no flow change; update `settingsSchema` in
  `server/src/routes/chat.ts` to accept the new filter/advanced keys so cards can carry them.

### 10. Server touch-up

- `server/src/services/analysis.ts`: no structural change (findings improve automatically); ensure
  re-analysis overwrites/versions cleanly as today. Persisted old analyses keep working (UI guards
  on missing `spectral`/`filterDelay`, same pattern as `ratesUsage`).

### 11. Tests (`shared/test/`)

- `steps.test.ts`: synthetic out-and-back wiggle moves are detected; smoothed ramps detected;
  normalization correct on 100 ms holds.
- `spectrogram.test.ts`: fixed-freq sine → frameResonance; throttle-swept sine → motorHarmonic with
  correct onset; quiet signal → no peaks.
- `delay.test.ts`: PT1/biquad/notch anchors from research; full BF 4.5 default chain lands in a
  sane ~2–5 ms band; disabling dyn notch reduces total.
- `rules.test.ts`: update existing (default min 100), add: quiet-frame disable, motor peaks never
  widen the dyn notch, RPM min/fade from onset, LPF2 anti-alias both directions, per-band D-term
  targeting, FF lag/overshoot, TPA info, CLI-only keys never in MSP-bound changes.
- `cli.test.ts`: settings→CLI mapping incl. weights split.
- `compare.test.ts`: settings diff + metric delta verdicts.
- Run `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm smoke` (server running).

### 12. Docs

- Update `AGENTS.md` (new shared modules: `analysis/spectrogram.ts`, `analysis/delay.ts`,
  `analysis/compare.ts`, `tuning/cli.ts`; opt-in wizard behavior; CLI-only key rule).

## Risks / edge cases

- PT2/PT3 cutoff-correction constants must be verified against BF `filter.c` before relying on
  delay numbers (unit-test anchors will catch gross errors).
- Logs without RPM headers or with gyro==PID rate: delay estimator + LPF2 rule must fall back
  gracefully with warnings, not crash.
- `idleMinRpm` unit mismatch (MSP u8 vs CLI RPM) — treat as display/CLI-only, never MSP-write a
  CLI-derived value.
- Old persisted analyses lack new metric fields — every new UI card must guard on presence.
- Comparison when the previous log's analysis predates the overhaul: compare shared keys only.

## Validation

- Unit tests above; then `pnpm test && pnpm typecheck && pnpm build`.
- `pnpm smoke` with server running.
- Manual: analyze a real 4.5 log → delay card matches PIDToolbox ballpark for the same config;
  upload two logs of the same drone with a known filter change between them → comparison shows the
  setting diff and the expected metric movement; wizard starts with nothing selected and both
  Apply and Copy-CLI paths work; apply path still snapshots/diffs/confirms.

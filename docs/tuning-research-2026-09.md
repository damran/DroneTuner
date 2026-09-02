# Whoop & micro tuning logic — research notes (2 September 2026)

Companion to the published report "Whoop & Micro Tuning Logic". Sources: Betaflight 4.5-maintenance and 2025.12-maintenance firmware (`filter.c`, `dyn_notch_filter.c`, `rpm_filter.c`, `gyro_filter_impl.c`, `pid.c`, `pid_init.c`, `simplified_tuning.c`, `msp.c`, `blackbox.c`), betaflight-configurator `MSPHelper.js`, the Betaflight wiki (4.3 Tuning Notes, DSHOT RPM Filtering, Freestyle Tuning Principles, Inflight Adjustments, Black Box logging, Profiles), Oscar Liang (rates, RPM filter, Air65, Meteor75 Pro, FlyLens 85), the vendor files seeded in `server/src/seed/vendor-presets/` (each with its URL), and 76 of the pilot's own flights.

## In short

- Whoops are filtered by the RPM filter plus one dynamic notch, never by a gyro low-pass: BetaFPV factory, AOS, Karate and UAV Tech set gyro LPF1 off and require bidirectional DShot. The dynamic-notch floor is 120–150 Hz in every whoop tune; Betaflight's noisiest generic preset stops at 80 Hz. A 60 Hz / Q 300 floor crashed the Air65 R; the current 80 Hz floor is below everything published.
- Feedforward is the one thing nobody agrees on for 65mm: Air65 R factory and AOS use 0, Air75 and Meteor75 Pro 42–82, the hot race tunes 160–250. FF 0 for indoor precision, moderate FF for outdoor freestyle, high FF only for racing.
- 65mm vs 75mm differ in pitch D and TPA, not P: P/I stay near 61–64 / 103–121, pitch D grows with the 40mm-prop airframe (51 → 67), TPA starts earlier on racers (1250) and later for indoor recoveries (1600). HD whoops add `thrust_linear 30` and `vbat_sag_compensation 100`.
- Delay lives in the D-term chain (PT1 ≈ 125 / f_cut ms; biquad ≈ 2×). The pilot's V3 D chain (dyn 50–150 + LPF2 100) costs ~3.8 ms at hover, the Betaflight default chain ~2.5 ms, the Fractal experiment with a 235 Hz D notch ~15 ms.
- Betaflight 4.5 cannot switch PID profiles from a switch in flight (only rate profiles). The A/B flow writes crisp/smooth variants into two profiles; the pilot flies A, lands, switches via stick command or OSD, flies B in the same pack; each arm is its own blackbox session.
- The Meteor75 Pro runs the exact factory 4.5.3 tune and is the quietest craft (noise floor 0.02). A fixed 303 Hz peak in its filtered gyro at hover is motor noise the RPM filter should remove — check `motor_poles`.

## Evidence from the logs

Air65 R (59 flights): replacing damaged props cut D noise from 158 to 18; the HQ 31mm profile with D LPF2 100 and D-min 24/30 + D-max gain 45 (V3) gives the lowest overshoot (3.3 % vs 7 % factory) and the lowest pitch noise floor. The 80 Hz notch floor is not what improved those sessions (LPF2 was changed the same afternoon) and its 60 Hz cousin crashed the quad. The 18 May state runs `pid_process_denom 4` (2 kHz PID, 1 kHz Nyquist, RPM notches capped at 960 Hz) — go back to 2.

Fractal 65 (10 flights): no 66/132 Hz pair; a clean throttle-independent 231–233 Hz line on all axes (5–7× floor) plus ~76–82 Hz. The 235 Hz D-term notch was aimed right but redundant with a dynamic notch whose floor is ≥120 Hz, and together with the 75–110 Hz D low-pass it pushed the D-path delay to 15 ms. `dyn_notch_min_hz 40` must go back to ≥100. The 44 Hz line seen on all three crafts sits at the 2500 rpm dynamic-idle speed and is not a frame resonance.

Meteor75 Pro (7 flights): identical to the BetaFPV Meteor75 Pro O4 2026 factory file (P 64, I 103, D 48/67, D-min 43/58, FF 50/42/43, TPA 80@1350, gyro LPF2 550, 1 notch Q400 150–300, RPM 2 harmonics, D PT1 70–165 + 120, thrust_linear 30, sag comp 100, dyn idle 3000). Noise floor 0.02, D noise 6–11 in cruise.

## The logic per class

Filters: gyro LPF1 off; LPF2 500–600 as anti-alias (AOS 1000); one dynamic notch Q 400–500 with floor 120–150 (two on freestyle variants); D-term PT1 dyn 75–150 + PT1 150 (Meteor 70–165 + 120, Pavo20 Pro 86–172 + 172); RPM filter 3 harmonics (AOS 1, Karate 1–2 with fade 100–120); `pid_process_denom 2` on every G4/F4 whoop.

PIDs: I:D ≈ 2:1–3:1 (small motors heat fast); D-min as hover floor with modest D-max gain (AOS and UAV Tech switch D-max off); TPA 1250 on whoop race tunes, 1350 default, 1600–1750 for 5in freestyle; thrust_linear keyed to ESC PWM (0 @16–24 kHz, 20 @48 kHz, 40 @96 kHz per UAV Tech; AOS 25, Karate 20, BetaFPV HD 30); sag compensation 100 on 1S; vendors now tune through the simplified sliders (formulas in `simplified_tuning.c`).

Rates (ACTUAL, centre/max/expo): whoop racing 100–120 / 600–650 / 0.45–0.50 (SugarK whoop preset); 65mm outdoor freestyle 190 / 950 / 0.55 (Oscar Liang); 75mm HD freestyle 50–120 / 550–720 / 0–0.45 (AOS HD, Meteor factory), yaw max = roll max ÷ tan(uptilt); 2in HD cinematic 100 / 540 / 0.60 (FaderFPV); 2.5in freestyle 60–100 / 700–750 / 0.40–0.45 (RubberQuads); 2.5in racing 150 / 650–700 / 0.1–0.3 (ctzsnooze). Rate profiles can be switched in flight, so a centre-sensitivity A/B is free.

## Recommendations

Air65 R: notch floor 100 (120 if the 132 Hz line is gone), one notch Q 500; `pid_process_denom 2`; A/B balanced vs crisp on the "65mm 1S analog · Precision" template; FF 0 indoors, FF 50 as its own A/B outdoors; try `thrust_linear 20` and `vbat_sag_compensation 100` one at a time; log at 2 kHz.

Fractal 65: same master filters; remove the 235 Hz D notch; restore D low-pass 75–150 + 150 and let the A/B decide; start from profile 1 PIDs (P 61/67).

Meteor75 Pro: keep the factory tune; check `motor_poles` (14-pole 1102s would put every RPM notch off-frequency); Precision template indoors; match yaw to uptilt for yaw spins.

FlyLens 85 / Kayoumini: no factory tune exists; use the 2in HD and 2.5in templates (proxies from Cinebot20/Pavo20 Pro and Pavo25 V2/UAV Tech Micro), fly one balanced log, then A/B.

## Not verified

nils vo's and Bardwell's rates videos; any published "perceptible delay" figure for whoops; per-class delay budgets (synthesised from cutoffs); the Meteor75 Pro's true pole count; whether the "Champion" frame is the Air65 II part; the app's step-response and D-noise thresholds are its own choices.

## Update, 2 September 2026 (evening): what the re-analysis of all 76 flights changed

The classifier now tests every spectral line against the motors' own eRPM frequency (per motor, per window, harmonics 1-3, and folded at the log rate because blackbox decimates the filtered gyro without an anti-alias stage). Two conclusions above are corrected by it:

- **Meteor75 Pro motor poles: 12 is right, 14 is not.** On every 2 kHz session (#71, #73, #74, #75, #76) the strongest line at 966-980 Hz is the 3rd motor harmonic folded at Nyquist (2011 − 3·f) at a ratio of 1.000-1.001 to the 12-pole prediction, and #73 shows the direct 2nd harmonic at 701 Hz = 2.00×. With 14 poles the eRPM-derived frequency would be 7/6 too high and the 2nd harmonic would sit at 1.71×; no session has a line there. The app now reports "Motor pole count confirmed (motor_poles 12)" on these logs and would raise "RPM estimate does not match measured motor peak" (with a `set motor_poles` line) if a strong 1st/2nd-harmonic line sat within 1.5 % of another pole count's prediction.
- **The ~303 Hz line on the Meteor is not motor noise.** It sits on yaw (and roll in the 1 kHz session) at 9-10× the floor with 5-10 Hz spread, at 0.87-0.90× the motor fundamental: neither an integer harmonic nor the 14-pole 0.857×. It is a fixed line just above `dyn_notch_max_hz = 300`, which is why the dynamic notch never touches it; the resonance rule now proposes raising the notch ceiling to cover it.
- **The Fractal's 76-82 Hz line is the folded 2nd motor harmonic** (2·535 Hz − 989 Hz log rate), not a frame resonance, and the Air65 R's 115-123 Hz and 200-235 Hz lines stay fixed while the motors move, so they remain frame lines. The 42 Hz line is motor idle only on the logs flown with dynamic idle (2500 rpm); on the 12-13 May logs dynamic idle was off and the slowest motor never dropped below ~100 Hz, so there it is a genuine low-frequency line.
- **Step response now comes from system identification** (PIDtoolbox-style deconvolution over 2 s windows, normalised per window). The explicit "stick step" numbers quoted above (3.3 % vs 7 % overshoot, 40-60 ms rise) were measuring RC-smoothed stick ramps; the loop itself on the Air65 R shows 2 ms latency, 13-19 ms rise and 11-18 % overshoot on roll/pitch across the May logs, 5-8 % on the Meteor75 Pro. Axes with usable step evidence went from 32 to 175 of 228.
- Logging at 1/4 (1 kHz) on the Air65 R hides the motor band: the 2nd harmonic folds to 80-120 Hz. `blackbox_sample_rate = 1/2` is recommended on those logs.
- **Stick commands verified** against `src/main/fc/rc_controls.c` on the 4.5-maintenance branch: with throttle low and yaw left, roll left selects PID profile 1 (`changePidProfile(0)`), pitch up profile 2, roll right profile 3; the docs' Profiles page agrees and no stick command exists for rate profiles (those switch via adjustment function 12 / `adjrange`, OSD or CLI `rateprofile`).

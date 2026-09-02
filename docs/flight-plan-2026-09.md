# Flight plan — first A/B tests (written 2 September 2026, fly whenever)

Everything below is props-off bench work followed by one pack per test. The app can write each pair for you (Tuning Wizard → "Write A and B to the FC"), which also snapshots both slots and records the pair so the Log Lab labels the sessions; the CLI blocks are the same thing by hand.

**Numbering:** the CLI counts profiles from 0 (`profile 0/1/2`); Configurator, the OSD and the stick commands count from 1 ("PID profile 1/2/3"). Your Air65 R "HQ 31mm" tune lives in CLI `profile 1` = Configurator "PID profile 2".

## 1. Air65 R — Balanced vs Crisp (D-term chain only)

Template: 65mm 1S analog · Precision. A = the template's D chain, B = the same with the D chain × 1.25. PIDs, feedforward (0), TPA and rates are identical; only the D-term low-passes differ, so what you feel on the switch is the filtering-vs-delay trade-off itself.

```
# master settings (shared by every profile)
set pid_process_denom = 2
set dyn_notch_count = 1
set dyn_notch_min_hz = 100
set dyn_notch_max_hz = 500
set dyn_notch_q = 500
set rpm_filter_harmonics = 3
set rpm_filter_min_hz = 100
set blackbox_sample_rate = 1/2

# CLI profile 1 (= Configurator "PID profile 2", HQ 31mm) = A · Balanced
profile 1
set dterm_lpf1_dyn_min_hz = 70
set dterm_lpf1_dyn_max_hz = 150
set dterm_lpf2_static_hz = 120
set d_min_roll = 24
set d_min_pitch = 30
set d_max_gain = 45
set tpa_rate = 40
set tpa_breakpoint = 1600

# CLI profile 2 (= Configurator "PID profile 3") = B · Crisp: same PIDs, D chain × 1.25
profile 2
set p_roll = 61
set i_roll = 110
set d_roll = 41
set p_pitch = 67
set i_pitch = 121
set d_pitch = 51
set p_yaw = 61
set i_yaw = 110
set f_roll = 0
set f_pitch = 0
set f_yaw = 0
set d_min_roll = 24
set d_min_pitch = 30
set d_max_gain = 45
set tpa_rate = 40
set tpa_breakpoint = 1600
set dterm_lpf1_dyn_min_hz = 88
set dterm_lpf1_dyn_max_hz = 188
set dterm_lpf2_static_hz = 150

profile 1
save
```

Wizard equivalent: drone Air65 R, goal Precision, pair "Balanced vs Crisp", slot "PID profile 2" for A and "PID profile 3" for B, then "Write A and B to the FC". If you paste the CLI instead, press "Save pair for log labels" in the same card so the Log Lab can label the flights.

Procedure, one pack:

1. Props off: paste the block (or write from the wizard) and confirm the FC comes back on CLI profile 1 (Configurator shows "PID profile 2").
2. Arm and fly A for 30–60 s: the same indoor lines, five or six sharp roll and pitch flicks, three throttle chops, a hover. Land, disarm, touch the motors.
3. Stick command with throttle down and yaw left, then **roll right** (the FC LED flickers) = Configurator profile 3 = CLI profile 2 = B. (Roll left = profile 1, pitch up = profile 2, roll right = profile 3.) Or OSD menu → Profiles.
4. Arm, fly B the same way, land, disarm, touch the motors again. Hot motors on B end the argument.
5. Download the flash file, upload it in the Log Lab. The two sessions appear labelled "A · Balanced" and "B · Crisp"; select B and pick A under "Compare with". Overshoot, rise time, D-term noise and the delay estimate get a better/worse verdict.

What decides: motor temperature first; then B should show the same or lower overshoot with a slightly faster rise and no rise in D-term noise. If B wins cleanly, the next pair is Crisp vs a further ×1.25 step; if the motors come down warm or D noise climbs, Balanced stays.

## 2. Air65 R — rate A/B (centre sensitivity, switchable in flight)

Same pack or a second one. A = the draft's rates (190 °/s centre, 900 max, expo 0.20), B = centre × 1.3 (250 °/s), same max and expo. Wizard: "Rate A/B" card, slots rate profile 1 and 2, "Write rate A and B to the FC" (or "Copy CLI for both" and paste).

Set up the switch once: Configurator → Adjustments → "Rate Profile Selection" on a 3-position switch, or in the CLI

```
adjrange 0 0 <aux index> 900 2100 12 <aux index> 0 0
save
```

(function 12; aux index counts from 0 for AUX1; switch low = rate profile 1, middle = 2, high = 3). Fly A, land and disarm, flip the switch, arm and fly B — one blackbox session each, labelled "A · Rates" / "B · Centre +30 %".

## 3. Meteor75 Pro — one change, then the same A/B

Motor poles are 12 (confirmed from the harmonics; leave `motor_poles`). The stable ~303 Hz yaw line sits just above the dynamic-notch ceiling:

```
set dyn_notch_max_hz = 400
save
```

Fly one log, check that the yaw line is gone and yaw D noise did not rise. Then run Balanced vs Crisp on the "75mm 1S HD · Freestyle" template (it is the factory tune) exactly as in section 1.

## 4. Fractal 65

Before any A/B: `set dterm_notch_hz = 0` (the 235 Hz D notch), `set dyn_notch_min_hz = 100` (never 40), D low-pass back to 75–150 + 150, start from the HQ 31mm PIDs (P 61/67). Then section 1's pair on the "65mm 1S analog · Precision" template.

## After the flights

- Upload every file in the Log Lab; each arm is one entry. Re-analyze if a session was analyzed before the evening update (the findings now include the pole check, folded harmonics and the deconvolution step response).
- Look for: "Motor harmonic folded by the log rate" (should disappear at 2 kHz logging), "Motor pole count confirmed", the D-term noise per band, and the step response card's method and window count.

## 5. After the masterclass review (2 September, night): the sequence and the new pairs

The wizard now shows a **Tuning sequence** card per drone (log → filters → master → P:D → I and dynamic idle → feedforward → dynamic damping → rates, Rosser's order with Brian White's variant noted). Steps tick themselves when a log is analysed or a pair of that step is recorded; tick the rest yourself. Every pair below is written like section 1 (two PID profiles, fly A, land, stick command, fly B, upload) and labelled in the Log Lab.

Before the PID pairs, once per drone (CLI):

```
set d_max_advance = 0
set pidsum_limit = 1000
set pidsum_limit_yaw = 1000
set gyro_lpf2_static_hz = 1000
save
```

(Rosser: advance always 0; pidsum 1000 is optional and only while the motors are not saturating — UAV Tech's and Karate's whoop presets use it; LPF2 1000 is his rule for 8k gyro / 4k PID and his own AOS 65mm preset.)

Pairs, one pack each, in this order:

1. **Balanced vs Crisp** (section 1) — the D-term filter step. If the D-term is quiet in both throttle bands the Log Lab says so ("D-term is quiet — the D-term filtering has headroom").
2. **Master 1.0 vs 1.15** — P, I, D, D-min and FF ×1.15. Motors first, then rise time without new ringing. Fly it on a fresh pack (latency is voltage-sensitive).
3. **Tracking 1.0 vs 1.1** — P and I ×1.1, D unchanged. Per axis: faster rise, at most a hair of overshoot; ringing on B = past the optimum. For Rosser's clean sweep set FF 0, I low and D-max 0 on both sides first (the wizard does not do that for you).
4. **Dynamic idle 2500 vs 6000 rpm** — propwash and low-throttle stability against descent authority. The idle line moves from 42 Hz (unfiltered) to 100 Hz (inside the RPM filter). 10000 rpm (Rosser's AOS 65mm, Mobula6 V3) is the next pair if B wins.
5. **Feedforward 0 vs 50/50/45** (outdoor) — judge on the raw setpoint/gyro trace in the Log Lab, not on the step card: with the 500 Hz link the step tool exaggerates FF overshoot (Brian White).
6. Optional: **Karate vs AOS** — Rosser's single biquad 80-110 Hz D-term chain against the PT1 pair; his own whoop preset keeps the PT1 pair, so treat it as an experiment and watch the motors.

Meteor75 Pro: the raw gyro shows the 2nd and 3rd motor harmonics leaking with `rpm_filter_harmonics 1` (and the 3rd with 2) — set 3 harmonics before the `dyn_notch_max_hz 400` flight of section 3, then let the weights finding (2 kHz logs only) trim them.

RC smoothing (global, not A/B-able): the default 30 is a racing setting; try `set rc_smoothing_auto_factor = 50` for outdoor freestyle and judge by feel — each step of smoothing costs a few ms of stick delay.

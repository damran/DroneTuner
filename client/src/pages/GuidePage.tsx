import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const steps = [
  {
    title: "1. Set up logging (once)",
    body: "Blackbox tab: onboard flash, rate 1/2 at 4 kHz PID (2 kHz; whoops and 3in should log 2-4 kHz for the filter flights because their motor harmonics sit high). Betaflight 4.5 always logs the raw gyro, so any debug mode works; FFT_FREQ shows where the dynamic notches sit. Erase the flash before a tuning day. Apply your radio-link preset (ELRS 500 Hz) so feedforward smoothing, jitter and averaging match the link.",
  },
  {
    title: "2. Baseline flight",
    body: "Fresh, undamaged props and the build exactly as you fly it. Hover 30-40 s at a metre or more (ground effect dirties the data), do three slow throttle sweeps to full over 5-10 s each, then fly normally with some sharp roll and pitch moves. Arm once per pack so each flight is its own log.",
  },
  {
    title: "3. Filter flight and the filter pass",
    body: "Upload, analyse. The Log Lab reads the raw gyro (what noise exists) and the filtered gyro (what leaks through), the way Rosser reads the frequency-vs-throttle view: motor lines → RPM filter (fade-in where the noise starts, Q pushed while nothing leaks, weights dimmed on harmonics the raw gyro does not show); fixed stripes → one dynamic notch per stripe with the minimum a little below the lowest stripe, never under 100 Hz, or no notch when there is no stripe; gyro LPF1 off, LPF2 at 1000 Hz. Then the D-term filters: fly the Balanced vs Crisp pair and open them until the motors sound rough or come down warm, then back off a step.",
  },
  {
    title: "4. PID flights: the wobble test",
    body: "Sharp roll and pitch moves with the stick held: out-and-back, or left-right wobbles, 20-25 per axis, 20-45 s — never let the stick snap back to centre. Angle mode with a reduced angle limit is fine and easier indoors. For the P:D and master pairs the wizard zeroes nothing for you: set feedforward, I and dynamic damping low yourself if you want Rosser's clean sweep, or fly the pairs on your normal tune and compare the step responses as they are. A tiny overshoot is fine, oscillation is not; a drooping tail is too little I; a slow drawn-out overshoot is too much I.",
  },
  {
    title: "5. Compare A and B in the Log Lab",
    body: "'Compare in flight' writes two versions of your draft into two PID profiles: the D-term chain (Balanced/Crisp/Smooth/AOS), the master multiplier, the tracking (P&I) step, feedforward, or dynamic idle. Fly A, land, switch to profile B while disarmed (stick command: throttle down + yaw left, then roll left = profile 1, pitch up = profile 2, roll right = profile 3; or the OSD menu — Betaflight 4.5 has no in-flight switch for PID profiles, only for rate profiles), fly B the same way in the same pack, upload. The Log Lab labels each session A or B from its headers and puts them side by side: motor temperature and D-term noise first, then rise time and overshoot. Judge feedforward on the raw setpoint/gyro trace, not the step tool (with a 500 Hz link it exaggerates FF overshoot).",
  },
  {
    title: "6. Rates and RC smoothing",
    body: "The rate A/B writes your rates into one rate profile and the same rates with 30 % more centre sensitivity into another; rate profiles switch in flight: 'Rate Profile Selection' (adjustment function 12) on a 3-position switch, or CLI adjrange 0 0 <aux> 900 2100 12 <aux> 0 0 (low = rate profile 1, middle = 2, high = 3). Rosser: centre 50 for precision and cinematic, 50-100 freestyle, ~150 dynamic flying; max 500-700, raise it only when flips take an age; RC smoothing auto factor 50-60 freestyle, 90-100 cinematic (the default 30 is a racing setting).",
  },
];

const tips = [
  "Bench work with props off — the app never arms or spins motors.",
  "Check the motors after every A/B side: hot motors end the argument (Rosser); pinch the bell — if you cannot hold it a few seconds it is too hot.",
  "Fly the same lines on A and B in the same pack; keep the battery voltage similar across a sweep (latency is voltage-sensitive, Brian White).",
  "Keep the dynamic notch floor at 100 Hz or above on whoops and micros: below that it removes real control signal (this fleet crashed at 60 Hz / Q 300).",
  "Log at 2 kHz or better (blackbox_sample_rate 1/2 at 4 kHz PID) so motor harmonics above 500 Hz are visible; 1 kHz logging folds them into the spectrum.",
  "d_max_advance stays 0 (Rosser); dynamic damping gain is tuned with debug mode D_MIN so the D-term boosts on sharp moves only.",
];

export default function GuidePage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Tuning flights, in order</h1>
        <p className="text-sm text-muted-foreground">
          Chris Rosser's Betaflight 4.5 tuning sequence and Brian White's PIDtoolbox wobble test, as the wizard runs them.
        </p>
      </div>

      <div className="space-y-4">
        {steps.map((s) => (
          <Card key={s.title}>
            <CardHeader className="p-4">
              <CardTitle className="text-sm">{s.title}</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0 text-sm text-muted-foreground">{s.body}</CardContent>
          </Card>
        ))}

        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">Tips</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

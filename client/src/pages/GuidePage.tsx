import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const steps = [
  {
    title: "1. Enable blackbox logging",
    body: "In Betaflight Configurator, go to the Blackbox tab and enable logging to flash or SD card. Set the logging rate to 1 kHz (or 2 kHz if your FC supports it) for clean noise data.",
  },
  {
    title: "2. Pick a debug mode",
    body: "For noise analysis, set the debug mode to GYRO_SCALED or NONE. For RPM filter checks, use RPM_FILTER (requires bidirectional DSHOT).",
  },
  {
    title: "3. Fly the right maneuvers",
    body: "Record a mix of: (a) a slow hover for noise floor, (b) sharp stick flicks on roll and pitch for step-response analysis, (c) full-throttle punchouts for battery sag and motor saturation, and (d) steady cruise for D-term activity.",
  },
  {
    title: "4. Download the log",
    body: "After landing, disarm and download the .bbl file from the Blackbox tab (or copy it off the SD card).",
  },
  {
    title: "5. Upload here",
    body: "Open the Log Lab, pick the drone, and upload the .bbl file. A flash download holds one session per arm: every flight becomes its own entry (short arm/disarm blips are skipped). Click Analyze to get metrics and findings, then Load traces to inspect gyro/setpoint/D-term and the FFT noise spectrum.",
  },
  {
    title: "6. A/B test crisp vs smooth in one pack",
    body: "In the Tuning Wizard, 'Compare in flight' writes two versions of your draft into two PID profiles: same PIDs, feedforward and rates, only the D-term filter chain differs. Fly A for 30 s with a few sharp moves and throttle chops, land, switch to profile B while disarmed (stick command: throttle down + yaw left, then roll left = profile 1, pitch up = profile 2, roll right = profile 3; or the OSD menu — Betaflight 4.5 has no in-flight switch for PID profiles, only for rate profiles), fly B the same way in the same pack, then upload the log. The Log Lab labels each session A or B from its headers, and 'Compare with' puts the two side by side: noise floor, D-term noise, step overshoot and the filter delay estimate decide.",
  },
  {
    title: "7. A/B the rates in flight",
    body: "The wizard's rate A/B writes the draft's rates into one rate profile and the same rates with 30 % more centre sensitivity into another. Rate profiles do switch in flight: put 'Rate Profile Selection' (adjustment function 12) on a 3-position switch in Configurator → Adjustments, or in the CLI: adjrange 0 0 <aux> 900 2100 12 <aux> 0 0 (switch low = rate profile 1, middle = 2, high = 3). Fly A, land and disarm, flip the switch, arm and fly B, so each side is its own blackbox session and gets its A/B label.",
  },
];

const tips = [
  "Bench work with props off — the app never arms or spins motors.",
  "A 30–60 second log is plenty for noise and step-response analysis.",
  "Fly in calm air: wind adds low-frequency noise that muddies the spectrum.",
  "If you see a strong resonance peak, note the frequency — the tuning wizard will notch it out.",
  "Keep the dynamic notch floor at 100 Hz or above on whoops and micros: below that it removes real control signal (this fleet crashed at 60 Hz / Q 300).",
  "Log at 2 kHz or better (blackbox_sample_rate 1/2 at 4 kHz PID) so motor harmonics above 500 Hz are visible; 1 kHz logging folds them into the spectrum.",
];

export default function GuidePage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Recording a usable log</h1>
        <p className="text-sm text-muted-foreground">
          How to capture blackbox logs that produce useful noise and tuning analysis.
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

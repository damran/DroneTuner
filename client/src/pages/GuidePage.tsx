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
    body: "Open the Log Lab, pick the drone, and upload the .bbl file. Click Analyze to get metrics and findings, then Load traces to inspect gyro/setpoint/D-term and the FFT noise spectrum.",
  },
];

const tips = [
  "Bench work with props off — the app never arms or spins motors.",
  "A 30–60 second log is plenty for noise and step-response analysis.",
  "Fly in calm air: wind adds low-frequency noise that muddies the spectrum.",
  "If you see a strong resonance peak, note the frequency — the tuning wizard will notch it out.",
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

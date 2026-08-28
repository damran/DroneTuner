import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { Axis } from "@dronetuner/shared";
import { AXIS_LABELS } from "@dronetuner/shared";
import {
  BF_DEFAULT_RATES,
  shareInRange,
  type AxisRates,
  type AxisRateUsage,
  type RatesUsage,
} from "@dronetuner/shared/analysis";
import {
  RATES_STYLES,
  RATES_STYLE_LABELS,
  bendRegionDegS,
  rateCurvePoints,
  recommendRates,
  stickForDegS,
  zoneStickTravel,
  type AxisRatesRecommendation,
  type RatesStyle,
} from "@dronetuner/shared/tuning";
import { EChart } from "@/components/charts/EChart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const AXES: readonly Axis[] = ["roll", "pitch", "yaw"];

const ZONE_ORDER = ["precision", "normal", "deadspace", "trick"] as const;
const ZONE_LABELS: Record<(typeof ZONE_ORDER)[number], string> = {
  precision: "Precision (0–50 °/s)",
  normal: "Normal (50–300 °/s)",
  deadspace: "Dead space (300–600 °/s)",
  trick: "Trick (600+ °/s)",
};
const ZONE_BANDS: Record<(typeof ZONE_ORDER)[number], [number, number]> = {
  precision: [0, 50],
  normal: [50, 300],
  deadspace: [300, 600],
  trick: [600, 2000],
};
const ZONE_COLORS: Record<(typeof ZONE_ORDER)[number], string> = {
  precision: "rgba(34, 211, 238, 0.10)",
  normal: "rgba(52, 211, 153, 0.10)",
  deadspace: "rgba(245, 158, 11, 0.12)",
  trick: "rgba(244, 114, 182, 0.10)",
};

function isRatesStyle(v: string | null | undefined): v is RatesStyle {
  return (RATES_STYLES as readonly string[]).includes(v ?? "");
}

export default function RatesAdvisor({
  usage,
  sizeClass,
  initialStyle,
}: {
  usage: RatesUsage;
  sizeClass: string;
  initialStyle?: string | null;
}) {
  const [style, setStyle] = useState<RatesStyle>(isRatesStyle(initialStyle) ? initialStyle : "freestyle");
  const [axisTab, setAxisTab] = useState<Axis>("roll");
  const [copied, setCopied] = useState(false);

  const rec = useMemo(() => recommendRates(usage, style, sizeClass), [usage, style, sizeClass]);

  const usageFor = (axis: Axis): AxisRateUsage | undefined => usage.axes.find((a) => a.axis === axis);
  const currentFor = (axis: Axis): AxisRates => usage.loggedRates?.[axis] ?? BF_DEFAULT_RATES;
  const recFor = (axis: Axis): AxisRatesRecommendation => rec.axes.find((a) => a.axis === axis)!;

  const copyCli = async () => {
    await navigator.clipboard.writeText(rec.cliBlock);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between p-4">
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm">Rates advisor</CardTitle>
            <Badge variant="outline">{sizeClass}</Badge>
          </div>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Flying style</Label>
              <Select value={style} onValueChange={(v) => setStyle(v as RatesStyle)}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RATES_STYLES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {RATES_STYLE_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-1 p-4 pt-0">
          <p className="text-xs text-muted-foreground">
            Stick usage measured from this log&apos;s setpoint channels (deg/s), {Math.round(usage.airborneShare * 100)}%
            of frames airborne. Recommendation blends your selected style, this drone&apos;s size class and your measured
            usage.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4">
          <CardTitle className="text-sm">Your stick usage</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 p-4 pt-0">
          <div className="grid gap-4 lg:grid-cols-3">
            {AXES.map((axis) => {
              const u = usageFor(axis);
              if (!u) return null;
              return (
                <div key={axis}>
                  <div className="mb-1 text-xs font-medium">{AXIS_LABELS[axis]}</div>
                  <EChart option={buildHistogramOption(u, usage.binWidthDegS, currentFor(axis).max)} height={180} />
                  <div className="mt-1 text-xs text-muted-foreground">
                    {ZONE_ORDER.map((z) => `${ZONE_LABELS[z].split(" (")[0]} ${Math.round(u.zones[z] * 100)}%`).join(" · ")}
                  </div>
                  {u.highDeflectionTracking !== null && u.highDeflectionTracking < 0.9 && u.achievedP99DegS !== null && (
                    <div className="mt-1 text-xs text-amber-500">
                      Commanded max ~{Math.round(currentFor(axis).max)} °/s, physically reaches ~
                      {Math.round(u.achievedP99DegS)} °/s ({Math.round(u.highDeflectionTracking * 100)}% tracking).
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {AXES.map((axis) => {
            const u = usageFor(axis);
            if (!u) return null;
            const notes: string[] = [];
            if (u.zones.deadspace > 0.25) {
              notes.push(
                `${AXIS_LABELS[axis]}: ${Math.round(u.zones.deadspace * 100)}% of airtime is in the 300–600 °/s dead space — ` +
                  `rates that don't match your flying style pile usage there.`,
              );
            }
            const bend = bendRegionDegS(currentFor(axis).center, currentFor(axis).max, currentFor(axis).expo);
            if (bend) {
              const share = shareInRange(u.histogram, bend[0], bend[1], usage.binWidthDegS);
              if (share > 0.3) {
                notes.push(
                  `${AXIS_LABELS[axis]}: ~${Math.round(share * 100)}% of your flying sits on the current curve's steep ` +
                    `elbow (${Math.round(bend[0])}–${Math.round(bend[1])} °/s) — corrections there feel inconsistent.`,
                );
              }
            }
            return notes.map((n) => (
              <p key={n} className="text-xs text-amber-500">
                {n}
              </p>
            ));
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4">
          <CardTitle className="text-sm">Recommended rates — {RATES_STYLE_LABELS[style]}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Axis</TableHead>
                <TableHead>Center (°/s)</TableHead>
                <TableHead>Max rate (°/s)</TableHead>
                <TableHead>Expo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {AXES.map((axis) => {
                const cur = currentFor(axis);
                const r = recFor(axis);
                return (
                  <TableRow key={axis}>
                    <TableCell className="font-medium">{AXIS_LABELS[axis]}</TableCell>
                    <TableCell>
                      <RateCell from={cur.center} to={r.center} />
                    </TableCell>
                    <TableCell>
                      <RateCell from={cur.max} to={r.max} />
                    </TableCell>
                    <TableCell>
                      <RateCell from={cur.expo} to={r.expo} digits={2} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {!usage.loggedRates && (
            <p className="text-xs text-muted-foreground">
              Log headers don&apos;t include rates — “current” shows the Betaflight 4.5 defaults (70 / 670 / 0.50).
            </p>
          )}
          {rec.axes.some((a) => a.rationale.length > 0) && (
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {rec.axes.flatMap((a) => a.rationale.map((r) => <li key={`${a.axis}-${r}`}>{r}</li>))}
            </ul>
          )}
          {rec.warnings.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-xs text-amber-500">
              {rec.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between p-4">
          <CardTitle className="text-sm">Curves &amp; resolution</CardTitle>
          <Tabs value={axisTab} onValueChange={(v) => setAxisTab(v as Axis)}>
            <TabsList>
              {AXES.map((a) => (
                <TabsTrigger key={a} value={a}>
                  {AXIS_LABELS[a]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="space-y-4 p-4 pt-0">
          <EChart
            option={buildCurveOption(currentFor(axisTab), recFor(axisTab), usageFor(axisTab))}
            height={260}
          />
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              Stick travel per zone (current → recommended)
            </div>
            <Table>
              <TableBody>
                {(() => {
                  const cur = zoneStickTravel(currentFor(axisTab).center, currentFor(axisTab).max, currentFor(axisTab).expo);
                  const r = recFor(axisTab);
                  const next = zoneStickTravel(r.center, r.max, r.expo);
                  return ZONE_ORDER.map((z) => (
                    <TableRow key={z}>
                      <TableCell className="text-xs text-muted-foreground">{ZONE_LABELS[z]}</TableCell>
                      <TableCell className="text-xs">
                        {Math.round(cur[z] * 100)}% →{" "}
                        <span className={next[z] !== cur[z] ? "font-medium text-primary" : ""}>
                          {Math.round(next[z] * 100)}%
                        </span>
                      </TableCell>
                    </TableRow>
                  ));
                })()}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between p-4">
          <CardTitle className="text-sm">Apply manually</CardTitle>
          <Button size="sm" variant="outline" onClick={() => void copyCli()}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-2 p-4 pt-0">
          <pre className="overflow-x-auto rounded-lg border bg-muted/50 p-3 text-xs">{rec.cliBlock}</pre>
          <p className="text-xs text-muted-foreground">
            Display only — paste into the Betaflight Configurator CLI (writes to the active rate profile, then
            `save`). FC writes from DroneTuner stay in the wizard/profile apply flow.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function RateCell({ from, to, digits = 0 }: { from: number; to: number; digits?: number }) {
  const changed = from.toFixed(digits) !== to.toFixed(digits);
  return (
    <span className="text-xs">
      <span className="text-muted-foreground">{from.toFixed(digits)}</span>
      {" → "}
      <span className={changed ? "font-medium text-primary" : ""}>{to.toFixed(digits)}</span>
    </span>
  );
}

function buildHistogramOption(u: AxisRateUsage, binWidth: number, loggedMax: number) {
  const total = u.histogram.reduce((a, b) => a + b, 0);
  const data: [number, number][] = [];
  for (let b = 0; b < u.histogram.length; b++) {
    const pct = total > 0 ? (u.histogram[b]! / total) * 100 : 0;
    if (pct > 0 || b * binWidth <= 700) data.push([b * binWidth + binWidth / 2, Number(pct.toFixed(2))]);
  }
  const xMax = Math.min(1250, Math.max(650, Math.ceil(Math.max(u.maxDegS, loggedMax) / 100) * 100 + 50));

  const markLineData: { xAxis: number; label: { formatter: string }; lineStyle: { color: string; type: "dashed" | "solid" } }[] = [
    { xAxis: u.p50, label: { formatter: "p50" }, lineStyle: { color: "#9ca3af", type: "dashed" } },
    { xAxis: u.p90, label: { formatter: "p90" }, lineStyle: { color: "#9ca3af", type: "dashed" } },
    { xAxis: u.p99, label: { formatter: "p99" }, lineStyle: { color: "#9ca3af", type: "dashed" } },
  ];
  if (loggedMax > 0 && loggedMax <= xMax) {
    markLineData.push({ xAxis: loggedMax, label: { formatter: "max" }, lineStyle: { color: "#f472b6", type: "solid" } });
  }

  return {
    backgroundColor: "transparent",
    textStyle: { color: "#9ca3af" },
    tooltip: {
      trigger: "axis" as const,
      formatter: (params: unknown) => {
        const p = (params as { data: [number, number] }[])[0];
        if (!p) return "";
        const lo = p.data[0] - binWidth / 2;
        return `${lo}–${lo + binWidth} °/s<br/>${p.data[1]}% of airtime`;
      },
    },
    grid: { left: 40, right: 10, top: 20, bottom: 24 },
    xAxis: {
      type: "value" as const,
      min: 0,
      max: xMax,
      name: "°/s",
      nameTextStyle: { color: "#9ca3af" },
      axisLabel: { color: "#9ca3af" },
    },
    yAxis: { type: "value" as const, axisLabel: { color: "#9ca3af", formatter: "{value}%" } },
    series: [
      {
        type: "bar" as const,
        data,
        barWidth: "70%",
        itemStyle: { color: "#22d3ee" },
        markArea: {
          silent: true,
          data: ZONE_ORDER.map(
            (z): [{ xAxis: number; itemStyle: { color: string } }, { xAxis: number }] => [
              { xAxis: ZONE_BANDS[z][0], itemStyle: { color: ZONE_COLORS[z] } },
              { xAxis: Math.min(ZONE_BANDS[z][1], xMax) },
            ],
          ),
        },
        markLine: { silent: true, symbol: "none", data: markLineData },
      },
    ],
  };
}

function buildCurveOption(current: AxisRates, rec: AxisRatesRecommendation, u: AxisRateUsage | undefined) {
  const yMax = Math.ceil(Math.max(current.max, rec.max) / 200) * 200 + 100;
  const currentPts = rateCurvePoints(current.center, current.max, current.expo);
  const recPts = rateCurvePoints(rec.center, rec.max, rec.expo);

  // Shade the current curve's steep "elbow" region (nils vo's bendy part).
  const bend = bendRegionDegS(current.center, current.max, current.expo);
  const bendArea =
    bend !== null
      ? [
          [
            { xAxis: stickForDegS(bend[0], current.center, current.max, current.expo) * 100, itemStyle: { color: "rgba(245, 158, 11, 0.15)" } },
            { xAxis: stickForDegS(bend[1], current.center, current.max, current.expo) * 100 },
          ],
        ]
      : [];

  // Where the pilot's typical usage sits on the recommended curve.
  const usagePts: [number, number][] = [];
  if (u) {
    for (const v of [u.p50, u.p90]) {
      if (v > 0 && v <= rec.max) usagePts.push([stickForDegS(v, rec.center, rec.max, rec.expo) * 100, v]);
    }
  }

  const series: Record<string, unknown>[] = [
    {
      name: "current",
      type: "line",
      data: currentPts,
      showSymbol: false,
      lineStyle: { color: "#9ca3af", type: "dashed" },
      itemStyle: { color: "#9ca3af" },
      markArea: { silent: true, data: bendArea },
    },
    {
      name: "recommended",
      type: "line",
      data: recPts,
      showSymbol: false,
      lineStyle: { color: "#22d3ee" },
      itemStyle: { color: "#22d3ee" },
      markArea: {
        silent: true,
        data: ZONE_ORDER.map((z) => [
          { yAxis: ZONE_BANDS[z][0], itemStyle: { color: ZONE_COLORS[z] } },
          { yAxis: Math.min(ZONE_BANDS[z][1], yMax) },
        ]),
      },
    },
  ];
  if (usagePts.length > 0) {
    series.push({
      name: "your p50/p90",
      type: "scatter",
      data: usagePts,
      symbolSize: 8,
      itemStyle: { color: "#f472b6" },
    });
  }

  return {
    backgroundColor: "transparent",
    textStyle: { color: "#9ca3af" },
    tooltip: { trigger: "axis" as const },
    legend: { textStyle: { color: "#9ca3af" }, data: series.map((s) => s.name as string) },
    grid: { left: 50, right: 20, top: 30, bottom: 30 },
    xAxis: {
      type: "value" as const,
      min: 0,
      max: 100,
      name: "stick %",
      nameTextStyle: { color: "#9ca3af" },
      axisLabel: { color: "#9ca3af" },
    },
    yAxis: {
      type: "value" as const,
      min: 0,
      max: yMax,
      name: "°/s",
      nameTextStyle: { color: "#9ca3af" },
      axisLabel: { color: "#9ca3af" },
    },
    series,
  };
}

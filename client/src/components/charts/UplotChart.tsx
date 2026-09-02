import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useChartTheme } from "@/lib/chart-theme";

export interface UplotSeries {
  label: string;
  data: (number | null)[];
  stroke?: string;
  /** y-scale key; "y" (default) is the left axis, "d" is a right axis */
  scale?: string;
}

export function UplotChart({
  x,
  series,
  height = 280,
  yLabel,
  xLabel = "t (s)",
}: {
  x: number[];
  series: UplotSeries[];
  height?: number;
  yLabel?: string;
  xLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const theme = useChartTheme();

  useEffect(() => {
    if (!ref.current) return;
    if (x.length === 0 || series.some((s) => s.data.length !== x.length)) return;

    const usesRightAxis = series.some((s) => s.scale === "d");
    const axisStyle = { stroke: theme.text, grid: { stroke: theme.grid, width: 1 }, ticks: { stroke: theme.grid, width: 1 } };
    const opts: uPlot.Options = {
      width: ref.current.clientWidth,
      height,
      cursor: { drag: { x: true, y: false } },
      legend: { show: true },
      scales: {
        x: { time: false },
        y: { auto: true },
        ...(usesRightAxis ? { d: { auto: true } } : {}),
      },
      axes: [
        { label: xLabel, size: 60, ...axisStyle },
        { label: yLabel ?? "", size: 60, ...axisStyle },
        ...(usesRightAxis
          ? [{ side: 1 as const, scale: "d", label: "D-term (raw)", size: 60, stroke: theme.text, grid: { show: false }, ticks: { stroke: theme.grid, width: 1 } }]
          : []),
      ],
      series: [
        {},
        ...series.map((s, i) => ({
          label: s.label,
          stroke: s.stroke ?? theme.series[i % theme.series.length],
          width: 1,
          points: { show: false },
          scale: s.scale ?? "y",
          spanGaps: true,
        })),
      ],
    };
    const data: uPlot.AlignedData = [x, ...series.map((s) => s.data)];
    plotRef.current = new uPlot(opts, data, ref.current);

    const ro = new ResizeObserver(() => {
      if (ref.current && plotRef.current) {
        plotRef.current.setSize({ width: ref.current.clientWidth, height });
      }
    });
    ro.observe(ref.current);

    return () => {
      ro.disconnect();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [x, series, height, yLabel, xLabel, theme]);

  return <div ref={ref} className="w-full" />;
}

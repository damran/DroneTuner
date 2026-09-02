import { useEffect, useState } from "react";
import { useUiStore } from "./ui-store";

export interface ChartTheme {
  text: string;
  grid: string;
  series: string[];
  warning: string;
  info: string;
  success: string;
  accent: string;
}

function cssHsl(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `hsl(${v})` : fallback;
}

/** Resolve the chart colour tokens from the active theme's CSS variables. */
export function readChartTheme(): ChartTheme {
  return {
    text: cssHsl("--chart-text", "#9ca3af"),
    grid: cssHsl("--chart-grid", "#27272a"),
    series: [1, 2, 3, 4, 5].map((i) => cssHsl(`--chart-${i}`, "#22d3ee")),
    warning: cssHsl("--warning", "#f59e0b"),
    info: cssHsl("--info", "#38bdf8"),
    success: cssHsl("--success", "#22c55e"),
    accent: cssHsl("--chart-2", "#a78bfa"),
  };
}

/** Chart colours that follow the light/dark switch. */
export function useChartTheme(): ChartTheme {
  const theme = useUiStore((s) => s.theme);
  const [colors, setColors] = useState<ChartTheme>(() => readChartTheme());
  useEffect(() => {
    // The class flips synchronously in setTheme; read after paint to be safe.
    const id = requestAnimationFrame(() => setColors(readChartTheme()));
    return () => cancelAnimationFrame(id);
  }, [theme]);
  return colors;
}

/** ECharts option fragments shared by every chart (axis/legend/text colours). */
export function echartsBase(t: ChartTheme) {
  return {
    backgroundColor: "transparent",
    textStyle: { color: t.text },
    legend: { textStyle: { color: t.text } },
    axisText: { color: t.text },
    splitLine: { lineStyle: { color: t.grid } },
  };
}

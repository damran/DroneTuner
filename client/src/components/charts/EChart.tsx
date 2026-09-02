import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { useChartTheme } from "@/lib/chart-theme";

export function EChart({
  option,
  height = 280,
  className,
}: {
  option: echarts.EChartsOption;
  height?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const theme = useChartTheme();

  useEffect(() => {
    if (!ref.current) return;
    chartRef.current = echarts.init(ref.current);
    const onResize = () => chartRef.current?.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    // Theme colours as defaults; the option's own explicit colours win.
    const themed: echarts.EChartsOption = {
      backgroundColor: "transparent",
      textStyle: { color: theme.text },
      color: theme.series,
      ...option,
    };
    chartRef.current?.setOption(themed, true);
  }, [option, theme]);

  return <div ref={ref} style={{ height }} className={className} />;
}

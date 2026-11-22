import { useEffect, useRef } from "react";
import { echarts, type ChartOption } from "./echarts";

interface ChartProps {
  option: ChartOption;
  height: number;
  /** What the chart shows, for screen readers. */
  label: string;
  className?: string;
}

/** A thin ECharts wrapper: one instance per element, resized with it, disposed with it. */
export function Chart({ option, height, label, className }: ChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const instance = useRef<ReturnType<typeof echarts.init> | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const chart = echarts.init(element, null, { renderer: "canvas" });
    instance.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element);
    return () => {
      observer.disconnect();
      chart.dispose();
      instance.current = null;
    };
  }, []);

  useEffect(() => {
    instance.current?.setOption({ aria: { enabled: true, label: { description: label } }, ...option }, { notMerge: true });
  }, [option, label]);

  return <div ref={ref} className={className ?? "chart"} style={{ height }} role="img" aria-label={label} />;
}

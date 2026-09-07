import { useEffect, useRef, type ReactNode } from "react";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import type { EChartsType } from "echarts/core";
import type { UsageChartOption } from "@/lib/usage-analytics/usage-chart-option";

// The SVG renderer is load-bearing, not a preference - the palette reaches the chart as CSS `var(...)` strings
// that only resolve because they end up in DOM attributes (see `buildUsageChartOption`).
echarts.use([LineChart, GridComponent, TooltipComponent, SVGRenderer]);

export interface EChartsContainerProps {
  readonly option: UsageChartOption;
  readonly className: string;
  readonly ariaLabel: string;
  readonly testId: string;
}

/** Imperative ECharts lifecycle behind a plain div: init once, `setOption` per option change, resize with the
 * container, dispose on unmount. */
export function EChartsContainer(props: EChartsContainerProps): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const chart = echarts.init(container, null, { renderer: "svg" });
    chartRef.current = chart;
    // The container mounts before layout settles (and at 0×0 inside a just-opening dialog); the observer's initial
    // callback delivers the real size, and later ones track panel/window resizes.
    const observer = new ResizeObserver(() => {
      chart.resize();
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      chartRef.current = null;
      chart.dispose();
    };
  }, []);

  // Runs after the init effect on mount (declaration order), then alone on every option change.
  useEffect(() => {
    chartRef.current?.setOption(props.option, { notMerge: true });
  }, [props.option]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={props.ariaLabel}
      data-testid={props.testId}
      className={props.className}
    />
  );
}

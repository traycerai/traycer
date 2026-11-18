import type { ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { UsageChartGroupBy } from "@/lib/usage-analytics/usage-chart-data";

export interface UsageChartGroupByToggleProps {
  readonly groupBy: UsageChartGroupBy;
  readonly onChange: (groupBy: UsageChartGroupBy) => void;
  /**
   * Extra classes merged onto each trigger - the styling seam the Tabs
   * primitive doesn't otherwise expose (its list hardcodes `h-8`), used by
   * the usage dialogs for coarse-pointer touch-target bumps. `undefined`
   * keeps the primitive's sizing (Settings).
   */
  readonly triggerClassName: string | undefined;
}

/**
 * Harness/Model toggle for the daily chart's stacking dimension - same
 * anatomy as `UsageBreakdownToggle`. "Harness" (not "provider") because that
 * is the page's established vocabulary: the breakdown table's column header
 * and the split rows both call claude/codex/grok harnesses.
 */
export function UsageChartGroupByToggle(
  props: UsageChartGroupByToggleProps,
): ReactNode {
  return (
    <Tabs
      value={props.groupBy}
      onValueChange={(value) => {
        if (value === "harness" || value === "model") props.onChange(value);
      }}
    >
      <TabsList aria-label="Group chart by">
        <TabsTrigger
          value="harness"
          className={props.triggerClassName}
          data-testid="usage-chart-groupby-harness"
        >
          Harness
        </TabsTrigger>
        <TabsTrigger
          value="model"
          className={props.triggerClassName}
          data-testid="usage-chart-groupby-model"
        >
          Model
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

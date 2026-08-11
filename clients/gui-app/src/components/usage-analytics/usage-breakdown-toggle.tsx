import type { ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type UsageBreakdownGroupBy = "model" | "day";

export interface UsageBreakdownToggleProps {
  readonly groupBy: UsageBreakdownGroupBy;
  readonly onChange: (groupBy: UsageBreakdownGroupBy) => void;
}

/** Model/Day toggle for the breakdown table - same anatomy as `UsageMetricToggle`. */
export function UsageBreakdownToggle(
  props: UsageBreakdownToggleProps,
): ReactNode {
  return (
    <Tabs
      value={props.groupBy}
      onValueChange={(value) => {
        if (value === "model" || value === "day") props.onChange(value);
      }}
    >
      <TabsList aria-label="Group breakdown by">
        <TabsTrigger value="model" data-testid="usage-breakdown-groupby-model">
          Model
        </TabsTrigger>
        <TabsTrigger value="day" data-testid="usage-breakdown-groupby-day">
          Day
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

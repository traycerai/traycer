import type { ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { UsageMetric } from "@/lib/usage-analytics/usage-chart-data";

export interface UsageMetricToggleProps {
  readonly metric: UsageMetric;
  readonly onChange: (metric: UsageMetric) => void;
}

export function UsageMetricToggle(props: UsageMetricToggleProps): ReactNode {
  return (
    <Tabs
      value={props.metric}
      onValueChange={(value) => {
        if (value === "cost" || value === "tokens") props.onChange(value);
      }}
    >
      <TabsList aria-label="Metric">
        <TabsTrigger value="cost" data-testid="usage-metric-cost">
          Cost
        </TabsTrigger>
        <TabsTrigger value="tokens" data-testid="usage-metric-tokens">
          Tokens
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

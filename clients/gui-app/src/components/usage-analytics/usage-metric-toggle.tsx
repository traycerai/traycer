import type { ReactNode } from "react";
import { USAGE_METRIC_LABELS } from "@/lib/usage-analytics/usage-metric-labels";
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
          {USAGE_METRIC_LABELS.cost}
        </TabsTrigger>
        <TabsTrigger value="tokens" data-testid="usage-metric-tokens">
          {USAGE_METRIC_LABELS.tokens}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

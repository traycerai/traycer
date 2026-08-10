import { useMemo, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { HostRpcRegistry } from "@/lib/host";
import {
  buildUsageSummaryRequest,
  useUsageSummaryForClient,
  type UsageSummaryResponse,
  type UsageSummaryWindowDays,
} from "@/hooks/usage-analytics/use-usage-summary-query";
import type { UsageMetric } from "@/lib/usage-analytics/usage-chart-data";
import {
  buildUsageChartColumns,
  buildUsageSeriesScaleForBuckets,
} from "@/lib/usage-analytics/usage-chart-data";
import { buildUsageBreakdownRows } from "@/lib/usage-analytics/usage-breakdown";
import { lastNCalendarDays } from "@/lib/usage-analytics/day-window";
import { getViewerTimeZone } from "@/lib/usage-analytics/viewer-timezone";
import { UsageWindowPicker } from "@/components/usage-analytics/usage-window-picker";
import { UsageMetricToggle } from "@/components/usage-analytics/usage-metric-toggle";
import { UsageDailyChart } from "@/components/usage-analytics/usage-daily-chart";
import { UsageBreakdownTable } from "@/components/usage-analytics/usage-breakdown-table";
import { UsageCostFigure } from "@/components/usage-analytics/usage-cost-figure";
import { UsageErrorCard } from "@/components/usage-analytics/usage-error-card";

export interface UsageSummaryPanelProps {
  readonly client: HostClient<HostRpcRegistry> | null;
}

type UsageSummaryQueryResult = UseQueryResult<
  UsageSummaryResponse,
  HostRpcError
>;

const DEFAULT_WINDOW_DAYS: UsageSummaryWindowDays = 30;

/**
 * The Usage page's full body: window picker, cost/token toggle, per-day
 * chart, harness/model breakdown. Placement-agnostic (takes a client
 * directly) so wherever this ends up mounted, the surface itself doesn't
 * change.
 */
export function UsageSummaryPanel(props: UsageSummaryPanelProps): ReactNode {
  const [windowDays, setWindowDays] =
    useState<UsageSummaryWindowDays>(DEFAULT_WINDOW_DAYS);
  const [metric, setMetric] = useState<UsageMetric>("cost");
  // Captured once on mount, not read live during render - the x-axis's day
  // list only needs to be stable for the life of this panel, and reading
  // `Date.now()` directly in the render body is an impure render (flagged by
  // the React Compiler purity lint); a lazy `useState` initializer runs
  // exactly once, which this codebase already uses for the same reason
  // (`useNowMs` in `host-settings-panel-hooks.ts`).
  const [nowMs] = useState(() => Date.now());

  const request = useMemo(
    () => buildUsageSummaryRequest({ windowDays, epicId: null }),
    [windowDays],
  );
  const query = useUsageSummaryForClient(props.client, request);

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <UsageWindowPicker windowDays={windowDays} onChange={setWindowDays} />
        <UsageMetricToggle metric={metric} onChange={setMetric} />
      </div>
      <UsageSummaryPanelBody
        query={query}
        metric={metric}
        windowDays={windowDays}
        nowMs={nowMs}
      />
    </div>
  );
}

function UsageSummaryPanelBody(props: {
  readonly query: UsageSummaryQueryResult;
  readonly metric: UsageMetric;
  readonly windowDays: UsageSummaryWindowDays;
  readonly nowMs: number;
}): ReactNode {
  const { query, metric, windowDays, nowMs } = props;

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-ui-sm text-muted-foreground">
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
        Loading usage…
      </div>
    );
  }
  if (query.error !== null) {
    return (
      <UsageErrorCard
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  if (query.data === undefined) {
    return (
      <p className="py-8 text-ui-sm text-muted-foreground">
        Usage data unavailable.
      </p>
    );
  }

  const { summary, coverage, servedBy } = query.data;
  const days = lastNCalendarDays(windowDays, getViewerTimeZone(), nowMs);
  const scale = buildUsageSeriesScaleForBuckets(summary.buckets);
  const columns = buildUsageChartColumns(days, summary.buckets, scale, metric);
  const rows = buildUsageBreakdownRows(summary.buckets);

  return (
    <div className="flex flex-col gap-5">
      <UsageCostFigure
        totals={summary.totals}
        coverage={coverage}
        servedBy={servedBy}
        size="default"
      />
      <UsageDailyChart columns={columns} scale={scale} metric={metric} />
      <div>
        <h3 className="mb-2 text-ui-sm font-medium text-foreground">
          By harness and model
        </h3>
        <UsageBreakdownTable rows={rows} />
      </div>
    </div>
  );
}

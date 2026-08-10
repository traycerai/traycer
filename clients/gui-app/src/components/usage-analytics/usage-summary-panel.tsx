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
import {
  buildUsageBreakdownRows,
  buildUsageDayBreakdownRows,
} from "@/lib/usage-analytics/usage-breakdown";
import { buildUsageHarnessSplitRows } from "@/lib/usage-analytics/usage-harness-split";
import {
  buildUsageStatTiles,
  usageCompletenessAbsentNote,
} from "@/lib/usage-analytics/usage-stat-tiles";
import { formatDateRangeLabel } from "@/lib/usage-analytics/format-metric-value";
import { lastNCalendarDays } from "@/lib/usage-analytics/day-window";
import { UsageWindowPicker } from "@/components/usage-analytics/usage-window-picker";
import { UsageMetricToggle } from "@/components/usage-analytics/usage-metric-toggle";
import { UsageDailyChart } from "@/components/usage-analytics/usage-daily-chart";
import { UsageBreakdownTable } from "@/components/usage-analytics/usage-breakdown-table";
import { UsageDayBreakdownTable } from "@/components/usage-analytics/usage-day-breakdown-table";
import {
  UsageBreakdownToggle,
  type UsageBreakdownGroupBy,
} from "@/components/usage-analytics/usage-breakdown-toggle";
import { UsageHarnessSplit } from "@/components/usage-analytics/usage-harness-split";
import { UsageStatTiles } from "@/components/usage-analytics/usage-stat-tiles";
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
  const [breakdownGroupBy, setBreakdownGroupBy] =
    useState<UsageBreakdownGroupBy>("model");

  const request = useMemo(
    () => buildUsageSummaryRequest({ windowDays, epicId: null }),
    [windowDays],
  );
  // Enabled unconditionally: this panel only mounts once its caller has
  // already confirmed `host.usage.summary` is supported (see
  // `UsageSettingsPanelBody`'s early return). No polling here - unlike the
  // ambient epic cost badge, this is an actively-viewed screen with its own
  // refetch triggers (window/metric change, manual Retry).
  const query = useUsageSummaryForClient(props.client, request, true, false);
  const days = useMemo(() => daysForResponse(query.data), [query.data]);
  const dateRangeLabel = formatDateRangeLabel(days);

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <UsageWindowPicker windowDays={windowDays} onChange={setWindowDays} />
          <span
            className="text-ui-xs text-muted-foreground"
            data-testid="usage-date-range-label"
          >
            {dateRangeLabel}
          </span>
        </div>
        <UsageMetricToggle metric={metric} onChange={setMetric} />
      </div>
      <UsageSummaryPanelBody
        query={query}
        metric={metric}
        days={days}
        breakdownGroupBy={breakdownGroupBy}
        onBreakdownGroupByChange={setBreakdownGroupBy}
      />
    </div>
  );
}

/**
 * The chart's x-axis and the range label beside the window picker, both
 * derived from the RESPONSE's own window rather than from a client clock.
 *
 * `endAtExclusive` is the first instant outside the window, so
 * `endAtExclusive - 1` is the last one it includes - local midnight tomorrow
 * minus a millisecond, i.e. "today so far" (see `resolveUsageSummaryWindow`
 * in packages/common). Anchoring on a mount-time `Date.now()` instead was
 * the earlier shape, and this panel outlives a local midnight easily: any
 * later refetch - window switch, Retry, host reconnect, window refocus -
 * would return buckets for the new day against an axis that still ended on
 * the old one, dropping the newest bucket from the chart while it stayed in
 * the totals, and leaving the range label a day behind.
 *
 * No usage response yet means no range to describe, so the axis is empty and
 * the label renders nothing - the body is showing its loading or error state
 * in that same pass anyway.
 */
function daysForResponse(
  data: UsageSummaryResponse | undefined,
): readonly string[] {
  if (data === undefined) return [];
  const { window } = data.summary;
  return lastNCalendarDays(
    window.windowDays,
    window.timezone,
    window.endAtExclusive - 1,
  );
}

function UsageSummaryPanelBody(props: {
  readonly query: UsageSummaryQueryResult;
  readonly metric: UsageMetric;
  readonly days: readonly string[];
  readonly breakdownGroupBy: UsageBreakdownGroupBy;
  readonly onBreakdownGroupByChange: (groupBy: UsageBreakdownGroupBy) => void;
}): ReactNode {
  const { query, metric, days, breakdownGroupBy, onBreakdownGroupByChange } =
    props;

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
  const scale = buildUsageSeriesScaleForBuckets(summary.buckets);
  const columns = buildUsageChartColumns(days, summary.buckets, scale, metric);
  const harnessRows = buildUsageHarnessSplitRows(summary.buckets);
  const statTiles = buildUsageStatTiles(summary.totals, summary.buckets);
  const absentNote = usageCompletenessAbsentNote(
    summary.usageCompletenessBreakdown,
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <UsageCostFigure
          totals={summary.totals}
          coverage={coverage}
          servedBy={servedBy}
          size="default"
        />
        <UsageHarnessSplit rows={harnessRows} scale={scale} />
      </div>
      <div className="flex flex-col gap-1.5">
        <UsageStatTiles tiles={statTiles} />
        {absentNote === null ? null : (
          <p
            className="text-ui-xs text-muted-foreground/80"
            data-testid="usage-stat-tiles-absent-note"
          >
            {absentNote}
          </p>
        )}
      </div>
      <UsageDailyChart columns={columns} scale={scale} metric={metric} />
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-ui-sm font-medium text-foreground">Breakdown</h3>
          <UsageBreakdownToggle
            groupBy={breakdownGroupBy}
            onChange={onBreakdownGroupByChange}
          />
        </div>
        {breakdownGroupBy === "model" ? (
          <UsageBreakdownTable
            rows={buildUsageBreakdownRows(summary.buckets)}
          />
        ) : (
          <UsageDayBreakdownTable
            rows={buildUsageDayBreakdownRows(summary.buckets)}
          />
        )}
      </div>
    </div>
  );
}

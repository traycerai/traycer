import { useMemo, useRef, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { HostRpcRegistry } from "@/lib/host";
import { useUsageImageExport } from "@/hooks/usage-analytics/use-usage-image-export";
import { UsageExportImageActions } from "@/components/usage-analytics/usage-export-image-actions";
import { USAGE_EXPORT_REGION_SELECTOR } from "@/lib/usage-analytics/usage-export-image";
import {
  buildUsageSummaryRequest,
  useUsageSummaryForClient,
  type UsageSummaryResponse,
  type UsageSummaryWindowDays,
} from "@/hooks/usage-analytics/use-usage-summary-query";
import type {
  UsageChartGroupBy,
  UsageMetric,
} from "@/lib/usage-analytics/usage-chart-data";
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
import { USAGE_METRIC_LABELS } from "@/lib/usage-analytics/usage-metric-labels";
import { UsageDailyChart } from "@/components/usage-analytics/usage-daily-chart";
import { UsageBreakdownTable } from "@/components/usage-analytics/usage-breakdown-table";
import { UsageDayBreakdownTable } from "@/components/usage-analytics/usage-day-breakdown-table";
import {
  UsageBreakdownToggle,
  type UsageBreakdownGroupBy,
} from "@/components/usage-analytics/usage-breakdown-toggle";
import { UsageChartGroupByToggle } from "@/components/usage-analytics/usage-chart-groupby-toggle";
import { UsageHarnessSplit } from "@/components/usage-analytics/usage-harness-split";
import { UsageStatTiles } from "@/components/usage-analytics/usage-stat-tiles";
import { UsageCostFigure } from "@/components/usage-analytics/usage-cost-figure";
import { UsageErrorCard } from "@/components/usage-analytics/usage-error-card";
import { UsageHostFilter } from "@/components/usage-analytics/usage-host-filter";
import { UsageHostSplit } from "@/components/usage-analytics/usage-host-split";
import { UsageActivityHeatmap } from "@/components/usage-analytics/usage-activity-heatmap";
import {
  buildUsageActivityCalendar,
  isWindowTooWideError,
  USAGE_ACTIVITY_FALLBACK_WINDOW_DAYS,
  USAGE_ACTIVITY_WINDOW_DAYS,
} from "@/lib/usage-analytics/usage-activity";
import {
  buildUsageHostFilterOptions,
  buildUsageHostSplitRows,
  resolveUsageHostName,
} from "@/lib/usage-analytics/usage-host-split";

export interface UsageSummaryPanelProps {
  readonly client: HostClient<HostRpcRegistry> | null;
  /** An id absent from the map is a host the client cannot name, not an error - see `resolveUsageHostName`. */
  readonly hostNames: ReadonlyMap<string, string>;
  /** The host this panel's client is bound to. */
  readonly currentHostId: string | null;
}

type UsageSummaryQueryResult = UseQueryResult<
  UsageSummaryResponse,
  HostRpcError
>;

const DEFAULT_WINDOW_DAYS: UsageSummaryWindowDays = 30;

/** The Usage page's full body: window picker, cost/token toggle, per-day chart, harness/model breakdown. */
export function UsageSummaryPanel(props: UsageSummaryPanelProps): ReactNode {
  const [windowDays, setWindowDays] =
    useState<UsageSummaryWindowDays>(DEFAULT_WINDOW_DAYS);
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const [breakdownGroupBy, setBreakdownGroupBy] =
    useState<UsageBreakdownGroupBy>("model");
  const [chartGroupBy, setChartGroupBy] =
    useState<UsageChartGroupBy>("harness");
  // Kept in this component rather than in the request memo so switching hosts is a normal query-key change, not
  // a remount.
  const [hostId, setHostId] = useState<string | null>(null);

  const request = useMemo(
    () => buildUsageSummaryRequest({ windowDays, epicId: null, hostId }),
    [windowDays, hostId],
  );
  // The activity heatmap's own fixed-year read (ticket 15).
  const activityRequest = useMemo(
    () =>
      buildUsageSummaryRequest({
        windowDays: USAGE_ACTIVITY_WINDOW_DAYS,
        epicId: null,
        hostId,
      }),
    [hostId],
  );
  // Enabled unconditionally: this panel only mounts once its caller has already confirmed `host.usage.summary`
  // is supported (see `UsageSettingsPanelBody`'s early return).
  const query = useUsageSummaryForClient(props.client, request, true, false);
  const activityQuery = useUsageSummaryForClient(
    props.client,
    activityRequest,
    true,
    false,
  );
  // Only that classified rejection arms this narrower read - a transient failure on the year read must surface
  // as an error, not be quietly replaced by a quarter of the calendar that happened to succeed.
  const activityFallbackRequest = useMemo(
    () =>
      buildUsageSummaryRequest({
        windowDays: USAGE_ACTIVITY_FALLBACK_WINDOW_DAYS,
        epicId: null,
        hostId,
      }),
    [hostId],
  );
  const activityFallbackQuery = useUsageSummaryForClient(
    props.client,
    activityFallbackRequest,
    isWindowTooWideError(activityQuery.error),
    false,
  );
  const days = useMemo(() => daysForResponse(query.data), [query.data]);
  const dateRangeLabel = formatDateRangeLabel(days);

  // The local plane only ever holds this machine's own executions, so there is nothing to filter between there -
  // the control states the scope instead of offering a choice it cannot honor.
  const pinnedToHostName =
    query.data?.servedBy === "local"
      ? localPlaneHostName(props.currentHostId, props.hostNames)
      : null;
  // A host filter picked on the cloud plane is meaningless once the plane becomes local, and worse than
  // meaningless when it names a different host.
  if (pinnedToHostName !== null && hostId !== null) {
    setHostId(null);
  }
  // The activity calendar spans a year while the picker's own read spans 7/30/90 days, so a host that was active
  // months ago - and that the local directory can no longer name.
  const responseHostIds = useMemo(
    () =>
      unionHostIds(
        [
          ...(query.data?.summary.hostBuckets ?? []),
          ...(activityQuery.data?.summary.hostBuckets ?? []),
          // The fallback calendar is a real read too: an old host that rejected the year can still surface a host
          // (active e.g. 60 days ago) that neither the directory nor the 30-day window knows.
          ...(activityFallbackQuery.data?.summary.hostBuckets ?? []),
        ].map((bucket) => bucket.hostId),
      ),
    [query.data, activityQuery.data, activityFallbackQuery.data],
  );
  // The shared aggregator applies the `hostId` filter to the facts before it groups them, so a filtered
  // response's `hostBuckets` holds only the host that was asked for.
  const [discoveredHostIds, setDiscoveredHostIds] = useState<readonly string[]>(
    [],
  );
  if (hostId === null && !sameHostIds(responseHostIds, discoveredHostIds)) {
    setDiscoveredHostIds(responseHostIds);
  }
  const hostOptions = useMemo(
    () =>
      buildUsageHostFilterOptions({
        hostNames: props.hostNames,
        hostIdsWithUsage: [...discoveredHostIds, ...responseHostIds],
        selectedHostId: hostId,
      }),
    [props.hostNames, discoveredHostIds, responseHostIds, hostId],
  );
  // Scoped to this root so a second usage surface can never be captured by mistake.
  const panelRef = useRef<HTMLDivElement | null>(null);
  // The capture region spans the headline through the activity calendar, so "the primary read resolved" is not
  // enough to export.
  const exportReady =
    query.data !== undefined &&
    usageActivityLaneSettled(activityQuery, activityFallbackQuery);
  const { pendingAction, copyImage, shareImage, downloadImage } =
    useUsageImageExport({
      getExportNode: () =>
        panelRef.current?.querySelector<HTMLElement>(
          USAGE_EXPORT_REGION_SELECTOR,
        ) ?? null,
      fileName: `traycer-usage-${String(windowDays)}d.png`,
      heading: "Usage",
      // The metric belongs in the subheading because its toggle sits outside the capture region.
      subheading: `${dateRangeLabel} · ${USAGE_METRIC_LABELS[metric]}`,
      errorSource: "Usage settings",
      analyticsSource: "settings",
    });
  return (
    <div ref={panelRef} className="flex w-full max-w-4xl flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <UsageWindowPicker
            windowDays={windowDays}
            onChange={setWindowDays}
            triggerClassName={undefined}
          />
          <UsageHostFilter
            options={hostOptions}
            hostId={hostId}
            onChange={setHostId}
            pinnedToHostName={pinnedToHostName}
          />
          <span
            className="text-ui-xs text-muted-foreground"
            data-testid="usage-date-range-label"
          >
            {dateRangeLabel}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <UsageMetricToggle metric={metric} onChange={setMetric} />
          <UsageExportImageActions
            exportReady={exportReady}
            pendingAction={pendingAction}
            copyImage={copyImage}
            shareImage={shareImage}
            downloadImage={downloadImage}
            testIdPrefix="usage"
            variant="icon"
            buttonClassName={undefined}
          />
        </div>
      </div>
      <UsageSummaryPanelBody
        query={query}
        activityQuery={activityQuery}
        activityFallbackQuery={activityFallbackQuery}
        metric={metric}
        days={days}
        breakdownGroupBy={breakdownGroupBy}
        onBreakdownGroupByChange={setBreakdownGroupBy}
        chartGroupBy={chartGroupBy}
        onChartGroupByChange={setChartGroupBy}
        hostNames={props.hostNames}
        hostScopeName={
          hostId === null ? null : resolveUsageHostName(hostId, props.hostNames)
        }
      />
    </div>
  );
}

/** Merged host ids from the two reads, sorted so the result is a function of which hosts appeared rather than
 * of which response happened to arrive first. */
function unionHostIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

/** Both lists come from `hostBuckets`, which the wire sorts by `hostId`, so position-wise comparison is enough
 * - and it is only ever asked about a handful of hosts. */
function sameHostIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** A client with no resolved host id yet still has a scope to state - the read is this-machine-only either way
 * - so it falls back to naming the machine generically rather than rendering nothing. */
function localPlaneHostName(
  currentHostId: string | null,
  hostNames: ReadonlyMap<string, string>,
): string {
  if (currentHostId === null) return "This machine";
  return resolveUsageHostName(currentHostId, hostNames);
}

/** The chart's x-axis and the range label beside the window picker, both derived from the response's own window
 * rather than from a client clock. */
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
  /** It stays secondary (its own inline error, never the page's). */
  readonly activityQuery: UsageSummaryQueryResult;
  /** The narrower read that runs only once {@link activityQuery} has failed. */
  readonly activityFallbackQuery: UsageSummaryQueryResult;
  readonly metric: UsageMetric;
  readonly days: readonly string[];
  readonly breakdownGroupBy: UsageBreakdownGroupBy;
  readonly onBreakdownGroupByChange: (groupBy: UsageBreakdownGroupBy) => void;
  readonly chartGroupBy: UsageChartGroupBy;
  readonly onChartGroupByChange: (groupBy: UsageChartGroupBy) => void;
  readonly hostNames: ReadonlyMap<string, string>;
  readonly hostScopeName: string | null;
}): ReactNode {
  const {
    query,
    activityQuery,
    activityFallbackQuery,
    metric,
    days,
    breakdownGroupBy,
    onBreakdownGroupByChange,
    chartGroupBy,
    onChartGroupByChange,
    hostNames,
    hostScopeName,
  } = props;

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
  const scale = buildUsageSeriesScaleForBuckets(summary.buckets, "harness");
  // Same slot palette, different key space - the two sections only share colors when both group by harness.
  const chartScale =
    chartGroupBy === "harness"
      ? scale
      : buildUsageSeriesScaleForBuckets(summary.buckets, "model");
  const columns = buildUsageChartColumns({
    days,
    buckets: summary.buckets,
    scale: chartScale,
    metric,
    groupBy: chartGroupBy,
  });
  const harnessRows = buildUsageHarnessSplitRows(summary.buckets);
  const hostRows = buildUsageHostSplitRows(summary.hostBuckets, hostNames);
  const statTiles = buildUsageStatTiles(summary.totals, summary.buckets);
  const absentNote = usageCompletenessAbsentNote(
    summary.usageCompletenessBreakdown,
  );

  return (
    // `usage-chart-root` carries the series and harness palettes, and it has to sit on the common ancestor rather
    // than on the chart alone.
    <div className="usage-chart-root flex flex-col gap-5">
      {/* The image-export capture region: headline through the activity calendar, deliberately not the breakdown
         tables below - "what did this cost" shares fine, an unbounded table doesn't. */}
      <div
        className="flex flex-col gap-5"
        data-usage-export-region=""
        data-testid="usage-export-region"
      >
        <div className="flex flex-col gap-3">
          <UsageCostFigure
            totals={summary.totals}
            coverage={coverage}
            servedBy={servedBy}
            hostScopeName={hostScopeName}
            size="default"
          />
          <UsageHarnessSplit rows={harnessRows} scale={scale} showTokens />
        </div>
        {/* Only worth a section once there is more than one host to compare. */}
        {hostRows.length > 1 ? (
          <div className="flex flex-col gap-2" data-usage-export-exclude="">
            <h3 className="text-ui-sm font-medium text-foreground">By host</h3>
            <UsageHostSplit rows={hostRows} />
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <UsageStatTiles tiles={statTiles} variant="full" />
          {absentNote === null ? null : (
            <p
              className="text-ui-xs text-muted-foreground/80"
              data-testid="usage-stat-tiles-absent-note"
            >
              {absentNote}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex justify-end">
            <UsageChartGroupByToggle
              groupBy={chartGroupBy}
              onChange={onChartGroupByChange}
              triggerClassName={undefined}
            />
          </div>
          {/* `key` per the prop's contract: the legend's hidden-series state is keyed by the current grouping's series
             keys. */}
          <UsageDailyChart
            key={chartGroupBy}
            columns={columns}
            scale={chartScale}
            metric={metric}
            groupBy={chartGroupBy}
          />
        </div>
        <UsageActivitySection
          query={activityQuery}
          fallbackQuery={activityFallbackQuery}
          metric={metric}
        />
      </div>
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

/** But it must not vanish silently either - the page's Retry only refetches the primary window query, so this
 * section carries its own error card and its own refetch. */
function UsageActivitySection(props: {
  readonly query: UsageSummaryQueryResult;
  readonly fallbackQuery: UsageSummaryQueryResult;
  readonly metric: UsageMetric;
}): ReactNode {
  const { query, fallbackQuery, metric } = props;
  // The fallback query is only ever enabled for that classified rejection (see `isWindowTooWideError`), so its
  // data can't paper over an unrelated year-read failure.
  const data = query.data ?? fallbackQuery.data;
  if (data !== undefined) {
    return (
      <div className="flex flex-col gap-2" data-testid="usage-activity-section">
        <h3 className="text-ui-sm font-medium text-foreground">Activity</h3>
        <UsageActivityHeatmap
          calendar={buildUsageActivityCalendar(
            lastNCalendarDays(
              data.summary.window.windowDays,
              data.summary.window.timezone,
              data.summary.window.endAtExclusive - 1,
            ),
            data.summary.buckets,
            metric,
          )}
          metric={metric}
        />
      </div>
    );
  }
  const displayedError = usageActivityDisplayedError(query, fallbackQuery);
  if (displayedError !== null) {
    return (
      <div className="flex flex-col gap-2" data-testid="usage-activity-section">
        <h3 className="text-ui-sm font-medium text-foreground">Activity</h3>
        <UsageErrorCard
          error={displayedError}
          onRetry={() => {
            void query.refetch();
            void fallbackQuery.refetch();
          }}
        />
      </div>
    );
  }
  return null;
}

/** The year read failed for a reason the fallback does not exist for, or the fallback itself failed too -
 * either way the section owes the reader an explanation and a way back, never a silent gap. */
function usageActivityDisplayedError(
  query: UsageSummaryQueryResult,
  fallbackQuery: UsageSummaryQueryResult,
): HostRpcError | null {
  const error = query.error;
  if (error === null) return null;
  if (isWindowTooWideError(error)) return fallbackQuery.error;
  return error;
}

/** Shared with the export gate rather than restated there: a second notion of "settled" would drift from the
 * branching in UsageActivitySection, and the failure that drift produces is invisible. */
function usageActivityLaneSettled(
  query: UsageSummaryQueryResult,
  fallbackQuery: UsageSummaryQueryResult,
): boolean {
  return (
    (query.data ?? fallbackQuery.data) !== undefined ||
    usageActivityDisplayedError(query, fallbackQuery) !== null
  );
}

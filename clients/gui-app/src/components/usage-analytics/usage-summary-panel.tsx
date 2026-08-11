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
import { UsageHostFilter } from "@/components/usage-analytics/usage-host-filter";
import { UsageHostSplit } from "@/components/usage-analytics/usage-host-split";
import {
  buildUsageHostFilterOptions,
  buildUsageHostSplitRows,
  resolveUsageHostName,
} from "@/lib/usage-analytics/usage-host-split";

export interface UsageSummaryPanelProps {
  readonly client: HostClient<HostRpcRegistry> | null;
  /**
   * `hostId` -> display name for every host this client knows about.
   * Injected rather than read here, so this panel stays placement-agnostic:
   * the host directory is a Settings-shell concern, and the only thing this
   * surface needs from it is a name to put beside an id. An id absent from
   * the map is a host the client cannot name, not an error - see
   * `resolveUsageHostName`.
   */
  readonly hostNames: ReadonlyMap<string, string>;
  /**
   * The host this panel's client is bound to. Names the machine in the
   * pinned filter on `servedBy: "local"`; `null` when the client has no
   * resolved host yet.
   */
  readonly currentHostId: string | null;
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
  // Defaults to "All hosts" - the whole point of ONE dashboard with a host
  // filter rather than a second per-host surface (ticket 13, user ruling
  // 2026-08-10). Kept in this component rather than in the request memo so
  // switching hosts is a normal query-key change, not a remount.
  const [hostId, setHostId] = useState<string | null>(null);

  const request = useMemo(
    () => buildUsageSummaryRequest({ windowDays, epicId: null, hostId }),
    [windowDays, hostId],
  );
  // Enabled unconditionally: this panel only mounts once its caller has
  // already confirmed `host.usage.summary` is supported (see
  // `UsageSettingsPanelBody`'s early return). No polling here - unlike the
  // ambient epic cost badge, this is an actively-viewed screen with its own
  // refetch triggers (window/metric change, manual Retry).
  const query = useUsageSummaryForClient(props.client, request, true, false);
  const days = useMemo(() => daysForResponse(query.data), [query.data]);
  const dateRangeLabel = formatDateRangeLabel(days);

  // The local plane only ever holds this machine's own executions, so there
  // is nothing to filter BETWEEN there - the control states the scope
  // instead of offering a choice it cannot honor. Read off the RESPONSE's
  // `servedBy`, never guessed from connectivity: which plane answers is the
  // host's decision (see the replication-and-read-path artifact).
  const pinnedToHostName =
    query.data?.servedBy === "local"
      ? localPlaneHostName(props.currentHostId, props.hostNames)
      : null;
  // A host filter picked on the cloud plane is meaningless once the plane
  // becomes local, and worse than meaningless when it names a DIFFERENT
  // host: the request contract says a foreign host id matches zero facts
  // there, so the page would claim "This machine only" over an empty summary
  // while the picker had already been replaced by a pinned readout offering
  // no way to clear the stale selection.
  //
  // Adjusted during render (React's documented "reset state when a prop
  // changes" shape) rather than in an effect or by deriving the request:
  // an effect is a cascading-render lint error here, and deriving would
  // OSCILLATE, because the resulting query-key change drops `query.data` to
  // `undefined` mid-refetch, which flips the derivation back to the stale id
  // and flips the key again. A latch settles in one pass.
  if (pinnedToHostName !== null && hostId !== null) {
    setHostId(null);
  }
  const responseHostIds = useMemo(
    () =>
      (query.data?.summary.hostBuckets ?? []).map((bucket) => bucket.hostId),
    [query.data],
  );
  // Host ids learned from the last UNFILTERED response.
  //
  // The shared aggregator applies the `hostId` filter to the FACTS before it
  // groups them, so a filtered response's `hostBuckets` holds only the host
  // that was asked for. Rebuilding the picker from the current response alone
  // therefore collapsed it the moment a host was chosen: every other host the
  // account has usage for but the directory cannot name vanished from the
  // list, and reaching one of them meant going back to All hosts and waiting
  // for a second round trip. Only an unfiltered response is evidence about
  // hosts OTHER than the selected one, so only that one updates this.
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

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <UsageWindowPicker windowDays={windowDays} onChange={setWindowDays} />
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
        <UsageMetricToggle metric={metric} onChange={setMetric} />
      </div>
      <UsageSummaryPanelBody
        query={query}
        metric={metric}
        days={days}
        breakdownGroupBy={breakdownGroupBy}
        onBreakdownGroupByChange={setBreakdownGroupBy}
        hostNames={props.hostNames}
        hostScopeName={
          hostId === null ? null : resolveUsageHostName(hostId, props.hostNames)
        }
      />
    </div>
  );
}

/**
 * Both lists come from `hostBuckets`, which the wire sorts by `hostId`, so
 * position-wise comparison is enough - and it is only ever asked about a
 * handful of hosts.
 */
function sameHostIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * What the pinned filter calls the machine on `servedBy: "local"`. A client
 * with no resolved host id yet still has a scope to state - the read is
 * this-machine-only either way - so it falls back to naming the machine
 * generically rather than rendering nothing.
 */
function localPlaneHostName(
  currentHostId: string | null,
  hostNames: ReadonlyMap<string, string>,
): string {
  if (currentHostId === null) return "This machine";
  return resolveUsageHostName(currentHostId, hostNames);
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
  readonly hostNames: ReadonlyMap<string, string>;
  /** The picked host's display name, or `null` for the All-hosts default. */
  readonly hostScopeName: string | null;
}): ReactNode {
  const {
    query,
    metric,
    days,
    breakdownGroupBy,
    onBreakdownGroupByChange,
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
  const scale = buildUsageSeriesScaleForBuckets(summary.buckets);
  const columns = buildUsageChartColumns(days, summary.buckets, scale, metric);
  const harnessRows = buildUsageHarnessSplitRows(summary.buckets);
  const hostRows = buildUsageHostSplitRows(summary.hostBuckets, hostNames);
  const statTiles = buildUsageStatTiles(summary.totals, summary.buckets);
  const absentNote = usageCompletenessAbsentNote(
    summary.usageCompletenessBreakdown,
  );

  return (
    // `usage-chart-root` carries the `--usage-series-*` palette, and it has
    // to sit on the common ancestor rather than on the chart alone:
    // `UsageHarnessSplit` is the chart's SIBLING here and colors its dots and
    // bars from the same scale, so while the scope lived only on
    // `UsageDailyChart` those `var(--usage-series-N)` reads resolved against
    // nothing and the split rendered colorless. `UsageDailyChart` keeps its
    // own copy of the class for the epic dialog, where it stands alone.
    <div className="usage-chart-root flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <UsageCostFigure
          totals={summary.totals}
          coverage={coverage}
          servedBy={servedBy}
          hostScopeName={hostScopeName}
          size="default"
        />
        <UsageHarnessSplit rows={harnessRows} scale={scale} />
      </div>
      {/* Only worth a section once there is more than one host to compare:
          a single-row "By host" list under an All-hosts filter says nothing
          the filter did not already say, and on the local plane there can
          never be a second row at all. */}
      {hostRows.length > 1 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-ui-sm font-medium text-foreground">By host</h3>
          <UsageHostSplit rows={hostRows} />
        </div>
      ) : null}
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

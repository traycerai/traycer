import { useMemo, useRef, useState, type ReactNode } from "react";
import { Copy, Download } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { HostRpcRegistry } from "@/lib/host";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import { useUsageImageExport } from "@/hooks/usage-analytics/use-usage-image-export";
import {
  buildUsageSummaryRequest,
  useUsageSummaryForClient,
  type UsageSummaryResponse,
  type UsageSummaryWindowDays,
} from "@/hooks/usage-analytics/use-usage-summary-query";
import { lastNCalendarDays } from "@/lib/usage-analytics/day-window";
import {
  buildUsageChartColumns,
  buildUsageSeriesScaleForBuckets,
  type UsageChartGroupBy,
} from "@/lib/usage-analytics/usage-chart-data";
import { buildUsageHarnessSplitRows } from "@/lib/usage-analytics/usage-harness-split";
import {
  buildUsageStatTiles,
  usageCompletenessAbsentNote,
} from "@/lib/usage-analytics/usage-stat-tiles";
import {
  servedByScopeNote,
  type UsageServedBy,
} from "@/lib/usage-analytics/cost-format";
import { formatDateRangeLabel } from "@/lib/usage-analytics/format-metric-value";
import { USAGE_EXPORT_REGION_SELECTOR } from "@/lib/usage-analytics/usage-export-image";
import { cn } from "@/lib/utils";
import { UsageCostFigure } from "@/components/usage-analytics/usage-cost-figure";
import { UsageChartGroupByToggle } from "@/components/usage-analytics/usage-chart-groupby-toggle";
import { UsageDailyChart } from "@/components/usage-analytics/usage-daily-chart";
import { UsageChatBreakdown } from "@/components/usage-analytics/usage-chat-breakdown";
import { UsageHarnessSplit } from "@/components/usage-analytics/usage-harness-split";
import { UsageStatTiles } from "@/components/usage-analytics/usage-stat-tiles";
import { UsageWindowPicker } from "@/components/usage-analytics/usage-window-picker";
import {
  UsageDialogFrame,
  USAGE_DIALOG_SHEET_CLASSES,
} from "@/components/usage-analytics/usage-dialog-frame";
import {
  UsageDialogEmpty,
  UsageDialogErrorState,
  UsageDialogSkeleton,
  UsageDialogUnavailable,
} from "@/components/usage-analytics/usage-dialog-states";

export interface EpicUsageDialogProps {
  readonly epicId: string;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

type UsageSummaryQueryResult = UseQueryResult<
  UsageSummaryResponse,
  HostRpcError
>;

const DEFAULT_WINDOW_DAYS: UsageSummaryWindowDays = 7;

// >=44px touch targets on coarse pointers without growing the tabs list's
// hardcoded h-8: an invisible overlay extends each trigger's vertical hit
// area (the trigger is already `relative`; `after:` is taken by the
// line-variant indicator, so this rides `before:`).
const COARSE_POINTER_TRIGGER =
  "pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-2.5";

/**
 * The scoped epic panel ticket 12 replaces the ambient cost badge with:
 * headline (`UsageCostFigure`), harness split, curated stat tiles, a
 * per-day trend chart, and a by-chat/agent breakdown, with window options
 * 7/30/90 - variant B of the usage-dialog redesign (48rem mini-dashboard
 * in a fixed frame; states swap inside it, never resize it). Cost is
 * on-demand by construction - the query is only `enabled` while the dialog
 * is open, so there is nothing ambient left to silently revert (fixup-01's
 * failure mode). `poll: false` matches every other actively-viewed usage
 * surface (Settings' `UsageSummaryPanel`).
 */
export function EpicUsageDialog(props: EpicUsageDialogProps): ReactNode {
  const { epicId, client, open, onOpenChange } = props;
  const [windowDays, setWindowDays] =
    useState<UsageSummaryWindowDays>(DEFAULT_WINDOW_DAYS);
  // Held here rather than in the body: Radix unmounts `DialogContent` - and
  // with it the body - while the dialog is closed, so a grouping picked
  // there would silently reset on every reopen. This component outlives
  // that (it lives as long as its `EpicShell`), which is the same reason
  // the window selection above it is held here.
  const [chartGroupBy, setChartGroupBy] =
    useState<UsageChartGroupBy>("harness");
  const request = useMemo(
    () =>
      buildUsageSummaryRequest({
        windowDays,
        epicId,
      }),
    [epicId, windowDays],
  );
  const query = useUsageSummaryForClient(client, request, open, false);
  const { openSettings } = useSystemTabModalActions();
  // The capture region is found by data attribute under this dialog's own
  // content node at click time, not held as a threaded RefObject - the
  // React Compiler's ref rules reject a ref object travelling through
  // props, and an event-time DOM query needs no render-time ref reads.
  // Scoping the query to this content node (rather than `document`) keeps
  // it correct if another usage surface ever grows its own export region.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const exportReady =
    query.data !== undefined && query.data.summary.totals.factCount > 0;
  const { mutation, copyImage, downloadImage } = useUsageImageExport({
    getExportNode: () =>
      contentRef.current?.querySelector<HTMLElement>(
        USAGE_EXPORT_REGION_SELECTOR,
      ) ?? null,
    fileName: `traycer-usage-${String(windowDays)}d.png`,
    heading: "Usage",
    subheading: "Cost and token usage for this task.",
    errorSource: "Epic usage dialog",
    analyticsSource: "epic_dialog",
  });
  // One export runs at a time, so BOTH buttons go disabled while either is
  // pending; only the button that started it shows the spinner, which is
  // what the variables discriminate.
  const isExporting = mutation.isPending;
  const isCopying = isExporting && mutation.variables.action === "copy";
  const isDownloading = isExporting && mutation.variables.action === "download";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        // Fixed `h` - not `max-h` - is the no-jump fix: every state renders
        // into the same frame. `sm:max-w-3xl` overrides the primitive's
        // `sm:max-w-sm` cap (load-bearing, same reason the earlier shape
        // carried `sm:max-w-lg`).
        className={cn(
          "flex h-[min(88dvh,46rem)] w-[min(92vw,48rem)] min-w-0 flex-col gap-4 overflow-hidden sm:max-w-3xl",
          USAGE_DIALOG_SHEET_CLASSES,
          "max-[28rem]:h-[94dvh]",
        )}
        data-testid="epic-usage-dialog"
      >
        <UsageDialogFrame
          title="Usage"
          description="Cost and token usage for this task."
          headerControls={
            <UsageWindowPicker
              windowDays={windowDays}
              onChange={setWindowDays}
              triggerClassName={COARSE_POINTER_TRIGGER}
            />
          }
          footer={
            <>
              {/* `sm:mr-auto` splits the band: export actions lead, the
                  Settings hand-off keeps the trailing primary slot. On the
                  sheet tier the footer column-reverses, so this group
                  stacks below it, full width like its sibling. */}
              <div className="flex gap-2 max-[28rem]:flex-col sm:mr-auto">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="max-[28rem]:w-full"
                  data-testid="epic-usage-copy-image"
                  disabled={!exportReady || isExporting}
                  onClick={copyImage}
                >
                  {isCopying ? (
                    <AgentSpinningDots
                      className="size-3"
                      testId={undefined}
                      variant={undefined}
                    />
                  ) : (
                    <Copy aria-hidden />
                  )}
                  Copy image
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="max-[28rem]:w-full"
                  data-testid="epic-usage-download-image"
                  disabled={!exportReady || isExporting}
                  onClick={downloadImage}
                >
                  {isDownloading ? (
                    <AgentSpinningDots
                      className="size-3"
                      testId={undefined}
                      variant={undefined}
                    />
                  ) : (
                    <Download aria-hidden />
                  )}
                  Download image
                </Button>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="max-[28rem]:w-full"
                data-testid="epic-usage-view-full-dashboard"
                onClick={() => {
                  onOpenChange(false);
                  openSettings({ section: "usage", resetToGeneral: false });
                }}
              >
                View full usage →
              </Button>
            </>
          }
        >
          <EpicUsageDialogBody
            query={query}
            windowDays={windowDays}
            onWindowDaysChange={setWindowDays}
            chartGroupBy={chartGroupBy}
            onChartGroupByChange={setChartGroupBy}
          />
        </UsageDialogFrame>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One state switch, in routing order; every branch renders into the
 * frame's body slot while the frame (header, picker, footer) stays
 * constant around it.
 */
function EpicUsageDialogBody(props: {
  readonly query: UsageSummaryQueryResult;
  readonly windowDays: UsageSummaryWindowDays;
  readonly onWindowDaysChange: (windowDays: UsageSummaryWindowDays) => void;
  readonly chartGroupBy: UsageChartGroupBy;
  readonly onChartGroupByChange: (groupBy: UsageChartGroupBy) => void;
}): ReactNode {
  const { query } = props;

  if (query.isLoading) return <UsageDialogSkeleton variant="epic" />;
  if (query.error !== null) {
    return (
      <UsageDialogErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  if (query.data === undefined) return <UsageDialogUnavailable />;
  // The empty routing owns "nothing in this window" entirely: the loaded
  // layout below can assume facts exist, which is also why the group-by
  // toggle no longer needs a factCount guard of its own - a control with
  // nothing to regroup is unreachable from the loaded branch.
  if (query.data.summary.totals.factCount === 0) {
    return (
      <EpicUsageEmptyState
        windowDays={props.windowDays}
        onWindowDaysChange={props.onWindowDaysChange}
        servedBy={query.data.servedBy}
      />
    );
  }
  return (
    <EpicUsageLoadedBody
      data={query.data}
      chartGroupBy={props.chartGroupBy}
      onChartGroupByChange={props.onChartGroupByChange}
    />
  );
}

/**
 * Wider windows only: a chip that re-requests the CURRENT window would be
 * a broken control, so a 90-day empty offers none. (365 exists on the wire
 * for the activity heatmap and is never a picker state here.)
 */
function widerWindows(
  windowDays: UsageSummaryWindowDays,
): readonly UsageSummaryWindowDays[] {
  if (windowDays === 7) return [30, 90];
  if (windowDays === 30) return [90];
  return [];
}

function EpicUsageEmptyState(props: {
  readonly windowDays: UsageSummaryWindowDays;
  readonly onWindowDaysChange: (windowDays: UsageSummaryWindowDays) => void;
  readonly servedBy: UsageServedBy;
}): ReactNode {
  const wider = widerWindows(props.windowDays);
  return (
    <UsageDialogEmpty
      headline={`No usage in the last ${String(props.windowDays)} days`}
      hint="Chats and agents in this epic haven't recorded usage in this window."
      // A local-plane read only speaks for THIS machine, so an unqualified
      // "no usage" would overclaim - the same note `UsageCostFigure` carries
      // on the loaded branch (`hostScopeName` null for the reason below).
      note={servedByScopeNote(props.servedBy, null)}
    >
      {wider.length === 0 ? null : (
        <div className="flex flex-wrap justify-center gap-2">
          {wider.map((days) => (
            <Button
              key={days}
              type="button"
              variant="outline"
              size="sm"
              data-testid={`usage-empty-window-${String(days)}`}
              onClick={() => {
                props.onWindowDaysChange(days);
              }}
            >
              Show {days} days
            </Button>
          ))}
        </div>
      )}
    </UsageDialogEmpty>
  );
}

function EpicUsageLoadedBody(props: {
  readonly data: UsageSummaryResponse;
  readonly chartGroupBy: UsageChartGroupBy;
  readonly onChartGroupByChange: (groupBy: UsageChartGroupBy) => void;
}): ReactNode {
  const { chartGroupBy } = props;
  const { summary, coverage, servedBy } = props.data;
  const days = daysForSummaryWindow(summary);
  // Two scales, the Settings dashboard's shape: the harness split beside
  // the headline always stacks by harness, so it keeps a harness-keyed
  // scale regardless of what the chart shows, and the chart shares it only
  // while it groups by harness. A single `chartGroupBy`-keyed scale was
  // the earlier shape here, and it grayed every split row the moment the
  // chart regrouped by model - `colorVar` falls back to the "Other" token
  // for keys outside its space.
  const scale = buildUsageSeriesScaleForBuckets(summary.buckets, "harness");
  const chartScale =
    chartGroupBy === "harness"
      ? scale
      : buildUsageSeriesScaleForBuckets(summary.buckets, "model");
  const columns = buildUsageChartColumns({
    days,
    buckets: summary.buckets,
    scale: chartScale,
    metric: "cost",
    groupBy: chartGroupBy,
  });
  const harnessRows = buildUsageHarnessSplitRows(summary.buckets);
  const statTiles = buildUsageStatTiles(summary.totals, summary.buckets);
  // Travels with the tiles wherever they render, per the note's own
  // contract: turns that reported no usage at all still add a silent zero to
  // every token sum in them, so unqualified tiles read as "this work used no
  // cache" rather than "this work reported nothing". Settings pairs the two
  // the same way - this dialog only needs it because it now shows tiles.
  const absentNote = usageCompletenessAbsentNote(
    summary.usageCompletenessBreakdown,
  );
  const dateRangeLabel = formatDateRangeLabel(days);

  return (
    // `usage-chart-root` scopes the series and harness palettes over BOTH
    // consumers - the chart and its sibling harness split - the same
    // reason Settings hangs it on their common ancestor.
    <div className="usage-chart-root flex flex-col gap-5">
      {/* The image-export capture region: summary hero + trend chart, and
          deliberately not the by-chat table below - "what did this cost"
          shares fine, an unbounded row list doesn't. Inside
          `usage-chart-root` so the chart's `var(...)` palette resolves in
          the capture's computed styles. */}
      <div
        className="flex flex-col gap-5"
        data-usage-export-region=""
        data-testid="epic-usage-export-region"
      >
        <div
          className="grid grid-cols-1 gap-4 @min-[40rem]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]"
          data-testid="epic-usage-hero"
        >
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <UsageCostFigure
                totals={summary.totals}
                coverage={coverage}
                servedBy={servedBy}
                // The host dimension is irrelevant at this scope: an epic's
                // (or a chat's) work is the same work wherever it ran.
                hostScopeName={null}
                size="display"
              />
              <span
                className="text-ui-xs text-muted-foreground"
                data-testid="usage-date-range-label"
              >
                {dateRangeLabel}
              </span>
            </div>
            <UsageHarnessSplit
              rows={harnessRows}
              scale={scale}
              showTokens={false}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <UsageStatTiles tiles={statTiles} variant="curated" />
            {absentNote === null ? null : (
              <p
                className="text-ui-xs text-muted-foreground/80"
                data-testid="usage-stat-tiles-absent-note"
              >
                {absentNote}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-ui-sm font-medium text-foreground">
              Daily cost
            </h3>
            <UsageChartGroupByToggle
              groupBy={chartGroupBy}
              onChange={props.onChartGroupByChange}
              triggerClassName={COARSE_POINTER_TRIGGER}
            />
          </div>
          {/* `key` per the prop's contract: the legend's hidden-series set is
            keyed by the current grouping's series keys, so a switch
            remounts rather than letting stale harness keys filter model
            bands. */}
          <UsageDailyChart
            key={chartGroupBy}
            columns={columns}
            scale={chartScale}
            metric="cost"
            groupBy={chartGroupBy}
          />
        </div>
      </div>
      <div>
        <h3 className="mb-2 text-ui-sm font-medium text-foreground">
          By chat / agent
        </h3>
        <UsageChatBreakdown rows={summary.chatBuckets} />
      </div>
    </div>
  );
}

/**
 * The trend chart's x-axis, anchored on the RESPONSE's own window rather
 * than on any client clock.
 *
 * `endAtExclusive` is the first instant OUTSIDE the window, so
 * `endAtExclusive - 1` is the last instant it includes, which is the day
 * the axis must end on. A fixed window ends at local midnight tomorrow, so
 * `- 1` lands on "today so far".
 *
 * Anchoring on a client `Date.now()` sampled at mount was the earlier
 * shape, and this dialog is mounted for as long as its `EpicShell` lives
 * while staying closed - so opening it after a local midnight built columns
 * ending on the previous day and dropped the newest buckets the query had
 * just returned.
 *
 * Only called from the loaded branch, where the empty routing has already
 * guaranteed facts exist.
 */
function daysForSummaryWindow(
  summary: UsageSummaryResponse["summary"],
): readonly string[] {
  return lastNCalendarDays(
    summary.window.windowDays,
    summary.window.timezone,
    summary.window.endAtExclusive - 1,
  );
}

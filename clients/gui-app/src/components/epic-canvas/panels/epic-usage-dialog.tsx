import { useMemo, useState, type ReactNode } from "react";
import { LineChart } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { HostRpcRegistry } from "@/lib/host";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
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
} from "@/lib/usage-analytics/usage-chart-data";
import { UsageCostFigure } from "@/components/usage-analytics/usage-cost-figure";
import { UsageDailyChart } from "@/components/usage-analytics/usage-daily-chart";
import { UsageErrorCard } from "@/components/usage-analytics/usage-error-card";
import { UsageChatBreakdown } from "@/components/usage-analytics/usage-chat-breakdown";
import { UsageWindowPicker } from "@/components/usage-analytics/usage-window-picker";

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

/**
 * The scoped epic panel ticket 12 replaces the ambient cost badge with:
 * headline (`UsageCostFigure`, reused unmodified), a small per-day trend
 * chart, and a by-chat/agent breakdown, with window options 7/30/90. Cost is
 * on-demand by construction - the query is only
 * `enabled` while the dialog is open, so there is nothing ambient left to
 * silently revert (fixup-01's failure mode). `poll: false` matches every
 * other actively-viewed usage surface (Settings' `UsageSummaryPanel`).
 */
export function EpicUsageDialog(props: EpicUsageDialogProps): ReactNode {
  const { epicId, client, open, onOpenChange } = props;
  const [windowDays, setWindowDays] =
    useState<UsageSummaryWindowDays>(DEFAULT_WINDOW_DAYS);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(90dvh,38rem)] w-[min(92vw,32rem)] min-w-0 flex-col gap-4 overflow-hidden sm:max-w-lg"
        data-testid="epic-usage-dialog"
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15">
            <LineChart className="size-4" aria-hidden />
          </div>
          <div className="min-h-0 min-w-0 flex-1 space-y-1">
            <DialogTitle className="text-ui font-semibold leading-snug">
              Usage
            </DialogTitle>
            <DialogDescription>
              Cost and token usage for this epic.
            </DialogDescription>
          </div>
        </div>
        <UsageWindowPicker windowDays={windowDays} onChange={setWindowDays} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EpicUsageDialogBody query={query} />
        </div>
        <DialogFooter className="-mx-4 -mb-4 mt-0 border-t bg-muted/50 px-4 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="epic-usage-view-full-dashboard"
            onClick={() => {
              onOpenChange(false);
              openSettings({ section: "usage", resetToGeneral: false });
            }}
          >
            View full usage →
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EpicUsageDialogBody(props: {
  readonly query: UsageSummaryQueryResult;
}): ReactNode {
  const { query } = props;

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-ui-sm text-muted-foreground">
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
      <p className="py-6 text-ui-sm text-muted-foreground">
        Usage data unavailable.
      </p>
    );
  }

  const { summary, coverage, servedBy } = query.data;
  const days = daysForSummaryWindow(summary);
  const scale = buildUsageSeriesScaleForBuckets(summary.buckets, "harness");
  const columns = buildUsageChartColumns({
    days,
    buckets: summary.buckets,
    scale,
    metric: "cost",
    groupBy: "harness",
  });

  return (
    <div className="flex flex-col gap-4">
      <UsageCostFigure
        totals={summary.totals}
        coverage={coverage}
        servedBy={servedBy}
        // The host dimension is irrelevant at this scope: an epic's (or a
        // chat's) work is the same work wherever it ran.
        hostScopeName={null}
        size="default"
      />
      {summary.totals.factCount === 0 ? null : (
        <UsageDailyChart
          columns={columns}
          scale={scale}
          metric="cost"
          groupBy="harness"
        />
      )}
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
 */
function daysForSummaryWindow(
  summary: UsageSummaryResponse["summary"],
): readonly string[] {
  if (summary.totals.factCount === 0) return [];
  return lastNCalendarDays(
    summary.window.windowDays,
    summary.window.timezone,
    summary.window.endAtExclusive - 1,
  );
}

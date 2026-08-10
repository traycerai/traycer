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
import {
  EpicUsageWindowPicker,
  type EpicUsageWindow,
} from "@/components/usage-analytics/epic-usage-window-picker";

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

const DEFAULT_WINDOW_DAYS: UsageSummaryWindowDays = 30;
const DEFAULT_WINDOW: EpicUsageWindow = DEFAULT_WINDOW_DAYS;

/**
 * The scoped epic panel ticket 12 replaces the ambient cost badge with:
 * headline (`UsageCostFigure`, reused unmodified), a small per-day trend
 * chart, and a by-chat/agent breakdown, with window options 7/30/90 plus
 * "entire epic". Cost is on-demand by construction - the query is only
 * `enabled` while the dialog is open, so there is nothing ambient left to
 * silently revert (fixup-01's failure mode). `poll: false` matches every
 * other actively-viewed usage surface (Settings' `UsageSummaryPanel`).
 */
export function EpicUsageDialog(props: EpicUsageDialogProps): ReactNode {
  const { epicId, client, open, onOpenChange } = props;
  const [windowValue, setWindowValue] =
    useState<EpicUsageWindow>(DEFAULT_WINDOW);
  const [nowMs] = useState(() => Date.now());
  const request = useMemo(
    () =>
      buildUsageSummaryRequest({
        // The request schema requires `windowDays` unconditionally even for
        // `window: "epic"` - the host ignores it for that window kind.
        windowDays: windowValue === "epic" ? DEFAULT_WINDOW_DAYS : windowValue,
        epicId,
        window: windowValue === "epic" ? "epic" : undefined,
      }),
    [epicId, windowValue],
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
        <EpicUsageWindowPicker value={windowValue} onChange={setWindowValue} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EpicUsageDialogBody
            query={query}
            nowMs={nowMs}
            isEpicWindow={windowValue === "epic"}
          />
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
  readonly nowMs: number;
  readonly isEpicWindow: boolean;
}): ReactNode {
  const { query, nowMs, isEpicWindow } = props;

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
  const days = daysForSummaryWindow(summary, nowMs, isEpicWindow);
  const scale = buildUsageSeriesScaleForBuckets(summary.buckets);
  const columns = buildUsageChartColumns(days, summary.buckets, scale, "cost");

  return (
    <div className="flex flex-col gap-4">
      <UsageCostFigure
        totals={summary.totals}
        coverage={coverage}
        servedBy={servedBy}
        size="default"
      />
      {summary.totals.factCount === 0 ? null : (
        <UsageDailyChart columns={columns} scale={scale} metric="cost" />
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
 * The trend chart's x-axis. Fixed windows use the viewer's last N calendar
 * days ending "now" (the same anchor `UsageSummaryPanel` uses). `window:
 * "epic"` instead spans the epic's own fact bounds - `resolveUsage
 * SummaryEpicWindowBounds` (packages/common) stamps `window.windowDays` as
 * the RESOLVED calendar-day width of that span and `window.endAtExclusive`
 * as its own end (host time, not the viewer's `nowMs`), so anchoring there
 * instead of `nowMs` is what keeps the trend chart's last column truthful
 * for a long-lived epic rather than reading as "today" when the epic's last
 * fact was days ago.
 */
function daysForSummaryWindow(
  summary: UsageSummaryResponse["summary"],
  nowMs: number,
  isEpicWindow: boolean,
): readonly string[] {
  if (summary.totals.factCount === 0) return [];
  const tz = summary.window.timezone;
  if (isEpicWindow) {
    return lastNCalendarDays(
      summary.window.windowDays,
      tz,
      summary.window.endAtExclusive,
    );
  }
  return lastNCalendarDays(summary.window.windowDays, tz, nowMs);
}

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, LineChart } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import {
  buildUsageSummaryRequest,
  useUsageSummaryForClient,
  type UsageSummaryResponse,
} from "@/hooks/usage-analytics/use-usage-summary-query";
import { UsageCostFigure } from "@/components/usage-analytics/usage-cost-figure";
import { UsageErrorCard } from "@/components/usage-analytics/usage-error-card";
import { UsageTurnDrilldown } from "@/components/usage-analytics/usage-turn-drilldown";
import {
  useChatUsageDialogStore,
  type ChatUsageDialogTarget,
} from "@/stores/chats/chat-usage-dialog-store";
import { cn } from "@/lib/utils";

type UsageSummaryQueryResult = UseQueryResult<
  UsageSummaryResponse,
  HostRpcError
>;

const FILLER_WINDOW_DAYS = 30;

/**
 * Ticket 12's chat cost line: mounted ONCE (not per-tab), driven by
 * `useChatUsageDialogStore` - the tab strip's "Usage" context-menu item
 * writes a target there instead of threading dialog-open state through the
 * strip's own already-large prop chain. Always the chat's FULL lifetime
 * (`window: "epic"` bounded by `chatId`, per the wire's own naming for "the
 * epic/chat's own fact span") - a chat's cost line is "how much has this
 * chat cost", not a rolling window, so there is no window picker here.
 */
export function ChatUsageDialog(): ReactNode {
  const target = useChatUsageDialogStore((s) => s.target);
  const close = useChatUsageDialogStore((s) => s.close);
  const client = useHostClientForHostId(target?.hostId ?? null);
  // A stable, harmless placeholder request while `target` is null - never
  // actually sent, since `enabled` (below) is `false` in that state; this
  // just keeps `useUsageSummaryForClient` fed a real request object
  // unconditionally, matching every other call site's "real args, gate
  // through `enabled`" shape rather than nulling an argument.
  const request = useMemo(
    () =>
      buildUsageSummaryRequest({
        windowDays: FILLER_WINDOW_DAYS,
        epicId: null,
        chatId: target?.chatId ?? null,
        window: target === null ? undefined : "epic",
      }),
    [target],
  );
  const query = useUsageSummaryForClient(
    client,
    request,
    target !== null,
    false,
  );

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="flex max-h-[min(90dvh,38rem)] w-[min(92vw,32rem)] min-w-0 flex-col gap-4 overflow-hidden sm:max-w-lg"
        data-testid="chat-usage-dialog"
      >
        {target === null ? null : (
          <ChatUsageDialogBody target={target} query={query} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChatUsageDialogBody(props: {
  readonly target: ChatUsageDialogTarget;
  readonly query: UsageSummaryQueryResult;
}): ReactNode {
  const { target, query } = props;
  const [drilldownOpen, setDrilldownOpen] = useState(false);

  return (
    <>
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15">
          <LineChart className="size-4" aria-hidden />
        </div>
        <div className="min-h-0 min-w-0 flex-1 space-y-1">
          <DialogTitle className="truncate text-ui font-semibold leading-snug wrap-anywhere">
            Usage — {target.chatTitle}
          </DialogTitle>
          <DialogDescription>
            Cost and token usage for this chat's full history.
          </DialogDescription>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ChatUsageDialogContent
          query={query}
          drilldownOpen={drilldownOpen}
          onDrilldownOpenChange={setDrilldownOpen}
        />
      </div>
    </>
  );
}

function ChatUsageDialogContent(props: {
  readonly query: UsageSummaryQueryResult;
  readonly drilldownOpen: boolean;
  readonly onDrilldownOpenChange: (open: boolean) => void;
}): ReactNode {
  const { query, drilldownOpen, onDrilldownOpenChange } = props;

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
  // Gate on the array the drilldown actually renders, not on `factCount`:
  // `turnRows` is nullable on the wire, so a host that answers with facts
  // but no per-turn rows would otherwise offer a "Show 0 turns" toggle onto
  // an empty body.
  const turnRows = summary.turnRows ?? [];
  const hasTurnRows = turnRows.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <UsageCostFigure
        totals={summary.totals}
        coverage={coverage}
        servedBy={servedBy}
        // The host dimension is irrelevant at this scope: an epic's (or a
        // chat's) work is the same work wherever it ran.
        hostScopeName={null}
        size="default"
      />
      {hasTurnRows ? (
        <Collapsible open={drilldownOpen} onOpenChange={onDrilldownOpenChange}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-fit gap-1.5 px-2"
              data-testid="chat-usage-drilldown-toggle"
            >
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform",
                  drilldownOpen && "rotate-180",
                )}
              />
              {drilldownOpen ? "Hide" : "Show"} {turnRows.length} turn
              {turnRows.length === 1 ? "" : "s"}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <UsageTurnDrilldown
              rows={turnRows}
              truncated={summary.turnRowsTruncated}
            />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

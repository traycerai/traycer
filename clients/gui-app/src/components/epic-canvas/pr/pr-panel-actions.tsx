import { useCallback, type ReactNode } from "react";
import { ListFilter } from "lucide-react";
import { RefreshIcon } from "@/components/refresh-icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PrSourceNoticeHint } from "@/components/epic-canvas/pr/pr-source-notice";
import type { PrListSubscriptionResult } from "@/hooks/pr/use-pr-list-subscription";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import {
  PR_STATE_FILTERS,
  usePrPanelStore,
  type PrStateFilter,
} from "@/stores/epics/pr-panel-store";

const PR_REFRESH_TIMEOUT_MS = 10_000;

/** Actions share the body's canvas-host subscription on desktop and mobile. */
export function PrPanelActions(props: {
  readonly subscription: PrListSubscriptionResult;
  readonly enabled: boolean;
}): ReactNode {
  const { subscription, enabled } = props;
  const notice = subscription.data?.notice ?? null;

  const onRefresh = useCallback((): Promise<void> => {
    subscription.sendRefresh();
    return Promise.resolve();
  }, [subscription]);

  const refresh = useRefreshSpinner({
    onRefresh,
    externalRefreshing: false,
    timeoutMs: PR_REFRESH_TIMEOUT_MS,
  });

  return (
    <div
      className="flex min-w-0 items-center gap-1"
      data-testid="pr-panel-actions"
    >
      {notice === null ? null : (
        <PrSourceNoticeHint subject="pull-requests" notice={notice} />
      )}
      <PrStateFilterMenu />
      <Button
        type="button"
        variant="muted"
        size="icon-sm"
        onClick={refresh.trigger}
        aria-label="Refresh pull requests"
        disabled={!enabled || refresh.refreshing}
        data-testid="pr-panel-refresh"
      >
        <RefreshIcon refreshing={refresh.refreshing} />
      </Button>
    </div>
  );
}

const PR_STATE_FILTER_LABELS: Readonly<Record<PrStateFilter, string>> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
  all: "All",
};

/**
 * Names the listed state on the trigger itself, so the header says what the
 * list holds while the menu is shut.
 */
function PrStateFilterMenu(): ReactNode {
  const stateFilter = usePrPanelStore((state) => state.stateFilter);
  const setStateFilter = usePrPanelStore((state) => state.setStateFilter);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="muted"
          size="sm"
          data-testid="pr-panel-state-filter"
        >
          <ListFilter data-icon="inline-start" aria-hidden />
          {PR_STATE_FILTER_LABELS[stateFilter]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={stateFilter}
          onValueChange={(value) => {
            const next = PR_STATE_FILTERS.find((filter) => filter === value);
            if (next !== undefined) setStateFilter(next);
          }}
        >
          {PR_STATE_FILTERS.map((filter) => (
            <DropdownMenuRadioItem key={filter} value={filter}>
              {PR_STATE_FILTER_LABELS[filter]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

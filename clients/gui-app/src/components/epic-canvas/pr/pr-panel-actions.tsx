import { useCallback, type ReactNode } from "react";
import { RefreshIcon } from "@/components/refresh-icon";
import { Button } from "@/components/ui/button";
import { PrSourceNoticeHint } from "@/components/epic-canvas/pr/pr-source-notice";
import type { PrListSubscriptionResult } from "@/hooks/pr/use-pr-list-subscription";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";

const PR_REFRESH_TIMEOUT_MS = 10_000;

/** Actions share the body's selected-host subscription on desktop and mobile. */
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

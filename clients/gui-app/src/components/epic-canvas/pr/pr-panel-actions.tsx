import { useCallback, type ReactNode } from "react";
import { RefreshIcon } from "@/components/refresh-icon";
import { Button } from "@/components/ui/button";
import { PrSourceNoticeHint } from "@/components/epic-canvas/pr/pr-source-notice";
import type { PrListSubscriptionResult } from "@/hooks/pr/use-pr-list-subscription";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { newestObservedAt } from "@/lib/pr/pr-list-projection";
import { useRelativeTimestamp } from "@/lib/relative-time";

const PR_REFRESH_TIMEOUT_MS = 10_000;

/** Actions share the body's selected-host subscription on desktop and mobile. */
export function PrPanelActions(props: {
  readonly subscription: PrListSubscriptionResult;
  readonly enabled: boolean;
}): ReactNode {
  const { subscription, enabled } = props;
  const observedAt =
    subscription.data === null
      ? null
      : newestObservedAt(subscription.data.items);
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
      {subscription.data === null ? null : (
        <PrStalenessHint observedAt={observedAt} />
      )}
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

/**
 * The panel's freshness line, including the state where there is no freshness
 * to report. A null `observedAt` means no row has ever landed for any PR here,
 * and saying so is the only thing that distinguishes "nothing fetched yet"
 * from "fetched, and nothing has changed since" - which matters most while a
 * pause is in effect and the ⓘ beside this text explains why.
 */
function PrStalenessHint(props: {
  readonly observedAt: number | null;
}): ReactNode {
  return (
    <span
      className="max-w-[min(40vw,8rem)] truncate text-ui-xs text-muted-foreground"
      data-testid="pr-panel-staleness"
    >
      {props.observedAt === null ? (
        "Not yet fetched"
      ) : (
        <PrStalenessLabel observedAt={props.observedAt} />
      )}
    </span>
  );
}

function PrStalenessLabel(props: { readonly observedAt: number }): ReactNode {
  const label = useRelativeTimestamp(props.observedAt);
  return <>{label === "Just now" ? "Updated just now" : `Updated ${label}`}</>;
}

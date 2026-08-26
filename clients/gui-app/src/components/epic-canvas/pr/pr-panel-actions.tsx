import { useCallback, type ReactNode } from "react";
import { RefreshIcon } from "@/components/refresh-icon";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { Button } from "@/components/ui/button";
import { PrSourceNoticeHint } from "@/components/epic-canvas/pr/pr-source-notice";
import { usePrListSubscription } from "@/hooks/pr/use-pr-list-subscription";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { useStreamMethodSupport } from "@/lib/host/stream-runtime-context";
import { newestObservedAt } from "@/lib/pr/pr-list-projection";
import { useRelativeTimestamp } from "@/lib/relative-time";
import {
  useLeftPanelSectionCollapsed,
  useMainPanelCollapsed,
} from "@/stores/epics/left-panel-store";

const PR_REFRESH_TIMEOUT_MS = 10_000;

/**
 * Header actions for the Pull Requests panel: epic-wide staleness + Refresh.
 * Host switcher is intentionally omitted in T5 — the list follows the
 * canvas-serving host via `useCanvasHostId`, matching the Git Diff panel's
 * default-host stream client; a dedicated switcher affordance can
 * land with workspace-picker parity later if needed.
 *
 * Note: Actions stay mounted when the section collapses (only Body unmounts)
 * and when the whole sidebar collapses (CSS-only). The same visibility gate
 * as the body is applied here so a collapsed surface does not keep a
 * foreground subscription alive.
 */
export function PrPanelActions(
  props: LeftPanelSlotProps & { readonly collapsed: boolean },
): ReactNode {
  if (props.collapsed) return null;
  return <PrPanelActionsLive epicId={props.epicId} tabId={props.tabId} />;
}

function PrPanelActionsLive(props: {
  readonly epicId: string;
  readonly tabId: string;
}): ReactNode {
  const hostId = useCanvasHostId();
  const mainCollapsed = useMainPanelCollapsed(props.tabId);
  const sectionCollapsed = useLeftPanelSectionCollapsed("pull-requests");
  const methodSupport = useStreamMethodSupport("pr.subscribeListForEpic");
  const methodSupported = methodSupport !== "unsupported";
  const enabled = !mainCollapsed && !sectionCollapsed && methodSupported;

  const subscription = usePrListSubscription({
    hostId,
    epicId: props.epicId,
    mode: "foreground",
    enabled,
  });

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
        variant="ghost"
        size="icon-sm"
        onClick={refresh.trigger}
        aria-label="Refresh pull requests"
        disabled={!enabled || refresh.refreshing}
        data-testid="pr-panel-refresh"
        className="text-muted-foreground hover:text-foreground"
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

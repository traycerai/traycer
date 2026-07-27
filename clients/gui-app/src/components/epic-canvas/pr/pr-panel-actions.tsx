import { useCallback, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { Button } from "@/components/ui/button";
import { usePrListSubscription } from "@/hooks/pr/use-pr-list-subscription";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { useStreamMethodSupport } from "@/lib/host/stream-runtime-context";
import { newestObservedAt } from "@/lib/pr/pr-list-projection";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  useLeftPanelSectionCollapsed,
  useMainPanelCollapsed,
} from "@/stores/epics/left-panel-store";

const PR_REFRESH_TIMEOUT_MS = 10_000;

/**
 * Header actions for the Pull Requests panel: epic-wide staleness + Refresh.
 * Host switcher is intentionally omitted in T5 — the list follows the app's
 * active (default) host via `useReactiveActiveHostId`, matching the Git Diff
 * panel's default-host stream client; a dedicated switcher affordance can
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
  const hostId = useReactiveActiveHostId();
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
      {observedAt === null ? null : <PrStalenessHint observedAt={observedAt} />}
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
        <RotateCcw
          className={cn("size-4", refresh.refreshing && "animate-spin")}
        />
      </Button>
    </div>
  );
}

function PrStalenessHint(props: { readonly observedAt: number }): ReactNode {
  const label = useRelativeTimestamp(props.observedAt);
  return (
    <span
      className="max-w-[min(40vw,8rem)] truncate text-ui-xs text-muted-foreground"
      data-testid="pr-panel-staleness"
    >
      {label === "Just now" ? "Updated just now" : `Updated ${label}`}
    </span>
  );
}

import { useCallback, useEffect, type ReactNode } from "react";
import { SquareStack } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineTitleField } from "@/components/epic-canvas/mobile/inline-title-field";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import {
  epicTabRightActionsKey,
  useMobileHeaderStore,
} from "@/stores/layout/mobile-header-store";
import { useMobileSwitcherStore } from "@/stores/epics/mobile-switcher-store";
import { useRegisteredEpicPermissionRole } from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useEpicUpdateTitle } from "@/hooks/epic/use-epic-title-mutation";
import {
  getEpicSessionHandleHostClient,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { updateEpicTitleInCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";
import {
  settleDetachedEpicTitleCommit,
  settleEpicTitleWrite,
} from "@/lib/epic-title-write-settlement";

/**
 * Fills the mobile-header right-actions slot on the epic route with the tab switcher trigger.
 * Tapping it opens the switcher sheet, which the epic tile view mounts - the two halves talk through `useMobileSwitcherStore` because this trigger renders from the app provider stack, OUTSIDE the epic session tree.
 */
export function EpicMobileSwitcherTrigger(props: { readonly tabId: string }) {
  const { tabId } = props;
  const setOpen = useMobileSwitcherStore((state) => state.setOpen);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Switch tab"
      data-testid="mobile-epic-switcher-trigger"
      onClick={() => setOpen(tabId, true)}
      className="shrink-0 text-muted-foreground hover:text-foreground"
    >
      <SquareStack className="size-4" />
    </Button>
  );
}

/**
 * The committed name reaches this control back through the same live session the header resolved it from, so no separate tab-name write is needed - and it must be that session, because the tab record's copy is only refreshed by the epic route's active-session effects, which the restore this control has to work under never mounts.
 */
export function MobileEpicHeaderTitle(props: {
  readonly epicId: string;
  readonly title: string;
}): ReactNode {
  const { epicId, title } = props;
  const canEdit = isEditableRole(useRegisteredEpicPermissionRole(epicId));
  const updateTitle = useEpicUpdateTitle();
  const queryClient = useQueryClient();
  const handleCommit = useCallback(
    async (next: string) => {
      // Both were RPC-only here until 1.1, which meant the SAME user on the SAME device got different feedback either side of a 768px window drag - `useIsMobileViewport()` is a media query, not a platform.
      const handle = getOpenEpicRegistry().peek(epicId);
      // That check is gone, and its absence is not an oversight - the crossing it guarded cannot occur any more.
      // So a rename issued against a live handle reaches that session's host and can never reach the app-wide client.
      if (handle !== null) {
        const sessionClient = getEpicSessionHandleHostClient(handle);
        const hostId = sessionClient?.getActiveHostId() ?? null;
        const userId = sessionClient?.getRequestContextUserId() ?? null;
        const state = handle.store.getState();
        const commandId = await state.enqueueWriteCommand({
          kind: "update-epic-title",
          title: next,
          updatedAt: Date.now(),
        });
        // A promise is truthy, so this guard only means anything against the
        // awaited value - see the enqueue above.
        if (commandId === null) return;
        settleEpicTitleWrite(state.waitForWriteCommand(commandId), {
          onCommitted: () => {
            // This arm bypasses `useEpicUpdateTitle`, so it owns the analytics
            // and cache update that hook normally performs.
            Analytics.getInstance().track(AnalyticsEvent.TaskRenamed, {
              source: "direct_ui",
            });
            toast.success("Epic renamed");
            if (userId === null) return;
            updateEpicTitleInCloudTaskCaches(
              queryClient,
              { hostId, userId },
              epicId,
              next,
            );
          },
          source: "Epic mobile header",
        });
        return;
      }
      void updateTitle
        .mutateAsync({
          epicDelta: { id: epicId, title: next, updatedAt: Date.now() },
        })
        .then(
          () => {},
          () => {},
        );
    },
    [epicId, queryClient, updateTitle],
  );
  return (
    <InlineTitleField
      value={title}
      editable={canEdit}
      // `void` states the fire-and-forget the caller already assumed, instead of leaking a promise into a void slot.
      onCommit={(next: string) => {
        settleDetachedEpicTitleCommit(handleCommit(next), "Epic mobile header");
      }}
      inputLabel="Epic title"
      testId="mobile-epic-header-title"
      className="min-w-0 flex-1 truncate font-medium text-foreground"
    />
  );
}

/**
 * The registry stores a `ReactNode` element: this is safe because the element is a self-contained component keyed only on the stable tab id - it re-reads volatile state from its own hooks each header render, so nothing goes stale.
 */
export function MobileEpicHeaderActionsBinder(props: {
  readonly tabId: string;
}) {
  const { tabId } = props;
  const isMobile = useIsMobileViewport();
  const registerRightActions = useMobileHeaderStore(
    (s) => s.registerRightActions,
  );
  const unregisterRightActions = useMobileHeaderStore(
    (s) => s.unregisterRightActions,
  );

  useEffect(() => {
    if (!isMobile) return;
    const key = epicTabRightActionsKey(tabId);
    registerRightActions(key, <EpicMobileSwitcherTrigger tabId={tabId} />);
    return () => unregisterRightActions(key);
  }, [isMobile, registerRightActions, tabId, unregisterRightActions]);

  return null;
}

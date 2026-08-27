import { useCallback, useEffect, type ReactNode } from "react";
import { SquareStack } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineTitleField } from "@/components/epic-canvas/mobile/inline-title-field";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useMobileHeaderStore } from "@/stores/layout/mobile-header-store";
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
import { toastFromHostError } from "@/lib/host-error-toast";
import { toHostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { updateEpicTitleInCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";

/**
 * Fills the mobile-header right-actions slot on the epic route with the tab
 * switcher trigger. Tapping it opens the switcher sheet, which the epic tile
 * view mounts - the two halves talk through `useMobileSwitcherStore` because
 * this trigger renders from the app provider stack, OUTSIDE the epic session
 * tree.
 *
 * Ungated by permission: switching tabs reads, it does not mutate, so a viewer
 * gets the same trigger. The create actions inside the sheet carry their own
 * editor gate.
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
 * The epic's name in the mobile header, renamed in place: tapping it turns the
 * title into its own field, and the committed value goes through the canonical
 * epic-rename mutation. The committed name reaches this control back through
 * the same live session the header resolved it from, so no separate tab-name
 * write is needed - and it must be that session, because the tab record's copy
 * is only refreshed by the epic route's active-session effects, which the
 * restore this control has to work under never mounts.
 *
 * Renaming is editor-only (the same role predicate the sidebar uses, read
 * through the header-safe registry accessor because this renders outside the
 * epic session tree); a viewer sees plain text.
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
    (next: string) => {
      // Optimistic overlay, so this control behaves identically to the wide
      // viewport's tab strip. Both were RPC-only here until 1.1, which meant
      // the SAME user on the SAME device got different feedback either side of
      // a 768px window drag - `useIsMobileViewport()` is a media query, not a
      // platform. Reached through the registry rather than `useOpenEpicHandle`
      // because this renders outside the epic session tree, exactly as the
      // permission-role read above does.
      const handle = getOpenEpicRegistry().peek(epicId);
      const requestId =
        handle?.store.getState().beginEpicTitleMutation(next) ?? null;
      // Retire rides the promise, not a per-call `onSettled` - TanStack drops
      // those on unmount, and this control UNMOUNTS on the very resize the
      // 768px parity contract is about. Contract note in
      // `use-rename-canvas-tab.ts`.
      const retire = (outcome: "landed" | "failed"): void => {
        if (requestId === null) return;
        handle?.store.getState().retirePendingMutation(requestId, outcome);
      };
      // HOST-SCOPED where a live session exists, exactly as the wide
      // viewport's tab strip resolves `epicRenameClient(tab.hostId)`: the
      // overlay above was stamped on the SESSION's store, so the RPC must go
      // to the session's host - an app-wide client pointed elsewhere during
      // a host switch would ack a rename the session can never echo, leaving
      // the landed stamp masking the real title until expiry (and renaming
      // the wrong host's copy). A session with no serving client right now,
      // or no session at all, falls back to the app-wide mutation - all this
      // surface ever had before sessions carried a host.
      const sessionClient =
        handle === null ? null : getEpicSessionHandleHostClient(handle);
      if (sessionClient !== null) {
        const hostId = sessionClient.getActiveHostId();
        const userId = sessionClient.getRequestContextUserId();
        void sessionClient
          .request("epic.updateTitle", {
            epicDelta: { id: epicId, title: next, updatedAt: Date.now() },
          })
          .then(
            () => {
              retire("landed");
              toast.success("Epic renamed");
              if (userId === null) return;
              updateEpicTitleInCloudTaskCaches(
                queryClient,
                { hostId, userId },
                epicId,
                next,
              );
            },
            (error: unknown) => {
              retire("failed");
              toastFromHostError(
                toHostRpcError(error, "epic.updateTitle"),
                "Couldn't rename epic.",
              );
            },
          );
        return;
      }
      void updateTitle
        .mutateAsync({
          epicDelta: { id: epicId, title: next, updatedAt: Date.now() },
        })
        .then(
          () => {
            retire("landed");
          },
          () => {
            retire("failed");
          },
        );
    },
    [epicId, queryClient, updateTitle],
  );
  return (
    <InlineTitleField
      value={title}
      editable={canEdit}
      onCommit={handleCommit}
      inputLabel="Epic title"
      testId="mobile-epic-header-title"
      className="min-w-0 flex-1 truncate font-medium text-foreground"
    />
  );
}

/**
 * Fills / clears the mobile-header right-actions slot for the FOCUSED epic
 * surface. Mounted once (by that surface, from its tab-focus flag), self-gated
 * on `useIsMobileViewport()`. The slot stores a `ReactNode` element: this is
 * safe because the element is a self-contained component keyed only on the
 * stable tab id - it re-reads volatile state from its own hooks each header
 * render, so nothing goes stale. A render-fn slot would be isomorphic (a fn
 * returning the same element) but a larger store change; a baked-in control
 * that closed over epic-session handlers WOULD go stale, which is exactly what
 * this shape avoids.
 */
export function MobileEpicHeaderActionsBinder(props: {
  readonly tabId: string;
}) {
  const { tabId } = props;
  const isMobile = useIsMobileViewport();
  const setRightActions = useMobileHeaderStore((s) => s.setRightActions);

  useEffect(() => {
    if (!isMobile) return;
    setRightActions(<EpicMobileSwitcherTrigger tabId={tabId} />);
    return () => setRightActions(null);
  }, [isMobile, tabId, setRightActions]);

  return null;
}

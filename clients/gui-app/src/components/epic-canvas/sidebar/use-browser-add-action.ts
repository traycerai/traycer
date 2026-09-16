import { preparePendingBrowserTile } from "@/lib/browser-view/tiles/pending-browser-tab";
import type { PreparedBrowserTabOpen } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import {
  tilePlacementForCategory,
  useSettingsStore,
} from "@/stores/settings/settings-store";
import { useCallback } from "react";
import { flushSync } from "react-dom";
import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { browserSessionsRefusal } from "@traycer-clients/shared/platform/browser-view";
import { useBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { browserMutationKeys } from "@/lib/query-keys/browser-mutation-keys";
import {
  DEFAULT_BROWSER_TILE_URL,
  makeBrowserSessionTileRef,
} from "@/stores/epics/canvas/tile-schema/browser-tile";
import { tileIntent } from "@/lib/canvas/tile-open/intent";

/** The host that answered, and the tab it opened there. */
interface OpenedBrowserTab {
  readonly pending: boolean;
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
}

export interface AddBrowserAction {
  /** A tab has been asked for and the host has not answered yet. */
  readonly isAdding: boolean;
  readonly add: () => void;
}

export function useAddBrowserAction(
  tabId: string,
  onOpened: (() => void) | null,
): AddBrowserAction {
  const sessions = useBrowserSessionsContext();
  const queryClient = useQueryClient();
  const { openTile } = useEpicTileNavigation();
  const openTabKey = browserMutationKeys.openTab(sessions.hostId);
  const addMutation = useMutation<
    OpenedBrowserTab,
    Error,
    PreparedBrowserTabOpen | null
  >({
    mutationKey: openTabKey,
    retry: false,
    mutationFn: async (request) => {
      const hostId = sessions.hostId;
      if (sessions.lifecycle !== "live" || hostId === null) {
        throw new Error(browserSessionsRefusal(sessions));
      }
      const opened = await (request === null
        ? sessions.openTab(null, DEFAULT_BROWSER_TILE_URL)
        : request.send());
      return {
        hostId,
        sessionId: opened.sessionId,
        tabId: opened.tabId,
        pending: request !== null,
      };
    },
    onSuccess: (opened) => {
      if (opened.pending) return;
      openTile(
        tileIntent(
          makeBrowserSessionTileRef(opened),
          { tabId },
          "explicit",
          "direct_ui",
        ),
      );
      onOpened?.();
    },
    onError: (cause, request) => {
      request?.dismiss();
      toast.error(cause.message);
    },
  });
  // Counted across every surface adding on this host, not just this hook's
  // own call: the header and the empty state mount together, so a per-hook
  // flag would let one tap on each open two tabs.
  const isAdding = useIsMutating({ mutationKey: openTabKey }) > 0;
  const mutate = addMutation.mutate;
  const add = useCallback(() => {
    if (queryClient.isMutating({ mutationKey: openTabKey }) > 0) return;
    const placement = useSettingsStore.getState().tilePlacement;
    if (
      sessions.lifecycle !== "live" ||
      sessions.hostId === null ||
      tilePlacementForCategory(placement, "browser") === "pip"
    ) {
      mutate(null);
      return;
    }
    const pending = preparePendingBrowserTile(
      sessions,
      DEFAULT_BROWSER_TILE_URL,
    );
    // Commit the new stream consumer before a mobile sheet releases its own.
    flushSync(() => {
      openTile(tileIntent(pending.node, { tabId }, "explicit", "direct_ui"));
    });
    pending.observe();
    mutate(pending.request);
    onOpened?.();
  }, [queryClient, openTabKey, sessions, openTile, tabId, mutate, onOpened]);
  return { isAdding, add };
}

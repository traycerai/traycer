import { useCallback } from "react";
import { useIsMutating, useMutation } from "@tanstack/react-query";
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

interface OpenedBrowserTab {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
}

export interface AddBrowserAction {
  /** A tab has been asked for and the host has not answered yet. */
  readonly isAdding: boolean;
  readonly add: () => void;
}

/**
 * `onOpened` runs only once the tile is on the canvas, never on the refusals that report themselves with a toast and open nothing.
 * The disconnected refusal is raised from inside the request rather than short- circuiting ahead of it, so both ways an add can fail arrive at one reporting path.
 */
export function useAddBrowserAction(
  tabId: string,
  onOpened: (() => void) | null,
): AddBrowserAction {
  const sessions = useBrowserSessionsContext();
  const { openTile } = useEpicTileNavigation();
  const openTabKey = browserMutationKeys.openTab(sessions.hostId);
  const addMutation = useMutation<OpenedBrowserTab>({
    mutationKey: openTabKey,
    mutationFn: async () => {
      const hostId = sessions.hostId;
      if (sessions.lifecycle !== "live" || hostId === null) {
        throw new Error(browserSessionsRefusal(sessions));
      }
      const opened = await sessions.openTab(null, DEFAULT_BROWSER_TILE_URL);
      return { hostId, sessionId: opened.sessionId, tabId: opened.tabId };
    },
    onSuccess: (opened) => {
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
    onError: (cause) => {
      toast.error(cause.message);
    },
  });
  // Counted across every surface adding on this host, not just this hook's own call: the header and the empty state mount together, so a per-hook flag would let one tap on each open two tabs.
  const isAdding = useIsMutating({ mutationKey: openTabKey }) > 0;
  const mutate = addMutation.mutate;
  const add = useCallback(() => {
    if (isAdding) return;
    mutate();
  }, [isAdding, mutate]);
  return { isAdding, add };
}

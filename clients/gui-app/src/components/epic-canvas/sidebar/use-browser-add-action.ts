import { useCallback } from "react";
import { useIsMutating, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { browserMutationKeys } from "@/lib/query-keys/browser-mutation-keys";
import {
  DEFAULT_BROWSER_TILE_URL,
  makeBrowserSessionTileRef,
} from "@/stores/epics/canvas/tile-schema/browser-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

/** The host that answered, and the tab it opened there. */
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
 * Opens a fresh browser tab on the panel's host and focuses it in the tab.
 *
 * `onOpened` runs only once the tile is on the canvas, never on the refusals
 * that report themselves with a toast and open nothing. A surface that
 * dismisses itself on create has to key that on the tile, or a refusal takes
 * away the very list the error is about - including its Retry. `null` for the
 * surfaces that outlive the tab they opened.
 *
 * The disconnected refusal is raised from inside the request rather than short-
 * circuiting ahead of it, so both ways an add can fail arrive at one reporting
 * path. `openTab` normalizes every rejection to an `Error` at the coordinator
 * boundary, so its message is always the one to show.
 *
 * `isAdding` is what keeps a second tap from opening a second tab: the host
 * round-trip is long enough on a phone for the button to be pressed twice, and
 * nothing downstream deduplicates - two answers mean two tabs and two tiles.
 * `add` re-checks it instead of relying on the caller's `disabled`, so the hook
 * holds that invariant for any surface that renders its own affordance.
 */
export function useAddBrowserAction(
  epicId: string,
  tabId: string,
  onOpened: (() => void) | null,
): AddBrowserAction {
  const sessions = useBrowserSessionsContext();
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpen = useEpicCanvasStore(
    (state) => state.prepareOpenTileInTabFocusTarget,
  );
  const openTabKey = browserMutationKeys.openTab(sessions.hostId);
  const addMutation = useMutation<OpenedBrowserTab>({
    mutationKey: openTabKey,
    mutationFn: async () => {
      const hostId = sessions.hostId;
      if (sessions.lifecycle !== "live" || hostId === null) {
        throw new Error("Browsers are not connected yet.");
      }
      const opened = await sessions.openTab(null, DEFAULT_BROWSER_TILE_URL);
      return { hostId, sessionId: opened.sessionId, tabId: opened.tabId };
    },
    onSuccess: (opened) => {
      navigateNested(epicId, tabId, () =>
        prepareOpen(tabId, makeBrowserSessionTileRef(opened)),
      );
      onOpened?.();
    },
    onError: (cause) => {
      toast.error(cause.message);
    },
  });
  // Counted across every surface adding on this host, not just this hook's
  // own call: the header and the empty state mount together, so a per-hook
  // flag would let one tap on each open two tabs.
  const isAdding = useIsMutating({ mutationKey: openTabKey }) > 0;
  const mutate = addMutation.mutate;
  const add = useCallback(() => {
    if (isAdding) return;
    mutate();
  }, [isAdding, mutate]);
  return { isAdding, add };
}

import { useCallback } from "react";
import { useIsMutating, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { browserMutationKeys } from "@/lib/query-keys/browser-mutation-keys";
import { DEFAULT_BROWSER_TILE_URL } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import { defaultLandingBrowserTitle } from "./use-landing-browser-reconciliation";

export interface LandingBrowserOpenTab {
  /** A tab has been asked for and the device has not answered yet. */
  readonly isOpening: boolean;
  readonly open: () => void;
}

/**
 * Opens a browser tab in the Start Page panel on one device.
 *
 * Keyed by device the way `useAddBrowserAction` is, and for the same reason:
 * the count is shared across every surface adding on that host, so the chord
 * and the chooser cannot open two tabs between them. The panel is not inside a
 * `BrowserSessionsHostProvider` - its tabs can name several devices - so the
 * coordinator arrives as an argument rather than from context.
 *
 * The tab is added to the store from the ANSWER's ids, never optimistically:
 * the session and tab ids are the device's to mint, and a ref written before
 * they exist would be reconciled straight back out.
 */
export function useLandingBrowserOpenTab(args: {
  readonly hostId: string | null;
  readonly sessions: BrowserSessionsState | null;
}): LandingBrowserOpenTab {
  const { hostId, sessions } = args;
  const openTabKey = browserMutationKeys.openTab(hostId);
  const openMutation = useMutation({
    mutationKey: openTabKey,
    mutationFn: async (): Promise<void> => {
      if (
        hostId === null ||
        sessions === null ||
        sessions.lifecycle !== "live"
      ) {
        throw new Error("Browsers are not connected yet.");
      }
      const opened = await sessions.openTab(null, DEFAULT_BROWSER_TILE_URL);
      useLandingPanelStore.getState().addTab({
        kind: "browser",
        instanceId: `landing-browser-${uuidv4()}`,
        hostId,
        sessionId: opened.sessionId,
        tabId: opened.tabId,
        name: defaultLandingBrowserTitle({
          title: null,
          url: DEFAULT_BROWSER_TILE_URL,
        }),
        titleSource: "default",
      });
    },
    onError: (cause: Error) => {
      toast.error(cause.message);
    },
  });
  const isOpening = useIsMutating({ mutationKey: openTabKey }) > 0;
  const mutate = openMutation.mutate;
  const open = useCallback(() => {
    if (isOpening) return;
    mutate();
  }, [isOpening, mutate]);
  return { isOpening, open };
}

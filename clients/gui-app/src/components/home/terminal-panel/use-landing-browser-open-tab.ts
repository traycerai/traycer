import { useCallback } from "react";
import { useIsMutating, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { browserMutationKeys } from "@/lib/query-keys/browser-mutation-keys";
import { DEFAULT_BROWSER_TILE_URL } from "@/stores/epics/canvas/tile-schema/browser-tile";
import type { LandingBrowserTabRef } from "@/stores/home/landing-panel-store";
import { defaultLandingBrowserTitle } from "./use-landing-browser-reconciliation";

/**
 * How many Start Page browser tabs one device holds.
 *
 * This is the HOST's limit restated, not a second policy: the host enforces
 * `DEFAULT_BROWSER_TAB_MAX_PER_SESSION` (also 8) in
 * `traycer-host/src/domain/browser/session/browser-session-manager.ts`, and the
 * Start Page puts every one of a device's panel browsers in a SINGLE
 * independent session - so per-session and per-device are the same number here
 * and the chooser can present the host's refusal before the user meets it.
 *
 * The two must move together. If the host's constant changes, this reads as a
 * cap the device does not actually have, in whichever direction: too low hides
 * capacity, too high shows an enabled card whose click fails.
 */
export const LANDING_BROWSER_TAB_CAP = 8;

/**
 * The device's own count of Start Page browser tabs, from its inventory rather
 * than from the panel's list.
 *
 * The inventory is the side the host counts, and it is the side that answers
 * for tabs another WINDOW opened: the panel strip is shared across windows, so
 * a store-side count would let two windows each believe there is room.
 * `null` while the device has not published one - the cap cannot be checked and
 * the caller shows the connecting state instead of guessing.
 */
export function landingBrowserTabCount(
  sessions: BrowserSessionsState | null,
  hostId: string | null,
): number | null {
  if (sessions === null || hostId === null || !sessions.inventoryReady) {
    return null;
  }
  return sessions.items
    .filter(
      (item) => item.hostId === hostId && item.scope.kind === "independent",
    )
    .reduce((total, item) => total + item.tabs.length, 0);
}

export interface LandingBrowserOpenTab {
  /** A tab has been asked for and the device has not answered yet. */
  readonly isOpening: boolean;
  /**
   * The device's tab count, or `null` while it has not published one. The
   * chooser renders the cap from this; the opener re-checks it.
   */
  readonly tabCount: number | null;
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
 * they exist would be reconciled straight back out. `onOpened` receives that
 * ref, which is how the chooser turns its placeholder into the tab in place.
 */
export function useLandingBrowserOpenTab(args: {
  readonly hostId: string | null;
  readonly sessions: BrowserSessionsState | null;
  /** Runs once the device has answered, with the ref that was added. */
  readonly onOpened: (tab: LandingBrowserTabRef) => void;
}): LandingBrowserOpenTab {
  const { hostId, sessions, onOpened } = args;
  const openTabKey = browserMutationKeys.openTab(hostId);
  const tabCount = landingBrowserTabCount(sessions, hostId);
  const openMutation = useMutation({
    mutationKey: openTabKey,
    mutationFn: async (): Promise<LandingBrowserTabRef> => {
      if (
        hostId === null ||
        sessions === null ||
        sessions.lifecycle !== "live"
      ) {
        throw new Error("Browsers are not connected yet.");
      }
      // Re-checked here and not only at the affordance: the chord opens a tab
      // without ever rendering the chooser's disabled card, and the count can
      // move between the render that enabled a card and the click on it.
      if (tabCount !== null && tabCount >= LANDING_BROWSER_TAB_CAP) {
        throw new Error(landingBrowserCapMessage());
      }
      const opened = await sessions.openTab(null, DEFAULT_BROWSER_TILE_URL);
      return {
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
      };
    },
    onSuccess: (tab) => {
      onOpened(tab);
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
  return { isOpening, tabCount, open };
}

/** The chooser's disabled-card copy, and the chord's toast when it refuses. */
export function landingBrowserCapMessage(): string {
  return `This device has ${LANDING_BROWSER_TAB_CAP} browser tabs open`;
}

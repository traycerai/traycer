import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMutating, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { browserSessionsRefusal } from "@traycer-clients/shared/platform/browser-view";
import { browserMutationKeys } from "@/lib/query-keys/browser-mutation-keys";
import { DEFAULT_BROWSER_TILE_URL } from "@/stores/epics/canvas/tile-schema/browser-tile";
import {
  useLandingPanelStore,
  type LandingBrowserTabRef,
} from "@/stores/home/landing-panel-store";
import type { LandingBrowserSessionEntries } from "./landing-terminal-authority-fleet";
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
  /** Set for the whole in-flight window, so `open()` is idempotent per tick. */
  const inFlightRef = useRef<{ readonly hostId: string | null } | null>(null);
  const openTabKey = browserMutationKeys.openTab(hostId);
  const tabCount = landingBrowserTabCount(sessions, hostId);
  const openMutation = useMutation({
    mutationKey: openTabKey,
    mutationFn: async (): Promise<LandingBrowserTabRef> => {
      // `inventoryReady` belongs in THIS guard rather than being left to the
      // cap check below: a live stream that has not published an inventory has
      // no count, so the cap check passes vacuously and the open goes to a
      // device whose tabs nobody has counted. The device has not spoken yet -
      // which is what the connecting refusal says, and it is not the cap's
      // sentence to say.
      if (
        hostId === null ||
        sessions === null ||
        sessions.lifecycle !== "live" ||
        !sessions.inventoryReady
      ) {
        throw new Error(browserSessionsRefusal(sessions));
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
    onSettled: () => {
      inFlightRef.current = null;
    },
  });
  const isOpening = useIsMutating({ mutationKey: openTabKey }) > 0;
  const mutate = openMutation.mutate;
  const open = useCallback(() => {
    // `isOpening` is RENDERED state: `useIsMutating` publishes through the
    // query cache's subscription, so two `open()` calls in one tick both read
    // the value from the render they were dispatched in - `false` - and both
    // reach the mutation. Only a ref moves within the tick. It records the
    // device rather than a bare boolean so a host switch mid-flight releases
    // it: that is a different device, and its tab is not the one in flight.
    if (isOpening) return;
    if (inFlightRef.current !== null && inFlightRef.current.hostId === hostId) {
      return;
    }
    inFlightRef.current = { hostId };
    mutate();
  }, [hostId, isOpening, mutate]);
  return { isOpening, tabCount, open };
}

/** The chooser's disabled-card copy, and the chord's toast when it refuses. */
export function landingBrowserCapMessage(): string {
  return `This device has ${LANDING_BROWSER_TAB_CAP} browser tabs open`;
}

/** Where a popup the page raised should land relative to the reader. */
export type LandingBrowserLinkDisposition = "foreground" | "background";

/**
 * How many unanswered popup asks the panel will hold.
 *
 * {@link LANDING_BROWSER_TAB_CAP}, because that is the ceiling on what could
 * ever land: a device holds eight panel tabs, so a ninth queued open is one the
 * cap re-check would refuse anyway. Overflow is dropped rather than queued
 * behind asks that cannot succeed - a page emitting popups faster than a device
 * can answer them is not a reader making eight requests.
 */
const MAX_PENDING_LINK_OPENS = LANDING_BROWSER_TAB_CAP;

interface LandingBrowserLinkRequest {
  readonly hostId: string;
  readonly sessionId: string;
  readonly url: string;
  readonly disposition: LandingBrowserLinkDisposition;
  /** Distinguishes a second identical ask from the first one. */
  readonly requestId: string;
}

export interface LandingBrowserOpenLink {
  readonly open: (
    tab: LandingBrowserTabRef,
    url: string,
    disposition: LandingBrowserLinkDisposition,
  ) => void;
}

/**
 * A link the page asked to open in a new tab.
 *
 * Browser semantics, not the panel's: the popup belongs to the SAME session as
 * the tab that raised it, and a background open (middle / ctrl / cmd click)
 * must not take the selection from the tab being read.
 *
 * It goes through Query on the same key the chooser's opener uses,
 * `browserMutationKeys.openTab(hostId)`, so a popup and a chooser open on one
 * device are one in-flight open rather than two - which is also what makes the
 * cap re-check here mean anything. The key names the DEVICE, and a popup's
 * device is the raising tab's rather than the panel's active one, so the ask is
 * queued into state for one render and dispatched from there: the key is read
 * off the render the mutation starts in, and a ref could not move it.
 */
export function useLandingBrowserOpenLink(args: {
  readonly browserSessions: LandingBrowserSessionEntries;
}): LandingBrowserOpenLink {
  const { browserSessions } = args;
  // A QUEUE and not a slot: a page can emit two `window.open` calls in one
  // tick, and a single slot would let the second overwrite the first before
  // either was dispatched - losing a popup silently, which is worse than
  // opening it late.
  const [queue, setQueue] = useState<readonly LandingBrowserLinkRequest[]>([]);
  const head = queue.at(0) ?? null;
  const dispatchedRef = useRef<string | null>(null);
  const openMutation = useMutation({
    mutationKey: browserMutationKeys.openTab(head?.hostId ?? null),
    mutationFn: async (
      pending: LandingBrowserLinkRequest,
    ): Promise<LandingBrowserTabRef> => {
      const sessions = browserSessions[pending.hostId] ?? null;
      if (
        sessions === null ||
        sessions.lifecycle !== "live" ||
        !sessions.inventoryReady
      ) {
        throw new Error(browserSessionsRefusal(sessions));
      }
      const tabCount = landingBrowserTabCount(sessions, pending.hostId);
      if (tabCount !== null && tabCount >= LANDING_BROWSER_TAB_CAP) {
        throw new Error(landingBrowserCapMessage());
      }
      const opened = await sessions.openTab(pending.sessionId, pending.url);
      // Read AFTER the await, not before it: the reader can move to another
      // row - or close the one they were on - while the device is answering,
      // and "the tab being read" is the row that is active when the popup
      // ARRIVES, not the one that was active when it was asked for.
      const previousActiveInstanceId =
        useLandingPanelStore.getState().activeInstanceId;
      const store = useLandingPanelStore.getState();
      const tab: LandingBrowserTabRef = {
        kind: "browser",
        instanceId: `landing-browser-${uuidv4()}`,
        hostId: pending.hostId,
        sessionId: opened.sessionId,
        tabId: opened.tabId,
        name: pending.url,
        titleSource: "default",
      };
      store.addTab(tab);
      // `addTab` activates what it adds, which is right for a foreground open
      // and wrong for a background one - so the background arm puts the
      // selection back where the reader left it. `activateTab` ignores an id
      // the store no longer holds, so a row closed mid-open leaves the new tab
      // active rather than nothing.
      if (
        pending.disposition === "background" &&
        previousActiveInstanceId !== null
      ) {
        store.activateTab(previousActiveInstanceId);
      }
      return tab;
    },
    onError: (cause: Error) => {
      toast.error(cause.message);
    },
    onSettled: () => {
      // Only the head is ever in flight, so the settled ask is the one that
      // leaves - and the render that follows dispatches the next.
      setQueue((current) => current.slice(1));
    },
  });
  const mutate = openMutation.mutate;
  useEffect(() => {
    if (head === null) {
      dispatchedRef.current = null;
      return;
    }
    if (dispatchedRef.current === head.requestId) return;
    dispatchedRef.current = head.requestId;
    mutate(head);
  }, [mutate, head]);
  const open = useCallback(
    (
      tab: LandingBrowserTabRef,
      url: string,
      disposition: LandingBrowserLinkDisposition,
    ): void => {
      setQueue((current) =>
        current.length >= MAX_PENDING_LINK_OPENS
          ? current
          : [
              ...current,
              {
                hostId: tab.hostId,
                sessionId: tab.sessionId,
                url,
                disposition,
                requestId: uuidv4(),
              },
            ],
      );
    },
    [],
  );
  return { open };
}

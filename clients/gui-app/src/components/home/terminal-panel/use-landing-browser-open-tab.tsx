import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useIsMutating, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { browserSessionsRefusal } from "@traycer-clients/shared/platform/browser-view";
import { browserMutationKeys } from "@/lib/query-keys/browser-mutation-keys";
import { DEFAULT_BROWSER_TILE_URL } from "@/stores/epics/canvas/tile-schema/browser-tile";
import type { LandingBrowserTabRef } from "@/stores/home/landing-panel-store";
import type { LandingBrowserSessionEntries } from "./landing-terminal-authority-fleet";
import { LandingBrowserLinkOpener } from "./landing-browser-link-opener";
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

/**
 * What one ask was answering, carried WITH that ask.
 *
 * The opener's pending state is keyed by device, so a request on one device and
 * a later one on another can both be in flight - and a panel-level slot holding
 * "the row this is for" would be read by whichever answered first, whatever it
 * had recorded. Mutation variables travel with their own request by
 * construction, which is what makes each answer act on its own row.
 */
export interface LandingBrowserOpenRequest {
  /**
   * The chooser row the ask was made from, read at DISPATCH, or `null` when
   * there was none. A chord names one too when the strip is showing one - what
   * it must not do is name a row that appeared while the device was answering,
   * which is a choice the reader made after this ask.
   */
  readonly placeholderInstanceId: string | null;
}

/**
 * What one `open()` hands its mutation: the request, and the device it was
 * made on. The device's stream state is deliberately NOT carried: it is read
 * when the mutation runs, from what the panel holds for that device then.
 */
interface LandingBrowserDispatch {
  readonly request: LandingBrowserOpenRequest;
  readonly hostId: string | null;
}

export interface LandingBrowserOpenTab {
  /** A tab has been asked for and the device has not answered yet. */
  readonly isOpening: boolean;
  /**
   * The device's tab count, or `null` while it has not published one. The
   * chooser renders the cap from this; the opener re-checks it.
   */
  readonly tabCount: number | null;
  readonly open: (request: LandingBrowserOpenRequest) => void;
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
  /**
   * Every device's stream state, not only the target's: an open is made on
   * the device the panel targets at dispatch and runs later (see the ref
   * below), by which time the panel may target another device. Keyed by
   * device, the state the open needs is still here when it runs.
   */
  readonly browserSessions: LandingBrowserSessionEntries;
  /**
   * Whether this shell can drive a tab it opens. See
   * {@link landingBrowserViewerMessage} - the chord opens without ever
   * rendering the chooser's card, so the refusal has to live here too.
   */
  readonly canDriveTabs: boolean;
  /**
   * Runs once the device has answered, with the ref that was added and the
   * request it answers - never a slot some other request may have overwritten.
   */
  readonly onOpened: (
    tab: LandingBrowserTabRef,
    request: LandingBrowserOpenRequest,
  ) => void;
}): LandingBrowserOpenTab {
  const { canDriveTabs, hostId, browserSessions, onOpened } = args;
  const sessions = hostId === null ? null : (browserSessions[hostId] ?? null);
  /**
   * The devices with an open in flight, so `open()` is idempotent per tick.
   *
   * A SET, not one cell holding the device in flight. The panel's target host
   * can change while an open is unanswered, so two devices are routinely in
   * flight at once - and one cell cannot describe two. It failed in both
   * directions: B's dispatch overwrote A's entry, and then whichever settled
   * first cleared the other's latch, letting a second request on the still
   * pending device through both guards and open a duplicate tab.
   */
  const pendingHostsRef = useRef<Set<string | null>>(new Set());
  /**
   * Every device's stream state as of the LAST RENDER, for the mutation to
   * read when it actually runs. A `mutationFn` closes over the render `mutate`
   * was called in, and the shared scope below can hold this open behind a
   * popup's for as long as the device takes to answer that one - long enough
   * for the popup to take the device's last slot. Counting from the dispatching
   * render then sends a ninth open the device refuses, instead of this side's
   * cap refusing it first. The popup opener reads its inventory through a ref
   * for the same reason.
   *
   * All devices and not the target's alone, because the panel's target can
   * move while the open waits: a ref holding only the current target's state
   * would answer a queued open on the previous device with either the wrong
   * device's inventory or a snapshot from its own dispatch - which is the
   * stale count this ref exists to avoid.
   */
  const sessionsRef = useRef(browserSessions);
  useEffect(() => {
    sessionsRef.current = browserSessions;
  }, [browserSessions]);
  const openTabKey = browserMutationKeys.openTab(hostId);
  const tabCount = landingBrowserTabCount(sessions, hostId);
  const openMutation = useMutation({
    mutationKey: openTabKey,
    // Shared with the popup opener on this device, so the two cannot be in
    // flight at once and the cap re-check below reads a count that includes
    // whatever the other one just opened. See `openTabScope`.
    scope: { id: browserMutationKeys.openTabScope(hostId) },
    mutationFn: async (
      dispatched: LandingBrowserDispatch,
    ): Promise<LandingBrowserTabRef> => {
      // The device this open is for was fixed at dispatch. Its stream state is
      // read NOW, from the latest render's entries for that device - whatever
      // device the panel targets by now.
      const target = dispatched.hostId;
      const live =
        target === null ? null : (sessionsRef.current[target] ?? null);
      // `inventoryReady` belongs in THIS guard rather than being left to the
      // cap check below: a live stream that has not published an inventory has
      // no count, so the cap check passes vacuously and the open goes to a
      // device whose tabs nobody has counted. The device has not spoken yet -
      // which is what the connecting refusal says, and it is not the cap's
      // sentence to say.
      // Before the stream terms, because this one is about the shell and does
      // not resolve: a viewer that waited for `inventoryReady` would be told
      // it is connecting to a device whose answer changes nothing.
      if (!canDriveTabs) {
        throw new Error(landingBrowserViewerMessage());
      }
      if (
        target === null ||
        live === null ||
        live.lifecycle !== "live" ||
        !live.inventoryReady
      ) {
        throw new Error(browserSessionsRefusal(live));
      }
      // Re-checked here and not only at the affordance: the chord opens a tab
      // without ever rendering the chooser's disabled card, and the count can
      // move between the render that enabled a card and the click on it - or,
      // through the shared scope, between the dispatch and this line.
      const count = landingBrowserTabCount(live, target);
      if (count !== null && count >= LANDING_BROWSER_TAB_CAP) {
        throw new Error(landingBrowserCapMessage());
      }
      const opened = await live.openTab(null, DEFAULT_BROWSER_TILE_URL);
      return {
        kind: "browser",
        instanceId: `landing-browser-${uuidv4()}`,
        hostId: target,
        sessionId: opened.sessionId,
        tabId: opened.tabId,
        name: defaultLandingBrowserTitle({
          title: null,
          url: DEFAULT_BROWSER_TILE_URL,
        }),
        titleSource: "default",
      };
    },
    // The device this request is for, captured at dispatch - the house rule for
    // a host-swap race, and here it is what lets the settle clear the right
    // latch. Reading `hostId` in `onSettled` instead would read the host of
    // whatever render the answer happened to arrive in.
    onMutate: (dispatched): { readonly hostId: string | null } => ({
      hostId: dispatched.hostId,
    }),
    onSuccess: (tab, dispatched) => {
      onOpened(tab, dispatched.request);
    },
    onError: (cause: Error) => {
      toast.error(cause.message);
    },
    onSettled: (_tab, _cause, _request, context) => {
      if (context === undefined) return;
      pendingHostsRef.current.delete(context.hostId);
    },
  });
  const isOpening = useIsMutating({ mutationKey: openTabKey }) > 0;
  const mutate = openMutation.mutate;
  const open = useCallback(
    (request: LandingBrowserOpenRequest) => {
      // `isOpening` is RENDERED state: `useIsMutating` publishes through the
      // query cache's subscription, so two `open()` calls in one tick both read
      // the value from the render they were dispatched in - `false` - and both
      // reach the mutation. Only a ref moves within the tick.
      //
      // It also only ever describes THIS device: the key it counts is
      // `openTab(hostId)`. So the ref below has to be per device too, or the
      // two guards disagree about which device they are talking about.
      if (isOpening) return;
      if (pendingHostsRef.current.has(hostId)) return;
      pendingHostsRef.current.add(hostId);
      mutate({ request, hostId });
    },
    [hostId, isOpening, mutate],
  );
  return { isOpening, tabCount, open };
}

/** The chooser's disabled-card copy, and the chord's toast when it refuses. */
export function landingBrowserCapMessage(): string {
  return `This device has ${LANDING_BROWSER_TAB_CAP} browser tabs open`;
}

/**
 * The same, on a shell that can only watch a browser tab.
 *
 * A Start Page browser tab is one the READER drives, and driving it needs the
 * shell's own native browser capability: without it the tile is a screencast
 * viewer marked "View only" (`screencastRoleForShell` - `readOnly` follows the
 * SHELL, which is why a desktop viewing a remote host's tab still controls it
 * and is not refused here). An independent session has no agent driving it
 * either, so what the card would open is a blank page nobody can navigate away
 * from - and unlike the cap or the connecting wait, this does not resolve.
 */
export function landingBrowserViewerMessage(): string {
  return "Browser tabs need the desktop app";
}

/** Where a popup the page raised should land relative to the reader. */
export type LandingBrowserLinkDisposition = "foreground" | "background";

/**
 * How many unanswered popup asks the panel holds FOR ONE DEVICE.
 *
 * {@link LANDING_BROWSER_TAB_CAP}, because that is the ceiling on what could
 * ever land there: a device holds eight panel tabs, so a ninth queued open is
 * one the cap re-check would refuse anyway. Overflow is dropped rather than
 * queued behind asks that cannot succeed - a page emitting popups faster than a
 * device can answer them is not a reader making eight requests.
 *
 * Per device, because the number describes a device's tab ceiling. A single
 * pool would let one noisy page spend another device's slots, and every ask it
 * dropped would be a popup that device had room for.
 */
const MAX_PENDING_LINK_OPENS_PER_HOST = LANDING_BROWSER_TAB_CAP;

export interface LandingBrowserLinkRequest {
  readonly hostId: string;
  readonly sessionId: string;
  readonly url: string;
  readonly disposition: LandingBrowserLinkDisposition;
  /** Distinguishes a second identical ask from the first one. */
  readonly requestId: string;
}

/** Unanswered asks per device, in the order the page raised them. */
type LandingBrowserLinkQueues = Readonly<
  Record<string, ReadonlyArray<LandingBrowserLinkRequest>>
>;

export interface LandingBrowserOpenLink {
  readonly open: (
    tab: LandingBrowserTabRef,
    url: string,
    disposition: LandingBrowserLinkDisposition,
  ) => void;
  /**
   * One opener per device with unanswered asks. Render it - it paints nothing,
   * and without it the queue is never dispatched.
   *
   * The openers are components rather than one hook-level mutation because a
   * mutation carries ONE `mutationKey` and ONE `scope` per render, and both
   * name a device. A single mutation could therefore only ever serve one
   * device at a time, which is exactly the head-of-line blocking the per-device
   * queues exist to remove.
   */
  readonly openers: ReactNode;
}

/**
 * A link the page asked to open in a new tab.
 *
 * Browser semantics, not the panel's: the popup belongs to the SAME session as
 * the tab that raised it, and a background open (middle / ctrl / cmd click)
 * must not take the selection from the tab being read.
 *
 * Asks are queued per device for one render and dispatched from there rather
 * than sent from `open()`: the mutation's key and scope are read off the render
 * it starts in, and a popup's device is the raising tab's rather than the
 * panel's active one.
 */
export function useLandingBrowserOpenLink(args: {
  readonly browserSessions: LandingBrowserSessionEntries;
}): LandingBrowserOpenLink {
  const { browserSessions } = args;
  // Read at EXECUTION rather than closed over at dispatch: an ask that arrives
  // while another open is running on its device is paused by the shared scope
  // and runs later, by which time the render it was queued in may name a
  // stream that has since been replaced.
  const sessionsRef = useRef(browserSessions);
  useEffect(() => {
    sessionsRef.current = browserSessions;
  }, [browserSessions]);
  // A QUEUE per device and not a slot: a page can emit two `window.open` calls
  // in one tick, and a single slot would let the second overwrite the first
  // before either was dispatched - losing a popup silently, which is worse than
  // opening it late.
  const [queues, setQueues] = useState<LandingBrowserLinkQueues>({});
  const settle = useCallback((hostId: string): void => {
    setQueues((current) => {
      // Only a device's head is ever in flight, so the settled ask is the one
      // that leaves - and the render that follows dispatches the next.
      const rest = (current[hostId] ?? []).slice(1);
      const next = { ...current };
      if (rest.length === 0) delete next[hostId];
      else next[hostId] = rest;
      return next;
    });
  }, []);
  const open = useCallback(
    (
      tab: LandingBrowserTabRef,
      url: string,
      disposition: LandingBrowserLinkDisposition,
    ): void => {
      setQueues((current) => {
        const pending = current[tab.hostId] ?? [];
        if (pending.length >= MAX_PENDING_LINK_OPENS_PER_HOST) return current;
        return {
          ...current,
          [tab.hostId]: [
            ...pending,
            {
              hostId: tab.hostId,
              sessionId: tab.sessionId,
              url,
              disposition,
              requestId: uuidv4(),
            },
          ],
        };
      });
    },
    [],
  );
  const openers = (
    <>
      {Object.entries(queues).map(([hostId, pending]) => {
        const head = pending.at(0);
        if (head === undefined) return null;
        return (
          <LandingBrowserLinkOpener
            key={hostId}
            hostId={hostId}
            head={head}
            sessionsRef={sessionsRef}
            onSettled={settle}
          />
        );
      })}
    </>
  );
  return { open, openers };
}

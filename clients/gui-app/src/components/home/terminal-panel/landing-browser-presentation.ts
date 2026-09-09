import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import type { LandingBrowserTabRef } from "@/stores/home/landing-panel-store";
import { LANDING_BROWSER_WATCHED_HOST_CAP } from "./landing-browser-open-reservations";
import { defaultLandingBrowserTitle } from "./use-landing-browser-reconciliation";

/**
 * Re-exported, not defined here.
 *
 * The cap is an invariant of the reservation SET - `reserve` decides and
 * inserts against it in one synchronous step - so it lives with the set, which
 * every jsdom suite's setup imports and which must therefore stay a leaf. It
 * is re-exported because this module is where the bound is read from: the
 * selector below spends it, and its callers have always taken it from here.
 */
export { LANDING_BROWSER_WATCHED_HOST_CAP };

/**
 * How many devices the always-mounted tombstone recovery bridge puts on a
 * browser stream at a time.
 *
 * The same budget against the same desktop ceiling, for the arm nobody is
 * looking at. The bridge mounts a device because a browser tombstone still
 * names it, and an outstanding tombstone is unbounded in a way the strip is
 * not: it survives sign-out, reload and the device's absence, so a fleet with
 * a dozen of them would spend the whole window allowance on background closes
 * and the desktop would refuse the panel's own stream, or a canvas tile's -
 * the surfaces a reader is actually watching. Those are refused LAST, and a
 * refusal is only re-asked when some coordinator RELEASES its stream
 * (`retryFailedCoordinators`) - an edge a recovery stream reaches when its
 * tombstones drain, and, since the rotation below, also when it yields.
 *
 * Two, and deliberately the smallest of the three budgets: this arm has no
 * reader, and it makes progress by rotation rather than by breadth. A slot is
 * a LEASE on a place in a QUEUE: a device renews it by answering and goes to
 * the back otherwise. `landing-browser-recovery-slots.ts` owns that policy,
 * and it is what keeps this bound from starving the devices behind a silent
 * one.
 *
 * The bound is on DEVICES this bridge names, not on streams it opens: a device
 * the panel is already watching shares that coordinator by key and costs no
 * second stream, so the real spend is at most this number and usually less.
 */
export const LANDING_BROWSER_RECOVERY_HOST_CAP = 2;

/**
 * The tooltip on a row whose device this window is not watching.
 *
 * It is an admission rather than a claim: a row past the bound is rendered
 * from the store alone, so this window has no standing to say the tab is
 * dormant OR that its device is unreachable.
 */
export const LANDING_BROWSER_UNWATCHED_TOOLTIP =
  "Not watching this device; activate a tab to watch it";

/**
 * The devices an open panel puts on a browser stream, most important first.
 *
 * The ONE place the bound is decided. The panel mounts exactly this list and
 * builds every row's view model against it, so the strip cannot claim a
 * dormancy or an outage for a device the panel is not actually watching.
 *
 * Two devices are pinned, and the first of them only while the page is ON
 * SCREEN:
 *
 * - the routing TARGET, whether or not it has a tab: creating a browser tab
 *   goes through that device's coordinator, so `app.browser.new` and the
 *   chooser's tab-cap count both need it mounted before the first tab exists,
 *   and both work while the panel is COLLAPSED - which is why collapsing does
 *   not release it. A BACKGROUNDED Start Page reaches neither: the panel
 *   registers those handlers under `useLandingTerminalSurfaceActive`, so
 *   nothing can ask that device for anything. The panel outlives its page's
 *   activation, so without this the retained page holds a stream for as long
 *   as it stays mounted - a slot against the desktop's
 *   `MAX_STREAMS_PER_WINDOW`, which refuses whichever request came LAST, so a
 *   canvas tile or panel opened later pays for a device nobody is watching;
 * - the ACTIVE tab's device, whose tile is the pixels on screen.
 *
 * The rest of the budget goes to the most recently ACTIVATED tab hosts, and
 * then - for devices this session has never activated, which is every one of
 * them after a reload - to the strip's own order.
 */
export function landingBrowserWatchedHostIds(args: {
  readonly targetHostId: string | null;
  /** `null` when the active row is not a browser tab. */
  readonly activeBrowserHostId: string | null;
  /** Tab hosts by last activation, most recent first. */
  readonly recentlyActivatedHostIds: ReadonlyArray<string>;
  /** Every browser tab's device, in strip order. */
  readonly tabHostIds: ReadonlyArray<string>;
  /** The Start Page's pane is on screen, panel open or collapsed. */
  readonly paneVisible: boolean;
  /** The panel is open on a Start Page that is on screen. */
  readonly panelWatching: boolean;
  /**
   * Devices with an open this panel has not seen answered yet - both openers,
   * queued asks included.
   */
  readonly pendingOpenHostIds: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const watched: Array<string> = [];
  const add = (hostId: string | null): void => {
    if (hostId === null || watched.includes(hostId)) return;
    watched.push(hostId);
  };
  // Devices with an accepted, unanswered open come FIRST, ahead of even the
  // routing target, and the order is the whole of it. Neither opener acquires
  // its device: both read the stream from the panel's entries at the moment
  // the mutation RUNS (`sessionsRef` / `browserSessions`). So a device dropped
  // here mid-open loses the coordinator its own `openTab` came from - a
  // refusal for an ask the reader made, or a tab the device really did create
  // that this window never rowed and the tombstone drain has to clean up. That
  // is worse than the leak, so nothing already accepted may be evicted by
  // anything below.
  //
  // Ordering it after the target was a real defect and not a hypothetical: at
  // the cap's worth of pending devices with the target elsewhere, the target
  // took a slot and the last accepted open was dropped.
  //
  // NOT capped here, and that is deliberate. The cap belongs where the set is
  // MUTATED - `reserveLandingBrowserOpen` decides and inserts in one
  // synchronous step, so `size <= cap` is an invariant of the set rather than a
  // claim about its callers, and truncating here could only ever undo an
  // admission that had already been granted.
  //
  // A backstop whose failure mode IS the catastrophe it guards against is
  // worse than none: the previous shape broke the loop at the cap, so a
  // pending set that ever exceeded it lost an accepted hold - silently, and
  // chosen by sort order rather than by age. If this list is somehow over the
  // budget, this window now holds one stream too many, which is bounded and
  // recoverable; it never drops a device that is still answering.
  //
  // What the bound is worth stating plainly, because the version this replaces
  // was argued rather than counted: "an open is only dispatched against a
  // device the panel had mounted, so this is a subset of what the cap already
  // allowed" was FALSE. Being mounted at DISPATCH says nothing about the union
  // of devices mounted at DIFFERENT times - opens on different devices run
  // concurrently by design and nothing times them out, so twelve successive
  // targets held twelve streams and kept all twelve after a background. That
  // is the entire per-window allowance, spent on exactly the later canvas tile
  // or panel this release exists to protect.
  for (const hostId of args.pendingOpenHostIds) add(hostId);
  if (args.paneVisible && watched.length < LANDING_BROWSER_WATCHED_HOST_CAP) {
    add(args.targetHostId);
  }
  // Collapsed, or a backgrounded Start Page: nothing of those devices is
  // rendered, so nothing needs their inventory.
  if (!args.panelWatching) return watched;
  // Cap-guarded like everything else, so the total is the cap and not the cap
  // plus the pins. With the budget spent on unanswered opens the active row
  // reads `not watched` rather than claiming a dormancy this window cannot
  // see - a degraded status line, against a stream this window cannot afford.
  if (watched.length < LANDING_BROWSER_WATCHED_HOST_CAP) {
    add(args.activeBrowserHostId);
  }
  for (const hostId of [...args.recentlyActivatedHostIds, ...args.tabHostIds]) {
    if (watched.length >= LANDING_BROWSER_WATCHED_HOST_CAP) break;
    add(hostId);
  }
  return watched;
}

/** The refusal a reader sees when the open budget is already spent. */
export function landingBrowserOpenBudgetMessage(): string {
  return `Too many devices are still opening browser tabs (${LANDING_BROWSER_WATCHED_HOST_CAP})`;
}

/**
 * Whether this window is watching `hostId` - the membership half of
 * {@link landingBrowserWatchedHostIds}, so the mount list and every row read
 * the same answer from the same list.
 */
export function isLandingBrowserHostWatched(
  watchedHostIds: ReadonlyArray<string>,
  hostId: string,
): boolean {
  return watchedHostIds.includes(hostId);
}

/**
 * What the strip renders for one browser row - the browser counterpart of
 * `PlainTerminalViewModel`, and deliberately the same three questions: what to
 * call it, whether it is dormant, and whether its device is reporting at all.
 */
export interface LandingBrowserViewModel {
  readonly displayTitle: string;
  /** The live address, for the row's tooltip. `null` while unknown. */
  readonly address: string | null;
  readonly isDormant: boolean;
  /** The device has not published an inventory this row can be read against. */
  readonly isRuntimeUnknown: boolean;
  /**
   * This window is not watching the row's device, so the two flags above are
   * not facts it can report. Mutually exclusive with both by construction.
   */
  readonly isUnwatched: boolean;
}

export function selectLandingBrowserViewModel(args: {
  readonly tab: LandingBrowserTabRef;
  readonly sessions: BrowserSessionsState | null;
  /** The bound, from {@link landingBrowserWatchedHostIds}. */
  readonly watchedHostIds: ReadonlyArray<string>;
}): LandingBrowserViewModel {
  const stored: LandingBrowserViewModel = {
    displayTitle: args.tab.name,
    address: null,
    isDormant: false,
    isRuntimeUnknown: false,
    isUnwatched: false,
  };
  // Above the inventory read, and deliberately: an unwatched device has no
  // inventory here to read, and `isRuntimeUnknown` is the answer that absence
  // would otherwise produce - "status unavailable" about a device that is
  // perfectly fine and simply not being watched. The title still comes from
  // the store, which is where a browser row's name lives anyway.
  if (!isLandingBrowserHostWatched(args.watchedHostIds, args.tab.hostId)) {
    return { ...stored, isUnwatched: true };
  }
  const sessions = args.sessions;
  if (sessions === null || !sessions.inventoryReady) {
    return { ...stored, isRuntimeUnknown: true };
  }
  // Host and scope are re-checked even though the caller resolves `sessions`
  // by `tab.hostId`, matching the reconciler's posture in
  // `reconcileLandingBrowserTabs`: a session id is unique per device, so
  // matching on it alone would resolve a STRANGER'S tab under this row's name
  // if a caller ever handed over the wrong device's inventory. Failing to find
  // it reads as "gone", which is the safe direction.
  const session = sessions.items.find(
    (item) =>
      item.sessionId === args.tab.sessionId &&
      item.hostId === args.tab.hostId &&
      item.scope.kind === "independent",
  );
  const live = session?.tabs.find((item) => item.tabId === args.tab.tabId);
  // Ready and absent: the reconciler is about to drop this row. It is not
  // "status unavailable" - the device answered, and the answer was "gone".
  if (session === undefined || live === undefined) return stored;
  return {
    // Read from the snapshot rather than from `tab.name`, which the reconciler
    // syncs in an effect and is therefore one commit behind. A manual title is
    // the user's and is never overwritten by either path.
    displayTitle:
      args.tab.titleSource === "manual"
        ? args.tab.name
        : defaultLandingBrowserTitle(live),
    address: live.url,
    isDormant: live.status === "dormant" || session.runtime.kind === "dormant",
    isRuntimeUnknown: false,
    isUnwatched: false,
  };
}

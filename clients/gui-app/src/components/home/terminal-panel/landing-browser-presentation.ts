import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import type { LandingBrowserTabRef } from "@/stores/home/landing-panel-store";
import { defaultLandingBrowserTitle } from "./use-landing-browser-reconciliation";

/**
 * How many DEVICES one open panel keeps on a browser stream at a time.
 *
 * Counts hosts, not tabs - the panel puts every one of a device's browser tabs
 * in a SINGLE independent session, so a device costs one stream however many
 * rows it holds. That is the other cap's twin, and the two are about different
 * ceilings: `LANDING_BROWSER_TAB_CAP` (8, in `use-landing-browser-open-tab.tsx`)
 * restates the HOST's per-session tab limit, while this one is a budget against
 * the DESKTOP's `MAX_STREAMS_PER_WINDOW` (12, in
 * `clients/desktop/src/electron-main/browser-sessions/browser-sessions-owner.ts`).
 * A stream is a socket, a relay attach, an identity attestation and a whole
 * contributed-set replay, and the desktop refuses whichever was asked for LAST -
 * so an unbounded strip can cost the reader the tab on screen, or a task
 * canvas tile, for rows nobody is looking at.
 *
 * Four leaves the window room for the canvas tiles it also has to serve.
 */
export const LANDING_BROWSER_WATCHED_HOST_CAP = 4;

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
 * Two devices are pinned and always mounted:
 *
 * - the routing TARGET, whether or not it has a tab: creating a browser tab
 *   goes through that device's coordinator, so `app.browser.new` and the
 *   chooser's tab-cap count both need it mounted before the first tab exists,
 *   and both work while the panel is collapsed;
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
  /** The panel is open on a Start Page that is on screen. */
  readonly panelWatching: boolean;
}): ReadonlyArray<string> {
  const watched: Array<string> = [];
  const add = (hostId: string | null): void => {
    if (hostId === null || watched.includes(hostId)) return;
    watched.push(hostId);
  };
  add(args.targetHostId);
  // Collapsed, or a backgrounded Start Page: nothing of those devices is
  // rendered, so nothing needs their inventory. Today's rule, unchanged.
  if (!args.panelWatching) return watched;
  add(args.activeBrowserHostId);
  // The pinned two count against the cap - the bound is on what this window
  // holds, not on what it holds beyond the ones it must.
  for (const hostId of [...args.recentlyActivatedHostIds, ...args.tabHostIds]) {
    if (watched.length >= LANDING_BROWSER_WATCHED_HOST_CAP) break;
    add(hostId);
  }
  return watched;
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

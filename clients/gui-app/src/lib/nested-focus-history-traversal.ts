import type { HistoryLocation, RouterHistory } from "@tanstack/react-router";
import { parseEpicTabHref } from "@/lib/history-navigation";
import { parseNestedFocusTargetFromHref } from "@/lib/epic-nested-focus-route";
import {
  markExplicitNestedFocusIntent,
  markReturnedToNestedFocusRequest,
} from "@/lib/nested-focus-navigation-intent";

/**
 * What a committed history destination says about a pending artifact-focus
 * request, which is the one question this module answers.
 *
 * A history step reaches the route without passing `navigateNestedFocus`, so
 * nothing on that path declares provenance of its own. The route's pending
 * request samples whether a nested target was present when its key FIRST
 * arrived, and a history move keeps that key - same `focusArtifactId`, same
 * `focusedAt` - so the sample is never recut. Both answers below exist because
 * of that: the request cannot tell from its own key that the person has moved.
 */
type TraversedFocusDecision =
  /** The destination names a tile. Landing on it is choosing it. */
  | "chose-tile"
  /**
   * The destination carries the request itself and names no tile - the person
   * has come back TO the request.
   *
   * This RESTORES the request rather than merely leaving it alone, and the
   * difference is load-bearing. Abstaining is not enough once anything has
   * already retired it: retirement is `lastIntentSeq > baseline.lastIntentSeq`
   * against a baseline captured when the key first arrived and never recut, so
   * a stamp left by an earlier traversal keeps the request retired for as long
   * as the key lives, and the auto-open SPENDS its key on retirement so a late
   * record cannot revive it. A person who asks for an artifact, has two tiles
   * open automatically over it, and presses Back twice lands here - and would
   * otherwise find the artifact they asked for permanently cancelled by their
   * own first Back.
   *
   * It is recorded as its own positive stamp, never as the absence of a
   * choice: absence is what a DROPPED stamp looks like, and route sync drops
   * one on every root `StrictMode` replay, so reading a return off absence
   * would make a dev-mode replay revive a request the person had left.
   */
  | "returned-to-request"
  /** Nothing about a focus request. */
  | "nothing";

interface EpicTabFocusDestination {
  readonly epicId: string;
  readonly tabId: string;
  readonly decision: TraversedFocusDecision;
}

function hrefSearchParams(href: string): URLSearchParams {
  const queryStart = href.indexOf("?");
  if (queryStart === -1) return new URLSearchParams();
  const hashStart = href.indexOf("#", queryStart);
  return new URLSearchParams(
    hashStart === -1
      ? href.slice(queryStart + 1)
      : href.slice(queryStart + 1, hashStart),
  );
}

function readFocusDestination(href: string): EpicTabFocusDestination | null {
  const epicTab = parseEpicTabHref(href);
  if (epicTab === null) return null;
  const decision = ((): TraversedFocusDecision => {
    if (parseNestedFocusTargetFromHref(href) !== null) return "chose-tile";
    const requested = hrefSearchParams(href).get("focusArtifactId");
    return requested === null || requested.length === 0
      ? "nothing"
      : "returned-to-request";
  })();
  return { epicId: epicTab.epicId, tabId: epicTab.tabId, decision };
}

/**
 * Whether this notification is the history MOVING through its own entries,
 * rather than the app writing a new one.
 *
 * `PUSH` and `REPLACE` are writes, and the ones that matter most here are the
 * app's own: `replaceNestedFocusRoute` writes the route on every tile focus,
 * including the automatic commit that SERVES a pending request, so reading a
 * write as a person's traversal would make the request retire itself the
 * moment it was answered.
 *
 * An allow-list rather than `!== "PUSH"`, so a history action added later is
 * not silently read as a person's intent.
 */
function isHistoryTraversalAction(type: string): boolean {
  return type === "BACK" || type === "FORWARD" || type === "GO";
}

/**
 * The identity of the entry a location sits on, for deciding whether the
 * history actually MOVED.
 *
 * A traversal action is not proof that anything committed, and both backends
 * prove it:
 *
 * - `createMemoryHistory` clamps (`index = Math.max(index - 1, 0)`), and
 *   `createHistory.back` then calls `handleIndexChange`, which notifies
 *   `BACK` with the location unchanged. A Back at the first entry, a Forward
 *   at the last, and `go(0)` all notify while standing still.
 * - `createBrowserHistory`'s blocked-pop branch rolls the move back and calls
 *   `history.notify` with the traversal action while `currentLocation` is
 *   still the OLD location - so a refused step notifies, and the href it
 *   carries is where the person came FROM.
 *
 * Retiring a request on either would cancel the artifact the route was opening
 * because a step did NOT happen. So movement is read from the entry's own
 * identity: `__TSR_key` is minted per entry, which is what distinguishes two
 * entries sharing an href. Index plus href is the fallback for a state older
 * than the key.
 */
function entryIdentity(location: HistoryLocation): string {
  const state = location.state;
  const key = state.__TSR_key ?? state.key ?? null;
  if (key !== null && key.length > 0) return `key:${key}`;
  return `index:${String(state.__TSR_index)}|${location.href}`;
}

/**
 * Observe every history traversal's committed destination, for the life of the
 * router, and keep a pending artifact-focus request in step with where the
 * person actually is.
 *
 * Why observation rather than prediction. A step could be predicted on the
 * branded backend, which owns its entry list and can name the landing first.
 * Two kinds of traversal are outside that:
 *
 * 1. The browser web app's plain history exposes no entries and no index, so
 *    the landing is genuinely unknowable before the move. It was left
 *    uncovered for exactly that reason, which left the defect live on the web.
 * 2. On that same plain history, the BROWSER's own back and forward - its
 *    buttons, its keyboard shortcut - move the stack without this app's
 *    commands being called at all. The desktop and phone gestures are NOT in
 *    this set: `DesktopHistorySwipes` and the mobile swipe both go through
 *    `goBack`/`goForward`, and the branded memory stack is not moved by the
 *    browser's own navigation.
 *
 * Both are answered by reading what happened: the notification says whether
 * the history traversed, the entry identity says whether it moved, and
 * `location.href` is the destination it committed to. Nothing is guessed and
 * no timer is involved - a traversal that does not happen simply leaves the
 * identity where it was.
 *
 * This is the ONLY point that claims a traversal's intent, which is why
 * `navigateHistory` makes no prediction of its own. It does not need to: this
 * observer is subscribed in `createAppRouter`, before `<RouterProvider>`'s
 * transitioner effect subscribes the router's own loader, and `createHistory`'s
 * `notify` walks its insertion-ordered subscriber set synchronously - so it has
 * already decided before the route reacts to the landing, on the branded
 * backend as much as the plain one.
 *
 * Returns the unsubscribe, for a router that is torn down.
 */
export function observeNestedFocusTraversals(
  history: RouterHistory,
): () => void {
  let lastIdentity = entryIdentity(history.location);
  return history.subscribe(({ location, action }) => {
    const identity = entryIdentity(location);
    const moved = identity !== lastIdentity;
    // Updated for EVERY notification, writes included: a push is where the
    // next traversal is measured from, so skipping it here would compare a
    // later landing against an entry the person has long since left.
    lastIdentity = identity;
    if (!moved || !isHistoryTraversalAction(action.type)) return;
    const destination = readFocusDestination(location.href);
    if (destination === null) return;
    if (destination.decision === "chose-tile") {
      markExplicitNestedFocusIntent(destination.epicId, destination.tabId);
      return;
    }
    if (destination.decision === "returned-to-request") {
      markReturnedToNestedFocusRequest(destination.epicId, destination.tabId);
    }
  });
}

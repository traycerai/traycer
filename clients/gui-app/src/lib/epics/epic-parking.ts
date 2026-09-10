/**
 * Renderer parking: the per-epic "nobody is looking at this" signal, and the
 * release it drives (plan C, decisions C1, C3, C5, C6).
 *
 * ## What parking is
 *
 * An epic tab that is not in front stays OPEN - that is what makes coming back
 * to it instant - and an open tab holds `epic.subscribe`, a `chat.subscribe`
 * per chat tile, artifact-body leases, and two 20 s record polls. Every one of
 * those claims a VISIBLE lease on the epic's slot on the host, and a slot with
 * any visible lease is never evictable. So a hidden tab pins its epic - its
 * artifact rooms, its cloud connection, its file sync - for as long as the tab
 * exists, which on staging was 210 MB of rooms resident for epics nobody had
 * looked at.
 *
 * Parking releases all of it and keeps the tab. The tab strip, the canvas
 * layout, the tile set, the drafts - everything the canvas store holds - are
 * untouched, because none of them are subscriptions. What ends is the session,
 * and with it the runtime worker and the replica this window was holding.
 *
 * ## The key is the OPEN TAB, not a mounted surface
 *
 * This module used to be driven by `EpicSurface` mounting and unmounting, and
 * that key silently exempted the population it most needed to reach.
 * `TopLevelTabHost` keeps at most `retainedTopLevelSurfaces` (5) surfaces
 * mounted; a hidden tab past that is UNMOUNTED, its provider's `releaseMounted`
 * drops demand to zero, and its session goes WARM with `epic.subscribe` still
 * open - up to `maxLiveEpics` (5) such sessions. That stream is a visible lease
 * the host's own idle sweep can never reach, and a decider keyed on a mounted
 * provider had no entry for it at all. It is also the wrong key on its face: a
 * tab whose surface was unmounted for lack of retention is hidden BY
 * DEFINITION.
 *
 * So the entries here mirror the open epic tabs of this window - the canvas
 * store's `openTabOrder`, the same projection `releaseOpenEpicSessionIfUnused`
 * reads, fed in by `lib/epics/epic-parking-open-tabs.ts` - and a park releases
 * the session whether it was mounted or warm. A tab that is CLOSED is not
 * parked: it is closed, and its session is the tab-close path's to release.
 *
 * ## Why the debounce is per EPIC, not per tab
 *
 * Decision C6: an epic shown in a second pane is foreground, and one visible
 * pane anywhere is enough. Two sources answer that, and this module ORs them:
 * the visible-view registry in
 * `lib/browser-view/tiles/surface-host-opened-tab.ts` for this window's own
 * panes, and `lib/epics/cross-window-epic-visibility.ts` for every other
 * window's. Both are keyed by epic and already visible-if-any, so this module
 * is their roll-up plus a clock, not a third source of truth about visibility.
 * The one thing neither source can see is the WINDOW: a pane in front of a
 * minimised window is placed, not on screen, so this window's own arm is also
 * gated on `lib/dom/document-visibility.ts` (see `isEpicVisibleAnywhere`).
 *
 * The cross-window arm is a real channel (main-process state fed by each
 * renderer's own roll-up over IPC), deliberately NOT `ownership.snapshot()`:
 * ownership is async, keys on `tabId`, and reports every tab for the epic
 * including hidden ones, so reading it as visibility would turn "another window
 * is SHOWING this" into "another window has it OPEN" and disable parking for
 * the whole multi-window case. Off the desktop shell - a browser, or a preload
 * built before the channel existed - that arm answers `false` and the decision
 * degrades to this window's panes, which is the right answer where there is no
 * second window.
 *
 * ## Why THIS module decides, and the provider only reacts
 *
 * Parking has to be decided once per epic, and an epic can have several
 * `EpicSessionProvider`s (two header views of one task). If each provider ran
 * its own timer and its own eligibility check they would disagree during the
 * window where one has parked and another has not, and the gates that read
 * "is this epic parked" - the record polls, the chat tiles, the hosted-surface
 * membership - would see a per-provider answer to a per-epic question. A warm
 * session has no provider at all, which settles it: the decision lives here,
 * this module runs the clock, asks the session registry whether the epic MAY be
 * parked, performs the release, and publishes one boolean. Providers observe it
 * and drop their own references.
 *
 * ## Eligibility is the registry's, not a second opinion
 *
 * "A tab with unsynced edits or an in-progress action is not parked. The
 * renderer's own prune already skips dirty and active entries; parking uses the
 * same eligibility." `OpenEpicSessionRegistry.park` is the one predicate; a
 * refusal here is not a failure, it is "not yet", and the epic is parked as
 * soon as the registry says the work has settled.
 *
 * That eligibility FAILS CLOSED on the agent-activity plane: `epicIsBusy` reads
 * every epic as busy while the plane cannot answer (the stream is closed, or
 * its union does not reach the session's host), so an activity-plane outage
 * defers ALL parking until it recovers. Accepted deliberately, and not softened
 * here: it is the identical gate the prune walk applies, and a second opinion
 * about "is an agent working" is exactly the drift that would let a park
 * destroy a turn in progress. The cost of an outage is that memory is not
 * reclaimed for its duration - the pre-parking behaviour, and recoverable -
 * where the cost of guessing wrong the other way is not.
 *
 * The one input to that verdict this window owns rather than the host is
 * `lib/epics/epic-draft-guard.ts`: unsaved user-typed text in an editor the
 * release would UNMOUNT. It is still not a second opinion - `canPark` reads it
 * as one more gate, and this module only WATCHES it, exactly as it watches the
 * registry's own eligibility edge, because a park refused for a draft has to
 * re-attempt when that draft settles.
 *
 * ## What parking does NOT have to release
 *
 * `BrowserSessionsProvider` sits outside the session gate in
 * `epic-surface.tsx` and keeps its epic-scoped `browser.sessions` stream open
 * through a park. That is fine: on the host side the browser stream resolver
 * takes NO epic lease of any kind - its dependencies are the browser session
 * manager and a logger, and the epic scope is a pure FILTER over which sessions
 * a subscriber is shown (`host-resource-scope-match.ts`), with nothing reaching
 * `EpicMemoryManager`. So it pins no slot and there is nothing here to release.
 */
import {
  isEpicSurfaceVisible,
  subscribeEpicSurfaceVisibility,
} from "@/lib/browser-view/tiles/surface-host-opened-tab";
import {
  isDocumentVisible,
  subscribeDocumentVisibility,
} from "@/lib/dom/document-visibility";
import { subscribeEpicDraftGuard } from "@/lib/epics/epic-draft-guard";
import {
  isEpicVisibleInAnotherWindow,
  subscribeCrossWindowEpicVisibility,
} from "@/lib/epics/cross-window-epic-visibility";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { subscribeAgentActivity } from "@/stores/agent-activity-store";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
import { PARK_HIDDEN_EPIC_AFTER_MS } from "@/stores/replica-memory/retention-profile";
import { useCallback, useSyncExternalStore } from "react";
import type { RuntimeTimer } from "@traycer-clients/shared/replica-runtime";

/**
 * The clock and the scheduler, through the runtime environment rather than
 * `window` - the same reason every other timer under the epic runtime does it,
 * and one that bites harder here: the window this measures elapses while the
 * tab is in the BACKGROUND, where browsers throttle timers to about once a
 * minute. A timer firing is therefore not proof the window elapsed, which is
 * why {@link parkWindowElapsed} re-reads the clock and re-arms for the
 * remainder instead of trusting the callback.
 */
const environment = createRendererRuntimeEnvironment();

interface EpicParkingEntry {
  /**
   * When the current hidden window started, or `null` when no window is in
   * progress (the epic is visible, or it is already parked).
   *
   * The elapsed test reads this rather than the timer having fired - see
   * {@link environment}.
   */
  hiddenSinceMs: number | null;
  timer: RuntimeTimer | null;
  /**
   * Live subscription to the session registry while a park is WAITING on
   * eligibility - the epic went unwatched but holds unsynced edits or has an
   * agent working. The registry emits when either changes, which is the
   * moment to try again; polling for it would be a second clock measuring
   * something the registry already announces.
   */
  unwatchEligibility: (() => void) | null;
  parked: boolean;
}

/**
 * One entry per OPEN epic tab of this window, keyed by epic. Mirrored from the
 * canvas store by {@link syncOpenEpics}; an epic with no open tab has no entry,
 * because it is closed rather than parked.
 */
const entries = new Map<string, EpicParkingEntry>();
const listeners = new Set<(epicId: string) => void>();

function notify(epicId: string): void {
  for (const listener of Array.from(listeners)) {
    listener(epicId);
  }
}

/**
 * Decision C6's visible-if-any, over both windows and panes. Either arm alone
 * is a partial answer: the local registry cannot see another renderer, and the
 * cross-window map deliberately excludes this window's own row.
 *
 * The document gate binds THIS WINDOW'S arm only, and the placement of that
 * `&&` is the whole point. `isEpicSurfaceVisible` answers "which pane is in
 * front" and cannot see the window, so a minimized app's front pane claims to
 * be on screen forever and the clock below never starts. But a window that
 * cannot see itself still cannot speak for ANOTHER one: gating the whole
 * expression would park an epic a second window has open on screen, which is
 * exactly what C6's second arm exists to prevent. So: hidden window, no claim
 * of our own; other windows keep theirs.
 *
 * The two halves stay consistent because the same conjunction governs what we
 * REPORT - `cross-window-epic-visibility.ts` sends the empty set while hidden -
 * so a hidden window withdraws its claim here and there in one move.
 */
function isEpicVisibleAnywhere(epicId: string): boolean {
  return (
    (isDocumentVisible() && isEpicSurfaceVisible(epicId)) ||
    isEpicVisibleInAnotherWindow(epicId)
  );
}

function cancelParkWindow(entry: EpicParkingEntry): void {
  entry.timer?.cancel();
  entry.timer = null;
  entry.hiddenSinceMs = null;
}

function stopWatchingEligibility(entry: EpicParkingEntry): void {
  entry.unwatchEligibility?.();
  entry.unwatchEligibility = null;
}

function scheduleParkCheck(
  epicId: string,
  entry: EpicParkingEntry,
  delayMs: number,
): void {
  entry.timer = environment.scheduler.schedule(delayMs, () => {
    entry.timer = null;
    parkWindowElapsed(epicId, entry);
  });
}

function armParkWindow(epicId: string, entry: EpicParkingEntry): void {
  entry.timer?.cancel();
  entry.hiddenSinceMs = environment.clock.now();
  scheduleParkCheck(epicId, entry, PARK_HIDDEN_EPIC_AFTER_MS);
}

function parkWindowElapsed(epicId: string, entry: EpicParkingEntry): void {
  const hiddenSinceMs = entry.hiddenSinceMs;
  if (hiddenSinceMs === null) return;
  if (isEpicVisibleAnywhere(epicId)) return;
  const nowMs = environment.clock.now();
  const elapsedMs = nowMs - hiddenSinceMs;
  // A clock that stepped BACKWARD - an NTP correction, a resume from sleep,
  // the user setting the clock - leaves a baseline in the future. Re-base it
  // and start a fresh window from the corrected clock.
  //
  // The shared session registry clamps this case instead (`Math.max(0, …)` on
  // its own remainder) and this deliberately does not, because the clamp only
  // bounds ONE re-arm: the baseline stays in the future, so the next callback
  // reads a negative elapsed again and arms another full window, and another,
  // until the clock catches up. A one-hour backward step therefore delays a
  // park by about an hour in five-minute rounds, where re-basing delays it by
  // one window. The registry's clamp is sound for a ten-minute TTL that also
  // re-arms from a demand transition; nothing re-arms this one but the clock.
  if (elapsedMs < 0) {
    entry.hiddenSinceMs = nowMs;
    scheduleParkCheck(epicId, entry, PARK_HIDDEN_EPIC_AFTER_MS);
    return;
  }
  // The remainder, never a fresh window: a background tab's throttled timer
  // fires late as often as early, and re-arming the full window on an early
  // fire would double the time an unwatched epic stays resident.
  if (elapsedMs < PARK_HIDDEN_EPIC_AFTER_MS) {
    scheduleParkCheck(epicId, entry, PARK_HIDDEN_EPIC_AFTER_MS - elapsedMs);
    return;
  }
  attemptPark(epicId, entry);
}

/**
 * Release the epic if the registry allows it, otherwise wait for the work it
 * is holding to settle.
 *
 * The eligibility watch is dropped BEFORE the attempt rather than after it:
 * `park` notifies the registry's subscribers from inside its own transaction,
 * so a watch still installed would re-enter this function while the successful
 * park is still unwinding.
 */
function attemptPark(epicId: string, entry: EpicParkingEntry): void {
  stopWatchingEligibility(entry);
  if (!getOpenEpicRegistry().park(epicId)) {
    waitForEligibility(epicId, entry);
    return;
  }
  entry.hiddenSinceMs = null;
  if (entry.parked) return;
  entry.parked = true;
  notify(epicId);
}

/**
 * The window has elapsed and the epic still holds work. Wait to be told it has
 * settled rather than re-arming a clock: both sources below emit on exactly
 * the facts `canPark` reads, so a timer here would be a second, slower way of
 * learning something we are told.
 *
 * TWO sources for one verdict, because `canPark` has two kinds of input. The
 * registry emits on the session's own work - unsynced edits, an agent's turn.
 * The draft guard emits on the RENDERER's: text sitting in a composer that
 * this park would unmount out of existence (`lib/epics/epic-draft-guard.ts`),
 * which the epic store never hears about and the registry therefore cannot
 * announce. A park deferred for a draft has to re-attempt when that draft is
 * submitted or cleared, and nothing else would ever wake it: the hide edge
 * that armed the window has already happened and may never happen again.
 */
function waitForEligibility(epicId: string, entry: EpicParkingEntry): void {
  if (entry.unwatchEligibility !== null) return;
  const retry = (): void => {
    if (entry.parked) return;
    if (isEpicVisibleAnywhere(epicId)) return;
    attemptPark(epicId, entry);
  };
  const unwatchRegistry = getOpenEpicRegistry().subscribe(retry);
  const unwatchDrafts = subscribeEpicDraftGuard((changedEpicId) => {
    if (changedEpicId !== epicId) return;
    retry();
  });
  entry.unwatchEligibility = () => {
    unwatchRegistry();
    unwatchDrafts();
  };
}

/**
 * Re-attempt every park this window deferred for want of eligibility.
 *
 * The watch above listens to the OPEN-EPIC registry, which emits off a
 * per-session eligibility key - so it is silent for precisely the case that
 * needs it most: an epic with no session entry of its own, whose park was
 * refused because its CHATS still held work. Nothing about that epic will ever
 * move the open-epic registry, and the park window has already elapsed, so
 * without this the deferral is permanent and the epic is never reclaimed.
 *
 * Called by the plane that just settled, from
 * `lib/registries/chat-session-registry.ts` - which owns the cross-plane wiring
 * because it is downstream of both and can import either without closing a
 * cycle.
 */
let retryingDeferredParks = false;

export function retryDeferredEpicParks(): void {
  // RE-ENTRANT BY CONSTRUCTION, and guarded rather than reasoned about: this
  // runs on the chat registry's change signal, and a park that SUCCEEDS here
  // disposes that epic's chats, which makes the chat registry emit again from
  // inside this very loop. The recursion terminates on its own - a parked entry
  // short-circuits and there are finitely many - but the cost of being wrong
  // about that is a hung renderer, and the cost of the guard is a boolean.
  if (retryingDeferredParks) return;
  retryingDeferredParks = true;
  try {
    retryDeferredEpicParksOnce();
  } finally {
    retryingDeferredParks = false;
  }
}

function retryDeferredEpicParksOnce(): void {
  for (const [epicId, entry] of Array.from(entries)) {
    // Only epics whose window has already elapsed and whose park was refused;
    // an entry still counting down keeps its timer.
    if (entry.unwatchEligibility === null) continue;
    if (entry.parked) continue;
    if (isEpicVisibleAnywhere(epicId)) continue;
    attemptPark(epicId, entry);
  }
}

/**
 * A provider found a live session under a parked epic and could not release
 * it, so the epic is not parked after all.
 *
 * Reachable in one narrow order and worth naming, because the alternative is
 * silent: the release happens when the window elapses, and a session acquired
 * AFTER it - a host that only answered once the epic had already sat unwatched
 * for five minutes - is a live subscription under a parked flag. The provider
 * re-asserts the release for that case; when the re-assertion is refused (the
 * epic became dirty or busy in the same gap) the signal has to come back down,
 * or every gate reading it would stay shut over a session that is still
 * streaming.
 *
 * Withdrawing, not deferring: the retry belongs to the eligibility watch, which
 * is armed here and fires on the registry's own signal.
 */
export function reportEpicParkRefused(epicId: string): void {
  const entry = entries.get(epicId);
  if (entry === undefined) return;
  waitForEligibility(epicId, entry);
  if (!entry.parked) return;
  entry.parked = false;
  notify(epicId);
}

function unpark(epicId: string, entry: EpicParkingEntry): void {
  cancelParkWindow(entry);
  stopWatchingEligibility(entry);
  if (!entry.parked) return;
  entry.parked = false;
  notify(epicId);
}

function epicVisibilityChanged(epicId: string): void {
  const entry = entries.get(epicId);
  if (entry === undefined) return;
  if (isEpicVisibleAnywhere(epicId)) {
    unpark(epicId, entry);
    return;
  }
  if (entry.parked) return;
  // Already counting: a second hidden edge (this window's last pane hid, and
  // moments later the other window's did too) must not restart the window the
  // first one armed.
  if (entry.hiddenSinceMs !== null) return;
  armParkWindow(epicId, entry);
}

/**
 * Bring the entry set in line with the open tabs: arm a window for an epic that
 * just opened hidden, and forget one whose last tab closed.
 *
 * TOLD the set rather than reading it, which is what keeps this module a leaf.
 * `lib/epics/epic-parking-open-tabs.ts` owns the canvas-store projection and
 * calls this; the split is not cosmetic, because the release side of parking
 * (`lib/registries/chat-session-registry.ts`) imports THIS module at module
 * scope, and that import is reached from anything that touches a chat. Reading
 * the canvas store here would put a large store into that graph at import time.
 *
 * The hidden-from-birth arm is not an optimisation. Visibility notifications
 * only fire on a CHANGE, and a tab opened in the background never has one - it
 * reports `false` at mount and the epic's roll-up was already `false` - so
 * without an arm here those epics would be the only ones that never park,
 * which is precisely the population parking exists for. The same is true of a
 * tab restored behind the front one, and of every tab past the retention pool
 * on a cold restore.
 */
export function syncEpicParkingOpenTabs(open: ReadonlySet<string>): void {
  for (const epicId of open) {
    if (entries.has(epicId)) continue;
    const entry: EpicParkingEntry = {
      hiddenSinceMs: null,
      timer: null,
      unwatchEligibility: null,
      parked: false,
    };
    entries.set(epicId, entry);
    if (isEpicVisibleAnywhere(epicId)) continue;
    armParkWindow(epicId, entry);
  }
  for (const [epicId, entry] of Array.from(entries)) {
    if (open.has(epicId)) continue;
    // The epic is CLOSED, not parked: its session is the tab-close path's to
    // release (`releaseOpenEpicSessionIfUnused`), and leaving a parked flag
    // behind would answer for an epic that is no longer open at all - and
    // would be read as parked by the next tab opened for it, before any window
    // had elapsed.
    entries.delete(epicId);
    cancelParkWindow(entry);
    stopWatchingEligibility(entry);
    if (!entry.parked) continue;
    entry.parked = false;
    notify(epicId);
  }
}

/** Whether this epic's subscriptions are currently released. */
export function isEpicParked(epicId: string): boolean {
  return entries.get(epicId)?.parked ?? false;
}

/**
 * Watch parking transitions. The listener is handed the epic whose state
 * changed, so a plane that reacts per epic (the chat session registry's
 * release, the hosted-surface membership recompute) does not have to diff.
 */
export function subscribeEpicParking(
  listener: (epicId: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React binding for {@link isEpicParked}. */
export function useEpicParked(epicId: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeEpicParking(() => {
        onStoreChange();
      }),
    [],
  );
  const getSnapshot = useCallback(() => isEpicParked(epicId), [epicId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * Forget every epic, and every timer and registry watch they are holding.
 *
 * `listeners` is deliberately NOT cleared. Two of its members are module-scope
 * subscriptions registered at import time - the chat session registry's
 * release and the hosted-surface membership recompute - and nothing
 * re-registers them, so clearing here would silently disarm both halves of the
 * release for the whole of the rest of the file. A suite would then watch the
 * parked flag flip and see no subscriptions go, with every assertion about the
 * signal itself still passing.
 */
export function __resetEpicParkingForTests(): void {
  for (const entry of entries.values()) {
    cancelParkWindow(entry);
    stopWatchingEligibility(entry);
  }
  entries.clear();
}

subscribeEpicSurfaceVisibility(epicVisibilityChanged);
subscribeCrossWindowEpicVisibility(epicVisibilityChanged);
// The window itself hiding or returning. FAN-OUT over every entry, unlike the
// two above, because this edge carries no epic: minimizing withdraws this
// window's claim to all of them at once, and restoring returns it. Routing it
// through the same per-epic handler is what makes a document-hidden park
// indistinguishable from a tab-hidden one - same arming, same cancel on the
// way back (`unpark` clears a pending window before anything else), and the
// same seeded reopen afterwards, rather than a second path to keep in step.
subscribeDocumentVisibility(() => {
  for (const epicId of Array.from(entries.keys())) {
    epicVisibilityChanged(epicId);
  }
});
// The THIRD input to `canPark` that can settle on its own, and the one with no
// other route back here. `waitForEligibility` listens to the open-epic
// registry, whose eligibility key is emitted per SESSION - so an epic with no
// session entry, refused because the activity plane was unanswered or did not
// cover one of its chats' hosts, has nothing that would ever tell it the plane
// recovered. The plane failing closed is deliberate; staying deferred after it
// reopens is not.
subscribeAgentActivity(() => {
  retryDeferredEpicParks();
});

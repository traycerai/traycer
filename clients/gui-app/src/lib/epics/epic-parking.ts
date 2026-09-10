/**
 * Renderer parking: the per-epic "nobody is looking at this" signal, and the
 * release it drives (plan C, decisions C1, C3, C5, C6).
 *
 * ## What parking is
 *
 * An epic tab that is not in front stays MOUNTED - that is what makes coming
 * back to it instant - and a mounted tab holds `epic.subscribe`, a
 * `chat.subscribe` per chat tile, artifact-body leases, and two 20 s record
 * polls. Every one of those claims a VISIBLE lease on the epic's slot on the
 * host, and a slot with any visible lease is never evictable. So a hidden tab
 * pins its epic - its artifact rooms, its cloud connection, its file sync -
 * for as long as the tab exists, which on staging was 210 MB of rooms resident
 * for epics nobody had looked at.
 *
 * Parking releases all of it and keeps the tab. The tab strip, the canvas
 * layout, the tile set, the drafts - everything the canvas store holds - are
 * untouched, because none of them are subscriptions. What ends is the session,
 * and with it the runtime worker and the replica this window was holding.
 *
 * ## Why the debounce is per EPIC, not per tab
 *
 * Decision C6: an epic shown in a second pane is foreground, and one visible
 * pane anywhere is enough. The visible-view registry in
 * `lib/browser-view/tiles/surface-host-opened-tab.ts` answers exactly that
 * question - it is keyed by epic and view tab and is already visible-if-any -
 * so this module is its roll-up plus a clock, not a second source of truth
 * about visibility.
 *
 * ## The roll-up spans VIEWS, not desktop windows - a known limitation
 *
 * C6 says "no visible pane for that epic in ANY window", and this reaches only
 * the panes of ONE renderer. The visible-view registry is module state, each
 * Electron `BrowserWindow` is its own renderer, and desktop epic ownership
 * does NOT make that difference unobservable: `EpicWindowOwnership.claim`
 * keys on `tabId`, not `epicId` (`getOwnerForEpic` exists and the claim path
 * does not consult it), so two windows can hold live sessions for one epic at
 * the same time. Window A can therefore park an epic that window B is showing.
 *
 * What that costs is bounded, and it is not the thing this plan exists to fix.
 * Parking releases only the PARKING window's own subscriptions; window B keeps
 * its session, its visible lease and therefore the host's slot, so no memory
 * claim in plan C depends on A and B agreeing. The cost is that switching back
 * to A re-establishes - against a host slot B is holding warm, which is the
 * sub-second seed-hydrate path decision C5 already accepts.
 *
 * Closing it properly means propagating the roll-up through the desktop main
 * process, which is a `clients/desktop` change (main-process state, an IPC
 * channel, a preload bridge, and a browser fallback) and deliberately outside
 * this ticket. Do not "fix" it by reading `ownership.snapshot()` here: that is
 * async and reports every tab for the epic, hidden ones included, so it would
 * turn "another window is SHOWING this" into "another window has it OPEN" and
 * disable parking for the whole multi-window case.
 *
 * ## Why THIS module decides, and the provider only reacts
 *
 * Parking has to be decided once per epic, and an epic can have several
 * `EpicSessionProvider`s (two header views of one task). If each provider ran
 * its own timer and its own eligibility check they would disagree during the
 * window where one has parked and another has not, and the gates that read
 * "is this epic parked" - the record polls, the chat tiles, the hosted-surface
 * membership - would see a per-provider answer to a per-epic question. So the
 * decision lives here: this module runs the clock, asks the session registry
 * whether the epic MAY be parked, performs the release, and publishes one
 * boolean. Providers observe it and drop their own references.
 *
 * ## Eligibility is the registry's, not a second opinion
 *
 * "A tab with unsynced edits or an in-progress action is not parked. The
 * renderer's own prune already skips dirty and active entries; parking uses
 * the same eligibility." `OpenEpicSessionRegistry.parkMounted` is the one
 * predicate; a refusal here is not a failure, it is "not yet", and the epic is
 * parked as soon as the registry says the work has settled.
 */
import {
  isEpicSurfaceVisible,
  subscribeEpicSurfaceVisibility,
} from "@/lib/browser-view/tiles/surface-host-opened-tab";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
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
   * View tabs currently mounting a surface for this epic, in ANY window of
   * this renderer.
   *
   * Tracked separately from the visible-view set because the two answer
   * different questions and only this one bounds the entry's life: a hidden
   * surface is absent from the visible set and present here, so "no visible
   * pane" and "no pane at all" would be the same reading if this module tried
   * to derive both from visibility. An epic whose last surface unmounts is
   * CLOSED, not parked, and its entry is forgotten.
   */
  readonly surfaces: Set<string>;
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

const entries = new Map<string, EpicParkingEntry>();
const listeners = new Set<(epicId: string) => void>();

function notify(epicId: string): void {
  for (const listener of Array.from(listeners)) {
    listener(epicId);
  }
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
  if (isEpicSurfaceVisible(epicId)) return;
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
 * `parkMounted` notifies the registry's subscribers from inside its own
 * transaction, so a watch still installed would re-enter this function while
 * the successful park is still unwinding.
 */
function attemptPark(epicId: string, entry: EpicParkingEntry): void {
  stopWatchingEligibility(entry);
  if (!getOpenEpicRegistry().parkMounted(epicId)) {
    waitForEligibility(epicId, entry);
    return;
  }
  entry.hiddenSinceMs = null;
  if (entry.parked) return;
  entry.parked = true;
  notify(epicId);
}

/**
 * The window has elapsed and the epic still holds work. Wait for the registry
 * to say it has settled rather than re-arming a clock: the registry already
 * emits on exactly the two facts `canPark` reads, so a timer here would be a
 * second, slower way of learning something we are told.
 */
function waitForEligibility(epicId: string, entry: EpicParkingEntry): void {
  if (entry.unwatchEligibility !== null) return;
  entry.unwatchEligibility = getOpenEpicRegistry().subscribe(() => {
    if (entry.parked) return;
    if (isEpicSurfaceVisible(epicId)) return;
    attemptPark(epicId, entry);
  });
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

function epicSurfaceVisibilityChanged(epicId: string): void {
  const entry = entries.get(epicId);
  if (entry === undefined) return;
  if (isEpicSurfaceVisible(epicId)) {
    unpark(epicId, entry);
    return;
  }
  if (entry.parked) return;
  armParkWindow(epicId, entry);
}

/**
 * Register a mounted epic surface (one `EpicSurface`, i.e. one view tab of one
 * epic) for the life of that surface. Returns the deregistration.
 *
 * This is what starts the clock for a tab that is hidden FROM BIRTH - a task
 * opened into a background tab, or restored behind the front one. Visibility
 * notifications only fire on a change, and such a surface never has one: it
 * reports `false` at mount and the epic's roll-up was already `false`. Without
 * an arm here those epics would be the only ones that never park, which is
 * precisely the population parking exists for.
 */
export function trackEpicParkingSurface(
  epicId: string,
  viewTabId: string,
): () => void {
  let entry = entries.get(epicId);
  if (entry === undefined) {
    entry = {
      surfaces: new Set<string>(),
      hiddenSinceMs: null,
      timer: null,
      unwatchEligibility: null,
      parked: false,
    };
    entries.set(epicId, entry);
  }
  const tracked = entry;
  tracked.surfaces.add(viewTabId);
  if (
    !tracked.parked &&
    tracked.hiddenSinceMs === null &&
    !isEpicSurfaceVisible(epicId)
  ) {
    armParkWindow(epicId, tracked);
  }
  return () => {
    if (entries.get(epicId) !== tracked) return;
    tracked.surfaces.delete(viewTabId);
    if (tracked.surfaces.size > 0) return;
    // The epic is CLOSED, not parked: its session is the tab-close path's to
    // release (`releaseOpenEpicSessionIfUnused`), and leaving a parked flag
    // behind would answer for an epic that is no longer open at all - and
    // would be read as parked by the next surface to mount for it, before any
    // window had elapsed.
    entries.delete(epicId);
    cancelParkWindow(tracked);
    stopWatchingEligibility(tracked);
    if (!tracked.parked) return;
    tracked.parked = false;
    notify(epicId);
  };
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

subscribeEpicSurfaceVisibility(epicSurfaceVisibilityChanged);

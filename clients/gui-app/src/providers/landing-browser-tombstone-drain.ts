import { useEffect, useRef, useState } from "react";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import type { LandingBrowserSessionEntries } from "@/components/home/terminal-panel/landing-terminal-authority-fleet";
import {
  landingTabRefKey,
  useLandingPanelStore,
  type LandingBrowserPendingKill,
} from "@/stores/home/landing-panel-store";
import { appLogger, describeLogErrorSummary } from "@/lib/logger";

/**
 * The first interval between a REFUSED close and the next attempt, doubling to
 * {@link BROWSER_CLOSE_RETRY_MAX_MS}.
 *
 * The same ladder the terminal arm runs, for the same reason and against a
 * narrower question. Absence in a ready inventory settles whether the tab is
 * GONE, and that is what needs no ladder. It settles nothing about a close the
 * device would not accept: a refusal is the ask failing, not the device
 * answering, so the evidence the tombstone is waiting for never arrives.
 */
const BROWSER_CLOSE_RETRY_BASE_MS = 500;

/**
 * Ceiling on that interval, and deliberately no ceiling on the number of
 * attempts.
 *
 * A tombstone is a close that is still owed, so this drain must not reach a
 * state it cannot leave - the argument `CAPABLE_CLOSE_RETRY_MAX_MS` makes for
 * the terminal arm, and it binds harder here because the tab is a real window
 * on the device with nothing else scheduled to reap it. A refusal repaired by
 * a host restart or a re-grant has to be picked up on its own.
 *
 * What an attempt budget was there to bound is the COST of a permanent
 * refusal, and the interval bounds that directly: the ladder reaches this
 * ceiling after ~10 attempts and then costs a dozen frames an hour.
 */
const BROWSER_CLOSE_RETRY_MAX_MS = 300_000;

/** One tombstone's refusal ladder. At most one armed timer per key. */
interface BrowserCloseRetry {
  attempt: number;
  timer: number | null;
  /** Set by the timer; consumed by the dispatch it admits. */
  due: boolean;
  /**
   * The ready generation the ladder was climbed on. A new stream incarnation
   * is new evidence, so it starts a fresh ladder rather than inheriting the
   * five-minute interval a dead connection ran up.
   */
  generation: number;
}

/**
 * What a browser tombstone is owed on this pass.
 *
 * Three outcomes, and a ladder narrower than the terminal arm's beside it.
 * That one exists because a `terminal.kill` can be ANSWERED and still leave the
 * question open - an in-flight create has no projection to look in, so
 * "absent" is not proof of death and the drain has to keep asking. Here the
 * device publishes its whole independent inventory and every tab id in a
 * tombstone was minted and reported by that device, so absence IS proof: one
 * look at a ready inventory settles it either way, and nothing re-asks a
 * question the device has answered.
 *
 * The ladder covers only the case the inventory cannot answer: a close the
 * device REFUSED. See {@link BROWSER_CLOSE_RETRY_BASE_MS}.
 */
export type LandingBrowserTombstoneAction = "wait" | "close" | "clear";

export function landingBrowserTombstoneDecision(args: {
  readonly pending: LandingBrowserPendingKill;
  readonly sessions: BrowserSessionsState | null;
  /**
   * The device's ready generation this key was last dispatched on, or `null`.
   * Dispatches are marked against a GENERATION rather than a bare "sent" flag
   * so a stream that drops and comes back re-arms the send: the close may have
   * gone down with the socket, and the fresh inventory is a new answer rather
   * than the one that was already acted on.
   */
  readonly attemptedGeneration: number | null;
  readonly generation: number;
  /**
   * Has this key's refusal ladder come due? The second way past the mark, and
   * the only one that does not need the connection to have changed.
   */
  readonly retryDue: boolean;
}): LandingBrowserTombstoneAction {
  const sessions = args.sessions;
  // No provider mounted for this device yet, or its stream has not supplied a
  // snapshot. An empty `items` on a connecting stream is indistinguishable from
  // "this device has no tabs", and reading it as the latter would clear the
  // tombstone and leave the tab open for good.
  if (sessions === null || !sessions.inventoryReady) return "wait";
  const session = sessions.items.find(
    (item) =>
      item.sessionId === args.pending.sessionId &&
      item.hostId === args.pending.hostId &&
      // The scope term its two siblings carry (`reconcileLandingBrowserTabs`,
      // `selectLandingBrowserViewModel`). Inert while the only publisher is the
      // fleet's independent provider, and this is the one arm whose false match
      // sends a real `closeTab` at a live tab - so it is the last place to rely
      // on the caller having handed over the right inventory.
      item.scope.kind === "independent",
  );
  const present =
    session !== undefined &&
    session.tabs.some((tab) => tab.tabId === args.pending.tabId);
  if (!present) return "clear";
  if (args.attemptedGeneration === args.generation && !args.retryDue) {
    return "wait";
  }
  return "close";
}

/**
 * Drains browser tombstones against each device's independent inventory.
 *
 * The states are published by the always-mounted fleet's report-only browser
 * arm, so this shares the panel's coordinator by key rather than opening a
 * second stream per device.
 *
 * A device's stream the desktop REFUSED (its per-window stream cap) reads as
 * `failed`, which the decision above treats as "wait". Nothing here re-asks
 * for it: `browser-sessions-coordinator.ts` re-asks the refused on both edges
 * a slot frees on - another coordinator releasing its stream, and a stream
 * main had admitted failing to open - and that covers the panel's and a
 * tile's refused stream the same way as this one's.
 *
 * The release edge is only reachable because the bridge BOUNDS what it mounts
 * (`LANDING_BROWSER_RECOVERY_HOST_CAP`, and only for devices with a route).
 * Mounting one per tombstoned device would have filled the window's allowance
 * with streams that release exactly when their tombstones settle - which, for
 * the devices that cannot answer, is never - so the refusal would have landed
 * on the panel's own stream with nothing left to free a slot.
 *
 * Every tombstone is still passed here, mounted device or not: a key whose
 * device is unmounted reads as "wait" and is re-examined when the mount
 * rotates to it. Rotation is what makes that a promise rather than a hope - a
 * mounted device that has not drained within its attempt budget yields its
 * slot (`landing-browser-recovery-slots.ts`), so no device is parked behind
 * one that is stuck.
 *
 * Rotation answers CONTENTION and nothing else. A refused close is a separate
 * problem with a separate remedy - {@link scheduleBrowserCloseRetry} - because
 * the two do not co-occur: with one device, or with the others drained, no
 * rotation is owed and none happens, and a healthy stream need never reconnect,
 * so the generation the mark is set against would never move again. Reading the
 * lease as the retry trigger stranded exactly that tab.
 */
export function useLandingBrowserTombstoneDrain(args: {
  readonly pendingKills: ReadonlyArray<LandingBrowserPendingKill>;
  readonly browserSessions: LandingBrowserSessionEntries;
}): void {
  const { pendingKills, browserSessions } = args;
  const readyRef = useRef<Map<string, boolean>>(new Map());
  const generationRef = useRef<Map<string, number>>(new Map());
  const attemptedRef = useRef<Map<string, number>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());
  const retriesRef = useRef<Map<string, BrowserCloseRetry>>(new Map());
  const mountedRef = useRef(true);
  const [retryGeneration, setRetryGeneration] = useState(0);
  useLandingBrowserSessionsPublication(browserSessions);

  useEffect(() => {
    mountedRef.current = true;
    const retries = retriesRef.current;
    return () => {
      mountedRef.current = false;
      for (const key of [...retries.keys()])
        clearBrowserCloseRetry(retries, key);
    };
  }, []);

  useEffect(() => {
    const signalRetry = (): void => {
      setRetryGeneration((current) => current + 1);
    };
    // Reap records whose tombstone left by some other path - a sign-out clear,
    // a store reset - so an armed timer cannot outlive what it was arming for.
    // Every other exit retires its own record; this covers the ones that do not
    // pass through here at all.
    const pendingKeys = new Set(
      pendingKills.map((entry) => landingTabRefKey(entry)),
    );
    for (const key of [...retriesRef.current.keys()]) {
      if (!pendingKeys.has(key))
        clearBrowserCloseRetry(retriesRef.current, key);
    }
    for (const pending of pendingKills) {
      const key = landingTabRefKey(pending);
      const sessions = browserSessions[pending.hostId] ?? null;
      const generation = advanceReadyGeneration({
        generations: generationRef.current,
        hostId: pending.hostId,
        ready: sessions !== null && sessions.inventoryReady,
        readiness: readyRef.current,
      });
      if (inFlightRef.current.has(key)) continue;
      const retry = retriesRef.current.get(key);
      const action = landingBrowserTombstoneDecision({
        pending,
        sessions,
        attemptedGeneration: attemptedRef.current.get(key) ?? null,
        generation,
        retryDue: retry?.due === true,
      });
      if (action === "wait") continue;
      if (action === "clear") {
        attemptedRef.current.delete(key);
        clearBrowserCloseRetry(retriesRef.current, key);
        useLandingPanelStore.getState().clearPendingKill(pending);
        continue;
      }
      // Non-null on the "close" branch by the decision above; read again rather
      // than asserted, because that narrowing does not cross the call.
      if (sessions === null) continue;
      attemptedRef.current.set(key, generation);
      // Spent here rather than when the timer fired: a due mark that outlived
      // its dispatch would admit every following pass too, which is the loop
      // the mark exists to prevent.
      if (retry !== undefined) retry.due = false;
      inFlightRef.current.add(key);
      void sessions
        .closeTab(pending.sessionId, pending.tabId)
        .then(() => {
          // Retire the mark with the record it belongs to, so nothing outlives
          // the tombstone it was made for.
          attemptedRef.current.delete(key);
          clearBrowserCloseRetry(retriesRef.current, key);
          useLandingPanelStore.getState().clearPendingKill(pending);
        })
        .catch((cause: unknown) => {
          // Not surfaced: nobody asked for this close in this session and the
          // tab it names is not on screen. The mark stays, so nothing loops
          // against a device that is answering "no" - and the ladder is what
          // eventually asks again, on a schedule that needs no other device to
          // want this one's stream.
          appLogger.warn("[landing-browser] tombstone close failed", {
            hostId: pending.hostId,
            error: describeLogErrorSummary(cause),
          });
          scheduleBrowserCloseRetry({
            retries: retriesRef.current,
            key,
            generation,
            mounted: mountedRef,
            signalRetry,
          });
        })
        .finally(() => {
          inFlightRef.current.delete(key);
          // Parity with the terminal arm's `signalRetry`, for the reason it
          // states: clearing a ref renders nothing, so without this the drain
          // never looks at this key again on its own. The window it closes is
          // narrow but real - a close in flight while the stream drops and
          // returns is skipped for being in flight, the generation moves past
          // it, and a rejection then leaves the mark on the OLD generation with
          // nothing scheduled. It cannot loop: a settled close takes the
          // tombstone with it, and a failed one re-reads as "wait" until either
          // the next incarnation bumps the generation or its ladder comes due.
          signalRetry();
        });
    }
  }, [browserSessions, pendingKills, retryGeneration]);
}

/**
 * The browser session states this WINDOW currently holds.
 *
 * Published from the drain because sign-out is not a render: it runs inside an
 * auth-transition callback in `LandingTerminalPersistLifecycleBridge`, which
 * sits ABOVE the bridge that owns these states and so cannot read them through
 * context. Reading them here keeps the sign-out close on the coordinator the
 * drain already uses instead of opening a second path to the device.
 */
let publishedBrowserSessions: LandingBrowserSessionEntries = {};

function useLandingBrowserSessionsPublication(
  entries: LandingBrowserSessionEntries,
): void {
  useEffect(() => {
    publishedBrowserSessions = entries;
    return () => {
      // Only retract what is still ours: a remount publishes the next entries
      // before this cleanup runs, and clearing unconditionally would blank it.
      if (publishedBrowserSessions === entries) publishedBrowserSessions = {};
    };
  }, [entries]);
}

/**
 * Discharges what can still be discharged, immediately before sign-out clears
 * the store.
 *
 * Best effort by construction, and only for a device whose independent stream
 * is live and ready in this window: the close travels on that stream, so a
 * tombstone without one has nowhere to go and is dropped with the store. That
 * is the honest outcome rather than a silent loss - the device is offline, its
 * idle TTL owns the tab from here, and if the tab is still there at the next
 * sign-in the panel re-adopts it, which is a visible tab the user can close
 * again rather than a promise this window quietly failed to keep.
 *
 * Nothing is awaited and nothing is cleared: the store is about to go.
 */
export function closeLandingBrowserTombstonesForSignOut(
  pendingKills: ReadonlyArray<LandingBrowserPendingKill>,
): void {
  for (const pending of pendingKills) {
    const sessions = publishedBrowserSessions[pending.hostId] ?? null;
    if (
      sessions === null ||
      sessions.lifecycle !== "live" ||
      !sessions.inventoryReady
    ) {
      continue;
    }
    void sessions.closeTab(pending.sessionId, pending.tabId).catch(() => {
      // Nobody asked for this in this session and there is no store left to
      // record the failure in.
    });
  }
}

/**
 * Arms the next attempt after a REFUSED close.
 *
 * What bounds it, in the same terms as the coordinator's cap sweep:
 *
 * - it cannot spin. A retry is armed only by a settled rejection, and the next
 *   one only by the rejection after it, so attempts are serialised by the
 *   round trip rather than by the render loop. At most one timer per key - a
 *   record of THIS generation with one already armed returns here untouched.
 * - it cannot accelerate. Within one generation the interval only doubles,
 *   from {@link BROWSER_CLOSE_RETRY_BASE_MS} to
 *   {@link BROWSER_CLOSE_RETRY_MAX_MS}, so a device refusing forever costs a
 *   dozen frames an hour. It can be RESET, but only by a new connection, and
 *   a new connection costs a socket - so the reset is bounded by something
 *   more expensive than the retry it buys.
 * - it cannot outlive its reason. The record dies with the tombstone: on the
 *   close that succeeds, on the inventory that proves the tab gone, on the
 *   reap for a record whose tombstone left another way, and on unmount.
 * - a new incarnation starts a FRESH ladder, and that is a claim the discard
 *   below makes rather than one the generation field implies. It is pinned by
 *   `climbs a fresh ladder after a reconnect, rather than waiting out the old
 *   interval` in this module's suite, which drives climb -> reconnect ->
 *   reject and reads the interval that follows.
 *
 * And unlike the recovery rotation, it needs no other device to want this
 * one's slot. That is the point: with a single device, or with the others
 * drained, there is no contention to ride and a refused close would otherwise
 * wait for a reconnect a healthy stream never has to make.
 */
function scheduleBrowserCloseRetry(args: {
  readonly retries: Map<string, BrowserCloseRetry>;
  readonly key: string;
  readonly generation: number;
  readonly mounted: { readonly current: boolean };
  readonly signalRetry: () => void;
}): void {
  if (!args.mounted.current) return;
  // BEFORE the reuse guard below, and that order is the whole of it. A ladder
  // belongs to the connection it was climbed on, so a record from an older
  // generation is discarded outright, timer and all - exactly as the terminal
  // arm discards a record belonging to the other arm, and for the same reason.
  //
  // Ordered the other way, a stale record's armed timer made this function
  // return before the generation was ever compared: a ladder that had climbed
  // to five minutes on generation 1 kept that timer across a reconnect, and
  // generation 2's rejection scheduled nothing at all. The record still said
  // generation 1, and the tab waited out the old interval rather than the
  // fresh 500ms a new connection is owed. "A new incarnation starts a fresh
  // ladder" was a property of this comparison and not of the code until the
  // discard moved above the guard.
  const stale = args.retries.get(args.key);
  if (stale !== undefined && stale.generation !== args.generation) {
    clearBrowserCloseRetry(args.retries, args.key);
  }
  const prior = args.retries.get(args.key);
  if (prior !== undefined && prior.timer !== null) return;
  // Same generation by construction now, so this is the ladder's own step.
  const attempt = (prior?.attempt ?? 0) + 1;
  const next: BrowserCloseRetry = {
    attempt,
    timer: null,
    due: false,
    generation: args.generation,
  };
  next.timer = window.setTimeout(
    () => {
      if (!args.mounted.current) return;
      next.timer = null;
      next.due = true;
      args.signalRetry();
    },
    Math.min(
      BROWSER_CLOSE_RETRY_BASE_MS * 2 ** (attempt - 1),
      BROWSER_CLOSE_RETRY_MAX_MS,
    ),
  );
  args.retries.set(args.key, next);
}

function clearBrowserCloseRetry(
  retries: Map<string, BrowserCloseRetry>,
  key: string,
): void {
  const retry = retries.get(key);
  if (retry !== undefined && retry.timer !== null) clearTimeout(retry.timer);
  retries.delete(key);
}

/**
 * The device's ready generation, incremented on the false -> true edge of
 * `inventoryReady` - the only edge that means "a new stream incarnation has
 * spoken". A device with no provider mounted reads as not ready, so an
 * unmount/remount re-arms exactly like a reconnect.
 */
function advanceReadyGeneration(args: {
  readonly generations: Map<string, number>;
  readonly hostId: string;
  readonly ready: boolean;
  readonly readiness: Map<string, boolean>;
}): number {
  const wasReady = args.readiness.get(args.hostId) ?? false;
  if (args.ready !== wasReady) {
    args.readiness.set(args.hostId, args.ready);
    if (args.ready) {
      args.generations.set(
        args.hostId,
        (args.generations.get(args.hostId) ?? 0) + 1,
      );
    }
  }
  return args.generations.get(args.hostId) ?? 0;
}

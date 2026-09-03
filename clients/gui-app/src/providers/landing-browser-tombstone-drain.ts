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
 * What a browser tombstone is owed on this pass.
 *
 * Three outcomes and no retry ladder, unlike the terminal arm beside it. That
 * ladder exists because a `terminal.kill` can be ANSWERED and still leave the
 * question open - an in-flight create has no projection to look in, so
 * "absent" is not proof of death and the drain has to keep asking. Here the
 * device publishes its whole independent inventory and every tab id in a
 * tombstone was minted and reported by that device, so absence IS proof: one
 * look at a ready inventory settles it either way.
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
  if (args.attemptedGeneration === args.generation) return "wait";
  return "close";
}

/**
 * Drains browser tombstones against each device's independent inventory.
 *
 * The states are published by the always-mounted fleet's report-only browser
 * arm, so this shares the panel's coordinator by key rather than opening a
 * second stream per device.
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
  const [retryGeneration, setRetryGeneration] = useState(0);
  useLandingBrowserSessionsPublication(browserSessions);

  useEffect(() => {
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
      const action = landingBrowserTombstoneDecision({
        pending,
        sessions,
        attemptedGeneration: attemptedRef.current.get(key) ?? null,
        generation,
      });
      if (action === "wait") continue;
      if (action === "clear") {
        attemptedRef.current.delete(key);
        useLandingPanelStore.getState().clearPendingKill(pending);
        continue;
      }
      // Non-null on the "close" branch by the decision above; read again rather
      // than asserted, because that narrowing does not cross the call.
      if (sessions === null) continue;
      attemptedRef.current.set(key, generation);
      inFlightRef.current.add(key);
      void sessions
        .closeTab(pending.sessionId, pending.tabId)
        .then(() => {
          // Retire the mark with the record it belongs to, so nothing outlives
          // the tombstone it was made for.
          attemptedRef.current.delete(key);
          useLandingPanelStore.getState().clearPendingKill(pending);
        })
        .catch((cause: unknown) => {
          // Not surfaced: nobody asked for this close in this session and the
          // tab it names is not on screen. The mark stays, so the retry is the
          // next stream incarnation rather than a loop against a device that is
          // answering "no".
          appLogger.warn("[landing-browser] tombstone close failed", {
            hostId: pending.hostId,
            error: describeLogErrorSummary(cause),
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
          // tombstone with it, and a failed one re-reads as "wait" until the
          // next incarnation bumps the generation.
          setRetryGeneration((current) => current + 1);
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

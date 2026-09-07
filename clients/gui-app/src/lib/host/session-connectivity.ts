import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";
import { isMobileApp } from "@/lib/mobile-app";

/**
 * The SESSION plane of host connectivity: whether this device's own live transport to the active host is carrying traffic right now.
 */
export type HostSessionConnectivity =
  /** The client's session is attached and carrying frames. */
  | "ready"
  /**
   * Down, but not yet for long enough to announce.
   * See {@link SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS}.
   */
  | "settling"
  /** Down past the announce window: a real interruption, worth stating. */
  | "interrupted"
  /**
   * Interrupted, and long enough that a reassuring "reconnecting" no longer describes it.
   * See {@link SESSION_CONNECTIVITY_ESCALATE_AFTER_MS}.
   */
  | "interrupted-prolonged"
  /** Not ready and has never been ready - a first dial, not a drop. */
  | "dialing"
  /** Nothing to say: no live client, or not the mobile app. */
  | "unknown";

/**
 * Whether this verdict is one a user should be told about.
 * The two announced states differ in WORDING, not in whether the surface appears, so callers ask this rather than matching the union themselves and drifting apart.
 */
export function isAnnouncedInterruption(
  connectivity: HostSessionConnectivity,
): boolean {
  return (
    connectivity === "interrupted" || connectivity === "interrupted-prolonged"
  );
}

/** How often readiness is re-read while the session is up. */
export const SESSION_CONNECTIVITY_POLL_MS = 250;

/** How long an outage must persist before it is announced at all. */
export const SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS = 1_000;

/** How long one outage runs before it stops being described as a blip. */
export const SESSION_CONNECTIVITY_ESCALATE_AFTER_MS = 15_000;

/** Passed to `reconnectAll` so a hand-driven retry is distinguishable in logs. */
const SESSION_WAKE_REASON = "user-retry";

/**
 * Both members are arrow-function PROPERTIES rather than methods, because `useSyncExternalStore` takes them detached from the object.
 * Declared as methods they would carry an implicit `this`, and a detached call could only be made safe by rebinding at every call site.
 */
export interface SessionConnectivityStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => HostSessionConnectivity;
}

/**
 * The wall clock, hoisted out of the hook below so no impure read sits inside a render path.
 * Everything that consumes it takes a `now` thunk instead, so tests substitute a controllable clock and never reach this.
 */
const wallClockNow = (): number => Date.now();

/** Builds the external store behind {@link useHostSessionConnectivity}. */
export function createSessionConnectivityStore(args: {
  readonly streamClient: IHostStreamClient<HostStreamRpcRegistry> | null;
  readonly isReady: () => boolean;
  readonly now: () => number;
  readonly pollMs: number;
  readonly announceAfterMs: number;
  readonly escalateAfterMs: number;
}): SessionConnectivityStore {
  const {
    streamClient,
    isReady,
    now,
    pollMs,
    announceAfterMs,
    escalateAfterMs,
  } = args;
  // Monotonic within this store's life.
  // It is what separates a drop from a first dial, and only a real ready boundary sets it - so a session that has never attached cannot report itself interrupted no matter how long it spends failing.
  let everReady = false;
  // When the CURRENT outage began, or null while attached.
  // One outage spans however many redials the transport makes inside it, so the escalation it feeds cannot be undone by an attempt that reaches `connecting` and fails again - only reaching ready ends the episode.
  let downSince: number | null = null;
  let escalated = false;
  let snapshot: HostSessionConnectivity = "unknown";
  let episodeTimers: number[] = [];
  // React may overlap an old and a new subscription across a re-render, so a set rather than one slot.
  // EVERY signal this store listens to is store-wide and reference-counted against this set - see `attachSignals`.
  const listeners = new Set<() => void>();
  let detachSignals: (() => void) | null = null;

  const clearEpisodeTimers = (): void => {
    for (const timer of episodeTimers) {
      window.clearTimeout(timer);
    }
    episodeTimers = [];
  };

  const notify = (): void => {
    refresh();
    for (const listener of [...listeners]) {
      listener();
    }
  };

  /**
   * (Re-)arms the deadlines for the CURRENT outage, measured from when it began rather than from now.
   * A deadline already passed is not re-armed - `refresh` has already folded it into the snapshot - so re-arming is idempotent and a re-subscribe mid-outage resumes the original schedule instead of restarting it, which would let a remount postpone the.
   */
  const armEpisodeTimers = (): void => {
    clearEpisodeTimers();
    if (downSince === null || listeners.size === 0) {
      return;
    }
    const elapsed = now() - downSince;
    for (const deadline of [announceAfterMs, escalateAfterMs]) {
      if (elapsed < deadline) {
        episodeTimers.push(window.setTimeout(notify, deadline - elapsed));
      }
    }
  };

  const attachSignals = (): void => {
    if (streamClient === null || detachSignals !== null) {
      return;
    }
    const stopRecovered = streamClient.subscribeAvailabilityRecovered(notify);
    const stopClosed = streamClient.onClosed(notify);
    const poll = window.setInterval(notify, pollMs);
    detachSignals = () => {
      stopRecovered();
      stopClosed();
      window.clearInterval(poll);
    };
  };

  const refresh = (): void => {
    if (streamClient === null) {
      snapshot = "unknown";
      return;
    }
    if (isReady()) {
      everReady = true;
      downSince = null;
      escalated = false;
      clearEpisodeTimers();
      snapshot = "ready";
      return;
    }
    if (!everReady) {
      snapshot = "dialing";
      return;
    }
    if (downSince === null) {
      downSince = now();
      armEpisodeTimers();
    }
    const downMs = now() - downSince;
    if (downMs >= escalateAfterMs) {
      escalated = true;
    }
    // The escalation outranks the announce window rather than being re-gated by it: once an outage has earned the stronger wording it keeps it for the rest of the episode, so a redial that reaches `connecting` and fails again cannot walk the message back to a.
    if (escalated) {
      snapshot = "interrupted-prolonged";
      return;
    }
    snapshot = downMs < announceAfterMs ? "settling" : "interrupted";
  };

  refresh();

  return {
    subscribe: (listener: () => void) => {
      if (streamClient === null) {
        return () => undefined;
      }
      listeners.add(listener);
      attachSignals();
      // `refresh` dates an outage that began before anyone subscribed; `armEpisodeTimers` then covers the other order - an outage already under way whose deadlines were stood down when the last listener left.
      refresh();
      armEpisodeTimers();
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) {
          // An overlapping subscriber still owns these signals.
          // Tearing them down here would leave it attached to a store that has stopped listening to anything, and its snapshot would silently freeze.
          return;
        }
        if (detachSignals !== null) {
          detachSignals();
          detachSignals = null;
        }
        // The deadlines go, but `downSince` and `escalated` stay: a re-subscribe resumes the same outage on its original schedule rather than starting a new one.
        clearEpisodeTimers();
      };
    },
    getSnapshot: () => snapshot,
  };
}

/** The active host's session connectivity, for app-wide chrome. */
export function useHostSessionConnectivity(): HostSessionConnectivity {
  const activeClient = useWsStreamClient();
  const streamClient = isMobileApp() ? activeClient : null;
  const store = useMemo(
    () =>
      createSessionConnectivityStore({
        streamClient,
        isReady: () => streamClient !== null && streamClient.isReady(),
        now: wallClockNow,
        pollMs: SESSION_CONNECTIVITY_POLL_MS,
        announceAfterMs: SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
        escalateAfterMs: SESSION_CONNECTIVITY_ESCALATE_AFTER_MS,
      }),
    [streamClient],
  );
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}

/** Asks the active host's transport to stop waiting out its backoff and re-establish now. */
export function useHostSessionWake(): () => void {
  const streamClient = useWsStreamClient();
  return useCallback(() => {
    if (streamClient === null) {
      return;
    }
    // Forced, not probe-first: the caller is a person demanding "re-establish now", and the probe-first flavour would answer a live-but-stuck socket with nothing.
    // The OS resume path makes the opposite call for the opposite reason (`subscribeWakeSignals`).
    streamClient.reconnectAll(SESSION_WAKE_REASON, {
      probeFirst: false,
      wakeProbe: null,
    });
  }, [streamClient]);
}

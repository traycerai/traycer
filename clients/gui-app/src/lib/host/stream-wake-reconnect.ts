import { useEffect } from "react";
import type {
  IHostStreamClient,
  ReconnectAllOptions,
} from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IRunnerHost,
  SystemResumeEvent,
} from "@traycer-clients/shared/platform/runner-host";
import {
  wakeHeldRemoteSessions,
  RELAY_WAKE_PROBE_TIMEOUT_BACKGROUNDED_MS,
  WAKE_FORCE_RECONNECT_AFTER_BACKGROUND_MS,
} from "@traycer-clients/shared/host-transport/remote/index";
import { onWakeReconnect } from "@/lib/host/wake-reconnect";
import { appLogger, describeLogError } from "@/lib/logger";
import { useRunnerHost } from "@/providers/use-runner-host";

/** The three OS-level triggers a wake subscriber can fire on. */
export type WakeSignalReason = "wake-online" | "wake-resume" | "wake-network";

/**
 * Subscribes `onWake` to the three OS-level wake triggers - `window 'online'`
 * (`onWakeReconnect`), `IRunnerHost.onSystemResumed` (the shell's own wake
 * signal: Electron `powerMonitor` on desktop, the app returning to the
 * foreground on mobile), and `IRunnerHost.onNetworkPathChanged` (the shell's
 * native reachability edge; a no-op subscription on desktop and web) - and
 * returns a disposer. The shared primitive under every renderer-side wake
 * consumer (stream re-dial, closed chat-session retry), so a new consumer
 * cannot wire only one trigger and miss the same-network lid-open or app
 * switch (`online` never fires for either), the Wi-Fi -> cellular handoff
 * (`online` never fires there either - the network moved without going
 * offline), or the web shell (no shell wake signal at all).
 *
 * `resume` carries the shell's measured background dwell on `wake-resume` and
 * is `null` for the other two triggers - it is the evidence
 * {@link wakeReconnectOptions} turns into a probe-or-redial verdict.
 */
export function subscribeWakeSignals(
  runnerHost: IRunnerHost,
  onWake: (reason: WakeSignalReason, resume: SystemResumeEvent | null) => void,
): () => void {
  const offOnline = onWakeReconnect(() => {
    onWake("wake-online", null);
  });
  const disposers: Array<() => void> = [() => offOnline()];
  try {
    const resumeSubscription = runnerHost.onSystemResumed((event) => {
      onWake("wake-resume", event);
    });
    disposers.push(() => resumeSubscription.dispose());
    const networkSubscription = runnerHost.onNetworkPathChanged(() => {
      onWake("wake-network", null);
    });
    disposers.push(() => networkSubscription.dispose());
    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  } catch (cause) {
    // Roll back every already-registered listener if wiring a later
    // subscription throws, so a failed open never leaks a dangling reconnect
    // callback (the disposer is never returned to the caller in that case).
    for (const dispose of disposers) {
      dispose();
    }
    throw cause;
  }
}

/**
 * Turns a wake trigger plus the shell's resume evidence into the
 * `reconnectAll` verdict for that wake. One function so the per-client
 * subscription and the process-wide remote sweep cannot disagree about what a
 * given wake means.
 *
 *  - `wake-network`: the shell watched the network path move underneath live
 *    sockets (or come back). A socket the OS re-routed is dead in a way no
 *    probe answer can vouch for - the reply proves the NEW path works, not
 *    that the mux session survived the migration - so force the redial.
 *  - `wake-resume` with a measured background dwell (a mobile shell):
 *    T3-shaped duration gate. Under
 *    `WAKE_FORCE_RECONNECT_AFTER_BACKGROUND_MS` the socket may well have
 *    survived the quick app switch, so probe it - but on the short
 *    backgrounded deadline, and with a failed probe redialing immediately
 *    (the person is looking at the screen). At or past the gate iOS has
 *    torn the socket down; probing a corpse only delays the redial the
 *    person is waiting on.
 *  - everything else (`wake-online`, and any resume that cannot state its
 *    dwell - desktop, web, a shell that missed the background edge): the
 *    original probe-first behavior on the transport's default deadline. A
 *    desktop lid-open usually leaves sockets - certainly a localhost one -
 *    intact, and force-dropping them would re-run every stream's open while
 *    the machine's network is still coming back.
 */
export function wakeReconnectOptions(
  reason: WakeSignalReason,
  resume: SystemResumeEvent | null,
): ReconnectAllOptions {
  if (reason === "wake-network") {
    return { probeFirst: false, wakeProbe: null };
  }
  const backgroundedForMs = resume === null ? null : resume.backgroundedForMs;
  if (backgroundedForMs === null) {
    return { probeFirst: true, wakeProbe: null };
  }
  if (backgroundedForMs >= WAKE_FORCE_RECONNECT_AFTER_BACKGROUND_MS) {
    return { probeFirst: false, wakeProbe: null };
  }
  return {
    probeFirst: true,
    wakeProbe: {
      timeoutMs: RELAY_WAKE_PROBE_TIMEOUT_BACKGROUNDED_MS,
      immediateRedialOnFailure: true,
    },
  };
}

/**
 * Whether the process-wide remote-session resume sweep is installed. Module
 * scope because the thing it answers for is module scope: one runtime, one
 * remote-session cache.
 */
let remoteResumeSweepInstalled = false;

/**
 * Test-only: forgets that the sweep was installed, so the next subscription
 * installs it again.
 *
 * A module-level singleton outlives the test that created it. Without this, the
 * first test to subscribe installs the sweep for the whole FILE, every later
 * test sees one fewer registration than production would have, and an
 * assertion on registration counts silently depends on test order. Tests that
 * fake the runner host's subscriber set must reset both together.
 */
export function resetRemoteResumeSweepForTest(): void {
  remoteResumeSweepInstalled = false;
}

/**
 * Installs the ONE resume subscription that wakes every held remote session,
 * on first use and never again.
 *
 * Runtime resume and a per-client reconnect are different questions. A client's
 * `reconnectAll` speaks for the connection that client is bound to; a resume
 * says the whole JavaScript context was frozen, which is a fact about every
 * session at once - including the ones no stream client speaks for at all (a
 * messenger-only binding, a pinned non-active asset client). Answering that
 * process-wide question from a per-client subscription would both miss those
 * and repeat itself once per client, so it is answered once, here, from the
 * cache's own ownership seam.
 *
 * Deliberately never disposed: it outlives every individual client, holds no
 * per-client state, and the sweep it runs skips entries no consumer holds.
 */
function ensureRemoteResumeSweep(runnerHost: IRunnerHost): void {
  if (remoteResumeSweepInstalled) {
    return;
  }
  remoteResumeSweepInstalled = true;
  try {
    subscribeWakeSignals(runnerHost, (reason, resume) => {
      appLogger.debug("[stream] remote session resume sweep", { reason });
      wakeHeldRemoteSessions(reason, wakeReconnectOptions(reason, resume));
    });
  } catch (error) {
    // Best-effort, and deliberately not fatal to the caller's own
    // subscription: a shell whose resume wiring cannot be installed must still
    // get per-client wake reconnect. Un-marking lets the next client retry
    // rather than leaving the sweep permanently believed-installed.
    remoteResumeSweepInstalled = false;
    appLogger.warn("[stream] remote session resume sweep unavailable", {
      error: describeLogError(error),
    });
  }
}

/**
 * Non-hook core of the wake-reconnect wiring. Subscribes a stream client to the
 * two OS-wake triggers and returns a disposer. Used directly (not via React) by
 * the chat session store, which OWNS its transport for the session's warm
 * lifetime and ties the wake subscriptions to that same lifetime - so they are
 * created with the transport and torn down when it closes, not on tile unmount.
 *
 * Also brings up the process-wide remote resume sweep on first use. The two
 * cover different things and neither subsumes the other: this subscription
 * re-dials the LOCAL client that owns it (a remote one only wakes its own
 * session, idempotently), while the sweep reaches every held remote session
 * whether or not a stream client speaks for it.
 */
export function subscribeStreamWakeReconnect(
  client: IHostStreamClient<HostStreamRpcRegistry>,
  runnerHost: IRunnerHost,
): () => void {
  try {
    const dispose = subscribeWakeSignals(runnerHost, (reason, resume) => {
      appLogger.debug("[stream] wake reconnect requested", { reason });
      // The verdict - probe (and how hard) vs drop-and-redial - is the shared
      // policy's, from the trigger and the shell's resume evidence; see
      // `wakeReconnectOptions`.
      client.reconnectAll(reason, wakeReconnectOptions(reason, resume));
    });
    // After the caller's own subscription, never before: a shell whose resume
    // wiring throws should fail this call once, cleanly, rather than have a
    // process-wide singleton attempt the same doomed subscription first and
    // double the rollback.
    ensureRemoteResumeSweep(runnerHost);
    return dispose;
  } catch (cause) {
    appLogger.error("[stream] wake reconnect subscription failed", {}, cause);
    throw cause;
  }
}

/**
 * Forces a LONG-LIVED host stream client to re-dial immediately on an OS
 * wake, instead of idling until the next heartbeat tick notices the OS-frozen
 * socket (up to one ping interval, ~25s) or the pong timeout (~60s) elapses.
 * Shared by the app-wide epic stream (`HostStreamProvider`) and the per-tab
 * chat/terminal streams so they recover from sleep/wake at the same speed.
 *
 * Three triggers:
 *  - `window 'online'` (`onWakeReconnect`): the network returning on wake.
 *    Cross-platform; does NOT fire on a same-network lid-open.
 *  - `IRunnerHost.onSystemResumed`: the shell's own wake signal - Electron
 *    `powerMonitor` resume/unlock-screen on desktop, the app returning to the
 *    foreground on mobile. The reliable trigger, because it fires even when no
 *    network transition occurs, which is every app switch on a phone (the
 *    WebView is suspended, its sockets die, and the network never moved).
 *    Shells with no wake signal at all (web, tests) install a no-op
 *    subscription, so this degrades to the `online`-only path.
 *  - `IRunnerHost.onNetworkPathChanged`: the shell's native reachability
 *    edge (mobile only; a no-op elsewhere) - connectivity regained, or the
 *    interface type moving under live sockets, neither of which raises
 *    `online`.
 *
 * All feed `reconnectAll`, which is idempotent (a wake that fires several just
 * reschedules the redial). No-op when `client` is null - no live stream, or a
 * transient stream (e.g. the one-shot worktree delete) that opts out by not
 * calling this hook. Must be called inside a `<RunnerHostProvider>`.
 */
export function useStreamWakeReconnect(
  client: IHostStreamClient<HostStreamRpcRegistry> | null,
): void {
  const runnerHost = useRunnerHost();

  useEffect(() => {
    if (client === null) {
      return;
    }
    return subscribeStreamWakeReconnect(client, runnerHost);
  }, [client, runnerHost]);
}

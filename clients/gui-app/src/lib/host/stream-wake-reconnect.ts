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
 * Subscribes `onWake` to the three OS-level wake triggers - `window 'online'` (`onWakeReconnect`), `IRunnerHost.onSystemResumed` (the shell's own wake signal: Electron `powerMonitor` on desktop, the app returning to the foreground on mobile), and.
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
    // Roll back every already-registered listener if wiring a later subscription throws, so a failed open never leaks a dangling reconnect callback (the disposer is never returned to the caller in that case).
    for (const dispose of disposers) {
      dispose();
    }
    throw cause;
  }
}

/**
 * Turns a wake trigger plus the shell's resume evidence into the `reconnectAll` verdict for that wake.
 * One function so the per-client subscription and the process-wide remote sweep cannot disagree about what a given wake means.
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
 * Whether the process-wide remote-session resume sweep is installed.
 * Module scope because the thing it answers for is module scope: one runtime, one remote-session cache.
 */
let remoteResumeSweepInstalled = false;

/** Test-only: forgets that the sweep was installed, so the next subscription installs it again. */
export function resetRemoteResumeSweepForTest(): void {
  remoteResumeSweepInstalled = false;
}

/** Installs the ONE resume subscription that wakes every held remote session, on first use and never again. */
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
    // Best-effort, and deliberately not fatal to the caller's own subscription: a shell whose resume wiring cannot be installed must still get per-client wake reconnect.
    // Un-marking lets the next client retry rather than leaving the sweep permanently believed-installed.
    remoteResumeSweepInstalled = false;
    appLogger.warn("[stream] remote session resume sweep unavailable", {
      error: describeLogError(error),
    });
  }
}

/**
 * Non-hook core of the wake-reconnect wiring.
 * Subscribes a stream client to the two OS-wake triggers and returns a disposer.
 */
export function subscribeStreamWakeReconnect(
  client: IHostStreamClient<HostStreamRpcRegistry>,
  runnerHost: IRunnerHost,
): () => void {
  try {
    const dispose = subscribeWakeSignals(runnerHost, (reason, resume) => {
      appLogger.debug("[stream] wake reconnect requested", { reason });
      // The verdict - probe (and how hard) vs drop-and-redial - is the shared policy's, from the trigger and the shell's resume evidence; see `wakeReconnectOptions`.
      client.reconnectAll(reason, wakeReconnectOptions(reason, resume));
    });
    // After the caller's own subscription, never before: a shell whose resume wiring throws should fail this call once, cleanly, rather than have a process-wide singleton attempt the same doomed subscription first and double the rollback.
    ensureRemoteResumeSweep(runnerHost);
    return dispose;
  } catch (cause) {
    appLogger.error("[stream] wake reconnect subscription failed", {}, cause);
    throw cause;
  }
}

/**
 * Forces a LONG-LIVED host stream client to re-dial immediately on an OS wake, instead of idling until the next heartbeat tick notices the OS-frozen socket (up to one ping interval, ~25s) or the pong timeout (~60s) elapses.
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

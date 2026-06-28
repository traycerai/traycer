import { useEffect } from "react";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { onWakeReconnect } from "@/lib/host/wake-reconnect";
import { appLogger } from "@/lib/logger";
import { useRunnerHost } from "@/providers/use-runner-host";

/**
 * Non-hook core of the wake-reconnect wiring. Subscribes a stream client to the
 * two OS-wake triggers and returns a disposer. Used directly (not via React) by
 * the chat session store, which OWNS its transport for the session's warm
 * lifetime and ties the wake subscriptions to that same lifetime - so they are
 * created with the transport and torn down when it closes, not on tile unmount.
 */
export function subscribeStreamWakeReconnect(
  client: WsStreamClient<HostStreamRpcRegistry>,
  runnerHost: IRunnerHost,
): () => void {
  const offOnline = onWakeReconnect(() => {
    appLogger.debug("[stream] wake reconnect requested", {
      reason: "wake-online",
    });
    client.reconnectAll("wake-online");
  });
  try {
    const resumeSubscription = runnerHost.onSystemResumed(() => {
      appLogger.debug("[stream] wake reconnect requested", {
        reason: "wake-resume",
      });
      client.reconnectAll("wake-resume");
    });
    return () => {
      offOnline();
      resumeSubscription.dispose();
    };
  } catch (cause) {
    appLogger.error("[stream] wake reconnect subscription failed", {}, cause);
    // Roll back the already-registered 'online' listener if wiring the OS-resume
    // subscription throws, so a failed open never leaks a dangling reconnect
    // callback (the disposer is never returned to the caller in that case).
    offOnline();
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
 * Two triggers:
 *  - `window 'online'` (`onWakeReconnect`): the network returning on wake.
 *    Cross-platform; does NOT fire on a same-network lid-open.
 *  - `IRunnerHost.onSystemResumed`: Electron `powerMonitor` resume/unlock-screen
 *    bridged from the shell - the reliable desktop trigger that fires even when
 *    no network transition occurs. Shells with no OS wake signal (web, mobile,
 *    tests) install a no-op subscription, so this degrades to the `online`-only
 *    path.
 *
 * Both feed `reconnectAll`, which is idempotent (a wake that fires both just
 * reschedules the redial). No-op when `client` is null - no live stream, or a
 * transient stream (e.g. the one-shot worktree delete) that opts out by not
 * calling this hook. Must be called inside a `<RunnerHostProvider>`.
 */
export function useStreamWakeReconnect(
  client: WsStreamClient<HostStreamRpcRegistry> | null,
): void {
  const runnerHost = useRunnerHost();

  useEffect(() => {
    if (client === null) {
      return;
    }
    return subscribeStreamWakeReconnect(client, runnerHost);
  }, [client, runnerHost]);
}

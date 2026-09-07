import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostEndpointProvider } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import { subscribeStreamWakeReconnect } from "@/lib/host/stream-wake-reconnect";
import {
  AVAILABILITY_RECOVERY_COOLDOWN_MS,
  wireAvailabilityRecovery,
} from "@/lib/host/availability-recovery";
import { appLogger } from "@/lib/logger";

export interface DurableStreamTransport {
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  /**
   * Tears down wake + endpoint-change wiring then the socket.
   * The owning session calls it exactly once - when it disposes, or before rebuilding on `retry()`.
   */
  readonly close: () => void;
}

/** A durable session transport whose owner can attribute its final close. */
export interface AttributableDurableStreamTransport extends DurableStreamTransport {
  /** Same teardown, with a caller-authored diagnostic reason. */
  readonly closeWithReason: (reason: string) => void;
}

/**
 * Long-lived host stream for session stores: live `endpoint` on every redial, auth revalidate, wake, endpoint-change redial, availability recovery.
 * `close()` tears all wiring; a throw while wiring disposes already-registered subscriptions so a failed build never leaks a socket.
 */
export function openDurableStreamTransport(params: {
  readonly target: HostDirectoryEntry;
  /** The signed-in user this transport is built for (Architecture §4 / S1 cache key). */
  readonly userId: string;
  readonly endpoint: HostEndpointProvider;
  readonly bearer: BearerSourceProvider;
  readonly auth: StreamAuthRevalidator;
  readonly runnerHost: IRunnerHost;
  /**
   * Subscribes to same-user bearer rotations.
   * The durable transport forwards the event to its owned stream client so open host connections rotate credentials in place via `credentialUpdate`.
   */
  readonly subscribeBearerRotation: (onRotation: () => void) => () => void;
  /**
   * Subscribes to host-directory changes for the bound host, returning a disposer.
   * The callback fires on ANY directory change; this module filters it down to a genuine dialable-endpoint move before re-dialing.
   */
  readonly subscribeEndpointChange: (onChange: () => void) => () => void;
  /**
   * Called (cooldown-coalesced by this module) when this transport's own heartbeat evidences ITS host recovering - a session re-open after a drop, or a pong after a stall-length gap.
   * The factory routes it to `HostClient.notifyHostAvailabilityRecovered(hostId)` so that host's stranded unary queries refetch.
   */
  readonly notifyRecoveredForNamedHost: () => void;
}): AttributableDurableStreamTransport {
  const wsStreamClient = buildHostStreamClient({
    target: params.target,
    endpoint: params.endpoint,
    bearer: params.bearer,
    authnBaseUrl: params.runnerHost.authnBaseUrl,
    auth: params.auth,
    userId: params.userId,
    // Durable warm session: its streams re-snapshot on replay, so the
    // process-wide sweep may probe or force-drop it freely.
    proactiveWakeEligible: true,
    // Owned-lifetime transport: eager warm-connect is correct here.
    autoStart: true,
  });
  if (wsStreamClient === null) {
    // Only reachable for a remote target whose registry-published public key does not decode (a corrupt row) - genuinely exceptional, unlike the ordinary "no target yet" case callers already gate on before opening.
    throw new Error(
      `Remote host ${params.target.hostId} has an invalid public key; cannot open a durable stream`,
    );
  }
  appLogger.debug("[stream] durable transport opened", {
    hasEndpoint: params.endpoint() !== null,
  });
  const disposers: Array<() => void> = [];
  try {
    disposers.push(
      params.subscribeBearerRotation(() => {
        wsStreamClient.notifyBearerRotated();
      }),
    );
    disposers.push(
      subscribeStreamWakeReconnect(wsStreamClient, params.runnerHost),
    );
    disposers.push(
      subscribeEndpointRedial(
        wsStreamClient,
        params.endpoint,
        params.subscribeEndpointChange,
      ),
    );
    disposers.push(
      wireAvailabilityRecovery({
        wsStreamClient,
        target: {
          notifyRecoveredForNamedHost: params.notifyRecoveredForNamedHost,
        },
        cooldownMs: AVAILABILITY_RECOVERY_COOLDOWN_MS,
        now: () => Date.now(),
      }),
    );
  } catch (cause) {
    appLogger.error("[stream] durable transport wiring failed", {}, cause);
    // Roll back every subscription wired so far, then close the socket, so a
    // throw mid-wiring leaves nothing dangling.
    disposers.forEach((dispose) => dispose());
    wsStreamClient.close("durable-transport-wiring-failed");
    throw cause;
  }
  const closeWithReason = (reason: string): void => {
    // Dispose wake + endpoint-change wiring BEFORE the socket, so neither can
    // fire `reconnectAll` on a socket that is being torn down.
    disposers.forEach((dispose) => dispose());
    wsStreamClient.close(reason);
  };
  return {
    wsStreamClient,
    close: () => {
      closeWithReason("durable-transport-closed");
    },
    closeWithReason,
  };
}

/**
 * Re-dials the durable transport the instant its bound host gains a NEW dialable endpoint - a host restart / re-provision that moved to a new `websocketUrl`, or a host that just came back `available` - instead of waiting for the dropped socket to notice (up.
 */
function subscribeEndpointRedial(
  client: IHostStreamClient<HostStreamRpcRegistry>,
  endpoint: HostEndpointProvider,
  subscribeEndpointChange: (onChange: () => void) => () => void,
): () => void {
  let lastWebsocketUrl = endpoint()?.websocketUrl ?? null;
  return subscribeEndpointChange(() => {
    const nextWebsocketUrl = endpoint()?.websocketUrl ?? null;
    if (nextWebsocketUrl === lastWebsocketUrl) {
      return;
    }
    lastWebsocketUrl = nextWebsocketUrl;
    if (nextWebsocketUrl !== null) {
      appLogger.debug("[stream] durable endpoint changed - reconnecting", {});
      // The host moved to a new address: the current socket points somewhere that no longer serves this host, so it must be dropped whether or not it still answers.
      // Not a wake - no probe.
      client.reconnectAll("host-endpoint-change", {
        probeFirst: false,
        wakeProbe: null,
      });
    }
  });
}

import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import type { HostEndpointProvider } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import { subscribeStreamWakeReconnect } from "@/lib/host/stream-wake-reconnect";
import { appLogger } from "@/lib/logger";

export interface DurableStreamTransport {
  readonly wsStreamClient: WsStreamClient<HostStreamRpcRegistry>;
  /**
   * Tears down wake + endpoint-change wiring then the socket. The owning session
   * calls it exactly once - when it disposes, or before rebuilding on `retry()`.
   */
  readonly close: () => void;
}

/**
 * Builds a LONG-LIVED host stream transport for a SESSION STORE to own across
 * its warm lifetime (not a React tile). This is the ONE place "durable stream =
 * transport + auth + wake + endpoint-change re-dial" lives: the chat, terminal,
 * and epic session stores all build their transport here, and the app-wide
 * stream uses the same `buildHostStreamClient` + reconnect primitives - so a new
 * durable consumer cannot wire a subset (auth without wake, or a socket without
 * the endpoint-change re-dial) and silently reintroduce the freeze / slow-wake /
 * stuck-after-restart bugs this replaced.
 *
 *  - `endpoint` is read LIVE on every (re)dial, so a host that respawns on a
 *    new `websocketUrl` while the session is warm (no tile mounted to recompute
 *    a memo) reconnects to the new address instead of retrying the dead one.
 *  - `bearer` + `auth` provide UNAUTHORIZED revalidate+reconnect.
 *  - wake re-dial (`window 'online'` + OS resume) is wired here.
 *  - endpoint-change re-dial: when the bound host moves to a NEW dialable
 *    endpoint while the app is awake (a Settings-page restart / re-provision -
 *    no OS sleep, no network transition), this re-dials IMMEDIATELY instead of
 *    waiting for the dropped socket to be noticed (up to the pong timeout on a
 *    half-open socket). It is the session-transport sibling of the app-wide
 *    `useReconnectStreamOnEndpointChange` nudge, keeping both scopes symmetric.
 *
 * All wiring is torn down by `close()`. If any subscription throws while wiring,
 * every already-registered subscription is disposed and the half-built socket is
 * closed before the error propagates, so a failed build never leaks a socket or
 * listeners. Callers that build a typed stream client (chat/terminal/epic) on
 * top must likewise `close()` this transport if THAT construction throws.
 */
export function openDurableStreamTransport(params: {
  readonly endpoint: HostEndpointProvider;
  readonly bearer: BearerSourceProvider;
  readonly auth: StreamAuthRevalidator;
  readonly runnerHost: IRunnerHost;
  /**
   * Subscribes to host-directory changes for the bound host, returning a
   * disposer. The callback fires on ANY directory change; this module filters it
   * down to a genuine dialable-endpoint move before re-dialing.
   */
  readonly subscribeEndpointChange: (onChange: () => void) => () => void;
}): DurableStreamTransport {
  const wsStreamClient = buildHostStreamClient({
    endpoint: params.endpoint,
    bearer: params.bearer,
    auth: params.auth,
  });
  appLogger.info("[stream] durable transport opened", {
    hasEndpoint: params.endpoint() !== null,
  });
  const disposers: Array<() => void> = [];
  try {
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
  } catch (cause) {
    appLogger.error("[stream] durable transport wiring failed", {}, cause);
    // Roll back every subscription wired so far, then close the socket, so a
    // throw mid-wiring leaves nothing dangling.
    disposers.forEach((dispose) => dispose());
    wsStreamClient.close();
    throw cause;
  }
  return {
    wsStreamClient,
    // Dispose wake + endpoint-change wiring BEFORE the socket, so neither can
    // fire `reconnectAll` on a socket that is being torn down.
    close: () => {
      disposers.forEach((dispose) => dispose());
      wsStreamClient.close();
    },
  };
}

/**
 * Re-dials the durable transport the instant its bound host gains a NEW dialable
 * endpoint - a host restart / re-provision that moved to a new `websocketUrl`,
 * or a host that just came back `available` - instead of waiting for the dropped
 * socket to notice (up to the pong timeout on a half-open socket). The dropped
 * socket would re-dial the live `endpoint()` on its own eventually; nudging
 * skips that wait so recovery is instant, matching the app-wide stream.
 *
 * Only fires when the dialable `websocketUrl` actually MOVES to a new non-null
 * value, so the high-frequency benign directory re-emits (every
 * `onLocalHostChange` rebuilds the entry, and on desktop it crosses the IPC
 * bridge as a fresh object) do NOT churn the socket. A move to `null` (host went
 * away) is recorded but not nudged - the next non-null move fires it.
 */
function subscribeEndpointRedial(
  client: WsStreamClient<HostStreamRpcRegistry>,
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
      appLogger.info("[stream] durable endpoint changed - reconnecting", {});
      client.reconnectAll("host-endpoint-change");
    }
  });
}

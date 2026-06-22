import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import type { HostEndpointProvider } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import { subscribeStreamWakeReconnect } from "@/lib/host/stream-wake-reconnect";

export interface DurableStreamTransport {
  readonly wsStreamClient: WsStreamClient<HostStreamRpcRegistry>;
  /**
   * Tears down wake wiring then the socket. The owning session calls it exactly
   * once - when it disposes, or before rebuilding on `retry()`.
   */
  readonly close: () => void;
}

/**
 * Builds a LONG-LIVED host stream transport for a SESSION STORE to own across
 * its warm lifetime (not a React tile). This is the ONE place "durable stream =
 * transport + auth + wake" lives: the chat and terminal session stores both
 * build their transport here, and the app-wide epic stream uses the same
 * `buildHostStreamClient` + wake primitives - so a new durable consumer
 * cannot wire a subset (auth without wake, or vice-versa) and silently
 * reintroduce the freeze/slow-wake bugs this replaced.
 *
 *  - `endpoint` is read LIVE on every (re)dial, so a host that respawns on a
 *    new `websocketUrl` while the session is warm (no tile mounted to recompute
 *    a memo) reconnects to the new address instead of retrying the dead one.
 *  - `bearer` + `auth` provide UNAUTHORIZED revalidate+reconnect.
 *  - wake re-dial (`window 'online'` + OS resume) is wired here and torn down
 *    by `close()`.
 *
 * If wiring the wake subscription throws, the half-built socket is closed before
 * the error propagates, so a failed build never leaks a socket or listeners.
 * Callers that build a typed stream client (chat/terminal) on top must likewise
 * `close()` this transport if THAT construction throws.
 */
export function openDurableStreamTransport(params: {
  readonly endpoint: HostEndpointProvider;
  readonly bearer: BearerSourceProvider;
  readonly auth: StreamAuthRevalidator;
  readonly runnerHost: IRunnerHost;
}): DurableStreamTransport {
  const wsStreamClient = buildHostStreamClient({
    endpoint: params.endpoint,
    bearer: params.bearer,
    auth: params.auth,
  });
  try {
    const disposeWake = subscribeStreamWakeReconnect(
      wsStreamClient,
      params.runnerHost,
    );
    return {
      wsStreamClient,
      close: () => {
        disposeWake();
        wsStreamClient.close();
      },
    };
  } catch (cause) {
    wsStreamClient.close();
    throw cause;
  }
}

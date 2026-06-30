import { useEffect, useMemo } from "react";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { DEFAULT_DIAL_TIMEOUT_MS } from "@traycer-clients/shared/host-transport/transport-config";
import { createWhatwgStreamWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-stream-ws-factory";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import type { HostEndpointProvider } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostClient } from "@/lib/host/runtime";
import { hostTransportKey } from "@/lib/host/transport-key";
import { useCloseWsStreamClientOnReplace } from "@/lib/host/use-close-ws-stream-client-on-replace";

/**
 * Per-session stream dial / handshake / heartbeat timings. Mirror the values
 * the app-wide `HostStreamProvider` builds its `WsStreamClient` with (those
 * constants are module-private there) so a transient client behaves
 * identically on the wire.
 */
const OPEN_ACK_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 60_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const TRANSPORT_KEY_SEPARATOR = "\u0000";

const browserStreamWebSocketFactory = createWhatwgStreamWebSocketFactory();

export interface HostStreamClientBinding {
  readonly client: WsStreamClient<HostStreamRpcRegistry>;
  readonly transportKey: string;
}

export function hostStreamTransportKeyFor(
  target: HostDirectoryEntry | null,
  userId: string | null,
): string | null {
  // Reuse the canonical transport identity so this per-tab key stays in
  // lockstep with the app-wide `HostStreamProvider` key and cannot drift.
  // A same-content directory re-emit yields the same `transport`, so the memo
  // below keeps the same `WsStreamClient` and the active chat socket survives
  // benign `onLocalHostChange` churn. The `userId` scope rebuilds the client
  // when the signed-in identity changes; token rotation is handled live by the
  // `bearer` closure and intentionally does NOT key the client.
  const transport = hostTransportKey(target);
  if (transport === null || userId === null) {
    return null;
  }
  return ["host-stream", userId, transport].join(TRANSPORT_KEY_SEPARATOR);
}

/**
 * Production transport key for a session-owned durable stream (chat / terminal):
 * `null` until there is BOTH an authenticated request context AND a dialable
 * host endpoint. Shared by the chat and terminal session registries so their
 * readiness gate cannot drift. Kept separate from each registry's test seam -
 * tests substitute their own key via the factory override and so never reach
 * (or need to mock) the real request context.
 */
export function authenticatedHostStreamKey(
  globalClient: HostClient<HostRpcRegistry>,
  target: HostDirectoryEntry | null,
): string | null {
  if (globalClient.getRequestContext() === null) {
    return null;
  }
  return hostStreamTransportKeyFor(
    target,
    globalClient.getRequestContextUserId(),
  );
}

/**
 * Constructs a per-host `WsStreamClient` with the standard dial/heartbeat
 * timings - the single place those timings live, shared by the app-wide
 * `HostStreamProvider`, the transient per-tab binding hook below, and the
 * session-owned durable transport (`openDurableStreamTransport`). Non-hook so
 * it can be called wherever a stream transport must be OWNED for a non-React
 * lifetime. `endpoint`, `bearer` and `auth` are all read live on each (re)dial:
 * `endpoint` so a host respawn on a new url is followed, `bearer` so
 * credential rotation is reflected; `auth` wires UNAUTHORIZED recovery
 * (null = terminal, for one-shot streams).
 */
export function buildHostStreamClient(params: {
  readonly endpoint: HostEndpointProvider;
  readonly bearer: BearerSourceProvider;
  readonly auth: StreamAuthRevalidator | null;
}): WsStreamClient<HostStreamRpcRegistry> {
  return new WsStreamClient<HostStreamRpcRegistry>({
    registry: hostStreamRpcRegistry,
    endpoint: params.endpoint,
    bearer: params.bearer,
    auth: params.auth,
    webSocketFactory: browserStreamWebSocketFactory,
    dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
    openAckTimeoutMs: OPEN_ACK_TIMEOUT_MS,
    pingIntervalMs: PING_INTERVAL_MS,
    pongTimeoutMs: PONG_TIMEOUT_MS,
    initialBackoffMs: INITIAL_BACKOFF_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
  });
}

/**
 * Builds a `WsStreamClient` that opens streams against a CHOSEN host (the
 * per-tab host binding) WITHOUT touching the app-wide active-host stream
 * transport (`HostStreamProvider`). Powers the durable per-tab chat and
 * terminal streams as well as the transient Settings ▸ Worktrees
 * `worktree.deleteByPath` stream.
 *
 * `auth` is the stream-side recovery that durable consumers MUST pass (via
 * `useStreamAuthRevalidator`): on an `UNAUTHORIZED` open-frame rejection the
 * client revalidates the credential and reconnects instead of going terminal -
 * the same recovery the app-wide epic stream uses. Pass `null` ONLY for
 * genuinely short-lived one-shot streams (worktree delete), where a terminal
 * auth rejection is the desired outcome. Callers must pass a referentially
 * stable `auth` (the hook returns one) so it does not churn the client memo.
 *
 * The bearer reads live from the global client's `RequestContext` (auth is
 * per-user, valid across hosts) so a credential-lease rotation is reflected.
 * Returns `null` when there is no target, no authenticated request context, or
 * no bound user. Memoized on the authenticated transport identity (+ the auth
 * revalidator) so directory refreshes that allocate a fresh but equivalent
 * entry do not tear down active stream sessions.
 */
export function useHostStreamClientBindingFor(
  target: HostDirectoryEntry | null,
  auth: StreamAuthRevalidator | null,
): HostStreamClientBinding | null {
  const globalClient = useHostClient();
  // `null` when signed out or the credential lease was released - the
  // "no bound user" / "no auth" gate.
  const requestContext = globalClient.getRequestContext();
  const userId = globalClient.getRequestContextUserId();
  const transportKey =
    requestContext === null ? null : hostStreamTransportKeyFor(target, userId);
  const endpointHostId = target?.hostId ?? null;
  const endpointWebsocketUrl = target?.websocketUrl ?? null;

  const binding = useMemo(() => {
    if (
      transportKey === null ||
      endpointHostId === null ||
      endpointWebsocketUrl === null
    ) {
      return null;
    }
    const endpoint = {
      hostId: endpointHostId,
      websocketUrl: endpointWebsocketUrl,
    };

    return {
      transportKey,
      client: buildHostStreamClient({
        endpoint: () => endpoint,
        bearer: () => globalClient.getRequestContext()?.credentials ?? null,
        auth,
      }),
    };
  }, [auth, endpointHostId, endpointWebsocketUrl, globalClient, transportKey]);
  useCloseWsStreamClientOnReplace(binding?.client ?? null);

  // Push the rotated bearer onto this client's open sessions whenever a token
  // refresh rotates the credential lease in place, so the host updates each
  // connection's credential without a reconnect (`credentialUpdate`). Same-user
  // rotation is silent on `onChange`, so we subscribe to the dedicated
  // `onBearerRotated` signal.
  const client = binding?.client ?? null;
  useEffect(() => {
    if (client === null) {
      return;
    }
    return globalClient.onBearerRotated(() => {
      client.notifyBearerRotated();
    });
  }, [client, globalClient]);

  return binding;
}

export function useHostStreamClientFor(
  target: HostDirectoryEntry | null,
  auth: StreamAuthRevalidator | null,
): WsStreamClient<HostStreamRpcRegistry> | null {
  return useHostStreamClientBindingFor(target, auth)?.client ?? null;
}

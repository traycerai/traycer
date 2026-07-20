import { useEffect, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { DEFAULT_DIAL_TIMEOUT_MS } from "@traycer-clients/shared/host-transport/transport-config";
import { createWhatwgStreamWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-stream-ws-factory";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  isRemoteHostDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { createRemoteHostTransport } from "@traycer-clients/shared/host-transport/remote/index";
import type { HostStatusDTO } from "@traycer/protocol/host/host-status";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import type { HostEndpointProvider } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostClient } from "@/lib/host/runtime";
import { useRunnerHost } from "@/providers/use-runner-host";
import {
  hostTransportKey,
  remoteAwareOwnerIdentity,
  remoteAwareOwnerIdentityKey,
} from "@/lib/host/transport-key";

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

/**
 * Inert placeholder satisfying `RemoteHostDirectoryEntry.remoteStatus`'s shape
 * requirement where a caller only has the primitive transport identity
 * (hostId/websocketUrl/publicKey) on hand, not a live status DTO. Never read
 * by `buildHostStreamClient` - only `isRemoteHostDirectoryEntry`'s structural
 * check needs it to be present.
 */
const PLACEHOLDER_REMOTE_STATUS: HostStatusDTO = {
  presenceLease: "expired",
  hostRelayAttached: false,
  viewerReachability: "unknown",
  clientCloud: "ok",
  busy: false,
  busySessionCount: 0,
  updateState: "current",
  appVersion: null,
  lastSeenAt: null,
};

export interface HostStreamClientBinding {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  /**
   * The remote-aware owner identity (`remoteAwareOwnerIdentity`, R-1) this
   * binding's `client` was built for - hostId + userId, plus, for a remote
   * host, its public key + relay attach URL. NOT the dialability-only
   * `hostTransportKey` - a caller comparing this across renders to decide
   * "is this still the same owned session" must see a remote public-key
   * rotation as a distinct value, or it would silently misuse a stale
   * session the same way the S1-era owners did.
   */
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
 * Owner-identity counterpart to `authenticatedHostStreamKey` (R-1): same "no
 * auth" gate, but the value is the mode-aware `remoteAwareOwnerIdentity`
 * (hostId + userId, plus - for a remote host - its public key + relay attach
 * URL) rather than the dialability-only transport key. Durable owners
 * (chat/terminal session registries, the epic session mount) fold this into
 * their rebuild decision so a same-host remote public-key rotation - which
 * `hostTransportKey` cannot see, since every remote host shares one fixed
 * relay attach URL - closes the stale owner and acquires a fresh one instead
 * of leaving it pinned to the old key.
 */
export function authenticatedOwnerIdentityKey(
  globalClient: HostClient<HostRpcRegistry>,
  target: HostDirectoryEntry | null,
): string | null {
  if (globalClient.getRequestContext() === null) {
    return null;
  }
  return remoteAwareOwnerIdentityKey(
    target,
    globalClient.getRequestContextUserId(),
  );
}

/**
 * Constructs a per-host stream client with the standard dial/heartbeat
 * timings - the single place those timings live, shared by the app-wide
 * `HostStreamProvider`, the transient per-tab binding hook below, and the
 * session-owned durable transport (`openDurableStreamTransport`). Non-hook so
 * it can be called wherever a stream transport must be OWNED for a non-React
 * lifetime.
 *
 * Selects the transport by `target.kind` (T14, mirrors `useHostClientFor`'s
 * `buildMessenger`):
 *  - `local`: a `WsStreamClient` dialing `endpoint` (read live on each
 *    (re)dial, so a host respawn on a new url is followed without a client
 *    rebuild); `auth` wires UNAUTHORIZED recovery (null = terminal, for
 *    one-shot streams).
 *  - `remote`: a persistent `RemoteSession` (Noise-NK + mux) behind a
 *    `RemoteStreamClient`, built the SAME way `useHostClientFor` builds its
 *    RPC messenger for the same host - an independent session, not a shared
 *    one (a true single mux session per host across the RPC/stream/app-wide
 *    consumers is a further optimization, not required for this transport
 *    selection). Returns `null` when the host's public key does not decode
 *    (a malformed registry row degrades to "unconnectable").
 *
 * `bearer` is read live on each (re)dial for both branches so a credential
 * rotation is reflected.
 */
export function buildHostStreamClient(params: {
  readonly target: HostDirectoryEntry;
  readonly endpoint: HostEndpointProvider;
  readonly bearer: BearerSourceProvider;
  readonly authnBaseUrl: string;
  readonly auth: StreamAuthRevalidator | null;
  /**
   * The signed-in user this transport is built for. Part of the shared
   * `(hostId, userId)` remote-session cache key (Architecture §4 / S1) - only
   * consulted on the `target.kind === "remote"` branch.
   */
  readonly userId: string;
  // Whether to eagerly `start()` the remote session (warm-connect). Owned-
  // lifetime callers (`openDurableStreamTransport`, one-shot) pass `true`.
  // Render-path callers (`useHostStreamClientBindingFor`, `HostStreamProvider`)
  // pass `false` and instead build inside a `useEffect` (not a `useMemo` - see
  // those hooks' doc comments: under S1's shared `(hostId, userId)` session
  // cache, a `useMemo` factory that React invokes more than once per commit
  // would leave a discarded run's acquired reference on the shared session
  // permanently un-released, since only an effect's cleanup is guaranteed to
  // pair with exactly the committed acquire). `start()` is idempotent and
  // `subscribe()` lazily starts, so a caller that never eager-starts still
  // connects on first use.
  readonly autoStart: boolean;
}): IHostStreamClient<HostStreamRpcRegistry> | null {
  if (params.target.kind === "remote") {
    // Fail closed: an incomplete remote row (no public key / no relay url)
    // must never fall through to the plain-WS branch below - that would dial
    // a relay attach URL without the Noise-NK transport.
    if (
      !isRemoteHostDirectoryEntry(params.target) ||
      params.target.websocketUrl === null
    ) {
      return null;
    }

    const remoteTransport = createRemoteHostTransport<
      HostRpcRegistry,
      HostStreamRpcRegistry
    >({
      hostId: params.target.hostId,
      userId: params.userId,
      relayAttachUrl: params.target.websocketUrl,
      authnBaseUrl: params.authnBaseUrl,
      hostPublicKey: params.target.publicKey,
      bearer: params.bearer,
      rpcRegistry: hostRpcRegistry,
      streamRegistry: hostStreamRpcRegistry,
      webSocketFactory: browserStreamWebSocketFactory,
      requestId: uuidv4,
    });
    if (remoteTransport === null) return null;
    if (params.autoStart) {
      remoteTransport.session.start();
    }
    return remoteTransport.streamClient;
  }

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
 * no bound user - including transiently on first mount and right after a
 * dependency change, until the acquire effect below commits (see that
 * effect's doc comment for why the build lives there, not in a memo).
 * Callers should treat the authenticated transport identity (+ auth
 * revalidator) as what identifies "the same stream", not the `target` object
 * identity, so a directory refresh that allocates a fresh but equivalent
 * entry does not tear down an active stream session.
 */
export function useHostStreamClientBindingFor(
  target: HostDirectoryEntry | null,
  auth: StreamAuthRevalidator | null,
): HostStreamClientBinding | null {
  const globalClient = useHostClient();
  const authnBaseUrl = useRunnerHost().authnBaseUrl;
  // `null` when signed out or the credential lease was released - the
  // "no bound user" / "no auth" gate.
  const requestContext = globalClient.getRequestContext();
  const userId = globalClient.getRequestContextUserId();
  const transportKey =
    requestContext === null ? null : hostStreamTransportKeyFor(target, userId);
  const endpointHostId = target?.hostId ?? null;
  const endpointWebsocketUrl = target?.websocketUrl ?? null;
  const endpointKind = target?.kind ?? null;
  const endpointPublicKey =
    target !== null && isRemoteHostDirectoryEntry(target)
      ? target.publicKey
      : null;

  const [binding, setBinding] = useState<HostStreamClientBinding | null>(null);

  // Builds AND owns the client's lifecycle inside this ONE effect, rather
  // than a `useMemo` (as this hook did before S1's session cache) - see
  // `useHostClientFor`'s identically-shaped effect (`use-host-client-for.ts`)
  // for the full "why": a discarded `useMemo` invocation (StrictMode dev
  // double-invoke, or a discarded concurrent render in prod) used to be
  // harmless (each built its own independent, unstarted client that GC
  // reclaimed); under the shared `(hostId, userId)` session cache
  // (Architecture §4 / S1) a discarded acquire instead holds a live,
  // never-released reference on the ONE shared session, so the session's
  // refCount would never return to zero. This effect's cleanup is guaranteed
  // to run for exactly the committed acquire, so it supersedes both the old
  // `useMemo` AND `useCloseWsStreamClientOnReplace` (which only protected
  // against closing a STABLE memoized client too eagerly - moot now that the
  // client is built and closed by this same effect).
  useEffect(() => {
    if (
      transportKey === null ||
      endpointHostId === null ||
      endpointWebsocketUrl === null ||
      endpointKind === null ||
      userId === null
    ) {
      setBinding(null);
      return;
    }
    const endpoint = {
      hostId: endpointHostId,
      websocketUrl: endpointWebsocketUrl,
    };
    // Rebuilt from the primitive dependency values (not the live `target`
    // object identity) so a same-content directory re-emit does not rebuild
    // the client - see the dependency array below. `remoteStatus` plays no
    // role in transport construction (`buildHostStreamClient` only reads
    // `hostId`/`websocketUrl`/`publicKey`); it is a placeholder purely to
    // satisfy `isRemoteHostDirectoryEntry`'s shape check.
    const memoizedTarget =
      endpointKind === "remote" && endpointPublicKey !== null
        ? ({
            hostId: endpointHostId,
            label: endpointHostId,
            kind: "remote",
            websocketUrl: endpointWebsocketUrl,
            version: null,
            status: "available",
            publicKey: endpointPublicKey,
            remoteStatus: PLACEHOLDER_REMOTE_STATUS,
          } satisfies RemoteHostDirectoryEntry)
        : ({
            hostId: endpointHostId,
            label: endpointHostId,
            kind: endpointKind,
            websocketUrl: endpointWebsocketUrl,
            version: null,
            status: "available",
          } satisfies HostDirectoryEntry);

    const client = buildHostStreamClient({
      target: memoizedTarget,
      endpoint: () => endpoint,
      bearer: () => globalClient.getRequestContext()?.credentials ?? null,
      authnBaseUrl,
      auth,
      userId,
      // Never eager-start: this acquire is guaranteed exactly one matching
      // release (unlike the old memo-based build), but the connect-on-first-
      // subscribe laziness is an independent, unchanged behavior. `start()`
      // is idempotent and `subscribe()` lazily starts.
      autoStart: false,
    });
    if (client === null) {
      setBinding(null);
      return;
    }
    setBinding({
      transportKey: remoteAwareOwnerIdentity(memoizedTarget, userId),
      client,
    });

    return () => {
      client.close("transient-host-client-teardown");
    };
  }, [
    auth,
    authnBaseUrl,
    endpointHostId,
    endpointKind,
    endpointPublicKey,
    endpointWebsocketUrl,
    globalClient,
    transportKey,
    userId,
  ]);

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
): IHostStreamClient<HostStreamRpcRegistry> | null {
  return useHostStreamClientBindingFor(target, auth)?.client ?? null;
}

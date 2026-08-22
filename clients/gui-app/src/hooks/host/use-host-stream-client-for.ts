import { useEffect, useRef, useState } from "react";
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
import {
  appHostCredentialMintFlow,
  noteHostCredentialState,
} from "@/lib/auth/host-credential-provisioning";
import { acquireHostStreamClient } from "@/lib/host/host-stream-client-cache";
import { useHostBinding } from "@/lib/host/runtime";
import { processReconnectEngine } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import { transportEvidenceRelay } from "@/lib/host/transport-evidence";
import { appLogger } from "@/lib/logger";
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
  // `unknown`, not `offline`: this value is never rendered, but if it ever
  // leaked to a status surface it must not assert something we did not learn.
  // We are here precisely because the caller had no status DTO to hand.
  connectivity: "unknown",
  viewerReachability: "unknown",
  clientCloud: "ok",
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
  /**
   * Opt-in transport lease (Codex re-review, image-preview coalescing).
   *
   * A caller that hands `client` to a consumer outliving this hook instance -
   * a stream a sibling instance also reads from - must `pin()` it first and
   * `unpin()` exactly when that consumer's OWN need for it ends. **A pinned
   * transport must outlive every shared subscription opened through it; the
   * underlying close defers until the reference count reaches zero**, whether
   * that happens before or after this hook instance's own unmount.
   *
   * These are `retain`/`release` on the shared cache entry backing `client`
   * (`host-stream-client-cache.ts`), NOT a private count beside it, so the
   * sentence above holds ACROSS surfaces rather than within one instance.
   * `client` is no longer transient-per-instance either: a second surface
   * naming the same host holds this same object.
   *
   * A caller that never pins is unaffected. This hook holds exactly one
   * reference of its own, so its unmount still closes the client immediately -
   * unless another surface on the same host is holding it, which is the case
   * that used to open a duplicate transport instead.
   */
  readonly pin: () => void;
  readonly unpin: () => void;
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
      // Same UNAUTHORIZED recovery the local branch wires below: an expired
      // bearer at a wake-time re-attach revalidates + redials instead of
      // terminally closing the shared session (`RemoteSessionOptions.auth`).
      auth: params.auth,
      rpcRegistry: hostRpcRegistry,
      streamRegistry: hostStreamRpcRegistry,
      webSocketFactory: browserStreamWebSocketFactory,
      requestId: uuidv4,
      evidence: transportEvidenceRelay,
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
    // Always the app-wide flow, never a per-caller one: the renderer holds
    // several clients against one host, and the shared module is what keeps
    // that from becoming several concurrent mints revoking each other. It
    // resolves `unavailable` until the provisioning provider is mounted, so
    // dev shells and tests are unaffected.
    hostCredentialMint: appHostCredentialMintFlow,
    // Kept wired as the one place transports report credential state into,
    // but the report is deliberately INERT today: an `openAck` state carries
    // no provenance (which credential, which transport, when), so `active`
    // must NOT release the app-wide adoption claim - a delayed `active(A)`
    // observed before A was burned would free B's claim and reopen the
    // double-mint it exists to prevent. The claim expires on its TTL alone;
    // see `noteHostCredentialState`'s own doc. If a future frame carries the
    // credential's identity, this is the seam that starts trusting it.
    onHostCredentialState: noteHostCredentialState,
    // The LOCAL host's long-lived connection, so this is the leg that hears a
    // restart tombstone from a local host restarted by somebody other than
    // this app - a `traycer host restart` on the box, an update install. The
    // remote branch above reports through the same relay via its mux session.
    evidence: transportEvidenceRelay,
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
 * The bearer reads live from the binding's client's `RequestContext` (auth is
 * per-user, valid across hosts) so a credential-lease rotation is reflected.
 * The BINDING's client, not `useHostClient()`, deliberately: everything this
 * hook needs is the transport identity (request context, user id, bearer
 * rotation), which every requester binds to the same underlying client - and
 * `useHostClient()` returns a requester re-minted whenever the effective host
 * moves. With that object in the build effect's dependencies, each Activate or
 * failover tore down and re-dialed every stream client this hook owns,
 * including ones bound to hosts the move never touched; the notifications
 * provider read the local host's fresh instance as a respawn and wiped its
 * replica. Same source the app-wide `HostStreamProvider` uses for its bearer.
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
  const runtimeBinding = useHostBinding();
  if (runtimeBinding === null) {
    throw new Error(
      "useHostStreamClientBindingFor requires a HostRuntimeProvider",
    );
  }
  const globalClient = runtimeBinding.hostClient;
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
  const [rebuildNonce, setRebuildNonce] = useState(0);
  const teardownInProgressRef = useRef(false);
  // Same rebuild pacing the app-wide `HostStreamProvider` runs, and needed here
  // MORE than there: that provider follows the active host, while this hook
  // dials whichever machine its caller names - a per-tab binding, or a host
  // somebody picked out of a list and whose selection PERSISTS. An older host,
  // an incompatible protocol or a plan restriction closes every fresh dial the
  // same way, and without backoff that is a mint/dial/handshake loop running
  // for as long as the selection stands, with nothing on screen to explain it.
  // Same engine, same reason as the app-wide provider: the policy is the
  // registry's, the pacer is this hook instance's (its client retargets
  // whenever its caller names another host, and `markBuilt` clears the streak
  // on that identity change).
  const [rebuildBackoff] = useState(() =>
    processReconnectEngine().createRebuildPacer(),
  );

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
    //
    // `transportDialability` is written coarsely here for the same reason: this
    // is a FABRICATED entry describing an endpoint this effect has already
    // decided to dial, not a directory row carrying a verdict about a machine.
    // The gate that decides whether to dial at all ran above this, against the
    // real entry.
    const memoizedTarget =
      endpointKind === "remote" && endpointPublicKey !== null
        ? ({
            hostId: endpointHostId,
            label: endpointHostId,
            kind: "remote",
            websocketUrl: endpointWebsocketUrl,
            version: null,
            transportDialability: "dialable",
            publicKey: endpointPublicKey,
            remoteStatus: PLACEHOLDER_REMOTE_STATUS,
            // Fabricated endpoint, not a directory verdict: never in fuse grace.
            relayFuseGrace: false,
            recentHostCheckIn: false,
            // Same reason `transportDialability` is written coarsely above:
            // the plan gate ran upstream against the real directory entry, and
            // re-asserting a refusal here would contradict a dial this effect
            // has already been cleared to make.
            planAllowsRemote: true,
          } satisfies RemoteHostDirectoryEntry)
        : ({
            hostId: endpointHostId,
            label: endpointHostId,
            kind: endpointKind,
            websocketUrl: endpointWebsocketUrl,
            version: null,
            transportDialability: "dialable",
          } satisfies HostDirectoryEntry);

    // ONE reference on the SHARED client for this hook instance, taken here
    // and returned in the cleanup below. `buildHostStreamClient` runs only on
    // a cache miss: a second surface naming the same host adopts this exact
    // object, and that shared object identity is what makes the two share a
    // `git.subscribeStatus` instead of opening one each (the subscription
    // registries key on `client.instanceId`). See `host-stream-client-cache.ts`
    // for the identity, the eviction policy and how `pin`/`unpin` compose with
    // the reference count.
    const lease = acquireHostStreamClient(
      {
        kind: endpointKind,
        hostId: endpointHostId,
        userId,
        websocketUrl: endpointWebsocketUrl,
        publicKey: endpointPublicKey ?? "",
        authnBaseUrl,
        authRecovery: auth === null ? "terminal" : "revalidate",
      },
      () =>
        buildHostStreamClient({
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
        }),
    );
    if (lease === null) {
      setBinding(null);
      return;
    }
    const client = lease.client;
    // The SAME identity the binding is filed under, so the streak follows the
    // transport rather than this hook instance: a caller that retargets is
    // dialing a different machine, and the previous one's failures are not
    // evidence about it.
    const builtTransportKey = remoteAwareOwnerIdentity(memoizedTarget, userId);
    rebuildBackoff.markBuilt(Date.now(), builtTransportKey);
    setBinding({
      transportKey: builtTransportKey,
      client,
      // `pin`/`unpin` ARE this lease's retain/release. Deliberately not a
      // second count beside the cache's: two lifecycles over one object is
      // how the same code yields premature disposal in one race and a leak in
      // another.
      pin: lease.retain,
      unpin: lease.release,
    });

    return () => {
      teardownInProgressRef.current = true;
      // Returns THIS hook instance's own reference. The client is closed here
      // only if nothing else still holds one - neither a sibling surface on
      // the same host nor an outstanding `pin()`. A pinned transport
      // therefore still outlives this unmount and closes at the `unpin()`
      // that brings the count to zero, exactly as before.
      lease.release();
      teardownInProgressRef.current = false;
    };
  }, [
    auth,
    authnBaseUrl,
    endpointHostId,
    endpointKind,
    endpointPublicKey,
    endpointWebsocketUrl,
    globalClient,
    rebuildBackoff,
    rebuildNonce,
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

  useEffect(() => {
    if (client === null) return;
    let backoffTimer: number | null = null;
    const clearBackoffTimer = (): void => {
      if (backoffTimer === null) return;
      window.clearTimeout(backoffTimer);
      backoffTimer = null;
    };
    const rebuild = (): void => {
      if (teardownInProgressRef.current) return;
      const delayMs = rebuildBackoff.nextRebuildDelayMs(Date.now());
      appLogger.warn(
        "[stream] transient host stream client closed underneath its binding - rebuilding",
        {
          client: client.instanceId,
          closedReason: client.getClosedReason(),
          rebuildDelayMs: delayMs,
        },
      );
      if (delayMs === 0) {
        setRebuildNonce((nonce) => nonce + 1);
        return;
      }
      backoffTimer = window.setTimeout(() => {
        backoffTimer = null;
        setRebuildNonce((nonce) => nonce + 1);
      }, delayMs);
    };
    if (client.isClosed()) {
      rebuild();
      return clearBackoffTimer;
    }
    const unsubscribe = client.onClosed(rebuild);
    return () => {
      unsubscribe();
      clearBackoffTimer();
    };
  }, [client, rebuildBackoff]);

  return binding?.client.isClosed() === true ? null : binding;
}

export function useHostStreamClientFor(
  target: HostDirectoryEntry | null,
  auth: StreamAuthRevalidator | null,
): IHostStreamClient<HostStreamRpcRegistry> | null {
  return useHostStreamClientBindingFor(target, auth)?.client ?? null;
}

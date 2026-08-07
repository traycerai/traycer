import { v4 as uuidv4 } from "uuid";
import type {
  BearerSourceProvider,
  OpenFrameBearerSource,
} from "@traycer-clients/shared/auth/bearer-source";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  HostRpcError,
  type HostRequestAuthority,
  type IHostMessenger,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  createRemoteHostTransport,
  type IRemoteSession,
  type RemoteHostTransport,
} from "@traycer-clients/shared/host-transport/remote/index";
import { DEFAULT_DIAL_TIMEOUT_MS } from "@traycer-clients/shared/host-transport/transport-config";
import { createWhatwgStreamWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-stream-ws-factory";
import { createWhatwgWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-ws-factory";
import {
  HOST_POST_OPEN_ATTESTATION_WINDOW_MS,
  WsRpcClient,
  type RequestIdProvider,
} from "@traycer-clients/shared/host-transport/ws-rpc-client";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";

const DEFAULT_HOST_RPC_FRAME_TIMEOUT_MS = 30_000;
const TRANSPORT_KEY_SEPARATOR = "\u0000";

const browserWebSocketFactory = createWhatwgWebSocketFactory();
const browserStreamWebSocketFactory = createWhatwgStreamWebSocketFactory();

export interface BuiltHostMessenger<Registry extends VersionedRpcRegistry> {
  readonly messenger: IHostMessenger<Registry>;
  readonly remoteTransport: RemoteHostTransport<
    Registry,
    HostStreamRpcRegistry
  > | null;
}

export interface BuildRawHostMessengerForTargetParams<
  Registry extends VersionedRpcRegistry,
> {
  readonly target: HostDirectoryEntry;
  readonly registry: Registry;
  /**
   * Reads the bearer the CURRENT request is authorized under. The remote
   * transport outlives any single request (its Noise session is cached per
   * `(hostId, userId)`), so it must read the live lease rather than capture
   * one request's `authority.bearer` - that is what lets a rotated-in-place
   * bearer reach the next `open` frame without rebuilding the session.
   */
  readonly bearer: BearerSourceProvider;
  /**
   * Auth recovery for an `UNAUTHORIZED` remote-session fatal (an expired
   * bearer at a wake-time re-attach; see `RemoteSessionOptions.auth`).
   * `null` keeps such a fatal terminal - acceptable only for short-lived
   * callers; the runtime messenger always passes the app revalidator.
   */
  readonly auth: StreamAuthRevalidator | null;
  readonly authnBaseUrl: string;
  readonly requestId: RequestIdProvider;
  /** The signed-in user this messenger is built for (Architecture §4 / S1 cache key). */
  readonly userId: string;
}

export function buildRawHostMessengerForTarget<
  Registry extends VersionedRpcRegistry,
>(
  params: BuildRawHostMessengerForTargetParams<Registry>,
): BuiltHostMessenger<Registry> | null {
  if (params.target.kind === "remote") {
    if (
      !isRemoteHostDirectoryEntry(params.target) ||
      params.target.websocketUrl === null
    ) {
      // A "remote" entry that isn't fully formed (missing publicKey/remoteStatus,
      // or no dialable websocketUrl) must never fall through to the local
      // WsRpcClient path below - that would skip the Noise transport entirely.
      return null;
    }

    const remoteTransport = createRemoteHostTransport<
      Registry,
      HostStreamRpcRegistry
    >({
      hostId: params.target.hostId,
      userId: params.userId,
      relayAttachUrl: params.target.websocketUrl,
      authnBaseUrl: params.authnBaseUrl,
      hostPublicKey: params.target.publicKey,
      bearer: params.bearer,
      auth: params.auth,
      rpcRegistry: params.registry,
      streamRegistry: hostStreamRpcRegistry,
      webSocketFactory: browserStreamWebSocketFactory,
      requestId: params.requestId,
    });
    if (remoteTransport === null) return null;
    return {
      messenger: remoteTransport.messenger,
      remoteTransport,
    };
  }

  return {
    messenger: new WsRpcClient<Registry>({
      registry: params.registry,
      requestId: params.requestId,
      webSocketFactory: browserWebSocketFactory,
      dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
      frameTimeoutMs: DEFAULT_HOST_RPC_FRAME_TIMEOUT_MS,
      // The GUI's response deadline matches the host's post-`openAck`
      // deadline, so which overdue timer runs first is up to scheduling (or a
      // sleep/resume - and a stalled host fires its timer late, well past
      // 30s). This window keeps the socket open long enough for the host's
      // no-dispatch attestation when the client's timer wins that race.
      hostAttestationWindowMs: HOST_POST_OPEN_ATTESTATION_WINDOW_MS,
    }),
    remoteTransport: null,
  };
}

export interface RuntimeHostMessengerBinding<
  Registry extends VersionedRpcRegistry,
> {
  readonly messenger: IHostMessenger<Registry>;
  readonly reset: () => void;
  readonly dispose: () => void;
}

export interface BuildRuntimeHostMessengerParams<
  Registry extends VersionedRpcRegistry,
> {
  readonly registry: Registry;
  /**
   * Resolves the full directory entry for the host a `HostRequestAuthority`
   * names. The authority only carries `{ hostId, websocketUrl }`, but the
   * remote branch additionally needs `kind`/`publicKey` to decide that this is
   * a relay target at all and to run the Noise-NK handshake - so the entry is
   * looked up here rather than threaded through the transport contract.
   */
  readonly resolveTarget: (hostId: string) => HostDirectoryEntry | null;
  /**
   * Auth recovery the remote transport uses when the host FATALs the shared
   * session `UNAUTHORIZED` (see `BuildRawHostMessengerForTargetParams.auth`).
   * The runtime provider passes the app revalidator so a wake-time expired
   * bearer redials with a fresh one instead of bricking the session.
   */
  readonly auth: StreamAuthRevalidator | null;
  readonly authnBaseUrl: string;
  readonly requestId: RequestIdProvider;
  /**
   * Ready-boundary evidence for the runtime binding's remote session, keyed
   * by the host it serves. The runtime messenger is the ONLY holder of a
   * remote session for a host that is neither the active host (stream-
   * runtime wires that one) nor tab-bound (the durable per-tab transport
   * wires those) - e.g. a Settings host-picker selection. Queries that raced
   * this session's dial have already errored pre-send, so without this
   * callback their host scope is never told the session came up and they
   * strand on an error card until their own retry backoff fires (measured at
   * 15-20s in production). Wire it to
   * `HostClient.notifyHostAvailabilityRecovered`.
   */
  readonly onRemoteAvailabilityRecovered: (hostId: string) => void;
}

export function buildRuntimeHostMessenger<
  Registry extends VersionedRpcRegistry,
>(
  params: BuildRuntimeHostMessengerParams<Registry>,
): RuntimeHostMessengerBinding<Registry> {
  const messenger = new RuntimeHostMessenger(params);
  return {
    messenger,
    reset: () => messenger.reset(),
    dispose: () => messenger.dispose(),
  };
}

class RuntimeHostMessenger<
  Registry extends VersionedRpcRegistry,
> implements IHostMessenger<Registry> {
  private readonly registry: Registry;
  private readonly resolveTarget: (hostId: string) => HostDirectoryEntry | null;
  private readonly auth: StreamAuthRevalidator | null;
  private readonly authnBaseUrl: string;
  private readonly requestId: RequestIdProvider;
  private readonly onRemoteAvailabilityRecovered: (hostId: string) => void;
  private readonly localMessenger: IHostMessenger<Registry>;
  private remoteBinding: RemoteBinding<Registry> | null = null;
  // The bearer of the request currently being dispatched. The cached remote
  // session outlives a single request, so it reads this through a thunk
  // instead of capturing one authority's bearer - a bearer rotated in place
  // for the same context then reaches the next `open` frame unchanged.
  private currentBearer: OpenFrameBearerSource | null = null;
  // Terminal. `reset()` is a recoverable release; `dispose()` is the end of
  // this messenger's life, after which a request must not silently rebuild a
  // remote binding no caller remains to ever release.
  private disposed = false;
  /**
   * At most ONE released-but-still-owed availability listener per host. A new
   * subscription for the same host takes over the old orphan's debt: the
   * boundary exists to un-strand queries via a host-scope invalidation, and
   * one invalidation serves every generation's stranded queries alike -
   * whereas keeping each generation's orphan would fan out one duplicate
   * invalidation per picker visit that released mid-dial (the exact pile-up
   * the orphan design promises not to build), and would double-deliver when a
   * re-visit adopts the SAME still-dialing session from the keep-warm cache.
   */
  private readonly owedOrphanDetachByHost = new Map<string, () => void>();

  constructor(params: BuildRuntimeHostMessengerParams<Registry>) {
    this.registry = params.registry;
    this.resolveTarget = params.resolveTarget;
    this.auth = params.auth;
    this.authnBaseUrl = params.authnBaseUrl;
    this.requestId = params.requestId;
    this.onRemoteAvailabilityRecovered = params.onRemoteAvailabilityRecovered;
    this.localMessenger = new WsRpcClient<Registry>({
      registry: params.registry,
      requestId: params.requestId,
      webSocketFactory: browserWebSocketFactory,
      dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
      frameTimeoutMs: DEFAULT_HOST_RPC_FRAME_TIMEOUT_MS,
      // Same post-`openAck` attestation grace as the standalone builder above.
      hostAttestationWindowMs: HOST_POST_OPEN_ATTESTATION_WINDOW_MS,
    });
  }

  request<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    authority: HostRequestAuthority,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    const disposedRejection = this.rejectIfDisposed(method);
    if (disposedRejection !== null) {
      return disposedRejection;
    }
    const target = this.resolveTarget(authority.endpoint.hostId);
    if (target === null || target.kind !== "remote") {
      this.closeRemoteTransport();
      return this.localMessenger.request(method, params, authority);
    }

    const remoteMessenger = this.remoteMessengerFor(target, authority);
    if (remoteMessenger === null) {
      return Promise.reject(
        new HostRpcError({
          code: "RPC_ERROR",
          message: `Remote host '${target.hostId}' does not expose a valid remote transport`,
          requestId: this.requestId(),
          method,
          fatalDetails: null,
        }),
      );
    }
    return remoteMessenger.request(method, params, authority);
  }

  requestWithResponseTimeout<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    responseTimeoutMs: number,
    authority: HostRequestAuthority,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    const disposedRejection = this.rejectIfDisposed(method);
    if (disposedRejection !== null) {
      return disposedRejection;
    }
    const target = this.resolveTarget(authority.endpoint.hostId);
    if (target === null || target.kind !== "remote") {
      this.closeRemoteTransport();
      return this.localMessenger.requestWithResponseTimeout(
        method,
        params,
        responseTimeoutMs,
        authority,
      );
    }

    const remoteMessenger = this.remoteMessengerFor(target, authority);
    if (remoteMessenger === null) {
      return Promise.reject(
        new HostRpcError({
          code: "RPC_ERROR",
          message: `Remote host '${target.hostId}' does not expose a valid remote transport`,
          requestId: this.requestId(),
          method,
          fatalDetails: null,
        }),
      );
    }
    return remoteMessenger.requestWithResponseTimeout(
      method,
      params,
      responseTimeoutMs,
      authority,
    );
  }

  /**
   * Terminal teardown. Unlike `reset()`, this HARD-detaches the binding's
   * availability listener instead of orphaning it: an orphan exists to carry
   * one owed boundary to a runtime that is still there to receive it, and
   * after dispose there is no such runtime - a late boundary would fire this
   * messenger's callback into a torn-down provider closure. The detach also
   * drops any prior orphan still owed for other hosts, and the `disposed`
   * flag keeps a stray late request from rebuilding a binding that nothing
   * remains to release.
   */
  dispose(): void {
    this.disposed = true;
    for (const detach of [...this.owedOrphanDetachByHost.values()]) {
      detach();
    }
    this.teardownRemoteTransport();
  }

  reset(): void {
    this.closeRemoteTransport();
  }

  private remoteMessengerFor(
    target: HostDirectoryEntry,
    authority: HostRequestAuthority,
  ): IHostMessenger<Registry> | null {
    const nextKey = remoteTransportKey(target);
    if (nextKey === null) {
      return null;
    }
    if (authority.abortSignal.aborted) {
      // A retired authority must never reach the session cache: the cache's
      // supersession sweep treats the acquiring identity as the NEWEST
      // context, so an acquire under a stale lease's epoch would mark the
      // LIVE entry superseded and build a doomed successor. The retrying
      // wrapper already throws pre-dispatch on an aborted authority, but that
      // gate lives three layers up - this seam is where the assumption is
      // load-bearing, so it must not depend on who composed the wrappers.
      return null;
    }
    // Publish this request's bearer before any dial so both a cache hit and a
    // freshly-built session read the lease this call was authorized under.
    this.currentBearer = authority.bearer;
    if (this.remoteBinding !== null && this.remoteBinding.key === nextKey) {
      if (!this.remoteBinding.transport.session.isClosed()) {
        return this.remoteBinding.transport.messenger;
      }
      // The cached session terminally closed underneath (a session-level
      // fatal). A closed session can never carry traffic again (`start()`
      // no-ops once closed), so release the dead binding and rebuild below -
      // the session cache evicts closed entries on acquire, so the rebuild
      // mints a live successor rather than re-pinning the corpse.
      this.closeRemoteTransport();
    }
    // The remote session cache is keyed `(hostId, userId)` (Architecture §4 /
    // S1); the authority's bearer is the authoritative identity for the
    // request being dispatched, so take the user from it rather than a
    // separately-read signed-in user that could disagree mid-transition.
    const userId = authority.bearer.identity.userId;

    this.closeRemoteTransport();
    const built = buildRawHostMessengerForTarget({
      target,
      userId,
      registry: this.registry,
      bearer: () => this.currentBearer,
      auth: this.auth,
      authnBaseUrl: this.authnBaseUrl,
      requestId: this.requestId,
    });
    if (built === null || built.remoteTransport === null) {
      return null;
    }
    built.remoteTransport.session.start();
    // Every ready boundary (the clean first open included) un-strands the
    // queries that raced this session's dial and errored pre-send - this
    // binding is the only session holder for a non-active, non-tab host, so
    // nothing else can deliver that evidence.
    const availability = this.subscribeRemoteAvailability(
      built.remoteTransport.session,
      target.hostId,
    );
    this.remoteBinding = {
      key: nextKey,
      transport: built.remoteTransport,
      availability,
    };
    return built.messenger;
  }

  /**
   * Forwards `session`'s availability-recovered events for `hostId`, and
   * returns a RELEASE function - deliberately not an unsubscribe.
   *
   * This messenger holds ONE remote binding, and any request for a local or
   * different host replaces it (see `request`). Since the session cache keeps
   * a released session warm rather than closing it, a session that was still
   * dialing when the slot flipped goes on to reach its first ready boundary -
   * and that boundary is the only evidence that un-strands the queries which
   * already errored against it. Detaching at replacement time would drop
   * precisely the event this wiring exists to deliver, in precisely the
   * interleaving (a background active-host request landing mid-dial) that
   * makes it necessary.
   *
   * So a released subscription stays attached, fires at most once more, and
   * then removes itself. It is also removed if the session closes without ever
   * getting ready - a session-level fatal, or the keep-warm linger expiring -
   * so a churning host picker cannot accumulate listeners.
   *
   * The orphan is owed exactly ONE outstanding boundary. A binding that
   * already saw one has nothing left to carry: the queries it would un-strand
   * were re-armed then, so release detaches it on the spot. And per HOST there
   * is at most one orphan at a time: subscribing a new binding for the same
   * host takes over the previous orphan's debt (see
   * `owedOrphanDetachByHost`), because one host-scope invalidation un-strands
   * every generation's queries alike. Otherwise a picker toggling between an
   * UNREACHABLE host and another would pile up one permanent listener per
   * visit on a session that never gets ready but is kept alive (a bound tab,
   * or re-visits landing inside the keep-warm linger), and the host's
   * eventual recovery would fan out that many duplicate invalidations - and a
   * re-visit that warm-adopts the SAME still-dialing session would deliver
   * one boundary twice, once through the orphan and once through the current
   * listener.
   */
  private subscribeRemoteAvailability(
    session: IRemoteSession<Registry, HostStreamRpcRegistry>,
    hostId: string,
  ): AvailabilitySubscription {
    const previousOrphanDetach = this.owedOrphanDetachByHost.get(hostId);
    if (previousOrphanDetach !== undefined) {
      // This subscription carries the host's debt from here on.
      previousOrphanDetach();
    }
    let released = false;
    // Whether this listener is still WAITING on a boundary. That is the whole
    // reason a released binding's listener is allowed to outlive it - it owes
    // the queries one invalidation - so it is also the exact condition for
    // detaching. Tracked as "owed" rather than "delivered" because the two
    // differ on the warm-cache path below, where a boundary is never owed and
    // therefore never delivered either.
    let boundaryOwed = true;
    let detached = false;
    let unsubscribeAvailability: (() => void) | null = null;
    let unsubscribeClosed: (() => void) | null = null;
    const detach = (): void => {
      if (detached) {
        return;
      }
      detached = true;
      if (this.owedOrphanDetachByHost.get(hostId) === detach) {
        this.owedOrphanDetachByHost.delete(hostId);
      }
      unsubscribeAvailability?.();
      unsubscribeClosed?.();
    };
    unsubscribeAvailability = session.subscribeAvailabilityRecovered(() => {
      boundaryOwed = false;
      this.onRemoteAvailabilityRecovered(hostId);
      if (released) {
        detach();
      }
    });
    unsubscribeClosed = session.onClosed(detach);
    // An ALREADY-ready session owes nothing: `subscribeAvailabilityRecovered`
    // fires on a recovery, not on the current state, so a binding that adopts a
    // warm cached session would otherwise wait forever for a boundary that has
    // already happened - and, since it never arrives, never detach on release.
    // Every picker visit would then leave one more listener on a session some
    // other consumer keeps alive, and the next real reconnect would fan out one
    // duplicate invalidation per abandoned visit.
    //
    // Read AFTER subscribing, so the check cannot fall in the gap: a session
    // that becomes ready in between has already run the listener above and
    // cleared the flag, and re-clearing it here is a no-op.
    if (session.isReady()) {
      boundaryOwed = false;
    }
    return {
      release: () => {
        released = true;
        if (!boundaryOwed) {
          detach();
          return;
        }
        // Now an orphan: record its detach so the host's NEXT subscription
        // (which takes over the debt) or `dispose()` can retire it.
        this.owedOrphanDetachByHost.set(hostId, detach);
      },
      detach,
    };
  }

  /**
   * Release the binding for reuse: the physical session goes back to the
   * keep-warm cache and a still-owed availability listener stays attached as
   * the host's orphan. This is the replacement/reset path - for terminal
   * teardown see `teardownRemoteTransport`.
   */
  private closeRemoteTransport(): void {
    if (this.remoteBinding === null) {
      return;
    }
    const binding = this.remoteBinding;
    this.remoteBinding = null;
    binding.availability.release();
    binding.transport.session.close();
  }

  private teardownRemoteTransport(): void {
    if (this.remoteBinding === null) {
      return;
    }
    const binding = this.remoteBinding;
    this.remoteBinding = null;
    binding.availability.detach();
    binding.transport.session.close();
  }

  private rejectIfDisposed(method: string): Promise<never> | null {
    if (!this.disposed) {
      return null;
    }
    return Promise.reject(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "Host messenger has been disposed",
        requestId: this.requestId(),
        method,
        fatalDetails: null,
      }),
    );
  }
}

/**
 * The two ways a binding's availability forwarding can end. `release` orphans
 * a still-owed listener rather than detaching it - see
 * `subscribeRemoteAvailability` for why it has to outlive the binding on the
 * replacement path. `detach` removes it unconditionally, for terminal
 * teardown where no runtime remains to receive a late boundary.
 */
interface AvailabilitySubscription {
  readonly release: () => void;
  readonly detach: () => void;
}

interface RemoteBinding<Registry extends VersionedRpcRegistry> {
  readonly key: string;
  readonly transport: RemoteHostTransport<Registry, HostStreamRpcRegistry>;
  readonly availability: AvailabilitySubscription;
}

function remoteTransportKey(entry: HostDirectoryEntry): string | null {
  if (
    entry.kind !== "remote" ||
    !isRemoteHostDirectoryEntry(entry) ||
    entry.websocketUrl === null
  ) {
    return null;
  }
  // `status` is deliberately excluded: it doesn't feed `createRemoteHostTransport`,
  // so folding it into the identity key would rotate the session (tearing down a
  // healthy Noise/relay transport) on every availability/busy poll update.
  return [
    entry.hostId,
    entry.websocketUrl,
    entry.version ?? "",
    entry.publicKey,
  ].join(TRANSPORT_KEY_SEPARATOR);
}

export const defaultHostRpcRequestId: RequestIdProvider = () => uuidv4();

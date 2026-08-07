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

  dispose(): void {
    this.closeRemoteTransport();
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
    const releaseAvailability = this.subscribeRemoteAvailability(
      built.remoteTransport.session,
      target.hostId,
    );
    this.remoteBinding = {
      key: nextKey,
      transport: built.remoteTransport,
      releaseAvailability,
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
   */
  private subscribeRemoteAvailability(
    session: IRemoteSession<Registry, HostStreamRpcRegistry>,
    hostId: string,
  ): () => void {
    let released = false;
    let detached = false;
    let unsubscribeAvailability: (() => void) | null = null;
    let unsubscribeClosed: (() => void) | null = null;
    const detach = (): void => {
      if (detached) {
        return;
      }
      detached = true;
      unsubscribeAvailability?.();
      unsubscribeClosed?.();
    };
    unsubscribeAvailability = session.subscribeAvailabilityRecovered(() => {
      this.onRemoteAvailabilityRecovered(hostId);
      if (released) {
        detach();
      }
    });
    unsubscribeClosed = session.onClosed(detach);
    return () => {
      released = true;
    };
  }

  private closeRemoteTransport(): void {
    if (this.remoteBinding === null) {
      return;
    }
    const binding = this.remoteBinding;
    this.remoteBinding = null;
    binding.releaseAvailability();
    binding.transport.session.close();
  }
}

interface RemoteBinding<Registry extends VersionedRpcRegistry> {
  readonly key: string;
  readonly transport: RemoteHostTransport<Registry, HostStreamRpcRegistry>;
  /**
   * Orphans this binding's availability forwarding rather than detaching it -
   * see `subscribeRemoteAvailability` for why the listener has to outlive the
   * binding.
   */
  readonly releaseAvailability: () => void;
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

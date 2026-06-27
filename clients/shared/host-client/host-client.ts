import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { RequestContext } from "@traycer/protocol/auth/request-context";
import type {
  HostRpcError,
  IHostMessenger,
  RequestOfMethod,
  ResponseOfMethod,
} from "../host-transport/host-messenger";
import { HostRpcError as HostRpcErrorCtor } from "../host-transport/host-messenger";
import type { HostDirectoryEntry } from "./host-directory";

/**
 * Narrow port the client calls to invalidate host-scoped query state.
 *
 * `gui-app` wires this to `queryClient.invalidateQueries({ queryKey: ["host", hostId, …] })`.
 * Passing `null` means "no host selected" - consumers typically drop any
 * host-scoped entries entirely.
 */
export interface IHostQueryInvalidator {
  invalidateHostScope(
    hostId: string | null,
    options: HostQueryInvalidationOptions,
  ): void;
}

export interface HostQueryInvalidationOptions {
  readonly refetchActive: boolean;
}

/** Unsubscribe handle returned by `HostClient` event subscriptions. */
export type HostClientUnsubscribe = () => void;

export interface HostClientChangeEvent {
  readonly previousHostId: string | null;
  readonly currentHostId: string | null;
  readonly reason: HostClientChangeReason;
}

export type HostClientChangeReason =
  | "auth-changed"
  | "host-bound"
  | "host-updated"
  | "host-unbound"
  | "availability-recovered";

export interface HostClientOptions<Registry extends VersionedRpcRegistry> {
  readonly registry: Registry;
  readonly messenger: IHostMessenger<Registry>;
  readonly invalidator: IHostQueryInvalidator;
}

/**
 * App-facing host client used by `gui-app`.
 *
 * Responsibilities:
 * 1. Hold the currently selected host and the active `RequestContext`.
 *    The context is the runtime auth authority below the auth boundary -
 *    raw bearer strings live only inside `ctx.credentials` and are
 *    extracted by final transport clients (`WsRpcClient`, stream clients)
 *    when opening a WS connection.
 * 2. Delegate typed unary requests to an `IHostMessenger` - the messenger
 *    performs the actual envelope/transport work (see `WsRpcClient`).
 * 3. Invalidate host-scoped TanStack Query state whenever the
 *    `RequestContext` identity transitions (sign-in / sign-out /
 *    cross-user), the selected host changes, or a previously
 *    unavailable endpoint reports availability recovery. Same-user
 *    credential rotation does NOT replace the context reference (the
 *    `RequestContextProvider` rotates the lease in place), so the cache
 *    is preserved across token refreshes - only identity transitions
 *    drop host-scoped entries.
 *
 * The messenger is constructed once with endpoint/context providers that
 * read `HostClient`'s state (see `WsRpcClient`), so swapping hosts or
 * minting a new context does not require rebuilding transport wiring.
 */
export class HostClient<Registry extends VersionedRpcRegistry> {
  private readonly registry: Registry;
  private readonly messenger: IHostMessenger<Registry>;
  private readonly invalidator: IHostQueryInvalidator;

  private activeHost: HostDirectoryEntry | null = null;
  private requestContext: RequestContext | null = null;
  private readonly changeHandlers = new Set<
    (event: HostClientChangeEvent) => void
  >();
  private readonly bearerRotationHandlers = new Set<() => void>();

  constructor(options: HostClientOptions<Registry>) {
    this.registry = options.registry;
    this.messenger = options.messenger;
    this.invalidator = options.invalidator;
  }

  /** Returns the registry this client was constructed with (for type callers). */
  getRegistry(): Registry {
    return this.registry;
  }

  getActiveHost(): HostDirectoryEntry | null {
    return this.activeHost;
  }

  getActiveHostId(): string | null {
    return this.activeHost === null ? null : this.activeHost.hostId;
  }

  /**
   * Returns the active `RequestContext`, or `null` when signed out / not
   * yet authenticated. Final transport clients call this to extract a
   * bearer (`ctx.credentials.getBearerToken()`) when opening a WS frame;
   * shared-core consumers thread the context itself past the boundary.
   */
  getRequestContext(): RequestContext | null {
    return this.requestContext;
  }

  /**
   * Returns the active request-context identity only when the context still
   * owns a usable credential lease. Query/stream UI uses this as the central
   * "host communication may start" signal; transports still extract the
   * bearer at the final WS boundary.
   */
  getRequestContextUserId(): string | null {
    if (this.requestContext === null) {
      return null;
    }
    if (this.requestContext.credentials.isReleased) {
      return null;
    }
    return this.requestContext.identity.userId;
  }

  /**
   * Selects a host (or clears selection with `null`). When the active host
   * id changes, invalidates the host-scoped cache for the previous host
   * (so stale entries are dropped) and notifies subscribers.
   */
  bind(entry: HostDirectoryEntry | null): void {
    const previous = this.activeHost;
    if (sameHostId(previous, entry)) {
      this.activeHost = entry;
      if (!sameHostTransport(previous, entry)) {
        if (entry !== null) {
          this.invalidator.invalidateHostScope(entry.hostId, {
            refetchActive: true,
          });
        }
        this.emitChange({
          previousHostId: previous === null ? null : previous.hostId,
          currentHostId: entry === null ? null : entry.hostId,
          reason: "host-updated",
        });
      }
      return;
    }

    this.activeHost = entry;
    this.invalidator.invalidateHostScope(
      previous === null ? null : previous.hostId,
      { refetchActive: false },
    );
    if (entry !== null) {
      this.invalidator.invalidateHostScope(entry.hostId, {
        refetchActive: true,
      });
    }
    this.emitChange({
      previousHostId: previous === null ? null : previous.hostId,
      currentHostId: entry === null ? null : entry.hostId,
      reason: entry === null ? "host-unbound" : "host-bound",
    });
  }

  /**
   * Reports that an endpoint the client already selected has just recovered
   * availability. Invalidates host-scoped cache so active observers refetch
   * against the recovered endpoint. No-op when no host is bound.
   */
  notifyAvailabilityRecovered(): void {
    if (this.activeHost === null) {
      return;
    }
    this.invalidator.invalidateHostScope(this.activeHost.hostId, {
      refetchActive: true,
    });
    this.emitChange({
      previousHostId: this.activeHost.hostId,
      currentHostId: this.activeHost.hostId,
      reason: "availability-recovered",
    });
  }

  /**
   * Updates the `RequestContext` the messenger threads onto outgoing
   * requests. An identity transition (the previous and next contexts have
   * different `userId`s, OR one side is `null`) invalidates the
   * host-scoped cache so cached responses tied to the previous identity
   * are dropped. Reattaching the SAME context reference is a no-op.
   *
   * Same-user credential rotation does NOT pass through this method -
   * `RequestContextProvider.rotateCurrentBearer(...)` mutates the existing
   * lease in place and does not emit a fresh context. The cache therefore
   * survives token refreshes intact.
   */
  setRequestContext(ctx: RequestContext | null): void {
    if (this.requestContext === ctx) {
      return;
    }
    this.requestContext = ctx;
    const currentHostId =
      this.activeHost === null ? null : this.activeHost.hostId;
    this.invalidator.invalidateHostScope(currentHostId, {
      refetchActive: false,
    });
    this.emitChange({
      previousHostId: currentHostId,
      currentHostId,
      reason: "auth-changed",
    });
  }

  onChange(
    handler: (event: HostClientChangeEvent) => void,
  ): HostClientUnsubscribe {
    this.changeHandlers.add(handler);
    return () => {
      this.changeHandlers.delete(handler);
    };
  }

  /**
   * Subscribes to in-place bearer rotations (same-user token refresh). Distinct
   * from `onChange`, which only fires on identity transitions; rotation keeps
   * the same context reference. Stream transports listen here to push the fresh
   * credential onto open connections (`credentialUpdate`) without a reconnect.
   */
  onBearerRotated(handler: () => void): HostClientUnsubscribe {
    this.bearerRotationHandlers.add(handler);
    return () => {
      this.bearerRotationHandlers.delete(handler);
    };
  }

  /**
   * Fires every `onBearerRotated` subscriber. Called by `HostRuntime` when the
   * `RequestContextProvider` rotates the active context's bearer in place.
   */
  notifyBearerRotated(): void {
    for (const handler of [...this.bearerRotationHandlers]) {
      handler();
    }
  }

  /**
   * Delegates to the messenger. The messenger reads the latest endpoint /
   * context state at call time, so any `bind` / `setRequestContext` update
   * that happened before `request` is resolved takes effect for this call.
   */
  request<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    const preflightError = this.readRequestPreflightError(method);
    if (preflightError !== null) {
      return Promise.reject(preflightError);
    }
    return this.messenger.request(method, params);
  }

  private readRequestPreflightError(method: string): HostRpcError | null {
    if (this.activeHost === null) {
      return new HostRpcErrorCtor({
        code: "RPC_ERROR",
        message: "Cannot call host RPC without an active host",
        requestId: "client-preflight",
        method,
        fatalDetails: null,
      });
    }
    if (this.requestContext === null) {
      return new HostRpcErrorCtor({
        code: "RPC_ERROR",
        message:
          "Cannot call host RPC without an authenticated request context",
        requestId: "client-preflight",
        method,
        fatalDetails: null,
      });
    }
    if (this.requestContext.credentials.isReleased) {
      return new HostRpcErrorCtor({
        code: "RPC_ERROR",
        message:
          "Cannot call host RPC with a released authenticated request context",
        requestId: "client-preflight",
        method,
        fatalDetails: null,
      });
    }
    return null;
  }

  private emitChange(event: HostClientChangeEvent): void {
    for (const handler of this.changeHandlers) {
      handler(event);
    }
  }
}

function sameHostId(
  previous: HostDirectoryEntry | null,
  next: HostDirectoryEntry | null,
): boolean {
  if (previous === null && next === null) {
    return true;
  }
  if (previous === null || next === null) {
    return false;
  }
  return previous.hostId === next.hostId;
}

function sameHostTransport(
  previous: HostDirectoryEntry | null,
  next: HostDirectoryEntry | null,
): boolean {
  if (previous === null || next === null) {
    return previous === next;
  }
  return (
    previous.hostId === next.hostId &&
    previous.kind === next.kind &&
    previous.websocketUrl === next.websocketUrl &&
    previous.version === next.version &&
    previous.status === next.status
  );
}

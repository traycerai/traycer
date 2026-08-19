import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { RequestContext } from "@traycer/protocol/auth/request-context";
import type {
  HostRpcError,
  HostRequestAuthority,
  IHostMessenger,
  RequestOfMethod,
  ResponseOfMethod,
} from "../host-transport/host-messenger";
import { HostRpcError as HostRpcErrorCtor } from "../host-transport/host-messenger";
import type { HostDirectoryEntry } from "./host-directory";
import {
  HostBindingAuthorityRegistry,
  StaleHostBindingAuthorityError,
} from "./host-binding-authority-registry";
import {
  HostRequestCoordinator,
  type HostRequestAuthorityDomain,
} from "./host-request-coordinator";
import type { RpcSchedulingPolicy } from "./rpc-scheduling-policy";

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
  /** Cancels observers before a binding/context change aborts their jobs. */
  readonly cancelHostScope?: (hostId: string | null) => Promise<void>;
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

/**
 * Two reasons, and there used to be five. `host-bound` / `host-updated` /
 * `host-unbound` were the active slot announcing itself; the slot is gone
 * (redesign D17 / P4.2) and a host becoming effective is a fact the selection
 * layer publishes, not an event this client emits.
 */
export type HostClientChangeReason = "auth-changed" | "availability-recovered";

export interface HostClientOptions<Registry extends VersionedRpcRegistry> {
  readonly registry: Registry;
  readonly messenger: IHostMessenger<Registry>;
  readonly invalidator: IHostQueryInvalidator;
  /** Registry-exhaustive unary scheduling policy supplied by the shell. */
  readonly schedulingPolicy?: RpcSchedulingPolicy<Registry>;
  /** Provider-owned in GUI; standalone callers may let this client own one. */
  readonly requestCoordinator?: HostRequestCoordinator<Registry> | null;
  /** Shared by default and routed clients created within one host runtime. */
  readonly authorityRegistry?: HostBindingAuthorityRegistry;
  /** Reads the live directory entry to reject stale routed captures. */
  readonly findHostById?: (hostId: string) => HostDirectoryEntry | null;
}

/** Narrow request surface shared by the default client and routed facades. */
export interface HostRequester<Registry extends VersionedRpcRegistry> {
  getRegistry(): Registry;
  getActiveHost(): HostDirectoryEntry | null;
  getActiveHostId(): string | null;
  getRequestContext(): RequestContext | null;
  getRequestContextUserId(): string | null;
  onChange(
    handler: (event: HostClientChangeEvent) => void,
  ): HostClientUnsubscribe;
  request<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ): Promise<ResponseOfMethod<Registry, Method>>;
  requestWithSignal<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    signal: AbortSignal | undefined,
  ): Promise<ResponseOfMethod<Registry, Method>>;
  requestWithResponseTimeout<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    responseTimeoutMs: number,
  ): Promise<ResponseOfMethod<Registry, Method>>;
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
  private readonly authorityRegistry: HostBindingAuthorityRegistry;
  private readonly findHostById: (hostId: string) => HostDirectoryEntry | null;
  private readonly schedulingPolicy: RpcSchedulingPolicy<Registry>;
  private readonly requestCoordinator: HostRequestCoordinator<Registry>;
  private readonly ownsRequestCoordinator: boolean;

  private requestContext: RequestContext | null = null;
  private readonly changeHandlers = new Set<
    (event: HostClientChangeEvent) => void
  >();
  private readonly bearerRotationHandlers = new Set<() => void>();

  constructor(options: HostClientOptions<Registry>) {
    this.registry = options.registry;
    this.messenger = options.messenger;
    this.invalidator = options.invalidator;
    this.schedulingPolicy =
      options.schedulingPolicy ?? createLatestSchedulingPolicy<Registry>();
    this.ownsRequestCoordinator =
      options.requestCoordinator === null ||
      options.requestCoordinator === undefined;
    this.requestCoordinator =
      options.requestCoordinator ??
      new HostRequestCoordinator({
        registry: options.registry,
        schedulingPolicy: this.schedulingPolicy,
      });
    this.authorityRegistry =
      options.authorityRegistry ?? new HostBindingAuthorityRegistry();
    // No fallback to a bound host: there is none. A client built without a
    // directory lookup resolves nothing, which is the honest answer now that
    // nothing is implicitly a host - and it is what makes an unrouted request
    // fail loudly at the preflight instead of landing on whatever was bound.
    this.findHostById = options.findHostById ?? (() => null);
  }

  /** Returns the registry this client was constructed with (for type callers). */
  getRegistry(): Registry {
    return this.registry;
  }

  /**
   * ∅ — this client addresses no host, and both accessors say so.
   *
   * They are not vestigial. Every requester is a Proxy over THIS object
   * (see {@link createPinnedRequester}) and intercepts these two, so the
   * members must exist for `HostClient` to be the type a requester is handed
   * out as. What is gone is the field they used to read: the spine owns the
   * messenger, the coordinator, the authority registry and the request
   * context, and none of those is a host. Asking the spine which host it is
   * on is the question redesign D17 removed, and ∅ is the answer.
   */
  getActiveHost(): HostDirectoryEntry | null {
    return null;
  }

  getActiveHostId(): string | null {
    return null;
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

  getAuthorityRegistry(): HostBindingAuthorityRegistry {
    return this.authorityRegistry;
  }

  resolveHostById(hostId: string): HostDirectoryEntry | null {
    return this.findHostById(hostId);
  }

  createRequester(entry: HostDirectoryEntry): HostClient<Registry> {
    // Pins the host IDENTITY, not the transport snapshot. A host's directory
    // entry refreshes in place (status, version, endpoint) and
    // `captureAuthority` refuses a routed entry that no longer matches the
    // live directory - so a requester frozen on its creation-time entry would
    // fail every request after such a refresh until rebuilt, while a dialog
    // holding it stays open. Each property access resolves the current entry;
    // the creation-time one only serves once the host leaves the directory,
    // where capture rejects it as stale either way.
    //
    // The id stays FROZEN even then: a surface pinned to this host must keep
    // announcing which host it addresses while the row is missing, or a
    // placement re-validation reads `null` and mistakes a momentarily absent
    // row for "the caller moved".
    return this.createPinnedRequester(
      () => this.findHostById(entry.hostId) ?? entry,
      () => entry.hostId,
    );
  }

  /**
   * THE uniform `hostId -> client` resolution (redesign D17). Identical
   * machinery to {@link createRequester} - one pinned requester, one live
   * entry lookup per access - reached by ID rather than by a captured row, so
   * a window-global consumer resolves the selection layer's `effectiveHostId`
   * through exactly the path a pinned consumer resolves its own host through.
   * Nothing here reads the active slot, which is what lets P4.2 delete the
   * slot without a second resolution path having to be built first.
   *
   * `null` is ∅ - "no host is effective" - not "follow whatever is bound".
   * The id-pinned requester also reports `getActiveHostId() === null` while
   * the named row is UNRESOLVED, and its requests reject with the same
   * preflight error an unbound client has always produced. That is deliberate
   * rather than incidental: `HostDirectoryService.selectById` binds `null` for
   * an id it cannot resolve, so this reproduces the answer the active slot
   * gave, and a consumer gating on "is a host addressable yet" keeps gating on
   * the same value. A pinned requester freezes its id instead, because it was
   * handed a row that existed; this one was handed an intent that may not have
   * landed.
   *
   * Unresolved is not a dead end, and how it un-sticks is SETTLED (P4.1).
   * The requester re-reads the row on every access, so one that ARRIVES late
   * is picked up with nothing to re-resolve - but a React consumer still has
   * to be told to look again. That signal used to be `bind()`'s change event,
   * which is the active slot; it is now
   * `host-connection-registry.ts`'s `subscribeHostRowChanged` (per host) /
   * `subscribeAnyHostRowChanged` (for consumers that resolve their own id at
   * read time, which is every reactive projection over a pinned requester -
   * they cannot name the host at subscribe time, because the row not existing
   * yet is the thing they are waiting on).
   *
   * P4.2 DID THIS, and it was a deletion rather than a migration. The three
   * reactive projections (`useReactiveHostReadiness`,
   * `useReactiveOwnerIdentityKey`, and `stream-runtime.tsx`'s
   * `useReactiveHostTransportKey`) each subscribed to BOTH arms; the
   * `client.onChange` arm came out of all three and the registry arm already
   * carried them. It was proved rather than asserted: neutering `bind()`'s two
   * `emitChange` calls and re-running the row-arrival regression CAUGHT before
   * P4.1 and SURVIVED after, which is what made the arm removable.
   */
  createRequesterForHostId(hostId: string | null): HostClient<Registry> {
    const resolveEntry = (): HostDirectoryEntry | null =>
      hostId === null ? null : this.findHostById(hostId);
    return this.createPinnedRequester(resolveEntry, () =>
      resolveEntry() === null ? null : hostId,
    );
  }

  /**
   * The one requester mechanism both entry points above are built from.
   *
   * Every request-shaped member is re-pointed at its `...For` sibling with the
   * resolved entry supplied explicitly; everything else binds to this client,
   * which owns the messenger, the coordinator, the authority registry and the
   * request context. A requester is therefore a ROUTING view over one client,
   * never a second client - and the entry is resolved at property-access time
   * so an activation that lands mid-chain cannot silently redirect a call the
   * caller already aimed.
   */
  private createPinnedRequester(
    resolveEntry: () => HostDirectoryEntry | null,
    readActiveHostId: () => string | null,
  ): HostClient<Registry> {
    return new Proxy(this, {
      get: (target, property, receiver) => {
        if (property === "getActiveHost") {
          return () => resolveEntry();
        }
        if (property === "getActiveHostId") {
          return readActiveHostId;
        }
        if (property === "request") {
          // A closure rather than a `bind` only because the trailing `signal`
          // cannot be pre-bound; the entry is still captured HERE, at property
          // access, so all four request members resolve at the same instant.
          const entry = resolveEntry();
          return <Method extends keyof Registry & string>(
            method: Method,
            params: RequestOfMethod<Registry, Method>,
          ) => target.requestForWithSignal(entry, method, params, undefined);
        }
        if (property === "requestWithSignal") {
          return target.requestForWithSignal.bind(target, resolveEntry());
        }
        if (property === "requestWithResponseTimeout") {
          return target.requestForWithResponseTimeout.bind(
            target,
            resolveEntry(),
          );
        }
        if (property === "cancelActiveRead") {
          return target.cancelActiveReadFor.bind(target, resolveEntry());
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /**
   * Reports that an endpoint recovered availability, for a NAMED host.
   *
   * The announcing form: it invalidates that host's scope so active observers
   * refetch, and emits the `"availability-recovered"` change event.
   *
   * There used to be a no-argument sibling that read the active slot to
   * decide whose queries to un-strand, and this method delegated to it when
   * the named host happened to be the bound one. Both are gone with the slot
   * (redesign P4.2). That is not a simplification for its own sake: the
   * no-arg form would have become a permanent no-op the moment nothing was
   * bound, and its one production caller - the app-wide stream's recovery
   * wiring - would have stopped un-stranding queries entirely, silently, with
   * nothing failing anywhere. Naming the host is what makes the recovery
   * expressible at all now.
   *
   * Delivery is coalesced per host per microtask tick (see
   * {@link deliverHostScopeSweep}): one shared remote session's ready
   * boundary fans out to every consumer wiring, each of which reports it here
   * in the same tick with its own cooldown state.
   */
  notifyHostAvailabilityRecovered(hostId: string): void {
    this.deliverHostScopeSweep(hostId, true);
  }

  /**
   * Sweeps one host's query scope WITHOUT announcing it - the same host-scope
   * invalidation {@link notifyHostAvailabilityRecovered} performs, with no
   * `"availability-recovered"` change event behind it.
   *
   * TWO callers, and neither is reporting an availability recovery. The name
   * says what the method does rather than why any one caller wants it, which
   * is what lets both of them share it honestly:
   *
   *  1. A remote binding that owes a ready boundary for a host whose first
   *     dial was still in flight. Routing that through the announcing form
   *     would emit `"availability-recovered"`, and the runtime answers a
   *     change by resetting the very binding delivering the news. Dropping it
   *     instead is not an option either - `subscribeAvailabilityRecovered`
   *     reports a RECOVERY, not current state, so a stream runtime attaching
   *     afterwards to an already-ready session gets no replay and the queries
   *     stranded by that dial never refetch.
   *  2. A same-host public-key ROTATION (R-1): the host was rebuilt under its
   *     own id, so everything cached for it describes a machine that is gone.
   *     Nothing recovered availability there - the rotation rebuilds transport
   *     on its own - and a reason-scoped consumer woken by an
   *     `"availability-recovered"` it can only read as true would be acting on
   *     an event that did not happen.
   *
   * This used to be `invalidateHostScopeForAvailability`, documented as
   * existing for one caller. It has two, and a name naming one of their
   * reasons would have to be replaced by the next one.
   */
  invalidateHostScopeUnannounced(hostId: string): void {
    this.deliverHostScopeSweep(hostId, false);
  }

  /**
   * The choke point every host-scope sweep funnels through, so one physical
   * trigger reaching N wirings costs ONE host-scope invalidation and at most
   * one change event. Reports for the same host in the same microtask tick
   * merge; a merged report emits the change event if ANY of its callers asked
   * for one (the availability report does, the unannounced sweep deliberately
   * does not). A rotation sweep landing in the same tick as a genuine
   * availability recovery therefore still announces, and that is correct: the
   * availability caller asked, and its announcement is true.
   */
  private readonly pendingHostScopeSweeps = new Map<
    string,
    { emitChangeEvent: boolean }
  >();

  private deliverHostScopeSweep(
    hostId: string,
    emitChangeEvent: boolean,
  ): void {
    const pending = this.pendingHostScopeSweeps.get(hostId);
    if (pending !== undefined) {
      if (emitChangeEvent) {
        pending.emitChangeEvent = true;
      }
      return;
    }
    const entry = { emitChangeEvent };
    this.pendingHostScopeSweeps.set(hostId, entry);
    queueMicrotask(() => {
      this.pendingHostScopeSweeps.delete(hostId);
      this.invalidator.invalidateHostScope(hostId, {
        refetchActive: true,
      });
      // No active-host gate: there is no active host. The event carries the
      // host it is about, and consumers that care which one filter on
      // `currentHostId` - which is what the gate was standing in for while a
      // privileged binding existed.
      if (entry.emitChangeEvent) {
        this.emitChange({
          previousHostId: hostId,
          currentHostId: hostId,
          reason: "availability-recovered",
        });
      }
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
    // SCOPE-FREE, and that is the truthful statement rather than a widening.
    // An identity transition invalidates work on every host this client
    // serves, not on a privileged one: the context is shared by every
    // requester handed out, so a request issued under the outgoing credential
    // is stale wherever it was aimed. This used to name the bound host
    // because a bound host existed; with the slot gone there is no host to
    // name, and `null` is what both ports already document as "all
    // host-scoped".
    this.invalidator.invalidateHostScope(null, { refetchActive: false });
    this.cancelThenAbortAll();
    this.emitChange({
      previousHostId: null,
      currentHostId: null,
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
  async request<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    return this.requestWithSignal(method, params, undefined);
  }

  async requestWithSignal<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    signal: AbortSignal | undefined,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    // ∅: the spine addresses no host, so an unrouted request rejects at the
    // preflight. Callers reach a host through a requester.
    return this.requestForWithSignal(null, method, params, signal);
  }

  /**
   * Releases a cancelled TanStack Query's active latest/join raw call. This
   * is for bespoke query functions that predate `requestWithSignal`; normal
   * query builders propagate their cancellation signal directly.
   */
  cancelActiveRead<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ): void {
    // ∅ — see `request`. A cancel with no host named releases nothing.
    this.cancelActiveReadFor(null, method, params);
  }

  /**
   * {@link cancelActiveRead} for an explicitly named host, so a requester
   * cancels the read IT issued rather than one on whatever the slot happens
   * to hold. The coordinator's cancellation key is `(hostId, userId, method,
   * params)`, so routing this through the slot would let a pinned surface's
   * cancel land on another host's identical read - or, once its own host
   * stopped being effective, on nothing at all.
   */
  cancelActiveReadFor<Method extends keyof Registry & string>(
    entry: HostDirectoryEntry | null,
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ): void {
    if (entry === null || this.requestContext === null) {
      return;
    }
    this.requestCoordinator.cancelActiveRead(
      entry.hostId,
      this.requestContext.identity.userId,
      method,
      params,
    );
  }

  /**
   * `request` with an extended response-frame budget for long-poll methods
   * whose contract is to stay silent until a domain event fires (see
   * `IHostMessenger.requestWithResponseTimeout`). Dial and handshake keep
   * the transport defaults so an unreachable host still fails fast.
   */
  async requestWithResponseTimeout<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    responseTimeoutMs: number,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    const expectedTimeout = this.schedulingPolicyTimeout(method);
    if (expectedTimeout === null || expectedTimeout !== responseTimeoutMs) {
      return Promise.reject(
        new Error(
          `Host method '${method}' does not permit response timeout ${responseTimeoutMs}`,
        ),
      );
    }
    return this.requestForWithResponseTimeout(
      // ∅ — see `request`.
      null,
      method,
      params,
      responseTimeoutMs,
    );
  }

  requestFor<Method extends keyof Registry & string>(
    entry: HostDirectoryEntry,
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    return this.requestForWithSignal(entry, method, params, undefined);
  }

  requestForWithSignal<Method extends keyof Registry & string>(
    entry: HostDirectoryEntry | null,
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    signal: AbortSignal | undefined,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    return this.scheduleRequest(entry, method, params, signal, (authority) =>
      this.messenger.request(method, params, authority),
    );
  }

  requestForWithResponseTimeout<Method extends keyof Registry & string>(
    entry: HostDirectoryEntry | null,
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    responseTimeoutMs: number,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    const expectedTimeout = this.schedulingPolicyTimeout(method);
    if (expectedTimeout === null || expectedTimeout !== responseTimeoutMs) {
      return Promise.reject(
        new Error(
          `Host method '${method}' does not permit response timeout ${responseTimeoutMs}`,
        ),
      );
    }
    return this.scheduleRequest(entry, method, params, undefined, (authority) =>
      this.messenger.requestWithResponseTimeout(
        method,
        params,
        responseTimeoutMs,
        authority,
      ),
    );
  }

  private scheduleRequest<Method extends keyof Registry & string>(
    entry: HostDirectoryEntry | null,
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    signal: AbortSignal | undefined,
    execute: (
      authority: HostRequestAuthority,
    ) => Promise<ResponseOfMethod<Registry, Method>>,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    try {
      const preflightError = this.readRequestPreflightError(method, entry);
      if (preflightError !== null) {
        return Promise.reject(preflightError);
      }
      if (entry === null || this.requestContext === null) {
        return Promise.reject(new StaleHostBindingAuthorityError("unbound"));
      }
      const captured = this.captureAuthority(entry, this.requestContext);
      return this.requestCoordinator.request({
        hostId: entry.hostId,
        userId: this.requestContext.identity.userId,
        method,
        params,
        authority: captured.authority,
        authorityDomain: captured.authorityDomain,
        signal,
        execute,
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  dispose(): void {
    if (this.ownsRequestCoordinator) {
      this.requestCoordinator.dispose();
    }
  }

  private captureAuthority(
    entry: HostDirectoryEntry,
    context: RequestContext,
  ): {
    readonly authority: HostRequestAuthority;
    readonly authorityDomain: HostRequestAuthorityDomain;
  } {
    const binding = this.authorityRegistry.capture(
      entry,
      this.findHostById(entry.hostId),
    );
    return {
      authority: {
        endpoint: binding.endpoint,
        bearer: context.credentials,
        abortSignal: AbortSignal.any([
          binding.abortSignal,
          context.abortSignal,
        ]),
      },
      authorityDomain: {
        bindingToken: binding.token,
        requestContext: context,
      },
    };
  }

  private schedulingPolicyTimeout<Method extends keyof Registry & string>(
    method: Method,
  ): number | null {
    return this.schedulingPolicy.joinResponseTimeoutMs(method);
  }

  /**
   * Cancels every host-scoped observer, then aborts the read jobs that
   * existed when the identity transition began.
   *
   * The ORDER is the contract and predates this change: Query observers must
   * consume cancellation before the coordinator aborts their jobs, or a
   * cancelled read settles as a failure the caller sees. What changed is the
   * SCOPE — this was `cancelThenAbortHost(hostId)`, reachable only through
   * the active slot, and the slot's deletion (redesign D17 / P4.2) leaves no
   * host to name. Nothing is lost by widening: the one surviving caller is
   * the identity transition, and a credential change invalidates work on
   * every host at once. The snapshot is still taken BEFORE the cancel so
   * work submitted while cancellation is in flight is spared.
   */
  private cancelThenAbortAll(): void {
    const transition = this.requestCoordinator.snapshotAllTransitions();
    const finishTransition = (): void => {
      this.requestCoordinator.abortHostTransition(transition);
    };
    const cancel = this.invalidator.cancelHostScope;
    if (cancel === undefined) {
      finishTransition();
      return;
    }
    void cancel(null).finally(() => {
      finishTransition();
    });
  }

  private readRequestPreflightError(
    method: string,
    entry: HostDirectoryEntry | null,
  ): HostRpcError | null {
    if (entry === null) {
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

function createLatestSchedulingPolicy<
  Registry extends VersionedRpcRegistry,
>(): RpcSchedulingPolicy<Registry> {
  return {
    modeFor: () => "latest",
    joinResponseTimeoutMs: () => null,
  };
}

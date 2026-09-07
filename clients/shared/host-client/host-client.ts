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
import { StaleHostBindingAuthorityError } from "./host-binding-authority-error";
import { HostBindingAuthorityRegistry } from "./host-binding-authority-registry";
import {
  HostRequestCoordinator,
  type HostRequestAuthorityDomain,
} from "./host-request-coordinator";
import type { RpcSchedulingPolicy } from "./rpc-scheduling-policy";

/**
 * Narrow port the client calls to invalidate host-scoped query state.
 * Passing `null` means "no host selected" - consumers typically drop any host-scoped entries entirely.
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

export const HOST_AVAILABILITY_SWEEP_WINDOW_MS = 10_000;

export type HostClientUnsubscribe = () => void;

export interface HostClientChangeEvent {
  readonly previousHostId: string | null;
  readonly currentHostId: string | null;
  readonly reason: HostClientChangeReason;
}

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

export interface HostRequester<Registry extends VersionedRpcRegistry> {
  getRegistry(): Registry;
  getActiveHost(): HostDirectoryEntry | null;
  getActiveHostId(): string | null;
  getRequestContext(): RequestContext | null;
  getRequestContextUserId(): string | null;
  onChange(
    handler: (event: HostClientChangeEvent) => void,
  ): HostClientUnsubscribe;
  /**
   * Sends without an idempotency key.
   * A command that needs retry safety must use {@link requestWithIdempotencyKey}; this path deliberately supplies `null` to the same implementation.
   */
  request<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ): Promise<ResponseOfMethod<Registry, Method>>;
  /**
   * Selects the transport-key path explicitly.
   * Only the command queue may opt into a non-null key.
   */
  requestWithIdempotencyKey<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    idempotencyKey: string | null,
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
    // No fallback to a bound host: there is none.
    this.findHostById = options.findHostById ?? (() => null);
  }

  /** Returns the registry this client was constructed with (for type callers). */
  getRegistry(): Registry {
    return this.registry;
  }

  /**
   * ∅ - this client addresses no host, and both accessors say so.
   * Every requester is a Proxy over this object (see {@link createPinnedRequester}) and intercepts these two, so the members must exist for `HostClient` to be the type a requester is handed out as.
   */
  getActiveHost(): HostDirectoryEntry | null {
    return null;
  }

  getActiveHostId(): string | null {
    return null;
  }

  /** Returns the active `RequestContext`, or `null` when signed out / not yet authenticated. */
  getRequestContext(): RequestContext | null {
    return this.requestContext;
  }

  /**
   * Returns the active request-context identity only when the context still owns a usable credential lease.
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
    // Pins the host identity, not the transport snapshot.
    // Each property access resolves the current entry; the creation-time one only serves once the host leaves the directory, where capture rejects it as stale either way.
    return this.createPinnedRequester(
      () => this.findHostById(entry.hostId) ?? entry,
      () => entry.hostId,
    );
  }

  /**
   * The uniform `hostId -> client` resolution (redesign D17).
   * Nothing here reads the active slot, which is what lets P4.2 delete the slot without a second resolution path having to be built first.
   */
  createRequesterForHostId(hostId: string | null): HostClient<Registry> {
    const resolveEntry = (): HostDirectoryEntry | null =>
      hostId === null ? null : this.findHostById(hostId);
    return this.createPinnedRequester(resolveEntry, () =>
      resolveEntry() === null ? null : hostId,
    );
  }

  /** The one requester mechanism both entry points above are built from. */
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
        // The entry is captured here, at property access, so all four
          // request members resolve at the same instant.
          const entry = resolveEntry();
          return <Method extends keyof Registry & string>(
            method: Method,
            params: RequestOfMethod<Registry, Method>,
          ) => target.requestForWithIdempotencyKey(entry, method, params, null);
        }
        if (property === "requestWithIdempotencyKey") {
          const entry = resolveEntry();
          return <Method extends keyof Registry & string>(
            method: Method,
            params: RequestOfMethod<Registry, Method>,
            idempotencyKey: string | null,
          ) =>
            target.requestForWithIdempotencyKey(
              entry,
              method,
              params,
              idempotencyKey,
            );
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
   * Reports that an endpoint recovered availability, for a named host.
   * There used to be a no-argument sibling that read the active slot to decide whose queries to un-strand, and this method delegated to it when the named host happened to be the bound one.
   */
  notifyHostAvailabilityRecovered(hostId: string): void {
    const gate = this.hostAvailabilitySweepGates.get(hostId);
    if (gate !== undefined) {
      if (!gate.leadingPending) gate.trailing = true;
      return;
    }
    const opened = { leadingPending: true, trailing: false };
    this.hostAvailabilitySweepGates.set(hostId, opened);
    this.deliverHostScopeSweep(hostId, true);
    queueMicrotask(() => {
      if (this.hostAvailabilitySweepGates.get(hostId) === opened) {
        opened.leadingPending = false;
      }
    });
    this.armHostAvailabilitySweepGate(hostId, opened);
  }

  /**
   * Sweeps one host's query scope without announcing it - the same host-scope invalidation {@link notifyHostAvailabilityRecovered} performs, with no `"availability-recovered"` change event behind it.
   * The name says what the method does rather than why any one caller wants it, which is what lets both of them share it honestly: 1.
   */
  invalidateHostScopeUnannounced(hostId: string): void {
    this.deliverHostScopeSweep(hostId, false);
  }

  private readonly hostAvailabilitySweepGates = new Map<
    string,
    { leadingPending: boolean; trailing: boolean }
  >();

  private armHostAvailabilitySweepGate(
    hostId: string,
    gate: { leadingPending: boolean; trailing: boolean },
  ): void {
    setTimeout(() => {
      if (this.hostAvailabilitySweepGates.get(hostId) !== gate) return;
      if (!gate.trailing) {
        this.hostAvailabilitySweepGates.delete(hostId);
        return;
      }
      gate.trailing = false;
      gate.leadingPending = true;
      this.deliverHostScopeSweep(hostId, true);
      queueMicrotask(() => {
        if (this.hostAvailabilitySweepGates.get(hostId) === gate) {
          gate.leadingPending = false;
        }
      });
      this.armHostAvailabilitySweepGate(hostId, gate);
    }, HOST_AVAILABILITY_SWEEP_WINDOW_MS);
  }

  /**
   * The choke point every host-scope sweep funnels through, so one physical trigger reaching N wirings costs one host-scope invalidation and at most one change event.
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
      // No active-host gate: there is no active host.
      // The event carries the host it is about, and consumers that care which one filter on `currentHostId` - which is what the gate was standing in for while a privileged binding existed.
      if (entry.emitChangeEvent) {
        this.emitChange({
          previousHostId: hostId,
          currentHostId: hostId,
          reason: "availability-recovered",
        });
      }
    });
  }

  /** Updates the `RequestContext` the messenger threads onto outgoing requests. */
  setRequestContext(ctx: RequestContext | null): void {
    if (this.requestContext === ctx) {
      return;
    }
    this.requestContext = ctx;
    // Scope-free, and that is the truthful statement rather than a widening.
    // This used to name the bound host because a bound host existed; with the slot gone there is no host to name, and `null` is what both ports already document as "all host-scoped".
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
   * Subscribes to in-place bearer rotations (same-user token refresh).
   * Distinct from `onChange`, which only fires on identity transitions; rotation keeps the same context reference.
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

  /** Delegates to the messenger. */
  async request<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    return this.requestWithIdempotencyKey(method, params, null);
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

  async requestWithIdempotencyKey<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    idempotencyKey: string | null,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    return this.requestForWithIdempotencyKey(
      null,
      method,
      params,
      idempotencyKey,
    );
  }

  /** Releases a cancelled TanStack Query's active latest/join raw call. */
  cancelActiveRead<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ): void {
  // ∅ - see `request`. A cancel with no host named releases nothing.
    this.cancelActiveReadFor(null, method, params);
  }

  /**
   * {@link cancelActiveRead} for an explicitly named host, so a requester cancels the read IT issued rather than one on whatever the slot happens to hold.
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
   * `request` with an extended response-frame budget for long-poll methods whose contract is to stay silent until a domain event fires (see `IHostMessenger.requestWithResponseTimeout`).
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
    // ∅ - see `request`.
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
    return this.requestForWithIdempotencyKey(entry, method, params, null);
  }

  requestForWithSignal<Method extends keyof Registry & string>(
    entry: HostDirectoryEntry | null,
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    signal: AbortSignal | undefined,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    return this.scheduleRequest(entry, method, params, signal, (authority) =>
      this.messenger.request(method, params, {
        idempotencyKey: null,
        authority,
        // Every dispatch this client originates is a caller's first attempt.
        // The replay requirement is raised one layer down, by `createRetryingMessenger`, and only for the attempts that follow a failure whose retryability a negotiated key earned.
        replayMustBeKeyed: false,
      }),
    );
  }

  requestForWithIdempotencyKey<Method extends keyof Registry & string>(
    entry: HostDirectoryEntry | null,
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    idempotencyKey: string | null,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    return this.scheduleRequest(entry, method, params, undefined, (authority) =>
      this.messenger.request(method, params, {
        idempotencyKey,
        authority,
        // A key the caller supplied, which is not the same as a replay that
        // requires one - see the sibling above.
        replayMustBeKeyed: false,
      }),
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
        {
          idempotencyKey: null,
          authority,
          replayMustBeKeyed: false,
        },
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
   * Cancels every host-scoped observer, then aborts the read jobs that existed when the identity transition began.
   * The order is the contract and predates this change: Query observers must consume cancellation before the coordinator aborts their jobs, or a cancelled read settles as a failure the caller sees.
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

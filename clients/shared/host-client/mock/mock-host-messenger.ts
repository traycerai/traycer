import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import {
  HostRpcError,
  HostRequestAbortedError,
  type HostRequestAuthority,
  type IHostMessenger,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "../../host-transport/host-messenger";

/**
 * Resolver for a single method in the mock host runtime.
 *
 * Handlers receive the canonical request params and return the canonical
 * response body. Throwing inside a handler surfaces as a `HostRpcError`
 * with code `RPC_ERROR`, matching what a real host dispatcher would emit.
 */
export type MockMethodHandler<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
> = (
  params: RequestOfMethod<Registry, Method>,
) =>
  | Promise<ResponseOfMethod<Registry, Method>>
  | ResponseOfMethod<Registry, Method>;

export type MockHandlerMap<Registry extends VersionedRpcRegistry> = {
  readonly [Method in keyof Registry & string]?: MockMethodHandler<
    Registry,
    Method
  >;
};

/**
 * Discriminated trace event mirroring the per-request WebSocket lifecycle so
 * tests and dev tooling can assert that the simulated messenger walks the same
 * `open → auth → manifest → request → response → close` phases as the real
 * `WsRpcClient`.
 *
 * Every event carries `method` and `requestId` so multi-call traces remain
 * attributable. `request` carries the canonical params; `response` carries
 * either the canonical result or the surfaced `HostRpcError` so callers can
 * inspect both happy and error paths without subscribing to handler internals.
 */
export type MockPhaseEvent =
  | {
      readonly kind: "open";
      readonly method: string;
      readonly requestId: string;
    }
  | {
      readonly kind: "auth";
      readonly method: string;
      readonly requestId: string;
    }
  | {
      readonly kind: "manifest";
      readonly method: string;
      readonly requestId: string;
    }
  | {
      readonly kind: "request";
      readonly method: string;
      readonly requestId: string;
      readonly params: unknown;
    }
  | {
      readonly kind: "response";
      readonly method: string;
      readonly requestId: string;
      readonly result: unknown;
      readonly error: HostRpcError | null;
    }
  | {
      readonly kind: "close";
      readonly method: string;
      readonly requestId: string;
    };

export type MockPhaseListener = (event: MockPhaseEvent) => void;

export type MockPhaseUnsubscribe = () => void;

export interface MockHostMessengerOptions<
  Registry extends VersionedRpcRegistry,
> {
  readonly registry: Registry;
  readonly handlers: MockHandlerMap<Registry>;
  readonly requestId: () => string;
}

/**
 * In-memory `IHostMessenger` used by dev, preview, and shared tests.
 *
 * Keeps the same typed surface as `WsRpcClient` so `gui-app` can bind to
 * either without branching in UI code. The mock only implements the unary
 * request path - streaming/push is deferred at the interface level.
 *
 * The `phases` log and `subscribe()` listener mirror the lifecycle of the
 * real WebSocket client so observability assertions work identically across
 * mock and prod transports.
 */
export class MockHostMessenger<
  Registry extends VersionedRpcRegistry,
> implements IHostMessenger<Registry> {
  private handlers: MockHandlerMap<Registry>;
  private readonly requestIdProvider: () => string;
  private readonly listeners: Set<MockPhaseListener> = new Set();
  readonly calls: Array<{
    readonly method: string;
    readonly params: unknown;
    readonly requestId: string;
    readonly authority: HostRequestAuthority;
  }> = [];
  readonly phases: MockPhaseEvent[] = [];

  constructor(options: MockHostMessengerOptions<Registry>) {
    this.handlers = options.handlers;
    this.requestIdProvider = options.requestId;
  }

  setHandlers(handlers: MockHandlerMap<Registry>): void {
    this.handlers = handlers;
  }

  /**
   * Subscribes to lifecycle phase events. Returns an unsubscribe function so
   * callers (typically tests) can scope a listener to a single block without
   * leaking subscriptions across cases.
   */
  subscribe(listener: MockPhaseListener): MockPhaseUnsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  requestWithResponseTimeout<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    responseTimeoutMs: number,
    authority: HostRequestAuthority,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    // The mock runs handlers inline with no transport timers, so the extended
    // response budget has nothing to bound - the call delegates unchanged.
    void responseTimeoutMs;
    return this.request(method, params, authority);
  }

  async request<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    authority: HostRequestAuthority,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    const requestId = this.requestIdProvider();
    this.calls.push({ method, params, requestId, authority });

    this.emit({ kind: "open", method, requestId });
    this.emit({ kind: "auth", method, requestId });
    this.emit({ kind: "manifest", method, requestId });
    this.emit({ kind: "request", method, requestId, params });

    const handler = this.handlers[method];
    if (handler === undefined) {
      const error = new HostRpcError({
        code: "RPC_ERROR",
        message: `No mock handler registered for method '${method}'`,
        requestId,
        method,
        fatalDetails: null,
      });
      this.emit({
        kind: "response",
        method,
        requestId,
        result: null,
        error,
      });
      this.emit({ kind: "close", method, requestId });
      throw error;
    }

    let result: ResponseOfMethod<Registry, Method>;
    let detachAbortListener = (): void => undefined;
    try {
      result = await awaitAbortableHandler(
        handler(params),
        authority,
        requestId,
        method,
        (detach) => {
          detachAbortListener = detach;
        },
      );
    } catch (cause) {
      if (cause instanceof HostRequestAbortedError) {
        this.emit({
          kind: "response",
          method,
          requestId,
          result: null,
          error: cause,
        });
        this.emit({ kind: "close", method, requestId });
        throw cause;
      }
      if (cause instanceof HostRpcError) {
        const error = new HostRpcError({
          code: cause.code,
          message: cause.message,
          requestId,
          method,
          fatalDetails: cause.fatalDetails,
        });
        this.emit({
          kind: "response",
          method,
          requestId,
          result: null,
          error,
        });
        this.emit({ kind: "close", method, requestId });
        throw error;
      }
      const error = new HostRpcError({
        code: "RPC_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
        requestId,
        method,
        fatalDetails: null,
      });
      this.emit({
        kind: "response",
        method,
        requestId,
        result: null,
        error,
      });
      this.emit({ kind: "close", method, requestId });
      throw error;
    } finally {
      detachAbortListener();
    }

    this.emit({
      kind: "response",
      method,
      requestId,
      result,
      error: null,
    });
    this.emit({ kind: "close", method, requestId });
    return result;
  }

  private emit(event: MockPhaseEvent): void {
    this.phases.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function awaitAbortableHandler<Response>(
  handlerResult: Promise<Response> | Response,
  authority: HostRequestAuthority,
  requestId: string,
  method: string,
  setDetachAbortListener: (detach: () => void) => void,
): Promise<Response> {
  const abortError = (): HostRequestAbortedError =>
    new HostRequestAbortedError({
      message: "Mock host request authority was aborted",
      requestId,
      method,
    });
  if (authority.abortSignal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<Response>((resolve, reject) => {
    const abort = (): void => reject(abortError());
    authority.abortSignal.addEventListener("abort", abort, { once: true });
    setDetachAbortListener(() => {
      authority.abortSignal.removeEventListener("abort", abort);
    });
    Promise.resolve(handlerResult).then(resolve, reject);
  });
}

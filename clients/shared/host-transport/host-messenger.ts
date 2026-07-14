import type {
  LatestContract,
  MethodVersionRegistry,
  RequestOf,
  ResponseOf,
  RpcErrorCode,
  RpcErrorDetails,
  VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";

/**
 * App-facing host messenger abstraction.
 *
 * `IHostMessenger` sits above the committed versioned RPC envelope. Callers
 * name a method and pass canonical params for that method; the messenger owns
 * envelope construction (`requestId`, `method`, `schemaVersion`, `params`) and
 * response decoding on the wire.
 *
 * This is the unary surface required by the current slice. Streaming / push
 * (`streamRequest`, server push, unsolicited event delivery) remain reserved
 * extension points and are intentionally not part of this interface yet.
 */
export interface IHostMessenger<Registry extends VersionedRpcRegistry> {
  /**
   * Sends a single unary RPC request and resolves with the method's canonical
   * response body. Rejects with `HostRpcError` when the host returns an
   * error envelope or when transport-level validation fails.
   */
  request<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ): Promise<ResponseOfMethod<Registry, Method>>;

  /**
   * Same as `request`, but waits up to `responseTimeoutMs` for the host's
   * response frame instead of the transport's default frame timeout. For
   * long-poll methods whose contract is to stay silent until a domain event
   * fires (e.g. `providers.awaitLogin` blocks until the OAuth child
   * terminates), the default frame timeout would misread that silence as a
   * dead host and abandon a healthy in-flight call. Only the response wait
   * is extended - dial and handshake (`openAck`) keep the transport's
   * defaults, so a host that is actually unreachable still fails fast.
   */
  requestWithResponseTimeout<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    responseTimeoutMs: number,
  ): Promise<ResponseOfMethod<Registry, Method>>;
}

/**
 * Canonical request payload for a method on a validated host registry.
 *
 * `LatestContract<Registry[Method]>` tracks the highest installed major and
 * minor for that method - the same canonical contract the host's resolver
 * is written against - so clients and the dispatcher agree on shape.
 */
export type RequestOfMethod<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
> = Registry[Method] extends MethodVersionRegistry
  ? RequestOf<LatestContract<Registry[Method]>>
  : never;

/** Canonical response payload for a method on a validated host registry. */
export type ResponseOfMethod<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
> = Registry[Method] extends MethodVersionRegistry
  ? ResponseOf<LatestContract<Registry[Method]>>
  : never;

/**
 * Typed error thrown by `IHostMessenger.request` when the host returns an
 * error envelope or when envelope decoding fails. Preserves the correlating
 * `requestId` and method name so callers can attribute failures.
 */
export class HostRpcError extends Error {
  readonly code: RpcErrorCode;
  readonly requestId: string;
  readonly method: string;
  /**
   * Buffered `fatalError` payload preserved verbatim from the host's
   * pre-close frame (or from the client-side mirror compatibility check).
   * `null` when the failure did not arrive via a fatal-error frame.
   */
  readonly fatalDetails: FatalErrorDetails | null;

  constructor(details: {
    code: RpcErrorCode;
    message: string;
    requestId: string;
    method: string;
    fatalDetails: FatalErrorDetails | null;
  }) {
    super(details.message);
    this.name = "HostRpcError";
    this.code = details.code;
    this.requestId = details.requestId;
    this.method = details.method;
    this.fatalDetails = details.fatalDetails;
  }

  static fromErrorDetails(
    error: RpcErrorDetails,
    requestId: string,
    method: string,
  ): HostRpcError {
    return new HostRpcError({
      code: error.code,
      message: error.message,
      requestId,
      method,
      fatalDetails: null,
    });
  }
}

/**
 * A `HostRpcError` raised by a transient transport failure that occurred
 * *before* the request frame was put on the wire - a dial timeout, an
 * `onerror`/`onclose` during the dial-or-handshake phase, or a handshake
 * (`openAck`) frame timeout.
 *
 * The "before the request was sent" guarantee is what makes it safe to retry
 * even non-idempotent methods: the host never observed the call, so a fresh
 * dial cannot double-apply a side effect. `createRetryingMessenger` keys its
 * bounded retry off this subclass; every other failure (a post-send drop, a
 * malformed frame, or any host-originated error) stays a plain `HostRpcError`
 * and propagates on the first attempt.
 *
 * It is a `HostRpcError` (`code` stays `"RPC_ERROR"`) so existing
 * `instanceof HostRpcError` / `code`-based handling - the auth-aware wrapper,
 * error toasts - keeps treating it exactly as it did before.
 */
export class RetryableTransportError extends HostRpcError {
  constructor(details: {
    code: RpcErrorCode;
    message: string;
    requestId: string;
    method: string;
    fatalDetails: FatalErrorDetails | null;
  }) {
    super(details);
    this.name = "RetryableTransportError";
  }
}

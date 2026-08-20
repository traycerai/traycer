import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import {
  HostRpcError,
  HostTransportFailureError,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer/protocol/host-transport/remote/rpc-types";
import type { OpenFrameBearerSource } from "../auth/bearer-source";

export {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer/protocol/host-transport/remote/rpc-types";

/**
 * Immutable transport coordinates captured for one host-RPC job. The
 * transport owns no live endpoint or bearer providers: callers capture an
 * authority before dispatch, then every retry reuses this exact object.
 */
export interface HostTransportEndpoint {
  readonly hostId: string;
  readonly websocketUrl: string | null;
}

/**
 * The frozen authority a unary transport attempt is allowed to observe.
 * `bearer` can rotate in place for the same request context, but replacing the
 * context or host must abort this signal and issue a new authority.
 */
export interface HostRequestAuthority {
  readonly endpoint: HostTransportEndpoint;
  readonly bearer: OpenFrameBearerSource;
  readonly abortSignal: AbortSignal;
}

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
    authority: HostRequestAuthority,
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
    authority: HostRequestAuthority,
  ): Promise<ResponseOfMethod<Registry, Method>>;
}

/**
 * The major-version downgrade path can reject a request before a request frame
 * is sent. Keep that capability result distinct from ordinary transport and
 * host failures so UI feature gates can hide unavailable functionality without
 * mistaking a temporary disconnect for an old host.
 */
export type HostRequestFailure =
  | { readonly kind: "downgrade-unsupported"; readonly error: HostRpcError }
  | { readonly kind: "other"; readonly error: unknown };

export function classifyHostRequestFailure(error: unknown): HostRequestFailure {
  if (error instanceof HostRpcError && error.code === "DOWNGRADE_UNSUPPORTED") {
    return { kind: "downgrade-unsupported", error };
  }
  return { kind: "other", error };
}

/**
 * Totalizes an arbitrary rejection into a `HostRpcError`. TypeScript cannot
 * type a promise's rejection channel, so every `HostRpcError`-declared error
 * generic (TanStack queries/mutations, hook result interfaces) is an
 * unchecked assertion - a bare `Error` slipping through it crashes `.code` /
 * `.fatalDetails` consumers at runtime. Passing a rejection through this
 * function is what makes those declarations true by construction.
 */
export function toHostRpcError(error: unknown, method: string): HostRpcError {
  if (error instanceof HostRpcError) return error;
  return new HostRpcError({
    code: "RPC_ERROR",
    message:
      error instanceof Error ? error.message : "Unknown host request failure",
    requestId: "client-normalized",
    method,
    fatalDetails: null,
  });
}

/**
 * Runs `run` and re-throws any rejection normalized via `toHostRpcError`.
 * Wrap the entire body of a queryFn/mutationFn whose error type is declared
 * as `HostRpcError`, so bugs and bare throws anywhere inside (response
 * mapping, pagination guards, transient-client resolution) can never leak a
 * foreign error shape to `.code`-reading consumers.
 */
export async function withHostRpcErrorBoundary<T>(
  method: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toHostRpcError(error, method);
  }
}

/** Auth recovery discovered that the captured bearer no longer owns the session. */
export class HostAuthoritySupersededError extends Error {
  constructor() {
    super(
      "Host request authority was superseded before authentication recovery completed",
    );
    this.name = "HostAuthoritySupersededError";
  }
}

/**
 * True when the failure is expected to clear on its own: the transport never
 * got an answer from the host (restart, dropped socket, dial/frame timeout),
 * or the host answered with a fatal frame it explicitly marked `retryable`
 * (e.g. a transient credential-verification outage). Background best-effort
 * callers use this to fail silently; user-gesture surfaces can still toast,
 * describing the connection rather than the operation.
 */
export function isTransientHostRpcFailure(error: HostRpcError): boolean {
  return (
    error instanceof HostTransportFailureError ||
    error.fatalDetails?.retryable === true
  );
}

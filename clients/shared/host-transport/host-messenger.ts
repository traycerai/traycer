import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import {
  HostRpcError,
  HostTransportFailureError,
  type RequestOfMethod,
  type RequiredHostMethodVersion,
  type ResponseOfMethod,
} from "@traycer/protocol/host-transport/remote/rpc-types";
import type { OpenFrameBearerSource } from "../auth/bearer-source";

export {
  HostMethodVersionUnsatisfiedError,
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
  negotiatedVersionMeetsRequirement,
  type RequestOfMethod,
  type RequiredHostMethodVersion,
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
  /**
   * Whether the session behind `bearer` may spend a CLOUD CAPABILITY, carried
   * to the host on this request's `open` frame so a context the host registers
   * as live inherits the verdict instead of defaulting to authorized.
   *
   * That registration is the reason a one-request socket needs a verdict at
   * all. The request itself is the small half: the host registers this
   * connection's context in its live-context registry, where background workers
   * select it for work no client asked for - so a `/rpc` call from an
   * unverified session would otherwise hand the host an authorized context to
   * spend on that user's account.
   *
   * A LIVE READ, not a captured boolean, and that is the whole correctness of
   * it. An authority outlives its construction: the request coordinator queues
   * it, and `WsRpcClient` then awaits `session.dial()` before the open frame
   * goes out. A snapshot taken at construction can therefore be sent long after
   * the verdict moved - and a same-context demotion does NOT abort the context
   * (that is the point of demoting in place), so the `abortSignal` fence never
   * fires and nothing else catches it. The result was an `open` frame asserting
   * `cloudAuthorized: true` for a session already demoted.
   *
   * So it is read as LATE as the frame allows - in `WsRpcClient` at the
   * `session.send({kind: "open"})` that follows the dial. Note this is later
   * than `bearer`, which `extractBearerOrThrowRpcError` pulls before
   * `session.dial()`; the two are deliberately NOT level. The skew only runs
   * one way and that way is closed: a demotion during the dial sends
   * `cloudAuthorized: false` beside a pre-demotion bearer, which denies. The
   * opposite pairing - a stale `true` beside a fresh bearer - is the one that
   * would spend, and reading the verdict last is what makes it unreachable.
   *
   * OPTIONAL, and the absence is meaningful rather than a default: an authority
   * that does not carry a verdict is one built before this existed, and the
   * host reads its silence as authorized - the same "presence is the
   * declaration" rule the wire field itself follows.
   */
  readonly cloudAuthorized?: () => boolean;
}

/**
 * Per-request options shared by every unary send: the idempotency key that
 * lets a retried request be recognized as the same attempt, and the frozen
 * authority it may dispatch under. Grouped so `request` and
 * `requestWithResponseTimeout` take the same trailing shape rather than two
 * positional tails that drift apart as the seam grows.
 */
export interface HostRequestOptions {
  readonly idempotencyKey: string | null;
  readonly authority: HostRequestAuthority;
  /**
   * This dispatch is a REPLAY of an attempt that may already have committed,
   * so it must not go out unkeyed.
   *
   * `false` on a caller's first attempt, and set by
   * `createRetryingMessenger` for every attempt after a failure whose
   * retryability was earned by a negotiated key
   * ({@link RetryableTransportError.replaySafetyFromKey}).
   *
   * The two are not the same question as `idempotencyKey !== null`. A key is
   * what the CALLER asked for; this is whether dropping it is still allowed.
   * Both transports strip a key the handshake cannot honour
   * (`ws-rpc-client`'s `wireIdempotencyKey`, `remote-session`'s), which is
   * correct on a first attempt against a host that predates the capability -
   * nothing has been dispatched, so an unkeyed send is a first send. It is not
   * correct on a replay: the first attempt's retryability was granted BECAUSE
   * that connection negotiated a key, and a second connection that cannot
   * honour it - a reconnect onto a host replaced by an older incarnation -
   * would execute the mutation a second time with no dedupe. On that path both
   * transports must refuse and answer ambiguously instead of dispatching.
   */
  readonly replayMustBeKeyed: boolean;
  /**
   * A floor this dispatch's OWN handshake must clear, or the request must not
   * go out at all.
   *
   * The problem it solves is that a version read and the call it authorizes
   * are two different connections. Every local unary dials a fresh socket and
   * handshakes again, so a caller that asks `readNegotiatedMethodVersion` -
   * or that forces a handshake with a probe RPC and reads what it recorded -
   * has learned about a host process that may be gone by the time the real
   * frame is written. A host restarted or rolled back under the same id in
   * that window answers the request on its older resolver, and an additive
   * request field the caller was relying on is silently stripped by the
   * frozen schema of the version actually negotiated. The caller sees a
   * normal response and cannot tell.
   *
   * So the requirement travels WITH the request and is checked against the
   * manifest of the connection carrying it, between `openAck` and the request
   * frame. Below the floor, both transports refuse pre-send with
   * `HostMethodVersionUnsatisfiedError`; nothing was dispatched, so the
   * refusal is unambiguous.
   *
   * `method` is not necessarily the method being sent. A caller may condition
   * one call on the version of another - `epic.create` advertises no version
   * of its own, and what decides whether this host serves creates locally is
   * the `epic.listTasks` line it is on - so the requirement names its own
   * subject. `null` is the ordinary case: no floor, dispatch whatever the
   * handshake negotiates.
   */
  readonly requiredHostMethodVersion: RequiredHostMethodVersion | null;
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
    options: HostRequestOptions,
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
    options: HostRequestOptions,
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

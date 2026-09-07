import {
  holdersRevisionWireFieldSchema,
  isRpcErrorCode,
  worktreeBusyHoldersSchema,
  type LatestContract,
  type MethodVersionRegistry,
  type RequestOf,
  type ResponseOf,
  type RpcErrorCode,
  type RpcErrorDetails,
  type VersionedRpcRegistry,
  type WorktreeBusyHolder,
} from "@traycer/protocol/framework/index";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { OpenFrameBearerSource } from "../auth/bearer-source";

/**
 * Immutable transport coordinates captured for one host-RPC job.
 * The transport owns no live endpoint or bearer providers: callers capture an authority before dispatch, then every retry reuses this exact object.
 */
export interface HostTransportEndpoint {
  readonly hostId: string;
  readonly websocketUrl: string | null;
}

/**
 * The frozen authority a unary transport attempt is allowed to observe.
 * `bearer` can rotate in place for the same request context, but replacing the context or host must abort this signal and issue a new authority.
 */
export interface HostRequestAuthority {
  readonly endpoint: HostTransportEndpoint;
  readonly bearer: OpenFrameBearerSource;
  readonly abortSignal: AbortSignal;
}

/**
 * Per-request options shared by every unary send: the idempotency key that lets a retried request be recognized as the same attempt, and the frozen authority it may dispatch under.
 * Grouped so `request` and `requestWithResponseTimeout` take the same trailing shape rather than two positional tails that drift apart as the seam grows.
 */
export interface HostRequestOptions {
  readonly idempotencyKey: string | null;
  readonly authority: HostRequestAuthority;
  /**
   * This dispatch is a replay of an attempt that may already have committed, so it must not go out unkeyed.
   * `false` on a caller's first attempt, and set by `createRetryingMessenger` for every attempt after a failure whose retryability was earned by a negotiated key ({@link RetryableTransportError.replaySafetyFromKey}).
   */
  readonly replayMustBeKeyed: boolean;
}

export interface IHostMessenger<Registry extends VersionedRpcRegistry> {
  /** Sends a single unary RPC request and resolves with the method's canonical response body. */
  request<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    options: HostRequestOptions,
  ): Promise<ResponseOfMethod<Registry, Method>>;

  /**
   * Same as `request`, but waits up to `responseTimeoutMs` for the host's response frame instead of the transport's default frame timeout.
   * Only the response wait is extended - dial and handshake (`openAck`) keep the transport's defaults, so a host that is actually unreachable still fails fast.
   */
  requestWithResponseTimeout<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    responseTimeoutMs: number,
    options: HostRequestOptions,
  ): Promise<ResponseOfMethod<Registry, Method>>;
}

export type RequestOfMethod<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
> = Registry[Method] extends MethodVersionRegistry
  ? RequestOf<LatestContract<Registry[Method]>>
  : never;

export type ResponseOfMethod<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
> = Registry[Method] extends MethodVersionRegistry
  ? ResponseOf<LatestContract<Registry[Method]>>
  : never;

export class HostRpcError extends Error {
  readonly code: RpcErrorCode;
  readonly requestId: string;
  readonly method: string;
  /**
   * Buffered `fatalError` payload preserved verbatim from the host's pre-close frame (or from the client-side mirror compatibility check).
   */
  readonly fatalDetails: FatalErrorDetails | null;
  /**
   * Typed holder inventory on `WORKTREE_BUSY` and `WORKTREE_HOLDERS_CHANGED`.
   * Callers that render a confirm dialog read this; they must not fall back to parsing `message`.
   */
  readonly holders: readonly WorktreeBusyHolder[] | null;
  /**
   * Opaque host digest of that inventory. `null` when the envelope omitted
   * it, carried a different code, or was not a non-empty string.
   */
  readonly holdersRevision: string | null;

  constructor(details: {
    code: RpcErrorCode;
    message: string;
    requestId: string;
    method: string;
    fatalDetails: FatalErrorDetails | null;
    holders?: readonly WorktreeBusyHolder[] | null;
    holdersRevision?: string | null;
  }) {
    super(details.message);
    this.name = "HostRpcError";
    this.code = details.code;
    this.requestId = details.requestId;
    this.method = details.method;
    this.fatalDetails = details.fatalDetails;
    this.holders = isHolderCarryingCode(details.code)
      ? (details.holders ?? null)
      : null;
    this.holdersRevision = isHolderCarryingCode(details.code)
      ? (details.holdersRevision ?? null)
      : null;
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
      holders: holdersForBusyCode(error.code, error.holders),
      holdersRevision: holdersRevisionForBusyCode(
        error.code,
        error.holdersRevision,
      ),
    });
  }

  /**
   * Build from a decoded wire error envelope (`code` is an open string).
   * `holders` (and `holdersRevision`) survive only on `WORKTREE_BUSY` / `WORKTREE_HOLDERS_CHANGED` when they match the protocol schema.
   */
  static fromWireEnvelope(
    error: {
      readonly code: string;
      readonly message: string;
      readonly holders?: unknown;
      readonly holdersRevision?: unknown;
    },
    requestId: string,
    method: string,
  ): HostRpcError {
    return new HostRpcError({
      code: isRpcErrorCode(error.code) ? error.code : "RPC_ERROR",
      message: error.message,
      requestId,
      method,
      fatalDetails: null,
      holders: holdersForBusyCode(error.code, error.holders),
      holdersRevision: holdersRevisionForBusyCode(
        error.code,
        error.holdersRevision,
      ),
    });
  }
}

function isHolderCarryingCode(code: string): boolean {
  return code === "WORKTREE_BUSY" || code === "WORKTREE_HOLDERS_CHANGED";
}

function holdersForBusyCode(
  code: string,
  holders: unknown,
): readonly WorktreeBusyHolder[] | null {
  if (!isHolderCarryingCode(code)) {
    return null;
  }
  if (holders === undefined || holders === null) {
    return null;
  }
  const parsed = worktreeBusyHoldersSchema.safeParse(holders);
  return parsed.success ? parsed.data : null;
}

function holdersRevisionForBusyCode(
  code: string,
  revision: unknown,
): string | null {
  if (!isHolderCarryingCode(code)) return null;
  const parsed = holdersRevisionWireFieldSchema.safeParse(revision);
  if (
    !parsed.success ||
    parsed.data === undefined ||
    parsed.data.length === 0
  ) {
    return null;
  }
  return parsed.data;
}

/**
 * The major-version downgrade path can reject a request before a request frame is sent.
 * Keep that capability result distinct from ordinary transport and host failures so UI feature gates can hide unavailable functionality without mistaking a temporary disconnect for an old host.
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

/**
 * A `HostRpcError` whose cause is the transport itself - no host bound, a dropped or unopenable WebSocket, a dial or frame timeout - rather than the host rejecting the operation.
 * The host either never saw the request or never answered it, so the failure says nothing about the method that happened to be in flight.
 */
export class HostTransportFailureError extends HostRpcError {
  constructor(details: {
    code: RpcErrorCode;
    message: string;
    requestId: string;
    method: string;
    fatalDetails: FatalErrorDetails | null;
  }) {
    super(details);
    this.name = "HostTransportFailureError";
  }
}

/**
 * The "host did not dispatch the request" guarantee is what makes it safe to retry even non-idempotent methods: a fresh dial cannot double-apply a side effect.
 */
export class RetryableTransportError extends HostTransportFailureError {
  /**
   * This retryability was earned by a negotiated key rather than by proof that nothing was dispatched.
   * A pre-dispatch failure is safe to replay however the next connection is configured, because the host never saw the call.
   */
  readonly replaySafetyFromKey: boolean;

  constructor(details: {
    code: RpcErrorCode;
    message: string;
    requestId: string;
    method: string;
    fatalDetails: FatalErrorDetails | null;
    replaySafetyFromKey: boolean;
  }) {
    super(details);
    this.name = "RetryableTransportError";
    this.replaySafetyFromKey = details.replaySafetyFromKey;
  }
}

/**
 * A caller-owned request authority was aborted.
 * Unlike a pre-send dial failure, this is never retryable: the authority belongs to a context or host binding that has already been replaced or disposed.
 */
export class HostRequestAbortedError extends HostTransportFailureError {
  constructor(details: { message: string; requestId: string; method: string }) {
    super({
      code: "RPC_ERROR",
      message: details.message,
      requestId: details.requestId,
      method: details.method,
      fatalDetails: null,
    });
    this.name = "HostRequestAbortedError";
  }
}

export class HostAuthoritySupersededError extends Error {
  constructor() {
    super(
      "Host request authority was superseded before authentication recovery completed",
    );
    this.name = "HostAuthoritySupersededError";
  }
}

/**
 * Background best-effort callers use this to fail silently; user-gesture surfaces can still toast, describing the connection rather than the operation.
 */
export function isTransientHostRpcFailure(error: HostRpcError): boolean {
  return (
    error instanceof HostTransportFailureError ||
    error.fatalDetails?.retryable === true
  );
}

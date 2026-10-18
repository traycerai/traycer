import {
  ENVIRONMENT_WRITE_STALE_CODE,
  staleWriteForCode,
  type EnvironmentStaleWrite,
} from "../../framework/environment-stale-write";
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
  type SchemaVersion,
  type VersionedRpcRegistry,
  type WorktreeBusyHolder,
} from "../../framework/index";
import type { FatalErrorDetails } from "../../framework/ws-protocol";

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

/**
 * "Method `method` must be advertised at `version` or higher, in the same
 * major." Attached to a request as `HostRequestOptions.requiredHostMethodVersion`
 * (clients/shared) and checked by both transports between `openAck` and the
 * request frame; below the floor the dispatch is refused pre-send with
 * {@link HostMethodVersionUnsatisfiedError}.
 */
export interface RequiredHostMethodVersion {
  readonly method: string;
  readonly version: SchemaVersion;
}

/**
 * Whether a connection's advertised version for the required method clears the
 * floor. `undefined` - the host does not advertise the method at all - does
 * not, and neither does a different major: a major is a break, so "higher"
 * across one is not the same capability.
 *
 * A host whose canonical entry sits on a HIGHER major also fails, and that is
 * fail-closed rather than a gap. Such a peer may still serve the caller's
 * major through the same-major downgrade, but its manifest entry carries only
 * the canonical `{ major, minor }` - the minor it would serve on the older
 * major is not in it - so there is no evidence here that the floor is met, and
 * a floor exists precisely because guessing is what went wrong.
 *
 * Shared by both transports so the local and remote answers cannot drift.
 */
export function negotiatedVersionMeetsRequirement(
  negotiated: SchemaVersion | undefined,
  requirement: RequiredHostMethodVersion,
): boolean {
  if (negotiated === undefined) return false;
  return (
    negotiated.major === requirement.version.major &&
    negotiated.minor >= requirement.version.minor
  );
}

export class HostRpcError extends Error {
  readonly code: RpcErrorCode;
  readonly requestId: string;
  readonly method: string;
  readonly fatalDetails: FatalErrorDetails | null;
  /**
   * Typed holder inventory on `WORKTREE_BUSY` and
   * `WORKTREE_HOLDERS_CHANGED`. `null` when the envelope omitted it (old
   * host), carried a different code, or failed schema parse.
   */
  readonly holders: readonly WorktreeBusyHolder[] | null;
  /**
   * Opaque host digest of that inventory. `null` when the envelope omitted
   * it, carried a different code, or was not a non-empty string.
   */
  readonly holdersRevision: string | null;
  /**
   * Who changed the item and its current revision, on
   * `ENVIRONMENT_WRITE_STALE`. `null` on every other code, when the envelope
   * omitted it, or when it failed schema parse.
   */
  readonly staleWrite: EnvironmentStaleWrite | null;

  constructor(details: {
    code: RpcErrorCode;
    message: string;
    requestId: string;
    method: string;
    fatalDetails: FatalErrorDetails | null;
    holders?: readonly WorktreeBusyHolder[] | null;
    holdersRevision?: string | null;
    staleWrite?: EnvironmentStaleWrite | null;
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
    this.staleWrite =
      details.code === ENVIRONMENT_WRITE_STALE_CODE
        ? (details.staleWrite ?? null)
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
      staleWrite: staleWriteForCode(error.code, error.staleWrite),
    });
  }

  static fromWireEnvelope(
    error: {
      readonly code: string;
      readonly message: string;
      readonly holders?: unknown;
      readonly holdersRevision?: unknown;
      readonly staleWrite?: unknown;
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
      staleWrite: staleWriteForCode(error.code, error.staleWrite),
    });
  }
}

/**
 * A pre-send refusal: this connection's handshake does not meet the floor the
 * caller attached to the request.
 *
 * Extends `HostRpcError` so it is non-retryable by construction - the retrying
 * messenger only retries `RetryableTransportError`, and retrying is exactly
 * wrong here, since a redial reaches the same downgraded host. Callers that
 * have their own copy for this condition (`epic.listTasks`' withdrawn-verdict
 * error, the composer's inline create refusal) catch this specific type rather
 * than matching on `code`, which several unrelated paths also produce.
 */
export class HostMethodVersionUnsatisfiedError extends HostRpcError {
  readonly requirement: RequiredHostMethodVersion;
  /** What the connection advertised, or `null` when it advertised nothing. */
  readonly negotiated: SchemaVersion | null;

  constructor(details: {
    requirement: RequiredHostMethodVersion;
    negotiated: SchemaVersion | undefined;
    requestId: string;
    method: string;
    hostId: string;
  }) {
    const advertised =
      details.negotiated === undefined
        ? "not advertised"
        : `${String(details.negotiated.major)}.${String(details.negotiated.minor)}`;
    super({
      code: "DOWNGRADE_UNSUPPORTED",
      message: `Host '${details.hostId}' negotiated '${details.requirement.method}' at ${advertised}, below the ${String(details.requirement.version.major)}.${String(details.requirement.version.minor)} this '${details.method}' call requires`,
      requestId: details.requestId,
      method: details.method,
      fatalDetails: null,
    });
    this.name = "HostMethodVersionUnsatisfiedError";
    this.requirement = details.requirement;
    this.negotiated = details.negotiated ?? null;
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

export class RetryableTransportError extends HostTransportFailureError {
  /**
   * This retryability was earned by a NEGOTIATED KEY rather than by proof that
   * nothing was dispatched.
   *
   * The two grounds are not interchangeable and the difference decides what a
   * retry is allowed to do. A pre-dispatch failure is safe to replay however
   * the next connection is configured, because the host never saw the call. A
   * post-send failure is safe only for as long as the host is deduplicating
   * the key - so a replay of one must itself be keyed, which is what
   * `HostRequestOptions.replayMustBeKeyed` carries into the next attempt.
   *
   * Defaulted nowhere: every construction states its ground, because a
   * `false` assumed by omission would silently license exactly the unkeyed
   * replay this field exists to prevent.
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

export class HostRequestAbortedError extends HostTransportFailureError {
  /**
   * Whether the request may already have reached the host before its
   * authority was aborted: the frame had been sent on this connection, or an
   * earlier attempt of the same retry episode was sent and its answer lost.
   * An abort stops the caller from WAITING for the answer; it does not recall
   * a request the host may already be running, so a caller that reports
   * outcomes must not read a dispatched abort as "nothing happened".
   *
   * Stated at every construction, never defaulted, for the reason
   * `RetryableTransportError.replaySafetyFromKey` gives.
   */
  readonly mayHaveDispatched: boolean;

  constructor(details: {
    message: string;
    requestId: string;
    method: string;
    mayHaveDispatched: boolean;
  }) {
    super({
      code: "RPC_ERROR",
      message: details.message,
      requestId: details.requestId,
      method: details.method,
      fatalDetails: null,
    });
    this.name = "HostRequestAbortedError";
    this.mayHaveDispatched = details.mayHaveDispatched;
  }
}

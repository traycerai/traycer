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

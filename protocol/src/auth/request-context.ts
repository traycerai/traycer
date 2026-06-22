/**
 * Shared-core request context for auth identity and token propagation.
 *
 * This module is platform-neutral: it is consumed by host RPC/stream
 * resolvers, renderer/extension single-user flows, and tests. Host and
 * renderer adapters are responsible for constructing a context at their
 * boundary; shared-core services accept this context as their explicit
 * first argument instead of reading singleton auth state.
 *
 * Lives in `protocol/` so that future open-source clients (which won't
 * depend on the internal shared package) can share the same auth
 * identity/lease abstractions used inside the host. The module does carry runtime
 * behavior - classes, a WeakMap identity cache, and abort/cancel wiring
 * - alongside the declarative wire-shape contracts the package owns.
 *
 * Invariants enforced here (and asserted by characterization tests):
 *
 *   - The authenticated identity (`userId`, `username`, `providerHandle`)
 *     is an immutable snapshot for the lifetime of the context - it holds
 *     only locally-verifiable primitives, so mutating the caller's
 *     `AuthenticatedUser` afterwards has no effect on `ctx.identity`. There
 *     is no mid-operation identity switch. Team membership is deliberately
 *     NOT snapshotted here (it is a property of the user, not the
 *     connection, and is resolved from the single per-user
 *     `AuthenticatedUserProvider` source instead).
 *   - The credential lease may rotate bearer material only for the same
 *     `userId`; a cross-user rotation throws `IdentityMismatchError`.
 *   - `release()` clears retained bearer material so the host does not
 *     hold credentials beyond an active context/lease lifetime.
 *   - `abort()` releases credentials AND signals the abort signal so
 *     downstream cleanup can fail closed for old-user work.
 */
import type { AuthenticatedUser } from "@traycer/protocol/auth";

/**
 * Where a context was minted. Used by diagnostics and (eventually) by
 * code paths that must reject identity authority from the wrong origin.
 */
export type RequestContextOrigin =
  | "host-rpc"
  | "host-stream"
  | "renderer"
  | "extension"
  | "test";

/**
 * Immutable identity snapshot. `userId` and `username` are pre-resolved
 * convenience fields so cache-keying, persistence ownership, and
 * presence/migration writes do not need to re-derive them per call.
 */
export interface AuthenticatedIdentity {
  readonly userId: string;
  readonly username: string;
  readonly providerHandle: string | null;
}

/**
 * Thrown when shared-core code requests a bearer from a context whose
 * lease has been released or whose context has been aborted. Callers at
 * resolver/cleanup boundaries translate this into their boundary-specific
 * unauthorized error or persist pending state for retry.
 */
export class CredentialLeaseReleasedError extends Error {
  constructor(message: string | undefined) {
    super(message ?? "Credential lease has been released");
    this.name = "CredentialLeaseReleasedError";
  }
}

/**
 * Thrown when a credential rotation tries to swap in a bearer for a
 * different `userId` than the immutable identity. This is the test
 * boundary that makes "no identity switch on credential rotation"
 * executable.
 */
export class IdentityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityMismatchError";
  }
}

/**
 * Context-bound credential lease. The lease owns the retained bearer
 * for the duration of an operation (or a long-lived Tiptap/notification
 * session) and is the only place credentials may rotate. Identity is
 * fixed at construction; rotation is same-user-only.
 */
export interface CredentialLease {
  readonly identity: AuthenticatedIdentity;
  readonly isReleased: boolean;
  /**
   * Returns the current bearer. Throws `CredentialLeaseReleasedError`
   * when the lease has been released (directly or via context abort).
   */
  getBearerToken(): string;
  /**
   * Replaces retained bearer material for the SAME authenticated user.
   * Throws `IdentityMismatchError` if `userId` does not match the
   * lease identity, and `CredentialLeaseReleasedError` if the lease has
   * already been released.
   */
  rotateBearerToken(args: { userId: string; bearerToken: string }): void;
  /**
   * Idempotent. Clears retained bearer material so cleanup paths can
   * surrender credentials without leaking them past the operation.
   */
  release(): void;
}

/**
 * Per-operation request context threaded as the explicit first argument
 * to identity/token-sensitive shared-core methods.
 *
 * Construction happens at process boundaries (host WS open frames,
 * renderer/extension auth boundaries, test fixtures). Shared-core code never
 * constructs its own context.
 */
export interface RequestContext {
  readonly identity: AuthenticatedIdentity;
  readonly origin: RequestContextOrigin;
  readonly connectionId: string | undefined;
  readonly operationId: string | undefined;
  readonly abortSignal: AbortSignal;
  readonly credentials: CredentialLease;
  readonly isAborted: boolean;
  /**
   * Aborts the context: signals `abortSignal` AND releases the credential
   * lease so any retained bearer material is cleared. Idempotent.
   */
  abort(reason: string | undefined): void;
  /**
   * Releases the credential lease without firing the abort signal. Used
   * when a resolver completes normally and no follow-up cloud work is
   * outstanding. Idempotent.
   */
  release(): void;
}

export interface CreateRequestContextOptions {
  readonly identity: AuthenticatedIdentity;
  readonly bearerToken: string;
  readonly origin: RequestContextOrigin;
  readonly connectionId: string | undefined;
  readonly operationId: string | undefined;
  /**
   * Optional external abort signal (e.g. a stream's connection-close
   * signal or an auth-transition signal). When it fires, the context
   * aborts itself - releasing credentials and forwarding through
   * `abortSignal`.
   */
  readonly externalAbortSignal: AbortSignal | undefined;
}

/**
 * Display username for an `AuthenticatedUser`. Falls back to
 * `providerHandle` when `user.name` is null - `providerHandle` is required
 * upstream so this is the canonical resolution for presence/migration
 * writes and is shared across host, renderer, and persistence callers.
 */
export function usernameFromAuthenticatedUser(user: AuthenticatedUser): string {
  return user.user.name ?? user.user.providerHandle;
}

const identityCache = new WeakMap<AuthenticatedUser, AuthenticatedIdentity>();

/**
 * Builds an `AuthenticatedIdentity` from an `AuthenticatedUser`.
 *
 * The identity holds only locally-derivable primitives (`userId`,
 * `username`, `providerHandle`) copied by value, so subsequent mutation of
 * the caller's object cannot leak into `ctx.identity`. Identities are
 * memoized per source `AuthenticatedUser` reference, so repeated context
 * creation for the same signed-in user reuses one frozen identity. Team
 * membership is intentionally not derived here - it is resolved from the
 * single per-user `AuthenticatedUserProvider` source where it is needed.
 */
export function identityFromAuthenticatedUser(
  user: AuthenticatedUser,
): AuthenticatedIdentity {
  const cached = identityCache.get(user);
  if (cached !== undefined) {
    return cached;
  }
  const identity = Object.freeze({
    userId: user.user.id,
    username: usernameFromAuthenticatedUser(user),
    providerHandle: user.user.providerHandle ?? null,
  });
  identityCache.set(user, identity);
  return identity;
}

/**
 * Builds an `AuthenticatedIdentity` from verified token claims, with no full
 * `AuthenticatedUser` in hand. This is the local-JWT connect path (host RPC
 * and stream) after token verification. Team-backed role checks resolve
 * memberships from the cached `AuthenticatedUserProvider` - the single source
 * of truth - rather than from the identity.
 */
export function identityFromClaims(claims: {
  readonly userId: string;
  readonly providerHandle: string | null;
}): AuthenticatedIdentity {
  return Object.freeze({
    userId: claims.userId,
    username: claims.providerHandle ?? claims.userId,
    providerHandle: claims.providerHandle,
  });
}

class CredentialLeaseImpl implements CredentialLease {
  readonly identity: AuthenticatedIdentity;
  private retainedBearer: string | undefined;
  private released = false;

  constructor(identity: AuthenticatedIdentity, initialBearer: string) {
    this.identity = identity;
    this.retainedBearer = initialBearer;
  }

  get isReleased(): boolean {
    return this.released;
  }

  getBearerToken(): string {
    if (this.released || this.retainedBearer === undefined) {
      throw new CredentialLeaseReleasedError(
        `Credential lease for user '${this.identity.userId}' is no longer valid`,
      );
    }
    return this.retainedBearer;
  }

  rotateBearerToken(args: { userId: string; bearerToken: string }): void {
    if (this.released) {
      throw new CredentialLeaseReleasedError(
        `Cannot rotate credentials on released lease for user '${this.identity.userId}'`,
      );
    }
    if (args.userId !== this.identity.userId) {
      throw new IdentityMismatchError(
        `Refusing to rotate credentials: lease identity '${this.identity.userId}' does not match supplied userId '${args.userId}'`,
      );
    }
    this.retainedBearer = args.bearerToken;
  }

  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.retainedBearer = undefined;
  }
}

class RequestContextImpl implements RequestContext {
  readonly identity: AuthenticatedIdentity;
  readonly origin: RequestContextOrigin;
  readonly connectionId: string | undefined;
  readonly operationId: string | undefined;
  readonly credentials: CredentialLease;
  private readonly internalAbort: AbortController;

  constructor(options: CreateRequestContextOptions) {
    this.identity = options.identity;
    this.origin = options.origin;
    this.connectionId = options.connectionId;
    this.operationId = options.operationId;
    this.credentials = new CredentialLeaseImpl(
      options.identity,
      options.bearerToken,
    );
    this.internalAbort = new AbortController();

    this.internalAbort.signal.addEventListener("abort", () => {
      this.credentials.release();
    });

    const external = options.externalAbortSignal;
    if (external !== undefined) {
      if (external.aborted) {
        this.internalAbort.abort(external.reason);
      } else {
        external.addEventListener(
          "abort",
          () => {
            this.internalAbort.abort(external.reason);
          },
          { once: true },
        );
      }
    }
  }

  get abortSignal(): AbortSignal {
    return this.internalAbort.signal;
  }

  get isAborted(): boolean {
    return this.internalAbort.signal.aborted;
  }

  abort(reason: string | undefined): void {
    if (this.internalAbort.signal.aborted) {
      return;
    }
    this.internalAbort.abort(reason);
  }

  release(): void {
    this.credentials.release();
  }
}

/**
 * Builds a `RequestContext`. The returned context is the immutable
 * authority for `identity` for its lifetime; rotation is allowed only
 * through the credential lease for the same `userId`.
 */
export function createRequestContext(
  options: CreateRequestContextOptions,
): RequestContext {
  return new RequestContextImpl(options);
}

/**
 * Resolves the bearer for a `RequestContext` and returns ready-to-send
 * `Authorization: Bearer <token>` headers. Centralised so host, renderer,
 * and shared-core call sites all fail closed identically when the lease is
 * released or aborted - the only per-caller variation is the error class.
 */
export function buildBearerHeadersFromContext(
  ctx: RequestContext,
  options: {
    operationLabel: string;
    errorClass: new (message: string) => Error;
  },
): Headers {
  const Err = options.errorClass;
  const userId = ctx.identity.userId;
  if (ctx.isAborted) {
    throw new Err(
      `${options.operationLabel}: request context for user '${userId}' has been aborted`,
    );
  }
  let token: string;
  try {
    token = ctx.credentials.getBearerToken();
  } catch (cause) {
    if (cause instanceof CredentialLeaseReleasedError) {
      throw new Err(cause.message);
    }
    throw cause;
  }
  if (token.length === 0) {
    throw new Err(
      `${options.operationLabel}: empty bearer token for user '${userId}'`,
    );
  }
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

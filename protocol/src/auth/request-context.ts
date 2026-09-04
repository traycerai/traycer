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
  // Minted by the host for its own background work, with no client request or
  // stream behind it (e.g. the host-owner authority read from the machine-local
  // credentials file to drive queue-native managed-command deliveries into cold
  // chats). Distinguishes "the host acted on its own" from "the host acted for
  // a caller", which the two `host-*` origins above both imply.
  | "host-background"
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
   * Whether this context may SPEND a cloud capability - ask the account's
   * servers to issue, read, or act on something.
   *
   * Deliberately separate from holding a usable bearer, and deliberately
   * MUTABLE where the identity is not. The renderer's session can lose its
   * `/api/v3/user` verdict while its identity, its lease and its bearer all
   * stay exactly as they were: that is the whole of the `unverified` state,
   * which keeps the local plane readable precisely BY retaining the context.
   * So "can I still talk to this host" and "may I spend the account's
   * capability" stop being the same question, and only this bit answers the
   * second.
   *
   * The verdict is the CLIENT's to assert - it is the side that talks to
   * authn - and it is refreshed in place by {@link setCloudAuthorized}. A peer
   * that does not speak verdicts reads `true` forever, because such a peer has
   * no state to be unauthorized in.
   *
   * No negotiated frame carries this across a connection yet, so today the
   * only site that asserts a verdict is the renderer's own context provider,
   * in-process. Host-side connection boundaries pass `undefined` until that
   * capability exists; the field is the seam it will land on, not evidence
   * that it already has.
   *
   * `host-background` contexts are always `true`. They are the host acting on
   * its own credential rather than for a caller, which is a separate authority
   * that no GUI session's verdict speaks for.
   */
  readonly cloudAuthorized: boolean;
  /**
   * Applies a verdict change to a live context, in place.
   *
   * In place rather than by replacement because the context IS the thing every
   * background worker, timer and in-flight promise already holds; handing out a
   * new one would leave the old, permissive object in every closure that
   * captured it - which is the exact defect this bit exists to close.
   *
   * A no-op on a `host-background` context.
   */
  setCloudAuthorized(cloudAuthorized: boolean): void;
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
  /**
   * The peer's asserted cloud verdict at context creation, or `undefined` for
   * a peer that does not speak verdicts at all - see
   * {@link RequestContext.cloudAuthorized}. `undefined` reads as authorized.
   *
   * Explicitly `| undefined` rather than optional, like `externalAbortSignal`
   * above: every construction site has to state which of the two it is, so a
   * new caller cannot acquire the permissive default by omission.
   */
  readonly cloudAuthorized: boolean | undefined;
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
  private cloudAuthorizedState: boolean;

  constructor(options: CreateRequestContextOptions) {
    this.identity = options.identity;
    this.origin = options.origin;
    this.connectionId = options.connectionId;
    this.operationId = options.operationId;
    // A caller that says nothing gets `true`, which is the compatible answer
    // and not a lax one: every peer that predates the verdict has no
    // `unverified` state to be in, so it is always authorized in fact. The
    // fail-closed half of the rule belongs one level up - a peer that DID
    // declare the capability having to assert its verdict on the open frame -
    // and that negotiation does not exist yet, so no construction site can
    // reach it today.
    this.cloudAuthorizedState = options.cloudAuthorized ?? true;
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

  get cloudAuthorized(): boolean {
    // The host acting on its own credential, not for a caller. No GUI
    // session's verdict speaks for that authority, so none can withdraw it.
    if (this.origin === "host-background") {
      return true;
    }
    return this.cloudAuthorizedState;
  }

  setCloudAuthorized(cloudAuthorized: boolean): void {
    if (this.origin === "host-background") {
      return;
    }
    this.cloudAuthorizedState = cloudAuthorized;
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
  // The verdict gate, and it belongs HERE rather than at the call sites for the
  // same reason the abort check does: this is the single choke point every
  // outbound cloud call passes through, so a subsystem cannot spend by
  // forgetting to ask. That matters most for the callers no UI gate can reach -
  // background timers, detached promises, outbox drains - which hold a context
  // captured long before the verdict was withdrawn and would otherwise keep
  // minting headers from it.
  //
  // Ahead of the token read on purpose. An unauthorized context usually still
  // HOLDS a perfectly well-formed bearer; that is what `unverified` is. Reading
  // it first would produce a valid header and leave the decision to whoever
  // happened to look at the verdict afterwards.
  if (!ctx.cloudAuthorized) {
    throw new Err(
      `${options.operationLabel}: request context for user '${userId}' holds no cloud verdict`,
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

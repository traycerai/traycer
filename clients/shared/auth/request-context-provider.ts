/**
 * Client-side `RequestContextProvider` boundary contract.
 *
 * Below the auth boundary (host RPC/stream resolvers, persistence
 * services, collaboration managers, cloud-data clients) the only exposed
 * auth authority is a `RequestContext`. The provider replaces the legacy
 * raw-token runtime surfaces (`getToken()`, `onTokenChange(...)`,
 * `HostClient.setAuthToken(...)`) with context-oriented equivalents:
 *
 *   - `current()` returns the live `RequestContext` or `null`.
 *   - `onChange(listener)` notifies on every transition with the new
 *     context (or `null` on sign-out).
 *
 * The provider intentionally does NOT expose the raw bearer string. Final
 * host transport clients (e.g. `WsRpcClient`, stream clients) extract a
 * bearer through `ctx.credentials.getBearerToken()` only when opening a
 * WS open frame - every other consumer threads `RequestContext` itself.
 *
 * Boundary transitions are driven via the imperative methods on the
 * default implementation:
 *
 *   - `setSignedIn(...)` mints a fresh context. If the previous context
 *     was for a different user, it is aborted/released first; a same-user
 *     re-sign-in also aborts the previous context so any in-flight work
 *     under the old session does not silently keep going under the new
 *     bearer.
 *   - `rotateCurrentBearer(...)` rotates the lease of the active context
 *     for the SAME `userId`. Identity stays stable; subscribers do NOT
 *     receive a fresh emission because the context reference is unchanged.
 *   - `signOut()` aborts the current context and emits `null`.
 *
 * Same-user refresh is therefore observably distinct from cross-user
 * sign-in: refresh mutates retained bearer material in place, while
 * sign-in/sign-out swap the live context value.
 */
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
  type RequestContext,
  type RequestContextOrigin,
} from "@traycer/protocol/auth/request-context";

/**
 * Disposer returned from `onChange(...)`. Calling it removes the listener
 * exactly once; subsequent calls are no-ops.
 */
export type RequestContextSubscription = () => void;

/**
 * Listener signature for `onChange`. The provider always calls this
 * with the NEW current value - `null` on sign-out, or a fresh context
 * on sign-in/cross-user transition. Same-user refresh does NOT fire
 * this listener because the context reference is unchanged; subscribers
 * that need to know the credential lease rotated should observe the
 * lease itself through the existing context.
 */
export type RequestContextListener = (ctx: RequestContext | null) => void;

/**
 * Read-only client-runtime auth surface consumed below the boundary.
 *
 * The contract is intentionally narrow: there is no `getToken()` and no
 * `onTokenChange(...)`. Static guard tests assert this surface stays
 * raw-token-free.
 */
export interface RequestContextProvider {
  current(): RequestContext | null;
  onChange(listener: RequestContextListener): RequestContextSubscription;
  /**
   * Fires whenever the active context's bearer is rotated in place (same-user
   * refresh) - the transition `onChange` is deliberately silent about, because
   * the context reference is unchanged. Subscribers that must propagate a fresh
   * bearer to already-open connections (the stream transport's in-place
   * `credentialUpdate`) listen here; everything that keys on identity keeps
   * using `onChange`. Carries no value: listeners re-read the live lease.
   */
  onBearerRotated(listener: () => void): RequestContextSubscription;
}

export interface MintRequestContextOptions {
  readonly user: AuthenticatedUser;
  readonly bearerToken: string;
  readonly origin: RequestContextOrigin;
  readonly connectionId: string | undefined;
  readonly operationId: string | undefined;
  readonly externalAbortSignal: AbortSignal | undefined;
}

/**
 * Boundary helper: mints a `RequestContext` from a validated full
 * `AuthenticatedUser` plus its bearer.
 *
 * This is the ONE place the client boundary turns "raw bearer + validated
 * identity" into a `RequestContext`. Host RPC/stream boundaries have
 * an equivalent factory in their transport layer; both produce contexts
 * with the same `identity` shape so shared-core code does not need to
 * branch on origin.
 */
export function mintRequestContextFromValidatedIdentity(
  options: MintRequestContextOptions,
): RequestContext {
  return createRequestContext({
    identity: identityFromAuthenticatedUser(options.user),
    bearerToken: options.bearerToken,
    origin: options.origin,
    connectionId: options.connectionId,
    operationId: options.operationId,
    externalAbortSignal: options.externalAbortSignal,
  });
}

export interface SetSignedInOptions {
  readonly user: AuthenticatedUser;
  readonly bearerToken: string;
  readonly operationId: string | undefined;
  readonly externalAbortSignal: AbortSignal | undefined;
}

export interface RotateCurrentBearerOptions {
  readonly userId: string;
  readonly bearerToken: string;
}

export interface DefaultRequestContextProviderOptions {
  /**
   * Origin tag attached to every minted context. Renderer/extension
   * shells pass their respective origin so guard tests can distinguish
   * them when needed.
   */
  readonly origin: Extract<RequestContextOrigin, "renderer" | "extension">;
}

/**
 * Default in-memory `RequestContextProvider` implementation. Mints, swaps,
 * and aborts contexts in response to sign-in/refresh/sign-out transitions
 * driven by the auth boundary. Listeners are notified ONLY on transitions
 * that change the live context reference - same-user refresh rotates the
 * lease in place and is observably silent to subscribers.
 */
export class DefaultRequestContextProvider implements RequestContextProvider {
  private readonly origin: Extract<
    RequestContextOrigin,
    "renderer" | "extension"
  >;
  private currentContext: RequestContext | null = null;
  private readonly listeners = new Set<RequestContextListener>();
  private readonly bearerRotationListeners = new Set<() => void>();
  private disposed = false;

  constructor(options: DefaultRequestContextProviderOptions) {
    this.origin = options.origin;
  }

  current(): RequestContext | null {
    return this.currentContext;
  }

  onChange(listener: RequestContextListener): RequestContextSubscription {
    if (this.disposed) {
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onBearerRotated(listener: () => void): RequestContextSubscription {
    if (this.disposed) {
      return () => {};
    }
    this.bearerRotationListeners.add(listener);
    return () => {
      this.bearerRotationListeners.delete(listener);
    };
  }

  /**
   * Sign-in / cross-user transition. Aborts the previous context (if any)
   * before minting and emitting the new one. A previous same-user context
   * is also aborted: a fresh sign-in is a fresh session, and any in-flight
   * cleanup tied to the old context should fail closed rather than silently
   * inherit the new bearer.
   */
  setSignedIn(options: SetSignedInOptions): RequestContext {
    this.assertNotDisposed();
    const previous = this.currentContext;
    const next = mintRequestContextFromValidatedIdentity({
      user: options.user,
      bearerToken: options.bearerToken,
      origin: this.origin,
      connectionId: undefined,
      operationId: options.operationId,
      externalAbortSignal: options.externalAbortSignal,
    });
    this.currentContext = next;
    if (previous !== null) {
      const reason =
        previous.identity.userId === next.identity.userId
          ? "auth-resigned-in"
          : "auth-identity-changed";
      previous.abort(reason);
    }
    this.emit(next);
    return next;
  }

  /**
   * Same-user refresh. Rotates the credential lease on the existing
   * context. Throws if there is no live context, if the supplied
   * `userId` does not match the live identity, or if the lease has been
   * released - callers at the auth-boundary translate these into a
   * cleaner sign-out + re-sign-in transition.
   */
  rotateCurrentBearer(options: RotateCurrentBearerOptions): void {
    this.assertNotDisposed();
    const ctx = this.currentContext;
    if (ctx === null) {
      throw new Error(
        "Cannot rotate bearer: no current request context to rotate",
      );
    }
    ctx.credentials.rotateBearerToken({
      userId: options.userId,
      bearerToken: options.bearerToken,
    });
    for (const listener of [...this.bearerRotationListeners]) {
      listener();
    }
  }

  /**
   * Sign-out. Aborts the current context (releasing retained bearer
   * material) and emits `null`. Idempotent: a second `signOut()` while
   * already signed out is a no-op.
   */
  signOut(): void {
    this.assertNotDisposed();
    const previous = this.currentContext;
    if (previous === null) {
      return;
    }
    this.currentContext = null;
    previous.abort("auth-signed-out");
    this.emit(null);
  }

  /**
   * Releases all listeners and aborts the current context. After
   * disposal, `setSignedIn` / `rotateCurrentBearer` / `signOut` throw,
   * `current()` returns `null`, and `onChange` registrations are no-ops.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const previous = this.currentContext;
    this.currentContext = null;
    if (previous !== null) {
      previous.abort("request-context-provider-disposed");
    }
    this.listeners.clear();
    this.bearerRotationListeners.clear();
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(
        "RequestContextProvider has been disposed; cannot drive auth transitions",
      );
    }
  }

  private emit(value: RequestContext | null): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
}

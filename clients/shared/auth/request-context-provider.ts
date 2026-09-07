/**
 * Client-side `RequestContextProvider` boundary contract.
 * Below the auth boundary (host RPC/stream resolvers, persistence services, collaboration managers, cloud-data clients) the only exposed auth authority is a `RequestContext`.
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
 * The auth state a transition committed, captured at emit time and handed to the listener as one immutable value.
 * So the emission names the era itself instead of leaving each listener to reconstruct it.
 */
export interface AuthEra {
  /** The user id this transition committed, or `null` when signed out. */
  readonly identity: string | null;
  /** `getCredentialGeneration()` as of the commit. */
  readonly credentialGeneration: number;
}

/**
 * Listener signature for `onChange`.
 * Take it rather than re-deriving identity from `ctx` and the generation from an accessor: those are separate reads that can land on different sides of a transition, and this one cannot.
 */
export type RequestContextListener = (
  ctx: RequestContext | null,
  era: AuthEra,
) => void;

/** Read-only client-runtime auth surface consumed below the boundary. */
export interface RequestContextProvider {
  current(): RequestContext | null;
  onChange(listener: RequestContextListener): RequestContextSubscription;
  /**
   * Monotonic counter of credential changes: every `setSignedIn`, every `rotateCurrentBearer`, every `signOut`.
   * It counts here rather than in a caller because the provider is the single object every credential change already goes through: a rotation that skipped it would not be a rotation of the live lease at all.
   */
  getCredentialGeneration(): number;
  /**
   * Fires whenever the active context's bearer is rotated in place (same-user refresh) - the transition `onChange` is deliberately silent about, because the context reference is unchanged.
   * Subscribers that must propagate a fresh bearer to already-open connections (the stream transport's in-place `credentialUpdate`) listen here; everything that keys on identity keeps using `onChange`.
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
 * Boundary helper: mints a `RequestContext` from a validated full `AuthenticatedUser` plus its bearer.
 * This is the one place the client boundary turns "raw bearer + validated identity" into a `RequestContext`.
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
  /** Origin tag attached to every minted context. */
  readonly origin: Extract<RequestContextOrigin, "renderer" | "extension">;
}

/**
 * Default in-memory `RequestContextProvider` implementation.
 * Listeners are notified only on transitions that change the live context reference - same-user refresh rotates the lease in place and is observably silent to subscribers.
 */
export class DefaultRequestContextProvider implements RequestContextProvider {
  private readonly origin: Extract<
    RequestContextOrigin,
    "renderer" | "extension"
  >;
  private currentContext: RequestContext | null = null;
  private readonly listeners = new Set<RequestContextListener>();
  private readonly bearerRotationListeners = new Set<() => void>();
  /**
   * Bumped by every method below that changes the live credential, always before that change is announced - see `emitContextChange` / `rotateCurrentBearer`.
   * A listener therefore never observes a generation that is about to move for the transition it is already reacting to.
   */
  private credentialGeneration = 0;
  private disposed = false;

  constructor(options: DefaultRequestContextProviderOptions) {
    this.origin = options.origin;
  }

  current(): RequestContext | null {
    return this.currentContext;
  }

  getCredentialGeneration(): number {
    return this.credentialGeneration;
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
   * Sign-in / cross-user transition.
   * Aborts the previous context (if any) before minting and emitting the new one.
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
    this.credentialGeneration += 1;
    if (previous !== null) {
      const reason =
        previous.identity.userId === next.identity.userId
          ? "auth-resigned-in"
          : "auth-identity-changed";
      previous.abort(reason);
    }
    this.emitContextChange(next);
    return next;
  }

  /** Same-user refresh. */
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
    // The rotation the identity counter cannot see, and therefore the one this counter exists for.
    // Bumped before the notification, like every other credential change here: a listener that reads the generation while reacting to a rotation must read the post-rotation value.
    this.credentialGeneration += 1;
    for (const listener of [...this.bearerRotationListeners]) {
      listener();
    }
  }

  /**
   * Sign-out.
   * Idempotent: a second `signOut()` while already signed out is a no-op.
   */
  signOut(): void {
    this.assertNotDisposed();
    const previous = this.currentContext;
    if (previous === null) {
      return;
    }
    this.currentContext = null;
    this.credentialGeneration += 1;
    previous.abort("auth-signed-out");
    this.emitContextChange(null);
  }

  /**
   * Releases all listeners and aborts the current context.
   * After disposal, `setSignedIn` / `rotateCurrentBearer` / `signOut` throw, `current()` returns `null`, and `onChange` registrations are no-ops.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const previous = this.currentContext;
    this.currentContext = null;
    if (previous !== null) {
      // Disposal releases the live credential, so it counts like any other credential change: a request that outlives this provider must not read its own issue-time generation back as "still current".
      this.credentialGeneration += 1;
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

  /**
   * The ordering contract, stated where the emission happens.
   * So every piece of auth state that any listener can read - here and in the auth service that drives this provider - must already hold its post-transition value when this runs.
   */
  private emitContextChange(value: RequestContext | null): void {
    const era: AuthEra = {
      identity: value === null ? null : value.identity.userId,
      credentialGeneration: this.credentialGeneration,
    };
    for (const listener of [...this.listeners]) {
      listener(value, era);
    }
  }
}

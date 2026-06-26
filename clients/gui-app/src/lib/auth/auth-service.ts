import type {
  IRunnerHost,
  AuthCallbackResult,
  DeviceFlowResult,
  DeviceFlowSession,
  StoredAuthTokens,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type {
  AuthIdentityValidationResult,
  AuthIdentityValidResult,
} from "@traycer-clients/shared/auth/auth-validation";
import {
  DefaultRequestContextProvider,
  type RequestContextProvider,
} from "@traycer-clients/shared/auth/request-context-provider";
import { rotateAndPersistBearer } from "@traycer-clients/shared/auth/bearer-revalidator";
import {
  CODE_CHALLENGE_METHOD,
  deriveCodeChallenge,
  generateCodeVerifier,
} from "@traycer-clients/shared/auth/pkce";
import { usernameFromAuthenticatedUser } from "@traycer/protocol/auth/request-context";
import {
  useAuthStore,
  type AuthContextMetadata,
  type AuthProfile,
  type AuthStatus,
} from "@/stores/auth/auth-store";
import { normalizeAvatarUrl } from "@/lib/avatar-url";
import { projectShareableTeams } from "@/hooks/epic/use-epic-shareable-teams";
import { AuthTokenStore } from "./auth-token-store";

export interface AuthServiceOptions {
  readonly runnerHost: IRunnerHost;
}

export type AuthListener = (status: AuthStatus) => void;
export type AuthErrorListener = (error: string | null) => void;

/**
 * Boundary-only persisted-session snapshot.
 *
 * Host/runtime consumers must NOT read this - they thread the
 * `RequestContext` produced by `getRequestContextProvider()` instead. The
 * snapshot is exposed exclusively for cross-window/persistence projection
 * (e.g. the desktop windows bridge) where the bearer is required so a
 * second window can resume the same authenticated session.
 *
 * Per the auth boundary contract, raw bearer material is allowed only in
 * persistence/validation/refresh code paths; this snapshot is one of those
 * narrow exits.
 */
export interface AuthSessionSnapshot {
  readonly status: AuthStatus;
  readonly token: string | null;
  readonly profile: AuthProfile | null;
  readonly contextMetadata: AuthContextMetadata | null;
}

export type AuthSessionSnapshotListener = (
  snapshot: AuthSessionSnapshot,
) => void;

/**
 * Externally-delivered session snapshot accepted by `applyExternalSession`.
 *
 * Used by cross-window projection (desktop windows bridge): when window A
 * signs in, window B reads the persisted snapshot and pushes it through
 * `applyExternalSession` so window B's `AuthService` mints a context for
 * the same identity without re-running OAuth.
 */
export interface ExternalSignedInSession {
  readonly status: "signed-in";
  readonly token: string;
  readonly profile: AuthProfile;
  readonly user: AuthenticatedUser;
}

export type ExternalSession =
  | ExternalSignedInSession
  | { readonly status: "signing-in" }
  | { readonly status: "signed-out" };

/**
 * Maximum time the GUI will wait for a shell-delivered auth callback after
 * `signIn()` before returning to signed-out with an `auth-timeout` error.
 * Exposed so tests can reference the same value and callers can reason about
 * expected behavior.
 */
export const AUTH_CALLBACK_TIMEOUT_MS = 120_000;

/**
 * Stable error identifier emitted when the shell never delivers a callback
 * before the client-side timeout fires.
 */
export const AUTH_ERROR_TIMEOUT = "auth-timeout";

/**
 * Stable error identifier emitted when the runner host rejects the attempt to
 * open the external sign-in URL (e.g. the shell cannot launch a browser).
 * This must fail the flow immediately rather than waiting for the callback
 * timeout, since no callback will ever arrive.
 */
export const AUTH_ERROR_LAUNCH_FAILED = "auth-launch-failed";

/**
 * Stable error identifier emitted when AuthnV3 rejects a stored bearer token
 * during `start()`-time rehydration. Surfaced on the signed-out auth surface
 * so the user understands their previous session expired and a fresh sign-in
 * is needed. Distinct from `AUTH_ERROR_SIGN_IN_FAILED` so the UI copy matches
 * the flow the user was actually in.
 */
export const AUTH_ERROR_SESSION_EXPIRED = "session-expired";

/**
 * Stable error identifier emitted when AuthnV3 rejects (or the network fails
 * for) a token delivered through the OAuth callback during an active sign-in
 * attempt. Distinct from `AUTH_ERROR_SESSION_EXPIRED` so the signed-out auth
 * surface can render "Sign-in failed - please try again" copy instead of the
 * "Session expired" copy that belongs to the stored-token-rehydration path.
 */
export const AUTH_ERROR_SIGN_IN_FAILED = "sign-in-failed";

/**
 * Stable error identifier emitted when the user denies a device-flow request in
 * the browser. Distinct from `AUTH_ERROR_SIGN_IN_FAILED` so the device-code
 * surface can render "Request denied" copy.
 */
export const AUTH_ERROR_DEVICE_DENIED = "device-denied";

/**
 * Stable error identifier emitted when a device-flow attempt's `device_code`
 * TTL elapses before approval (the controller's terminal `expired`, or the
 * epoch+kind-scoped attempt timeout). Distinct so the device surface can render
 * "The code expired - start again" copy.
 */
export const AUTH_ERROR_DEVICE_EXPIRED = "device-expired";

/**
 * Source/kind of an in-flight sign-in attempt. `redirect` is the desktop
 * browser-redirect fast path (completion arrives as a deep-link callback);
 * `device` is the RFC 8628 fallback (completion arrives from the shell's
 * main-process poll controller). The two are distinct completion channels with
 * distinct stale-result behaviour, so the attempt records which one is live.
 */
export type AttemptKind = "redirect" | "device";

/**
 * Source-aware record of the single in-flight sign-in attempt - replaces the
 * scalar `activeOAuthEpoch`. `epoch` is the monotonically-increasing attempt id
 * (so a stale finalizer can detect supersession); `kind` is the completion
 * channel that may finalize it; `abortController` is aborted on supersede so an
 * in-flight device poll/fetch can be discarded; `redirectVerifier` holds the
 * one-time PKCE verifier for a `redirect` attempt (cleared the moment it is
 * spent or the attempt is superseded); `deviceSession` is the main-process poll
 * handle for a `device` attempt (cancelled on supersede so no 10-minute poll
 * leaks). Because `epoch` is globally unique, it identifies the attempt's kind
 * on its own; the explicit `kind` check is what drops a callback/poll result
 * BY SOURCE (a redirect deep-link never finalizes a device attempt, and vice
 * versa).
 */
interface Attempt {
  readonly epoch: number;
  readonly kind: AttemptKind;
  readonly abortController: AbortController;
  redirectVerifier: string | null;
  deviceSession: DeviceFlowSession | null;
}

/**
 * Projected device-flow progress for the GUI: the human-handled `userCode` +
 * the verification URIs to show, and the absolute expiry so the surface can
 * render a countdown instead of a silent spinner. `null` whenever no device
 * attempt is in flight.
 */
export interface DeviceFlowProgress {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresAtMs: number;
}

export type DeviceFlowProgressListener = (
  progress: DeviceFlowProgress | null,
) => void;

/**
 * Secure-storage key holding the in-flight PKCE `code_verifier`. Persisted at
 * `signIn()` and consumed at the callback exchange so a cold-start callback
 * replay (e.g. mobile re-delivering `getLaunchUrl()` after a process restart
 * between `signIn()` and the redirect) can still redeem the one-time code. The
 * verifier is single-use: it is deleted the moment the code is exchanged, and
 * on timeout / sign-out so a stale secret never lingers in the keychain.
 */
const PKCE_VERIFIER_STORAGE_KEY = "traycer.auth.pkce-code-verifier";

type ValidationOutcome = AuthIdentityValidationResult;

/**
 * GUI-owned auth service. Drives the sign-in flow through the shell-owned
 * runner host and projects the current authenticated session into:
 *
 *   - the Zustand auth store (status / profile / context metadata only -
 *     never the raw bearer string), and
 *   - a `RequestContextProvider` boundary that host/runtime/shared-core
 *     consumers subscribe to. The provider is the SOLE runtime auth surface
 *     past the boundary; the legacy `getToken()` / `onTokenChange(...)`
 *     pair has been retired in favour of `RequestContext` snapshots.
 *
 * Every token that lands in the GUI - rehydrated from the token store at
 * `start()` or delivered via `onAuthCallback` - is validated against AuthnV3
 * before being projected as `signed-in`. The validation/refresh helper
 * returns the FULL `AuthenticatedUser` so the minted `RequestContext`
 * carries the same identity shape that host-minted contexts already carry.
 *
 * Two distinct failure paths drive distinct `lastError` codes so the UI
 * copy can match the flow the user was actually in:
 *
 *   1. `start()`-time stored-token rehydration failure →
 *      `AUTH_ERROR_SESSION_EXPIRED` ("Session expired - sign in again").
 *      The validation helper has already attempted refresh before
 *      returning a terminal failure, so startup clears the stored token
 *      and asks the user to sign in again.
 *   2. The OAuth callback path - invoked by `handleCallback` when the shell
 *      delivers an OAuth success result. A `rejected` or `network-error`
 *      validation outcome surfaces `AUTH_ERROR_SIGN_IN_FAILED` ("Sign-in
 *      failed - please try again") and clears any persisted token.
 */
export class AuthService {
  private readonly runnerHost: IRunnerHost;
  private readonly tokenStore: AuthTokenStore;
  private readonly contextProvider: DefaultRequestContextProvider;
  private readonly listeners = new Set<AuthListener>();
  private readonly errorListeners = new Set<AuthErrorListener>();
  private readonly sessionSnapshotListeners =
    new Set<AuthSessionSnapshotListener>();
  private readonly authStoreUnsubscribe: () => void;
  private lastEmittedStatus: AuthStatus;
  /**
   * Persistence-only retained bearer. Mirrors the credential lease on the
   * current `RequestContext` and is kept here so cross-window projection
   * (windows-bridge) and the persisted token store can read the bearer
   * without going through `ctx.credentials.getBearerToken()`. Host /
   * runtime consumers must NEVER read this - they thread the context.
   */
  private currentBearer: string | null = null;
  private currentProfile: AuthProfile | null = null;
  private lastError: string | null = null;
  private callbackDisposable: Disposable | null = null;
  private pendingTimeoutHandle: number | null = null;
  private currentRevalidation: Promise<ValidationOutcome | null> | null = null;
  private disposed = false;
  // Monotonically increasing counter used to tag every sign-in attempt. A
  // non-zero value means at least one `signIn()` / `signInWithDeviceCode()` has
  // been invoked since this `AuthService` was constructed, which lets
  // `handleCallback` distinguish a cold-start replay (no local attempt) from a
  // stale callback that belongs to a superseded / already-consumed attempt.
  private nextEpoch: number = 0;
  // The single in-flight sign-in attempt (redirect or device), or null when no
  // attempt is live. Replaces the scalar `activeOAuthEpoch`: completion is now
  // tracked BY SOURCE, so a redirect deep-link can only finalize a `redirect`
  // attempt and a device poll result can only finalize a `device` attempt. The
  // in-flight PKCE verifier (redirect) and main-process poll handle (device)
  // live on the attempt so superseding it cleans both up. Set before the shell
  // is asked to launch the browser / start the device poll; cleared by a
  // matching finalizer, by `handleAttemptTimeout`, or by launch failure so the
  // same attempt cannot be resurrected by a stale replay.
  private activeAttempt: Attempt | null = null;
  // Projected device-flow progress (null unless a device attempt is in flight).
  private deviceProgress: DeviceFlowProgress | null = null;
  private readonly deviceProgressListeners =
    new Set<DeviceFlowProgressListener>();

  private static readonly scheduleTimeout: (
    handler: () => void,
    ms: number,
  ) => number = (handler, ms) => window.setTimeout(handler, ms);

  private static readonly cancelTimeout: (handle: number) => void = (handle) =>
    window.clearTimeout(handle);
  // True while `start()` is awaiting `tokenStore.load()`. Any replayed auth
  // callback or sign-in timeout that fires during this window must be treated
  // as authoritative over the persisted-token rehydration that runs after the
  // load resolves.
  private starting: boolean = false;
  // Set when a callback (`{ token }` or `{ error }`) or the sign-in timeout
  // has deterministically decided the auth state during `start()`. When true,
  // `start()` skips its "rehydrate persisted token" branch so a stale token
  // cannot resurrect signed-in state after a failure has already projected
  // signed-out.
  private authResolvedDuringStart: boolean = false;

  constructor(options: AuthServiceOptions) {
    this.runnerHost = options.runnerHost;
    this.tokenStore = new AuthTokenStore(options.runnerHost.tokenStore);
    this.contextProvider = new DefaultRequestContextProvider({
      origin: "renderer",
    });
    const initialAuth = useAuthStore.getState();
    this.lastEmittedStatus = initialAuth.status;
    // Watch the public auth store ONLY to relay status transitions to
    // `onChange` listeners. The store no longer carries a bearer token, so
    // there is nothing to reconcile here - cross-window projection lands
    // through `ingestProjectedSessionSnapshot` (the explicit persistence
    // boundary) instead of via store mutations.
    this.authStoreUnsubscribe = useAuthStore.subscribe((state) => {
      this.emit(state.status);
    });
  }

  /**
   * Cross-window projection inbound entry point used by the desktop windows
   * bridge. Each sibling window writes its persisted-session snapshot into
   * the desktop bridge; the receiving `AuthService` ingests the snapshot
   * here so the local `RequestContext` is minted/aborted to match.
   *
   * Re-validates the bearer through AuthnV3 because the bridge persists only
   * the narrow profile - `RequestContext` minting needs the full
   * `AuthenticatedUser` to keep identity shape consistent with host-minted
   * contexts. A `network-error` or `rejected` outcome is silent: the source
   * window already validated end-to-end, so a transient outage on this side
   * must not log the user out.
   */
  // Linear guard sequence (disposed / outcome kinds / identity validation);
  // each branch is an independent gate, not reducible nesting.
  // eslint-disable-next-line complexity
  async ingestProjectedSessionSnapshot(
    snapshot: AuthSessionSnapshot,
  ): Promise<void> {
    if (this.isDisposed()) {
      return;
    }
    if (snapshot.status === "signing-in") {
      if (useAuthStore.getState().status !== "signing-in") {
        useAuthStore.getState().setSigningIn();
      }
      return;
    }
    if (snapshot.status === "signed-out") {
      if (
        this.contextProvider.current() !== null ||
        this.currentBearer !== null ||
        useAuthStore.getState().status !== "signed-out"
      ) {
        this.applySignedOut();
      }
      return;
    }
    if (snapshot.token === null || snapshot.profile === null) {
      return;
    }
    const inboundToken = snapshot.token;
    if (inboundToken === this.currentBearer) {
      return;
    }
    // The refresh token (if any) lives in the shared store, not the cross-window
    // snapshot; load it so a refresh during this validate can still rotate.
    const storedForExternal = await this.tokenStore.load();
    const outcome = await this.validateToken(
      inboundToken,
      storedForExternal?.refreshToken ?? "",
    );
    if (this.isDisposed()) {
      return;
    }

    if (outcome.kind !== "valid") {
      return;
    }

    const accepted = this.acceptedToken(outcome, {
      token: inboundToken,
      refreshToken: storedForExternal?.refreshToken ?? "",
    });

    this.applySignedIn(accepted.token, outcome.user, snapshot.profile);
  }

  async start(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.starting = true;
    this.authResolvedDuringStart = false;
    // Subscribe to auth callbacks BEFORE awaiting the token load so a
    // shell-delivered callback that arrives during the `tokenStore.load()`
    // microtask is not missed. Replay-safe runner hosts (desktop preload,
    // mobile app-url listener) will deliver the most recent cached result
    // synchronously on subscribe.
    this.callbackDisposable = this.runnerHost.onAuthCallback((result) => {
      this.handleCallback(result);
    });

    try {
      const stored = await this.tokenStore.load();
      if (this.shouldStopStartFlow()) {
        return;
      }
      if (stored === null || stored.token.length === 0) {
        return;
      }

      const outcome = await this.validateToken(
        stored.token,
        stored.refreshToken,
      );
      if (this.shouldStopStartFlow()) {
        return;
      }
      if (outcome.kind === "valid") {
        const accepted = this.acceptedToken(outcome, stored);
        if (accepted.token !== stored.token) {
          await this.tokenStore.save(accepted);
          if (this.shouldStopStartFlow()) {
            return;
          }
        }
        this.applySignedIn(accepted.token, outcome.user, undefined);
        return;
      }
      await this.clearStoredAuthForStart();
      if (this.shouldStopStartFlow()) {
        return;
      }
      this.setLastError(AUTH_ERROR_SESSION_EXPIRED);
      this.applySignedOut();
    } finally {
      this.starting = false;
    }
  }

  private shouldStopStartFlow(): boolean {
    return this.disposed || this.authResolvedDuringStart;
  }

  private isDisposed(): boolean {
    return this.disposed;
  }

  async signIn(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.setLastError(null);
    // Begin a fresh `redirect` attempt. `beginAttempt` first supersedes any
    // in-flight attempt (a stalled redirect retry, OR a device attempt the user
    // is abandoning): it aborts that attempt, drops its persisted PKCE verifier,
    // and cancels its main-process device poll. After this, any shell-delivered
    // callback is unambiguously part of THIS attempt; a stale device poll
    // resolving later is dropped by source/epoch.
    const attempt = this.beginAttempt("redirect");
    useAuthStore.getState().setSigningIn();
    // Redirect timeout is the fixed `AUTH_CALLBACK_TIMEOUT_MS`; the handler is
    // epoch+kind-scoped so a later device attempt's timer can't kill it (F8).
    this.scheduleAttemptTimeout(
      attempt.epoch,
      "redirect",
      AUTH_CALLBACK_TIMEOUT_MS,
    );
    // Close the previous attempt window before asking the shell to launch the
    // external sign-in surface. After this call, any shell-delivered auth
    // callback is unambiguously part of the new attempt, so the runner host
    // can deterministically distinguish a stale OS-level replay of the
    // previous attempt from a genuine retry callback without a timing window.
    this.runnerHost.beginAuthAttempt();
    // PKCE: generate a fresh verifier, keep it on the attempt for the callback
    // exchange, and send only its S256 challenge in the sign-in URL so the
    // redirect carries a code (not tokens) the interceptor can't redeem.
    const verifier = generateCodeVerifier();
    attempt.redirectVerifier = verifier;
    // Mirror to secure storage before launching the browser so a callback that
    // arrives after a process restart can still recover the verifier. Persist
    // failures are non-fatal: the in-memory copy still serves the same-process
    // callback, so we degrade rather than block sign-in.
    await this.runnerHost.secureStorage
      .set(PKCE_VERIFIER_STORAGE_KEY, verifier)
      .catch(() => {});
    try {
      const signInUrl = new URL(this.runnerHost.signInUrl);
      signInUrl.searchParams.set(
        "code_challenge",
        await deriveCodeChallenge(verifier),
      );
      signInUrl.searchParams.set(
        "code_challenge_method",
        CODE_CHALLENGE_METHOD,
      );
      await this.runnerHost.openExternalLink(signInUrl.toString());
    } catch {
      // The shell could not open the external sign-in URL. No callback will
      // arrive, so cancel the pending callback timeout and fail immediately
      // through the same path shell-delivered failures use. This keeps the
      // UI's visible retry CTA consistent with every other failure mode.
      this.clearPendingTimeout();
      if (this.activeAttempt === attempt) {
        this.activeAttempt = null;
      }
      if (this.starting) {
        this.authResolvedDuringStart = true;
      }
      await this.applyFailure(AUTH_ERROR_LAUNCH_FAILED);
    }
  }

  /**
   * Device-flow fallback (RFC 8628). Supersedes any in-flight redirect attempt
   * - aborting it and dropping its PKCE verifier, so a late redirect deep-link
   * is dropped BY SOURCE - and starts a fresh `device` attempt whose
   * authorize + poll loop runs in the shell's privileged process (CORS-safe,
   * survives renderer close/sleep). The terminal outcome arrives via
   * `session.onResult` and converges on the SAME `applyTokenInternal` tail.
   */
  async signInWithDeviceCode(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.setLastError(null);
    const attempt = this.beginAttempt("device");
    useAuthStore.getState().setSigningIn();
    this.runnerHost.beginAuthAttempt();
    const session = await this.runnerHost.deviceFlow.start();
    if (this.isDisposed()) {
      session?.cancel();
      return;
    }
    // A newer attempt may have superseded this one while `/device/authorize`
    // was in flight - drop the session rather than adopt it.
    if (this.activeAttempt !== attempt) {
      session?.cancel();
      return;
    }
    if (session === null) {
      // `/device/authorize` failed (network/5xx) or the shell has no device
      // backend. Fail like a launch failure so the UI shows a retry CTA.
      this.activeAttempt = null;
      if (this.starting) {
        this.authResolvedDuringStart = true;
      }
      await this.applyFailure(AUTH_ERROR_LAUNCH_FAILED);
      return;
    }
    attempt.deviceSession = session;
    const authorization = session.authorization;
    this.setDeviceProgress({
      userCode: authorization.userCode,
      verificationUri: authorization.verificationUri,
      verificationUriComplete: authorization.verificationUriComplete,
      expiresAtMs: Date.now() + authorization.expiresInSeconds * 1000,
    });
    // Device timeout is the `device_code` TTL; epoch+kind-scoped so a redirect
    // attempt started afterwards is unaffected, and vice versa (F8). This is a
    // backstop - the controller also emits a terminal `expired` at the TTL.
    this.scheduleAttemptTimeout(
      attempt.epoch,
      "device",
      authorization.expiresInSeconds * 1000,
    );
    // Best-effort: open the pre-filled verification page so the user does not
    // have to type the code. Failure is non-fatal (the code + URI are shown).
    void this.runnerHost
      .openExternalLink(authorization.verificationUriComplete)
      .catch(() => {});
    session.onResult((result) => {
      void this.finalizeDeviceResult(result, attempt.epoch);
    });
  }

  async signOut(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.clearPendingTimeout();
    // Tear down any in-flight attempt: abort it, drop its persisted verifier,
    // and cancel its main-process device poll so no 10-minute poll leaks.
    this.discardActiveAttempt();
    await this.clearStoredAuth();
    this.setLastError(null);
    this.applySignedOut();
  }

  /**
   * Returns the `RequestContextProvider` boundary surface host / runtime
   * consumers subscribe to. The provider's `current()` always reflects the
   * live authenticated context (or `null` when signed out), and
   * `onChange(...)` fires on every identity transition (sign-in / sign-out /
   * cross-user). Same-user refresh rotates the existing context's lease in
   * place and is observably silent on the provider - the rotated bearer is
   * picked up on the next `ctx.credentials.getBearerToken()` extraction.
   */
  getRequestContextProvider(): RequestContextProvider {
    return this.contextProvider;
  }

  /**
   * Returns the current persisted-session snapshot for cross-window
   * projection callers (windows-bridge). This is a persistence boundary -
   * host / runtime consumers must NOT read the bearer here; they thread
   * the `RequestContext` from `getRequestContextProvider()`.
   */
  getCurrentSessionSnapshot(): AuthSessionSnapshot {
    const state = useAuthStore.getState();
    return {
      status: state.status,
      token: this.currentBearer,
      profile: this.currentProfile,
      contextMetadata: state.contextMetadata,
    };
  }

  /**
   * Subscribes to session-snapshot transitions for cross-window projection
   * callers. The handler is invoked synchronously on subscribe with the
   * current snapshot (matching the `IRunnerHost.onLocalHostChange`
   * convention) and again on every signed-in / signing-in / signed-out
   * transition. Same-user refresh fires once with the rotated bearer so the
   * desktop windows bridge keeps its persisted snapshot up-to-date.
   */
  onSessionSnapshotChange(handler: AuthSessionSnapshotListener): Disposable {
    this.sessionSnapshotListeners.add(handler);
    handler(this.getCurrentSessionSnapshot());
    return {
      dispose: () => {
        this.sessionSnapshotListeners.delete(handler);
      },
    };
  }

  /**
   * Cross-window projection inbound entry point. Called by the desktop
   * windows bridge when another window's `AuthService` projects a session
   * change through the desktop session bridge. Skips re-validation because
   * the source window already validated the bearer end-to-end through the
   * AuthnV3 boundary; we only re-mint the local context so this window's
   * host-runtime, providers, and store land on the same identity.
   *
   * If the inbound session matches the current local identity (same userId)
   * AND the bearer differs, the call rotates the existing context's
   * credential lease in place - observably silent on the provider but
   * visible to persistence subscribers via `onSessionSnapshotChange`.
   */
  applyExternalSession(session: ExternalSession): void {
    if (this.disposed) {
      return;
    }
    if (session.status === "signing-in") {
      useAuthStore.getState().setSigningIn();
      return;
    }
    if (session.status === "signed-out") {
      this.applySignedOut();
      return;
    }
    const currentUserId = this.contextProvider.current()?.identity.userId;
    if (
      currentUserId !== undefined &&
      currentUserId === session.user.user.id &&
      this.currentBearer !== session.token
    ) {
      this.contextProvider.rotateCurrentBearer({
        userId: currentUserId,
        bearerToken: session.token,
      });
      this.currentBearer = session.token;
      this.currentProfile = session.profile;
      const contextMetadata =
        useAuthStore.getState().contextMetadata ??
        this.contextMetadataFromUser(session.user);
      useAuthStore
        .getState()
        .setSignedIn(
          session.profile,
          contextMetadata,
          projectShareableTeams(session.user),
        );
      useAuthStore
        .getState()
        .setSubscriptionStatus(
          session.user.userSubscription.subscriptionStatus,
        );
      this.emitSessionSnapshot();
      return;
    }
    this.applySignedIn(session.token, session.user, session.profile);
  }

  /**
   * Re-validates the current authenticated session against AuthnV3.
   *
   * Same as `revalidateCurrentToken` semantics from the legacy raw-token
   * surface, but operates on the active `RequestContext` boundary:
   *
   *   - `valid` (no refresh)  → no-op; the lease keeps its bearer.
   *   - `valid` with refresh  → rotates the existing context's credential
   *                             lease in place (observably silent on the
   *                             provider's `onChange`), persists the new
   *                             token, and emits a session snapshot for
   *                             persistence callers.
   *   - `rejected`            → aborts the current context, clears the
   *                             persisted bearer, surfaces
   *                             `AUTH_ERROR_SESSION_EXPIRED`, and projects
   *                             signed-out.
   *   - `network-error`       → leaves auth state untouched; a transient
   *                             outage must not log the user out.
   *
   * No-op when the user is not currently signed-in.
   */
  async revalidateCurrentContext(): Promise<ValidationOutcome | null> {
    if (this.currentRevalidation !== null) {
      return this.currentRevalidation;
    }
    const revalidation = this.revalidateCurrentContextOnce().finally(() => {
      if (this.currentRevalidation === revalidation) {
        this.currentRevalidation = null;
      }
    });
    this.currentRevalidation = revalidation;
    return revalidation;
  }

  /**
   * Fetches the full `AuthenticatedUser` (identity + credits + team
   * subscriptions) for the signed-in session by revalidating the current
   * context against AuthnV3's `/api/v3/user`. Returns `null` when signed-out
   * or when validation does not yield a user (`rejected` / no live context).
   * Throws on `network-error` so a transient outage surfaces as a retryable
   * query error instead of a misleading "no subscription" empty state.
   *
   * The Settings subscription panel consumes this through TanStack Query so
   * credits live only in the query cache - never duplicated into the store.
   */
  async fetchAuthenticatedUser(): Promise<AuthenticatedUser | null> {
    const outcome = await this.revalidateCurrentContext();
    // `null` (no live context) or `rejected` (revalidate already signed out) →
    // no user; the panel renders its signed-out/empty state, not an error.
    if (outcome === null || outcome.kind === "rejected") {
      return null;
    }
    if (outcome.kind === "valid") {
      return outcome.user;
    }
    // `network-error`: a transient outage that did NOT sign the user out. Throw
    // so TanStack Query surfaces a retryable error on the panel (refresh button)
    // instead of a misleading "no subscription" empty state.
    throw new Error("Couldn't reach Traycer to load your subscription.");
  }

  private async revalidateCurrentContextOnce(): Promise<ValidationOutcome | null> {
    if (this.isDisposed()) {
      return null;
    }
    const ctx = this.contextProvider.current();
    if (ctx === null || this.currentBearer === null) {
      return null;
    }
    const currentUserId = ctx.identity.userId;
    const currentToken = this.currentBearer;
    // The refresh token pairs with the bearer in the store, not the live lease.
    const storedForRevalidate = await this.tokenStore.load();
    const fallbackRefreshToken = storedForRevalidate?.refreshToken ?? "";
    const outcome = await this.validateToken(
      currentToken,
      fallbackRefreshToken,
    );
    if (this.isDisposed()) {
      return null;
    }

    if (outcome.kind === "valid") {
      const accepted = this.acceptedToken(outcome, {
        token: currentToken,
        refreshToken: fallbackRefreshToken,
      });
      if (outcome.user.user.id !== currentUserId) {
        // The bearer revalidates to a different user - treat as a fresh
        // sign-in so the cross-user path aborts the old context cleanly.
        await this.tokenStore.save(accepted);
        if (this.isDisposed()) {
          return null;
        }
        this.applySignedIn(accepted.token, outcome.user, undefined);
        return outcome;
      }
      if (accepted.token !== currentToken) {
        // Same shared persist-then-rotate step the CLI uses: write the rotated
        // bearer, then rotate the live credential lease in place (observably
        // silent on the provider, so host-runtime / cache state survives).
        //
        // The `rotate` callback re-checks `isDisposed()` because `persist` is an
        // async IPC save: a sign-out / unmount can dispose the provider while it
        // is in flight, and `contextProvider.rotateCurrentBearer` throws on a
        // disposed provider. Skipping the rotate (and the post-check returning
        // null) preserves the pre-refactor "graceful no-op on teardown" behavior
        // without leaking disposal awareness into the shared helper.
        await rotateAndPersistBearer({
          newTokens: accepted,
          persist: (tokens) => this.tokenStore.save(tokens),
          rotate: (token) => {
            if (this.isDisposed()) {
              return;
            }
            this.contextProvider.rotateCurrentBearer({
              userId: currentUserId,
              bearerToken: token,
            });
          },
        });
        if (this.isDisposed()) {
          return null;
        }
        this.currentBearer = accepted.token;
        const profile =
          this.currentProfile ?? this.profileFromUser(outcome.user);
        const contextMetadata =
          useAuthStore.getState().contextMetadata ??
          this.contextMetadataFromUser(outcome.user);
        useAuthStore
          .getState()
          .setSignedIn(
            profile,
            contextMetadata,
            projectShareableTeams(outcome.user),
          );
        useAuthStore
          .getState()
          .setSubscriptionStatus(
            outcome.user.userSubscription.subscriptionStatus,
          );
        this.currentProfile = profile;
        this.emitSessionSnapshot();
      }
      return outcome;
    }
    if (outcome.kind === "rejected") {
      await this.clearStoredAuth();
      this.setLastError(AUTH_ERROR_SESSION_EXPIRED);
      this.applySignedOut();
    }
    return outcome;
  }

  /**
   * OAuth-callback entrypoint. Invoked from `handleCallback` when the shell
   * delivers an `{ token }` result. A `rejected` or `network-error`
   * validation outcome surfaces `AUTH_ERROR_SIGN_IN_FAILED` so the header
   * sign-in surface renders "Sign-in failed - please try again" instead of
   * the "Session expired" copy that belongs to the rehydration path.
   *
   * The callback is only applied if the attempt it belongs to is still the
   * active one. A callback captured for epoch `E` is dropped silently if the
   * active attempt has been replaced by a new `signIn()` /
   * `signInWithDeviceCode()` between dispatch and final projection.
   */
  /**
   * Exchanges the one-time PKCE `code` from the sign-in callback for the token
   * pair (via the runner-host boundary, so desktop renderer CORS is bypassed),
   * then applies it like any other callback token. A missing verifier (a code
   * with no matching in-process attempt, e.g. a cold-start replay) or a failed
   * exchange surfaces `AUTH_ERROR_SIGN_IN_FAILED` through the same stale-epoch-
   * safe error path callback tokens use.
   */
  private async exchangeAndApplyCode(
    code: string,
    verifier: string | null,
    expectedEpoch: number | null,
  ): Promise<void> {
    // Same-process callbacks carry the verifier directly; a cold-start replay
    // (no in-process attempt) recovers it from secure storage.
    const resolvedVerifier =
      verifier ??
      (await this.runnerHost.secureStorage
        .get(PKCE_VERIFIER_STORAGE_KEY)
        .catch(() => null));
    if (resolvedVerifier === null) {
      // No in-process attempt (cold-start callback) and nothing in secure
      // storage to recover - the code can't be exchanged. Warn so the failure
      // is visible in the shipped app log (renderer console is forwarded to the
      // file on warning/error) rather than only manifesting as "Sign-in failed".
      console.warn(
        "[auth] sign-in failed: PKCE code verifier missing (cold-start callback with no recoverable verifier)",
      );
      await this.applyOAuthCallbackError(
        AUTH_ERROR_SIGN_IN_FAILED,
        expectedEpoch,
      );
      return;
    }
    // The code is one-time and consumed atomically server-side, so the verifier
    // is spent the moment we attempt the exchange - drop the persisted copy and
    // clear it off the attempt up front so it can never be replayed, regardless
    // of the exchange outcome.
    this.dropPersistedVerifier();
    if (this.activeAttempt?.epoch === expectedEpoch) {
      this.activeAttempt.redirectVerifier = null;
    }
    const tokens = await this.runnerHost.exchangeAuthCode(
      code,
      resolvedVerifier,
    );
    if (this.isDisposed()) {
      return;
    }
    if (tokens === null) {
      await this.applyOAuthCallbackError(
        AUTH_ERROR_SIGN_IN_FAILED,
        expectedEpoch,
      );
      return;
    }
    await this.applyTokenInternal(
      tokens.token,
      tokens.refreshToken,
      expectedEpoch,
    );
  }

  private async applyTokenInternal(
    token: string,
    refreshToken: string,
    expectedOAuthEpoch: number | null,
  ): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    if (token.length === 0) {
      if (!this.isAttemptCurrent(expectedOAuthEpoch)) {
        return false;
      }
      this.clearPendingTimeout();
      this.activeAttempt = null;
      await this.applyFailure(AUTH_ERROR_SIGN_IN_FAILED);
      return false;
    }
    if (!this.isAttemptCurrent(expectedOAuthEpoch)) {
      return false;
    }
    this.clearPendingTimeout();
    const outcome = await this.validateToken(token, refreshToken);
    if (this.isDisposed()) {
      return false;
    }

    // After the async validation, the state machine may have moved on: a
    // fresh `signIn()` / `signInWithDeviceCode()` could have minted a new
    // attempt. In that case this callback is stale and must not mutate state.
    if (!this.isAttemptCurrent(expectedOAuthEpoch)) {
      return false;
    }
    if (outcome.kind === "valid") {
      // Consume the attempt so a subsequent cached replay (e.g. desktop
      // preload re-emitting `cachedAuthCallback` on re-subscribe) cannot
      // re-apply the same callback.
      this.activeAttempt = null;
      const accepted = this.acceptedToken(outcome, { token, refreshToken });
      await this.tokenStore.save(accepted);
      if (this.isDisposed()) {
        return false;
      }

      // Provision the machine-local credentials file the host's owner gate
      // reads, BEFORE flipping to signed-in (which enables host RPCs). On a
      // brand-new sign-in the file does not exist yet, and the host denies
      // every authenticated connection until it does - seeding it up front
      // closes the race where early RPCs are rejected as UNAUTHORIZED, which
      // would burn single-use refresh tokens and can trip a refresh-reuse
      // sign-out. No-op on shells without a local CLI.
      await this.ensureLocalProvisioning(accepted.token, accepted.refreshToken);
      if (this.isDisposed()) {
        return false;
      }

      this.setLastError(null);
      this.applySignedIn(accepted.token, outcome.user, undefined);
      return true;
    }
    // Validation `rejected` OR `network-error`: do not persist. Surface
    // `sign-in-failed` so the header sign-in surface renders a retry CTA.
    this.activeAttempt = null;
    await this.applyFailure(AUTH_ERROR_SIGN_IN_FAILED);
    return false;
  }

  /**
   * Device-flow terminal finalizer. Applies a device poll outcome ONLY if the
   * live attempt is still the `device` attempt with this epoch - so a result
   * for a superseded attempt, or one arriving after a redirect already won
   * (active attempt is now `redirect`, or null), is dropped BY SOURCE. The
   * `authorized` path converges on the SAME `applyTokenInternal` tail the
   * redirect path uses; terminal failures surface a kind-specific error.
   */
  private async finalizeDeviceResult(
    result: DeviceFlowResult,
    expectedEpoch: number,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    const attempt = this.activeAttempt;
    if (
      attempt === null ||
      attempt.kind !== "device" ||
      attempt.epoch !== expectedEpoch
    ) {
      return;
    }
    if (result.kind === "authorized") {
      await this.applyTokenInternal(
        result.token,
        result.refreshToken,
        expectedEpoch,
      );
      return;
    }
    // Terminal device failure (denied / expired / unrecoverable error).
    this.clearPendingTimeout();
    this.activeAttempt = null;
    if (this.starting) {
      this.authResolvedDuringStart = true;
    }
    await this.applyFailure(deviceFailureError(result));
  }

  /**
   * Writes the machine-local credentials file the host reads to pin its owner
   * (the owner-binding gate), BEFORE we transition to signed-in. The host
   * denies every authenticated connection until that file exists, so seeding it
   * here - rather than relying on the best-effort `CliCredentialSeeder` that
   * reacts AFTER sign-in - removes the first-sign-in race. No-ops on shells
   * without a local CLI (mobile / web / tests).
   *
   * Best-effort with a few quick retries: a transient CLI-spawn failure must
   * not wedge sign-in, so once the retries are exhausted we proceed anyway. The
   * host then simply stays unreachable (surfaced by the host gate) until a
   * later re-seed succeeds, instead of blocking the UI indefinitely.
   */
  private async ensureLocalProvisioning(
    token: string,
    refreshToken: string,
  ): Promise<void> {
    const cli = this.runnerHost.traycerCli;
    if (cli === null) {
      return;
    }
    await this.retryLocalCredentialCommand(
      () => cli.cliLogin(token, refreshToken),
      "[auth] local credential provisioning failed; the host may be " +
        "unreachable until the next token refresh",
      1,
    );
  }

  private async clearStoredAuth(): Promise<void> {
    await this.tokenStore.clear();
    await this.ensureLocalDeprovisioning();
  }

  private async clearStoredAuthForStart(): Promise<void> {
    if (this.shouldStopStartFlow()) {
      return;
    }
    await this.tokenStore.clear();
    if (this.shouldStopStartFlow()) {
      return;
    }
    await this.ensureLocalDeprovisioning();
  }

  /**
   * Deprovisions the machine-local CLI credentials so the host's owner gate
   * falls back to deny-by-default. Best-effort with the same retry profile as
   * provisioning: sign-out must not wedge on transient CLI-spawn failures, but a
   * short retry avoids leaving the host bound to the prior owner unnecessarily.
   */
  private async ensureLocalDeprovisioning(): Promise<void> {
    const cli = this.runnerHost.traycerCli;
    if (cli === null) {
      return;
    }
    await this.retryLocalCredentialCommand(
      () => cli.cliLogout(),
      "[auth] local credential deprovisioning failed; the host may " +
        "remain bound to the prior owner until its credentials are cleared",
      1,
    );
  }

  private async retryLocalCredentialCommand(
    run: () => Promise<void>,
    warningMessage: string,
    attempt: number,
  ): Promise<void> {
    const maxAttempts = 3;
    const failure = await run()
      .then(() => null)
      .catch((error: unknown) => error);
    if (failure === null) {
      return;
    }
    if (attempt === maxAttempts) {
      // Deliberately omit the raw rejection value: a CLI-spawn failure can
      // carry stderr / request context that may include auth material.
      console.warn(warningMessage);
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, attempt * 200));
    return this.retryLocalCredentialCommand(run, warningMessage, attempt + 1);
  }

  /**
   * Epoch-currency check used by async finalization paths. Returns true iff
   * the captured epoch still matches the live attempt's epoch. Cold-start
   * replay (no attempt ever started) captures `null` and expects `null`; an
   * in-flight attempt captures a number and expects that same number. Because
   * epochs are globally unique, matching the epoch also pins the attempt's
   * kind, so callers that already gated on kind (the device finalizer) and
   * callers that don't (the shared `applyTokenInternal` tail) are both safe.
   */
  private isAttemptCurrent(expectedEpoch: number | null): boolean {
    return (this.activeAttempt?.epoch ?? null) === expectedEpoch;
  }

  /**
   * Supersedes (or tears down) the live attempt: aborts its controller so an
   * in-flight device poll/fetch is discarded, drops its persisted PKCE verifier
   * so a stale redirect callback can't replay it, and cancels its main-process
   * device poll so no 10-minute poll leaks. Leaves `activeAttempt === null`.
   */
  private discardActiveAttempt(): void {
    const attempt = this.activeAttempt;
    if (attempt === null) {
      return;
    }
    attempt.abortController.abort();
    attempt.redirectVerifier = null;
    if (attempt.deviceSession !== null) {
      attempt.deviceSession.cancel();
    }
    this.dropPersistedVerifier();
    this.setDeviceProgress(null);
    this.activeAttempt = null;
  }

  /**
   * Discards the current attempt (see `discardActiveAttempt`) and starts a new
   * one of the given kind with a fresh, globally-unique epoch.
   */
  private beginAttempt(kind: AttemptKind): Attempt {
    this.clearPendingTimeout();
    this.discardActiveAttempt();
    const epoch = ++this.nextEpoch;
    const attempt: Attempt = {
      epoch,
      kind,
      abortController: new AbortController(),
      redirectVerifier: null,
      deviceSession: null,
    };
    this.activeAttempt = attempt;
    return attempt;
  }

  onChange(listener: AuthListener): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  onErrorChange(handler: AuthErrorListener): Disposable {
    this.errorListeners.add(handler);
    return {
      dispose: () => {
        this.errorListeners.delete(handler);
      },
    };
  }

  getStatus(): AuthStatus {
    return useAuthStore.getState().status;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  clearLastError(): void {
    this.setLastError(null);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearPendingTimeout();
    // Tear down any in-flight attempt so a device poll loop in the shell's main
    // process doesn't keep running after this service is gone.
    if (this.activeAttempt !== null) {
      this.activeAttempt.abortController.abort();
      this.activeAttempt.deviceSession?.cancel();
      this.activeAttempt = null;
    }
    if (this.callbackDisposable !== null) {
      this.callbackDisposable.dispose();
      this.callbackDisposable = null;
    }
    this.authStoreUnsubscribe();
    this.contextProvider.dispose();
    this.currentBearer = null;
    this.currentProfile = null;
    this.listeners.clear();
    this.errorListeners.clear();
    this.sessionSnapshotListeners.clear();
    this.deviceProgressListeners.clear();
  }

  private handleCallback(result: AuthCallbackResult): void {
    if (this.disposed) {
      return;
    }
    const attempt = this.activeAttempt;
    // Source-aware gating (F2). A deep-link callback belongs to the REDIRECT
    // completion channel:
    //   - If an attempt has been started locally (`nextEpoch > 0`): honor the
    //     callback only when the live attempt is a `redirect` attempt. A
    //     `device` attempt (`kind !== "redirect"`), or an already-consumed /
    //     terminated attempt (`attempt === null`), drops the callback BY SOURCE
    //     - it neither hijacks nor signs out the device attempt.
    //   - If no attempt was ever started (`nextEpoch === 0`): a cold-start
    //     cached replay still flows through (`attempt === null`, expected epoch
    //     `null`) so a completed handshake from a prior process can hydrate
    //     signed-in state on the next launch.
    if (
      this.nextEpoch > 0 &&
      (attempt === null || attempt.kind !== "redirect")
    ) {
      return;
    }
    const callbackEpoch = attempt?.epoch ?? null;
    if ("code" in result) {
      if (result.code.length === 0) {
        return;
      }
      this.clearPendingTimeout();
      if (this.starting) {
        this.authResolvedDuringStart = true;
      }
      // Capture the verifier synchronously: a later retry would replace the
      // active attempt, and this callback must exchange against the verifier
      // from the attempt it belongs to.
      const verifier = attempt?.redirectVerifier ?? null;
      void this.exchangeAndApplyCode(result.code, verifier, callbackEpoch);
      return;
    }
    // Error path: clear any persisted token and return to signed-out so
    // the sign-in button can be pressed again. Shell-provided error
    // message is retained for diagnostic surfaces.
    this.clearPendingTimeout();
    if (this.starting) {
      this.authResolvedDuringStart = true;
    }
    void this.applyOAuthCallbackError(result.error, callbackEpoch);
  }

  /**
   * Error-callback finalizer. Separate from `applyFailure` so it can re-check
   * the OAuth epoch after any awaited work and silently drop stale errors
   * (e.g. a `user_cancelled` replay after a superseding pasted session).
   */
  private async applyOAuthCallbackError(
    error: string,
    expectedEpoch: number | null,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.isAttemptCurrent(expectedEpoch)) {
      return;
    }
    this.activeAttempt = null;
    // The attempt is ending in failure; drop any persisted verifier so a later
    // replay can't resurrect it. (Stale errors returned above, so this only
    // fires for the attempt that genuinely owns the verifier.)
    this.dropPersistedVerifier();
    await this.applyFailure(error);
  }

  /**
   * Epoch+kind-scoped attempt timeout (F8). Fires the failure ONLY when the
   * live attempt is still the exact attempt the timer was scheduled for - same
   * epoch AND same kind - so a stray timer from a superseded attempt can never
   * kill a newer one (e.g. a redirect timer firing after the user switched to a
   * device attempt, or a device timer firing after a redirect succeeded).
   * Redirect attempts time out after `AUTH_CALLBACK_TIMEOUT_MS`; device
   * attempts time out after the `device_code` TTL (`expires_in`).
   */
  private handleAttemptTimeout(epoch: number, kind: AttemptKind): void {
    if (this.disposed) {
      return;
    }
    this.pendingTimeoutHandle = null;
    const attempt = this.activeAttempt;
    if (attempt === null || attempt.epoch !== epoch || attempt.kind !== kind) {
      return;
    }
    if (useAuthStore.getState().status !== "signing-in") {
      return;
    }
    attempt.deviceSession?.cancel();
    this.activeAttempt = null;
    this.dropPersistedVerifier();
    this.setDeviceProgress(null);
    if (this.starting) {
      this.authResolvedDuringStart = true;
    }
    void this.applyFailure(
      kind === "device" ? AUTH_ERROR_DEVICE_EXPIRED : AUTH_ERROR_TIMEOUT,
    );
  }

  /**
   * Schedules the single in-flight attempt timer. Only one attempt is ever live
   * at a time, so a single handle suffices; the captured `epoch`/`kind` make
   * the handler a no-op if the attempt has been superseded by the time it
   * fires.
   */
  private scheduleAttemptTimeout(
    epoch: number,
    kind: AttemptKind,
    durationMs: number,
  ): void {
    this.clearPendingTimeout();
    this.pendingTimeoutHandle = AuthService.scheduleTimeout(() => {
      this.handleAttemptTimeout(epoch, kind);
    }, durationMs);
  }

  /**
   * Validates a bearer token against AuthnV3's `/api/v3/user` endpoint.
   *
   * Calls the runner-host full-identity validator so desktop validation runs
   * in Electron main instead of the CSP-constrained renderer. The `valid`
   * variant carries the complete `AuthenticatedUser` (not just the narrow
   * profile), which `RequestContext` minting needs so client-minted contexts
   * preserve the same identity shape that host-minted contexts already
   * carry.
   *
   * Refresh-on-401 behaviour is owned by the helper: a single refresh
   * attempt is made before a terminal `rejected` / `network-error` result
   * is returned, and a successful refresh is reported via `refreshedToken`.
   */
  private validateToken(
    token: string,
    refreshToken: string,
  ): Promise<ValidationOutcome> {
    return this.runnerHost.validateAuthTokenIdentity(token, refreshToken);
  }

  private acceptedToken(
    outcome: AuthIdentityValidResult,
    fallback: StoredAuthTokens,
  ): StoredAuthTokens {
    if ("refreshedToken" in outcome) {
      return {
        token: outcome.refreshedToken,
        refreshToken: outcome.refreshedRefreshToken,
      };
    }
    return fallback;
  }

  /**
   * Mints a fresh `RequestContext` for the validated identity AND projects
   * the corresponding signed-in state into the store + persistence
   * snapshot. The provider's `setSignedIn` aborts any previously-active
   * context (cross-user transition or same-user re-sign-in), so host /
   * runtime consumers see a single emit for the new identity.
   */
  private applySignedIn(
    bearerToken: string,
    user: AuthenticatedUser,
    profileOverride: AuthProfile | undefined,
  ): void {
    if (this.disposed) {
      return;
    }
    this.setDeviceProgress(null);
    this.contextProvider.setSignedIn({
      user,
      bearerToken,
      operationId: undefined,
      externalAbortSignal: undefined,
    });
    const profile = profileOverride ?? this.profileFromUser(user);
    const contextMetadata = this.contextMetadataFromUser(user);
    this.currentBearer = bearerToken;
    this.currentProfile = profile;
    useAuthStore
      .getState()
      .setSignedIn(profile, contextMetadata, projectShareableTeams(user));
    useAuthStore
      .getState()
      .setSubscriptionStatus(user.userSubscription.subscriptionStatus);
    this.emitSessionSnapshot();
  }

  /**
   * Aborts the live `RequestContext` (if any) and projects signed-out
   * state. Idempotent - a second call while already signed-out is a
   * no-op for the provider.
   */
  private applySignedOut(): void {
    if (this.disposed) {
      return;
    }
    this.setDeviceProgress(null);
    this.contextProvider.signOut();
    this.currentBearer = null;
    this.currentProfile = null;
    useAuthStore.getState().setSignedOut();
    this.emitSessionSnapshot();
  }

  /**
   * Projects the failure outcome and awaits the token clear so a stale
   * persisted token cannot survive the failure. `setSignedOut` + `emit` run
   * synchronously so UI updates immediately; the awaited `clear()` then runs
   * in the background to finish the storage cleanup.
   */
  private async applyFailure(error: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.setLastError(error);
    this.applySignedOut();
    await this.clearStoredAuth();
  }

  private profileFromUser(user: AuthenticatedUser): AuthProfile {
    return {
      userId: user.user.id,
      userName: user.user.name ?? user.user.providerHandle,
      email: user.user.email ?? "",
      avatarUrl: normalizeAvatarUrl(user.user.avatarUrl),
    };
  }

  private contextMetadataFromUser(
    user: AuthenticatedUser,
  ): AuthContextMetadata {
    return {
      userId: user.user.id,
      username: usernameFromAuthenticatedUser(user),
    };
  }

  private clearPendingTimeout(): void {
    if (this.pendingTimeoutHandle !== null) {
      AuthService.cancelTimeout(this.pendingTimeoutHandle);
      this.pendingTimeoutHandle = null;
    }
  }

  /**
   * Drops the persisted PKCE verifier from secure storage. Called when the
   * verifier is consumed (code exchange) or its attempt ends (timeout, error,
   * supersede, sign-out) so a spent/abandoned secret never lingers. The
   * in-memory copy lives on the attempt (`redirectVerifier`) and is dropped
   * with the attempt; this clears the cold-start-replay mirror. Best-effort.
   */
  private dropPersistedVerifier(): void {
    void this.runnerHost.secureStorage
      .delete(PKCE_VERIFIER_STORAGE_KEY)
      .catch(() => {});
  }

  /**
   * Subscribes to device-flow progress transitions (user code / verification
   * URIs / expiry). Fires synchronously on subscribe with the current value,
   * then on every change. `null` whenever no device attempt is in flight.
   */
  onDeviceProgressChange(handler: DeviceFlowProgressListener): Disposable {
    this.deviceProgressListeners.add(handler);
    handler(this.deviceProgress);
    return {
      dispose: () => {
        this.deviceProgressListeners.delete(handler);
      },
    };
  }

  getDeviceProgress(): DeviceFlowProgress | null {
    return this.deviceProgress;
  }

  private setDeviceProgress(next: DeviceFlowProgress | null): void {
    if (this.deviceProgress === next) {
      return;
    }
    this.deviceProgress = next;
    for (const handler of this.deviceProgressListeners) {
      handler(next);
    }
  }

  private setLastError(next: string | null): void {
    if (this.lastError === next) {
      return;
    }
    this.lastError = next;
    for (const handler of this.errorListeners) {
      handler(next);
    }
  }

  private emit(status: AuthStatus): void {
    if (this.lastEmittedStatus === status) {
      return;
    }
    this.lastEmittedStatus = status;
    for (const listener of this.listeners) {
      listener(status);
    }
  }

  private emitSessionSnapshot(): void {
    if (this.sessionSnapshotListeners.size === 0) {
      return;
    }
    const snapshot = this.getCurrentSessionSnapshot();
    for (const handler of this.sessionSnapshotListeners) {
      handler(snapshot);
    }
  }
}

/**
 * Maps a terminal (non-`authorized`) device-flow result to the stable error id
 * the device surface renders. `error` (invalid grant / exhausted retries) reuses
 * the generic sign-in-failed copy.
 */
function deviceFailureError(
  result: Exclude<DeviceFlowResult, { kind: "authorized" }>,
): string {
  switch (result.kind) {
    case "denied":
      return AUTH_ERROR_DEVICE_DENIED;
    case "expired":
      return AUTH_ERROR_DEVICE_EXPIRED;
    default:
      return AUTH_ERROR_SIGN_IN_FAILED;
  }
}

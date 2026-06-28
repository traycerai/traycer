import type {
  IRunnerHost,
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
  createProactiveRefreshScheduler,
  DEFAULT_REFRESH_LEAD_MS,
  DEFAULT_REFRESH_MIN_DELAY_MS,
  type ProactiveRefreshScheduler,
} from "@traycer-clients/shared/auth/token-refresh-scheduler";
import { usernameFromAuthenticatedUser } from "@traycer/protocol/auth/request-context";
import {
  useAuthStore,
  type AuthContextMetadata,
  type AuthProfile,
  type AuthStatus,
} from "@/stores/auth/auth-store";
import { normalizeAvatarUrl } from "@/lib/avatar-url";
import { projectShareableTeams } from "@/hooks/epic/use-epic-shareable-teams";
import { onWakeReconnect } from "@/lib/host/wake-reconnect";
import { appLogger, describeLogError } from "@/lib/logger";
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
 * Stable error identifier emitted when the device-authorization request itself
 * fails (network/5xx, or the shell has no device-flow backend) so no poll loop
 * ever starts. This must fail the flow immediately - there is no browser tab to
 * wait on - so the UI shows a retry CTA.
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

function classifyAuthFailureForLog(error: string): string {
  if (
    error === AUTH_ERROR_LAUNCH_FAILED ||
    error === AUTH_ERROR_SESSION_EXPIRED ||
    error === AUTH_ERROR_SIGN_IN_FAILED ||
    error === AUTH_ERROR_DEVICE_DENIED ||
    error === AUTH_ERROR_DEVICE_EXPIRED
  ) {
    return error;
  }
  return "external-callback-error";
}

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
 * Record of the single in-flight sign-in attempt. Device flow is now the only
 * interactive login, so there is one completion channel and one stale guard:
 * the monotonically-increasing `epoch`. A finalizer (the device poll result, or
 * the expiry timeout) only acts while `activeAttempt?.epoch` still matches the
 * epoch it captured, so a superseded attempt's late result is dropped. The
 * `abortController` is aborted on supersede/sign-out/dispose; `deviceSession` is
 * the main-process poll handle, cancelled on supersede so no ~10-minute poll
 * leaks and nudged (`pollNow`) on the browser-return signal.
 */
interface Attempt {
  readonly epoch: number;
  readonly abortController: AbortController;
  deviceSession: DeviceFlowSession | null;
  // Subscription to the device session's terminal result. Retained so it can be
  // disposed when the attempt is superseded, torn down, or finished - otherwise
  // the `onResult` closure (and the IPC listener behind it) leaks.
  resultDisposable: Disposable | null;
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
 * Interactive sign-in is the OAuth 2.0 Device Authorization Grant (RFC 8628):
 * `signIn()` opens the browser to the device-approval page and the shell's
 * main-process controller polls `/device/token`; the terminal `authorized`
 * result converges on the same `applyTokenInternal` tail as a rehydrated token.
 *
 * Two distinct failure paths drive distinct `lastError` codes so the UI
 * copy can match the flow the user was actually in:
 *
 *   1. `start()`-time stored-token rehydration failure →
 *      `AUTH_ERROR_SESSION_EXPIRED` ("Session expired - sign in again").
 *      The validation helper has already attempted refresh before
 *      returning a terminal failure, so startup clears the stored token
 *      and asks the user to sign in again.
 *   2. The device-flow poll path - a minted token that AuthnV3 then `rejected`
 *      (or a `network-error`) surfaces `AUTH_ERROR_SIGN_IN_FAILED` ("Sign-in
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
  // Single-flight guard for the proactive force-refresh path so the refresh
  // scheduler can't stack overlapping `/api/v3/auth/refresh` rotations.
  private currentForceRefresh: Promise<void> | null = null;
  // Proactively rotates the bearer shortly before its ~4h TTL so a long-open
  // session never carries a dead token into a live host call. Constructed in the
  // constructor; armed on every bearer (re)assignment, stopped on sign-out.
  private readonly refreshScheduler: ProactiveRefreshScheduler;
  // Teardown hooks for the OS-wake refresh listeners, released in `dispose()`.
  private readonly wakeDisposers: Array<() => void> = [];
  private disposed = false;
  // Monotonically increasing counter used to tag every sign-in attempt, so a
  // finalizer (device poll result / expiry timeout) can detect that a newer
  // `signIn()` has superseded the attempt it captured and drop its stale result.
  private nextEpoch: number = 0;
  // The single in-flight sign-in attempt, or null when no attempt is live. Holds
  // the main-process device poll handle so superseding the attempt cancels it.
  // Set before the shell is asked to start the device poll; cleared by a
  // matching finalizer, by `handleAttemptTimeout`, or by an authorize failure so
  // the same attempt cannot be resurrected by a stale result.
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
  // True while `start()` is awaiting `tokenStore.load()`. A device-flow result
  // or expiry that resolves during this window must be treated as authoritative
  // over the persisted-token rehydration that runs after the load resolves.
  private starting: boolean = false;
  // Set when a device-flow outcome (sign-in success or terminal failure) or the
  // expiry timeout has deterministically decided the auth state during
  // `start()`. When true, `start()` skips its "rehydrate persisted token" branch
  // so a stale token cannot resurrect signed-in state after a failure has
  // already projected signed-out.
  private authResolvedDuringStart: boolean = false;

  constructor(options: AuthServiceOptions) {
    this.runnerHost = options.runnerHost;
    this.tokenStore = new AuthTokenStore(options.runnerHost.tokenStore);
    this.contextProvider = new DefaultRequestContextProvider({
      origin: "renderer",
    });
    this.refreshScheduler = createProactiveRefreshScheduler<number>({
      getToken: () => this.currentBearer,
      revalidate: () => this.forceRefresh(),
      now: () => Date.now(),
      setTimer: (handler, ms) => AuthService.scheduleTimeout(handler, ms),
      clearTimer: (handle) => AuthService.cancelTimeout(handle),
      leadMs: DEFAULT_REFRESH_LEAD_MS,
      minDelayMs: DEFAULT_REFRESH_MIN_DELAY_MS,
      onDiagnostic: null,
    });
    this.installWakeRefreshListeners();
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
   * Refresh the bearer on device wake, since the scheduler's `setTimeout` is
   * frozen during sleep and would otherwise rot the token past its TTL. Mirrors
   * `subscribeStreamWakeReconnect`'s two triggers: `window 'online'` (network
   * back) and `onSystemResumed` (Electron resume). `notifyResumed` is a no-op
   * while signed out; the resume wiring is best-effort so it can't wedge
   * construction, leaving the `online` listener as the fallback.
   */
  private installWakeRefreshListeners(): void {
    this.wakeDisposers.push(
      onWakeReconnect(() => {
        this.refreshScheduler.notifyResumed();
      }),
    );
    try {
      const resume = this.runnerHost.onSystemResumed(() => {
        this.refreshScheduler.notifyResumed();
      });
      this.wakeDisposers.push(() => resume.dispose());
    } catch (error) {
      appLogger.warn("[auth] OS-resume wake refresh unavailable", {
        error: describeLogError(error),
      });
    }
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
    // Subscribe to the browser-return signal BEFORE awaiting the token load so a
    // shell-delivered nudge that arrives during the `tokenStore.load()` microtask
    // is not missed. The signal is payload-free - it only pokes an in-flight
    // device poll - so on a cold start with no live attempt it is a harmless
    // no-op.
    this.callbackDisposable = this.runnerHost.onAuthCallback(() => {
      this.handleReturnSignal();
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
      appLogger.warn("[auth] stored session validation failed during startup", {
        outcome: outcome.kind,
      });
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

  /**
   * Primary (and only) interactive sign-in: the OAuth 2.0 Device Authorization
   * Grant (RFC 8628). `beginAttempt` first supersedes any in-flight attempt (a
   * stalled retry the user is abandoning) - aborting it and cancelling its
   * main-process device poll - so a stale poll resolving later is dropped by
   * epoch. The shell's privileged process owns `/device/authorize` + the
   * `/device/token` poll loop (CORS-safe, survives renderer close/sleep); the
   * terminal `authorized` outcome arrives via `session.onResult` and converges
   * on the SAME `applyTokenInternal` tail a rehydrated token uses. Sign-in
   * completes from the poll alone - the browser-return deep link only nudges the
   * poll to fire sooner (see `handleReturnSignal`) and never delivers a token.
   */
  async signIn(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.setLastError(null);
    const attempt = this.beginAttempt();
    useAuthStore.getState().setSigningIn();
    this.runnerHost.beginAuthAttempt();
    let session: DeviceFlowSession | null;
    try {
      session = await this.runnerHost.deviceFlow.start();
    } catch {
      // A rejected `start()` (host/IPC failure) must route to the SAME
      // launch-failed cleanup as a `null` return - otherwise the UI stays stuck
      // in `signing-in` with a live attempt that never settles. Guard on the
      // attempt still being current so a superseded/disposed attempt is left
      // alone.
      if (this.activeAttempt === attempt) {
        this.activeAttempt = null;
        if (this.starting) {
          this.authResolvedDuringStart = true;
        }
        await this.applyFailure(AUTH_ERROR_LAUNCH_FAILED);
      }
      return;
    }
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
    // The attempt times out at the `device_code` TTL (`expires_in`); the handler
    // is epoch-scoped so a superseded attempt's timer can't kill a newer one.
    // This is a backstop - the controller also emits a terminal `expired`.
    this.scheduleAttemptTimeout(
      attempt.epoch,
      authorization.expiresInSeconds * 1000,
    );
    // Best-effort: open the pre-filled verification page so the user does not
    // have to type the code. Failure is non-fatal (the code + URI are shown).
    void this.runnerHost
      .openExternalLink(authorization.verificationUriComplete)
      .catch(() => {});
    attempt.resultDisposable = session.onResult((result) => {
      void this.finalizeDeviceResult(result, attempt.epoch);
    });
  }

  async signOut(): Promise<void> {
    if (this.disposed) {
      return;
    }
    // Stop the proactive refresh timer up front: `clearStoredAuth()` below is
    // awaited (storage clear + CLI deprovision), and a timer firing during that
    // window would race a `forceRefresh` against the credential removal.
    // `applySignedOut()` stops it again, idempotently.
    this.refreshScheduler.stop();
    this.clearPendingTimeout();
    // Tear down any in-flight attempt: abort it and cancel its main-process
    // device poll so no ~10-minute poll leaks.
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
      this.refreshScheduler.start();
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
    const revalidation = this.revalidateAfterPendingForceRefresh().finally(
      () => {
        if (this.currentRevalidation === revalidation) {
          this.currentRevalidation = null;
        }
      },
    );
    this.currentRevalidation = revalidation;
    return revalidation;
  }

  /**
   * Serializes against an in-flight proactive force-refresh before revalidating.
   * Both paths spend the same single-use refresh token, so overlapping would
   * double-spend it and sign the user out on the loser path. `forceRefreshOnce`
   * awaits us in reverse, making the lock mutual. Deadlock-free: each path checks
   * the other's flag once, synchronously, so only the later starter ever waits.
   * Runs inside the `currentRevalidation` single-flight, so concurrent callers
   * coalesce onto this one promise.
   */
  private async revalidateAfterPendingForceRefresh(): Promise<ValidationOutcome | null> {
    if (this.currentForceRefresh !== null) {
      await this.currentForceRefresh;
      if (this.isDisposed()) {
        return null;
      }
    }
    return this.revalidateCurrentContextOnce();
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
        this.refreshScheduler.start();
      }
      return outcome;
    }
    if (outcome.kind === "rejected") {
      appLogger.warn("[auth] current session rejected during revalidation", {});
      await this.clearStoredAuth();
      this.setLastError(AUTH_ERROR_SESSION_EXPIRED);
      this.applySignedOut();
    }
    if (outcome.kind === "network-error") {
      appLogger.warn(
        "[auth] current session revalidation hit network error",
        {},
      );
    }
    return outcome;
  }

  /**
   * Proactively rotates the access token ahead of its TTL. Driven by the
   * refresh scheduler shortly before `exp`.
   *
   * Unlike `revalidateCurrentContext` - which validates against `/api/v3/user`
   * and only refreshes on a 401 - this ALWAYS force-refreshes against
   * `/api/v3/auth/refresh`, so a still-valid-but-soon-to-expire bearer is
   * renewed before the host's connection-captured copy can go stale (the
   * overnight-session 401). Identity is unchanged on success, so it rotates the
   * live lease in place (observably silent on the provider) and persists,
   * without re-fetching the full user. Single-flight, and serialized against the
   * reactive `revalidateCurrentContext` path so the two can't double-spend the
   * single-use refresh token; a no-op when signed out or when no refresh
   * credential is available.
   */
  private forceRefresh(): Promise<void> {
    if (this.currentForceRefresh !== null) {
      return this.currentForceRefresh;
    }
    const op = this.forceRefreshOnce().finally(() => {
      if (this.currentForceRefresh === op) {
        this.currentForceRefresh = null;
      }
    });
    this.currentForceRefresh = op;
    return op;
  }

  private async forceRefreshOnce(): Promise<void> {
    if (this.isDisposed()) {
      return;
    }
    // Defer to an in-flight reactive revalidation. Both paths draw on the same
    // single-use refresh token, so running concurrently would double-spend it
    // and leave whichever loses holding a dead credential (and, for this path,
    // wrongly signing the user out). Awaiting here serializes the proactive and
    // reactive refreshes within this window - the "shared lock" the two paths
    // were missing. Cross-window siblings (separate `AuthService` instances)
    // can't be awaited; the store re-reads below cover that race instead.
    if (this.currentRevalidation !== null) {
      await this.currentRevalidation;
      if (this.isDisposed()) {
        return;
      }
    }
    const ctx = this.contextProvider.current();
    if (ctx === null || this.currentBearer === null) {
      return;
    }
    const userId = ctx.identity.userId;
    const currentToken = this.currentBearer;
    const stored = await this.tokenStore.load();
    if (this.isDisposed()) {
      return;
    }
    const refreshToken = stored?.refreshToken ?? "";
    if (refreshToken.length === 0) {
      // No refresh credential to rotate against - leave the bearer for the
      // reactive 401 path to handle at actual expiry.
      return;
    }
    // The persisted bearer already moved on from ours: a sibling window or the
    // reactive 401 path rotated it. Do NOT adopt it here - the GUI's shell token
    // slot is shared across windows and can hold a DIFFERENT user's bearer (a
    // window that signed in before its session snapshot projected to us), so
    // blind-rotating this context's lease to it under the current `userId` would
    // bind a foreign identity. Leave reconciliation to the validated cross-window
    // projection path (`ingestProjectedSessionSnapshot`), which confirms the
    // token maps to the same user before applying it.
    if (stored !== null && stored.token !== currentToken) {
      return;
    }
    const result = await this.runnerHost.refreshAuthToken(
      currentToken,
      refreshToken,
    );
    if (this.isDisposed()) {
      return;
    }
    if (result.kind === "network-error") {
      // Transient; the scheduler retries on its floor delay.
      return;
    }
    if (result.kind === "rejected") {
      await this.signOutIfRefreshCredentialDead(currentToken);
      return;
    }
    await this.applyProactiveRefresh(
      userId,
      currentToken,
      result.token,
      result.refreshToken,
    );
  }

  /**
   * Reject handler for the proactive refresh. Our single-use refresh token was
   * rejected; sign out ONLY if this is a genuine expiry. If the persisted bearer
   * has moved on from `refreshedAgainst`, a sibling (the reactive 401 path or
   * another window) already rotated successfully and merely spent the refresh
   * token first - the session is alive, so leave it intact and let the validated
   * projection path adopt the winner's bearer. Only a store still holding our
   * now-dead token is a real expiry that must sign out.
   */
  private async signOutIfRefreshCredentialDead(
    refreshedAgainst: string,
  ): Promise<void> {
    const afterReject = await this.tokenStore.load();
    if (this.isDisposed()) {
      return;
    }
    if (
      afterReject !== null &&
      afterReject.token.length > 0 &&
      afterReject.token !== refreshedAgainst
    ) {
      return;
    }
    await this.clearStoredAuth();
    this.setLastError(AUTH_ERROR_SESSION_EXPIRED);
    this.applySignedOut();
  }

  /**
   * Success handler for the proactive refresh: persist + rotate to the freshly
   * minted bearer, unless a concurrent winner intervened. A sign-out / cross-user
   * transition during the round trip, or a sibling that rotated the shared store
   * mid-refresh (a token differing from both `refreshedAgainst` and the one we
   * just minted), both abort our write - we neither clobber the winner nor
   * blind-adopt it (the shared shell slot can hold a different user); the
   * validated projection path reconciles instead.
   */
  private async applyProactiveRefresh(
    userId: string,
    refreshedAgainst: string,
    newToken: string,
    newRefreshToken: string,
  ): Promise<void> {
    const live = this.contextProvider.current();
    if (live === null || live.identity.userId !== userId) {
      return;
    }
    const latest = await this.tokenStore.load();
    if (this.isDisposed()) {
      return;
    }
    if (
      latest !== null &&
      latest.token.length > 0 &&
      latest.token !== refreshedAgainst &&
      latest.token !== newToken
    ) {
      return;
    }
    await rotateAndPersistBearer({
      newTokens: { token: newToken, refreshToken: newRefreshToken },
      persist: (tokens) => this.tokenStore.save(tokens),
      rotate: (token) => {
        if (this.isDisposed()) {
          return;
        }
        this.contextProvider.rotateCurrentBearer({
          userId,
          bearerToken: token,
        });
      },
    });
    if (this.isDisposed()) {
      return;
    }
    this.currentBearer = newToken;
    this.emitSessionSnapshot();
    this.refreshScheduler.start();
    // Propagate the rotated pair to the machine-local CLI/host credentials. On
    // the proactive path the renderer is the SOLE refresher (the host hasn't
    // 401'd, so its own revalidator hasn't run), so without this the local
    // credential file keeps the now-spent token pair and later host/CLI flows
    // fail to refresh. Best-effort, mirroring sign-in provisioning; a no-op on
    // shells without a local CLI.
    await this.ensureLocalProvisioning(newToken, newRefreshToken);
  }

  /**
   * Shared token-application tail. Invoked by the device-flow finalizer with a
   * minted `{ token, refreshToken }` pair. Validates against AuthnV3, then on
   * `valid` persists, provisions the local CLI, and projects signed-in; a
   * `rejected`/`network-error` outcome surfaces `AUTH_ERROR_SIGN_IN_FAILED` so
   * the header sign-in surface renders "Sign-in failed - please try again"
   * instead of the "Session expired" copy that belongs to the rehydration path.
   *
   * Only applied while the attempt it belongs to is still active: a pair
   * captured for epoch `E` is dropped silently if a fresh `signIn()` replaced
   * the active attempt between dispatch and final projection.
   */
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
        appLogger.info("[auth] ignored empty token from stale OAuth callback", {
          expectedEpoch: expectedOAuthEpoch ?? "cold-start",
        });
        return false;
      }
      appLogger.warn("[auth] OAuth callback delivered an empty token", {});
      this.clearPendingTimeout();
      this.clearActiveAttempt();
      await this.applyFailure(AUTH_ERROR_SIGN_IN_FAILED);
      return false;
    }
    if (!this.isAttemptCurrent(expectedOAuthEpoch)) {
      appLogger.info("[auth] ignored stale OAuth callback before validation", {
        expectedEpoch: expectedOAuthEpoch ?? "cold-start",
      });
      return false;
    }
    this.clearPendingTimeout();
    const outcome = await this.validateToken(token, refreshToken);
    if (this.isDisposed()) {
      return false;
    }

    // After the async validation, the state machine may have moved on: a
    // fresh `signIn()` could have minted a new attempt. In that case this
    // result is stale and must not mutate state.
    if (!this.isAttemptCurrent(expectedOAuthEpoch)) {
      appLogger.info("[auth] ignored stale OAuth callback after validation", {
        expectedEpoch: expectedOAuthEpoch ?? "cold-start",
      });
      return false;
    }
    if (outcome.kind === "valid") {
      // Consume the attempt so a subsequent replayed device result cannot
      // re-apply the same token.
      this.clearActiveAttempt();
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
    appLogger.warn("[auth] OAuth token validation failed", {
      outcome: outcome.kind,
    });
    this.clearActiveAttempt();
    await this.applyFailure(AUTH_ERROR_SIGN_IN_FAILED);
    return false;
  }

  /**
   * Device-flow terminal finalizer. Applies a device poll outcome ONLY if the
   * live attempt is still the one with this epoch - so a result for a superseded
   * attempt (a newer `signIn()` took over) is dropped. The `authorized` path
   * converges on the shared `applyTokenInternal` tail; terminal failures surface
   * a kind-specific error.
   */
  private async finalizeDeviceResult(
    result: DeviceFlowResult,
    expectedEpoch: number,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    const attempt = this.activeAttempt;
    if (attempt === null || attempt.epoch !== expectedEpoch) {
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
    this.clearActiveAttempt();
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
      appLogger.warn(warningMessage, { attempts: maxAttempts });
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, attempt * 200));
    return this.retryLocalCredentialCommand(run, warningMessage, attempt + 1);
  }

  /**
   * Epoch-currency check used by async finalization paths. Returns true iff
   * the captured epoch still matches the live attempt's epoch. A finalizer that
   * captured epoch `E` no-ops once a newer `signIn()` has replaced the active
   * attempt (or it was already consumed/torn down, leaving `null`).
   */
  private isAttemptCurrent(expectedEpoch: number | null): boolean {
    return (this.activeAttempt?.epoch ?? null) === expectedEpoch;
  }

  /**
   * Supersedes (or tears down) the live attempt: aborts its controller so an
   * in-flight device fetch is discarded, and cancels its main-process device
   * poll so no ~10-minute poll leaks. Leaves `activeAttempt === null`.
   */
  private discardActiveAttempt(): void {
    const attempt = this.activeAttempt;
    if (attempt === null) {
      return;
    }
    attempt.abortController.abort();
    attempt.resultDisposable?.dispose();
    if (attempt.deviceSession !== null) {
      attempt.deviceSession.cancel();
    }
    this.setDeviceProgress(null);
    this.activeAttempt = null;
  }

  /**
   * Concludes the active attempt from a terminal finalizer: disposes its
   * device-result subscription (releasing the `onResult`/IPC closure) and clears
   * it. Unlike `discardActiveAttempt`, it does NOT abort/cancel - the attempt
   * has already settled, so there is nothing to tear down.
   */
  private clearActiveAttempt(): void {
    this.activeAttempt?.resultDisposable?.dispose();
    this.activeAttempt = null;
  }

  /**
   * Discards the current attempt (see `discardActiveAttempt`) and starts a new
   * one with a fresh, globally-unique epoch.
   */
  private beginAttempt(): Attempt {
    this.clearPendingTimeout();
    this.discardActiveAttempt();
    const epoch = ++this.nextEpoch;
    const attempt: Attempt = {
      epoch,
      abortController: new AbortController(),
      deviceSession: null,
      resultDisposable: null,
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
    this.refreshScheduler.stop();
    for (const disposeWake of this.wakeDisposers) {
      disposeWake();
    }
    this.wakeDisposers.length = 0;
    this.clearPendingTimeout();
    // Tear down any in-flight attempt so a device poll loop in the shell's main
    // process doesn't keep running after this service is gone.
    if (this.activeAttempt !== null) {
      this.activeAttempt.abortController.abort();
      this.activeAttempt.resultDisposable?.dispose();
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

  /**
   * Browser-return signal handler. The shell delivers a payload-free nudge when
   * the user comes back from the device-approval tab (the `traycer://` deep
   * link). It carries no token or code: it only pokes the in-flight device poll
   * to fire immediately so approval is picked up without waiting out the poll
   * interval. With no live attempt (a cold-start replay, or one already
   * settled) there is nothing to nudge, so it is a no-op. The token always
   * arrives through `finalizeDeviceResult`, never here.
   */
  private handleReturnSignal(): void {
    if (this.disposed) {
      return;
    }
    this.activeAttempt?.deviceSession?.pollNow();
  }

  /**
   * Epoch-scoped attempt timeout. Fires the expiry failure ONLY when the live
   * attempt is still the exact attempt the timer was scheduled for, so a stray
   * timer from a superseded attempt can never kill a newer one (e.g. a timer
   * from an abandoned attempt firing after the user retried). The attempt times
   * out at the `device_code` TTL (`expires_in`).
   */
  private handleAttemptTimeout(epoch: number): void {
    if (this.disposed) {
      return;
    }
    this.pendingTimeoutHandle = null;
    const attempt = this.activeAttempt;
    if (attempt === null || attempt.epoch !== epoch) {
      return;
    }
    if (useAuthStore.getState().status !== "signing-in") {
      appLogger.info(
        "[auth] sign-in timeout ignored outside signing-in state",
        {
          status: useAuthStore.getState().status,
        },
      );
      return;
    }
    // Dispose the result subscription (via clearActiveAttempt) BEFORE cancelling
    // the session, mirroring discardActiveAttempt's dispose-before-cancel order:
    // even if a session's cancel() ever delivered the terminal result
    // synchronously, there is no live onResult handler left to re-enter this
    // finalizer.
    this.clearActiveAttempt();
    attempt.deviceSession?.cancel();
    this.setDeviceProgress(null);
    if (this.starting) {
      this.authResolvedDuringStart = true;
    }
    void this.applyFailure(AUTH_ERROR_DEVICE_EXPIRED);
  }

  /**
   * Schedules the single in-flight attempt timer. Only one attempt is ever live
   * at a time, so a single handle suffices; the captured `epoch` makes the
   * handler a no-op if the attempt has been superseded by the time it fires.
   */
  private scheduleAttemptTimeout(epoch: number, durationMs: number): void {
    this.clearPendingTimeout();
    this.pendingTimeoutHandle = AuthService.scheduleTimeout(() => {
      this.handleAttemptTimeout(epoch);
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
    this.refreshScheduler.start();
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
    this.refreshScheduler.stop();
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
    appLogger.warn("[auth] applying auth failure", {
      errorCode: classifyAuthFailureForLog(error),
    });
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

  /**
   * Re-opens the pre-filled approval page (`verification_uri_complete`, with the
   * user code embedded) for the in-flight device attempt. Backs the sign-in
   * surface's one-click "open approval page" affordance so the user never has to
   * type the code if the initial auto-open was missed. Best-effort; no-op when
   * no attempt is in flight.
   */
  openVerificationPage(): void {
    const progress = this.deviceProgress;
    if (progress === null) {
      return;
    }
    void this.runnerHost
      .openExternalLink(progress.verificationUriComplete)
      .catch(() => {});
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

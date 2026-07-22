import type {
  CredentialsMigrationOutcome,
  IRunnerHost,
  DeviceFlowResult,
  DeviceFlowSession,
  StoredAuthTokens,
  StoredCredentials,
  StoredCredentialsIdentity,
  TokenRotateResult,
} from "@traycer-clients/shared/platform/runner-host";
import { shouldWipeLegacyCredentials } from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation";
import { credentialsIdentityFromAuthenticatedUser } from "@traycer-clients/shared/auth/auth-validation";
import {
  DefaultRequestContextProvider,
  type RequestContextProvider,
} from "@traycer-clients/shared/auth/request-context-provider";
import type { OpenFrameBearerSource } from "@traycer-clients/shared/auth/bearer-source";
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
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsBlocker,
} from "@/lib/analytics";
import { projectShareableTeams } from "@/hooks/epic/use-epic-shareable-teams";
import { onWakeReconnect } from "@/lib/host/wake-reconnect";
import { appLogger, describeLogError } from "@/lib/logger";
import { AuthTokenStore } from "./auth-token-store";

// Legacy encrypted-localStorage token slots (the pre-§3 desktop store). Two
// separate string slots — NOT one JSON blob — matching the retired
// `desktop-runner-host` keys. The write path is gone (§3); §6 reads these one
// last time via the generic `secureStorage` seam to migrate the pair onto the
// shared file, then wipes them.
const LEGACY_ACCESS_TOKEN_KEY = "traycer.token";
const LEGACY_REFRESH_TOKEN_KEY = "traycer.refresh-token";

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
    error === AUTH_ERROR_DEVICE_EXPIRED ||
    error === AUTH_ERROR_STORE_UNAVAILABLE
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
 * Stable error identifier emitted when the credentials-file token store cannot
 * be read or rotated (EACCES/EIO, malformed sidecar, etc.). Surfaced as a
 * UI-only signed-out with a store-unavailable state — never tears down the
 * host runtime, and never writes/deletes the file.
 */
export const AUTH_ERROR_STORE_UNAVAILABLE = "store-unavailable";

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
 * The result of applying a same-user `rotate` outcome to the live session:
 *   - `rotated`    → the lease was rotated in place to `token`;
 *   - `signed-out` → a terminal outcome cleared the UI session (file kept);
 *   - `transient`  → a `lock-busy`/`refresh-network` retry; state untouched.
 */
type SameUserRotateResult =
  | { readonly status: "rotated"; readonly token: string }
  | { readonly status: "signed-out" }
  | { readonly status: "transient" };

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
  // §4 owned-watcher subscription (tokenStore.subscribe); disposed on dispose().
  private tokenStoreChangeDisposable: Disposable | null = null;
  private pendingTimeoutHandle: number | null = null;
  private currentRevalidation: Promise<ValidationOutcome | null> | null = null;
  private currentRevalidationBearer: OpenFrameBearerSource | null = null;
  // Single-flight guard for the proactive force-refresh path so the refresh
  // scheduler can't stack overlapping `/api/v3/auth/refresh` rotations.
  private currentForceRefresh: Promise<void> | null = null;
  // §4 reconcile worker: single-flight + trailing re-run so overlapping watcher
  // events never interleave applies. Never writes, never spends.
  private currentReconcile: Promise<void> | null = null;
  private reconcileQueued = false;
  // Bumped at the start of every reconcile; a newer reconcile drops an older one
  // after any await (mirrors identityGeneration for local mutations).
  private reconcileGeneration = 0;
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
  // Monotonic identity-transition generation, bumped by every transition this
  // service initiates (`signIn` / `signOut` / `dispose`) and re-checked after
  // each await of the sign-in finalization tail (token save, local
  // provisioning) and of `start()`'s rehydration. Complements the attempt
  // epoch rather than replacing it: the epoch fences replayed/superseded
  // results of the SAME interactive flow, but it is consumed before the
  // save/provision awaits, so only this generation can see a `signOut()` or
  // newer `signIn()` that lands inside that window - the newer transition
  // always wins over the already-started finalization.
  private identityGeneration: number = 0;
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
   * Live identity-transition generation. WindowsBridge captures this before a
   * delayed `authSession.get()` so a stale initial snapshot cannot overwrite a
   * newer local mutation that landed while the get was in flight.
   */
  getIdentityGeneration(): number {
    return this.identityGeneration;
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
   *
   * Generation fence: capture before any await; drop the projection if a local
   * mutation or reconcile moved the live identity while validation was in flight.
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
    const generation = this.identityGeneration;
    if (snapshot.status === "signing-in") {
      if (!this.isIdentityCurrent(generation)) {
        return;
      }
      if (useAuthStore.getState().status !== "signing-in") {
        useAuthStore.getState().setSigningIn();
      }
      return;
    }
    if (snapshot.status === "signed-out") {
      if (!this.isIdentityCurrent(generation)) {
        return;
      }
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
    // Capture the live bearer before the validate await. A file-watcher
    // reconcile (or local rotate) that adopts a newer token during the await
    // bumps reconcileGeneration / currentBearer, not identityGeneration — so
    // isIdentityCurrent alone would still pass and we'd clobber the newer
    // file-authoritative token with a staler projection. Symmetric with the
    // reconcile path's post-validate currentBearer no-op.
    const bearerBefore = this.currentBearer;
    // Access-only validation (§3): the cross-window snapshot is a UI projection,
    // not a token write. A stale projected bearer is handled by the local rotate
    // path; here we only mint the local UI session for the same identity.
    const outcome = await this.validateToken(inboundToken);
    if (!this.isIdentityCurrent(generation)) {
      return;
    }
    if (this.currentBearer !== bearerBefore) {
      // Concurrent reconcile/rotate landed a (file-authoritative) newer bearer
      // while we validated — defer to it. A projection is never newer than the
      // file, so dropping is always correct.
      return;
    }

    if (outcome.kind !== "valid") {
      return;
    }

    this.applySignedIn(inboundToken, outcome.user, snapshot.profile);
  }

  async start(): Promise<void> {
    if (this.disposed) {
      return;
    }
    // Rehydration defers to any identity transition that starts while it is
    // in flight: an interactive `signIn()` (its outcome supersedes the stored
    // token either way) or a `signOut()` both bump the generation and stop
    // this flow at the next gate.
    const startGeneration = this.identityGeneration;
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
    // §4: subscribe to the owned credentials-file watcher. Events are a hint;
    // the reconcile worker re-reads the store (disk is truth) and never spends.
    // Subscribe before the first get so a change that lands during rehydration
    // is not missed (the reconcile generation fence drops any race with start).
    if (this.tokenStoreChangeDisposable === null) {
      this.tokenStoreChangeDisposable = this.tokenStore.subscribe(() => {
        this.requestReconcile();
      });
    }

    try {
      // §6: one-time migration of the legacy per-window localStorage token pair
      // onto the shared file, BEFORE the first file read so the rehydrate below
      // adopts the migrated session. Bounded + single-flighted in main; on any
      // fault it declines and leaves the legacy slots for a later launch. Never
      // deletes the file — the rehydrate below is what establishes the session.
      await this.migrateLegacyCredentialsIfPresent();
      if (this.shouldStopStartFlow(startGeneration)) {
        return;
      }
      let stored: StoredCredentials | null;
      try {
        stored = await this.tokenStore.get();
      } catch (error) {
        // Unreadable store (EACCES/EIO/…) must never escape start() — the host
        // runtime provider would dispose the entire runtime. UI-only signed-out
        // + store-unavailable; no file write.
        this.markStoreUnavailable("start.get", error);
        return;
      }
      if (this.shouldStopStartFlow(startGeneration)) {
        return;
      }
      if (stored === null || stored.token.length === 0) {
        return;
      }

      const outcome = await this.validateToken(stored.token);
      if (this.shouldStopStartFlow(startGeneration)) {
        return;
      }
      if (outcome.kind === "valid") {
        this.applySignedIn(stored.token, outcome.user, undefined);
        return;
      }
      // The stored access token is invalid/expired. Run the locked rotate (the
      // one spend) rather than clearing the file: only explicit sign-out
      // destroys it, and a transient failure keeps it for a later retry (H1).
      appLogger.warn("[auth] stored session access token invalid at startup", {
        outcome: outcome.kind,
      });
      await this.rotateStoredSessionAtStartup(stored, startGeneration);
    } finally {
      this.starting = false;
    }
  }

  /**
   * §6 migration pre-step. Reads the legacy per-window localStorage token pair
   * (retired in §3) one last time and hands it to the main store, which
   * reconciles it onto the shared file and single-flights across windows. The
   * legacy slots are wiped only on an outcome that consolidated or discarded the
   * pair (`shouldWipeLegacyCredentials`); `retryable`/`commit-failed` keeps them
   * for a fresh process. Every fault is swallowed — migration must never break
   * startup, which falls through to the normal file rehydrate.
   */
  private async migrateLegacyCredentialsIfPresent(): Promise<void> {
    let legacy: StoredAuthTokens;
    try {
      const token = await this.runnerHost.secureStorage.get(
        LEGACY_ACCESS_TOKEN_KEY,
      );
      if (token === null || token.length === 0) {
        return; // no legacy session to migrate
      }
      const refreshToken =
        (await this.runnerHost.secureStorage.get(LEGACY_REFRESH_TOKEN_KEY)) ??
        "";
      legacy = { token, refreshToken };
    } catch (error) {
      appLogger.warn(
        "[auth] legacy credentials read failed; skipping migration",
        { error: describeLogError(error) },
      );
      return;
    }
    let outcome: CredentialsMigrationOutcome;
    try {
      outcome = await this.tokenStore.migrateLegacyCredentials(legacy);
    } catch (error) {
      // An IPC/store fault mid-migration is non-fatal: keep the legacy slots (a
      // fresh process retries) and fall through to the normal rehydrate.
      appLogger.warn("[auth] legacy credentials migration failed", {
        error: describeLogError(error),
      });
      return;
    }
    appLogger.info("[auth] legacy credentials migration", { outcome });
    if (shouldWipeLegacyCredentials(outcome)) {
      await this.wipeLegacyCredentials();
    }
  }

  private async wipeLegacyCredentials(): Promise<void> {
    try {
      await this.runnerHost.secureStorage.delete(LEGACY_ACCESS_TOKEN_KEY);
      await this.runnerHost.secureStorage.delete(LEGACY_REFRESH_TOKEN_KEY);
    } catch (error) {
      // A failed wipe is benign and idempotent: re-running migration next launch
      // resolves to `file-wins` (a present file) or a spent → `terminal-dead`
      // legacy pair. Never break startup over it.
      appLogger.warn("[auth] legacy credentials wipe failed", {
        error: describeLogError(error),
      });
    }
  }

  /**
   * Startup adoption when the stored access token is invalid/expired: run the
   * locked `rotate` (the one spend, refreshed under the file lock in main), then
   * either mint a fresh signed-in session from the rotated/adopted pair or
   * project a UI-only signed-out. The credentials file is NEVER deleted here -
   * `refresh-rejected` keeps the file (a sibling rotation can still recover it),
   * and only explicit sign-out destroys it (settled decision / H1).
   */
  private async rotateStoredSessionAtStartup(
    stored: StoredCredentials,
    startGeneration: number,
  ): Promise<void> {
    let rotated: TokenRotateResult;
    try {
      rotated = await this.tokenStore.rotate({
        userId: stored.user.id,
        token: stored.token,
      });
    } catch (error) {
      this.markStoreUnavailable("start.rotate", error);
      return;
    }
    if (this.shouldStopStartFlow(startGeneration)) {
      return;
    }
    const pair = rotatedLivePair(rotated);
    // `commit-failed` can surface a process-wide pending continuation for a
    // *different* user (one main-process store shared across windows). Never
    // adopt a foreign pair into this session.
    if (pair !== null && pair.user.id === stored.user.id) {
      // The rotated pair carries only the cached identity; re-validate it
      // (access-only) to mint the full `AuthenticatedUser` the context needs.
      const revalidated = await this.validateToken(pair.token);
      if (this.shouldStopStartFlow(startGeneration)) {
        return;
      }
      if (revalidated.kind === "valid") {
        this.applySignedIn(pair.token, revalidated.user, undefined);
        return;
      }
    }
    // `refresh-rejected` shows the "session expired" copy; every other terminal
    // or transient outcome projects a plain UI-only signed-out (file kept).
    if (rotated.outcome === "refresh-rejected") {
      this.setLastError(AUTH_ERROR_SESSION_EXPIRED);
    }
    this.applySignedOut();
  }

  private shouldStopStartFlow(startGeneration: number): boolean {
    return (
      this.disposed ||
      this.authResolvedDuringStart ||
      startGeneration !== this.identityGeneration
    );
  }

  private isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * True while `generation` is still the live identity transition (and the
   * service is not disposed). Async credential tails capture the generation
   * before their first await and re-check through this after each one, so a
   * newer `signIn()` / `signOut()` / `dispose()` always wins over an
   * already-started save/rotate/provision.
   */
  private isIdentityCurrent(generation: number): boolean {
    return !this.disposed && generation === this.identityGeneration;
  }

  private isExpectedBearerCurrent(expected: OpenFrameBearerSource): boolean {
    const current = this.contextProvider.current();
    return (
      current !== null &&
      current.credentials === expected &&
      !current.credentials.isReleased
    );
  }

  private isExpectedBearerLive(
    expected: OpenFrameBearerSource,
    generation: number,
  ): boolean {
    return (
      this.isIdentityCurrent(generation) &&
      this.isExpectedBearerCurrent(expected)
    );
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
    this.identityGeneration += 1;
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
        this.applyFailure(AUTH_ERROR_LAUNCH_FAILED);
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
      this.applyFailure(AUTH_ERROR_LAUNCH_FAILED);
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
    if (this.isDisposed()) {
      return;
    }
    // Invalidate any sign-in finalization that already passed its epoch fence
    // and is now awaiting its token save - the sign-out wins.
    this.identityGeneration += 1;
    // Stop the proactive refresh timer up front so a timer firing during the
    // delete can't race a `rotate` against the credential removal.
    this.refreshScheduler.stop();
    this.clearPendingTimeout();
    // Tear down any in-flight attempt: abort it and cancel its main-process
    // device poll so no ~10-minute poll leaks.
    this.discardActiveAttempt();
    // The single file-destroying path in the app (the other is `traycer logout`).
    // `delete()` rejects if the delete cannot land; a failed sign-out must stay
    // signed in and surface, never falsely report signed-out (§5).
    const deleteError = await this.tokenStore.delete().then(
      () => null,
      (error: unknown) => error ?? new Error("sign-out delete rejected"),
    );
    // dispose() may have landed during the delete await — re-read fresh.
    if (this.isDisposed()) {
      return;
    }
    if (deleteError !== null) {
      appLogger.warn(
        "[auth] sign-out could not delete the credentials file; staying signed in",
        { error: describeLogError(deleteError) },
      );
      // The session is still live - re-arm the proactive refresh we paused.
      this.refreshScheduler.start();
      return;
    }
    this.setLastError(null);
    this.applySignedOut();
    // Drop any in-flight reconcile that raced the delete chain (a superseded
    // finalization's signIn may have re-written the file and notified before
    // delete landed; its adopt must not resurrect signed-in after we cleared).
    this.reconcileGeneration += 1;
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
    const expected = this.contextProvider.current()?.credentials ?? null;
    if (expected === null) {
      return null;
    }
    return this.revalidateExpectedContext(expected);
  }

  /**
   * Revalidates only the credential object that produced an unauthorized host
   * frame. A session replacement never joins the old single-flight operation
   * and cannot be mutated by its eventual result.
   */
  async revalidateExpectedBearer(
    expected: OpenFrameBearerSource,
  ): Promise<"rotated" | "rejected" | "network-error" | "superseded"> {
    const generation = this.identityGeneration;
    if (!this.isExpectedBearerLive(expected, generation)) {
      return "superseded";
    }
    if (
      this.currentRevalidation !== null &&
      this.currentRevalidationBearer !== expected
    ) {
      return "superseded";
    }
    const outcome = await this.revalidateExpectedContext(expected);
    if (!this.isIdentityCurrent(generation) || outcome === null) {
      return "superseded";
    }
    if (outcome.kind === "rejected" || outcome.kind === "network-error") {
      return outcome.kind;
    }
    return this.isExpectedBearerLive(expected, generation)
      ? "rotated"
      : "superseded";
  }

  private revalidateExpectedContext(
    expected: OpenFrameBearerSource,
  ): Promise<ValidationOutcome | null> {
    if (this.currentRevalidation !== null) {
      return this.currentRevalidationBearer === expected
        ? this.currentRevalidation
        : Promise.resolve(null);
    }
    const revalidation = this.revalidateAfterPendingForceRefresh(
      expected,
    ).finally(() => {
      if (this.currentRevalidation === revalidation) {
        this.currentRevalidation = null;
        this.currentRevalidationBearer = null;
      }
    });
    this.currentRevalidation = revalidation;
    this.currentRevalidationBearer = expected;
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
  private async revalidateAfterPendingForceRefresh(
    expected: OpenFrameBearerSource,
  ): Promise<ValidationOutcome | null> {
    if (this.currentForceRefresh !== null) {
      await this.currentForceRefresh;
      if (this.isDisposed() || !this.isExpectedBearerCurrent(expected)) {
        return null;
      }
    }
    return this.revalidateCurrentContextOnce(expected);
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

  private async revalidateCurrentContextOnce(
    expected: OpenFrameBearerSource,
  ): Promise<ValidationOutcome | null> {
    if (this.isDisposed()) {
      return null;
    }
    // Same fence as the sign-in finalization: a signOut()/newer signIn()
    // landing during any await below owns the state - this revalidation must
    // not re-persist or re-project the identity it started with.
    const generation = this.identityGeneration;
    const ctx = this.contextProvider.current();
    if (
      ctx === null ||
      ctx.credentials !== expected ||
      ctx.credentials.isReleased ||
      this.currentBearer === null
    ) {
      return null;
    }
    const currentUserId = ctx.identity.userId;
    const currentToken = this.currentBearer;
    // Access-only (§3): validate the live bearer without spending. A stale bearer
    // comes back `rejected`, and the spend routes through the locked `rotate`.
    const outcome = await this.validateToken(currentToken);
    if (!this.isIdentityCurrent(generation)) {
      return null;
    }

    if (outcome.kind === "valid") {
      if (outcome.user.user.id !== currentUserId) {
        // The bearer now validates to a different user (a cross-user re-seed) -
        // treat as a fresh sign-in so the old context aborts cleanly.
        this.applySignedIn(currentToken, outcome.user, undefined);
      }
      return outcome;
    }
    if (outcome.kind === "rejected") {
      // The access token is stale/expired: run the locked rotate (the spend).
      appLogger.warn("[auth] current session access token stale; rotating", {});
      return this.rotateLiveSession(currentUserId, currentToken, generation);
    }
    // Only `network-error` remains — the valid/rejected arms returned above.
    appLogger.warn("[auth] current session revalidation hit network error", {});
    return outcome;
  }

  /**
   * Same-user rotation of the LIVE session (reactive 401 path): run the locked
   * `rotate`, rotate the credential lease in place on success (observably silent
   * on the provider), and hand back the fresh identity outcome so callers that
   * need the full user (the subscription panel) still get it. Terminal outcomes
   * clear the UI session (never the file, except `refresh-rejected` which also
   * surfaces "session expired").
   */
  private async rotateLiveSession(
    userId: string,
    currentToken: string,
    generation: number,
  ): Promise<ValidationOutcome | null> {
    let rotated: TokenRotateResult;
    try {
      rotated = await this.tokenStore.rotate({
        userId,
        token: currentToken,
      });
    } catch (error) {
      if (!this.isIdentityCurrent(generation)) {
        return null;
      }
      this.markStoreUnavailable("reactive.rotate", error);
      return { kind: "rejected" };
    }
    if (!this.isIdentityCurrent(generation)) {
      return null;
    }
    const result = this.applyLiveRotateOutcome(rotated, userId, generation);
    if (result.status === "rotated") {
      const revalidated = await this.validateToken(result.token);
      if (!this.isIdentityCurrent(generation)) {
        return null;
      }
      return revalidated.kind === "valid" ? revalidated : { kind: "rejected" };
    }
    return result.status === "signed-out"
      ? { kind: "rejected" }
      : { kind: "network-error" };
  }

  // Rotate the live credential lease in place onto `bearerToken` - observably
  // silent on the provider, so host-runtime / cache state survives - and re-arm
  // the refresh scheduler. The single point every same-user adoption goes through
  // (locked-rotate outcomes and the §4 reconcile worker).
  private rotateLiveBearer(userId: string, bearerToken: string): void {
    this.contextProvider.rotateCurrentBearer({ userId, bearerToken });
    this.currentBearer = bearerToken;
    this.emitSessionSnapshot();
    this.refreshScheduler.start();
  }

  // Adopt a rotated pair into the live session, but ONLY while the live context
  // is still the user we rotated for. A cross-user transition can land between
  // the rotate dispatch and here without bumping the generation (device-flow
  // ingest), and the R9 first-gate can hand back a foreign-user pending pair from
  // the shared main-process store; both are rejected here (→ transient, no
  // session/UI change). The `pair.user` check is the defense-in-depth.
  private adoptRotatedPairIntoLiveSession(
    pair: StoredCredentials | null,
    userId: string,
    generation: number,
  ): SameUserRotateResult {
    if (
      pair === null ||
      pair.user.id !== userId ||
      !this.isIdentityCurrent(generation) ||
      this.contextProvider.current()?.identity.userId !== userId
    ) {
      return { status: "transient" };
    }
    this.rotateLiveBearer(userId, pair.token);
    return { status: "rotated", token: pair.token };
  }

  /**
   * Applies a same-user `rotate` outcome to the LIVE session (shared by the
   * reactive and proactive paths). On a live pair it rotates the credential lease
   * in place - observably silent on the provider, so host-runtime / cache state
   * survives - and re-arms the scheduler. Terminal outcomes clear the UI session
   * only (the file is destroyed solely by explicit sign-out). Synchronous: the
   * caller has already re-checked identity currency after the rotate await.
   */
  private applyLiveRotateOutcome(
    rotated: TokenRotateResult,
    userId: string,
    generation: number,
  ): SameUserRotateResult {
    switch (rotated.outcome) {
      case "applied":
      case "superseded":
      case "commit-failed":
        // `superseded` is same-user by the store's user-mismatch-before-token
        // guard; `commit-failed` can carry a foreign-user pending pair from the
        // shared main-process store (R9 first-gate). The adopt guard bails on
        // either mismatch (→ transient, no session/UI change).
        return this.adoptRotatedPairIntoLiveSession(
          rotated.pair,
          userId,
          generation,
        );
      case "user-mismatch":
      case "deleted":
      case "tombstoned":
        // The shared file moved to another account or was signed out - UI-only.
        this.clearUiSession();
        return { status: "signed-out" };
      case "refresh-rejected":
        // Genuine dead credential - UI-only sign-out, file kept (settled decision).
        this.setLastError(AUTH_ERROR_SESSION_EXPIRED);
        this.clearUiSession();
        return { status: "signed-out" };
      case "lock-busy":
      case "refresh-network":
        // Transient; the access token in hand stays valid for its TTL.
        return { status: "transient" };
    }
  }

  /**
   * UI-only sign-out: abort the live context + project signed-out WITHOUT
   * touching the shared credentials file (only explicit user intent destroys it,
   * settled decision). Used by every automatic failure path; the §4 watch
   * re-adopts if a sibling rotation later lands.
   */
  private clearUiSession(): void {
    this.applySignedOut();
  }

  // Clear the UI session only when one is actually projected — avoids a redundant
  // signed-out emit when reconcile just confirms an already-absent session.
  private clearUiSessionIfSignedIn(): void {
    if (
      this.currentBearer !== null ||
      this.contextProvider.current() !== null ||
      useAuthStore.getState().status === "signed-in"
    ) {
      this.clearUiSession();
    }
  }

  /**
   * Credentials-file store fault (EACCES/EIO/malformed sidecar/…): surface
   * store-unavailable and project a UI-only signed-out. Never rethrows — a
   * fault must not tear down HostRuntimeProvider's startup, and never writes
   * or deletes the shared file.
   */
  private markStoreUnavailable(context: string, error: unknown): void {
    appLogger.warn(`[auth] token store unavailable (${context})`, {
      error: describeLogError(error),
    });
    this.setLastError(AUTH_ERROR_STORE_UNAVAILABLE);
    this.clearUiSession();
  }

  /**
   * §4 reconcile worker trigger. Single-flight with a trailing re-run so
   * overlapping watcher events collapse to one re-read after the in-flight
   * reconcile settles. Never writes, never spends.
   */
  private requestReconcile(): void {
    if (this.isDisposed()) {
      return;
    }
    if (this.currentReconcile !== null) {
      this.reconcileQueued = true;
      return;
    }
    const op = this.runReconcileOnce().finally(() => {
      if (this.currentReconcile === op) {
        this.currentReconcile = null;
      }
      if (this.reconcileQueued && !this.isDisposed()) {
        this.reconcileQueued = false;
        this.requestReconcile();
      }
    });
    this.currentReconcile = op;
  }

  /**
   * VALIDATE-ONLY re-adoption from the credentials file:
   *   - file null → UI-only signed-out (sign-out-elsewhere / traycer logout);
   *   - file present + access valid → applySignedIn (same-user rotation OR
   *     account switch OR signed-out→present);
   *   - file present + invalid/expired → clearUiSession (file kept; a later
   *     proactive/reactive/interactive path does the spend — never here).
   *
   * Every apply is gated by identity + reconcile generation after each await.
   */
  private async runReconcileOnce(): Promise<void> {
    if (this.isDisposed()) {
      return;
    }
    const identityGen = this.identityGeneration;
    this.reconcileGeneration += 1;
    const reconcileGen = this.reconcileGeneration;

    let stored: StoredCredentials | null;
    try {
      stored = await this.tokenStore.get();
    } catch (error) {
      if (!this.isReconcileCurrent(identityGen, reconcileGen)) {
        return;
      }
      this.markStoreUnavailable("reconcile.get", error);
      return;
    }
    if (!this.isReconcileCurrent(identityGen, reconcileGen)) {
      return;
    }

    if (stored === null || stored.token.length === 0) {
      this.clearUiSessionIfSignedIn();
      return;
    }

    // Self-write / sibling-echo no-op: already on this bearer.
    if (stored.token === this.currentBearer) {
      return;
    }

    // Never clobber an interactive sign-in attempt (device flow in flight). A
    // concurrent self-write notify from a superseded finalization's signIn must
    // not project signed-in over the newer attempt's signing-in state.
    if (
      this.activeAttempt !== null ||
      useAuthStore.getState().status === "signing-in"
    ) {
      return;
    }

    // Access-only: reconcile never spends. An expired file is left for the
    // proactive/reactive/interactive paths that own the locked rotate.
    const outcome = await this.validateToken(stored.token);
    if (!this.isReconcileCurrent(identityGen, reconcileGen)) {
      return;
    }
    // A local rotate may have adopted this bearer while we validated — same
    // no-op as the pre-validate check (avoids applySignedIn aborting the live
    // context the reactive path just rotated in place).
    if (stored.token === this.currentBearer) {
      return;
    }
    this.applyReconciledOutcome(stored, outcome);
  }

  /**
   * Projects a reconcile's access-only validation result onto the UI session
   * (never writes/spends). Same-user → rotate the lease in place (host-runtime /
   * cache state survives); signed-out→present or account switch → full signed-in
   * projection; network blip → leave the live session intact; invalid/expired →
   * UI-only sign-out (file kept — the spend is not this path's job).
   */
  private applyReconciledOutcome(
    stored: StoredCredentials,
    outcome: ValidationOutcome,
  ): void {
    if (outcome.kind === "valid") {
      const liveUserId = this.contextProvider.current()?.identity.userId;
      if (liveUserId !== undefined && liveUserId === outcome.user.user.id) {
        // Same-user adopt (external sibling rotation or a self-write echo that
        // raced past the pre-validate no-op): rotate the lease in place.
        this.rotateLiveBearer(liveUserId, stored.token);
        return;
      }
      // Signed-out → present, or account switch: full signed-in projection.
      this.applySignedIn(stored.token, outcome.user, undefined);
      return;
    }
    if (outcome.kind === "network-error") {
      // Transient: cannot adopt an unvalidated bearer, but do not tear down a
      // live session over a blip. A later event / restart re-tries.
      return;
    }
    // Invalid/expired: UI-only sign-out, file kept (spend is not this path's job).
    this.clearUiSessionIfSignedIn();
  }

  private isReconcileCurrent(
    identityGen: number,
    reconcileGen: number,
  ): boolean {
    return (
      !this.disposed &&
      this.identityGeneration === identityGen &&
      this.reconcileGeneration === reconcileGen
    );
  }

  /**
   * Proactively rotates the access token ahead of its TTL. Driven by the refresh
   * scheduler shortly before `exp`, so a still-valid-but-soon-to-expire bearer is
   * renewed before the host's connection-captured copy can go stale (the
   * overnight-session 401). The spend runs through the locked `rotate` op (in
   * main, under the file lock), and identity is unchanged on success so the live
   * lease rotates in place (observably silent on the provider). Single-flight,
   * and serialized against the reactive `revalidateCurrentContext` path so the
   * two can't both drive a rotate on the same base; a no-op when signed out.
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
    // A sign-out (or newer sign-in) that lands during any await below owns the
    // state from that point on - this tail must not re-project the identity it
    // started with.
    const generation = this.identityGeneration;
    // Defer to an in-flight reactive revalidation. Both paths drive the locked
    // `rotate`; awaiting here serializes the proactive and reactive refreshes
    // within this process, and the file lock serializes across processes - so at
    // most one process ever spends a given refresh token.
    if (this.currentRevalidation !== null) {
      await this.currentRevalidation;
      if (!this.isIdentityCurrent(generation)) {
        return;
      }
    }
    const ctx = this.contextProvider.current();
    if (ctx === null || this.currentBearer === null) {
      return;
    }
    const userId = ctx.identity.userId;
    const currentToken = this.currentBearer;
    let rotated: TokenRotateResult;
    try {
      rotated = await this.tokenStore.rotate({
        userId,
        token: currentToken,
      });
    } catch (error) {
      if (!this.isIdentityCurrent(generation)) {
        return;
      }
      this.markStoreUnavailable("proactive.rotate", error);
      return;
    }
    if (!this.isIdentityCurrent(generation)) {
      return;
    }
    // `superseded` here adopts a sibling's rotation without spending; `deleted`/
    // `user-mismatch`/`tombstoned` clear the UI session (no resurrection);
    // `refresh-rejected` is the genuine expiry; transient outcomes leave the
    // bearer for the reactive path. Identical handling to the reactive rotate.
    this.applyLiveRotateOutcome(rotated, userId, generation);
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
    // Captured before the first await. The attempt epoch is consumed before
    // the save/provision awaits below, so this generation is the only fence
    // that can drop the finalization once a `signOut()` / newer `signIn()`
    // interleaves with them.
    const generation = this.identityGeneration;
    if (token.length === 0) {
      if (!this.isAttemptCurrent(expectedOAuthEpoch)) {
        appLogger.debug(
          "[auth] ignored empty token from stale OAuth callback",
          {
            expectedEpoch: expectedOAuthEpoch ?? "cold-start",
          },
        );
        return false;
      }
      appLogger.warn("[auth] OAuth callback delivered an empty token", {});
      this.clearPendingTimeout();
      this.clearActiveAttempt();
      this.applyFailure(AUTH_ERROR_SIGN_IN_FAILED);
      return false;
    }
    if (!this.isAttemptCurrent(expectedOAuthEpoch)) {
      appLogger.debug("[auth] ignored stale OAuth callback before validation", {
        expectedEpoch: expectedOAuthEpoch ?? "cold-start",
      });
      return false;
    }
    this.clearPendingTimeout();
    const outcome = await this.validateToken(token);
    if (this.isDisposed()) {
      return false;
    }

    // After the async validation, the state machine may have moved on: a
    // fresh `signIn()` could have minted a new attempt. In that case this
    // result is stale and must not mutate state.
    if (!this.isAttemptCurrent(expectedOAuthEpoch)) {
      appLogger.debug("[auth] ignored stale OAuth callback after validation", {
        expectedEpoch: expectedOAuthEpoch ?? "cold-start",
      });
      return false;
    }
    if (outcome.kind === "valid") {
      // Consume the attempt so a subsequent replayed device result cannot
      // re-apply the same token.
      this.clearActiveAttempt();
      // Interactive sign-in: write the freshly-minted pair + validated identity to
      // the shared credentials file. `signIn` stamps `authnBaseUrl` + `savedAt` in
      // main and rejects if the write cannot land. This is the file the host's
      // owner gate reads, written BEFORE we flip signed-in (which enables host
      // RPCs) - so on a brand-new sign-in the owner is pinned before the first
      // connection, closing the UNAUTHORIZED race that would burn refresh tokens.
      // (This subsumes the old best-effort `ensureLocalProvisioning`/`cliLogin`
      // seed, which would now be a second, unsynchronized writer to the same file.)
      const signInError: unknown = await this.tokenStore
        .signIn({ token, refreshToken }, identityFromUser(outcome.user))
        .then(
          () => null,
          (error: unknown) => error ?? new Error("sign-in save rejected"),
        );
      // Checked before acting on the outcome: a transition (or dispose) that
      // landed during the write owns the state now, so neither the signed-in
      // projection nor the failure projection below may run for this stale
      // finalization.
      if (!this.isIdentityCurrent(generation)) {
        appLogger.debug(
          "[auth] dropped sign-in finalization superseded during token save",
          {},
        );
        return false;
      }
      if (signInError !== null) {
        // Without the persisted pair the "signed-in" projection would be a
        // lie the next launch cannot rehydrate and the rotate cannot refresh.
        // Fail the sign-in as a product failure instead.
        appLogger.warn(
          "[auth] failed to persist accepted sign-in credentials",
          { error: describeLogError(signInError) },
        );
        this.applyFailure(AUTH_ERROR_SIGN_IN_FAILED);
        return false;
      }

      this.setLastError(null);
      this.applySignedIn(token, outcome.user, undefined);
      // Terminal success of an interactive device-flow attempt (this method's
      // only caller is `finalizeDeviceResult`). Passive token restores use a
      // different path and deliberately never count as sign-ins.
      Analytics.getInstance().track(AnalyticsEvent.SignInSucceeded, null);
      return true;
    }
    // Validation `rejected` OR `network-error`: do not persist. Surface
    // `sign-in-failed` so the header sign-in surface renders a retry CTA.
    appLogger.warn("[auth] OAuth token validation failed", {
      outcome: outcome.kind,
    });
    this.clearActiveAttempt();
    this.applyFailure(AUTH_ERROR_SIGN_IN_FAILED);
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
    this.applyFailure(deviceFailureError(result));
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
    this.identityGeneration += 1;
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
    if (this.tokenStoreChangeDisposable !== null) {
      this.tokenStoreChangeDisposable.dispose();
      this.tokenStoreChangeDisposable = null;
    }
    this.reconcileQueued = false;
    this.currentReconcile = null;
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
      appLogger.debug(
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
    this.applyFailure(AUTH_ERROR_DEVICE_EXPIRED);
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
   * Access-only (§3): validates the bearer without spending. A stale/expired
   * token returns `rejected`; the refresh spend is owned exclusively by the
   * locked `rotate` path, never here.
   */
  private validateToken(token: string): Promise<ValidationOutcome> {
    return this.runnerHost.validateAuthTokenIdentity(token);
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
   * Projects a terminal sign-in FAILURE. UI-only: the credentials file is NOT
   * touched (only explicit sign-out destroys it). The paths that reach here
   * failed validation BEFORE any `signIn` wrote the file, so there is nothing to
   * clean up; a pre-existing file is left for the §4 watch / next launch to
   * reconcile (H1: an automatic failure never deletes the shared file).
   */
  private applyFailure(error: string): void {
    if (this.disposed) {
      return;
    }
    appLogger.warn("[auth] applying auth failure", {
      errorCode: classifyAuthFailureForLog(error),
    });
    // Every caller of this method is a terminal failure of an interactive
    // sign-in attempt (launch failure, device denial/expiry, token rejection),
    // so this is the one seam where `sign_in_failed` is emitted.
    Analytics.getInstance().track(AnalyticsEvent.SignInFailed, {
      blocker: SIGN_IN_FAILURE_BLOCKERS[error] ?? "unknown",
    });
    this.setLastError(error);
    this.applySignedOut();
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
/**
 * The credentials pair a `rotate` outcome hands back to adopt: present for
 * `applied`/`superseded`/`commit-failed`, `null` for the terminal/transient
 * outcomes that carry no pair (`deleted`/`user-mismatch`/`tombstoned`/
 * `lock-busy`/`refresh-rejected`/`refresh-network`).
 */
function rotatedLivePair(rotated: TokenRotateResult): StoredCredentials | null {
  if (
    rotated.outcome === "applied" ||
    rotated.outcome === "superseded" ||
    rotated.outcome === "commit-failed"
  ) {
    return rotated.pair;
  }
  return null;
}

/**
 * Projects the credentials-file identity block (`{ id, email, name }`) from a
 * validated `AuthenticatedUser`. The store stamps `authnBaseUrl` + `savedAt`;
 * only the user identity crosses the `signIn` seam.
 */
function identityFromUser(user: AuthenticatedUser): StoredCredentialsIdentity {
  // Single source of truth for the projection lives in shared auth-validation
  // (the §6 migration probe stamps the same shape from main).
  return credentialsIdentityFromAuthenticatedUser(user);
}

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

const SIGN_IN_FAILURE_BLOCKERS: Readonly<Record<string, AnalyticsBlocker>> = {
  [AUTH_ERROR_LAUNCH_FAILED]: "network",
  [AUTH_ERROR_DEVICE_DENIED]: "authorization",
  [AUTH_ERROR_DEVICE_EXPIRED]: "timeout",
  [AUTH_ERROR_SIGN_IN_FAILED]: "authentication",
};

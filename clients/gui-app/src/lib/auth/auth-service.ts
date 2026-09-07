import type {
  CredentialsMigrationOutcome,
  IRunnerHost,
  DeviceFlowResult,
  DeviceFlowSession,
  StoredAuthTokens,
  StoredCredentials,
  StoredCredentialsIdentity,
  TokenRotateOutcome,
  TokenRotateResult,
} from "@traycer-clients/shared/platform/runner-host";
import { shouldWipeLegacyCredentials } from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type {
  ListUserSessionsResponse,
  MintHostCredentialRequest,
} from "@traycer/protocol/auth/devices-sessions";
import type { HostListResponse } from "@traycer/protocol/host/host-status";
import type {
  MintHostCredentialFetchResult,
  RetainedStepUpVerifyFetchResult,
  RevokeAllSessionsFetchResult,
  RevokeUserSessionFetchResult,
  StepUpChallengeFetchResult,
} from "@traycer-clients/shared/auth/devices-sessions-fetcher";
import {
  claimLinkLoginCodeViaHttp,
  linkLoginTokenViaHttp,
  type LinkLoginStatusFetchResult,
  type MintLinkLoginCodeFetchResult,
  type RespondLinkLoginFetchResult,
} from "@traycer-clients/shared/auth/link-login";
import type {
  UpdateHostVersionPolicyFetchResult,
  UpdateHostVersionPolicyInput,
} from "@traycer-clients/shared/host-client/host-version-policy-fetcher";
import type { DeregisterHostFetchResult } from "@traycer-clients/shared/host-client/host-deregister-fetcher";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation";
import { credentialsIdentityFromAuthenticatedUser } from "@traycer-clients/shared/auth/auth-validation";
import {
  DefaultRequestContextProvider,
  type AuthEra,
  type RequestContextProvider,
} from "@traycer-clients/shared/auth/request-context-provider";
import type { OpenFrameBearerSource } from "@traycer-clients/shared/auth/bearer-source";
import {
  createProactiveRefreshScheduler,
  DEFAULT_REFRESH_LEAD_MS,
  DEFAULT_REFRESH_MIN_DELAY_MS,
  type ProactiveRefreshScheduler,
} from "@traycer-clients/shared/auth/token-refresh-scheduler";
import { readAccessTokenExpiryMs } from "@traycer-clients/shared/auth/jwt-exp";
import { usernameFromAuthenticatedUser } from "@traycer/protocol/auth/request-context";
import type { SubscriptionStatus } from "@traycer/protocol/auth/user";
import {
  useAuthStore,
  type AuthContextMetadata,
  type AuthProfile,
  type AuthStatus,
} from "@/stores/auth/auth-store";
import { normalizeAvatarUrl } from "@/lib/avatar-url";
import {
  browserChatPartCacheStorage,
  clearChatPartCache,
} from "@/lib/chats/cloud-chat-part-cache";
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsBlocker,
} from "@/lib/analytics";
import { projectShareableTeams } from "@/hooks/epic/use-epic-shareable-teams";
import { onWakeReconnect } from "@/lib/host/wake-reconnect";
import { appLogger, describeLogError } from "@/lib/logger";
import {
  recordAuthServerTime,
  recordRotatedBearer,
} from "@/lib/clock/app-server-clock";
import { AuthTokenStore } from "./auth-token-store";
import {
  clearProvisionalSessionSnapshot,
  readProvisionalSessionSnapshot,
  writeProvisionalSessionSnapshot,
} from "./provisional-session-snapshot";

// Legacy encrypted-localStorage token slots (the pre-§3 desktop store).
// Two separate string slots - NOT one JSON blob - matching the retired `desktop-runner-host` keys.
const LEGACY_ACCESS_TOKEN_KEY = "traycer.token";
const LEGACY_REFRESH_TOKEN_KEY = "traycer.refresh-token";

/**
 * The kinds a surface actually renders: the CODE VERDICTS, and nothing else.
 * A completed sign-in speaks for itself, and the two non-verdict outcomes (`superseded`, `failed`) are either silent or already presented globally.
 */
export type LinkLoginFailureKind = Exclude<
  LinkLoginSignInResult["kind"],
  "signed-in" | "superseded" | "failed"
>;

/**
 * Terminal outcome of {@link AuthService.signInWithLinkCode}.
 * `invalid-code` covers expired, claimed-elsewhere, and never-existed codes indistinguishably (the server does not say which); `denied` is the desktop explicitly rejecting the claim; `timed-out` means the approval window elapsed with no decision.
 */
export type LinkLoginSignInResult =
  | { readonly kind: "signed-in" }
  /**
   * The attempt stopped being ours - a newer sign-in superseded it, or the service was disposed.
   * NOT a failure, and deliberately not presentable: whoever superseded this attempt owns the surface now, and reporting a result from a discarded attempt would put its complaint under the successor's progress.
   */
  | { readonly kind: "superseded" }
  /**
   * The claim was approved, and applying the resulting credentials failed on THIS attempt - an empty token, a rejected persist, or validation that was rejected or unreachable.
   * A real failure, already surfaced globally.
   */
  | { readonly kind: "failed" }
  | { readonly kind: "invalid-code" }
  | { readonly kind: "denied" }
  | { readonly kind: "timed-out" }
  | { readonly kind: "rate-limited" }
  | { readonly kind: "network-error" };

/**
 * How long the phone keeps polling for the desktop's decision before giving up locally.
 * Matches the server's claim window; the record is gone by then.
 */
const LINK_LOGIN_APPROVAL_TIMEOUT_MS = 120_000;

/**
 * Thrown when a read is asked for on behalf of a credential era that is no longer the live one - the request would go out under a bearer from a different era than the answer is meant for.
 */
export class SupersededAuthEraError extends Error {
  constructor() {
    super("Refusing a read issued for a superseded credential era");
    this.name = "SupersededAuthEraError";
  }
}

// Stored-session recovery backoff bounds (see `sessionRecoveryTimer`).
const SESSION_RECOVERY_INITIAL_DELAY_MS = 1_000;
const SESSION_RECOVERY_MAX_DELAY_MS = 30_000;

export interface AuthServiceOptions {
  readonly runnerHost: IRunnerHost;
}

export type AuthListener = (status: AuthStatus) => void;
export type AuthErrorListener = (error: string | null) => void;

/** Boundary-only persisted-session snapshot. */
export interface AuthSessionSnapshot {
  readonly status: AuthStatus;
  readonly token: string | null;
  readonly profile: AuthProfile | null;
  readonly contextMetadata: AuthContextMetadata | null;
}

/**
 * The identity and credential authority that started an account-scoped operation.
 * `identityGeneration` alone cannot distinguish a projected or reconciled account replacement, so callers also retain the live credential object and bearer they are allowed to use.
 */
interface LiveSessionAuthority {
  readonly credentials: OpenFrameBearerSource;
  readonly userId: string;
  readonly bearer: string;
  readonly generation: number;
}

export type AuthSessionSnapshotListener = (
  snapshot: AuthSessionSnapshot,
) => void;

/** Externally-delivered session snapshot accepted by `applyExternalSession`. */
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
 * Stable error identifier emitted when the device-authorization request itself fails (network/5xx, or the shell has no device-flow backend) so no poll loop ever starts.
 * This must fail the flow immediately - there is no browser tab to wait on - so the UI shows a retry CTA.
 */
export const AUTH_ERROR_LAUNCH_FAILED = "auth-launch-failed";

/**
 * Stable error identifier emitted when AuthnV3 rejects a stored bearer token during `start()`-time rehydration.
 * Surfaced on the signed-out auth surface so the user understands their previous session expired and a fresh sign-in is needed.
 */
export const AUTH_ERROR_SESSION_EXPIRED = "session-expired";

/**
 * Stable error identifier emitted when AuthnV3 rejects (or the network fails for) a token delivered through the OAuth callback during an active sign-in attempt.
 * Distinct from `AUTH_ERROR_SESSION_EXPIRED` so the signed-out auth surface can render "Sign-in failed - please try again" copy instead of the "Session expired" copy that belongs to the stored-token-rehydration path.
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
 * Stable error identifier emitted when the user denies a device-flow request in the browser.
 * Distinct from `AUTH_ERROR_SIGN_IN_FAILED` so the device-code surface can render "Request denied" copy.
 */
export const AUTH_ERROR_DEVICE_DENIED = "device-denied";

/**
 * Stable error identifier emitted when a device-flow attempt's `device_code` TTL elapses before approval (the controller's terminal `expired`, or the epoch+kind-scoped attempt timeout).
 */
export const AUTH_ERROR_DEVICE_EXPIRED = "device-expired";

/**
 * Stable error identifier emitted when the credentials-file token store cannot be read or rotated (EACCES/EIO, malformed sidecar, etc.).
 * Surfaced as a UI-only signed-out with a store-unavailable state - never tears down the host runtime, and never writes/deletes the file.
 */
export const AUTH_ERROR_STORE_UNAVAILABLE = "store-unavailable";

/**
 * Record of the single in-flight sign-in attempt.
 * Device flow is now the only interactive login, so there is one completion channel and one stale guard: the monotonically-increasing `epoch`.
 */
interface Attempt {
  readonly epoch: number;
  readonly abortController: AbortController;
  deviceSession: DeviceFlowSession | null;
  // Subscription to the device session's terminal result.
  // Retained so it can be disposed when the attempt is superseded, torn down, or finished - otherwise the `onResult` closure (and the IPC listener behind it) leaks.
  resultDisposable: Disposable | null;
}

/**
 * Projected device-flow progress for the GUI: the human-handled `userCode` + the verification URIs to show, and the absolute expiry so the surface can render a countdown instead of a silent spinner.
 */
export interface DeviceFlowProgress {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresAtMs: number;
  /**
   * `waiting-approval` while the `/device/token` poll is outstanding; `finalizing` once the poll returned `authorized` and the token is being validated/persisted - the surface must stop saying "Waiting for approval" the moment the approval has actually landed.
   */
  readonly phase: "waiting-approval" | "finalizing";
}

export type DeviceFlowProgressListener = (
  progress: DeviceFlowProgress | null,
) => void;

/**
 * Projected link-login poll progress for the phone's QR sign-in surface, so the approval wait is a visibly ticking loop rather than an indefinite spinner.
 * `null` whenever no link attempt is polling.
 */
export interface LinkLoginProgress {
  readonly nextPollAtMs: number;
  /**
   * `waiting` between polls; `checking` while a `/link/token` request is outstanding; `finalizing` once a poll returned `authorized` and the token is being validated/persisted - the surface must stop counting down the moment the approval has actually landed.
   */
  readonly phase: "waiting" | "checking" | "finalizing";
  /**
   * The claim's match code - the two digits the desktop's prompt is showing for THIS claim - so the phone can display them for the human to compare.
   * Constant for the life of the poll; `null` from a server that predates it, in which case the desktop is showing no code either.
   */
  readonly matchCode: string | null;
}

export type LinkLoginProgressListener = (
  progress: LinkLoginProgress | null,
) => void;

type ValidationOutcome = AuthIdentityValidationResult;

/** The result of applying a same-user `rotate` outcome to the live session: */
type SameUserRotateResult =
  | { readonly status: "rotated"; readonly token: string }
  | { readonly status: "signed-out" }
  | { readonly status: "transient" };

/** How a token finalization ended. */
type TokenApplicationOutcome = "applied" | "superseded" | "failed";

/** The link flow's terminal result for a token finalization. */
function linkResultForTokenApplication(
  outcome: TokenApplicationOutcome,
): LinkLoginSignInResult {
  switch (outcome) {
    case "applied":
      return { kind: "signed-in" };
    case "failed":
      return { kind: "failed" };
    case "superseded":
      return { kind: "superseded" };
  }
}

/**
 * GUI-owned auth.
 * Never put the raw bearer in the Zustand store; `RequestContext` is the sole runtime auth surface past the boundary.
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
   * Persistence-only retained bearer.
   * Mirrors the credential lease on the current `RequestContext` and is kept here so cross-window projection (windows-bridge) and the persisted token store can read the bearer without going through `ctx.credentials.getBearerToken()`.
   */
  private currentBearer: string | null = null;
  /**
   * The `GET /api/v3/hosts` request currently in flight, together with the bearer it was ISSUED UNDER.
   * Both halves are load-bearing - see `fetchRegisteredHosts`.
   */
  private registeredHostsInFlight: {
    readonly bearer: string;
    readonly request: Promise<HostListResponse | null>;
  } | null = null;
  private currentProfile: AuthProfile | null = null;
  /**
   * The signed-in account's subscription tier, as of the last session commit or revalidation - the SAME value projected into the auth store beside every write below, kept here so a caller can read it without React.
   */
  private currentSubscription: SubscriptionStatus | null = null;
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
  private currentForceRefreshAuthority: LiveSessionAuthority | null = null;
  // The bearer `fetchUserSessions()` already spent a repair refresh on without reaching an identified current session.
  // Skips repeating that rotation on every 30s poll/focus refetch for an unchanging bearer; a bearer change (sign-in, sign-out, or any other rotation) naturally clears this by no longer matching.
  private unrepairableSessionsBearer: string | null = null;
  // §4 reconcile worker: single-flight + trailing re-run so overlapping watcher
  // events never interleave applies. Never writes, never spends.
  private currentReconcile: Promise<void> | null = null;
  private reconcileQueued = false;
  // Bumped at the start of every reconcile; a newer reconcile drops an older one
  // after any await (mirrors identityGeneration for local mutations).
  private reconcileGeneration = 0;
  // Proactively rotates the bearer shortly before its ~4h TTL so a long-open session never carries a dead token into a live host call.
  // Constructed in the constructor; armed on every bearer (re)assignment, stopped on sign-out.
  private readonly refreshScheduler: ProactiveRefreshScheduler;
  // Teardown hooks for the OS-wake refresh listeners, released in `dispose()`.
  private readonly wakeDisposers: Array<() => void> = [];
  private disposed = false;
  // Monotonically increasing counter used to tag every sign-in attempt, so a finalizer (device poll result / expiry timeout) can detect that a newer `signIn()` has superseded the attempt it captured and drop its stale result.
  private nextEpoch: number = 0;
  // Monotonic identity-transition generation, bumped by every transition this service initiates (`signIn` / `signOut` / `dispose`) and re-checked after each await of the sign-in finalization tail (token save, local provisioning) and of `start()`'s rehydration.
  private identityGeneration: number = 0;
  // The single in-flight sign-in attempt, or null when no attempt is live.
  // Holds the main-process device poll handle so superseding the attempt cancels it.
  private activeAttempt: Attempt | null = null;
  // Projected device-flow progress (null unless a device attempt is in flight).
  private deviceProgress: DeviceFlowProgress | null = null;
  private readonly deviceProgressListeners =
    new Set<DeviceFlowProgressListener>();
  // Projected link-login poll progress (null unless a link poll is running).
  private linkLoginProgress: LinkLoginProgress | null = null;
  private readonly linkLoginProgressListeners =
    new Set<LinkLoginProgressListener>();

  private static readonly scheduleTimeout: (
    handler: () => void,
    ms: number,
  ) => number = (handler, ms) => window.setTimeout(handler, ms);

  private static readonly cancelTimeout: (handle: number) => void = (handle) =>
    window.clearTimeout(handle);
  // True while `start()` is awaiting `tokenStore.load()`.
  // A device-flow result or expiry that resolves during this window must be treated as authoritative over the persisted-token rehydration that runs after the load resolves.
  private starting: boolean = false;
  // Set when a device-flow outcome (sign-in success or terminal failure) or the expiry timeout has deterministically decided the auth state during `start()`.
  // When true, `start()` skips its "rehydrate persisted token" branch so a stale token cannot resurrect signed-in state after a failure has already projected signed-out.
  private authResolvedDuringStart: boolean = false;
  // Background stored-session recovery - the anti-latch.
  // Armed whenever an AUTOMATIC path lands on signed-out for a TRANSIENT reason (lock-busy, a refresh network blip, a sibling's still-landing spend, a store I/O fault) while the shared credentials file may still hold a refreshable session.
  private sessionRecoveryTimer: number | null = null;
  private sessionRecoveryDelayMs: number = SESSION_RECOVERY_INITIAL_DELAY_MS;
  private sessionRecoveryAttempt: number = 0;
  // Superseded-save undos whose conditional deletes have not LANDED yet (in flight or failed): each stale pair may still be durable.
  // Every adoption path must drain this set before trusting anything it reads - adopting first would resurrect exactly the zombie credential the attempt fence dropped.
  private readonly pendingUndoTokens = new Set<string>();

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
    // Watch the public auth store ONLY to relay status transitions to `onChange` listeners.
    // The store no longer carries a bearer token, so there is nothing to reconcile here - cross-window projection lands through `ingestProjectedSessionSnapshot` (the explicit persistence boundary) instead of via store mutations.
    this.authStoreUnsubscribe = useAuthStore.subscribe((state) => {
      this.emit(state.status);
    });
  }

  /**
   * Refresh the bearer on device wake, since the scheduler's `setTimeout` is frozen while the runtime is - a sleeping machine, or a WebView the OS suspends when its app leaves the foreground - and would otherwise rot the token past its TTL.
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
   * Live identity-transition generation for observing interactive sign-in, sign-out, and disposal independently of same-user credential rotations.
   */
  getIdentityGeneration(): number {
    return this.identityGeneration;
  }

  /**
   * Live credential generation - advances on every bearer change, including same-user rotations (see `RequestContextProvider.getCredentialGeneration`).
   */
  getCredentialGeneration(): number {
    return this.contextProvider.getCredentialGeneration();
  }

  /**
   * The era the live credential belongs to, for a caller that has no era of its own - an ambient poll, a focus refetch, a picker-open read.
   * Both fields are read together from committed state, so the pair is coherent even though the two sources are separate.
   */
  currentAuthEra(): AuthEra {
    return {
      identity: this.currentProfile?.userId ?? null,
      credentialGeneration: this.getCredentialGeneration(),
    };
  }

  /**
   * Cross-window projection inbound entry point used by the desktop windows bridge.
   * Each sibling window writes its persisted-session snapshot into the desktop bridge; the receiving `AuthService` ingests the snapshot here so the local `RequestContext` is minted/aborted to match.
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
        // A snapshot projected from elsewhere carries no attempt kind.
        // Naming the device flow keeps the escape hatch this path has always offered: no attempt of OURS is running, so `signIn()` supersedes nothing here.
        useAuthStore.getState().setSigningIn("device");
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
    // Capture the live bearer before the validate await.
    // A file-watcher reconcile (or local rotate) that adopts a newer token during the await bumps reconcileGeneration / currentBearer, not identityGeneration - so isIdentityCurrent alone would still pass and we'd clobber the newer file-authoritative token with a.
    const bearerBefore = this.currentBearer;
    // Access-only validation (§3): the cross-window snapshot is a UI projection, not a token write.
    // A stale projected bearer is handled by the local rotate path; here we only mint the local UI session for the same identity.
    const outcome = await this.validateToken(inboundToken);
    if (!this.isIdentityCurrent(generation)) {
      return;
    }
    if (this.currentBearer !== bearerBefore) {
      // Concurrent reconcile/rotate landed a (file-authoritative) newer bearer while we validated - defer to it.
      // A projection is never newer than the file, so dropping is always correct.
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
    // Rehydration defers to any identity transition that starts while it is in flight: an interactive `signIn()` (its outcome supersedes the stored token either way) or a `signOut()` both bump the generation and stop this flow at the next gate.
    const startGeneration = this.identityGeneration;
    this.starting = true;
    this.authResolvedDuringStart = false;
    // Set only on the provisional path, where the rehydration outlives this
    // method and owns clearing `starting` itself.
    let settlesInBackground = false;
    // Subscribe to the browser-return signal BEFORE awaiting the token load so a shell-delivered nudge that arrives during the `tokenStore.load()` microtask is not missed.
    // The signal is payload-free - it only pokes an in-flight device poll - so on a cold start with no live attempt it is a harmless no-op.
    this.callbackDisposable = this.runnerHost.onAuthCallback(() => {
      this.handleReturnSignal();
    });
    // §4: subscribe to the owned credentials-file watcher.
    // Events are a hint; the reconcile worker re-reads the store (disk is truth) and never spends.
    if (this.tokenStoreChangeDisposable === null) {
      this.tokenStoreChangeDisposable = this.tokenStore.subscribe(() => {
        this.requestReconcile();
      });
    }

    try {
      // §6: one-time migration of the legacy per-window localStorage token pair onto the shared file, BEFORE the first file read so the rehydrate below adopts the migrated session.
      // Bounded + single-flighted in main; on any fault it declines and leaves the legacy slots for a later launch.
      await this.migrateLegacyCredentialsIfPresent();
      if (this.shouldStopStartFlow(startGeneration)) {
        return;
      }
      let stored: StoredCredentials | null;
      try {
        stored = await this.tokenStore.get();
      } catch (error) {
        // Unreadable store (EACCES/EIO/…) must never escape start() - the host runtime provider would dispose the entire runtime.
        // UI-only signed-out + store-unavailable; no file write.
        this.markStoreUnavailable("start.get", error);
        return;
      }
      if (this.shouldStopStartFlow(startGeneration)) {
        return;
      }
      if (stored === null || stored.token.length === 0) {
        return;
      }

      // PAINT BEFORE VALIDATING, when there is a validated identity to paint with.
      // The awaited `validateToken` below is a cloud round trip, and the app shell renders `HostRuntimeBootFallback` until this method resolves
      const provisional = await this.applyProvisionalSession(
        stored,
        startGeneration,
      );
      if (provisional !== null) {
        // `starting` deliberately stays TRUE until this settles.
        // It exists to make an interactive sign-in that resolves mid-rehydration set `authResolvedDuringStart`, and on this path the rehydration really is still in flight after `start()` returns - clearing it here would silently narrow that guard to the part of the.
        settlesInBackground = true;
        void this.settleProvisionalSession(stored, provisional, startGeneration)
          // `validateToken` is unguarded on the awaited path too, where a rejection escapes into `start()`'s caller.
          // Nothing awaits this one, so the same rejection would surface as a process-level unhandled rejection and - worse - strand `starting` at true, which would silently disarm the `authResolvedDuringStart` guard for the rest of the session.
          .catch((error: unknown) => {
            appLogger.warn("[auth] provisional session validation threw", {
              error: describeLogError(error),
            });
          })
          .finally(() => {
            this.starting = false;
          });
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
      if (outcome.kind === "network-error") {
        // No verdict (authn unreachable) is no reason to spend: the recovery loop re-validates on backoff, and only a REJECTED verdict ever authorizes the locked rotate.
        // Rotating here instead would let a half-reachable authn (identity probe down, refresh up) burn one refresh generation per retry for pairs it can never validate.
        appLogger.warn(
          "[auth] stored session could not be validated at startup",
          {},
        );
        this.scheduleSessionRecovery("startup:validate-network");
        return;
      }
      // Invalid/expired: route to the locked rotate rather than clearing the file.
      // The rotate's own outcome is the arbiter - its refresh either lands a fresh pair, fails as a transient the recovery loop retries, or returns the definitive rejection.
      appLogger.warn("[auth] stored session access token invalid at startup", {
        outcome: outcome.kind,
      });
      await this.rotateStoredSession(
        stored,
        () => !this.shouldStopStartFlow(startGeneration),
        "startup",
      );
    } finally {
      if (!settlesInBackground) {
        this.starting = false;
      }
    }
  }

  /**
   * Applies the STORED session without waiting for the cloud to confirm it, returning the identity applied - or `null` when there is nothing safe to apply, which means "carry on and await the verdict as before".
   */
  private async applyProvisionalSession(
    stored: StoredCredentials,
    startGeneration: number,
  ): Promise<AuthenticatedUser | null> {
    // An access token this client can already see is expired cannot open anything: painting with it would move the wait from one round trip to a cascade of host 401s.
    // Fall through to the rotate path instead.
    const expiresAtMs = readAccessTokenExpiryMs(stored.token);
    if (expiresAtMs !== null && expiresAtMs <= Date.now()) {
      return null;
    }
    const snapshot = await readProvisionalSessionSnapshot(
      this.runnerHost.secureStorage,
      stored.user.id,
    );
    if (snapshot === null || this.shouldStopStartFlow(startGeneration)) {
      return null;
    }
    this.applySessionProjection(stored.token, snapshot, undefined, "defer");
    return snapshot;
  }

  /** Finishes the validation the provisional apply skipped ahead of. */
  private async settleProvisionalSession(
    stored: StoredCredentials,
    provisional: AuthenticatedUser,
    startGeneration: number,
  ): Promise<void> {
    const outcome = await this.validateToken(stored.token);
    if (
      this.shouldStopStartFlow(startGeneration) ||
      !this.currentBearerIs(stored.token)
    ) {
      return;
    }

    if (outcome.kind === "valid") {
      // NOT a second `applySignedIn`.
      // That method re-broadcasts the session to every other window, restarts the refresh scheduler and rewrites the auth store with a freshly allocated teams array, so every subscriber churns for an identity that did not change.
      this.commitSubscriptionStatus(
        outcome.user.userSubscription.subscriptionStatus,
      );
      if (outcome.user.user.id !== provisional.user.id) {
        this.applySignedIn(stored.token, outcome.user, undefined);
        return;
      }
      // Same user, but not necessarily the same PERSON-FACING identity: the provisional apply painted the CACHED snapshot, and a name, avatar or team membership changed since the last launch is only in the verdict.
      this.reprojectSameUserIdentity(outcome.user);
      void writeProvisionalSessionSnapshot(
        this.runnerHost.secureStorage,
        outcome.user,
      );
      return;
    }

    if (outcome.kind === "network-error") {
      // No verdict, and deliberately NO `scheduleSessionRecovery` - which the awaited path calls here and which would be a no-op anyway: the recovery tick's first act is to stand down for a live bearer (`already-signed-in`), and the provisional session IS one.
      appLogger.warn(
        "[auth] provisional session could not be validated at startup",
        {},
      );
      return;
    }

    // Rejected.
    // The session on screen is not real, so take it back BEFORE rotating rather than after.
    appLogger.warn("[auth] provisional session rejected at startup", {
      outcome: outcome.kind,
    });
    this.clearUiSessionIfSignedIn();
    await this.rotateStoredSession(
      stored,
      () => !this.shouldStopStartFlow(startGeneration),
      "startup:provisional",
    );
  }

  /** Whether the live credential is still the exact bearer a caller applied. */
  private currentBearerIs(bearerToken: string): boolean {
    return this.currentBearer === bearerToken;
  }

  /**
   * §6 migration pre-step.
   * Reads the legacy per-window localStorage token pair (retired in §3) one last time and hands it to the main store, which reconciles it onto the shared file and single-flights across windows.
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
      // A failed wipe is benign and idempotent: re-running migration next launch resolves to `file-wins` (a present file) or a spent → `terminal-dead` legacy pair.
      // Never break startup over it.
      appLogger.warn("[auth] legacy credentials wipe failed", {
        error: describeLogError(error),
      });
    }
  }

  /**
   * The one spend-capable re-establishment path for a stored-but-stale session, shared by startup rehydration, the background recovery loop, and the §4 reconcile (via recovery) when the file's access token no longer validates.
   */
  private async rotateStoredSession(
    stored: StoredCredentials,
    stillWanted: () => boolean,
    trigger: string,
  ): Promise<void> {
    let rotated: TokenRotateResult;
    try {
      rotated = await this.tokenStore.rotate({
        userId: stored.user.id,
        token: stored.token,
      });
    } catch (error) {
      if (!stillWanted() || this.hasLiveBearer()) {
        return;
      }
      this.markStoreUnavailable(`${trigger}.rotate`, error);
      return;
    }
    if (!stillWanted() || this.hasLiveBearer()) {
      return;
    }
    appLogger.info("[auth] stored-session rotate outcome", {
      trigger,
      outcome: rotated.outcome,
    });
    const pair = rotatedLivePair(rotated);
    // `commit-failed` can surface a process-wide pending continuation for a *different* user (one main-process store shared across windows).
    // Never adopt a foreign pair into this session.
    if (pair !== null && pair.user.id === stored.user.id) {
      // The rotated pair carries only the cached identity; re-validate it
      // (access-only) to mint the full `AuthenticatedUser` the context needs.
      const revalidated = await this.validateToken(pair.token);
      if (!stillWanted() || this.hasLiveBearer()) {
        return;
      }
      if (revalidated.kind === "valid") {
        // Same deletion race as the recovery path: our locked rotate committed this pair, but an explicit sign-out can land (and delete the file) while the identity probe is in flight.
        if (!(await this.storedSessionStillOnDisk(pair.token))) {
          this.scheduleSessionRecovery(`${trigger}:rotated-pair-superseded`);
          return;
        }
        if (!stillWanted() || this.hasLiveBearer()) {
          return;
        }
        this.settleSessionRecovery("recovered");
        this.applySignedIn(pair.token, revalidated.user, undefined);
        return;
      }
      if (revalidated.kind === "network-error") {
        // The rotated pair is committed on disk; only the identity probe blipped.
        // Signed-out UI for now - the retry re-validates without spending anything.
        this.clearUiSessionIfSignedIn();
        this.scheduleSessionRecovery(`${trigger}:post-rotate-network`);
        return;
      }
      // A freshly-rotated pair the server rejects outright: terminal
      // server-side state (epoch revoke / sign-out-everywhere).
      this.setLastError(AUTH_ERROR_SESSION_EXPIRED);
      this.clearUiSessionIfSignedIn();
      this.settleSessionRecovery("rotated-pair-rejected");
      return;
    }
    this.applyUnadoptedStoredRotateOutcome(rotated.outcome, trigger);
  }

  /**
   * Tail of {@link rotateStoredSession} for every outcome that did NOT yield an adoptable same-user pair: terminal ones settle the recovery loop, transient ones re-arm it.
   */
  private applyUnadoptedStoredRotateOutcome(
    outcome: TokenRotateOutcome,
    trigger: string,
  ): void {
    switch (outcome) {
      case "refresh-rejected":
        // Genuine dead credential: "session expired" copy, file kept.
        this.setLastError(AUTH_ERROR_SESSION_EXPIRED);
        this.clearUiSessionIfSignedIn();
        this.settleSessionRecovery("refresh-rejected");
        return;
      case "deleted":
      case "tombstoned":
      case "user-mismatch":
        // A sign-out stands or the file changed accounts - both settled; the
        // §4 watch projects any newer state when it lands.
        this.clearUiSessionIfSignedIn();
        this.settleSessionRecovery(outcome);
        return;
      case "lock-busy":
      case "spend-pending":
      case "refresh-network":
      case "applied":
      case "superseded":
      case "commit-failed":
        // Transient.
        // (`applied`/`superseded`/`commit-failed` land here only when the adopt guard declined a null or foreign-user pair from the shared main-process store.)
        this.clearUiSessionIfSignedIn();
        this.scheduleSessionRecovery(`${trigger}:${outcome}`);
        return;
    }
  }

  /**
   * Whether a live bearer is installed.
   * A method (not a direct field read) so checks that straddle `await`s re-read the CURRENT value - TypeScript's narrowing of the mutable field would otherwise flag (and a reader would misjudge) the re-checks as tautological.
   */
  private hasLiveBearer(): boolean {
    return this.currentBearer !== null;
  }

  /**
   * Arm (or extend) the background recovery loop.
   * One timer, exponential backoff, generation-fenced: a user sign-in/sign-out that lands while a tick is pending makes the tick a no-op via `isIdentityCurrent`.
   */
  private scheduleSessionRecovery(trigger: string): void {
    if (this.disposed || this.sessionRecoveryTimer !== null) {
      return;
    }
    const delayMs = this.sessionRecoveryDelayMs;
    this.sessionRecoveryDelayMs = Math.min(
      delayMs * 2,
      SESSION_RECOVERY_MAX_DELAY_MS,
    );
    this.sessionRecoveryAttempt += 1;
    appLogger.info("[auth] stored-session recovery scheduled", {
      trigger,
      delayMs,
      attempt: this.sessionRecoveryAttempt,
    });
    const generation = this.identityGeneration;
    this.sessionRecoveryTimer = AuthService.scheduleTimeout(() => {
      this.sessionRecoveryTimer = null;
      void this.runSessionRecovery(generation);
    }, delayMs);
  }

  /** Disarm the loop and reset the backoff - the session state is settled. */
  private settleSessionRecovery(reason: string): void {
    if (this.sessionRecoveryTimer !== null) {
      AuthService.cancelTimeout(this.sessionRecoveryTimer);
      this.sessionRecoveryTimer = null;
    }
    if (this.sessionRecoveryAttempt > 0) {
      appLogger.info("[auth] stored-session recovery settled", { reason });
    }
    this.sessionRecoveryDelayMs = SESSION_RECOVERY_INITIAL_DELAY_MS;
    this.sessionRecoveryAttempt = 0;
  }

  /**
   * One recovery tick: re-read the file, validate access-only, and either adopt, spend through the locked rotate, or re-arm.
   * Stands down for a live session, an interactive attempt, or an emptied file.
   */
  private async runSessionRecovery(generation: number): Promise<void> {
    if (!this.isIdentityCurrent(generation)) {
      return;
    }
    if (this.hasLiveBearer()) {
      this.settleSessionRecovery("already-signed-in");
      return;
    }
    if (
      this.activeAttempt !== null ||
      useAuthStore.getState().status === "signing-in"
    ) {
      // Never race an interactive sign-in; its success settles the loop via
      // `applySignedIn`, its failure leaves the next tick to try again.
      this.scheduleSessionRecovery("recovery:interactive-attempt");
      return;
    }
    // A failed superseded-save undo left a stale pair durable.
    // Complete that conditional delete BEFORE reading anything to adopt - otherwise this very loop would validate and re-adopt the zombie the fence dropped.
    if (await this.pendingUndoBlocksAdoption("recovery")) {
      return;
    }
    let stored: StoredCredentials | null;
    try {
      stored = await this.tokenStore.get();
    } catch (error) {
      if (!this.isIdentityCurrent(generation)) {
        return;
      }
      appLogger.warn("[auth] stored-session recovery could not read store", {
        error: describeLogError(error),
      });
      this.scheduleSessionRecovery("recovery:store-unavailable");
      return;
    }
    if (!this.isIdentityCurrent(generation) || this.hasLiveBearer()) {
      return;
    }
    if (stored === null || stored.token.length === 0) {
      this.settleSessionRecovery("no-stored-session");
      return;
    }
    const outcome = await this.validateToken(stored.token);
    if (!this.isIdentityCurrent(generation) || this.hasLiveBearer()) {
      return;
    }
    if (outcome.kind === "valid") {
      await this.adoptRecoveredStoredSession(stored, outcome.user, generation);
      return;
    }
    if (outcome.kind === "network-error") {
      // No verdict is no reason to spend: re-validate on the next tick.
      // Only a REJECTED verdict authorizes the locked rotate - otherwise a half-reachable authn (identity probe down, refresh up) would rotate the freshly-committed pair again on every tick, burning one refresh generation per backoff step for pairs it can never.
      this.scheduleSessionRecovery("recovery:validate-network");
      return;
    }
    await this.rotateStoredSession(
      stored,
      () => this.isIdentityCurrent(generation),
      "recovery",
    );
  }

  /**
   * Tail of {@link runSessionRecovery} for a stored session the server just called valid: confirm the file still holds it, then sign in.
   * Extracted so the recovery tick stays under the complexity ceiling.
   */
  private async adoptRecoveredStoredSession(
    stored: StoredCredentials,
    user: AuthenticatedUser,
    generation: number,
  ): Promise<void> {
    if (!(await this.storedSessionStillOnDisk(stored.token))) {
      // A sign-out (or a sibling rotation) landed while `/user` was in flight.
      // Re-arm rather than settle: if the file is gone the next tick reads null and settles on `no-stored-session`; if it was rotated the next tick adopts the CURRENT pair.
      this.scheduleSessionRecovery("recovery:stored-session-superseded");
      return;
    }
    if (!this.isIdentityCurrent(generation) || this.hasLiveBearer()) {
      return;
    }
    // Same adoption-time fence re-check as the reconcile tail: an undo that
    // registered while this tick's validation was in flight must win.
    if (this.pendingUndoTokens.size > 0) {
      this.scheduleSessionRecovery("recovery:pending-undo");
      return;
    }
    this.settleSessionRecovery("recovered");
    this.applySignedIn(stored.token, user, undefined);
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
   * True while `generation` is still the live identity transition (and the service is not disposed).
   * Async credential tails capture the generation before their first await and re-check through this after each one, so a newer `signIn()` / `signOut()` / `dispose()` always wins over an already-started save/rotate/provision.
   */
  private isIdentityCurrent(generation: number): boolean {
    return !this.disposed && generation === this.identityGeneration;
  }

  /** Re-read the file and confirm it still carries `token` before an AUTOMATIC path adopts it into a signed-in UI. */
  private async storedSessionStillOnDisk(token: string): Promise<boolean> {
    try {
      const latest = await this.tokenStore.get();
      return latest !== null && latest.token === token;
    } catch {
      return false;
    }
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

  private captureLiveSessionAuthority(): LiveSessionAuthority | null {
    const ctx = this.contextProvider.current();
    const bearer = this.currentBearer;
    if (ctx === null || ctx.credentials.isReleased || bearer === null) {
      return null;
    }
    return {
      credentials: ctx.credentials,
      userId: ctx.identity.userId,
      bearer,
      generation: this.identityGeneration,
    };
  }

  private isLiveSessionAuthority(expected: LiveSessionAuthority): boolean {
    const ctx = this.contextProvider.current();
    return (
      !this.disposed &&
      this.identityGeneration === expected.generation &&
      ctx !== null &&
      ctx.identity.userId === expected.userId &&
      ctx.credentials === expected.credentials &&
      !ctx.credentials.isReleased &&
      this.currentBearer === expected.bearer
    );
  }

  private captureUpdatedSessionAuthority(
    expected: LiveSessionAuthority,
  ): LiveSessionAuthority | null {
    const current = this.captureLiveSessionAuthority();
    if (
      current === null ||
      current.generation !== expected.generation ||
      current.userId !== expected.userId ||
      current.credentials !== expected.credentials
    ) {
      return null;
    }
    return current;
  }

  /**
   * Primary (and only) interactive sign-in: the OAuth 2.0 Device Authorization Grant (RFC 8628).
   * `beginAttempt` first supersedes any in-flight attempt (a stalled retry the user is abandoning) - aborting it and cancelling its main-process device poll - so a stale poll resolving later is dropped by epoch.
   */
  async signIn(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.identityGeneration += 1;
    // Explicit user intent replaces the automatic loop: a pending recovery tick would only race the attempt (it stands down, but its timer would fire a stale no-op).
    // A failed attempt re-arms recovery (applyFailure); a successful one settles it again (applySignedIn).
    this.settleSessionRecovery("interactive-attempt");
    this.setLastError(null);
    const attempt = this.beginAttempt();
    useAuthStore.getState().setSigningIn("device");
    this.runnerHost.beginAuthAttempt();
    let session: DeviceFlowSession | null;
    try {
      session = await this.runnerHost.deviceFlow.start();
    } catch {
      // A rejected `start()` (host/IPC failure) must route to the SAME launch-failed cleanup as a `null` return - otherwise the UI stays stuck in `signing-in` with a live attempt that never settles.
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
      phase: "waiting-approval",
    });
    // The attempt times out at the `device_code` TTL (`expires_in`); the handler is epoch-scoped so a superseded attempt's timer can't kill a newer one.
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
    // Stop the proactive refresh timer up front so a timer firing during the delete can't race a `rotate` against the credential removal; the recovery loop stands down for the same reason (explicit intent settles it - nothing to recover after a deliberate sign-out).
    this.refreshScheduler.stop();
    this.settleSessionRecovery("explicit-sign-out");
    this.clearPendingTimeout();
    // Tear down any in-flight attempt: abort it and cancel its main-process
    // device poll so no ~10-minute poll leaks.
    this.discardActiveAttempt();
    // The single file-destroying path in the app (the other is `traycer logout`).
    // `delete()` rejects if the delete cannot land; a failed sign-out must stay signed in and surface, never falsely report signed-out (§5).
    const deleteError = await this.tokenStore.delete().then(
      () => null,
      (error: unknown) => error ?? new Error("sign-out delete rejected"),
    );
    // dispose() may have landed during the delete await - re-read fresh.
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
    // Published chat bytes do not survive leaving the account.
    void clearChatPartCache(browserChatPartCacheStorage());
    // Drop any in-flight reconcile that raced the delete chain (a superseded finalization's signIn may have re-written the file and notified before delete landed; its adopt must not resurrect signed-in after we cleared).
    this.reconcileGeneration += 1;
  }

  /**
   * Returns the `RequestContextProvider` boundary surface host / runtime consumers subscribe to.
   * The provider's `current()` always reflects the live authenticated context (or `null` when signed out), and `onChange(...)` fires on every identity transition (sign-in / sign-out / cross-user).
   */
  getRequestContextProvider(): RequestContextProvider {
    return this.contextProvider;
  }

  /**
   * Returns the current persisted-session snapshot for cross-window projection callers (windows-bridge).
   * This is a persistence boundary - host / runtime consumers must NOT read the bearer here; they thread the `RequestContext` from `getRequestContextProvider()`.
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
   * Subscribes to session-snapshot transitions for cross-window projection callers.
   * The handler is invoked synchronously on subscribe with the current snapshot (matching the `IRunnerHost.onLocalHostChange` convention) and again on every signed-in / signing-in / signed-out transition.
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
   * Cross-window projection inbound entry point.
   * Called by the desktop windows bridge when another window's `AuthService` projects a session change through the desktop session bridge.
   */
  applyExternalSession(session: ExternalSession): void {
    if (this.disposed) {
      return;
    }
    if (session.status === "signing-in") {
      // As above: an external session's attempt kind is not carried.
      useAuthStore.getState().setSigningIn("device");
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
      // COMMIT BEFORE EMIT (see `applySignedIn`) - the rotation notification below is synchronous, and this projection path rotates just as often as the local ones.
      this.commitLiveCredential(session.token, session.profile);
      this.commitSubscriptionStatus(
        session.user.userSubscription.subscriptionStatus,
      );
      this.contextProvider.rotateCurrentBearer({
        userId: currentUserId,
        bearerToken: session.token,
      });
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
      this.emitSessionSnapshot();
      this.refreshScheduler.start();
      return;
    }
    this.applySignedIn(session.token, session.user, session.profile);
  }

  /** Re-validates the current authenticated session against AuthnV3. */
  async revalidateCurrentContext(): Promise<ValidationOutcome | null> {
    const expected = this.contextProvider.current()?.credentials ?? null;
    if (expected === null) {
      return null;
    }
    return this.revalidateExpectedContext(expected);
  }

  /**
   * Revalidates only the credential object that produced an unauthorized host frame.
   * A session replacement never joins the old single-flight operation and cannot be mutated by its eventual result.
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
   * Both paths spend the same single-use refresh token, so overlapping would double-spend it and sign the user out on the loser path.
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
   * Fetches the full `AuthenticatedUser` (identity + credits + team subscriptions) for the signed-in session by revalidating the current context against AuthnV3's `/api/v3/user`.
   * Returns `null` when signed-out or when validation does not yield a user (`rejected` / no live context).
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
    // `network-error`: a transient outage that did NOT sign the user out.
    // Throw so TanStack Query surfaces a retryable error on the panel (refresh button) instead of a misleading "no subscription" empty state.
    throw new Error("Couldn't reach Traycer to load your subscription.");
  }

  /**
   * Fetches the signed-in user's host registry + live status via the runner host (`GET /api/v3/hosts`, run in Electron main for CORS).
   * Mirrors {@link fetchAuthenticatedUser}: the raw bearer stays inside this service (the auth boundary), so the My Hosts query hook consumes the parsed envelope without ever touching the token.
   */
  async fetchRegisteredHosts(era: AuthEra): Promise<HostListResponse | null> {
    // THE ISSUE-TIME CREDENTIAL CHECK, and it lives here because this is where the credential is read.
    // Every previous attempt to fence this refresh put the check one layer up - on the memo, on the commit - and each time the request still went out under a bearer belonging to somebody else, because the layer doing the checking never saw which credential the.
    const liveEra = this.currentAuthEra();
    if (
      liveEra.identity !== era.identity ||
      liveEra.credentialGeneration !== era.credentialGeneration
    ) {
      appLogger.debug("[auth] refusing a hosts read for a superseded era", {
        requestedIdentity: era.identity,
        requestedGeneration: era.credentialGeneration,
        liveGeneration: liveEra.credentialGeneration,
      });
      throw new SupersededAuthEraError();
    }
    if (this.currentBearer === null) {
      return null;
    }
    // Two independent callers reach this endpoint: the globally-mounted `HostDirectoryService` poll and the Settings liveness query, plus their event triggers (focus refetch, picker open, context change).
    const bearer = this.currentBearer;
    const inFlight = this.registeredHostsInFlight;
    if (inFlight !== null && inFlight.bearer === bearer) {
      return inFlight.request;
    }
    const request = this.performFetchRegisteredHosts(bearer);
    this.registeredHostsInFlight = { bearer, request };
    try {
      return await request;
    } finally {
      this.releaseRegisteredHostsSlot(request);
    }
  }

  /** Clears the in-flight slot, but only if it is still OURS. */
  private releaseRegisteredHostsSlot(
    request: Promise<HostListResponse | null>,
  ): void {
    if (this.registeredHostsInFlight?.request === request) {
      this.registeredHostsInFlight = null;
    }
  }

  private async performFetchRegisteredHosts(
    bearer: string,
  ): Promise<HostListResponse | null> {
    const result = await this.runnerHost.listRegisteredHosts(bearer);
    if (result.kind === "unauthorized") {
      return null;
    }
    if (result.kind === "network-error") {
      throw new Error("Couldn't reach Traycer to load your hosts.");
    }
    return result.response;
  }

  /**
   * Fetches the signed-in user's device/session list via authn-v3.
   * The raw bearer remains inside this auth boundary; callers consume a parsed DTO from TanStack Query and render signed-out as an empty state.
   */
  async fetchUserSessions(
    signal: AbortSignal,
  ): Promise<ListUserSessionsResponse | null> {
    signal.throwIfAborted();
    const initialAuthority = this.captureLiveSessionAuthority();
    if (initialAuthority === null) {
      return null;
    }
    const initial = await this.runnerHost.listUserSessions(
      initialAuthority.bearer,
      signal,
    );
    // This is the fence that keeps a cancelled read out of the repair below: everything between here and the rotation is synchronous, so bailing here is the same as bailing there.
    signal.throwIfAborted();
    if (!this.isLiveSessionAuthority(initialAuthority)) {
      return null;
    }
    if (initial.kind === "network-error") {
      throw new Error("Couldn't reach Traycer to load your sessions.");
    }
    if (
      initial.kind === "ok" &&
      initial.response.sessions.some(
        (session) => session.current && session.clientKind !== "unknown",
      )
    ) {
      this.unrepairableSessionsBearer = null;
      return initial.response;
    }

    // A prior repair already rotated this exact bearer without reaching an identified current session (e.g. the server-side condition is stuck, not transient).
    // Repeating the rotate on every 30s poll/focus refetch would keep spending `/api/v3/auth/refresh` against an unchanging bearer forever and permanently error the panel; return what we have instead.
    if (
      initial.kind === "ok" &&
      this.unrepairableSessionsBearer === initialAuthority.bearer
    ) {
      return initial.response;
    }

    // A still-valid credential from before individual session tracking has no row/family yet, and the original upgrader recorded an existing desktop row as `unknown`.
    // Listing used to turn either case into an authoritative empty/unknown UI.
    const repairedAuthority =
      await this.forceRefreshExpectedSession(initialAuthority);
    if (repairedAuthority === null) {
      return null;
    }

    const repaired = await this.runnerHost.listUserSessions(
      repairedAuthority.bearer,
      signal,
    );
    signal.throwIfAborted();
    if (!this.isLiveSessionAuthority(repairedAuthority)) {
      return null;
    }
    if (repaired.kind === "network-error") {
      throw new Error("Couldn't reach Traycer to load your sessions.");
    }
    if (repaired.kind === "unauthorized") {
      if (useAuthStore.getState().status === "signed-in") {
        throw new Error("Couldn't refresh your signed-in session.");
      }
      return null;
    }
    const hasIdentifiedCurrentSession = repaired.response.sessions.some(
      (session) => session.current && session.clientKind !== "unknown",
    );
    if (!hasIdentifiedCurrentSession) {
      this.unrepairableSessionsBearer = repairedAuthority.bearer;
      throw new Error("Couldn't register this signed-in session yet.");
    }
    this.unrepairableSessionsBearer = null;
    return repaired.response;
  }

  /**
   * Revokes one session family.
   * `useStepUpCredential` is false for the first attempt; if authn responds `step-up-required`, the UI verifies an OTP and retries by asking the runner-host boundary to attach its retained step-up bearer internally.
   */
  async revokeUserSession(
    familyId: string,
    useStepUpCredential: boolean,
  ): Promise<RevokeUserSessionFetchResult> {
    if (this.currentBearer === null) {
      return { kind: "unauthorized" };
    }
    return this.runnerHost.revokeUserSession(
      this.currentBearer,
      familyId,
      useStepUpCredential,
    );
  }

  /**
   * Global sign-out is intentionally tighter than per-session cleanup: callers verify a fresh step-up challenge for each invocation, then the runner-host boundary attaches and clears the retained step-up bearer internally.
   */
  async revokeAllSessions(): Promise<RevokeAllSessionsFetchResult> {
    if (this.currentBearer === null) {
      return { kind: "unauthorized" };
    }
    return this.runnerHost.revokeAllSessions(this.currentBearer);
  }

  /**
   * Mints a device credential for a connected host.
   * A single attempt on the ordinary bearer: unlike `revokeUserSession` there is no step-up retry, because the mint is not step-up gated (see the mint route's doc comment).
   */
  async mintHostCredential(
    request: MintHostCredentialRequest,
  ): Promise<MintHostCredentialFetchResult> {
    if (this.currentBearer === null) {
      return { kind: "unauthorized" };
    }
    return this.runnerHost.mintHostCredential(this.currentBearer, request);
  }

  async requestStepUpChallenge(): Promise<StepUpChallengeFetchResult> {
    if (this.currentBearer === null) {
      return { kind: "unauthorized" };
    }
    return this.runnerHost.requestStepUpChallenge(this.currentBearer);
  }

  /**
   * Mints a one-time link-login code for the "Link mobile app" QR surface.
   * The raw bearer stays inside this auth boundary; the panel consumes only the short-lived one-time code, which is itself the thing being displayed.
   */
  async mintLinkLoginCode(
    signal: AbortSignal,
  ): Promise<MintLinkLoginCodeFetchResult> {
    if (this.currentBearer === null) {
      return { kind: "unauthorized" };
    }
    return this.runnerHost.mintLinkLoginCode(this.currentBearer, signal);
  }

  async verifyStepUpChallenge(
    code: string,
  ): Promise<RetainedStepUpVerifyFetchResult> {
    if (this.currentBearer === null) {
      return { kind: "unauthorized" };
    }
    return this.runnerHost.verifyStepUpChallenge(this.currentBearer, code);
  }

  /**
   * "Update now" / auto-update policy toggle / "Apply now - ends N sessions" (Remote Host Support §13, T16): `PATCH /api/v3/hosts/:hostId` via the runner host (run in Electron main for CORS, mirroring {@link fetchRegisteredHosts}).
   */
  async updateHostVersionPolicy(
    hostId: string,
    input: UpdateHostVersionPolicyInput,
  ): Promise<UpdateHostVersionPolicyFetchResult> {
    if (this.currentBearer === null) {
      throw new Error("Sign in to update this host.");
    }
    return this.runnerHost.updateHostVersionPolicy(
      this.currentBearer,
      hostId,
      input,
    );
  }

  /**
   * "Remove from account": `POST /api/v3/hosts/:hostId/deregister` via the runner host (run in Electron main for CORS, mirroring {@link fetchRegisteredHosts}).
   * Throws on signed-out for the same reason {@link updateHostVersionPolicy} does - a mutation issued with no bearer is a caller bug, not a state to render.
   */
  async deregisterHostFromAccount(
    hostId: string,
  ): Promise<DeregisterHostFetchResult> {
    if (this.currentBearer === null) {
      throw new Error("Sign in to remove this host.");
    }
    return this.runnerHost.deregisterHostFromAccount(
      this.currentBearer,
      hostId,
    );
  }

  private async revalidateCurrentContextOnce(
    expected: OpenFrameBearerSource,
  ): Promise<ValidationOutcome | null> {
    if (this.isDisposed()) {
      return null;
    }
    // Same fence as the sign-in finalization: a signOut()/newer signIn() landing during any await below owns the state - this revalidation must not re-persist or re-project the identity it started with.
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
      // Subscription entitlement can change without a bearer rotation (for example after a purchase or restore).
      // Project every successful validation so entitlement-gated surfaces react without an app restart.
      this.commitSubscriptionStatus(
        outcome.user.userSubscription.subscriptionStatus,
      );
      if (outcome.user.user.id !== currentUserId) {
        // The bearer now validates to a different user (a cross-user re-seed) -
        // treat as a fresh sign-in so the old context aborts cleanly.
        this.applySignedIn(currentToken, outcome.user, undefined);
      } else {
        // Same argument as the subscription commit above, applied to the rest of the person-facing identity: a display name, avatar or team membership can change without a bearer rotation, and projecting only entitlement left every other field one launch stale.
        this.reprojectSameUserIdentity(outcome.user);
        // ...and DURABLY, which the projection alone is not.
        // `applySignedIn` is the only other writer of this snapshot and this path deliberately avoids it, so nothing else on this branch persists anything: the next launch paints the cached identity again, and if that launch's validation takes the accepted.
        void writeProvisionalSessionSnapshot(
          this.runnerHost.secureStorage,
          outcome.user,
        );
      }
      return outcome;
    }
    if (outcome.kind === "rejected") {
      // The access token is stale/expired: run the locked rotate (the spend).
      appLogger.warn("[auth] current session access token stale; rotating", {});
      return this.rotateLiveSession(currentUserId, currentToken, generation);
    }
    // Only `network-error` remains - the valid/rejected arms returned above.
    appLogger.warn("[auth] current session revalidation hit network error", {});
    return outcome;
  }

  /**
   * Same-user rotation of the LIVE session (reactive 401 path): run the locked `rotate`, rotate the credential lease in place on success (observably silent on the provider), and hand back the fresh identity outcome so callers that need the full user (the.
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
    const result = this.applyLiveRotateOutcome(
      rotated,
      userId,
      generation,
      "reactive",
    );
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

  // Rotate the live credential lease in place onto `bearerToken` - observably silent on the provider, so host-runtime / cache state survives - and re-arm the refresh scheduler.
  // The single point every same-user adoption goes through (locked-rotate outcomes and the §4 reconcile worker).
  private rotateLiveBearer(userId: string, bearerToken: string): void {
    // NO server-time sample here, deliberately.
    // This is the generic lease-adoption helper, and MOST of what it adopts is not freshly minted: `applyReconciledOutcome` passes a token read straight off disk, and the `superseded`/`commit-failed` rotate arms adopt a pair some other window already committed.
    this.commitLiveCredential(bearerToken, this.currentProfile);
    this.contextProvider.rotateCurrentBearer({ userId, bearerToken });
    this.emitSessionSnapshot();
    this.refreshScheduler.start();
  }

  // Adopt a rotated pair into the live session, but ONLY while the live context is still the user we rotated for.
  // A cross-user transition can land between the rotate dispatch and here without bumping the generation (device-flow ingest), and the R9 first-gate can hand back a foreign-user pending pair from the shared main-process store; both are rejected here (→.
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
   * Applies a same-user `rotate` outcome to the LIVE session (shared by the reactive and proactive paths).
   * On a live pair it rotates the credential lease in place - observably silent on the provider, so host-runtime / cache state survives - and re-arms the scheduler.
   */
  private applyLiveRotateOutcome(
    rotated: TokenRotateResult,
    userId: string,
    generation: number,
    trigger: string,
  ): SameUserRotateResult {
    appLogger.info("[auth] live rotate outcome", {
      trigger,
      outcome: rotated.outcome,
    });
    switch (rotated.outcome) {
      case "applied": {
        // THE server-time sample site, and the only one: `applied` means THIS process's locked rotate just spent the refresh against authn and committed the pair it minted, so the token is seconds old and its `iat` IS authn's clock.
        const applied = this.adoptRotatedPairIntoLiveSession(
          rotated.pair,
          userId,
          generation,
        );
        if (applied.status === "rotated") {
          recordRotatedBearer(applied.token);
        }
        return applied;
      }
      case "superseded":
      case "commit-failed":
        // `superseded` is same-user by the store's user-mismatch-before-token guard; `commit-failed` can carry a foreign-user pending pair from the shared main-process store (R9 first-gate).
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
      case "spend-pending":
      case "refresh-network":
        // Transient; the access token in hand stays valid for its TTL.
        return { status: "transient" };
    }
  }

  /**
   * UI-only sign-out: abort the live context + project signed-out WITHOUT touching the shared credentials file (only explicit user intent destroys it, settled decision).
   * Used by every automatic failure path; the §4 watch re-adopts if a sibling rotation later lands.
   */
  private clearUiSession(): void {
    this.applySignedOut();
  }

  // Clear the UI session only when one is actually projected - avoids a redundant
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
   * Credentials-file store fault (EACCES/EIO/malformed sidecar/…): surface store-unavailable and project a UI-only signed-out.
   * Never rethrows - a fault must not tear down HostRuntimeProvider's startup, and never writes or deletes the shared file.
   */
  private markStoreUnavailable(context: string, error: unknown): void {
    appLogger.warn(`[auth] token store unavailable (${context})`, {
      error: describeLogError(error),
    });
    this.setLastError(AUTH_ERROR_STORE_UNAVAILABLE);
    this.clearUiSession();
    // Every store fault is transient from the session's point of view, so the signed-out projection must never latch: arm the recovery loop here, at the one seam every fault path passes through (the loop's own store read keeps re-arming it while the fault.
    this.scheduleSessionRecovery(`${context}:store-unavailable`);
  }

  /**
   * §4 reconcile worker trigger.
   * Single-flight with a trailing re-run so overlapping watcher events collapse to one re-read after the in-flight reconcile settles.
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

  /** VALIDATE-ONLY re-adoption from the credentials file: */
  private async runReconcileOnce(): Promise<void> {
    if (this.isDisposed()) {
      return;
    }
    // Same fence as the recovery tick: a self-write watcher echo from the very save whose undo is pending must not become the adoption path that resurrects it.
    // Runs before the generation capture so a fresh reconcile request during the retry supersedes this pass normally.
    if (await this.pendingUndoBlocksAdoption("reconcile")) {
      return;
    }
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

    // Never clobber an interactive sign-in attempt (device flow in flight).
    // A concurrent self-write notify from a superseded finalization's signIn must not project signed-in over the newer attempt's signing-in state.
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
    // A local rotate may have adopted this bearer while we validated - same no-op as the pre-validate check (avoids applySignedIn aborting the live context the reactive path just rotated in place).
    if (stored.token === this.currentBearer) {
      return;
    }
    // Adoption-time fence re-check (synchronous - no interleave between it and the projection below): the entry fence can pass BEFORE a superseding finalization even begins its undo, since this reconcile was triggered by that very write's watcher echo.
    if (this.pendingUndoTokens.size > 0) {
      this.scheduleSessionRecovery("reconcile:pending-undo");
      return;
    }
    await this.projectReconciledSnapshot(
      stored,
      outcome,
      identityGen,
      reconcileGen,
    );
  }

  /**
   * Adoption tail of {@link runReconcileOnce}, after every local fence has passed: a STORE re-read mirroring the recovery path's `storedSessionStillOnDisk`.
   * The local pending-undo set only knows THIS window's undos - another window's undo registers its quarantine at the store authority, whose reads then stop serving the pair - so the validated snapshot is projected only if the store still serves it.
   */
  private async projectReconciledSnapshot(
    stored: StoredCredentials,
    outcome: ValidationOutcome,
    identityGen: number,
    reconcileGen: number,
  ): Promise<void> {
    if (!(await this.storedSessionStillOnDisk(stored.token))) {
      this.scheduleSessionRecovery("reconcile:stored-session-superseded");
      return;
    }
    if (!this.isReconcileCurrent(identityGen, reconcileGen)) {
      return;
    }
    this.applyReconciledOutcome(stored, outcome);
  }

  /**
   * Projects a reconcile's access-only validation result onto the UI session (never writes/spends itself).
   * Same-user → rotate the lease in place (host-runtime / cache state survives); signed-out→present or account switch → full signed-in projection; network blip → leave the live session intact; invalid/expired → UI-only sign-out plus a recovery-loop handoff.
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
      // Transient: cannot adopt an unvalidated bearer, and a live session is never torn down over a blip.
      // With NO live session there is also no later file event guaranteed (authn recovering writes nothing), so the adoption is handed to the recovery loop instead of dropped.
      if (!this.hasLiveBearer()) {
        this.scheduleSessionRecovery("reconcile:validate-network");
      }
      return;
    }
    // Invalid/expired but PRESENT: the file may still hold a perfectly refreshable session (a 4h-expired access token next to a 30d refresh token).
    // Sign the UI out now and hand the spend to the recovery loop, which owns the locked rotate - never latch signed-out over a file that one refresh call away from a live session.
    this.clearUiSessionIfSignedIn();
    this.scheduleSessionRecovery("reconcile:rejected");
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
   * Proactively rotates the access token ahead of its TTL.
   * Driven by the refresh scheduler shortly before `exp`, so a still-valid-but-soon-to-expire bearer is renewed before the host's connection-captured copy can go stale (the overnight-session 401).
   */
  private forceRefresh(): Promise<void> {
    const expected = this.captureLiveSessionAuthority();
    if (expected === null) {
      return Promise.resolve();
    }
    return this.forceRefreshExpectedSession(expected).then(() => undefined);
  }

  /**
   * Refresh only the session authority supplied by the caller.
   * This is used by the session-list repair so a late response for account A cannot rotate or clear the credential that account B installed in the meantime.
   */
  private async forceRefreshExpectedSession(
    expected: LiveSessionAuthority,
  ): Promise<LiveSessionAuthority | null> {
    if (!this.isLiveSessionAuthority(expected)) {
      return null;
    }
    if (this.currentForceRefresh !== null) {
      const activeAuthority = this.currentForceRefreshAuthority;
      if (
        activeAuthority === null ||
        activeAuthority.generation !== expected.generation ||
        activeAuthority.userId !== expected.userId ||
        activeAuthority.credentials !== expected.credentials
      ) {
        return null;
      }
      await this.currentForceRefresh;
      return this.captureUpdatedSessionAuthority(expected);
    }
    const op = this.forceRefreshOnce(expected).finally(() => {
      if (this.currentForceRefresh === op) {
        this.currentForceRefresh = null;
        this.currentForceRefreshAuthority = null;
      }
    });
    this.currentForceRefresh = op;
    this.currentForceRefreshAuthority = expected;
    await op;
    return this.captureUpdatedSessionAuthority(expected);
  }

  private async forceRefreshOnce(
    expected: LiveSessionAuthority,
  ): Promise<void> {
    if (!this.isLiveSessionAuthority(expected)) {
      return;
    }
    // Defer to an in-flight reactive revalidation.
    // Both paths drive the locked `rotate`; awaiting here serializes the proactive and reactive refreshes within this process, and the file lock serializes across processes - so at most one process ever spends a given refresh token.
    if (this.currentRevalidation !== null) {
      await this.currentRevalidation;
      if (!this.isLiveSessionAuthority(expected)) {
        return;
      }
    }
    let rotated: TokenRotateResult;
    try {
      rotated = await this.tokenStore.rotate({
        userId: expected.userId,
        token: expected.bearer,
      });
    } catch (error) {
      if (!this.isLiveSessionAuthority(expected)) {
        return;
      }
      this.markStoreUnavailable("proactive.rotate", error);
      return;
    }
    if (!this.isLiveSessionAuthority(expected)) {
      return;
    }
    // `superseded` here adopts a sibling's rotation without spending; `deleted`/ `user-mismatch`/`tombstoned` clear the UI session (no resurrection); `refresh-rejected` is the genuine expiry; transient outcomes leave the bearer for the reactive path.
    this.applyLiveRotateOutcome(
      rotated,
      expected.userId,
      expected.generation,
      "proactive",
    );
  }

  /**
   * Shared token-application tail.
   * Invoked by the device-flow finalizer with a minted `{ token, refreshToken }` pair.
   */
  private async applyTokenInternal(
    token: string,
    refreshToken: string,
    expectedOAuthEpoch: number | null,
  ): Promise<TokenApplicationOutcome> {
    if (this.disposed) {
      return "superseded";
    }
    // Captured before the first await.
    // The attempt epoch is consumed before the save/provision awaits below, so this generation is the only fence that can drop the finalization once a `signOut()` / newer `signIn()` interleaves with them.
    const generation = this.identityGeneration;
    if (token.length === 0) {
      if (!this.isAttemptCurrent(expectedOAuthEpoch)) {
        appLogger.debug(
          "[auth] ignored empty token from stale OAuth callback",
          {
            expectedEpoch: expectedOAuthEpoch ?? "cold-start",
          },
        );
        return "superseded";
      }
      appLogger.warn("[auth] OAuth callback delivered an empty token", {});
      this.clearPendingTimeout();
      this.clearActiveAttempt();
      this.applyFailure(AUTH_ERROR_SIGN_IN_FAILED);
      return "failed";
    }
    if (!this.isAttemptCurrent(expectedOAuthEpoch)) {
      appLogger.debug("[auth] ignored stale OAuth callback before validation", {
        expectedEpoch: expectedOAuthEpoch ?? "cold-start",
      });
      return "superseded";
    }
    this.clearPendingTimeout();
    const outcome = await this.validateToken(token);
    if (this.isDisposed()) {
      return "superseded";
    }

    // After the async validation, the state machine may have moved on: a fresh `signIn()` could have minted a new attempt.
    // In that case this result is stale and must not mutate state.
    if (!this.isAttemptCurrent(expectedOAuthEpoch)) {
      appLogger.debug("[auth] ignored stale OAuth callback after validation", {
        expectedEpoch: expectedOAuthEpoch ?? "cold-start",
      });
      return "superseded";
    }
    if (outcome.kind === "valid") {
      // Interactive sign-in: write the freshly-minted pair + validated identity to the shared credentials file.
      // `signIn` stamps `savedAt` in main and rejects if the write cannot land.
      const signInError: unknown = await this.tokenStore
        .signIn({ token, refreshToken }, identityFromUser(outcome.user))
        .then(
          () => null,
          (error: unknown) => error ?? new Error("sign-in save rejected"),
        );
      // Checked before acting on the outcome: a transition (or dispose) that landed during the write owns the state now, so neither the signed-in projection nor the failure projection below may run for this stale finalization - and the durable write this stale.
      if (
        !this.isIdentityCurrent(generation) ||
        !this.isAttemptCurrent(expectedOAuthEpoch)
      ) {
        appLogger.debug(
          "[auth] dropped sign-in finalization superseded during token save",
          {},
        );
        await this.undoSupersededCredentialSave(token);
        return "superseded";
      }
      // Consume the attempt now that the save is settled and still ours; a
      // replayed device result for this epoch is stale from here on.
      this.clearActiveAttempt();
      if (signInError !== null) {
        // Without the persisted pair the "signed-in" projection would be a lie the next launch cannot rehydrate and the rotate cannot refresh.
        // Fail the sign-in as a product failure instead.
        appLogger.warn(
          "[auth] failed to persist accepted sign-in credentials",
          { error: describeLogError(signInError) },
        );
        this.applyFailure(AUTH_ERROR_SIGN_IN_FAILED);
        return "failed";
      }

      this.setLastError(null);
      this.applySignedIn(token, outcome.user, undefined);
      // Terminal success of an interactive device-flow attempt (this method's only caller is `finalizeDeviceResult`).
      // Passive token restores use a different path and deliberately never count as sign-ins.
      Analytics.getInstance().track(AnalyticsEvent.SignInSucceeded, null);
      return "applied";
    }
    // Validation `rejected` OR `network-error`: do not persist. Surface
    // `sign-in-failed` so the header sign-in surface renders a retry CTA.
    appLogger.warn("[auth] OAuth token validation failed", {
      outcome: outcome.kind,
    });
    this.clearActiveAttempt();
    this.applyFailure(AUTH_ERROR_SIGN_IN_FAILED);
    return "failed";
  }

  /**
   * Undo for a credential save whose attempt was superseded mid-write: an atomic compare-and-delete at the store's own authority (main's file lock) removes the pair ONLY if the store still holds exactly the token this stale finalization wrote - any other.
   */
  private async undoSupersededCredentialSave(token: string): Promise<void> {
    // Recorded BEFORE the attempt, not on failure: the very write being undone has already fired the store watcher, so a reconcile can start while this delete is still in flight - it must hit the fence during that window too.
    this.pendingUndoTokens.add(token);
    try {
      await this.tokenStore.deleteIfToken(token);
      this.pendingUndoTokens.delete(token);
    } catch (error) {
      this.markStoreUnavailable("undo-superseded-save", error);
    }
  }

  /**
   * The ONE fence in front of EVERY durable-adoption path - the recovery tick, the watcher reconcile, and any future reader of the store.
   * While a superseded-save undo is pending, either the retry completes it now (the cleaned store may then be trusted) or this pass is refused and the recovery loop is armed to finish the job.
   */
  private async pendingUndoBlocksAdoption(trigger: string): Promise<boolean> {
    if (await this.retryPendingCredentialUndo()) {
      return false;
    }
    if (!this.disposed) {
      this.scheduleSessionRecovery(`${trigger}:pending-undo`);
    }
    return true;
  }

  /**
   * Drains the pending-undo set token by token.
   * `true` means the store is clean: nothing pending, or every retry just settled (`kept` is settled too - someone else's pair owns the file now and that stale one is gone).
   */
  private async retryPendingCredentialUndo(): Promise<boolean> {
    for (const token of [...this.pendingUndoTokens]) {
      try {
        const result = await this.tokenStore.deleteIfToken(token);
        this.pendingUndoTokens.delete(token);
        appLogger.info("[auth] completed pending superseded-save undo", {
          result,
        });
      } catch (error) {
        appLogger.warn("[auth] pending superseded-save undo still failing", {
          error: describeLogError(error),
        });
      }
    }
    return this.pendingUndoTokens.size === 0;
  }

  /**
   * Device-flow terminal finalizer.
   * Applies a device poll outcome ONLY if the live attempt is still the one with this epoch - so a result for a superseded attempt (a newer `signIn()` took over) is dropped.
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
      // Set BEFORE the first await, like every other terminal outcome below: an overlapping start() invoked after this attempt's signIn() shares its identityGeneration (nothing bumps it again until a fresh sign-in /out), so the generation fence alone cannot stop a.
      if (this.starting) {
        this.authResolvedDuringStart = true;
      }
      // The approval has landed; only token validation/persistence remains.
      // Flip the surface off "Waiting for approval" NOW - validation can take seconds (network retries, credentials-file lock), and through that window the panel would otherwise claim the approval never arrived.
      const progress = this.deviceProgress;
      if (progress !== null) {
        this.setDeviceProgress({ ...progress, phase: "finalizing" });
      }
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
   * Link-code sign-in, confirm-gated: CLAIMS the scanned public code - which grants nothing beyond the private polling secret and a spot in front of the desktop's approve/reject prompt - then polls WITH THAT SECRET until the desktop decides.
   */
  async signInWithLinkCode(code: string): Promise<LinkLoginSignInResult> {
    if (this.disposed) {
      return { kind: "superseded" };
    }
    this.identityGeneration += 1;
    this.settleSessionRecovery("interactive-attempt");
    this.setLastError(null);
    const attempt = this.beginAttempt();
    // Global signing-in projection, tagged as a LINK attempt: it disables the sibling device sign-in action while this claim runs (defense in depth on top of the fence), and it withholds the device flow's retry escape hatch, which here would supersede a claim.
    useAuthStore.getState().setSigningIn("link");

    const authnBaseUrl = this.runnerHost.authnBaseUrl;
    // Device identity for the approver's prompt, best first: the shell's native self-description ("iPhone 16 Pro") where one exists, else the WebView UA.
    // Carried in the claim BODY because the phone's native HTTP layer rewrites the transport User-Agent to a generic one that names nothing.
    const describer = this.runnerHost.deviceDescriber;
    const described = describer === null ? null : await describer.describe();
    // Fenced BEFORE the claim, not only after it.
    // `describe()` is a native round trip, and a newer sign-in landing during it would otherwise let this dead attempt spend the account's single live unclaimed code: the QR still on the desktop screen dies, and the desktop raises an approval prompt for a claim.
    if (this.isDisposed() || this.activeAttempt !== attempt) {
      return { kind: "superseded" };
    }
    const claimed = await claimLinkLoginCodeViaHttp(
      authnBaseUrl,
      code,
      described ?? navigator.userAgent,
    );
    if (this.isDisposed() || this.activeAttempt !== attempt) {
      return { kind: "superseded" };
    }
    if (claimed.kind !== "claimed") {
      this.clearActiveAttempt();
      this.applyLinkLoginFailure();
      if (claimed.kind === "invalid-code" || claimed.kind === "rate-limited") {
        return { kind: claimed.kind };
      }
      return { kind: "network-error" };
    }
    return this.pollLinkLoginResult(authnBaseUrl, claimed, attempt);
  }

  /**
   * The claim's poll loop, fenced on `attempt`: a superseded attempt returns silently without touching global auth state - the superseding flow owns it now.
   * Terminal outcomes for the CURRENT attempt consume it and project failure exactly like a failed device attempt.
   */
  private async pollLinkLoginResult(
    authnBaseUrl: string,
    claim: {
      readonly secret: string;
      readonly pollIntervalSeconds: number;
      readonly matchCode: string | null;
    },
    attempt: Attempt,
  ): Promise<LinkLoginSignInResult> {
    const { secret, pollIntervalSeconds, matchCode } = claim;
    const failCurrent = (
      result: LinkLoginSignInResult,
    ): LinkLoginSignInResult => {
      this.clearActiveAttempt();
      this.setLinkLoginProgress(null);
      this.applyLinkLoginFailure();
      return result;
    };
    const deadline = Date.now() + LINK_LOGIN_APPROVAL_TIMEOUT_MS;
    let intervalMs = Math.max(1_000, pollIntervalSeconds * 1_000);
    let transportFailures = 0;
    while (Date.now() < deadline) {
      // Published BEFORE the sleep, off the same `intervalMs` the loop is about to wait out - so a directive-stretched wait is counted down at its real length, never at the interval the claim first advertised.
      const nextPollAtMs = Date.now() + intervalMs;
      this.setLinkLoginProgress({ nextPollAtMs, phase: "waiting", matchCode });
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (
        this.isDisposed() ||
        this.activeAttempt !== attempt ||
        attempt.abortController.signal.aborted
      ) {
        return { kind: "superseded" };
      }
      this.setLinkLoginProgress({
        nextPollAtMs,
        phase: "checking",
        matchCode,
      });
      const polled = await linkLoginTokenViaHttp(authnBaseUrl, secret);
      if (this.isDisposed() || this.activeAttempt !== attempt) {
        return { kind: "superseded" };
      }
      switch (polled.kind) {
        case "authorized": {
          this.setLinkLoginProgress({
            nextPollAtMs,
            phase: "finalizing",
            matchCode,
          });
          // The shared tail re-checks the epoch, consumes the attempt on
          // success, and drops a finalization superseded mid-persist.
          const applied = await this.applyTokenInternal(
            polled.response.token,
            polled.response.refreshToken,
            attempt.epoch,
          );
          return linkResultForTokenApplication(applied);
        }
        case "authorization-pending":
          transportFailures = 0;
          // Snap back to the server-directed floor: a transient slow-down must not leave the cadence ratcheted up for the rest of the wait - approval is imminent in this state by definition.
          intervalMs = Math.max(1_000, pollIntervalSeconds * 1_000);
          continue;
        case "slow-down":
          transportFailures = 0;
          // Follow the directive in both directions rather than ratcheting
          // monotonically upward.
          intervalMs = Math.max(
            1_000,
            (polled.retryAfterSeconds ?? pollIntervalSeconds) * 1_000,
          );
          continue;
        case "access-denied":
          return failCurrent({ kind: "denied" });
        case "invalid-code":
          return failCurrent({ kind: "invalid-code" });
        case "network-error":
          transportFailures += 1;
          if (transportFailures >= 3) {
            return failCurrent({ kind: "network-error" });
          }
          continue;
      }
    }
    return failCurrent({ kind: "timed-out" });
  }

  /**
   * The "Link mobile app" panel's view of its current code - whether a phone has claimed it and the claimant metadata for the confirmation prompt.
   * The raw bearer stays inside this auth boundary.
   */
  async fetchLinkLoginStatus(
    code: string,
    signal: AbortSignal,
  ): Promise<LinkLoginStatusFetchResult> {
    if (this.currentBearer === null) {
      return { kind: "unauthorized" };
    }
    return this.runnerHost.linkLoginStatus(this.currentBearer, code, signal);
  }

  /** The panel's approve/reject decision on a claimed code. */
  async respondLinkLogin(
    code: string,
    approve: boolean,
  ): Promise<RespondLinkLoginFetchResult> {
    if (this.currentBearer === null) {
      return { kind: "unauthorized" };
    }
    return this.runnerHost.respondLinkLogin(this.currentBearer, code, approve);
  }

  /**
   * Epoch-currency check used by async finalization paths.
   * Returns true iff the captured epoch still matches the live attempt's epoch.
   */
  private isAttemptCurrent(expectedEpoch: number | null): boolean {
    return (this.activeAttempt?.epoch ?? null) === expectedEpoch;
  }

  /**
   * Supersedes (or tears down) the live attempt: aborts its controller so an in-flight device fetch is discarded, and cancels its main-process device poll so no ~10-minute poll leaks.
   * Leaves `activeAttempt === null`.
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
    this.setLinkLoginProgress(null);
    this.activeAttempt = null;
  }

  /**
   * Concludes the active attempt from a terminal finalizer: disposes its device-result subscription (releasing the `onResult`/IPC closure) and clears it.
   * Unlike `discardActiveAttempt`, it does NOT abort/cancel - the attempt has already settled, so there is nothing to tear down.
   */
  private clearActiveAttempt(): void {
    this.activeAttempt?.resultDisposable?.dispose();
    this.activeAttempt = null;
  }

  /**
   * Discards the current attempt (see `discardActiveAttempt`) and starts a new one with a fresh, globally-unique epoch.
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
    if (this.sessionRecoveryTimer !== null) {
      AuthService.cancelTimeout(this.sessionRecoveryTimer);
      this.sessionRecoveryTimer = null;
    }
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
    this.commitLiveCredential(null, null);
    this.contextProvider.dispose();
    this.listeners.clear();
    this.errorListeners.clear();
    this.sessionSnapshotListeners.clear();
    this.deviceProgressListeners.clear();
    this.linkLoginProgressListeners.clear();
  }

  /**
   * Browser-return signal handler.
   * The shell delivers a payload-free nudge when the user comes back from the device-approval tab (the `traycer://` deep link).
   */
  private handleReturnSignal(): void {
    if (this.disposed) {
      return;
    }
    this.activeAttempt?.deviceSession?.pollNow();
  }

  /**
   * Epoch-scoped attempt timeout.
   * Fires the expiry failure ONLY when the live attempt is still the exact attempt the timer was scheduled for, so a stray timer from a superseded attempt can never kill a newer one (e.g. a timer from an abandoned attempt firing after the user retried).
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
    // Dispose the result subscription (via clearActiveAttempt) BEFORE cancelling the session, mirroring discardActiveAttempt's dispose-before-cancel order: even if a session's cancel() ever delivered the terminal result synchronously, there is no live onResult.
    this.clearActiveAttempt();
    attempt.deviceSession?.cancel();
    this.setDeviceProgress(null);
    this.setLinkLoginProgress(null);
    if (this.starting) {
      this.authResolvedDuringStart = true;
    }
    this.applyFailure(AUTH_ERROR_DEVICE_EXPIRED);
  }

  /**
   * Schedules the single in-flight attempt timer.
   * Only one attempt is ever live at a time, so a single handle suffices; the captured `epoch` makes the handler a no-op if the attempt has been superseded by the time it fires.
   */
  private scheduleAttemptTimeout(epoch: number, durationMs: number): void {
    this.clearPendingTimeout();
    this.pendingTimeoutHandle = AuthService.scheduleTimeout(() => {
      this.handleAttemptTimeout(epoch);
    }, durationMs);
  }

  /** Validates a bearer token against AuthnV3's `/api/v3/user` endpoint. */
  private async validateToken(token: string): Promise<ValidationOutcome> {
    const outcome = await this.runnerHost.validateAuthTokenIdentity(token);
    if (outcome.kind !== "network-error") {
      recordAuthServerTime(outcome.serverTime);
    }
    return outcome;
  }

  /**
   * Projects the validated identity into the request context, store and persistence snapshot.
   * Which context operation that means depends on who is already live:
   */
  private applySignedIn(
    bearerToken: string,
    user: AuthenticatedUser,
    profileOverride: AuthProfile | undefined,
  ): void {
    this.applySessionProjection(bearerToken, user, profileOverride, "commit");
    // Cache the identity for the NEXT launch's provisional apply.
    // Here, and not at each call site, so "a validated identity was projected" and "the snapshot is current" cannot drift apart.
    void writeProvisionalSessionSnapshot(this.runnerHost.secureStorage, user);
  }

  /** The body of {@link applySignedIn}, parameterized on the one thing the provisional boot apply must NOT do. */
  private applySessionProjection(
    bearerToken: string,
    user: AuthenticatedUser,
    profileOverride: AuthProfile | undefined,
    entitlement: "commit" | "defer",
  ): void {
    if (this.disposed) {
      return;
    }
    this.settleSessionRecovery("signed-in");
    // A session being established IS the recovery: any prior transient error (store-unavailable, session-expired) is stale the moment a bearer lands - including on the automatic watcher/recovery paths that never pass through the interactive entry's clear.
    this.setLastError(null);
    this.setDeviceProgress(null);
    this.setLinkLoginProgress(null);
    const liveUserId = this.contextProvider.current()?.identity.userId;
    const profile = profileOverride ?? this.profileFromUser(user);
    const contextMetadata = this.contextMetadataFromUser(user);
    // COMMIT BEFORE EMIT - the ordering contract for this whole class of bug.
    this.commitLiveCredential(bearerToken, profile);
    if (entitlement === "commit") {
      this.commitSubscriptionStatus(user.userSubscription.subscriptionStatus);
    }
    let rotatedInPlace = false;
    if (liveUserId !== undefined && liveUserId === user.user.id) {
      try {
        this.contextProvider.rotateCurrentBearer({
          userId: liveUserId,
          bearerToken,
        });
        rotatedInPlace = true;
      } catch {
        // The provider's own contract: rotation refusals (no current context, a released lease, an identity mismatch) are translated by auth-boundary callers into a clean sign-out + re-sign-in transition.
        rotatedInPlace = false;
      }
    }
    if (!rotatedInPlace) {
      this.contextProvider.setSignedIn({
        user,
        bearerToken,
        operationId: undefined,
        externalAbortSignal: undefined,
      });
    }
    useAuthStore
      .getState()
      .setSignedIn(profile, contextMetadata, projectShareableTeams(user));
    this.emitSessionSnapshot();
    this.refreshScheduler.start();
  }

  /**
   * Aborts the live `RequestContext` (if any) and projects signed-out state.
   * Idempotent - a second call while already signed-out is a no-op for the provider.
   */
  private applySignedOut(): void {
    if (this.disposed) {
      return;
    }
    this.setDeviceProgress(null);
    this.setLinkLoginProgress(null);
    this.refreshScheduler.stop();
    // COMMIT BEFORE EMIT (see `applySignedIn`).
    // `signOut()` announces the null context synchronously and the runtime refreshes the directory inside that announcement; a bearer still readable here would be sent on behalf of a signed-out session, and - if the registry happened to accept it - would.
    this.commitLiveCredential(null, null);
    // The plan belongs to the account that just went away.
    // Cleared alongside the credential (`setSignedOut()` nulls the store's copy too) so no host list can be projected against the departed account's entitlement.
    this.currentSubscription = null;
    this.contextProvider.signOut();
    useAuthStore.getState().setSignedOut();
    this.emitSessionSnapshot();
    // The cached identity goes with the session.
    // HERE rather than only in `signOut()`, so the UI-only signed-out projection a dead credential produces cannot leave a snapshot the next launch would paint with.
    void clearProvisionalSessionSnapshot(this.runnerHost.secureStorage);
  }

  /**
   * THE single assignment site for the account's subscription tier: this object's copy and the store projection every entitlement-gated surface renders from, written together so the two can never disagree.
   */
  private commitSubscriptionStatus(status: SubscriptionStatus): void {
    this.currentSubscription = status;
    useAuthStore.getState().setSubscriptionStatus(status);
  }

  /**
   * The signed-in account's subscription tier, or `null` when signed out or not yet known.
   * Synchronous, and readable without React - the host-directory projection reads it once per fetch.
   */
  currentSubscriptionStatus(): SubscriptionStatus | null {
    return this.currentSubscription;
  }

  /** THE single assignment site for the live credential pair. */
  private commitLiveCredential(
    bearer: string | null,
    profile: AuthProfile | null,
  ): void {
    this.currentBearer = bearer;
    this.currentProfile = profile;
  }

  /**
   * Projects a terminal sign-in FAILURE.
   * UI-only: the credentials file is NOT touched (only explicit sign-out destroys it).
   */
  private applyFailure(error: string): void {
    if (this.disposed) {
      return;
    }
    this.setLastError(error);
    this.applyInteractiveFailure(error);
  }

  /** A link-login claim's terminal failure: the same transition as `applyFailure`, minus the durable `lastError`. */
  private applyLinkLoginFailure(): void {
    if (this.disposed) {
      return;
    }
    this.applyInteractiveFailure(AUTH_ERROR_SIGN_IN_FAILED);
  }

  private applyInteractiveFailure(error: string): void {
    appLogger.warn("[auth] applying auth failure", {
      errorCode: classifyAuthFailureForLog(error),
    });
    // Every caller of this method is a terminal failure of an interactive sign-in attempt (launch failure, device denial/expiry, token rejection), so this is the one seam where `sign_in_failed` is emitted.
    Analytics.getInstance().track(AnalyticsEvent.SignInFailed, {
      blocker: SIGN_IN_FAILURE_BLOCKERS[error] ?? "unknown",
    });
    this.applySignedOut();
    // A failed interactive attempt says nothing about the SHARED file - a recoverable stored session may still be sitting there (the entry to `signIn` settled any loop that was nursing one).
    this.scheduleSessionRecovery("interactive-failure");
  }

  /**
   * Re-projects a same-user verdict's person-facing identity into the auth store and the service's own live-credential copy - and nothing else.
   */
  private reprojectSameUserIdentity(user: AuthenticatedUser): void {
    const profile = this.profileFromUser(user);
    const contextMetadata = this.contextMetadataFromUser(user);
    const shareableTeams = projectShareableTeams(user);
    const current = useAuthStore.getState();
    // Keyed by id, not by INDEX.
    // `projectShareableTeams` preserves the server's order verbatim, so an index-wise compare reads a pure reorder of an identical team set as a change - which writes the store and fires an `Analytics.identify` for nothing.
    const currentTeamsById = new Map(
      current.shareableTeams.map((team) => [team.teamId, team]),
    );
    const unchanged =
      current.profile !== null &&
      current.contextMetadata !== null &&
      current.profile.userId === profile.userId &&
      current.profile.userName === profile.userName &&
      current.profile.email === profile.email &&
      current.profile.avatarUrl === profile.avatarUrl &&
      current.contextMetadata.userId === contextMetadata.userId &&
      current.contextMetadata.username === contextMetadata.username &&
      current.shareableTeams.length === shareableTeams.length &&
      shareableTeams.every((next) => {
        const team = currentTeamsById.get(next.teamId);
        return (
          team !== undefined &&
          team.slug === next.slug &&
          team.avatarUrl === next.avatarUrl
        );
      });
    if (unchanged) return;
    // The service's OWN copy moves too, through the single commit site and BEFORE the announcement, exactly as every other identity write does.
    // What this method must not disturb is the context provider and the refresh scheduler, and `currentProfile` is neither: it is the other half of the live credential pair, which `commitLiveCredential` exists to keep from splitting.
    this.commitLiveCredential(this.currentBearer, profile);
    useAuthStore
      .getState()
      .setSignedIn(profile, contextMetadata, shareableTeams);
    // The windows bridge holds a PUSHED copy of the same snapshot, so fixing only the pull-side read would leave every other window on the old identity.
    // Reached only past the gate above, so an unchanged identity still emits nothing.
    this.emitSessionSnapshot();
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
   * Subscribes to device-flow progress transitions (user code / verification URIs / expiry).
   * Fires synchronously on subscribe with the current value, then on every change.
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
   * Subscribes to link-login poll progress (when the next `/link/token` poll fires, and whether one is outstanding).
   * Fires synchronously on subscribe with the current value, then on every change.
   */
  onLinkLoginProgressChange(handler: LinkLoginProgressListener): Disposable {
    this.linkLoginProgressListeners.add(handler);
    handler(this.linkLoginProgress);
    return {
      dispose: () => {
        this.linkLoginProgressListeners.delete(handler);
      },
    };
  }

  getLinkLoginProgress(): LinkLoginProgress | null {
    return this.linkLoginProgress;
  }

  /**
   * Re-opens the pre-filled approval page (`verification_uri_complete`, with the user code embedded) for the in-flight device attempt.
   * Backs the sign-in surface's one-click "open approval page" affordance so the user never has to type the code if the initial auto-open was missed.
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

  private setLinkLoginProgress(next: LinkLoginProgress | null): void {
    const current = this.linkLoginProgress;
    if (
      current === next ||
      (current !== null &&
        next !== null &&
        current.nextPollAtMs === next.nextPollAtMs &&
        current.phase === next.phase &&
        current.matchCode === next.matchCode)
    ) {
      return;
    }
    this.linkLoginProgress = next;
    for (const handler of this.linkLoginProgressListeners) {
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
 * Maps a terminal (non-`authorized`) device-flow result to the stable error id the device surface renders.
 * `error` (invalid grant / exhausted retries) reuses the generic sign-in-failed copy.
 */
/**
 * The credentials pair a `rotate` outcome hands back to adopt: present for `applied`/`superseded`/`commit-failed`, `null` for the terminal/transient outcomes that carry no pair (`deleted`/`user-mismatch`/`tombstoned`/.
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
 * Projects the credentials-file identity block (`{ id, email, name }`) from a validated `AuthenticatedUser`.
 * The store stamps `savedAt`; only the user identity crosses the `signIn` seam.
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

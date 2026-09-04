import type {
  CredentialsMigrationOutcome,
  IRunnerHost,
  DeviceFlowResult,
  DeviceFlowSession,
  StoredAuthTokens,
  StoredCredentials,
  StoredCredentialsIdentity,
  AuthRefreshRejection,
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
import { retireAllRemoteSessions } from "@traycer-clients/shared/host-transport/remote/active-remote-sessions";
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
  type SignedOutCause,
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

// Legacy encrypted-localStorage token slots (the pre-§3 desktop store). Two
// separate string slots — NOT one JSON blob — matching the retired
// `desktop-runner-host` keys. The write path is gone (§3); §6 reads these one
// last time via the generic `secureStorage` seam to migrate the pair onto the
// shared file, then wipes them.
const LEGACY_ACCESS_TOKEN_KEY = "traycer.token";
const LEGACY_REFRESH_TOKEN_KEY = "traycer.refresh-token";

/**
 * The kinds a surface actually renders: the CODE VERDICTS, and nothing else.
 * A completed sign-in speaks for itself, and the two non-verdict outcomes
 * (`superseded`, `failed`) are either silent or already presented globally.
 */
export type LinkLoginFailureKind = Exclude<
  LinkLoginSignInResult["kind"],
  "signed-in" | "superseded" | "failed"
>;

/**
 * Terminal outcome of {@link AuthService.signInWithLinkCode}. `invalid-code`
 * covers expired, claimed-elsewhere, and never-existed codes
 * indistinguishably (the server does not say which); `denied` is the desktop
 * explicitly rejecting the claim; `timed-out` means the approval window
 * elapsed with no decision.
 *
 * Two members are NOT code verdicts and carry no copy of their own:
 * `superseded` (the attempt stopped being ours - nothing was projected, say
 * nothing) and `failed` (the code was approved and the finalization itself
 * failed - `AuthService` has already projected the global sign-in error, so a
 * caller adding the code-verdict copy would both duplicate the message and
 * misdescribe it). `LinkLoginFailureKind` is the set a surface may render.
 */
export type LinkLoginSignInResult =
  | { readonly kind: "signed-in" }
  /**
   * The attempt stopped being ours - a newer sign-in superseded it, or the
   * service was disposed. NOT a failure, and deliberately not presentable:
   * whoever superseded this attempt owns the surface now, and reporting a
   * result from a discarded attempt would put its complaint under the
   * successor's progress. Callers must render nothing for this kind.
   */
  | { readonly kind: "superseded" }
  /**
   * The claim was approved, and applying the resulting credentials failed on
   * THIS attempt - an empty token, a rejected persist, or validation that was
   * rejected or unreachable. A real failure, already surfaced globally.
   */
  | { readonly kind: "failed" }
  | { readonly kind: "invalid-code" }
  | { readonly kind: "denied" }
  | { readonly kind: "timed-out" }
  | { readonly kind: "rate-limited" }
  | { readonly kind: "network-error" };

/**
 * How long the phone keeps polling for the desktop's decision before giving
 * up locally. Matches the server's claim window; the record is gone by then.
 */
const LINK_LOGIN_APPROVAL_TIMEOUT_MS = 120_000;

/**
 * Thrown when a read is asked for on behalf of a credential era that is no
 * longer the live one — the request would go out under a bearer from a
 * different era than the answer is meant for.
 *
 * A distinct type rather than a bare `Error` so a caller can tell it apart
 * from a transport failure if it ever needs to; today every caller treats it
 * the same way, which is the correct one: no answer, retain what you have,
 * and let the refresh the new era triggers for itself provide the real one.
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
/**
 * The steady-state ceiling once the local plane has been admitted.
 *
 * The 30s ceiling above was chosen when a failure to validate meant the user
 * was LOCKED OUT: re-probing hard was the only way to let them back into the
 * app, so the cost was worth it. Each probe is up to
 * `AUTH_FETCH_MAX_ATTEMPTS` (3) `/api/v3/user` requests, so that ceiling is
 * ~5.7 requests/minute sustained forever against a server we already know is
 * unreachable.
 *
 * Once `unverified` is projected that justification is gone - the user is
 * already in the app, working against local disk - and the loop's job narrows
 * to noticing when the network comes back. Five minutes does that at roughly a
 * tenth of the traffic. The early ramp is deliberately unchanged: a short blip
 * still recovers in seconds, which is what the fast ramp is for.
 */
const SESSION_RECOVERY_ADMITTED_MAX_DELAY_MS = 300_000;

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

/**
 * The identity and credential authority that started an account-scoped
 * operation. `identityGeneration` alone cannot distinguish a projected or
 * reconciled account replacement, so callers also retain the live credential
 * object and bearer they are allowed to use.
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
 * The credential-scoped rejection that was the user's OWN doing: a "sign out
 * everywhere" (authn's per-user epoch gate, a 401 stamped
 * `revocation_scope: user_epoch`). Held and recovered exactly like
 * {@link AUTH_ERROR_SESSION_EXPIRED} - it is still a verdict about tokens -
 * and distinct only so the copy can say the true thing: "expired" for an
 * action the user took is the kind of message that reads as our bug.
 */
export const AUTH_ERROR_SIGNED_OUT_EVERYWHERE = "signed-out-everywhere";

/**
 * Stable error identifier emitted when AuthnV3 rejects (or the network fails
 * for) a token delivered through the OAuth callback during an active sign-in
 * attempt. Distinct from `AUTH_ERROR_SESSION_EXPIRED` so the signed-out auth
 * surface can render "Sign-in failed - please try again" copy instead of the
 * "Session expired" copy that belongs to the stored-token-rehydration path.
 */
export const AUTH_ERROR_SIGN_IN_FAILED = "sign-in-failed";

/**
 * Stable error identifier for an ACCOUNT-scoped rejection - authn answered
 * 403/404 for this user, so the server's verdict is about the account rather
 * than the token.
 *
 * Distinct from {@link AUTH_ERROR_SESSION_EXPIRED} because that copy ("sign in
 * again") describes a RECOVERABLE state, and this one is not: signing in again
 * with the same account cannot succeed. Telling someone whose account is gone
 * to sign in again sends them round a loop that has no exit, and the loop looks
 * like our bug rather than their account state.
 */
export const AUTH_ERROR_ACCOUNT_UNAVAILABLE = "account-unavailable";

function classifyAuthFailureForLog(error: string): string {
  if (
    error === AUTH_ERROR_LAUNCH_FAILED ||
    error === AUTH_ERROR_SESSION_EXPIRED ||
    error === AUTH_ERROR_SIGNED_OUT_EVERYWHERE ||
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
  /**
   * `waiting-approval` while the `/device/token` poll is outstanding;
   * `finalizing` once the poll returned `authorized` and the token is being
   * validated/persisted - the surface must stop saying "Waiting for approval"
   * the moment the approval has actually landed.
   */
  readonly phase: "waiting-approval" | "finalizing";
}

export type DeviceFlowProgressListener = (
  progress: DeviceFlowProgress | null,
) => void;

/**
 * Projected link-login poll progress for the phone's QR sign-in surface, so
 * the approval wait is a visibly ticking loop rather than an indefinite
 * spinner. `null` whenever no link attempt is polling.
 *
 * `nextPollAtMs` is ABSOLUTE, not a remaining duration: the surface subtracts
 * its own clock and therefore holds no copy of the poll interval. A server
 * directive that stretches the wait (a `slow_down` 429 carrying `Retry-After`)
 * moves this timestamp, so the countdown cannot advertise a cadence the loop
 * is no longer running at.
 */
export interface LinkLoginProgress {
  readonly nextPollAtMs: number;
  /**
   * `waiting` between polls; `checking` while a `/link/token` request is
   * outstanding; `finalizing` once a poll returned `authorized` and the token
   * is being validated/persisted — the surface must stop counting down the
   * moment the approval has actually landed.
   */
  readonly phase: "waiting" | "checking" | "finalizing";
}

export type LinkLoginProgressListener = (
  progress: LinkLoginProgress | null,
) => void;

type ValidationOutcome = AuthIdentityValidationResult;

/**
 * The result of applying a same-user `rotate` outcome to the live session:
 *   - `rotated`    → the lease was rotated in place to `token`;
 *   - `signed-out` → a terminal outcome cleared the UI session (file kept);
 *   - `transient`  → a `lock-busy`/`refresh-network` retry; state untouched.
 */
/**
 * What a live same-user rotation did. These name the fate of the REQUEST that
 * triggered the rotation, which since `unverified` arrived is no longer the
 * same thing as the fate of the session:
 *
 *  - `rotated`        - a fresh pair is live; re-drive the request.
 *  - `signed-out`     - the UI session was cleared; the request cannot proceed.
 *  - `credential-dead`- the refresh token is terminally rejected, so the request
 *                       cannot proceed EITHER, but the session was demoted to
 *                       `unverified` rather than cleared and the local plane is
 *                       still live. Distinct from `signed-out` because the two
 *                       leave the app in opposite states, and distinct from
 *                       `transient` because a dead credential must NOT be
 *                       retried - callers map `transient` to `network-error`,
 *                       which is precisely an instruction to try again.
 *  - `transient`      - nothing terminal; the bearer in hand is still usable.
 */
type SameUserRotateResult =
  | { readonly status: "rotated"; readonly token: string }
  | { readonly status: "signed-out" }
  | { readonly status: "credential-dead" }
  | { readonly status: "transient" };

/**
 * How a token finalization ended.
 *
 * The distinction that matters is `superseded` vs `failed`, and it is not a
 * shade of the same thing: `superseded` means the attempt stopped being ours
 * (an epoch/generation fence, or disposal) and NOTHING was projected, so a
 * caller must stay silent; `failed` means this attempt was still current and a
 * real failure was projected through `applyFailure`, so the global sign-in
 * error is already showing and a caller must not add a second message.
 * Collapsing them into a boolean is what let a genuine validation or
 * persistence failure be reported to callers as somebody else's attempt.
 */
type TokenApplicationOutcome = "applied" | "superseded" | "failed";

/**
 * The link flow's terminal result for a token finalization.
 *
 * Three outcomes, three answers, and `failed` is the one worth naming: it is a
 * REAL failure of this attempt - an empty token, a rejected persist, or
 * validation that was rejected or unreachable - which `applyTokenInternal` has
 * already projected as the global sign-in error. It comes back as its own kind
 * rather than as a code verdict because "that code is invalid or expired" is
 * the wrong sentence for a network blip after the desktop approved.
 */
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
/** The session a terminal verdict loss is about; see `onCloudAuthorizationRevoked`. */
export interface RevokedCloudAuthorization {
  /** The bearer the cloud rejected - the fence a copy held elsewhere applies. */
  readonly token: string;
}

export class AuthService {
  private readonly runnerHost: IRunnerHost;
  private readonly tokenStore: AuthTokenStore;
  private readonly contextProvider: DefaultRequestContextProvider;
  private readonly listeners = new Set<AuthListener>();
  private readonly errorListeners = new Set<AuthErrorListener>();
  private readonly cloudAuthorizationRevokedListeners = new Set<
    (revoked: RevokedCloudAuthorization) => void
  >();
  private readonly sessionSnapshotListeners =
    new Set<AuthSessionSnapshotListener>();
  private readonly authStoreUnsubscribe: () => void;
  private lastEmittedStatus: AuthStatus;
  /**
   * Persistence-only retained bearer. Mirrors the credential lease on the
   * current `RequestContext` and is kept here so cross-window projection
   * (windows-bridge) and the persisted token store can read the bearer without
   * reaching through a context - a reach that is now lint-fenced outside the
   * two host-local transport files
   * (`eslint/traycer-cloud-bearer-fence-rules.mjs`), so this field is the
   * sanctioned alternative rather than merely the convenient one. Host /
   * runtime consumers must NEVER read it - they thread the context.
   *
   * Inside this class it has TWO classes of reader and they are not
   * interchangeable: the auth machinery's own recovery reads it directly, and
   * every cloud product call goes through {@link cloudBearer}, which withholds
   * it unless a `/api/v3/user` verdict is held. Read that method before adding
   * a third caller.
   */
  private currentBearer: string | null = null;
  /**
   * The `GET /api/v3/hosts` request currently in flight, together with the
   * bearer it was ISSUED UNDER. Both halves are load-bearing — see
   * `fetchRegisteredHosts`.
   */
  private registeredHostsInFlight: {
    readonly bearer: string;
    readonly request: Promise<HostListResponse | null>;
  } | null = null;
  private currentProfile: AuthProfile | null = null;
  /**
   * The signed-in account's subscription tier, as of the last session commit
   * or revalidation — the SAME value projected into the auth store beside every
   * write below, kept here so a caller can read it without React.
   *
   * Kept here for synchronous consumers outside React. Remote-host
   * connectivity does not read it; authn owns that decision at grant minting.
   * `null` means "not signed in, or not yet known".
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
  // The bearer `fetchUserSessions()` already spent a repair refresh on without
  // reaching an identified current session. Skips repeating that rotation on
  // every 30s poll/focus refetch for an unchanging bearer; a bearer change
  // (sign-in, sign-out, or any other rotation) naturally clears this by no
  // longer matching.
  private unrepairableSessionsBearer: string | null = null;
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
  // Background stored-session recovery - the anti-latch. Armed whenever an
  // AUTOMATIC path lands on signed-out for a TRANSIENT reason (lock-busy, a
  // refresh network blip, a sibling's still-landing spend, a store I/O fault)
  // while the shared credentials file may still hold a refreshable session.
  // Without it a single bad moment - authn still booting next to the app in a
  // dev stack, a laptop waking - latched signed-out until an app restart,
  // because `applySignedOut()` also stops the proactive scheduler. Exponential
  // backoff; reset and disarmed by any settled state (signed in, terminal
  // rejection, explicit sign-out, no file left to recover).
  private sessionRecoveryTimer: number | null = null;
  private sessionRecoveryDelayMs: number = SESSION_RECOVERY_INITIAL_DELAY_MS;
  private sessionRecoveryAttempt: number = 0;
  // Single-flight for the ASYNC probe, distinct from `sessionRecoveryTimer`
  // which only covers the WAIT before it (cold review P2-6). The timer nulls
  // itself the instant it fires, so between that and the probe settling there
  // is a window - three `withAuthNetworkRetry` attempts wide - in which the
  // loop looks idle to anything that checks the timer. A wake landing there
  // would start a second, concurrent probe, and repeated wakes would keep
  // doing so, which is how the ticket's "18 calls in minute one, 5.7/min at
  // cap" stopped being a ceiling.
  private sessionRecoveryInFlight: boolean = false;
  // A wake that arrived DURING a probe. The probe re-arms from the floor when
  // it settles rather than being raced; deferring keeps the wake's intent
  // (re-try now, discard the accumulated backoff) without its concurrency.
  private sessionRecoveryRerunRequested: boolean = false;
  // Set when authn issued a TERMINAL verdict on the stored refresh token - a
  // rejection, as opposed to an unreachable authn. `settleSessionRecovery`
  // disarms the loop either way, but disarming is not remembering: the wake
  // nudge re-arms any unverified session on `online` / OS resume, so without
  // this a terminal 404 was re-POSTed on every laptop open, forever, against a
  // credential the server had already refused.
  //
  // Distinct from "settled" on purpose. A session settled because authn was
  // unreachable SHOULD re-probe on wake - that is the event it is waiting for.
  // A session settled because the credential is dead has nothing a network
  // event can change, and only a new credential (interactive sign-in, or a
  // sibling writing a fresh pair) can clear this.
  private sessionRecoveryTerminallyRejected: boolean = false;
  // Superseded-save undos whose conditional deletes have not LANDED yet
  // (in flight or failed): each stale pair may still be durable. Every
  // adoption path must drain this set before trusting anything it reads —
  // adopting first would resurrect exactly the zombie credential the
  // attempt fence dropped. A SET with per-token removal, not a single
  // slot: overlapping undos (A superseded by B superseded by C) must not
  // let one undo's settled `kept` clear the record of another undo that is
  // still failing — that would lose the failing token forever.
  //
  // BOUNDARY, before you assume this set is authoritative: it is INSTANCE
  // state, while the credentials file it guards is per-MACHINE. A sibling
  // window's undo is invisible here, so this is a per-window fence over
  // shared state, not a machine-wide one. The cross-window guarantee is the
  // store's own conditional delete (`deleteIfToken`), which serializes at
  // main's file lock; this set only ensures THIS window never adopts or
  // spends a pair it is itself still trying to delete. Widening it would mean
  // moving the record to the store authority, not adding another local set.
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
   * frozen while the runtime is - a sleeping machine, or a WebView the OS
   * suspends when its app leaves the foreground - and would otherwise rot the
   * token past its TTL. Mirrors `subscribeStreamWakeReconnect`'s two triggers:
   * `window 'online'` (network back) and `onSystemResumed` (the shell's own
   * wake signal: Electron resume, or the app foregrounding on mobile - the
   * app-switch case the `online` fallback cannot see). `notifyResumed` is a no-op
   * while signed out; the resume wiring is best-effort so it can't wedge
   * construction, leaving the `online` listener as the fallback.
   */
  private installWakeRefreshListeners(): void {
    this.wakeDisposers.push(
      onWakeReconnect(() => {
        this.refreshScheduler.notifyResumed();
        this.nudgeSessionRecoveryOnWake();
      }),
    );
    try {
      const resume = this.runnerHost.onSystemResumed(() => {
        this.refreshScheduler.notifyResumed();
        this.nudgeSessionRecoveryOnWake();
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
   *
   * NOT a credential counter, and it must not be pressed into service as one:
   * it moves on `signIn` / `signOut` / `dispose` only, so every ordinary
   * same-user rotation (proactive refresh, reconcile adopt, external
   * projection) leaves it exactly where it was. Callers fencing a DESTRUCTIVE
   * decision on "is the credential that observed this still current?" want
   * {@link getCredentialGeneration}.
   */
  getIdentityGeneration(): number {
    return this.identityGeneration;
  }

  /**
   * Live credential generation — advances on every bearer change, including
   * same-user rotations (see `RequestContextProvider.getCredentialGeneration`).
   *
   * Delegated to the context provider rather than counted here because the
   * provider is the object every rotation already goes through; a second
   * counter maintained alongside it would be one more thing to forget to bump
   * on a new rotation path, which is exactly the failure this replaces.
   */
  getCredentialGeneration(): number {
    return this.contextProvider.getCredentialGeneration();
  }

  /**
   * The era the live credential belongs to, for a caller that has no era of
   * its own — an ambient poll, a focus refetch, a picker-open read. Both
   * fields are read together from committed state, so the pair is coherent
   * even though the two sources are separate.
   *
   * A caller reacting to a TRANSITION must not use this: it threads the era
   * the emission handed it (`onChange`'s second argument), which is the whole
   * mechanism that keeps the incoming account's refresh from running under
   * the outgoing account's bearer.
   */
  currentAuthEra(): AuthEra {
    return {
      identity: this.currentProfile?.userId ?? null,
      credentialGeneration: this.getCredentialGeneration(),
    };
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
        // A snapshot projected from elsewhere carries no attempt kind. Naming
        // the device flow keeps the escape hatch this path has always offered:
        // no attempt of OURS is running, so `signIn()` supersedes nothing here.
        useAuthStore.getState().setSigningIn("device");
      }
      return;
    }
    if (snapshot.status === "signed-out") {
      if (!this.isIdentityCurrent(generation)) {
        return;
      }
      // STALE-BASELINE FENCE (cold review P1-1). An inbound `signed-out` may
      // not clear a locally-`unverified` session.
      //
      // The bridge deliberately never PUBLISHES `unverified` - it is this
      // window's local statement that it could not reach authn, and the desktop
      // snapshot has no member for it. The consequence is the defect: on a cold
      // desktop start where `start()` lands on `unverified`, nothing is ever
      // written outbound, so the main process still holds the `signed-out` its
      // constructor initialised it to. The bridge's delayed `authSession.get()`
      // then reads that INITIALISER - not a sibling's decision - and, because no
      // identity transition happened in between, the generation fence above lets
      // it through and it tears down the plane this ticket just admitted.
      //
      // Withholding is safe because no sibling can ever have MEANT this: a
      // window that genuinely signed out advances identity generation and
      // publishes a real transition, and a real sign-out also DELETES the shared
      // credentials file - which retires the plane through the reconcile watcher
      // and the recovery loop's `no-stored-session` arm, neither of which
      // consults this projection. The file is the authority for "there is no
      // session"; this channel only carries "a sibling changed session", and an
      // unwritten baseline carries nothing at all.
      if (useAuthStore.getState().status === "unverified") {
        appLogger.debug(
          "[auth] withholding an inbound signed-out from an unverified session",
          {},
        );
        return;
      }
      if (
        this.contextProvider.current() !== null ||
        this.currentBearer !== null ||
        useAuthStore.getState().status !== "signed-out"
      ) {
        this.applySignedOut("retired");
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
    // Set only on the provisional path, where the rehydration outlives this
    // method and owns clearing `starting` itself.
    let settlesInBackground = false;
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

      // PAINT BEFORE VALIDATING, when there is a validated identity to paint
      // with. The awaited `validateToken` below is a cloud round trip, and the
      // app shell renders `HostRuntimeBootFallback` until this method resolves
      // - 616 ms of the 968 ms to first paint on a LAN, and 8.0 s on a cold
      // launch whose authn answered late.
      const provisional = await this.applyProvisionalSession(
        stored,
        startGeneration,
      );
      if (provisional !== null) {
        // `starting` deliberately stays TRUE until this settles. It exists to
        // make an interactive sign-in that resolves mid-rehydration set
        // `authResolvedDuringStart`, and on this path the rehydration really
        // is still in flight after `start()` returns - clearing it here would
        // silently narrow that guard to the part of the flow that no longer
        // contains the validation.
        settlesInBackground = true;
        void this.settleProvisionalSession(stored, provisional, startGeneration)
          // `validateToken` is unguarded on the awaited path too, where a
          // rejection escapes into `start()`'s caller. Nothing awaits this
          // one, so the same rejection would surface as a process-level
          // unhandled rejection and - worse - strand `starting` at true, which
          // would silently disarm the `authResolvedDuringStart` guard for the
          // rest of the session.
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
        // No verdict (authn unreachable) is no reason to spend: the recovery
        // loop re-validates on backoff, and only a REJECTED verdict ever
        // authorizes the locked rotate. Rotating here instead would let a
        // half-reachable authn (identity probe down, refresh up) burn one
        // refresh generation per retry for pairs it can never validate.
        appLogger.warn(
          "[auth] stored session could not be validated at startup",
          {},
        );
        // Authn is unreachable, but this machine's epics are not: the host
        // serves local-homed data from disk with no network call at all.
        // Project the stored identity as `unverified` so the renderer mounts
        // the app around that local plane instead of parking the user on the
        // sign-in page in front of their own data. Recovery stays armed and
        // upgrades this to a real signed-in session when authn returns.
        this.applyUnverifiedSession(stored);
        this.scheduleSessionRecovery("startup:validate-network");
        return;
      }
      // Invalid/expired: route to the locked rotate rather than clearing the
      // file. The rotate's own outcome is the arbiter - its refresh either
      // lands a fresh pair, fails as a transient the recovery loop retries,
      // or returns the definitive rejection.
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
   * Applies the STORED session without waiting for the cloud to confirm it,
   * returning the identity applied - or `null` when there is nothing safe to
   * apply, which means "carry on and await the verdict as before".
   *
   * Identity only. `commitSubscriptionStatus` is deliberately NOT called here:
   * a stored `free` would render the remote-hosts upsell for one round trip to
   * anyone who upgraded since their last session, and `null` is the documented
   * not-yet-known state that `useRemoteHostsPlanRestricted` already reads as
   * not-restricted. Entitlement lands with the verdict, which is exactly where
   * it lands today for the whole of boot.
   *
   * The host never needed the cloud's answer either way: every `/rpc` and
   * `/stream` socket validates the bearer itself, so host traffic may start on
   * a provisional session. What the tradeoff really costs is the UI showing an
   * account whose token has since been revoked, for the length of one
   * validation - a window this app already accepts after every token refresh.
   */
  private async applyProvisionalSession(
    stored: StoredCredentials,
    startGeneration: number,
  ): Promise<AuthenticatedUser | null> {
    // An access token this client can already see is expired cannot open
    // anything: painting with it would move the wait from one round trip to a
    // cascade of host 401s. Fall through to the rotate path instead. The read
    // is unverified and advisory - an undecodable token is simply not refused
    // here - and a machine with a badly wrong clock only loses the fast path.
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

  /**
   * Finishes the validation the provisional apply skipped ahead of.
   *
   * The entry fence is the new one, and it is new because the usual one
   * inverts here. Every other automatic tail stands down when it observes a
   * live bearer ("someone else established a session while I was awaiting") -
   * but on this path the provisional apply IS that bearer, and it is the very
   * session this verdict is about. So the question becomes "is the live bearer
   * still the exact one I applied, at the same identity": anything else means
   * a sign-out, a sign-in, or a rotation landed while the cloud was answering,
   * and the verdict describes a session that no longer exists.
   *
   * Past that fence each branch converges back onto the ordinary rules rather
   * than carrying the inversion further - see the rejected branch, which
   * clears the session first precisely so it can.
   */
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
      // NOT a second `applySignedIn`. That method re-broadcasts the session to
      // every other window, restarts the refresh scheduler and rewrites the
      // auth store with a freshly allocated teams array, so every subscriber
      // churns for an identity that did not change. This is the same rule
      // `revalidateLiveSession` already applies to a validated live session:
      // project the entitlement, and re-sign-in only when the bearer turns out
      // to name a different user.
      this.commitSubscriptionStatus(
        outcome.user.userSubscription.subscriptionStatus,
      );
      if (outcome.user.user.id !== provisional.user.id) {
        this.applySignedIn(stored.token, outcome.user, undefined);
        return;
      }
      // Same user, but not necessarily the same PERSON-FACING identity: the
      // provisional apply painted the CACHED snapshot, and a name, avatar or
      // team membership changed since the last launch is only in the verdict.
      // Without this the header, the mobile drawer, the home hero and the
      // share picker's team list all stayed one launch behind, and nothing
      // else on this path ever corrected them - `commitSubscriptionStatus`
      // above writes the entitlement alone.
      this.reprojectSameUserIdentity(outcome.user);
      void writeProvisionalSessionSnapshot(
        this.runnerHost.secureStorage,
        outcome.user,
      );
      return;
    }

    if (outcome.kind === "network-error") {
      // No verdict, and deliberately NO `scheduleSessionRecovery` - which the
      // awaited path calls here and which would be a no-op anyway: the
      // recovery tick's first act is to stand down for a live bearer
      // (`already-signed-in`), and the provisional session IS one.
      //
      // The session simply stays up, which is the correct outcome rather than
      // a concession. Authn being unreachable is not evidence that a stored
      // token is bad, the host validates every bearer itself, and a live
      // session already owns exactly the machinery this needs: the proactive
      // refresh scheduler the projection started, and `revalidateLiveSession`
      // on the first 401. That is the same state any long-running session
      // enters when the network drops after boot.
      //
      // What stays unknown until some later validation is the ENTITLEMENT,
      // which the provisional apply skipped. `null` is the documented
      // not-yet-known value on both readers, permissive on both, and the
      // server enforces the grant authoritatively either way.
      appLogger.warn(
        "[auth] provisional session could not be validated at startup",
        {},
      );
      return;
    }

    // Rejected. The session on screen is not real, so take it back BEFORE
    // rotating rather than after.
    //
    // Not only honesty: it restores the invariant the rest of this machinery
    // is written against. `rotateStoredSession` and every recovery tick stand
    // down when a live bearer exists, so rotating with the rejected session
    // still installed would make a TRANSIENT rotate failure terminal - the
    // loop would settle as `already-signed-in` against the very session that
    // was just refused, and nothing would ever retry it. Cleared first, this
    // is byte-for-byte the path a cold boot takes today.
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

  /**
   * Whether the live credential is still the exact bearer a caller applied.
   *
   * Deliberately identity of the TOKEN, not of the user: a same-user rotation
   * replaces the bearer while `identityGeneration` stays put, and a verdict
   * about the pre-rotation token has nothing to say about the one now in use.
   */
  private currentBearerIs(bearerToken: string): boolean {
    return this.currentBearer === bearerToken;
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
   * The one spend-capable re-establishment path for a stored-but-stale session,
   * shared by startup rehydration, the background recovery loop, and the §4
   * reconcile (via recovery) when the file's access token no longer validates.
   * Runs the locked `rotate` (the one spend, under the file lock in main), then
   * either mints a fresh signed-in session from the rotated/adopted pair or
   * projects a UI-only signed-out. TERMINAL outcomes (a genuine refresh
   * rejection, a standing sign-out, an account switch) settle the recovery
   * loop; TRANSIENT ones (lock-busy, a sibling's still-landing spend, network,
   * a store fault) schedule a backoff retry so no blip ever latches
   * signed-out. The credentials file is NEVER deleted here - only explicit
   * sign-out destroys it (settled decision / H1).
   *
   * Stand-down invariant: every caller enters with NO live bearer, so a
   * bearer observed after any await means a competing path (the §4 watcher
   * adopting an externally-written session mid-flight) already established a
   * session - one that may belong to a DIFFERENT user and does not bump the
   * identity generation the `stillWanted` fences watch. Applying or clearing
   * anything past that point would clobber it, so every gate checks both.
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
      if (!stillWanted() || this.hasVerifiedSession()) {
        return;
      }
      this.markStoreUnavailable(`${trigger}.rotate`, error);
      return;
    }
    if (!stillWanted() || this.hasVerifiedSession()) {
      return;
    }
    appLogger.info("[auth] stored-session rotate outcome", {
      trigger,
      outcome: rotated.outcome,
    });
    const pair = rotatedLivePair(rotated);
    // `commit-failed` can surface a process-wide pending continuation for a
    // *different* user (one main-process store shared across windows). Never
    // adopt a foreign pair into this session.
    if (pair !== null && pair.user.id === stored.user.id) {
      // The rotated pair carries only the cached identity; re-validate it
      // (access-only) to mint the full `AuthenticatedUser` the context needs.
      const revalidated = await this.validateToken(pair.token);
      if (!stillWanted() || this.hasVerifiedSession()) {
        return;
      }
      if (revalidated.kind === "valid") {
        // Same deletion race as the recovery path: our locked rotate committed
        // this pair, but an explicit sign-out can land (and delete the file)
        // while the identity probe is in flight.
        if (!(await this.storedSessionStillOnDisk(pair.token))) {
          this.scheduleSessionRecovery(`${trigger}:rotated-pair-superseded`);
          return;
        }
        if (!stillWanted() || this.hasVerifiedSession()) {
          return;
        }
        this.settleSessionRecovery("recovered");
        this.applySignedIn(pair.token, revalidated.user, undefined);
        return;
      }
      if (revalidated.kind === "network-error") {
        // The rotated pair is committed on disk; only the identity probe
        // blipped. Admit the local plane on the ROTATED token (the one now on
        // disk, not the stale `stored.token` we came in with) and let the
        // retry re-validate without spending anything.
        this.applyUnverifiedSession({ token: pair.token, user: stored.user });
        this.scheduleSessionRecovery(`${trigger}:post-rotate-network`);
        return;
      }
      // A freshly-rotated pair the server rejects outright: terminal
      // server-side state (epoch revoke / sign-out-everywhere). The cloud
      // session is over, but the epics on this disk are still this user's:
      // hold the local plane rather than tearing it down mid-use. The error
      // copy is what tells them to sign in again.
      this.setLastError(AUTH_ERROR_SESSION_EXPIRED);
      this.applyUnverifiedSession({ token: pair.token, user: stored.user });
      this.sessionRecoveryTerminallyRejected = true;
      this.settleSessionRecovery("rotated-pair-rejected");
      return;
    }
    this.applyUnadoptedStoredRotateOutcome(
      rotated.outcome,
      rotated.rejection,
      trigger,
      stored,
    );
  }

  /**
   * Tail of {@link rotateStoredSession} for every outcome that did NOT yield
   * an adoptable same-user pair: terminal ones settle the recovery loop,
   * transient ones re-arm it.
   */
  private applyUnadoptedStoredRotateOutcome(
    outcome: TokenRotateOutcome,
    rejection: AuthRefreshRejection | null,
    trigger: string,
    stored: StoredCredentials,
  ): void {
    // This switch is where the CREDENTIAL-scoped / ACCOUNT-scoped line is
    // actually enforced; the line itself is stated at the `AuthStatus`
    // definition in `stores/auth/auth-store.ts`. Read it before moving a case
    // across the boundary.
    switch (outcome) {
      case "refresh-rejected-credential": {
        // CREDENTIAL-scoped: a verdict about a TOKEN, not about the account or
        // the person. The file is deliberately KEPT here, and with it the
        // identity that names this machine's local epics - so the person at
        // the keyboard is still who the disk says, and holding the plane
        // grants them nothing they did not already have. A dead credential
        // ends the CLOUD session; it is not grounds to evict someone from data
        // on their own disk that the host serves without asking authn
        // anything. The "session expired" copy (surfaced by
        // `AuthSessionExpiredToastBridge`, which MUST admit `unverified` for
        // exactly this case) is what drives the re-sign-in.
        //
        // This arm is where authn's 400/401 land, INCLUDING a user-initiated
        // "sign out everywhere" (the per-user epoch gate, which answers 401 and
        // stamps `revocation_scope`). A global sign-out is still a statement
        // about tokens, so it holds the plane exactly like an expiry does -
        // what differs is what the user is TOLD, and what an operator reading
        // the log can tell apart: their own sign-out from a fork-suspicious
        // reject. That is what `rejection.revocation` travelled here for.
        const revocation =
          rejection?.kind === "credential" ? rejection.revocation : null;
        appLogger.info("[auth] stored session refresh rejected", {
          trigger,
          scope: "credential",
          revocation,
        });
        this.setLastError(
          revocation === "user-epoch"
            ? AUTH_ERROR_SIGNED_OUT_EVERYWHERE
            : AUTH_ERROR_SESSION_EXPIRED,
        );
        this.applyUnverifiedSession(stored);
        this.sessionRecoveryTerminallyRejected = true;
        this.settleSessionRecovery("refresh-rejected-credential");
        return;
      }
      case "refresh-rejected-account":
        // HOLDS, by product ruling, and it is the one arm on this side of the
        // line that does. The three below are statements about the LOCAL file -
        // no identity remains on disk to hold a plane for. This one is a SERVER
        // verdict about an account whose identity block is still on disk and
        // whose epics are still on it.
        //
        // The deciding argument was enforceability: gating the renderer deletes
        // nothing. The host serves local-homed epics with zero `/api/v3/user`
        // calls and the CLI reads the same files, so refusing to render them
        // inconveniences the legitimate owner and protects nobody. Cloud
        // surfaces stay gated by `authorizesCloudCapability`; the file stays
        // kept, which was never in question.
        //
        // The error is TERMINAL, not an expiry: re-authenticating as the same
        // account cannot succeed. `AUTH_ERROR_ACCOUNT_UNAVAILABLE` is what keeps
        // the copy off "sign in again", and it must reach a surface that renders
        // under `unverified` - see `SignInErrorMessage` and the toast bridge,
        // both of which were keyed on `signed-out` until this arm started
        // holding.
        this.setLastError(AUTH_ERROR_ACCOUNT_UNAVAILABLE);
        this.applyUnverifiedSession(stored);
        this.sessionRecoveryTerminallyRejected = true;
        this.settleSessionRecovery(outcome);
        return;
      case "deleted":
      case "tombstoned":
      case "user-mismatch":
        // LOCAL-FILE outcomes: a sign-out stands, the file was tombstoned, or
        // it changed accounts. In each there is no longer an identity ON DISK
        // to hold a local plane FOR, so the session clears outright.
        //
        // Note what is NOT here: `refresh-rejected-account`. A server 403/404
        // is a verdict about the account, not about the file, and the identity
        // block is still on disk - so it holds, in the arm above. These three
        // are the cases where the thing being held for is genuinely absent.
        //
        // THE FILE IS DELIBERATELY KEPT on every one of these, and that is not
        // an unfinished thought.
        // Clearing the UI session is not the same act as destroying the shared
        // credentials file, and the next reader will be tempted to "finish" this
        // arm with a `tokenStore.delete()`. Do not:
        //
        //  - The verdict rests on a STATUS CODE ALONE. `fetchUserResponseOnce`
        //    parses no error body, so a 404 is not a trustworthy "the account
        //    was deleted" signal - a proxy, a misconfigured base URL, or an
        //    authn deploy momentarily dropping the route all mint one.
        //  - The file is MACHINE-SHARED (every window, and the CLI) and its
        //    destruction is irreversible. A false positive during a deploy blip
        //    is a mass sign-out across the machine.
        //  - The asymmetry decides it: holding on a wrong verdict costs noise,
        //    clearing on a wrong verdict costs the session permanently.
        //
        // If clearing is ever wanted, it belongs behind the file lock in the
        // main-process mutation store and on corroborating evidence - a parsed
        // `UserNotFoundError` from the refresh spend - not on a status code from
        // the validate.
        this.clearUiSessionIfSignedIn();
        this.settleSessionRecovery(outcome);
        return;
      case "lock-busy":
      case "spend-pending":
      case "refresh-network":
      case "applied":
      case "superseded":
      case "commit-failed":
        // Transient. (`applied`/`superseded`/`commit-failed` land here only
        // when the adopt guard declined a null or foreign-user pair from the
        // shared main-process store.)
        this.applyUnverifiedSession(stored);
        this.scheduleSessionRecovery(`${trigger}:${outcome}`);
        return;
    }
  }

  /**
   * Whether a SETTLED, server-confirmed session is live. A method (not a
   * direct field read) so checks that straddle `await`s re-read the CURRENT
   * value - TypeScript's narrowing of the mutable field would otherwise flag
   * (and a reader would misjudge) the re-checks as tautological.
   *
   * Every "someone else established a session, stand down" guard in this class
   * means THIS, not the weaker `hasLiveBearer()`. The two came apart when
   * `unverified` arrived: that state holds a real bearer (read off disk, and
   * genuinely usable for local host work) while holding no verdict at all, so
   * a guard written as `hasLiveBearer()` would read it as a settled session,
   * stand the recovery loop down, and strand the user in a state that can
   * never upgrade itself when the network returns.
   *
   * Derived from the store rather than tracked in a second field on purpose:
   * the store's `status` is already the one authority on which of the four
   * session states is live, and a private mirror of it here could disagree.
   */
  private hasVerifiedSession(): boolean {
    return (
      this.currentBearer !== null &&
      useAuthStore.getState().status === "signed-in"
    );
  }

  /**
   * The bearer for a CLOUD PRODUCT call, or `null` when this session holds no
   * `/api/v3/user` verdict. No method on this class issues a request to authn
   * on a caller's behalf without first clearing this gate.
   *
   * Stated as a gate rather than as "the one place a cloud bearer is read",
   * which would be the tidier claim and is false: {@link fetchUserSessions}
   * clears the gate and then takes its token from
   * {@link captureLiveSessionAuthority}, because its repair path needs the whole
   * authority object to fence a rotation on. A rule about where the token comes
   * from would have to carve that out; a rule about what every caller must clear
   * does not.
   *
   * `unverified` holds a real bearer, read off this machine's disk. That token
   * is the right credential for local, host-served work - the host serves
   * local-homed epics from it without asking authn anything - and it is NOT a
   * capability to act on the account. Nothing has confirmed it is still live,
   * whose it is, or that the account behind it still exists, so a non-null
   * check is not an authorization: it answers "is a string present", which is
   * true for a token revoked an hour ago.
   *
   * WHY THIS IS A METHOD AND NOT A GUARD AT EACH CALLER: eight of the nine
   * callers were unreachable before this ticket. Admitting the local plane
   * mounted the app shell (`root-route-components.tsx#isStandalone`) and the
   * settings surfaces (`settings-layout.tsx`) under `unverified`, which is what
   * put `devices-sessions-panel`, the hosts panel and
   * `HostCredentialProvisionProvider` in front of a user holding no verdict.
   * The reachability arrived with the admission, so the refusal lives at one
   * decision point rather than as nine copies that can drift apart.
   *
   * DELIBERATELY NOT GATED: every read that serves the auth machinery's OWN
   * recovery - the work of turning `unverified` back into `signed-in` - plus the
   * cross-window projection of what this window holds. Those keep reading
   * `currentBearer` directly. Gating them would remove the only path out of
   * `unverified` and strand the session there permanently, which is the defect
   * `hasVerifiedSession()` exists to prevent, reintroduced one layer down. Today
   * that class is `revalidateCurrentContextOnce`, `rotateLiveSession`, the
   * proactive scheduler's `getToken`, `getCurrentSessionSnapshot`, and the
   * snapshot-ingest comparisons; the class is the rule and the list is examples
   * of it, so a new recovery read belongs outside this gate without amending
   * anything here.
   *
   * `captureLiveSessionAuthority` is the edge worth knowing about: it is NOT
   * gated, because rotation is one of its callers and rotation must keep
   * working while unverified - but it is not exclusively recovery machinery
   * either. A PRODUCT caller that takes its bearer from it therefore has to
   * clear this gate on its own, which is what {@link fetchUserSessions} does.
   * "Serves recovery" is a property of a call site, not of an accessor.
   *
   * A method rather than a field for the same reason as
   * {@link hasVerifiedSession}: callers that straddle an `await` re-read the
   * current value instead of a narrowed snapshot.
   */
  private cloudBearer(): string | null {
    return this.hasVerifiedSession() ? this.currentBearer : null;
  }

  /**
   * Arm (or extend) the background recovery loop. One timer, exponential
   * backoff, generation-fenced: a user sign-in/sign-out that lands while a
   * tick is pending makes the tick a no-op via `isIdentityCurrent`.
   */
  private scheduleSessionRecovery(trigger: string): void {
    if (this.disposed || this.sessionRecoveryTimer !== null) {
      return;
    }
    const delayMs = this.sessionRecoveryDelayMs;
    // Read at each scheduling rather than latched: the ceiling relaxes as soon
    // as the local plane is admitted, and tightens again if that session is
    // ever cleared, without this loop having to be restarted.
    const maxDelayMs =
      useAuthStore.getState().status === "unverified"
        ? SESSION_RECOVERY_ADMITTED_MAX_DELAY_MS
        : SESSION_RECOVERY_MAX_DELAY_MS;
    this.sessionRecoveryDelayMs = Math.min(delayMs * 2, maxDelayMs);
    this.sessionRecoveryAttempt += 1;
    appLogger.info("[auth] stored-session recovery scheduled", {
      trigger,
      delayMs,
      attempt: this.sessionRecoveryAttempt,
    });
    const generation = this.identityGeneration;
    this.sessionRecoveryTimer = AuthService.scheduleTimeout(() => {
      this.sessionRecoveryTimer = null;
      this.sessionRecoveryInFlight = true;
      void this.runSessionRecovery(generation).finally(() => {
        this.sessionRecoveryInFlight = false;
        if (!this.sessionRecoveryRerunRequested) {
          return;
        }
        this.sessionRecoveryRerunRequested = false;
        // A wake landed mid-probe. Honour it now, from the floor, and only if
        // the state it was about still holds - `runSessionRecovery` may have
        // settled the loop (signed in) or the session may have been cleared
        // while the probe ran, and neither wants a re-arm.
        if (this.disposed || useAuthStore.getState().status !== "unverified") {
          return;
        }
        // REPLACE, never `scheduleSessionRecovery`. The probe that is settling
        // right now has almost always already armed its own ordinary backoff -
        // it schedules on the way out of each failure arm, which happens
        // BEFORE its promise resolves and therefore before this `finally`. So
        // by the time we get here `sessionRecoveryTimer` is non-null, and
        // `scheduleSessionRecovery`'s first line returns early: the wake was
        // recorded, honoured, and then silently dropped, leaving the user
        // `unverified` for up to the full ceiling.
        //
        // Resetting `sessionRecoveryDelayMs` does not rescue it either. The
        // live timeout captured its delay when it was armed; the field only
        // decides what the NEXT arming waits.
        this.replaceScheduledSessionRecovery("wake:deferred-during-probe");
      });
    }, delayMs);
  }

  /**
   * Arm the recovery loop from the FLOOR, displacing any timer already pending.
   *
   * The wake paths' primitive. Both of them mean "the accumulated backoff
   * describes how long authn was unreachable, and this event invalidates that
   * history" - which is a statement `scheduleSessionRecovery` cannot make,
   * because it is single-armed by design: its `sessionRecoveryTimer !== null`
   * guard is what stops overlapping ticks, and a wake path is precisely the
   * caller that must not be deduplicated against a pending tick.
   *
   * A separate method rather than a flag on `scheduleSessionRecovery` so the
   * distinction is a thing a reader (and a test) can hold: "arm if idle" and
   * "arm instead of whatever is pending" are different requests, and the one
   * bug this closes was written as the first while meaning the second.
   */
  private replaceScheduledSessionRecovery(trigger: string): void {
    if (this.disposed) {
      return;
    }
    if (this.sessionRecoveryTimer !== null) {
      AuthService.cancelTimeout(this.sessionRecoveryTimer);
      this.sessionRecoveryTimer = null;
    }
    this.sessionRecoveryDelayMs = SESSION_RECOVERY_INITIAL_DELAY_MS;
    this.scheduleSessionRecovery(trigger);
  }

  /**
   * Network-returned nudge for a session holding the local plane.
   *
   * `online` / OS-resume is the precise event the recovery loop spends its
   * whole life polling FOR, so hearing it directly is strictly better than
   * waiting out a backoff step. It is also what makes the relaxed
   * `SESSION_RECOVERY_ADMITTED_MAX_DELAY_MS` ceiling affordable: the long
   * ceiling covers the case where nothing announces the network's return,
   * while this covers the common case where something does - so a user who
   * regains connectivity upgrades to a real session in about a second rather
   * than sitting at `unverified` for up to five minutes.
   *
   * Scoped to `unverified` deliberately. A signed-in session's wake handling
   * is the refresh scheduler's job (above), and a signed-out one has nothing
   * to recover.
   */
  private nudgeSessionRecoveryOnWake(): void {
    if (this.disposed) {
      return;
    }
    if (useAuthStore.getState().status !== "unverified") {
      return;
    }
    // A network event cannot revive a credential the server has REFUSED. Waking
    // is evidence about the network, and this session did not stop for the
    // network.
    if (this.sessionRecoveryTerminallyRejected) {
      return;
    }
    // A probe is already running. Record the intent and let it re-arm from the
    // floor when it settles - starting a second one here is exactly the overlap
    // P2-6 names, and the running probe is already asking the question this
    // event wants asked.
    if (this.sessionRecoveryInFlight) {
      this.sessionRecoveryRerunRequested = true;
      return;
    }
    // Re-arm from the FLOOR: the accumulated backoff describes how long authn
    // was unreachable, which is exactly the history this event invalidates.
    this.replaceScheduledSessionRecovery("wake:network-returned");
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
    // A wake deferred during the probe that is settling right now must not
    // re-arm a loop this call just stood down.
    this.sessionRecoveryRerunRequested = false;
  }

  /**
   * One recovery tick: re-read the file, validate access-only, and either
   * adopt, spend through the locked rotate, or re-arm. Stands down for a live
   * session, an interactive attempt, or an emptied file.
   */
  private async runSessionRecovery(generation: number): Promise<void> {
    if (!this.isIdentityCurrent(generation)) {
      return;
    }
    if (this.hasVerifiedSession()) {
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
    // A failed superseded-save undo left a stale pair durable. Complete that
    // conditional delete BEFORE reading anything to adopt — otherwise this
    // very loop would validate and re-adopt the zombie the fence dropped.
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
    if (!this.isIdentityCurrent(generation) || this.hasVerifiedSession()) {
      return;
    }
    if (stored === null || stored.token.length === 0) {
      // The file is gone (a sibling slot signed out - that deletes the SHARED
      // file for the whole machine). An `unverified` session is held on behalf
      // of an identity ON DISK, so once that identity is gone there is nothing
      // left to hold the local plane for and it must not outlive the file.
      // Without this the offline session would persist indefinitely: this tick
      // settles the loop, so no later tick would revisit it.
      this.clearUiSessionIfSignedIn();
      this.settleSessionRecovery("no-stored-session");
      return;
    }
    const outcome = await this.validateToken(stored.token);
    if (!this.isIdentityCurrent(generation) || this.hasVerifiedSession()) {
      return;
    }
    await this.applyRecoveryValidationOutcome(stored, outcome, generation);
  }

  /**
   * Tail of {@link runSessionRecovery}, once `validateToken` has answered.
   *
   * Extracted for the same reason as {@link adoptRecoveredStoredSession}: the
   * recovery tick has to stay under the complexity ceiling, and the two
   * pending-undo re-checks here are branches it cannot afford inline. They
   * live together because they answer one question at two exits - whether the
   * pair this tick read is still the pair the store means to serve.
   */
  private async applyRecoveryValidationOutcome(
    stored: StoredCredentials,
    outcome: ValidationOutcome,
    generation: number,
  ): Promise<void> {
    if (outcome.kind === "valid") {
      await this.adoptRecoveredStoredSession(stored, outcome.user, generation);
      return;
    }
    if (outcome.kind === "network-error") {
      // No verdict is no reason to spend: re-validate on the next tick. Only
      // a REJECTED verdict authorizes the locked rotate - otherwise a
      // half-reachable authn (identity probe down, refresh up) would rotate
      // the freshly-committed pair again on every tick, burning one refresh
      // generation per backoff step for pairs it can never validate.
      //
      // Admit the local plane here too, not just at startup: this tick is
      // also reached from a store fault and from a reconcile blip, and the
      // user is equally entitled to their own disk in all three.
      //
      // "Their own disk" is the premise, so the undo fence is re-checked
      // here for the same reason the valid branch re-checks it: the entry
      // fence ran BEFORE `validateToken`, and an undo that registered during
      // that round trip means the pair we read is a write that lost and has
      // not finished losing. Admitting the local plane on it would project
      // another identity's bearer and profile - violating this arm's policy
      // while wearing its words.
      if (this.pendingUndoTokens.size > 0) {
        this.scheduleSessionRecovery("recovery:validate-network-pending-undo");
        return;
      }
      this.applyUnverifiedSession(stored);
      this.scheduleSessionRecovery("recovery:validate-network");
      return;
    }
    // Same re-check BEFORE the spend. `rotateStoredSession` performs the
    // locked rotate, so a pending-undo zombie here is not a wrong session but
    // an irreversible server-side act on a credential we have already decided
    // we do not own - and against rotation-replay controls, spending a
    // superseded refresh token can burn the whole refresh family.
    if (this.pendingUndoTokens.size > 0) {
      this.scheduleSessionRecovery("recovery:rotate-pending-undo");
      return;
    }
    await this.rotateStoredSession(
      stored,
      () => this.isIdentityCurrent(generation),
      "recovery",
    );
  }

  /**
   * Tail of {@link runSessionRecovery} for a stored session the server just
   * called valid: confirm the file still holds it, then sign in. Extracted so
   * the recovery tick stays under the complexity ceiling.
   */
  private async adoptRecoveredStoredSession(
    stored: StoredCredentials,
    user: AuthenticatedUser,
    generation: number,
  ): Promise<void> {
    if (!(await this.storedSessionStillOnDisk(stored.token))) {
      // A sign-out (or a sibling rotation) landed while `/user` was in flight.
      // Re-arm rather than settle: if the file is gone the next tick reads null
      // and settles on `no-stored-session`; if it was rotated the next tick
      // adopts the CURRENT pair.
      this.scheduleSessionRecovery("recovery:stored-session-superseded");
      return;
    }
    if (!this.isIdentityCurrent(generation) || this.hasVerifiedSession()) {
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
   * True while `generation` is still the live identity transition (and the
   * service is not disposed). Async credential tails capture the generation
   * before their first await and re-check through this after each one, so a
   * newer `signIn()` / `signOut()` / `dispose()` always wins over an
   * already-started save/rotate/provision.
   */
  private isIdentityCurrent(generation: number): boolean {
    return !this.disposed && generation === this.identityGeneration;
  }

  /**
   * Re-read the file and confirm it still carries `token` before an AUTOMATIC
   * path adopts it into a signed-in UI.
   *
   * The generation fences cannot cover this. `identityGeneration` moves only on
   * a LOCAL `signIn`/`signOut`/`dispose`; an external mutation - most
   * importantly another slot's explicit sign-out, which deletes the shared file
   * for the whole machine by design - arrives through the watcher and reconcile,
   * which deliberately leave it alone. So a deletion that lands while our
   * `/user` probe is in flight leaves every fence intact: the UI is already
   * signed out (nothing to clear, no bearer installed), and the stale token is
   * still valid server-side for hours. Adopting it would resurrect a session
   * the user explicitly ended, with no further file event to correct it.
   *
   * A read fault answers "not current": refusing to adopt is recoverable (the
   * loop retries), adopting a session that is gone is not.
   */
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
    // Explicit user intent replaces the automatic loop: a pending recovery
    // tick would only race the attempt (it stands down, but its timer would
    // fire a stale no-op). A failed attempt re-arms recovery (applyFailure);
    // a successful one settles it again (applySignedIn).
    this.settleSessionRecovery("interactive-attempt");
    this.setLastError(null);
    const attempt = this.beginAttempt();
    useAuthStore.getState().setSigningIn("device");
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
      phase: "waiting-approval",
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
    const priorStatus = useAuthStore.getState().status;
    this.identityGeneration += 1;
    // Stop the proactive refresh timer up front so a timer firing during the
    // delete can't race a `rotate` against the credential removal; the
    // recovery loop stands down for the same reason (explicit intent settles
    // it - nothing to recover after a deliberate sign-out).
    this.refreshScheduler.stop();
    this.settleSessionRecovery("explicit-sign-out");
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
      // Restore what the sign-out stood down, BY THE STATE IT STOOD DOWN
      // FROM. A verified session had the proactive scheduler; an unverified
      // one had the stored-session recovery loop (re-armed from the floor -
      // the settle above reset it) unless authn's verdict was terminal, in
      // which case nothing was running and nothing may start: starting the
      // scheduler there would spend the refused refresh credential again at
      // expiry or on wake, the exact spend `unverified` exists to prevent.
      if (priorStatus === "unverified") {
        if (!this.sessionRecoveryTerminallyRejected) {
          this.scheduleSessionRecovery("sign-out-delete-failed");
        }
        return;
      }
      // The session is still live - re-arm the proactive refresh we paused.
      this.refreshScheduler.start();
      return;
    }
    this.setLastError(null);
    this.applySignedOut("retired");
    // Published chat bytes do not survive leaving the account.
    //
    // The part store is shared across every viewer on the installation, which
    // is sound while they are signed in - a part is named by the sha256 of its
    // own bytes, so the only way to learn an address is to resolve a head the
    // server authorized you for. It is not sound as a residue: "leave the
    // account" reasonably means "leave the content", and the cost of honoring
    // that is one cold read next time.
    //
    // HERE and not in `applySignedOut`, which also runs for the UI-only
    // signed-out projection a dead credential produces (the file is kept, and
    // the same user is one refresh from being back). This is the deliberate
    // path, and it runs only after the delete actually landed.
    //
    // Not awaited into the sign-out's critical path and unable to fail it: the
    // clear swallows its own errors by contract, and a sign-out that stalled on
    // a storage quirk would be a worse outcome than a cache that outlives it by
    // a moment.
    void clearChatPartCache(browserChatPartCacheStorage());
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
   * picked up the next time a transport reads its injected bearer source,
   * which is the same lease object. (Deliberately not spelled
   * `ctx.credentials.getBearerToken()`: that reach is lint-fenced outside the
   * two transport files, and a doc that spells a banned shape teaches it.)
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
   * Fires when a session that HELD a cloud verdict loses it on a terminal
   * server rejection (`demoteVerifiedSessionToUnverified`) - never for the
   * `unverified` a cold start or an unreachable authn lands in, which is no
   * transition at all. The snapshot listeners cannot carry this edge: an
   * `unverified` snapshot is deliberately never projected cross-window, and
   * the status it would flatten to signs sibling windows out. Consumers that
   * hold their own copy of the session outside this renderer (the desktop
   * main process, whose jar plane speaks for the account on it) subscribe
   * here to withdraw it. Edge only: no replay on subscribe. Carries the
   * rejected bearer so a copy can fence the withdrawal to THAT session: the
   * desktop main process serves every window, and a demotion here can reach
   * it after a sibling window's fresh sign-in did.
   */
  onCloudAuthorizationRevoked(
    handler: (revoked: RevokedCloudAuthorization) => void,
  ): Disposable {
    this.cloudAuthorizationRevokedListeners.add(handler);
    return {
      dispose: () => {
        this.cloudAuthorizationRevokedListeners.delete(handler);
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
      // As above: an external session's attempt kind is not carried.
      useAuthStore.getState().setSigningIn("device");
      return;
    }
    if (session.status === "signed-out") {
      this.applySignedOut("retired");
      return;
    }
    const liveContext = this.contextProvider.current();
    if (
      liveContext !== null &&
      liveContext.identity.userId === session.user.user.id &&
      this.currentBearer !== session.token
    ) {
      // Read BEFORE the store commit below, for the same announcement rule
      // `applySignedIn` applies: only a promotion (`unverified` ->
      // `signed-in`) moved an ambient answer, so only a promotion announces.
      const heldVerdict = useAuthStore.getState().status === "signed-in";
      // COMMIT BEFORE EMIT (see `applySignedIn`) - the rotation notification
      // below is synchronous, and this projection path rotates just as often
      // as the local ones.
      this.commitLiveCredential(session.token, session.profile);
      this.commitSubscriptionStatus(
        session.user.userSubscription.subscriptionStatus,
      );
      // RESTORE THE VERDICT: a sibling window validated this session end to
      // end, so this is a verdict-bearing transition and not merely a new
      // token - the store lands on `signed-in` a few lines below. An in-place
      // rotation moves the bearer and nothing else, so a window that took this
      // path while `unverified` would otherwise show a signed-in session whose
      // every direct cloud worker is still fenced by
      // `buildBearerHeadersFromContext`, with no later edge to release it.
      liveContext.setCloudAuthorized(true);
      this.contextProvider.rotateCurrentBearer({
        userId: liveContext.identity.userId,
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
      // The post-commit verdict announcement, exactly as `applySignedIn`
      // makes it as its last act. `HostRuntime` retries the directory refresh
      // that was refused while unverified on THIS event and on nothing else -
      // the bearer-rotation notification above only invalidates in-flight
      // work - so a window that restored its verdict through this branch and
      // did not announce kept an empty remote directory until an ambient poll.
      if (!heldVerdict) {
        this.contextProvider.announceSessionVerified();
      }
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

  /**
   * Fetches the signed-in user's host registry + live status via the runner
   * host (`GET /api/v3/hosts`, run in Electron main for CORS). Mirrors
   * {@link fetchAuthenticatedUser}: the raw bearer stays inside this service
   * (the auth boundary), so the My Hosts query hook consumes the parsed
   * envelope without ever touching the token.
   *
   *   - no CLOUD bearer        → `null` (the panel renders its signed-out
   *                              state). That is signed-out, and equally an
   *                              `unverified` session: it holds a token off
   *                              disk but no verdict, so it may not read the
   *                              account's host registry. See
   *                              {@link cloudBearer}.
   *   - `unauthorized`         → `null` (a rare mid-rotation 401; the proactive
   *                              refresh keeps the bearer fresh and the ~60s poll
   *                              recovers on the next tick — no forced sign-out
   *                              from a background list poll).
   *   - `network-error`        → throws so TanStack Query surfaces a retriable
   *                              error instead of a misleading empty list.
   *   - superseded `era`       → throws {@link SupersededAuthEraError} WITHOUT
   *                              fetching (see below). Deliberately not `null`:
   *                              `null` means signed-out, which the directory
   *                              treats as an authoritative CLEAR, and "I
   *                              refused to ask" is not evidence of anything.
   *                              A throw takes the retain-last-known path.
   *
   * `era` is the credential era the caller is asking on behalf of — threaded
   * from the `onChange` emission for a transition-driven refresh, or
   * {@link currentAuthEra} for an ambient one.
   */
  async fetchRegisteredHosts(era: AuthEra): Promise<HostListResponse | null> {
    // THE ISSUE-TIME CREDENTIAL CHECK, and it lives here because this is where
    // the credential is read. Every previous attempt to fence this refresh put
    // the check one layer up — on the memo, on the commit — and each time the
    // request still went out under a bearer belonging to somebody else,
    // because the layer doing the checking never saw which credential the
    // fetch would actually use.
    //
    // `era` names the credential era this refresh was ISSUED FOR; the pair
    // below is the era the live bearer actually belongs to, written together
    // in `commitLiveCredential`. If they disagree, this call is about to send
    // a credential from a different era than the one it is answering for —
    // refuse instead, and let the caller take its retain-last-known path.
    //
    // The identity half is what makes the ordering contract fail CLOSED: if a
    // future edit moves an assignment back after its emission, this sees a
    // bearer still belonging to A while being asked for B and stops, rather
    // than fetching A's hosts and committing them under B. The generation
    // half catches the same mismatch within one identity, where the user id
    // is identical and only the token has been replaced.
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
    const bearer = this.cloudBearer();
    if (bearer === null) {
      return null;
    }
    // Two independent callers reach this endpoint: the globally-mounted
    // `HostDirectoryService` poll and the Settings liveness query, plus their
    // event triggers (focus refetch, picker open, context change). They are
    // on different sides of the TanStack cache, so nothing above this point
    // can deduplicate them, and their triggers genuinely coincide — a window
    // regaining focus fires both at once.
    //
    // In-flight coalescing only, deliberately: callers that arrive together
    // share one request, and a caller that arrives after it settles gets a
    // real fetch. A result memo would have been the way to halve the steady
    // rate too, but `directory.refresh()` on picker-open is a correctness
    // path — it exists to be current at that instant — and handing it a
    // seconds-old answer to save a request is the wrong trade.
    // KEYED BY BEARER, and that is the whole safety property. An unkeyed memo
    // hands whoever arrives next the answer to somebody else's question: sign
    // out of A and into B while A's request is in flight, and B is served A's
    // host list — another account's machine names, ids and platforms rendered
    // as B's own. The same slot would also let B await a request whose bearer
    // is already invalid and inherit its 401.
    //
    // Losing the coalescing across a token rotation is an acceptable cost (one
    // extra request); serving one identity's data to another is not, so the
    // comparison is on the exact bearer rather than on user id — a rotated
    // token for the SAME user is still a different request than the one in
    // flight, and cheap to just re-issue.
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

  /**
   * Clears the in-flight slot, but only if it is still OURS.
   *
   * Called whether the request resolved or threw: a failed read must not pin a
   * rejected promise that every later caller re-awaits. Guarded because a
   * request superseded by an identity change must not clear the NEWER slot
   * when it finally settles — the superseding caller has its own request in
   * there, and clearing it would drop the coalescing for everyone waiting on
   * it.
   *
   * A separate method rather than an inline `finally` body on purpose: inside
   * `fetchRegisteredHosts`, TypeScript still has the slot narrowed to the
   * object assigned a few lines above and reports the null check as
   * unnecessary. It is not — reentrancy across the `await` is exactly what it
   * guards — and narrowing that is wrong about concurrency is not a reason to
   * delete a live guard.
   */
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
   * Fetches the signed-in user's device/session list via authn-v3. The raw
   * bearer remains inside this auth boundary; callers consume a parsed DTO from
   * TanStack Query and render signed-out as an empty state.
   *
   * `signal` is the reading query's cancellation, and it is load-bearing for
   * more than the request: the repair below spends a single-use refresh
   * rotation. Identity fencing alone does not cover this, because the common
   * cancellations - a revoke invalidating the list, a panel unmount, a poll
   * superseded by a focus refetch - leave the SAME account live, so every
   * authority check still passes while nobody is waiting for the answer.
   * Aborting is therefore checked on entry and after each list await, and
   * throws rather than returning `null`, so a cancelled read can never be
   * mistaken for the signed-out empty state.
   */
  async fetchUserSessions(
    signal: AbortSignal,
  ): Promise<ListUserSessionsResponse | null> {
    signal.throwIfAborted();
    // Clears {@link cloudBearer}'s gate before taking a token from anywhere
    // else. This method cannot READ its bearer from that accessor - the repair
    // path below needs the whole `LiveSessionAuthority` to fence its rotation
    // on - but it is a cloud product read like the eight that do, and the
    // panel that drives it mounts under `unverified` since this ticket
    // admitted the settings surfaces.
    //
    // Refusing here also keeps an unverified session out of the REPAIR, which
    // spends a single-use refresh rotation. That spend belongs to the recovery
    // loop and its backoff; reached from a 30s panel poll instead, the loop's
    // request ceiling would not be a ceiling.
    if (this.cloudBearer() === null) {
      return null;
    }
    const initialAuthority = this.captureLiveSessionAuthority();
    if (initialAuthority === null) {
      return null;
    }
    const initial = await this.runnerHost.listUserSessions(
      initialAuthority.bearer,
      signal,
    );
    // This is the fence that keeps a cancelled read out of the repair below:
    // everything between here and the rotation is synchronous, so bailing here
    // is the same as bailing there.
    //
    // Ordered before the authority check on purpose: an aborted read is a
    // non-answer, not an account change, and the two shells disagree on how an
    // aborted request surfaces (in-process `fetch` collapses it into
    // `network-error`; the desktop bridge rejects). Checking here makes both
    // reach the caller as the same cancellation.
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

    // A prior repair already rotated this exact bearer without reaching an
    // identified current session (e.g. the server-side condition is stuck,
    // not transient). Repeating the rotate on every 30s poll/focus refetch
    // would keep spending `/api/v3/auth/refresh` against an unchanging bearer
    // forever and permanently error the panel; return what we have instead.
    if (
      initial.kind === "ok" &&
      this.unrepairableSessionsBearer === initialAuthority.bearer
    ) {
      return initial.response;
    }

    // A still-valid credential from before individual session tracking has no
    // row/family yet, and the original upgrader recorded an existing desktop
    // row as `unknown`. Listing used to turn either case into an authoritative
    // empty/unknown UI. One locked refresh lets authn create or enrich the row;
    // then read again with the rotated bearer. The existing single-flight +
    // cross-process credential lock keeps this from double-spending a refresh.
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
   * Revokes one session family. `useStepUpCredential` is false for the first
   * attempt; if authn responds `step-up-required`, the UI verifies an OTP and
   * retries by asking the runner-host boundary to attach its retained step-up
   * bearer internally.
   */
  async revokeUserSession(
    familyId: string,
    useStepUpCredential: boolean,
  ): Promise<RevokeUserSessionFetchResult> {
    const bearer = this.cloudBearer();
    if (bearer === null) {
      return { kind: "unauthorized" };
    }
    return this.runnerHost.revokeUserSession(
      bearer,
      familyId,
      useStepUpCredential,
    );
  }

  /**
   * Global sign-out is intentionally tighter than per-session cleanup: callers
   * verify a fresh step-up challenge for each invocation, then the runner-host
   * boundary attaches and clears the retained step-up bearer internally.
   */
  async revokeAllSessions(): Promise<RevokeAllSessionsFetchResult> {
    const bearer = this.cloudBearer();
    if (bearer === null) {
      return { kind: "unauthorized" };
    }
    return this.runnerHost.revokeAllSessions(bearer);
  }

  /**
   * Mints a device credential for a connected host. A single attempt on the
   * ordinary bearer: unlike `revokeUserSession` there is no step-up retry,
   * because the mint is not step-up gated (see the mint route's doc comment).
   */
  async mintHostCredential(
    request: MintHostCredentialRequest,
  ): Promise<MintHostCredentialFetchResult> {
    const bearer = this.cloudBearer();
    if (bearer === null) {
      return { kind: "unauthorized" };
    }
    return this.runnerHost.mintHostCredential(bearer, request);
  }

  async requestStepUpChallenge(): Promise<StepUpChallengeFetchResult> {
    const bearer = this.cloudBearer();
    if (bearer === null) {
      return { kind: "unauthorized" };
    }
    return this.runnerHost.requestStepUpChallenge(bearer);
  }

  /**
   * Mints a one-time link-login code for the "Link mobile app" QR surface. The
   * raw bearer stays inside this auth boundary; the panel consumes only the
   * short-lived one-time code, which is itself the thing being displayed.
   */
  async mintLinkLoginCode(
    signal: AbortSignal,
  ): Promise<MintLinkLoginCodeFetchResult> {
    // Gated on the VERDICT, not on a non-null bearer. `this.currentBearer !==
    // null` was a correct verdict check when this was written - on `main` a
    // present bearer meant a confirmed one, because no other state existed.
    // `unverified` is exactly that other state, so OUR change falsified this
    // gate rather than this gate failing to meet our policy. See
    // {@link cloudBearer}.
    const bearer = this.cloudBearer();
    if (bearer === null) {
      return { kind: "unauthorized" };
    }
    return this.runnerHost.mintLinkLoginCode(bearer, signal);
  }

  async verifyStepUpChallenge(
    code: string,
  ): Promise<RetainedStepUpVerifyFetchResult> {
    const bearer = this.cloudBearer();
    if (bearer === null) {
      return { kind: "unauthorized" };
    }
    return this.runnerHost.verifyStepUpChallenge(bearer, code);
  }

  /**
   * "Update now" / auto-update policy toggle / "Apply now — ends N sessions"
   * (Remote Host Support §13, T16): `PATCH /api/v3/hosts/:hostId` via the
   * runner host (run in Electron main for CORS, mirroring
   * {@link fetchRegisteredHosts}). Never returns `null` when there is no cloud
   * bearer: it throws, because a mutation has no empty state to render the way
   * the read path does, so its refusal has to be loud enough to reach the user.
   *
   * TWO states reach that throw and only one of them is a caller bug. Signed-out
   * is — nothing should offer this. `unverified` is NOT: this ticket admits the
   * settings surfaces without a `/api/v3/user` verdict, so the hosts panel
   * genuinely mounts for someone holding a token nothing has confirmed, and the
   * button is genuinely pressable. The copy already says the right thing to
   * them. See {@link cloudBearer}.
   */
  async updateHostVersionPolicy(
    hostId: string,
    input: UpdateHostVersionPolicyInput,
  ): Promise<UpdateHostVersionPolicyFetchResult> {
    const bearer = this.cloudBearer();
    if (bearer === null) {
      throw new Error("Sign in to update this host.");
    }
    return this.runnerHost.updateHostVersionPolicy(bearer, hostId, input);
  }

  /**
   * "Remove from account": `POST /api/v3/hosts/:hostId/deregister` via the
   * runner host (run in Electron main for CORS, mirroring
   * {@link fetchRegisteredHosts}). Throws with no cloud bearer for the same
   * reason {@link updateHostVersionPolicy} does, and reachable from the same
   * two states — read the note there before narrowing this one back to
   * signed-out.
   */
  async deregisterHostFromAccount(
    hostId: string,
  ): Promise<DeregisterHostFetchResult> {
    const bearer = this.cloudBearer();
    if (bearer === null) {
      throw new Error("Sign in to remove this host.");
    }
    return this.runnerHost.deregisterHostFromAccount(bearer, hostId);
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
      // Subscription entitlement can change without a bearer rotation (for
      // example after a purchase or restore). Project every successful
      // validation so entitlement-gated surfaces react without an app restart.
      this.commitSubscriptionStatus(
        outcome.user.userSubscription.subscriptionStatus,
      );
      if (outcome.user.user.id !== currentUserId) {
        // The bearer now validates to a different user (a cross-user re-seed) -
        // treat as a fresh sign-in so the old context aborts cleanly.
        this.applySignedIn(currentToken, outcome.user, undefined);
      } else {
        // Same argument as the subscription commit above, applied to the rest
        // of the person-facing identity: a display name, avatar or team
        // membership can change without a bearer rotation, and projecting only
        // entitlement left every other field one launch stale. Projection plus
        // the service's own profile copy, gated on a real difference - see
        // `reprojectSameUserIdentity` for why re-entering `applySignedIn` is
        // not available here.
        this.reprojectSameUserIdentity(outcome.user);
        // ...and DURABLY, which the projection alone is not. `applySignedIn`
        // is the only other writer of this snapshot and this path deliberately
        // avoids it, so nothing else on this branch persists anything: the
        // next launch paints the cached identity again, and if that launch's
        // validation takes the accepted network-error path the stale name and
        // avatar stand for the whole session. `settleProvisionalSession` pairs
        // these two calls for exactly this reason; this is the same pair on
        // the live-revalidation path, which had only the first half.
        //
        // Unconditional, matching that sibling. Gating it on
        // `reprojectSameUserIdentity`'s notion of "changed" would couple the
        // snapshot's contents to a comparison over the PROJECTED fields, which
        // is a strict subset of what the snapshot stores.
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
      if (revalidated.kind === "valid") {
        return revalidated;
      }
      if (revalidated.kind === "network-error") {
        // TRANSIENT, and it must not be reported as a terminal rejection. The
        // rotate succeeded and `result.token` is committed; only the identity
        // probe failed to answer. Collapsing this to `rejected` told the caller
        // a live credential was dead, which is the reverse of the mistake the
        // rest of this file is careful about - and it is the one that spends,
        // because a caller reading `rejected` goes looking for another rotate.
        return revalidated;
      }
      // The FRESHLY-ROTATED token is itself rejected. Nothing here changed
      // session state before this fix, so the store stayed `signed-in` on a
      // bearer authn had just refused: `cloudBearer()` kept handing it out,
      // attach-grant mints stayed enabled, and the scheduler stayed armed.
      //
      // Startup has always handled the same post-rotate verdict correctly (see
      // `rotateStoredSession`'s tail). This is the live path reaching the same
      // state and doing nothing about it - the third intake path that failed to
      // hold the plane, and the reason all of them were enumerated rather than
      // fixed one at a time.
      this.setLastError(AUTH_ERROR_SESSION_EXPIRED);
      this.demoteLiveSessionOnTerminalVerdict(result.token);
      return { kind: "rejected" };
    }
    // Both terminal shapes report `rejected` to the request layer: the
    // credential cannot authorize this call either way. They differ in what
    // happened to the SESSION, which is not this return value's subject - see
    // `SameUserRotateResult`.
    return result.status === "signed-out" || result.status === "credential-dead"
      ? { kind: "rejected" }
      : { kind: "network-error" };
  }

  // Rotate the live credential lease in place onto `bearerToken` - observably
  // silent on the provider, so host-runtime / cache state survives - and re-arm
  // the refresh scheduler. The single point every same-user adoption goes through
  // (locked-rotate outcomes and the §4 reconcile worker).
  private rotateLiveBearer(userId: string, bearerToken: string): void {
    // NO server-time sample here, deliberately. This is the generic
    // lease-adoption helper, and MOST of what it adopts is not freshly minted:
    // `applyReconciledOutcome` passes a token read straight off disk, and the
    // `superseded`/`commit-failed` rotate arms adopt a pair some other window
    // already committed. A backgrounded window that reconciles after five
    // minutes adopts a perfectly valid token whose `iat` is legitimately that
    // old - and sampling it would report the token's AGE as a server-time
    // offset, flipping the app-wide verdict to `skewed` on a correct clock.
    // That is a false banner plus every transport made eligible to park on the
    // next unrelated auth failure. See `applyLiveRotateOutcome` for the one
    // arm that is genuinely mint-proven.
    //
    // COMMIT BEFORE EMIT (see `applySignedIn`): `rotateCurrentBearer` notifies
    // its rotation listeners synchronously. The profile is unchanged - a
    // rotation is the same account with a new token - and passing the live one
    // back through the single commit site keeps the pair written together.
    this.commitLiveCredential(bearerToken, this.currentProfile);
    this.contextProvider.rotateCurrentBearer({ userId, bearerToken });
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
    trigger: string,
  ): SameUserRotateResult {
    appLogger.info("[auth] live rotate outcome", {
      trigger,
      outcome: rotated.outcome,
    });
    switch (rotated.outcome) {
      case "applied": {
        // THE server-time sample site, and the only one: `applied` means THIS
        // process's locked rotate just spent the refresh against authn and
        // committed the pair it minted, so the token is seconds old and its
        // `iat` IS authn's clock. The neighbouring arms are deliberately not
        // sampled - `superseded` adopts a pair another window committed and
        // `commit-failed` can carry a pending pair of unknown age, and a token
        // whose age we cannot bound reads as an offset we did not measure.
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
      case "refresh-rejected-account":
      case "refresh-rejected-credential": {
        // The ordinary mid-session expiry: a signed-in user editing local work
        // whose refresh authn rejects with a verdict about the TOKEN. This arm
        // used to `clearUiSession()`, which is cold-review P1-4 - it produced a
        // real `signed-out`, redirecting the shell out from under the work and
        // firing `useAuthIdentityTransition`'s destructive arm (which PURGES
        // account-scoped persisted state; reading positions are deleted from
        // disk). The stored-session path has always treated the identical
        // verdict as credential-scoped and held the plane, so the two disagreed
        // about the same outcome.
        //
        // The bearer in hand is the right one to hold on: the REFRESH token is
        // what was rejected, the access token keeps its own TTL, and it is the
        // credential the host is already serving local epics on. Identity comes
        // from the live profile rather than the file, because this path never
        // re-reads the file and `rotated.pair` is `null` on every rejection.
        // Same demotion, DIFFERENT copy. Both hold the plane, but one is an
        // expiry the user can clear by signing in again and the other is
        // terminal for this account - telling the second group to "sign in
        // again" sends them round a loop with no exit.
        this.setLastError(
          rotated.outcome === "refresh-rejected-account"
            ? AUTH_ERROR_ACCOUNT_UNAVAILABLE
            : AUTH_ERROR_SESSION_EXPIRED,
        );
        if (!this.demoteLiveSessionOnTerminalVerdict(this.currentBearer)) {
          // No live identity to hold a plane FOR. Nothing to demote, so take
          // the old behaviour rather than inventing a session.
          this.clearUiSession();
          return { status: "signed-out" };
        }
        // NOT `signed-out` (the session was demoted, not cleared) and NOT
        // `transient` (callers read that as retriable, and re-driving a dead
        // refresh is the spend this whole path avoids).
        return { status: "credential-dead" };
      }
      case "lock-busy":
      case "spend-pending":
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
    this.applySignedOut("retired");
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
    // Every store fault is transient from the session's point of view, so the
    // signed-out projection must never latch: arm the recovery loop here, at
    // the one seam every fault path passes through (the loop's own store read
    // keeps re-arming it while the fault persists, and stands down for a live
    // session).
    this.scheduleSessionRecovery(`${context}:store-unavailable`);
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
   *   - file present + invalid/expired → UI-only sign-out + a handoff to the
   *     recovery loop, which owns the locked rotate (never spent here).
   *
   * Every apply is gated by identity + reconcile generation after each await.
   */
  private async runReconcileOnce(): Promise<void> {
    if (this.isDisposed()) {
      return;
    }
    // Same fence as the recovery tick: a self-write watcher echo from the
    // very save whose undo is pending must not become the adoption path that
    // resurrects it. Runs before the generation capture so a fresh reconcile
    // request during the retry supersedes this pass normally.
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
    // Adoption-time fence re-check (synchronous — no interleave between it
    // and the projection below): the entry fence can pass BEFORE a
    // superseding finalization even begins its undo, since this reconcile
    // was triggered by that very write's watcher echo. If an undo registered
    // while validation was in flight, this pass adopts nothing and the
    // recovery loop finishes the delete first.
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
   * Adoption tail of {@link runReconcileOnce}, after every local fence has
   * passed: a STORE re-read mirroring the recovery path's
   * `storedSessionStillOnDisk`. The local pending-undo set only knows THIS
   * window's undos — another window's undo registers its quarantine at the
   * store authority, whose reads then stop serving the pair — so the
   * validated snapshot is projected only if the store still serves it.
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
   * Projects a reconcile's access-only validation result onto the UI session
   * (never writes/spends itself). Same-user → rotate the lease in place
   * (host-runtime / cache state survives); signed-out→present or account
   * switch → full signed-in projection; network blip → leave the live session
   * intact; invalid/expired → UI-only sign-out plus a recovery-loop handoff
   * (the loop owns the locked rotate that can revive the stored session).
   */
  private applyReconciledOutcome(
    stored: StoredCredentials,
    outcome: ValidationOutcome,
  ): void {
    if (outcome.kind === "valid") {
      const liveUserId = this.contextProvider.current()?.identity.userId;
      if (
        liveUserId !== undefined &&
        liveUserId === outcome.user.user.id &&
        // ...AND we already hold a VERIFIED session. Under `unverified` the
        // live context carries the same `userId` (it was minted from the same
        // on-disk identity), so this branch would otherwise capture the
        // promotion case and rotate the bearer in place - and
        // `rotateLiveBearer` deliberately never touches the store, so the
        // status would stay `unverified` FOREVER despite a successful verdict
        // in hand. There is no later trigger to correct it: a
        // credential-scoped rejection has already settled the recovery loop.
        //
        // A first valid verdict for an unverified session is a PROMOTION, not
        // a rotation, so it falls through to `applySignedIn` - which handles
        // the same-user case by rotating the context in place anyway (keeping
        // the "same user => same context object" invariant) while also
        // projecting the signed-in state the store is missing.
        this.hasVerifiedSession()
      ) {
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
      // Transient: cannot adopt an unvalidated bearer, and a live session is
      // never torn down over a blip. With NO live session there is also no
      // later file event guaranteed (authn recovering writes nothing), so the
      // adoption is handed to the recovery loop instead of dropped.
      if (!this.hasVerifiedSession()) {
        // Same entitlement to local disk as the startup and recovery arms.
        this.applyUnverifiedSession(stored);
        this.scheduleSessionRecovery("reconcile:validate-network");
      }
      return;
    }
    // Invalid/expired but PRESENT: the file may still hold a perfectly
    // refreshable session (a 4h-expired access token next to a 30d refresh
    // token), so the spend is handed to the recovery loop, which owns the
    // locked rotate - never latch a dead state over a file that is one refresh
    // call away from a live session.
    //
    // HOLDS rather than clears, and this arm used to call
    // `clearUiSessionIfSignedIn()`. That guard fires on a non-null bearer or
    // context, both of which an `unverified` session has - so a window working
    // offline on T1 was signed out the moment a sibling wrote a same-user T2
    // whose validation happened to reject: route unmounted, every destructive
    // identity-transition consumer fired, local work gone. The rejection is a
    // verdict about the FILE's token, and this window was not using it.
    //
    // `stored` is non-null here, so an identity to hold the plane for exists by
    // construction - the same identity the network-error arm above holds on.
    // The file-is-gone case, which genuinely has nobody to hold it for, is
    // handled earlier and still clears.
    this.applyUnverifiedSession(stored);
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
    const expected = this.captureLiveSessionAuthority();
    if (expected === null) {
      return Promise.resolve();
    }
    return this.forceRefreshExpectedSession(expected).then(() => undefined);
  }

  /**
   * Refresh only the session authority supplied by the caller. This is used by
   * the session-list repair so a late response for account A cannot rotate or
   * clear the credential that account B installed in the meantime.
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
    // Defer to an in-flight reactive revalidation. Both paths drive the locked
    // `rotate`; awaiting here serializes the proactive and reactive refreshes
    // within this process, and the file lock serializes across processes - so at
    // most one process ever spends a given refresh token.
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
    // `superseded` here adopts a sibling's rotation without spending; `deleted`/
    // `user-mismatch`/`tombstoned`/`refresh-rejected-account` clear the UI
    // session (no resurrection); `refresh-rejected-credential` is the genuine
    // expiry and DEMOTES to `unverified` rather than clearing, so the local
    // plane survives a mid-session expiry; transient outcomes leave the bearer
    // for the reactive path. Identical handling to the reactive rotate.
    this.applyLiveRotateOutcome(
      rotated,
      expected.userId,
      expected.generation,
      "proactive",
    );
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
  ): Promise<TokenApplicationOutcome> {
    if (this.disposed) {
      return "superseded";
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

    // After the async validation, the state machine may have moved on: a
    // fresh `signIn()` could have minted a new attempt. In that case this
    // result is stale and must not mutate state.
    if (!this.isAttemptCurrent(expectedOAuthEpoch)) {
      appLogger.debug("[auth] ignored stale OAuth callback after validation", {
        expectedEpoch: expectedOAuthEpoch ?? "cold-start",
      });
      return "superseded";
    }
    if (outcome.kind === "valid") {
      // Interactive sign-in: write the freshly-minted pair + validated identity to
      // the shared credentials file. `signIn` stamps `savedAt` in main and
      // rejects if the write cannot land. This is the file the host's
      // owner gate reads, written BEFORE we flip signed-in (which enables host
      // RPCs) - so on a brand-new sign-in the owner is pinned before the first
      // connection, closing the UNAUTHORIZED race that would burn refresh tokens.
      // (This subsumes the old best-effort `ensureLocalProvisioning`/`cliLogin`
      // seed, which would now be a second, unsynchronized writer to the same file.)
      //
      // The attempt stays ACTIVE through this durable write — it is consumed
      // only after the post-save fence below passes. The fence must cover the
      // write itself, not just the projection: a supersession landing mid-save
      // otherwise leaves this attempt's credentials on disk where a failed
      // successor's next launch would rehydrate them.
      const signInError: unknown = await this.tokenStore
        .signIn({ token, refreshToken }, identityFromUser(outcome.user))
        .then(
          () => null,
          (error: unknown) => error ?? new Error("sign-in save rejected"),
        );
      // Checked before acting on the outcome: a transition (or dispose) that
      // landed during the write owns the state now, so neither the signed-in
      // projection nor the failure projection below may run for this stale
      // finalization — and the durable write this stale finalization just
      // made must not survive it either.
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
        // Without the persisted pair the "signed-in" projection would be a
        // lie the next launch cannot rehydrate and the rotate cannot refresh.
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
      // Terminal success of an interactive device-flow attempt (this method's
      // only caller is `finalizeDeviceResult`). Passive token restores use a
      // different path and deliberately never count as sign-ins.
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
   * Undo for a credential save whose attempt was superseded mid-write: an
   * atomic compare-and-delete at the store's own authority (main's file
   * lock) removes the pair ONLY if the store still holds exactly the token
   * this stale finalization wrote — any other window's `signIn` serializes
   * wholly before or after it, so a successor's pair can never be destroyed
   * by a stale comparison. A failed undo has a real consequence (the stale
   * pair would rehydrate on a later launch if the successor fails), so it
   * surfaces through the shared store-fault seam AND is remembered: the
   * recovery loop completes the delete before adopting anything durable.
   */
  private async undoSupersededCredentialSave(token: string): Promise<void> {
    // Recorded BEFORE the attempt, not on failure: the very write being
    // undone has already fired the store watcher, so a reconcile can start
    // while this delete is still in flight — it must hit the fence during
    // that window too. The fence's own retry is a concurrent idempotent
    // compare-and-delete, so the overlap is harmless. On success only THIS
    // token is removed — never a blanket clear, which would drop the record
    // of a sibling undo that is still failing.
    this.pendingUndoTokens.add(token);
    try {
      await this.tokenStore.deleteIfToken(token);
      this.pendingUndoTokens.delete(token);
    } catch (error) {
      this.markStoreUnavailable("undo-superseded-save", error);
    }
  }

  /**
   * The ONE fence in front of EVERY durable-adoption path — the recovery
   * tick, the watcher reconcile, and any future reader of the store. While a
   * superseded-save undo is pending, either the retry completes it now (the
   * cleaned store may then be trusted) or this pass is refused and the
   * recovery loop is armed to finish the job. A path that reads durable
   * credentials without calling this first re-adopts the exact zombie the
   * attempt fence dropped.
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
   * Drains the pending-undo set token by token. `true` means the store is
   * clean: nothing pending, or every retry just settled (`kept` is settled
   * too — someone else's pair owns the file now and that stale one is
   * gone). `false` means at least one conditional delete is STILL failing
   * and nothing durable may be adopted this pass. Removal is strictly
   * per-token: a settled undo never clears a sibling's record.
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
      // Set BEFORE the first await, like every other terminal outcome below:
      // an overlapping start() invoked after this attempt's signIn() shares
      // its identityGeneration (nothing bumps it again until a fresh sign-in
      // /out), so the generation fence alone cannot stop a straggling
      // rehydration from clobbering the identity applyTokenInternal is about
      // to establish. `authResolvedDuringStart` is the only guard for that.
      if (this.starting) {
        this.authResolvedDuringStart = true;
      }
      // The approval has landed; only token validation/persistence remains.
      // Flip the surface off "Waiting for approval" NOW - validation can take
      // seconds (network retries, credentials-file lock), and through that
      // window the panel would otherwise claim the approval never arrived.
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
   * Link-code sign-in, confirm-gated: CLAIMS the scanned public code — which
   * grants nothing beyond the private polling secret and a spot in front of
   * the desktop's approve/reject prompt — then polls WITH THAT SECRET until
   * the desktop decides. An approved poll lands the minted pair through the
   * SAME validate → persist → signed-in tail as a device-flow authorization
   * (`applyTokenInternal`), so the resulting session is indistinguishable
   * from any other sign-in to the rest of the app.
   *
   * Runs inside the SAME `Attempt` lifecycle as device sign-in: it registers
   * as the active attempt (superseding any in-flight one), every post-await
   * branch is fenced on that attempt identity, and the token tail receives
   * the attempt epoch. A link attempt superseded by a newer sign-in becomes
   * a silent no-op — a late approval can never overwrite the newer session,
   * and a late denial/timeout can never sign it out.
   */
  async signInWithLinkCode(code: string): Promise<LinkLoginSignInResult> {
    if (this.disposed) {
      return { kind: "superseded" };
    }
    this.identityGeneration += 1;
    this.settleSessionRecovery("interactive-attempt");
    this.setLastError(null);
    const attempt = this.beginAttempt();
    // Global signing-in projection, tagged as a LINK attempt: it disables the
    // sibling device sign-in action while this claim runs (defense in depth on
    // top of the fence), and it withholds the device flow's retry escape
    // hatch, which here would supersede a claim the user is at that moment
    // being asked to approve on their desktop.
    useAuthStore.getState().setSigningIn("link");

    const authnBaseUrl = this.runnerHost.authnBaseUrl;
    // Device identity for the approver's prompt, best first: the shell's
    // native self-description ("iPhone 16 Pro") where one exists, else the
    // WebView UA. Carried in the claim BODY because the phone's native HTTP
    // layer rewrites the transport User-Agent to a generic one that names
    // nothing.
    const describer = this.runnerHost.deviceDescriber;
    const described = describer === null ? null : await describer.describe();
    // Fenced BEFORE the claim, not only after it. `describe()` is a native
    // round trip, and a newer sign-in landing during it would otherwise let
    // this dead attempt spend the account's single live unclaimed code: the QR
    // still on the desktop screen dies, and the desktop raises an approval
    // prompt for a claim nobody is waiting on.
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
    return this.pollLinkLoginResult(
      authnBaseUrl,
      claimed.secret,
      claimed.pollIntervalSeconds,
      attempt,
    );
  }

  /**
   * The claim's poll loop, fenced on `attempt`: a superseded attempt returns
   * silently without touching global auth state — the superseding flow owns
   * it now. Terminal outcomes for the CURRENT attempt consume it and project
   * failure exactly like a failed device attempt.
   */
  private async pollLinkLoginResult(
    authnBaseUrl: string,
    secret: string,
    pollIntervalSeconds: number,
    attempt: Attempt,
  ): Promise<LinkLoginSignInResult> {
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
      // Published BEFORE the sleep, off the same `intervalMs` the loop is
      // about to wait out — so a directive-stretched wait is counted down at
      // its real length, never at the interval the claim first advertised.
      const nextPollAtMs = Date.now() + intervalMs;
      this.setLinkLoginProgress({ nextPollAtMs, phase: "waiting" });
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (
        this.isDisposed() ||
        this.activeAttempt !== attempt ||
        attempt.abortController.signal.aborted
      ) {
        return { kind: "superseded" };
      }
      this.setLinkLoginProgress({ nextPollAtMs, phase: "checking" });
      const polled = await linkLoginTokenViaHttp(authnBaseUrl, secret);
      if (this.isDisposed() || this.activeAttempt !== attempt) {
        return { kind: "superseded" };
      }
      switch (polled.kind) {
        case "authorized": {
          this.setLinkLoginProgress({ nextPollAtMs, phase: "finalizing" });
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
          // Snap back to the server-directed floor: a transient slow-down
          // must not leave the cadence ratcheted up for the rest of the
          // wait — approval is imminent in this state by definition.
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
   * The "Link mobile app" panel's view of its current code — whether a phone
   * has claimed it and the claimant metadata for the confirmation prompt.
   * The raw bearer stays inside this auth boundary.
   */
  async fetchLinkLoginStatus(
    code: string,
    signal: AbortSignal,
  ): Promise<LinkLoginStatusFetchResult> {
    // Verdict-gated - see `mintLinkLoginCode`. This is the APPROVAL side of
    // linking another device to the account, so an unconfirmed bearer here does
    // not leak a read: it grants account access.
    const bearer = this.cloudBearer();
    if (bearer === null) {
      return { kind: "unauthorized" };
    }
    return this.runnerHost.linkLoginStatus(bearer, code, signal);
  }

  /** The panel's approve/reject decision on a claimed code. */
  async respondLinkLogin(
    code: string,
    approve: boolean,
  ): Promise<RespondLinkLoginFetchResult> {
    // Verdict-gated - see `mintLinkLoginCode`. Approving a device link on a
    // bearer nothing has confirmed is the sharpest case in this file: a token
    // revoked an hour ago would otherwise be enough to admit a new device.
    const bearer = this.cloudBearer();
    if (bearer === null) {
      return { kind: "unauthorized" };
    }
    return this.runnerHost.respondLinkLogin(bearer, code, approve);
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
    this.setLinkLoginProgress(null);
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
    this.setLinkLoginProgress(null);
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
   *
   * Also the renderer's SERVER-TIME TAP. Every outcome that came back from a
   * real response carries the authn `Date` header, and this is the one funnel
   * all of them pass through - startup rehydration, the reactive 401
   * revalidation, device-flow finalization. The reactive path is the one that
   * matters most: it is exactly the call the stream makes when it believes its
   * bearer expired, so on a machine with a wrong clock the very first cycle of
   * what used to be the terminal loop lands a sample.
   */
  private async validateToken(token: string): Promise<ValidationOutcome> {
    const outcome = await this.runnerHost.validateAuthTokenIdentity(token);
    if (outcome.kind !== "network-error") {
      recordAuthServerTime(outcome.serverTime);
    }
    return outcome;
  }

  /**
   * Projects the validated identity into the request context, store and
   * persistence snapshot. Which context operation that means depends on who
   * is already live:
   *
   *  - SAME user already signed in -> rotate the live credential lease in
   *    place. "Same user => same context object" is a load-bearing invariant:
   *    the remote-session cache keys its auth epoch on the lease SOURCE
   *    object, and stream owners do not rebuild their transports on a
   *    same-user event - so minting a fresh context here would retire the
   *    epoch under every live session while its holders keep using it, then
   *    duplicate the physical connection on the next acquire. The rotate
   *    paths (locked rotate, reconcile, session restore) already hold this
   *    invariant; this branch closes the last two ways around it (the
   *    cross-window snapshot projection and a same-user device-flow
   *    re-sign-in).
   *  - Signed out, or a DIFFERENT user -> mint a fresh context. The
   *    provider's `setSignedIn` aborts any previously-active context, so
   *    host / runtime consumers see a single emit for the new identity.
   */
  private applySignedIn(
    bearerToken: string,
    user: AuthenticatedUser,
    profileOverride: AuthProfile | undefined,
  ): void {
    this.applySessionProjection(bearerToken, user, profileOverride, "commit");
    // Cache the identity for the NEXT launch's provisional apply. Here, and
    // not at each call site, so "a validated identity was projected" and "the
    // snapshot is current" cannot drift apart. Not awaited and unable to
    // fail - the write swallows its own errors by contract, and the cost of
    // losing one is a boot exactly as slow as it was before.
    void writeProvisionalSessionSnapshot(this.runnerHost.secureStorage, user);
  }

  /**
   * The body of {@link applySignedIn}, parameterized on the one thing the
   * provisional boot apply must NOT do.
   *
   * `"defer"` commits identity and leaves `currentSubscription` at `null`. A
   * stored `free` would render the remote-hosts upsell for one round trip to
   * anyone who upgraded since their last session; `null` is the documented
   * not-yet-known state, which `useRemoteHostsPlanRestricted` and
   * `planAllowsRemoteHosts` both already read as not-restricted, and the
   * server enforces the grant authoritatively regardless.
   *
   * Everything else is deliberately shared, the broadcast included: the
   * provisional session is genuinely live in this renderer, and it is the ONE
   * announcement of it. `settleProvisionalSession`'s `valid` branch commits
   * the entitlement alone rather than re-entering here, so no subscriber sees
   * a second transition for an identity that never changed.
   *
   * Broadcasting a deferred-entitlement session is safe by CONSTRUCTION, not
   * by luck: `AuthSessionSnapshot` is `{ status, token, profile,
   * contextMetadata }` and carries no `userSubscription` at all, so there is
   * no way for a not-yet-known plan - or a stale cached one - to cross the
   * window boundary from here. Add a plan to that snapshot and this stops
   * being true.
   */
  private applySessionProjection(
    bearerToken: string,
    user: AuthenticatedUser,
    profileOverride: AuthProfile | undefined,
    entitlement: "commit" | "defer",
  ): void {
    if (this.disposed) {
      return;
    }
    // Read BEFORE anything commits: `false` means this call is a PROMOTION
    // into a verified session (from `unverified`, `signing-in` or
    // `signed-out`), rather than a re-validation of one that already held a
    // verdict. See the announcement at the end of this method.
    const heldVerdict = this.hasVerifiedSession();
    this.settleSessionRecovery("signed-in");
    // A session being established IS the recovery: any prior transient error
    // (store-unavailable, session-expired) is stale the moment a bearer
    // lands - including on the automatic watcher/recovery paths that never
    // pass through the interactive entry's clear.
    this.setLastError(null);
    this.setDeviceProgress(null);
    this.setLinkLoginProgress(null);
    const liveContext = this.contextProvider.current();
    const profile = profileOverride ?? this.profileFromUser(user);
    const contextMetadata = this.contextMetadataFromUser(user);
    // COMMIT BEFORE EMIT — the ordering contract for this whole class of bug.
    //
    // Every provider call below announces this transition SYNCHRONOUSLY, and
    // its listeners fetch: the host runtime answers a context change by
    // refreshing the host directory, which runs all the way down to
    // `fetchRegisteredHosts` and puts a bearer on the wire. So every ambient
    // auth read those listeners can reach must already hold its
    // post-transition value by the time the announcement goes out.
    //
    // These two assignments used to sit at the END of this method. That left
    // `currentBearer` holding the OUTGOING account's token while the incoming
    // account's mandatory refresh was being issued — the refresh whose entire
    // job is to load the new account fetched with the old one's credential,
    // and then committed those rows under the new identity, which by then had
    // caught up enough to pass the commit guard.
    //
    // The rotate branch needs it just as much: `rotateCurrentBearer` notifies
    // its own listeners, and they are entitled to the same guarantee.
    //
    // ONE THING THIS ORDERING DOES NOT BUY, because it reads as though it
    // does: the auth STORE is committed further down, and the listener chain
    // above reaches `cloudBearer()`, which gates on it. So on a transition
    // INTO `signed-in` that refresh is refused rather than sent — see
    // `commitLiveCredential`, which carries the full account, and the
    // `announceSessionVerified()` call at the end of this method, which is
    // what actually loads the directory for those transitions.
    this.commitLiveCredential(bearerToken, profile);
    if (entitlement === "commit") {
      this.commitSubscriptionStatus(user.userSubscription.subscriptionStatus);
    }
    let rotatedInPlace = false;
    if (liveContext !== null && liveContext.identity.userId === user.user.id) {
      try {
        // RESTORE THE VERDICT, the exact inverse of the withdrawal in
        // `projectUnverifiedSession`. A context minted by `setUnverified`
        // carries `cloudAuthorized: false`, and rotating its bearer does not
        // undo that - so without this an `unverified` session that recovers
        // keeps every direct cloud worker fenced off permanently, the fence
        // outliving the condition it was raised for. That half is as real as
        // the over-permissive half and has no other edge to clear it: the
        // recovery path rotates rather than mints precisely so nothing tears
        // down, which also means nothing re-authorizes.
        //
        // Unconditional rather than gated on `heldVerdict`: arriving here means
        // a validated `AuthenticatedUser`, which IS the verdict, so asserting
        // it states ground truth and is idempotent on a context already
        // holding it. Ordered before the rotation announces, per COMMIT BEFORE
        // EMIT above. A rotation that then throws is harmless - the
        // `setSignedIn` fallback aborts this context, and an aborted context
        // fails closed ahead of any verdict read.
        liveContext.setCloudAuthorized(true);
        this.contextProvider.rotateCurrentBearer({
          userId: liveContext.identity.userId,
          bearerToken,
        });
        rotatedInPlace = true;
      } catch {
        // The provider's own contract: rotation refusals (no current context,
        // a released lease, an identity mismatch) are translated by
        // auth-boundary callers into a clean sign-out + re-sign-in
        // transition. Falling through to `setSignedIn` IS that transition -
        // without it, a refused rotation would abort the whole sign-in
        // projection mid-way (device progress already cleared, store never
        // updated).
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
    // A server-confirmed session clears the terminal-rejection latch: whatever
    // authn refused before, it has just accepted something now, so wake
    // recovery is meaningful again.
    //
    // Cleared HERE and not in `commitLiveCredential`, which was the tempting
    // spot because it is the single credential-commit site - but the hold paths
    // commit through it too, so the latch would be erased by the very
    // transition that sets it. The clear belongs where a credential is
    // VALIDATED, not merely where one is stored.
    this.sessionRecoveryTerminallyRejected = false;
    this.emitSessionSnapshot();
    this.refreshScheduler.start();
    // THE POST-STORE VERDICT EDGE, and it is LAST for the same reason
    // `commitLiveCredential` is first: its listeners act by reading whether
    // this session may now spend a cloud capability, and the answer to that is
    // `useAuthStore`'s `status`, committed several lines above. Everything this
    // method writes has been written by the time it goes out.
    //
    // The trap it exists to route around, since the wrong version of it
    // type-checks and runs: driving the same work from `rotateCurrentBearer`'s
    // listeners (`onBearerRotated`) puts it INSIDE the context call above,
    // where `hasVerifiedSession()` still answers `false`. A directory refresh
    // driven from there asks `fetchRegisteredHosts` for a bearer, is refused by
    // `cloudBearer()`, and produces the identical empty directory - with a
    // plausible fix in place and the symptom unchanged.
    //
    // Only on a PROMOTION. A re-validation of a session that was already
    // `signed-in` (the 401 revalidate, the reconcile adopt) moves no ambient
    // answer, so the refresh those paths already drive was never refused, and
    // re-asking would be one more `GET /api/v3/hosts` per rotation for nothing.
    if (!heldVerdict) {
      this.contextProvider.announceSessionVerified();
    }
  }

  /**
   * Aborts the live `RequestContext` (if any) and projects signed-out
   * state. Idempotent - a second call while already signed-out is a
   * no-op for the provider.
   *
   * `cause` is what the projection cannot say on its own and what
   * `useAuthIdentityTransition` needs: every caller but one has retired the
   * identity (the file is gone, or another window says so), and that one -
   * `applyInteractiveFailure` - has not touched the file. A `signed-out` that
   * ends a held attempt is a retirement in the first case and a hold in the
   * second, and the two arrive through the identical `unverified ->
   * signing-in -> signed-out` sequence when an explicit `signOut()`'s delete
   * lands after a sign-in began.
   */
  private applySignedOut(cause: SignedOutCause): void {
    if (this.disposed) {
      return;
    }
    this.setDeviceProgress(null);
    this.setLinkLoginProgress(null);
    this.refreshScheduler.stop();
    // COMMIT BEFORE EMIT (see `applySignedIn`). `signOut()` announces the
    // null context synchronously and the runtime refreshes the directory
    // inside that announcement; a bearer still readable here would be sent on
    // behalf of a signed-out session, and — if the registry happened to
    // accept it — would re-commit the signed-out user's hosts as the
    // signed-out directory.
    this.commitLiveCredential(null, null);
    // The plan belongs to the account that just went away. Cleared alongside
    // the credential (`setSignedOut()` nulls the store's copy too) so no host
    // list can be projected against the departed account's entitlement.
    this.currentSubscription = null;
    this.contextProvider.signOut();
    if (cause === "attempt-failed") {
      useAuthStore.getState().setInteractiveAttemptFailed();
    } else {
      useAuthStore.getState().setSignedOut();
    }
    this.emitSessionSnapshot();
    // The cached identity goes with the session. HERE rather than only in
    // `signOut()`, so the UI-only signed-out projection a dead credential
    // produces cannot leave a snapshot the next launch would paint with. A
    // recovery that gets the same user back re-writes it through
    // `applySignedIn`, so the cost of clearing eagerly is one slow boot.
    void clearProvisionalSessionSnapshot(this.runnerHost.secureStorage);
  }

  /**
   * THE single assignment site for the account's subscription tier: this
   * object's copy and the store projection every entitlement-gated surface
   * renders from, written together so the two can never disagree.
   *
   * Entitlement can change without a bearer rotation (a purchase, a restore, a
   * downgrade), which is why every successful validation calls through here and
   * not only sign-in.
   */
  private commitSubscriptionStatus(status: SubscriptionStatus): void {
    this.currentSubscription = status;
    useAuthStore.getState().setSubscriptionStatus(status);
  }

  /**
   * The signed-in account's subscription tier, or `null` when signed out or
   * not yet known. Synchronous, and readable without React — the host-directory
   * projection reads it once per fetch.
   */
  currentSubscriptionStatus(): SubscriptionStatus | null {
    return this.currentSubscription;
  }

  /**
   * THE single assignment site for the live credential pair.
   *
   * `currentBearer` and `currentProfile` are one fact — a bearer and the
   * account it belongs to — and every consumer that has to tell "the current
   * credential" apart from "the credential this request is for" reads them as
   * a pair (see `fetchRegisteredHosts`). Writing them anywhere else, or in
   * two steps, re-opens the window where the bearer says A and the profile
   * says B.
   *
   * Callers assign through this BEFORE announcing the transition that made it
   * true. That is the ordering contract, and it is restated at each call site
   * because the failure it prevents is invisible from here — nothing about
   * these two lines shows that somebody is about to fetch.
   *
   * The store projection (`useAuthStore`) stays where it is, AFTER the
   * announcement — but not because nothing reads it there. This comment used
   * to claim "no synchronous listener path reads auth state from there", and
   * that claim is FALSE. It is stated as a correction rather than deleted
   * because it is the specific artifact that let a real defect survive review:
   *
   *   `setSignedIn` announces synchronously -> `HostRuntime` ->
   *   `directory.refreshForEra(era)` -> the auth-bound fetcher ->
   *   `fetchRegisteredHosts` -> `cloudBearer()` -> `hasVerifiedSession()`,
   *
   * every step of which runs BEFORE its first `await`. That last call reads
   * `useAuthStore.getState().status`, which is still pre-transition here — so
   * the transition-driven hosts refresh is refused on every sign-in that moves
   * the status INTO `signed-in`, and the directory stays empty until the ~60s
   * registry poll covers for it. (A cross-user A->B switch is unaffected: the
   * status reads `signed-in` on both sides of it, which is why this was only
   * ever visible on a cold start or an `unverified` promotion.)
   *
   * The FIX taken is not this ordering: `applySignedIn` announces the verdict
   * through `announceSessionVerified()` as its last act, after the store
   * commit, and the directory refresh rides that instead. Moving the store
   * projection above the context calls would be the deeper fix and was
   * deliberately not taken — zustand notifies synchronously, so it would let
   * components observe `signed-in` while `HostClient` still holds the outgoing
   * context, which is a worse class of bug than a delayed directory. If anyone
   * takes that on, it wants its own ticket.
   *
   * What IS true of the position: `currentBearer` and `currentProfile` must be
   * committed first regardless, because the fetch layer's era check reads them
   * through `currentAuthEra()` on that same synchronous path — the directory's
   * identity accessor reaches `currentProfile` via `getCurrentSessionSnapshot()`,
   * which is why THAT one is here.
   */
  private commitLiveCredential(
    bearer: string | null,
    profile: AuthProfile | null,
  ): void {
    this.currentBearer = bearer;
    this.currentProfile = profile;
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
    this.setLastError(error);
    this.applyInteractiveFailure(error);
  }

  /**
   * A link-login claim's terminal failure: the same transition as
   * `applyFailure`, minus the durable `lastError`.
   *
   * The result kind is already returned to the caller, and both link surfaces
   * render it precisely ("that code is invalid, expired, or already used").
   * Setting `lastError` too would put the generic "Sign-in failed - please try
   * again" beside it on the same screen, saying something weaker and, for an
   * expired code, actively wrong - trying again with a dead code cannot work.
   * One failure gets one explanation, and the specific one wins.
   */
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
    // Every caller of this method is a terminal failure of an interactive
    // sign-in attempt (launch failure, device denial/expiry, token rejection),
    // so this is the one seam where `sign_in_failed` is emitted.
    Analytics.getInstance().track(AnalyticsEvent.SignInFailed, {
      blocker: SIGN_IN_FAILURE_BLOCKERS[error] ?? "unknown",
    });
    this.applySignedOut("attempt-failed");
    // A failed interactive attempt says nothing about the SHARED file - a
    // recoverable stored session may still be sitting there (the entry to
    // `signIn` settled any loop that was nursing one). Re-arm; the first tick
    // settles itself when the file turns out to be empty.
    this.scheduleSessionRecovery("interactive-failure");
  }

  /**
   * Re-projects a same-user verdict's person-facing identity into the auth
   * store and the service's own live-credential copy - and nothing else.
   *
   * Deliberately not `applySignedIn` / `applySessionProjection`. Those restart
   * the refresh scheduler and - the part that is load-bearing rather than
   * merely wasteful - would put the identity back through the context
   * provider, where "same user => same context object" is an invariant the
   * remote-session cache keys its auth epoch on. A fresh context here retires
   * that epoch under every live session while its holders keep using it. So
   * the profile, the context METADATA (a plain projected value, not the
   * `RequestContext`) and the shareable teams are written to the store, the
   * profile half of the credential pair is committed alongside them, and
   * neither the provider nor the scheduler is touched.
   *
   * GATED on a real difference, which is what keeps the ordinary boot silent:
   * `setSignedIn` fires `Analytics.identify` (`auth-store.ts`), so an
   * unconditional call would emit one identify per launch for an identity that
   * did not change. With the gate it fires only when the account's own details
   * actually moved.
   *
   * The comparison is shallow by construction - `AuthProfile` and
   * `AuthContextMetadata` are flat, and a team is compared on the three fields
   * `projectShareableTeams` emits - so it can be read against those types
   * rather than trusted.
   */
  private reprojectSameUserIdentity(user: AuthenticatedUser): void {
    const profile = this.profileFromUser(user);
    const contextMetadata = this.contextMetadataFromUser(user);
    const shareableTeams = projectShareableTeams(user);
    const current = useAuthStore.getState();
    // Keyed by id, not by INDEX. `projectShareableTeams` preserves the server's
    // order verbatim, so an index-wise compare reads a pure reorder of an
    // identical team set as a change - which writes the store and fires an
    // `Analytics.identify` for nothing. Team ids are unique, so a same-length
    // set whose every id is found with matching fields is the same set.
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
    // The service's OWN copy moves too, through the single commit site and
    // BEFORE the announcement, exactly as every other identity write does.
    // What this method must not disturb is the context provider and the
    // refresh scheduler, and `currentProfile` is neither: it is the other half
    // of the live credential pair, which `commitLiveCredential` exists to keep
    // from splitting. Left
    // behind, it is not merely stale but SELF-PERPETUATING, because the
    // rotation path re-commits `this.currentProfile` verbatim on every
    // refresh; a renamed account would keep serving its old name to
    // `getCurrentSessionSnapshot` until the process restarted.
    //
    // The bearer is passed through unchanged: this path re-projects an
    // identity, it does not mint a token, and the pair must be written
    // together rather than one field at a time.
    this.commitLiveCredential(this.currentBearer, profile);
    useAuthStore
      .getState()
      .setSignedIn(profile, contextMetadata, shareableTeams);
    // The windows bridge holds a PUSHED copy of the same snapshot, so fixing
    // only the pull-side read would leave every other window on the old
    // identity. Reached only past the gate above, so an unchanged identity
    // still emits nothing.
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

  /**
   * Project a stored session we could NOT get a verdict for into the
   * `unverified` state, so the renderer admits the local, disk-served plane.
   *
   * This is the whole point of the state: the host already serves local-homed
   * epics with zero `/api/v3/user` calls, but the renderer used to park the
   * user on `AuthLandingPage` until a validation SUCCEEDED - so data sitting
   * on their own disk was unreachable whenever authn was.
   *
   * What it deliberately does NOT do:
   *  - It does not settle the recovery loop. This is a holding state, not a
   *    resolution; the caller arms recovery and a later success upgrades it
   *    through the ordinary `applySignedIn`.
   *  - It does not start the refresh scheduler. Scheduling refreshes against
   *    an unreachable authn is exactly the spend this path exists to avoid.
   *  - It does not project entitlement or teams (`setUnverifiedSession`
   *    clears both), because those are server claims and we hold none.
   *
   * Returns whether the projection was made, so callers can log the branch
   * they actually took.
   */
  private applyUnverifiedSession(session: {
    readonly token: string;
    readonly user: StoredCredentials["user"];
  }): boolean {
    // Never downgrade a live session. A network blip while signed in leaves
    // the signed-in projection alone (`applyReconciledOutcome` documents the
    // same rule); this state is for sessions that have no verdict at all.
    //
    // A DELIBERATE demotion is a different act and has its own entry point -
    // see {@link demoteVerifiedSessionToUnverified}. Keeping them apart matters:
    // this guard protects the far more common "we just could not reach authn"
    // caller, and loosening it to serve the rare terminal one would silently
    // let a blip tear down a signed-in session.
    if (this.hasVerifiedSession()) {
      return false;
    }
    return this.projectUnverifiedSession(session);
  }

  /**
   * Demote a session that IS currently verified down to `unverified`, keeping
   * the local plane alive.
   *
   * The one caller is a terminal, server-issued CREDENTIAL verdict on the live
   * rotation path (`applyLiveRotateOutcome`'s `refresh-rejected-credential`):
   * authn has said this refresh token is dead, which is a fact about the token
   * and not about the person or their disk. Before this existed that arm called
   * `clearUiSession()`, producing a real `signed-out` - which redirected the
   * shell out from under someone editing local work AND made
   * `useAuthIdentityTransition` run its destructive arm, purging account-scoped
   * persisted state (reading positions are deleted from disk outright). That
   * was cold-review P1-4.
   *
   * Deliberately bypasses {@link applyUnverifiedSession}'s live-session guard
   * rather than weakening it, because the two callers mean opposite things by
   * the same state: "we hold no verdict yet" versus "the verdict we held has
   * been revoked". Only the second may demote, and naming it here is what stops
   * a future edit from relaxing the guard for everyone to reach this case.
   *
   * The bearer stays the one in hand: its access token is still valid for its
   * own TTL (the rejection was of the REFRESH token), and it is the credential
   * the host is already serving this machine's local epics on. Nulling it is not
   * an option in the way it looks: `extractBearerForOpenFrame` THROWS on a null
   * or empty bearer, so a bearerless `unverified` session cannot open the host
   * WebSocket at all and the local plane never connects. The retained bearer is
   * what the plane runs on, not a leftover of the dead one.
   *
   * KNOWN GAP, recorded rather than papered over. The two paths that reach this
   * arm leave the retained bearer in different conditions and nothing here
   * distinguishes them:
   *
   *  - REACTIVE (`revalidateCurrentContextOnce`): `/api/v3/user` rejected this
   *    access token BEFORE the rotate, so it is known-dead.
   *  - PROACTIVE (the refresh scheduler): the access token was never rejected;
   *    only its refresh token was, so it stays usable until its own TTL.
   *
   * Both are held identically, which means the reactive case retains a secret a
   * server has already refused. The fix is NOT `null` (see above) but a
   * present-but-unconfirmed representation that readers can tell apart from a
   * live bearer - today `currentBearer` has no such third state, and every
   * cloud caller gates on `=== null`. Out of scope here; it wants its own
   * ticket rather than an inline invention.
   */
  /**
   * Demote the LIVE session on a terminal server verdict, taking the identity
   * from the live profile rather than the credentials file.
   *
   * Shared by every live-path intake that can land on a terminal verdict, which
   * is the point: three of them existed and only one held the plane. Each was a
   * separate reviewer finding, and they were the same defect — an intake path
   * that reaches a rejection and leaves the store `signed-in` on a credential
   * the server has refused. Adding a fourth caller should mean calling this,
   * not re-deriving it.
   *
   * `bearerToDemoteOnto` is the credential the plane keeps running on. It is a
   * parameter rather than a re-read of `currentBearer` because the post-rotate
   * caller holds a token NEWER than the field at the moment it decides — the
   * rotate committed it, and it is the one the host is now serving on.
   *
   * Returns whether a demotion happened. `false` means there was no live
   * identity to hold a plane for, and the caller owns what to do instead —
   * this never invents a session out of a missing profile.
   */
  private demoteLiveSessionOnTerminalVerdict(
    bearerToDemoteOnto: string | null,
  ): boolean {
    const profile = this.currentProfile;
    if (profile === null || bearerToDemoteOnto === null) {
      return false;
    }
    this.demoteVerifiedSessionToUnverified({
      token: bearerToDemoteOnto,
      user: {
        id: profile.userId,
        email: profile.email,
        name: profile.userName,
      },
    });
    return true;
  }

  private demoteVerifiedSessionToUnverified(session: {
    readonly token: string;
    readonly user: StoredCredentials["user"];
  }): boolean {
    // THE TERMINAL LATCH, set here because this is the terminal arm: every
    // live-path intake that reaches a refresh-rejected / account-rejected
    // verdict demotes through this method. The stored-session paths set the
    // latch beside their own `applyUnverifiedSession`; without it here, the
    // next `online` or resume event passed `nudgeSessionRecoveryOnWake`'s
    // guard and re-spent the credential authn had just refused - and, with
    // the access token still inside its TTL after a PROACTIVE rejection,
    // that recovery could promote the session back to `signed-in` and restart
    // the scheduler, undoing the server's verdict on a network event. Any
    // recovery loop already running is stood down for the same reason.
    // `applySignedIn` clears the latch when authn accepts something again.
    this.sessionRecoveryTerminallyRejected = true;
    this.settleSessionRecovery("terminal-verdict");
    // Read BEFORE the projection commits: this is the only moment the two
    // states are distinguishable, and only a session that HELD a verdict is
    // losing one.
    const heldVerdict = this.hasVerifiedSession();
    const projected = this.projectUnverifiedSession(session);
    if (!projected || !heldVerdict) {
      return projected;
    }
    // THE VERDICT-LOSS EDGE, and it has to be an explicit act because every
    // mechanism that would otherwise have caught it is deliberately inert here.
    //
    // The demotion retains the live context (that is the point - the local
    // plane runs on it), so `onChange` never fires, so the host runtime's
    // `auth-changed` sweep never runs. The remote session cache keys its
    // `authEpoch` on the bearer SOURCE OBJECT, which an in-place rotation does
    // not change, so every established remote session stays a cache HIT and
    // keeps dispatching. And `cloudAuthorized` gates the attach-grant MINT,
    // which an already-attached session does not perform again for the life of
    // the relay's client-leg deadline.
    //
    // So an account that has just been refused - including a deliberate "sign
    // out of all devices" - would keep being served on the connections it
    // already had. Closing them is the enforcement.
    //
    // `retireAllRemoteSessions` force-closes entries a consumer still HOLDS,
    // which is the property this call site needs and the one it did not have
    // until this ticket: an open tab is exactly such a holder. Local-host
    // sessions are untouched by construction - that cache holds remote
    // sessions only, so the plane `unverified` exists to protect is out of its
    // reach.
    appLogger.info(
      "[auth] closing remote sessions on cloud authorization loss",
      { userId: session.user.id },
    );
    retireAllRemoteSessions();
    // The copies of this session held OUTSIDE the renderer - the desktop main
    // process above all, whose jar plane keeps speaking for the account on
    // the bearer it verified until told otherwise. See
    // `onCloudAuthorizationRevoked`.
    for (const listener of Array.from(
      this.cloudAuthorizationRevokedListeners,
    )) {
      try {
        listener({ token: session.token });
      } catch (error) {
        appLogger.warn("[auth] a cloud-authorization-revoked listener failed", {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return projected;
  }

  private projectUnverifiedSession(session: {
    readonly token: string;
    readonly user: StoredCredentials["user"];
  }): boolean {
    if (this.disposed) {
      return false;
    }
    // Idempotence, and it is load-bearing rather than an optimization: the
    // recovery loop calls through here on EVERY failed tick, and re-minting
    // would abort the live context each time - tearing down exactly the
    // in-progress local work this state exists to protect, once per backoff
    // step.
    if (
      this.currentBearer === session.token &&
      useAuthStore.getState().status === "unverified"
    ) {
      return false;
    }
    const profile: AuthProfile = {
      userId: session.user.id,
      userName: session.user.name,
      email: session.user.email,
      // The credentials file carries no avatar. The header falls back to
      // initials, which `computeInitials` derives from the name we do have.
      avatarUrl: null,
    };
    const identity = {
      userId: session.user.id,
      username:
        session.user.name.length > 0 ? session.user.name : session.user.email,
      // The file carries no provider handle either, and `null` is what
      // `identityFromAuthenticatedUser` projects for a user without one.
      providerHandle: null,
    };
    // STOP THE PROACTIVE SCHEDULER before committing anything.
    //
    // Every caller that arrives here from `signed-out` or startup finds it
    // already stopped and this is a no-op. The caller that does NOT is the
    // demotion (`demoteVerifiedSessionToUnverified`): `applySignedIn` started
    // the scheduler, and nothing on the way here stops it. Left running it
    // re-reads `getToken: () => this.currentBearer` on a timer and spends
    // refreshes against a refresh token authn has already rejected - which is
    // the exact spend `unverified` exists to prevent, arriving through the one
    // path that reaches this state from a live session.
    //
    // It is stopped here rather than in the demotion arm so the invariant is
    // "no unverified session carries a running refresh scheduler", which holds
    // for a caller added later without that caller having to know it.
    this.refreshScheduler.stop();
    // COMMIT BEFORE EMIT, for the same reason `applySignedIn` documents at
    // length: the context transition below announces synchronously and its
    // listeners fetch, so every ambient auth read they can reach must already
    // hold its post-transition value.
    this.commitLiveCredential(session.token, profile);
    // RETAIN THE LIVE CONTEXT WHEN THERE IS ONE FOR THIS SAME IDENTITY.
    //
    // `setUnverified` mints a FRESH context and aborts the previous one as
    // `auth-resigned-in`. Downstream, `HostClient` reads that abort as an
    // identity change: it invalidates every host scope, cancels in-flight
    // requests and resets the messenger. On a cold start that costs nothing -
    // there is no context yet. On a DEMOTION it tears down the host runtime
    // serving the very local work this state exists to protect, which is the
    // ticket's own line - "refresh-token rejection must not abort in-progress
    // local access" - broken by the mechanism meant to honour it.
    //
    // A same-user demotion is a credential change, not an identity change, so
    // it takes the same in-place rotation an ordinary refresh does: the context
    // object and its lease survive, subscribers see no emission, and host
    // scopes stay warm. Only the verdict, the store and the scheduler move.
    //
    // The `setUnverified` branch remains for the case it was written for: no
    // live context, or one belonging to a different identity, where there is
    // nothing to retain and minting is the only option.
    const live = this.contextProvider.current();
    const canRetainLiveContext =
      live !== null &&
      live.identity.userId === identity.userId &&
      !live.credentials.isReleased;
    if (canRetainLiveContext) {
      // WITHDRAW THE VERDICT. This is the half of `setUnverified` that
      // retention cannot inherit by rotating, and the line above - "only the
      // verdict, the store and the scheduler move" - described an intent the
      // code did not carry out: the verdict was the one thing that did not
      // move. The mint branch below asserts `cloudAuthorized: false` at
      // construction; an in-place rotation moves the bearer alone, so the
      // retained context kept the `true` it was signed in with and
      // `buildBearerHeadersFromContext` kept minting headers from it - for
      // precisely the background timers, mount effects and detached promises
      // no surface gate reaches, which is why the verdict lives on the context
      // at all.
      //
      // Ordered before `rotateCurrentBearer` on this file's COMMIT BEFORE EMIT
      // rule: that call notifies its listeners synchronously and they are
      // entitled to read the post-transition verdict.
      live.setCloudAuthorized(false);
      this.contextProvider.rotateCurrentBearer({
        userId: identity.userId,
        bearerToken: session.token,
      });
    } else {
      this.contextProvider.setUnverified({
        identity,
        bearerToken: session.token,
      });
    }
    useAuthStore.getState().setUnverifiedSession(profile, {
      userId: identity.userId,
      username: identity.username,
    });
    this.emitSessionSnapshot();
    appLogger.info("[auth] local plane admitted on an unverified session", {
      userId: session.user.id,
    });
    return true;
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
   * Subscribes to link-login poll progress (when the next `/link/token` poll
   * fires, and whether one is outstanding). Fires synchronously on subscribe
   * with the current value, then on every change. `null` whenever no link
   * poll is running.
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

  private setLinkLoginProgress(next: LinkLoginProgress | null): void {
    const current = this.linkLoginProgress;
    if (
      current === next ||
      (current !== null &&
        next !== null &&
        current.nextPollAtMs === next.nextPollAtMs &&
        current.phase === next.phase)
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
 * Maps a terminal (non-`authorized`) device-flow result to the stable error id
 * the device surface renders. `error` (invalid grant / exhausted retries) reuses
 * the generic sign-in-failed copy.
 */
/**
 * The credentials pair a `rotate` outcome hands back to adopt: present for
 * `applied`/`superseded`/`commit-failed`, `null` for the terminal/transient
 * outcomes that carry no pair (`deleted`/`user-mismatch`/`tombstoned`/
 * `lock-busy`/`refresh-rejected-credential`/`refresh-rejected-account`/
 * `refresh-network`).
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
 * validated `AuthenticatedUser`. The store stamps `savedAt`; only the user
 * identity crosses the `signIn` seam.
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

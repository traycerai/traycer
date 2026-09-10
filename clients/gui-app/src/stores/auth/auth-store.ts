import { create } from "zustand";
import type { SubscriptionStatus } from "@traycer/protocol/auth/user";
import { Analytics } from "@/lib/analytics";

/**
 * Authoritative client-side auth state.
 *
 * The store keeps status as plain string literals so `gui-app` does not pull
 * in the AuthnV3 user type graph just for four status tokens.
 *
 * `unverified` is the state this union used to be missing, and its absence was
 * a product defect: `signed-out` was doing double duty for "we know there is no
 * session" and "we could not reach authn to find out". Those are different
 * facts with different correct renderings - the first belongs on
 * `AuthLandingPage`, the second belongs in the app, reading the epics already
 * sitting on this machine's disk.
 *
 * `unverified` means: a stored session identity IS present on this device, but
 * no successful `/api/v3/user` verdict is currently held for it. It is
 * deliberately a fourth member of THIS union rather than an orthogonal
 * "offline" flag beside it: the session is in exactly one of these states, and
 * a boolean alongside `status` could contradict it - which is the very
 * conflation this member exists to remove.
 *
 * IT IS NOT ONLY THE OFFLINE STATE, and the next reader will be tempted to
 * narrow it back to one. THREE causes reach it, and the line that matters is
 * not "hold or clear" - it is whether an identity is still ON DISK:
 *
 *  - authn UNREACHABLE - no verdict at all. -> `unverified`.
 *  - `refresh-rejected-credential` (authn answered 400/401) - a statement about
 *    a TOKEN. The person at the keyboard is still whoever the stored identity
 *    says they are. -> `unverified`.
 *  - `refresh-rejected-account` (authn answered 403/404) - a statement about
 *    the ACCOUNT. Also -> `unverified`, and the reason is worth reading before
 *    anyone "corrects" it: gating the renderer here is UNENFORCEABLE. The host
 *    serves local-homed epics with zero `/api/v3/user` calls and the CLI reads
 *    the same files, so refusing to render them deletes nothing and
 *    inconveniences only the legitimate owner. What the account verdict DOES
 *    change is the copy - `AUTH_ERROR_ACCOUNT_UNAVAILABLE`, terminal, must not
 *    invite a retry - and that wake recovery stops re-spending a refresh token
 *    the server has refused.
 *
 * What clears to `signed-out` is `deleted` / `tombstoned` / `user-mismatch`:
 * LOCAL credentials-file states, where the identity the plane was held FOR is
 * genuinely gone. No amount of server-side termination produces them.
 *
 * WHERE ACCOUNT TERMINATION ACTUALLY ARRIVES, because two earlier versions of
 * this comment got it wrong in opposite directions:
 *
 *  - A DELETED account -> `UserNotFoundError`, a 404 ->
 *    `refresh-rejected-account` -> HOLDS, with terminal copy.
 *  - A REVOKED account ("sign out everywhere", the per-user epoch gate) ->
 *    a 401 stamped `revocation_scope: user_epoch` -> credential-scoped ->
 *    HOLDS, with expiry copy.
 *
 * So the split does not decide who keeps their local epics - everyone with an
 * identity on disk does. It decides what they are TOLD and what the recovery
 * loop is allowed to spend.
 *
 * This ruling DEPENDS on the user being told. Holding the app open means
 * there is no `AuthLandingPage` left to carry the "session expired" message,
 * so `AuthSessionExpiredToastBridge` must admit `unverified` too - without it
 * the expiry is announced nowhere and the user silently stops syncing. Do not
 * narrow that bridge back to `signed-out` without revisiting this line.
 *
 * The load-bearing consequence: every `status === "signed-in"` test in the app
 * stays FALSE under `unverified`, so cloud-dependent surfaces remain gated by
 * construction and entitlement policy is untouched. Only the surfaces that
 * opt in through {@link admitsLocalPlane} admit it.
 */
export type AuthStatus =
  | "signed-out"
  | "signing-in"
  | "signed-in"
  | "unverified";

/**
 * Whether this session may render the LOCAL, disk-served plane - the epics the
 * host already serves without any network call.
 *
 * This is the renderer's admission predicate, and it is deliberately a named
 * function rather than an inlined `!== "signed-out"`: admission is a product
 * decision that several route bodies and the root layout must make
 * identically, and the next state added to `AuthStatus` must be classified
 * here, once, rather than in each of them.
 *
 * It is NOT an authorization predicate. Anything that reaches the cloud keeps
 * testing `status === "signed-in"`, because only that state carries a verdict
 * the server actually issued.
 *
 * Both admitted states guarantee non-null `profile` / `contextMetadata` (see
 * {@link AuthState}), so admitted surfaces may read an identity unconditionally.
 */
export function admitsLocalPlane(status: AuthStatus): boolean {
  return status === "signed-in" || status === "unverified";
}

/**
 * Whether this session may spend a CLOUD CAPABILITY - ask the account's servers
 * to issue something, or act on the account.
 *
 * The exact complement of {@link admitsLocalPlane} in intent, and deliberately
 * NOT its negation in code: both are positive statements about what a status
 * permits, so a fifth `AuthStatus` member has to be classified in each rather
 * than falling into one by default.
 *
 * This exists because the boundary needed a name somewhere below the UI. Most
 * cloud gating is a `status === "signed-in"` test inside a component, which is
 * fine there - the component is the surface being gated. But the attach-grant
 * mint in `createRemoteHostTransport` is a capability spend with no component
 * anywhere near it, and an inlined comparison in transport wiring reads as an
 * arbitrary state check rather than as the product rule it is.
 *
 * `AuthService.cloudBearer()` is the same rule applied to that class's own
 * egress; it is expressed there as `hasVerifiedSession()` (this predicate AND a
 * non-null bearer) because a method that returns a token has to answer for the
 * token as well as the permission.
 */
export function authorizesCloudCapability(status: AuthStatus): boolean {
  return status === "signed-in";
}

/** Which sign-in flow started the attempt currently projected as running. */
export type SignInAttemptKind = "device" | "link";

/**
 * WHY the current `signed-out` was projected - the one fact the status alone
 * cannot carry and that the identity-transition hook needs.
 *
 * - `retired` - the identity the local plane was held for is gone: an
 *   explicit `signOut()` after the credentials file was deleted, a file found
 *   deleted / tombstoned / owned by another user, or another window's
 *   sign-out projected into this one. Account-scoped state is purged.
 * - `attempt-failed` - an interactive sign-in attempt failed. `applyFailure`
 *   never touches the shared credentials file, so a stored identity may still
 *   be on disk and recovery may re-admit it; a `signed-out` reached this way
 *   from a held attempt is NOT a retirement, and the lifecycle bridges keep the
 *   pre-attempt account's state bound across it.
 *
 * Two reducers rather than one parameterised `setSignedOut`: every retirement
 * site in the service and every test that signs out already calls the bare
 * form, and the failure path is the single caller that means something else.
 */
export type SignedOutCause = "retired" | "attempt-failed";

/**
 * Subset of the AuthnV3 `/api/v3/user` response that the GUI surfaces in the
 * UserMenu. Identity fields are present because `AuthService.validateToken`
 * treats a 2xx response without a usable identity as a rejection - the menu
 * therefore never has to fall back to the raw bearer token as an email.
 * `avatarUrl` is absent or null when the user has no avatar; the menu then
 * falls back to initials.
 */
export interface AuthProfile {
  readonly userId: string;
  readonly userName: string;
  readonly email: string;
  readonly avatarUrl?: string | null;
}

/**
 * Identity metadata projected from the live `RequestContext` so UI code can
 * key on the authenticated user without ever reading the bearer string.
 *
 * `userId` mirrors `ctx.identity.userId` and is the cache-key authority for
 * host-scoped TanStack queries; `username` mirrors `ctx.identity.username`
 * (resolved through `usernameFromAuthenticatedUser`) and is shown in headers
 * / chat presence widgets where the narrow profile email is not a fit.
 */
export interface AuthContextMetadata {
  readonly userId: string;
  readonly username: string;
}

/**
 * Team the signed-in user can share epics with, projected from their
 * `teamSubscriptions` at sign-in. Kept here (rather than read from the live
 * `RequestContext`) because the identity snapshot no longer embeds the full
 * `AuthenticatedUser`; this is the narrow UI projection the sharing panel
 * needs (slug + avatar), in the same spirit as `AuthProfile`.
 */
export interface EpicShareableTeam {
  readonly teamId: string;
  readonly slug: string;
  readonly avatarUrl: string | null;
}

/**
 * Invariant: when `admitsLocalPlane(status)` - that is, `signed-in` OR
 * `unverified` - `profile` and `contextMetadata` are both non-null. The
 * `setSignedIn` / `setUnverifiedSession` reducers enforce this at the type
 * level by requiring both values. They stay nullable on the state shape
 * because `signed-out` and `signing-in` still need to represent the absence
 * of a resolved identity.
 *
 * Under `unverified` that identity is read from the on-disk credentials file
 * rather than from a `/api/v3/user` response, so it is exactly as trustworthy
 * as the disk it came from - which is precisely the trust level the local
 * plane needs, and no more. `subscriptionStatus` deliberately stays `null`
 * there: entitlement is a server verdict and we hold none.
 *
 * The Zustand store deliberately holds NO raw bearer token. The runtime auth
 * authority for host / shared-core / runtime consumers is the
 * `RequestContext` exposed through `AuthService.getRequestContextProvider()`.
 * Persistence-boundary callers that genuinely need the bearer (the desktop
 * windows bridge cross-window projection, the persisted token store) read it
 * through the explicit `AuthService.getCurrentSessionSnapshot()` /
 * `AuthService.onSessionSnapshotChange(...)` boundary - never through
 * `useAuthStore`. Static guard tests below enforce this constraint.
 */
export interface AuthState {
  readonly status: AuthStatus;
  readonly profile: AuthProfile | null;
  readonly contextMetadata: AuthContextMetadata | null;
  readonly shareableTeams: ReadonlyArray<EpicShareableTeam>;
  /**
   * Mirrors `userSubscription.subscriptionStatus` from the signed-in user.
   * `null` while signed-out or signing-in. AuthService projects it after each
   * successful validation so entitlement-gated surfaces react to restores.
   */
  readonly subscriptionStatus: SubscriptionStatus | null;
  /**
   * Which flow owns the in-flight attempt, or `null` when none is running.
   *
   * `status === "signing-in"` alone cannot answer that, and surfaces do need
   * to know: the device flow's "Taking too long? Retry" is a correct escape
   * hatch from a stalled browser round trip and a destructive one during a
   * link claim, where `signIn()` would supersede a claim the user is being
   * asked to approve on their desktop right now.
   */
  readonly signingInAttempt: SignInAttemptKind | null;
  /**
   * Set while `status === "signed-out"`, `null` under every other status. See
   * {@link SignedOutCause}; `useAuthIdentityTransition` reads it to decide
   * whether a `signed-out` that ends a held attempt retires the identity.
   */
  readonly signedOutCause: SignedOutCause | null;
  setSigningIn(attempt: SignInAttemptKind): void;
  setSignedIn(
    profile: AuthProfile,
    contextMetadata: AuthContextMetadata,
    shareableTeams: ReadonlyArray<EpicShareableTeam>,
  ): void;
  setSubscriptionStatus(status: SubscriptionStatus | null): void;
  /**
   * Project a stored-but-unvalidated session (see {@link AuthStatus}).
   *
   * Takes the same identity pair as `setSignedIn` because the local plane
   * needs exactly the same identity to render - a user id to scope
   * host-scoped caches by, and a profile to put in the header. What it does
   * NOT take is a subscription status: no server verdict is held, so the
   * entitlement projection is cleared rather than guessed.
   */
  setUnverifiedSession(
    profile: AuthProfile,
    contextMetadata: AuthContextMetadata,
  ): void;
  /** Project `signed-out` with cause `retired` - the identity is gone. */
  setSignedOut(): void;
  /**
   * Project `signed-out` with cause `attempt-failed`: the same projection as
   * {@link setSignedOut} for every surface that renders status, but the
   * credentials file was not touched, so a held attempt's bridges do not
   * treat it as a retirement. `AuthService.applyInteractiveFailure` is its
   * only caller.
   */
  setInteractiveAttemptFailed(): void;
}

function signedOutState(
  cause: SignedOutCause,
): Pick<
  AuthState,
  | "status"
  | "signingInAttempt"
  | "signedOutCause"
  | "profile"
  | "contextMetadata"
  | "shareableTeams"
  | "subscriptionStatus"
> {
  return {
    status: "signed-out",
    signingInAttempt: null,
    signedOutCause: cause,
    profile: null,
    contextMetadata: null,
    shareableTeams: [],
    subscriptionStatus: null,
  };
}

/**
 * Coalesce a profile's display name to a guaranteed string. `userName` and
 * `email` are typed `string` on `AuthProfile`, but a persisted or
 * cross-window-projected snapshot can violate that at runtime; declaring the
 * params nullable makes the fallback a genuine guard (and preserves an
 * explicitly empty `userName` rather than overwriting it with the email).
 */
function coalesceUserName(
  userName: string | undefined,
  email: string | undefined,
): string {
  return userName ?? email ?? "";
}

export const useAuthStore = create<AuthState>()((set) => ({
  status: "signed-out",
  signingInAttempt: null,
  // The initial `signed-out` is the absence of any identity, which is a
  // retirement as far as a bridge is concerned: there is nothing to hold.
  signedOutCause: "retired",
  profile: null,
  contextMetadata: null,
  shareableTeams: [],
  subscriptionStatus: null,
  setSigningIn: (attempt: SignInAttemptKind) => {
    set({
      status: "signing-in",
      signingInAttempt: attempt,
      signedOutCause: null,
    });
  },
  setSignedIn: (
    profile: AuthProfile,
    contextMetadata: AuthContextMetadata,
    shareableTeams: ReadonlyArray<EpicShareableTeam>,
  ) => {
    // Store chokepoint: every signed-in profile lands here, including the
    // projected/persisted-snapshot override paths (AuthService.ingestProjected
    // SessionSnapshot / applyExternalSession) that bypass `profileFromUser`.
    // `AuthProfile.userName` is typed `string`, but a stale or partial snapshot
    // can deliver it absent at runtime - the type is a serialization-boundary
    // guarantee the wire can violate. Coerce here so it is never absent
    // downstream; otherwise startup consumers throw on it:
    // `readFirstName(userName).replace(...)` in HomeHero and
    // `computeInitials(userName).trim()` in the header avatar.
    const safeProfile = {
      ...profile,
      userName: coalesceUserName(profile.userName, profile.email),
    };
    set({
      status: "signed-in",
      signingInAttempt: null,
      signedOutCause: null,
      profile: safeProfile,
      contextMetadata,
      shareableTeams,
    });
    // Email is the one person property sent (deliberate product decision so
    // PostHog dashboards can look users up); the final sanitizer drops
    // everything else the SDK stages on $identify.
    Analytics.getInstance().identify(contextMetadata.userId, safeProfile.email);
  },
  setSubscriptionStatus: (status: SubscriptionStatus | null) => {
    set({ subscriptionStatus: status });
  },
  setUnverifiedSession: (
    profile: AuthProfile,
    contextMetadata: AuthContextMetadata,
  ) => {
    // Same runtime coercion as `setSignedIn`, and for a sharper reason: this
    // profile comes off the credentials FILE, which a stale writer can leave
    // partial. `readFirstName(userName)` in HomeHero throws on an absent one,
    // and HomeHero is on the very surface this state exists to render.
    set({
      status: "unverified",
      signingInAttempt: null,
      signedOutCause: null,
      profile: {
        ...profile,
        userName: coalesceUserName(profile.userName, profile.email),
      },
      contextMetadata,
      // No server verdict is held, so no team list and no entitlement can be
      // projected. Sharing surfaces read `shareableTeams` and gate themselves
      // on emptiness; entitlement-gated surfaces read `subscriptionStatus`
      // and gate themselves on null. Both therefore fail CLOSED here without
      // needing to know this state exists.
      shareableTeams: [],
      subscriptionStatus: null,
    });
    // Deliberately no `Analytics.identify`: identification is a claim about a
    // verified account, and this identity was read off local disk. The
    // `applySignedIn` that follows a successful revalidation makes it.
  },
  setSignedOut: () => {
    set(signedOutState("retired"));
    Analytics.getInstance().reset();
  },
  setInteractiveAttemptFailed: () => {
    set(signedOutState("attempt-failed"));
    // The analytics identity is reset exactly as for a retirement: the failed
    // attempt held no verified account, and whatever `unverified` identity
    // recovery re-admits was never `identify`-ed (see `setUnverifiedSession`).
    Analytics.getInstance().reset();
  },
}));

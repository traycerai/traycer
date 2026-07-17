import { create } from "zustand";
import type { SubscriptionStatus } from "@traycer/protocol/auth/user";
import { Analytics } from "@/lib/analytics";

/**
 * Authoritative client-side auth state.
 *
 * The store keeps status as plain string literals so `gui-app` does not pull
 * in the AuthnV3 user type graph just for three status tokens.
 */
export type AuthStatus = "signed-out" | "signing-in" | "signed-in";

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
 * Invariant: when `status === "signed-in"`, `profile` and `contextMetadata`
 * are both non-null. The `setSignedIn` reducer enforces this at the type
 * level by requiring both values. They stay nullable on the state shape
 * because `signed-out` and `signing-in` still need to represent the absence
 * of a resolved identity.
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
   * `null` while signed-out or signing-in. Surfaced for subscription display;
   * refreshes only on full re-sign-in / revalidation, not reactively.
   */
  readonly subscriptionStatus: SubscriptionStatus | null;
  setSigningIn(): void;
  setSignedIn(
    profile: AuthProfile,
    contextMetadata: AuthContextMetadata,
    shareableTeams: ReadonlyArray<EpicShareableTeam>,
  ): void;
  setSubscriptionStatus(status: SubscriptionStatus | null): void;
  setSignedOut(): void;
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
  profile: null,
  contextMetadata: null,
  shareableTeams: [],
  subscriptionStatus: null,
  setSigningIn: () => {
    set({ status: "signing-in" });
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
  setSignedOut: () => {
    set({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
      shareableTeams: [],
      subscriptionStatus: null,
    });
    Analytics.getInstance().reset();
  },
}));

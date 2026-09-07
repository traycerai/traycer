import { create } from "zustand";
import type { SubscriptionStatus } from "@traycer/protocol/auth/user";
import { Analytics } from "@/lib/analytics";

/**
 * Authoritative client-side auth state. The store keeps status as plain string literals so
 * `gui-app` does not pull in the AuthnV3 user type graph just for three status tokens.
 */
export type AuthStatus = "signed-out" | "signing-in" | "signed-in";

/** Which sign-in flow started the attempt currently projected as running. */
export type SignInAttemptKind = "device" | "link";

/** Subset of the AuthnV3 `/api/v3/user` response that the GUI surfaces in the UserMenu. */
export interface AuthProfile {
  readonly userId: string;
  readonly userName: string;
  readonly email: string;
  readonly avatarUrl?: string | null;
}

/**
 * Identity metadata projected from the live `RequestContext` so UI code can key on the
 * authenticated user without ever reading the bearer string.
 */
export interface AuthContextMetadata {
  readonly userId: string;
  readonly username: string;
}

/**
 * Team the signed-in user can share epics with, projected from their `teamSubscriptions` at
 * sign-in.
 */
export interface EpicShareableTeam {
  readonly teamId: string;
  readonly slug: string;
  readonly avatarUrl: string | null;
}

/**
 * Invariant: when `status === "signed-in"`, `profile` and `contextMetadata` are both non-null. The
 * `setSignedIn` reducer enforces this at the type level by requiring both values.
 */
export interface AuthState {
  readonly status: AuthStatus;
  readonly profile: AuthProfile | null;
  readonly contextMetadata: AuthContextMetadata | null;
  readonly shareableTeams: ReadonlyArray<EpicShareableTeam>;
  /**
   * Mirrors `userSubscription.subscriptionStatus` from the signed-in user. `null` while signed-out
   * or signing-in.
   */
  readonly subscriptionStatus: SubscriptionStatus | null;
  /**
   * Which flow owns the in-flight attempt, or `null` when none is running. `status === "signing-in"`
   * alone cannot answer that, and surfaces do need to know: the device flow's "Taking too long?
   */
  readonly signingInAttempt: SignInAttemptKind | null;
  setSigningIn(attempt: SignInAttemptKind): void;
  setSignedIn(
    profile: AuthProfile,
    contextMetadata: AuthContextMetadata,
    shareableTeams: ReadonlyArray<EpicShareableTeam>,
  ): void;
  setSubscriptionStatus(status: SubscriptionStatus | null): void;
  setSignedOut(): void;
}

/** Coalesce a profile's display name to a guaranteed string. */
function coalesceUserName(
  userName: string | undefined,
  email: string | undefined,
): string {
  return userName ?? email ?? "";
}

export const useAuthStore = create<AuthState>()((set) => ({
  status: "signed-out",
  signingInAttempt: null,
  profile: null,
  contextMetadata: null,
  shareableTeams: [],
  subscriptionStatus: null,
  setSigningIn: (attempt: SignInAttemptKind) => {
    set({ status: "signing-in", signingInAttempt: attempt });
  },
  setSignedIn: (
    profile: AuthProfile,
    contextMetadata: AuthContextMetadata,
    shareableTeams: ReadonlyArray<EpicShareableTeam>,
  ) => {
    // Store chokepoint: every signed-in profile lands here, including the projected/persisted-snapshot
    // override paths (AuthService.ingestProjected SessionSnapshot / applyExternalSession) that bypass
    const safeProfile = {
      ...profile,
      userName: coalesceUserName(profile.userName, profile.email),
    };
    set({
      status: "signed-in",
      signingInAttempt: null,
      profile: safeProfile,
      contextMetadata,
      shareableTeams,
    });
    // Email is the one person property sent (deliberate product decision so PostHog dashboards can
    // look users up); the final sanitizer drops everything else the SDK stages on $identify.
    Analytics.getInstance().identify(contextMetadata.userId, safeProfile.email);
  },
  setSubscriptionStatus: (status: SubscriptionStatus | null) => {
    set({ subscriptionStatus: status });
  },
  setSignedOut: () => {
    set({
      status: "signed-out",
      signingInAttempt: null,
      profile: null,
      contextMetadata: null,
      shareableTeams: [],
      subscriptionStatus: null,
    });
    Analytics.getInstance().reset();
  },
}));

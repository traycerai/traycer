import type { AuthenticatedUser } from "@traycer/protocol/auth";
import { useAuthStore, type EpicShareableTeam } from "@/stores/auth/auth-store";

export type { EpicShareableTeam };

/** Teams the signed-in user can share an epic with. */
export function useEpicShareableTeams(): ReadonlyArray<EpicShareableTeam> {
  return useAuthStore((state) => state.shareableTeams);
}

export function projectShareableTeams(
  user: AuthenticatedUser | null,
): ReadonlyArray<EpicShareableTeam> {
  if (user === null) return [];
  return user.teamSubscriptions.map((subscription) => ({
    teamId: subscription.team.id,
    slug: subscription.team.slug,
    avatarUrl: subscription.team.avatarUrl,
  }));
}

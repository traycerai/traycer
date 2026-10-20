import { useCallback, useEffect, useRef } from "react";
import { organizationRowScope } from "@traycer-clients/shared/view-replica/row-scope";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import { removedTeamIds } from "@/hooks/teams/team-removal-model";
import {
  viewReplicaEvictionForVerdictLoss,
  viewReplicaStore,
} from "@/lib/view-replica/view-replica-store";

/**
 * Binds the replica tier to the signed-in identity.
 *
 * - An identity arriving (a cold start included, offline or not) warms its
 *   pages into memory, off the paint path.
 * - The identity retiring - sign-out, or another account taking the session
 *   - wipes the replica.
 * - Losing the cloud verdict applies its eviction class: an unreachable
 *   authn or a refused token keeps the pages, a refused account drops them.
 * - Leaving a team while signed in withdraws that team's rows from every
 *   cached page, as of now.
 */
export function ViewReplicaLifecycleMount(): null {
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  const cloudVerdictLoss = useAuthStore((state) => state.cloudVerdictLoss);
  const teams = useAuthStore((state) => state.shareableTeams);

  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    switch (transition.kind) {
      case "signedIn":
        if (transition.userId !== null) {
          void viewReplicaStore.warm(transition.userId);
        }
        return;
      case "userSwitched": {
        const next = transition.userId;
        void viewReplicaStore
          .evict({ kind: "identity-retired" })
          .then(() => (next === null ? undefined : viewReplicaStore.warm(next)));
        return;
      }
      case "signedOut":
        void viewReplicaStore.evict({ kind: "identity-retired" });
        return;
    }
  }, []);
  useAuthIdentityTransition(status, userId, onTransition);

  useEffect(() => {
    if (status !== "unverified" || userId === null) return;
    void viewReplicaStore.evict(
      viewReplicaEvictionForVerdictLoss(cloudVerdictLoss, userId),
    );
  }, [cloudVerdictLoss, status, userId]);

  const previousTeams = useRef<{
    readonly userId: string | null;
    readonly signedIn: boolean;
    readonly teamIds: readonly string[];
  } | null>(null);
  useEffect(() => {
    const signedIn = status === "signed-in";
    const teamIds = teams.map((team) => team.teamId);
    const before = previousTeams.current;
    previousTeams.current = { userId, signedIn, teamIds };
    // Only a removal one signed-in session observed, the same edge
    // `useCloseTilesOnTeamRemoval` closes a removed team's tiles on: a list
    // that is empty because no verdict is held is not a loss.
    if (
      !signedIn ||
      userId === null ||
      before === null ||
      !before.signedIn ||
      before.userId !== userId
    ) {
      return;
    }
    const at = Date.now();
    for (const teamId of removedTeamIds(before.teamIds, teamIds)) {
      void viewReplicaStore.evict({
        kind: "scope-withdrawn",
        accountId: userId,
        scope: organizationRowScope(teamId),
        at,
      });
    }
  }, [status, teams, userId]);

  return null;
}

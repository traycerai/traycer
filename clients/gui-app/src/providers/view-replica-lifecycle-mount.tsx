import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import {
  viewReplicaEvictionForVerdictLoss,
  viewReplicaStore,
} from "@/lib/view-replica/view-replica-store";

function subscribeToReplica(listener: () => void): () => void {
  return viewReplicaStore.subscribe(listener);
}

function readReplicaVersion(): number {
  return viewReplicaStore.version();
}

/**
 * Binds the replica tier to the signed-in identity.
 *
 * - An identity arriving (a cold start included, offline or not) warms its
 *   pages into memory, off the paint path.
 * - The identity retiring - sign-out, or another account taking the session
 *   - wipes the replica.
 * - Losing the cloud verdict applies its eviction class: an unreachable
 *   authn or a refused token keeps the pages, a refused account drops them.
 * - A team missing from a signed-in verdict's team list has its rows
 *   withdrawn from every cached page, as of then.
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
          .then(() =>
            next === null ? undefined : viewReplicaStore.warm(next),
          );
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

  // Every team list a signed-in verdict carries is the account's membership,
  // so the cached pages are reconciled against each one, and again whenever
  // they change (a warm landing, a page written): a removal made while the
  // session was unverified, or before this start, is caught at the first
  // verdict after it. Only a signed-in list counts - the `unverified` list is
  // empty because no verdict is held, which is not a loss.
  const storeVersion = useSyncExternalStore(
    subscribeToReplica,
    readReplicaVersion,
  );
  useEffect(() => {
    if (status !== "signed-in" || userId === null) return;
    const members = new Set(teams.map((team) => team.teamId));
    viewReplicaStore.reconcileMemberships(
      userId,
      (organizationId) => members.has(organizationId),
      Date.now(),
    );
  }, [status, storeVersion, teams, userId]);

  return null;
}

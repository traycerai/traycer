import { useEffect } from "react";
import { toast } from "sonner";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding, useHostClient } from "@/lib/host";
import { useRegisteredHosts } from "@/hooks/auth/use-registered-hosts-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  takeClaimNotice,
  useTeamComputersSeenStore,
  type SeenTeamComputer,
} from "@/stores/hosts/claimed-computer-notice-store";
import {
  claimNoticeKey,
  claimedComputerSentence,
  departedTeamComputers,
  teamComputersOf,
} from "./claimed-computer-notice-model";

/**
 * A teammate's claim of a team computer, told once per device (ruling 2,
 * 14 Nov). Whenever a team computer this device saw in the person's list is
 * gone from it while the person is still in its team, the app reads authn's
 * claimed computers for that team and, for a claim of that computer it has
 * not told yet, shows the owner's sentence. The list this device last saw is
 * kept across restarts, so a claim made while the app was closed is told at
 * the next open.
 */
export function useClaimedComputerNotice(): void {
  const binding = useHostBinding();
  const auth = binding?.auth ?? null;
  const viewerUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const signedIn = useAuthStore((state) => state.status === "signed-in");
  const teams = useAuthStore((state) => state.shareableTeams);
  const registry = useRegisteredHosts().data ?? null;
  const environments =
    useEnvironmentListQuery(useHostClient(), signedIn).data ?? null;

  useEffect(() => {
    if (!signedIn || viewerUserId === null || registry === null) return;
    const teamIds = new Set(teams.map((team) => team.teamId));
    const listed = teamComputersOf(registry);
    const seen =
      useTeamComputersSeenStore.getState().byViewer[viewerUserId] ?? {};
    const departed = departedTeamComputers(seen, listed, teamIds);
    if (departed.length > 0) {
      // Kept as seen until the team's environment can be named.
      if (auth === null || environments === null) return;
      void tellClaims(auth, viewerUserId, departed, environments);
    }
    useTeamComputersSeenStore
      .getState()
      .setSeen(viewerUserId, Object.fromEntries(listed));
  }, [auth, environments, registry, signedIn, teams, viewerUserId]);
}

async function tellClaims(
  auth: AuthService,
  viewerUserId: string,
  departed: ReadonlyArray<readonly [string, SeenTeamComputer]>,
  environments: EnvironmentListResponseV11,
): Promise<void> {
  const byTeam = new Map<string, Map<string, SeenTeamComputer>>();
  for (const [hostId, computer] of departed) {
    const hosts =
      byTeam.get(computer.teamId) ?? new Map<string, SeenTeamComputer>();
    hosts.set(hostId, computer);
    byTeam.set(computer.teamId, hosts);
  }
  for (const [teamId, hosts] of byTeam) {
    const environmentId = environments.environments.find(
      (descriptor) =>
        descriptor.ownerKind !== "user" && descriptor.ownerId === teamId,
    )?.environmentId;
    if (environmentId === undefined) continue;
    const result = await auth.listClaimedComputers(environmentId);
    if (result.kind !== "ok") continue;
    for (const claim of result.claims) {
      const computer = hosts.get(claim.hostId);
      if (computer === undefined) continue;
      if (!takeClaimNotice(viewerUserId, claimNoticeKey(claim))) continue;
      toast.info(
        claimedComputerSentence(claim.claimantName, computer.teamName),
        { id: `claimed-computer:${claimNoticeKey(claim)}` },
      );
    }
  }
}

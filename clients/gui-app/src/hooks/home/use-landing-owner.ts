import { useMemo } from "react";
import {
  resolveLandingOwner,
  type LandingOwnerTeam,
} from "@/components/home/composer/landing-owner-model";
import { useHostOwnerTeamId } from "@/hooks/sandboxes/use-on-team-sandbox";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The owner a landing draft's create sends: the team that owns the resolved
 * host when the person is in it, else Personal (`null`).
 */
export function useLandingOwner(
  resolvedHostId: string | null,
): LandingOwnerTeam | null {
  const teams = useAuthStore((s) => s.shareableTeams);
  const resolvedHostTeamId = useHostOwnerTeamId(resolvedHostId);
  return useMemo(
    () => resolveLandingOwner({ resolvedHostTeamId, teams }),
    [resolvedHostTeamId, teams],
  );
}

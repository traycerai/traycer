import { useMemo } from "react";
import {
  resolveLandingOwner,
  type LandingOwnerTeam,
} from "@/components/home/composer/landing-owner-model";
import { useHostOwnerTeamId } from "@/hooks/sandboxes/use-on-team-sandbox";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  landingOwnerDraftKey,
  useLandingOwnerStore,
} from "@/stores/home/landing-owner-store";

/**
 * The owner a landing draft's create sends: the draft's Belongs to pick, else
 * the resolved host's team, else Personal (`null`).
 */
export function useLandingOwner(
  draftId: string | null,
  resolvedHostId: string | null,
): LandingOwnerTeam | null {
  const choice = useLandingOwnerStore(
    (s) => s.byDraftId[landingOwnerDraftKey(draftId)] ?? null,
  );
  const teams = useAuthStore((s) => s.shareableTeams);
  const resolvedHostTeamId = useHostOwnerTeamId(resolvedHostId);
  return useMemo(
    () => resolveLandingOwner({ choice, resolvedHostTeamId, teams }),
    [choice, resolvedHostTeamId, teams],
  );
}

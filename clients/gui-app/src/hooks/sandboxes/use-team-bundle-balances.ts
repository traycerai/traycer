import { useCallback, useMemo } from "react";
import {
  queryOptions,
  useQueries,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { readTeamBundleRemaining } from "@traycer-clients/shared/environment/team-bundle-balance";
import { teamBundleBalanceMc } from "@/components/hosts/sandbox-create-model";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useHostBinding } from "@/lib/host";
import { sandboxQueryKeys } from "@/lib/query-keys";
import type { TeamBalanceMc } from "@/lib/sandboxes/sandbox-stage-model";
import { useAuthStore } from "@/stores/auth/auth-store";

interface BalanceTeam {
  readonly id: string;
  readonly slug: string;
}

const NO_TEAMS: readonly BalanceTeam[] = [];

/** The person's teams, stable while the signed-in user's record is. */
function useBalanceTeams(): readonly BalanceTeam[] {
  const user = useAuthUser().data ?? null;
  return useMemo(
    () => user?.teamSubscriptions.map((entry) => entry.team) ?? NO_TEAMS,
    [user],
  );
}

/**
 * One team's read, by its handle: the key it is cached under, the call that
 * answers it (the team's remaining bundle credits), and whether it may run.
 */
function useTeamBalanceOptions() {
  const auth = useHostBinding()?.auth ?? null;
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  return useCallback(
    (slug: string) =>
      queryOptions({
        queryKey: sandboxQueryKeys.teamBalance(auth, userId, slug),
        queryFn: async (): Promise<number | null> =>
          auth === null
            ? null
            : readTeamBundleRemaining(auth.environmentCloud(), slug),
        enabled: signedIn && userId !== null && auth !== null,
      }),
    [auth, signedIn, userId],
  );
}

/**
 * Each of the person's teams' own balance, in millicredits: the team's
 * remaining bundle credits, the pot every wake of its sandboxes draws. Read
 * from authn's organization route on the person's sign-in, which answers any
 * accepted member. A team whose read is out or failed, or whose organization
 * has no bundle summary, is `null`: unknown, never short.
 */
export function useTeamBundleBalances(): TeamBalanceMc {
  const teams = useBalanceTeams();
  const options = useTeamBalanceOptions();
  // Stable while the team list is, so the combined answer keeps its identity
  // between renders (TanStack re-runs `combine` when its reference changes).
  const combine = useCallback(
    (results: ReadonlyArray<UseQueryResult<number | null>>) => {
      const byTeamId = new Map<string, number>();
      results.forEach((result, index) => {
        const remaining = result.data;
        if (remaining === undefined || remaining === null) return;
        byTeamId.set(teams[index].id, teamBundleBalanceMc(remaining));
      });
      return byTeamId;
    },
    [teams],
  );
  const balances = useQueries({
    queries: teams.map((team) => options(team.slug)),
    combine,
  });
  return useCallback(
    (teamId: string) => balances.get(teamId) ?? null,
    [balances],
  );
}

/**
 * Reads one team's balance afresh, for Send: the cached one is advice. `null`
 * when the team is not the person's, the read fails, or it names no bundles.
 */
export function useReadTeamBundleBalance(): (
  teamId: string,
) => Promise<number | null> {
  const teams = useBalanceTeams();
  const options = useTeamBalanceOptions();
  const queryClient = useQueryClient();
  return useCallback(
    async (teamId: string) => {
      const team = teams.find((entry) => entry.id === teamId);
      if (team === undefined) return null;
      const read = options(team.slug);
      if (read.enabled !== true) return null;
      const remaining = await queryClient
        .fetchQuery({ ...read, staleTime: 0 })
        .catch(() => null);
      return remaining === null ? null : teamBundleBalanceMc(remaining);
    },
    [options, queryClient, teams],
  );
}

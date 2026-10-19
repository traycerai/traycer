import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { TeamEnvironmentFetchResult } from "@traycer-clients/shared/host-client/sandbox-secrets";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

function teamEnvironmentQueryOptions(
  auth: AuthService | null,
  userId: string | null,
  teamId: string | null,
  enabled: boolean,
) {
  if (auth === null || teamId === null) {
    return queryOptions<TeamEnvironmentFetchResult>({
      queryKey: sandboxQueryKeys.teamEnvironmentMissing(),
      queryFn: () =>
        Promise.resolve<TeamEnvironmentFetchResult>({ kind: "not-a-member" }),
      enabled: false,
    });
  }
  return queryOptions<TeamEnvironmentFetchResult>({
    queryKey: sandboxQueryKeys.teamEnvironment(auth, userId, teamId),
    queryFn: () => auth.getTeamEnvironment(teamId),
    enabled,
    // An environment's id never changes once created. Any other answer (not
    // a member yet, a failed read) is read again on the next pick or focus.
    staleTime: (query) =>
      query.state.data?.kind === "ok" ? Number.POSITIVE_INFINITY : 0,
    // The app's default is off; a failed read must come back on return.
    refetchOnWindowFocus: true,
  });
}

/**
 * `GET /api/v3/teams/:teamId/environment` for the team the create form's
 * Belongs to names. The route creates the team's environment and syncs the
 * member's items on its first call, so this reads it only for a picked team
 * (`null` reads nothing), once per session when it answers with the
 * environment.
 *
 * `data` is the fetch result itself: `not-a-member` and a failure are
 * answers the form renders, not errors.
 */
export function useTeamEnvironment(
  teamId: string | null,
): UseQueryResult<TeamEnvironmentFetchResult> {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  return useQuery(teamEnvironmentQueryOptions(auth, userId, teamId, signedIn));
}

import { useCallback } from "react";
import {
  queryOptions,
  useQueries,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { TeamEnvironmentFetchResult } from "@traycer-clients/shared/host-client/sandbox-secrets";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

export function teamEnvironmentQueryOptions(
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

/**
 * Every listed team's environment id, for a surface that sorts sandbox rows
 * by configuration (Settings › Sandboxes): a team's rows carry its
 * environment id, and Personal's are the rest. `complete` is false until
 * every team has answered with its environment or with not-a-member, so a
 * team pod is never filed under Personal while its team is unread or its
 * read failed (a failed read is read again on focus).
 */
export function useTeamEnvironmentIds(teamIds: readonly string[]): {
  readonly byTeamId: ReadonlyMap<string, string>;
  readonly complete: boolean;
} {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  // Stable while the team list is, so the combined answer keeps its identity
  // between renders (TanStack re-runs `combine` when its reference changes).
  const combine = useCallback(
    (results: ReadonlyArray<UseQueryResult<TeamEnvironmentFetchResult>>) => {
      const byTeamId = new Map<string, string>();
      let complete = true;
      results.forEach((result, index) => {
        const teamId = teamIds[index];
        const answer = result.data;
        if (answer === undefined) {
          complete = false;
          return;
        }
        if (answer.kind === "ok") {
          byTeamId.set(teamId, answer.environmentId);
        } else if (answer.kind !== "not-a-member") {
          complete = false;
        }
      });
      return { byTeamId, complete };
    },
    [teamIds],
  );
  return useQueries({
    queries: teamIds.map((teamId) =>
      teamEnvironmentQueryOptions(auth, userId, teamId, signedIn),
    ),
    combine,
  });
}

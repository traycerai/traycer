import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { ListUserSessionsResponse } from "@traycer/protocol/auth/devices-sessions";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { authQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

const USER_SESSIONS_POLL_MS = 30_000;

function userSessionsQueryOptions(
  auth: AuthService | null,
  userId: string | null,
) {
  if (auth === null || userId === null) {
    return queryOptions<ListUserSessionsResponse | null>({
      queryKey: authQueryKeys.userSessionsMissing(),
      queryFn: () => Promise.resolve(null),
      enabled: false,
    });
  }
  return queryOptions<ListUserSessionsResponse | null>({
    queryKey: authQueryKeys.userSessions(auth, userId),
    // The signal is forwarded rather than dropped because `fetchUserSessions`
    // can spend a single-use refresh rotation on its repair path. A revoke
    // invalidating this query, an unmount, or a focus refetch superseding the
    // 30s poll all cancel here, and none of them should leave that spend in
    // flight for an answer no one will read.
    queryFn: ({ signal }) => auth.fetchUserSessions(signal),
    enabled: true,
    refetchInterval: USER_SESSIONS_POLL_MS,
    refetchOnWindowFocus: true,
  });
}

export function useAuthFetchUserSessions(): UseQueryResult<ListUserSessionsResponse | null> {
  const binding = useHostBinding();
  const userId = useAuthStore((s) =>
    s.status === "signed-in" ? (s.contextMetadata?.userId ?? null) : null,
  );
  const auth = binding === null ? null : binding.auth;
  return useQuery(userSessionsQueryOptions(auth, userId));
}

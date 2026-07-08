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

function userSessionsQueryOptions(auth: AuthService | null, enabled: boolean) {
  if (auth === null) {
    return queryOptions<ListUserSessionsResponse | null>({
      queryKey: authQueryKeys.userSessionsMissing(),
      queryFn: () => Promise.resolve(null),
      enabled: false,
    });
  }
  return queryOptions<ListUserSessionsResponse | null>({
    queryKey: authQueryKeys.userSessions(auth),
    queryFn: () => auth.fetchUserSessions(),
    enabled,
    refetchInterval: enabled ? USER_SESSIONS_POLL_MS : false,
    refetchOnWindowFocus: true,
  });
}

export function useUserSessions(): UseQueryResult<ListUserSessionsResponse | null> {
  const binding = useHostBinding();
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const auth = binding === null ? null : binding.auth;
  return useQuery(userSessionsQueryOptions(auth, signedIn));
}

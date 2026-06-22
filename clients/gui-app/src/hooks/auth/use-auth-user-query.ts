import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { AuthService } from "@/lib/auth/auth-service";
import { useAuthService } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { authQueryKeys } from "@/lib/query-keys";

function authUserQueryOptions(auth: AuthService, enabled: boolean) {
  return queryOptions<AuthenticatedUser | null>({
    queryKey: authQueryKeys.user(auth),
    queryFn: () => auth.fetchAuthenticatedUser(),
    enabled,
    // Refetch on focus so a credit spend made elsewhere shows up on return; no
    // polling - the panel's refresh button covers in-session changes.
    refetchOnWindowFocus: true,
  });
}

/**
 * Fetches the signed-in user's full identity + credits via `AuthService`
 * (`/api/v3/user`). Disabled while signed-out. Credits live only in this query
 * cache - never the auth store, which keeps only its narrow projections.
 */
export function useAuthUser(): UseQueryResult<AuthenticatedUser | null> {
  const auth = useAuthService();
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  return useQuery(authUserQueryOptions(auth, signedIn));
}

import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { EnvironmentProvidersFetchResult } from "@traycer-clients/shared/host-client/sandbox-secrets";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

function environmentProvidersQueryOptions(
  auth: AuthService | null,
  userId: string | null,
  environmentId: string | null,
  enabled: boolean,
) {
  if (auth === null || environmentId === null) {
    return queryOptions<EnvironmentProvidersFetchResult>({
      queryKey: sandboxQueryKeys.environmentProvidersMissing(),
      queryFn: () =>
        Promise.resolve<EnvironmentProvidersFetchResult>({
          kind: "not-found",
        }),
      enabled: false,
    });
  }
  return queryOptions<EnvironmentProvidersFetchResult>({
    queryKey: sandboxQueryKeys.environmentProviders(
      auth,
      userId,
      environmentId,
    ),
    queryFn: () => auth.getEnvironmentProviders(environmentId),
    enabled,
    // An admin adds a provider in the dashboard, another window.
    refetchOnWindowFocus: true,
  });
}

/**
 * Whether a team's environment has a provider: its API keys and linked plans,
 * counted. `null` reads nothing. `data` is the fetch result itself; the form
 * warns only on an `ok` answer of none.
 */
export function useEnvironmentProviders(
  environmentId: string | null,
): UseQueryResult<EnvironmentProvidersFetchResult> {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  return useQuery(
    environmentProvidersQueryOptions(auth, userId, environmentId, signedIn),
  );
}

import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostListResponse } from "@traycer/protocol/host/host-status";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { authQueryKeys } from "@/lib/query-keys";

/** 60s poll plus refetchOnWindowFocus. Interval pauses in the background. */
function registeredHostsQueryOptions(
  auth: AuthService | null,
  userId: string | null,
  enabled: boolean,
  pollMs: number | false,
) {
  if (auth === null) {
    // No host-runtime binding yet (auth still booting, or a surface rendered
    // outside the provider) - disable and hold an empty result rather than
    // throw, so host surfaces can render their signed-out state anywhere.
    return queryOptions<HostListResponse | null>({
      queryKey: authQueryKeys.registeredHostsMissing(),
      queryFn: () => Promise.resolve(null),
      enabled: false,
    });
  }
  return queryOptions<HostListResponse | null>({
    queryKey: authQueryKeys.registeredHosts(auth, userId),
    // An ambient reader: this query runs on a poll, on focus, and on mount, never from inside an auth transition, so the live era IS the era it is asking about.
    queryFn: async () => {
      const era = auth.currentAuthEra();
      const response = await auth.fetchRegisteredHosts(era);
      if (response === null && era.identity !== null) {
        // Same classification `buildDefaultRemoteFetcher` applies for the directory: a refresh issued for a signed-in era can only read `null` as the registry 401-ing a bearer that is still current - a transient failure, not an answer.
        throw new Error("Host registry refused a still-current credential.");
      }
      return response;
    },
    enabled,
    refetchInterval: enabled ? pollMs : false,
    refetchOnWindowFocus: true,
  });
}

/**
 * Reads the host registry; does not poll. Surfaces that render liveness opt in with {@link useRegisteredHostsPollLiveness}.
 */
export function useRegisteredHosts(): UseQueryResult<HostListResponse | null> {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  return useQuery(registeredHostsQueryOptions(auth, userId, signedIn, false));
}

/**
 * Second observer on the same query key: adds the liveness interval only. Returns nothing so callers keep reading through `useHostScope` / `useRegisteredHosts`.
 */
export function useRegisteredHostsPollLiveness(): void {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  // No interval of its own: the directory poll invalidates this key. This hook still turns on `refetchOnWindowFocus` for surfaces that render liveness.
  useQuery(registeredHostsQueryOptions(auth, userId, signedIn, false));
}

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

/**
 * Liveness cadence for the My Hosts list (Remote Host Support §7, Journey 1/2):
 * a ~15s poll while the list is visible. TanStack pauses the interval when the
 * tab is backgrounded (`refetchIntervalInBackground` defaults to `false`), and
 * `refetchOnWindowFocus` snaps it fresh on return — v1 liveness is poll-based;
 * push can come later.
 */
const REGISTERED_HOSTS_POLL_MS = 15_000;

function registeredHostsQueryOptions(
  auth: AuthService | null,
  enabled: boolean,
) {
  if (auth === null) {
    // No host-runtime binding yet (auth still booting, or a surface rendered
    // outside the provider) — disable and hold an empty result rather than
    // throw, so My Hosts can render its signed-out state anywhere.
    return queryOptions<HostListResponse | null>({
      queryKey: authQueryKeys.registeredHostsMissing(),
      queryFn: () => Promise.resolve(null),
      enabled: false,
    });
  }
  return queryOptions<HostListResponse | null>({
    queryKey: authQueryKeys.registeredHosts(auth),
    queryFn: () => auth.fetchRegisteredHosts(),
    enabled,
    refetchInterval: enabled ? REGISTERED_HOSTS_POLL_MS : false,
    refetchOnWindowFocus: true,
  });
}

/**
 * Fetches the signed-in user's host registry + live status via `AuthService`
 * (`GET /api/v3/hosts`). Disabled while signed-out or before the host runtime
 * binding is ready. The registry + presence lease live only in this query
 * cache; status is rendered as a pure function of the returned DTO (see
 * `my-hosts-model.ts`).
 */
export function useRegisteredHosts(): UseQueryResult<HostListResponse | null> {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  return useQuery(registeredHostsQueryOptions(auth, signedIn));
}

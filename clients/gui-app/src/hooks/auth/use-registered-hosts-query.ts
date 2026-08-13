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
 * Liveness cadence for surfaces that actually render host liveness.
 *
 * 60s, not the 15s this used to run at. The old number was sized for a
 * heartbeat lease that expired in about a minute, so polling slower than that
 * meant showing a host as Online after it had already gone. Liveness is now a
 * relay attachment: a clean shutdown is pushed to the cloud in seconds, and a
 * dirty death is bounded by the lease TTL — on the order of 15 minutes — no
 * matter how fast this asks. So a faster poll buys a fresher answer to nothing
 * and simply multiplies the per-open-GUI read volume behind `GET /hosts`.
 *
 * `refetchOnWindowFocus` is what actually keeps the list feeling live and is
 * deliberately kept: the moment a person looks at the window is the moment the
 * answer has to be current, and that is one request rather than a standing
 * interval.
 *
 * TanStack pauses the interval while the tab is backgrounded
 * (`refetchIntervalInBackground` defaults to `false`).
 */
const REGISTERED_HOSTS_POLL_MS = 60_000;

function registeredHostsQueryOptions(
  auth: AuthService | null,
  userId: string | null,
  enabled: boolean,
  pollMs: number | false,
) {
  if (auth === null) {
    // No host-runtime binding yet (auth still booting, or a surface rendered
    // outside the provider) — disable and hold an empty result rather than
    // throw, so host surfaces can render their signed-out state anywhere.
    return queryOptions<HostListResponse | null>({
      queryKey: authQueryKeys.registeredHostsMissing(),
      queryFn: () => Promise.resolve(null),
      enabled: false,
    });
  }
  return queryOptions<HostListResponse | null>({
    queryKey: authQueryKeys.registeredHosts(auth, userId),
    // An ambient reader: this query runs on a poll, on focus, and on mount,
    // never from inside an auth transition, so the live era IS the era it is
    // asking about. Read at call time rather than closed over, so a refetch
    // after a rotation asks under the era it is actually running in.
    queryFn: async () => {
      const era = auth.currentAuthEra();
      const response = await auth.fetchRegisteredHosts(era);
      if (response === null && era.identity !== null) {
        // Same classification `buildDefaultRemoteFetcher` applies for the
        // directory: a refresh issued for a signed-in era can only read
        // `null` as the registry 401-ing a bearer that is still current — a
        // transient failure, not an answer. Committing it as data would
        // replace the cached host list with "no hosts", stripping registry
        // metadata (platform, update controls) from every scope reader until
        // a later poll succeeds. Throw so TanStack keeps the last successful
        // data and retries. A signed-out era's `null` stays data: that is the
        // authoritative empty state the panels render.
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
 * Fetches the signed-in user's host registry + live status via `AuthService`
 * (`GET /api/v3/hosts`). Disabled while signed-out or before the host runtime
 * binding is ready. Status is rendered as a pure function of the returned DTO
 * (see `my-hosts-model.ts`).
 *
 * Reading the list does NOT poll it. Most callers want this data for names,
 * platform and update policy — facts that do not go stale on a timer — and
 * they reach it through `useHostScope`, which every host-scoped Settings panel
 * mounts. Polling from here therefore ran a standing interval on behalf of
 * panels that render no liveness at all (Shell, Worktrees, Providers…), and
 * would silently re-arm one for the next panel that mounts the scope.
 * A surface that genuinely renders liveness opts in with
 * {@link useRegisteredHostsPollLiveness}.
 */
export function useRegisteredHosts(): UseQueryResult<HostListResponse | null> {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  return useQuery(registeredHostsQueryOptions(auth, userId, signedIn, false));
}

/**
 * Opt-in liveness polling for a surface that RENDERS host liveness — the
 * sidebar host switcher, the add-host list, the Overview identity card.
 *
 * Mounts a second observer on the same query key rather than taking a flag
 * through `useHostScope`: the flag would have to be threaded through every one
 * of that hook's ~15 call sites and their test doubles, to express something
 * only three components care about. TanStack dedupes by key, so this shares one
 * request and one cache entry with `useRegisteredHosts`; it only adds the
 * interval, and the interval stops when the last such component unmounts.
 *
 * Returns nothing on purpose. Callers read the data through their existing
 * `useHostScope()` / `useRegisteredHosts()` read; this hook exists to declare
 * "this surface is showing liveness", and a return value would invite a second
 * read path to the same cache entry.
 */
export function useRegisteredHostsPollLiveness(): void {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  useQuery(
    registeredHostsQueryOptions(
      auth,
      userId,
      signedIn,
      REGISTERED_HOSTS_POLL_MS,
    ),
  );
}

import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { UserSandboxCost } from "@traycer/protocol/host/sandbox-control";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { sandboxFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";
import { useSandboxControlUnavailableReason } from "@/hooks/sandboxes/use-sandbox-control-unavailable-reason";

/** How often the balance and the cost view refresh while something accrues. */
const ACCRUING_REFRESH_MS = 60_000;

/**
 * What the user's sandboxes accrue now, all rows together: compute while
 * awake, and storage while suspended or stopped. The awake burn alone is not
 * it - a sleeping sandbox burns nothing yet still bills its disk, so its
 * storage figure, pending charges and the balance would go stale.
 */
function accruingMillicreditsPerHour(costs: UserSandboxCost): number {
  return costs.sandboxes.reduce(
    (sum, row) => sum + row.currentRateMillicreditsPerHour,
    0,
  );
}

/**
 * The poll for the balance and the cost view: every minute while any sandbox
 * accrues credits, none otherwise. With the app focused on one screen and
 * nothing changing state, no event would ever refresh the two, and the
 * runway warning could cross both thresholds unseen. Paused while the app is
 * in the background (`refetchIntervalInBackground: false` at each use); focus
 * refetches on return.
 */
export function sandboxCostsRefetchInterval(
  costs: UserSandboxCost | null,
): number | false {
  return costs !== null && accruingMillicreditsPerHour(costs) > 0
    ? ACCRUING_REFRESH_MS
    : false;
}

function sandboxCostsQueryOptions(
  auth: AuthService | null,
  userId: string | null,
  enabled: boolean,
) {
  if (auth === null) {
    return queryOptions<UserSandboxCost | null>({
      queryKey: sandboxQueryKeys.costsMissing(),
      queryFn: () => Promise.resolve(null),
      enabled: false,
    });
  }
  return queryOptions<UserSandboxCost | null>({
    queryKey: sandboxQueryKeys.costs(auth, userId),
    queryFn: async () => {
      const result = await auth.getSandboxCosts();
      if (result.kind === "ok") {
        return result.costs;
      }
      // Thrown, never a zero burn: a burn of 0 reads as "nothing is running",
      // which would hide the balance warnings exactly when they matter.
      throw new Error(sandboxFailureMessage(result));
    },
    enabled,
    // On focus, on the events `useRefreshSandboxCosts` invalidates on, and
    // every minute while its own answer says a sandbox accrues (the balance
    // it is divided into polls on the same rule there).
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      sandboxCostsRefetchInterval(query.state.data ?? null),
    refetchIntervalInBackground: false,
  });
}

/**
 * `GET /api/sandboxes/cost`: every listed sandbox's cost from the control
 * plane's ledger, and the user's awake burn (`awakeBurnMillicreditsPerHour`),
 * which the balance warnings divide the live balance by.
 *
 * Mount `useRefreshSandboxCosts` beside it on a surface that shows it, so the
 * figures move when a sandbox changes state or a Traycer turn spends credits.
 */
export function useSandboxCosts(): UseQueryResult<UserSandboxCost | null> {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const unavailable = useSandboxControlUnavailableReason() !== null;
  return useQuery(
    sandboxCostsQueryOptions(auth, userId, signedIn && !unavailable),
  );
}

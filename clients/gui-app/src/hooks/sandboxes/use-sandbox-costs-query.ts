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
    // Same cadence as the credits it is divided into (`useAuthUser`): on
    // focus, and on the events `useRefreshSandboxCosts` invalidates on. No
    // polling of its own.
    refetchOnWindowFocus: true,
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
  return useQuery(sandboxCostsQueryOptions(auth, userId, signedIn));
}

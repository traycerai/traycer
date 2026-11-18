import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { CreditOffer } from "@traycer/protocol/auth/credit-offers";
import type { AuthService } from "@/lib/auth/auth-service";
import { useAuthService } from "@/lib/host";
import { authQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

function creditOffersQueryOptions(
  auth: AuthService,
  userId: string | null,
  enabled: boolean,
) {
  if (userId === null) {
    return queryOptions<ReadonlyArray<CreditOffer>>({
      queryKey: authQueryKeys.creditOffersMissing(),
      queryFn: () => Promise.resolve([]),
      enabled: false,
    });
  }
  return queryOptions<ReadonlyArray<CreditOffer>>({
    queryKey: authQueryKeys.creditOffers(auth, userId),
    queryFn: async ({ signal }) => {
      const result = await auth.listCreditOffers(signal);
      if (result.kind !== "ok") {
        // Thrown, not returned: the panel reads an error as "no list" and
        // keeps the claimed offers the user record carries.
        throw new Error(`Credit offers unavailable (${result.kind}).`);
      }
      return result.offers;
    },
    enabled,
    refetchOnWindowFocus: true,
  });
}

/**
 * The credit offers Settings ▸ Credits can claim from (`api/user/credit-
 * campaigns`). `enabled` is the caller's account context: offers belong to
 * the personal account, so a team context never asks.
 */
export function useAuthListCreditOffers(
  enabled: boolean,
): UseQueryResult<ReadonlyArray<CreditOffer>> {
  const auth = useAuthService();
  const userId = useAuthStore((s) =>
    s.status === "signed-in" ? (s.contextMetadata?.userId ?? null) : null,
  );
  return useQuery(creditOffersQueryOptions(auth, userId, enabled));
}

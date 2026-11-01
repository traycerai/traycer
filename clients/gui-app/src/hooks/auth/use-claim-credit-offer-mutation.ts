import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { CreditOffer } from "@traycer/protocol/auth/credit-offers";
import type {
  ClaimCreditOfferFetchResult,
  CreditOfferUnavailableReason,
} from "@traycer-clients/shared/auth/credit-offers";
import { CREDITS_PAGE } from "@/components/settings/panels/credits-settings.definitions";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import type { AuthService } from "@/lib/auth/auth-service";
import { useAuthService } from "@/lib/host";
import { authMutationKeys, authQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * A claim that did not fail. `already-claimed` is not an error: the list was
 * out of date, and the refetch every claim ends with puts the row right.
 */
export type ClaimCreditOfferOutcome =
  | { readonly kind: "claimed"; readonly offer: CreditOffer | null }
  | { readonly kind: "already-claimed" };

interface ClaimCreditOfferMutationContext {
  readonly auth: AuthService;
  readonly userId: string | null;
}

const UNAVAILABLE_MESSAGES: Readonly<
  Record<CreditOfferUnavailableReason, string>
> = {
  "sold-out": CREDITS_PAGE.claimSoldOut,
  "not-running": CREDITS_PAGE.claimNotRunning,
  ineligible: CREDITS_PAGE.claimIneligible,
};

function unwrapClaimCreditOfferResult(
  result: ClaimCreditOfferFetchResult,
): ClaimCreditOfferOutcome {
  switch (result.kind) {
    case "ok":
      return { kind: "claimed", offer: result.offer };
    case "conflict":
      return { kind: "already-claimed" };
    case "unavailable":
      throw new Error(UNAVAILABLE_MESSAGES[result.reason]);
    case "unauthorized":
      throw new Error(CREDITS_PAGE.claimSignIn);
    case "network-error":
      throw new Error(CREDITS_PAGE.claimUnreachable);
  }
}

/**
 * Settings ▸ Credits' Claim button. Every claim, however it ends, refetches
 * both the user record and the offer list, and stays pending until they land,
 * so the button cannot be pressed twice and the row never returns to "Claim"
 * in between. A successful claim's card is written into the list first, so
 * the row reads as claimed before the user record has caught up.
 */
export function useAuthClaimCreditOffer(): UseMutationResult<
  ClaimCreditOfferOutcome,
  Error,
  string,
  ClaimCreditOfferMutationContext
> {
  const auth = useAuthService();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: authMutationKeys.claimCreditOffer(),
    onMutate: (): ClaimCreditOfferMutationContext => ({
      auth,
      userId: useAuthStore.getState().contextMetadata?.userId ?? null,
    }),
    mutationFn: async (campaignId: string) =>
      unwrapClaimCreditOfferResult(await auth.claimCreditOffer(campaignId)),
    onSuccess: (outcome, _campaignId, context) => {
      if (
        outcome.kind !== "claimed" ||
        outcome.offer === null ||
        context.userId === null
      ) {
        return;
      }
      const claimed = outcome.offer;
      queryClient.setQueryData<ReadonlyArray<CreditOffer>>(
        authQueryKeys.creditOffers(context.auth, context.userId),
        (offers) =>
          offers?.map((offer) => (offer.id === claimed.id ? claimed : offer)),
      );
    },
    onError: (error) => toastFromAuthError(error, CREDITS_PAGE.claimFailed),
    onSettled: async (_outcome, _error, _campaignId, context) => {
      if (context === undefined) {
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: authQueryKeys.user(context.auth),
        }),
        context.userId === null
          ? Promise.resolve()
          : queryClient.invalidateQueries({
              queryKey: authQueryKeys.creditOffers(
                context.auth,
                context.userId,
              ),
            }),
      ]);
    },
  });
}

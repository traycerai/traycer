import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type {
  ProvidersConsumeRateLimitResetCreditRequest,
  ProvidersConsumeRateLimitResetCreditResponse,
} from "@traycer/protocol/host/rate-limit";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { toast } from "sonner";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useProviderRateLimitFetchScope } from "@/hooks/rate-limits/use-provider-rate-limit-fetch-scope";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import {
  fetchProviderRateLimits,
  type ProviderRateLimitFetchScope,
} from "@/lib/rate-limits/provider-rate-limit-fetch";

interface ConsumeResetCreditContext {
  readonly hostId: string | null;
  readonly fetchScope: ProviderRateLimitFetchScope | null;
}

function toastResetOutcome(
  response: ProvidersConsumeRateLimitResetCreditResponse,
): void {
  switch (response.outcome) {
    case "reset":
      toast.success("Codex usage limit reset");
      return;
    case "nothingToReset":
      toast.info("Codex has no active usage limit to reset.");
      return;
    case "noCredit":
      toast.info("No Codex manual resets are available.");
      return;
    case "alreadyRedeemed":
      toast.info("That Codex manual reset was already used.");
  }
}

export function useConsumeRateLimitResetCreditMutation(): UseMutationResult<
  ProvidersConsumeRateLimitResetCreditResponse,
  HostRpcError,
  ProvidersConsumeRateLimitResetCreditRequest,
  ConsumeResetCreditContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  const fetchScope = useProviderRateLimitFetchScope();

  return useHostMutation<
    HostRpcRegistry,
    "providers.consumeRateLimitResetCredit",
    ConsumeResetCreditContext
  >({
    client,
    method: "providers.consumeRateLimitResetCredit",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.consumeRateLimitResetCredit(),
      onMutate: () => ({
        hostId: client.getActiveHostId() ?? null,
        fetchScope,
      }),
      onSuccess: async (data, variables, context) => {
        toastResetOutcome(data);
        if (context.hostId === null) return;
        const rateLimitQueryFilters = {
          queryKey: hostQueryKeys.method<
            HostRpcRegistry,
            "host.getRateLimitUsage"
          >(context.hostId, "host.getRateLimitUsage", {
            accountContext: DEFAULT_ACCOUNT_CONTEXT,
            providerId: "codex",
            profileId: variables.profileId,
          }),
          exact: true,
        };
        // Cancel first: a read already in flight may carry numbers from before
        // the reset. A cancelled fetch is one `fetchProviderRateLimits` never
        // joins, so the forced read below goes out after the reset.
        await queryClient.cancelQueries(rateLimitQueryFilters);
        await queryClient.invalidateQueries(rateLimitQueryFilters);
        if (context.fetchScope?.hostId !== context.hostId) return;
        void fetchProviderRateLimits(
          context.fetchScope,
          {
            providerId: "codex",
            accountContext: DEFAULT_ACCOUNT_CONTEXT,
            profileId: variables.profileId,
          },
          { force: true },
        );
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't use the Codex manual reset."),
    },
  });
}

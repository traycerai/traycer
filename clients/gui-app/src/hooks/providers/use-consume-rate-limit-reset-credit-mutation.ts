import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type {
  ProvidersConsumeRateLimitResetCreditRequest,
  ProvidersConsumeRateLimitResetCreditResponse,
} from "@traycer/protocol/host/rate-limit";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { toast } from "sonner";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useRateLimitQueueScope } from "@/hooks/rate-limits/use-rate-limit-queue-scope";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import {
  enqueueRateLimitFetchForScope,
  type RateLimitQueueConfig,
} from "@/lib/rate-limits/ephemeral-fetch-queue";

interface ConsumeResetCreditContext {
  readonly hostId: string | null;
  readonly queueScope: RateLimitQueueConfig | null;
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
  const queueScope = useRateLimitQueueScope();

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
        queueScope,
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
        await queryClient.cancelQueries(rateLimitQueryFilters);
        await queryClient.invalidateQueries(rateLimitQueryFilters);
        if (context.queueScope?.hostId !== context.hostId) return;
        void enqueueRateLimitFetchForScope(
          context.queueScope,
          "codex",
          DEFAULT_ACCOUNT_CONTEXT,
          { force: true, profileId: variables.profileId },
        );
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't use the Codex manual reset."),
    },
  });
}

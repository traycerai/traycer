import type { UseMutationResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderApiKeyChangeResponse } from "@traycer-clients/shared/host-client/provider-api-key-change";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useProviderApiKeyChangeMutation } from "@/hooks/providers/use-provider-api-key-change-mutation";
import { providersMutationKeys } from "@/lib/query-keys";

type SetProviderApiKeyVariables = { readonly providerId: ProviderId } & (
  | { readonly intent?: "keep" }
  | { readonly intent: "share"; readonly environmentId: string | null }
);

export function useProvidersSetApiKey(
  expectedEnvironmentId: string | null,
  readApiKey: () => string,
  clearApiKeyInput: () => void,
  origin: "account-save" | undefined,
): UseMutationResult<
  ProviderApiKeyChangeResponse,
  HostRpcError,
  SetProviderApiKeyVariables,
  { readonly hostId: string | null }
> {
  return useProviderApiKeyChangeMutation<SetProviderApiKeyVariables>({
    expectedEnvironmentId,
    origin,
    method: "providers.setApiKey",
    mutationKey: providersMutationKeys.setApiKey(),
    errorMessage: "Couldn't save the API key.",
    changeOf: (variables) => {
      const { providerId, ...choice } = variables;
      return {
        providerId,
        change: { action: "set", apiKey: readApiKey(), ...choice },
      };
    },
    clearInput: clearApiKeyInput,
  });
}

import type { UseMutationResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderApiKeyChangeResponse } from "@traycer-clients/shared/host-client/provider-api-key-change";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useProviderApiKeyChangeMutation } from "@/hooks/providers/use-provider-api-key-change-mutation";
import { providersMutationKeys } from "@/lib/query-keys";

interface SetProviderApiKeyVariables {
  readonly providerId: ProviderId;
}

export function useProvidersSetApiKey(
  expectedEnvironmentId: string | null,
  readApiKey: () => string,
  clearApiKeyInput: () => void,
): UseMutationResult<
  ProviderApiKeyChangeResponse,
  HostRpcError,
  SetProviderApiKeyVariables,
  { readonly hostId: string | null }
> {
  return useProviderApiKeyChangeMutation<SetProviderApiKeyVariables>({
    expectedEnvironmentId,
    method: "providers.setApiKey",
    mutationKey: providersMutationKeys.setApiKey(),
    errorMessage: "Couldn't save the API key.",
    changeOf: ({ providerId }) => ({
      providerId,
      change: { action: "set", apiKey: readApiKey() },
    }),
    clearInput: clearApiKeyInput,
  });
}

import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderApiKeyChangeResponse } from "@traycer-clients/shared/host-client/provider-api-key-change";
import type { HostRpcRegistry } from "@/lib/host";
import { useProviderApiKeyChangeMutation } from "@/hooks/providers/use-provider-api-key-change-mutation";
import { providersMutationKeys } from "@/lib/query-keys";

export function useProvidersSetApiKey(
  expectedEnvironmentId: string | null,
): UseMutationResult<
  ProviderApiKeyChangeResponse,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.setApiKey">,
  { readonly hostId: string | null }
> {
  return useProviderApiKeyChangeMutation<
    RequestOfMethod<HostRpcRegistry, "providers.setApiKey">
  >({
    expectedEnvironmentId,
    method: "providers.setApiKey",
    mutationKey: providersMutationKeys.setApiKey(),
    errorMessage: "Couldn't save the API key.",
    changeOf: ({ providerId, apiKey }) => ({
      providerId,
      change: { action: "set", apiKey },
    }),
  });
}

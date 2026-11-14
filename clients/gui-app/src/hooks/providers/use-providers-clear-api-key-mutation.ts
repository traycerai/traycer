import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderApiKeyChangeResponse } from "@traycer-clients/shared/host-client/provider-api-key-change";
import type { HostRpcRegistry } from "@/lib/host";
import { useProviderApiKeyChangeMutation } from "@/hooks/providers/use-provider-api-key-change-mutation";
import { providersMutationKeys } from "@/lib/query-keys";

export function useProvidersClearApiKey(): UseMutationResult<
  ProviderApiKeyChangeResponse,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.clearApiKey">,
  { readonly hostId: string | null }
> {
  return useProviderApiKeyChangeMutation<
    RequestOfMethod<HostRpcRegistry, "providers.clearApiKey">
  >({
    method: "providers.clearApiKey",
    mutationKey: providersMutationKeys.clearApiKey(),
    errorMessage: "Couldn't clear the API key.",
    changeOf: ({ providerId }) => ({ providerId, change: { action: "clear" } }),
  });
}

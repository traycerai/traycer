import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderApiKeyChangeResponse } from "@traycer-clients/shared/host-client/provider-api-key-change";
import type { HostRpcRegistry } from "@/lib/host";
import { useProviderApiKeyChangeMutation } from "@/hooks/providers/use-provider-api-key-change-mutation";
import { providersMutationKeys } from "@/lib/query-keys";

type ClearProviderApiKeyVariables = RequestOfMethod<
  HostRpcRegistry,
  "providers.clearApiKey"
> & { readonly usePersonal?: true };

export function useProvidersClearApiKey(
  expectedEnvironmentId: string | null,
): UseMutationResult<
  ProviderApiKeyChangeResponse,
  HostRpcError,
  ClearProviderApiKeyVariables,
  { readonly hostId: string | null }
> {
  return useProviderApiKeyChangeMutation<ClearProviderApiKeyVariables>({
    expectedEnvironmentId,
    origin: undefined,
    method: "providers.clearApiKey",
    mutationKey: providersMutationKeys.clearApiKey(),
    errorMessage: "Couldn't clear the API key.",
    changeOf: ({ providerId, usePersonal }) => ({
      providerId,
      change:
        usePersonal === true
          ? { action: "clear", usePersonal }
          : { action: "clear" },
    }),
    clearInput: () => undefined,
  });
}

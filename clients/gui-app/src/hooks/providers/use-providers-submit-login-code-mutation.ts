import type { UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClient } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { providersMutationKeys } from "@/lib/query-keys";

type SubmitLoginCodeMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.submitLoginCode">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.submitLoginCode">
>;

/**
 * No cache invalidation; the exchange outcome arrives on `providers.awaitLogin`. No `onError` toast: the paste field renders `mutation.error` inline.
 */
export function useProvidersSubmitLoginCode(): SubmitLoginCodeMutationResult {
  return useProvidersSubmitLoginCodeForClient(useHostClient());
}

/** Client-scoped variant - see `useProvidersStartLoginForClient`. */
export function useProvidersSubmitLoginCodeForClient(
  client: HostClient<HostRpcRegistry> | null,
): SubmitLoginCodeMutationResult {
  return useHostMutation<HostRpcRegistry, "providers.submitLoginCode">({
    client,
    method: "providers.submitLoginCode",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.submitLoginCode(),
    },
  });
}

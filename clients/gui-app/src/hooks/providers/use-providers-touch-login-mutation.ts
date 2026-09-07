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

type TouchLoginMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.touchLogin">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.touchLogin">
>;

/**
 * Best-effort keepalive; no `onError` toast. The next touch or `awaitLogin` carries the real signal.
 */
export function useProvidersTouchLogin(): TouchLoginMutationResult {
  return useProvidersTouchLoginForClient(useHostClient());
}

/** Client-scoped variant - see `useProvidersStartLoginForClient`. */
export function useProvidersTouchLoginForClient(
  client: HostClient<HostRpcRegistry> | null,
): TouchLoginMutationResult {
  return useHostMutation<HostRpcRegistry, "providers.touchLogin">({
    client,
    method: "providers.touchLogin",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.touchLogin(),
    },
  });
}

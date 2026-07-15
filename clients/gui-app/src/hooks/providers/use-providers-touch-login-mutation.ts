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
 * Keepalive for an in-flight `providers.startLogin` child (code-paste
 * decision log's "Timeouts" row): resets the host's rolling kill timer
 * without submitting a code. Fired throttled from the paste field while the
 * user is still away in the browser.
 *
 * `onError` is intentionally omitted - this is a best-effort background
 * ping; a failure just means the next touch (or the eventual
 * `providers.awaitLogin` resolution) carries the real signal, so surfacing a
 * toast per missed keepalive would be noise.
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

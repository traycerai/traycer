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
  Omit<RequestOfMethod<HostRpcRegistry, "providers.submitLoginCode">, "code">
>;

/**
 * Relays a pasted authorization code to an in-flight `providers.startLogin`
 * child's stdin. No cache
 * invalidation - the exchange outcome surfaces later via
 * `providers.awaitLogin`'s `codeRejected` flag, not this response.
 *
 * `onError` is intentionally omitted: a submit that fails at the RPC layer
 * is a normal step in the code-paste waiting UI, not a host problem, so the
 * paste field renders `mutation.error?.message` inline instead of a toast -
 * same "surfaces that must stay inline-only" exception `TokenReauthForm`
 * uses for its own paste field.
 */
export function useProvidersSubmitLoginCode(
  readCode: () => string,
  clearCodeInput: () => void,
): SubmitLoginCodeMutationResult {
  return useProvidersSubmitLoginCodeForClient(
    useHostClient(),
    readCode,
    clearCodeInput,
  );
}

/** Client-scoped variant - see `useProvidersStartLoginForClient`. */
export function useProvidersSubmitLoginCodeForClient(
  client: HostClient<HostRpcRegistry> | null,
  readCode: () => string,
  clearCodeInput: () => void,
): SubmitLoginCodeMutationResult {
  return useHostMutation<
    HostRpcRegistry,
    "providers.submitLoginCode",
    unknown,
    Omit<RequestOfMethod<HostRpcRegistry, "providers.submitLoginCode">, "code">
  >({
    client,
    method: "providers.submitLoginCode",
    mapVariables: (variables) => ({ ...variables, code: readCode() }),
    options: {
      mutationKey: providersMutationKeys.submitLoginCode(),
      onSettled: clearCodeInput,
    },
  });
}

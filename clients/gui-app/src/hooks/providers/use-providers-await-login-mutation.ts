import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useQueryClient } from "@tanstack/react-query";
import { type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

type AwaitLoginRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.awaitLogin"
>;
type AwaitLoginResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.awaitLogin"
>;
type ProvidersListResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.list"
>;

/**
 * Awaits the honest login-completion edge for a provider on the CURRENT tab's
 * host: the host blocks the response until the `<cli> auth login` child
 * closes, then re-probes and returns that provider's fresh state. This replaces
 * the old 2s `forceAuthRefresh` poll - one request, resolving exactly when the
 * browser flow finishes, so there is no flaky-probe flicker mid-sign-in.
 *
 * On success the returned state is merged into the tab host's `providers.list`
 * cache, so the re-auth gate flips (and unmounts the banner) without a second
 * probe. A `null` state means nothing was in flight to await - left untouched.
 */
export function useProvidersAwaitLogin(): UseMutationResult<
  AwaitLoginResponse,
  HostRpcError,
  AwaitLoginRequest
> {
  const client = useTabHostClient();
  const tabHostId = useTabHostId();
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "providers.awaitLogin">({
    client,
    method: "providers.awaitLogin",
    mapVariables: (variables: AwaitLoginRequest) => variables,
    options: {
      mutationKey: providersMutationKeys.awaitLogin(),
      onSuccess: (data: AwaitLoginResponse) => {
        const next = data.state;
        if (next === null) return;
        queryClient.setQueryData<ProvidersListResponse>(
          hostQueryKeys.method<HostRpcRegistry, "providers.list">(
            tabHostId,
            "providers.list",
            {},
          ),
          (prev) => {
            if (prev === undefined) return prev;
            return {
              providers: prev.providers.map((p) =>
                p.providerId === next.providerId ? next : p,
              ),
            };
          },
        );
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't confirm sign-in."),
    },
  });
}

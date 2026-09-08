import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

/**
 * Remove the API key stored against ONE profile.
 *
 * A separate method from `providers.setProfileApiKey` rather than an
 * empty-string paste through it: the set request's `apiKey` is `min(1)`
 * precisely so a slipped empty paste cannot delete a credential, and the clear
 * request carries no `apiKey` field at all, so a key that reaches it is
 * dropped rather than stored. Deleting has to be the thing the caller asked
 * for. Same off-floor `degrade: { kind: "unsupported" }` posture as the setter,
 * and no `…ForClient` variant for the same reason - see the setter's note.
 */
type ClearProviderProfileApiKeyMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.clearProfileApiKey">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.clearProfileApiKey">,
  { readonly hostId: string | null }
>;

export function useClearProviderProfileApiKey(): ClearProviderProfileApiKeyMutationResult {
  // No `| null` widening here, unlike the `…ForClient` siblings: those take a
  // nullable client as a PARAMETER, so their `client?.` is real. Annotating
  // this one nullable does not make it so - the lint rule is type-aware and
  // reads through the annotation to what `useHostClient()` actually returns.
  // `useHostMutation` still accepts a nullable client; it just never gets one
  // from here.
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.clearProfileApiKey",
    { readonly hostId: string | null }
  >({
    client,
    method: "providers.clearProfileApiKey",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.clearProfileApiKey(),
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (_data, _variables, context) => {
        if (context.hostId === null) return;
        // Same full set as the setter, for the same reason: removing the
        // credential a profile authenticates with can take it out of service.
        for (const method of PROVIDER_INVALIDATIONS) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(context.hostId, method),
          });
        }
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't remove the API key."),
    },
  });
}

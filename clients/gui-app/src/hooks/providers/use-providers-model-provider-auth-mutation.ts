import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ModelProviderAuthAction } from "@traycer/protocol/host/provider-native-schemas";
import type {
  ProviderId,
  ProvidersModelProviderAuthResponse,
} from "@traycer/protocol/host/provider-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { invalidateAfterModelProviderMutation } from "@/hooks/providers/model-provider-invalidations";
import { providersMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

/**
 * The actions that write the provider's CONFIG FILE rather than its auth store.
 *
 * They settle differently from the rest: the host commits the block and rotates
 * before it reports the credential step, so even a failed key leaves the
 * catalog changed - which makes "invalidate only on `done`" wrong for exactly
 * these two.
 */
function isCustomProviderWrite(action: ModelProviderAuthAction): boolean {
  return action.action === "createCustom" || action.action === "updateCustom";
}

export interface ModelProviderAuthVariables {
  readonly providerId: ProviderId;
  readonly action: ModelProviderAuthAction;
}

interface ModelProviderAuthContext {
  readonly hostId: string | null;
}

/**
 * The whole upstream credential action set - `connect`, `startOauth`,
 * `submitCode`, `disconnect` - on one mutation, because they share one wire
 * method and one settlement rule.
 *
 * `onError` covers TRANSPORT failures only. Everything this surface can say
 * about a credential arrives as a successful response carrying a typed
 * `{ kind: "error" }` / `{ kind: "unsupported" }` arm, which the caller renders
 * inline next to the field that produced it - a toast for those would put the
 * explanation somewhere other than the form the user is still holding.
 */
export function useProvidersModelProviderAuth(): UseMutationResult<
  ProvidersModelProviderAuthResponse,
  HostRpcError,
  ModelProviderAuthVariables,
  ModelProviderAuthContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.modelProviderAuth",
    ModelProviderAuthContext,
    ModelProviderAuthVariables
  >({
    client,
    method: "providers.modelProviderAuth",
    mapVariables: (variables) => ({
      providerId: variables.providerId,
      action: variables.action,
    }),
    options: {
      mutationKey: providersMutationKeys.modelProviderAuth(),
      // Captured here, not read in `onSuccess`: a host swap mid-flight would
      // otherwise invalidate the NEW host's caches with the old host's result.
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (data, variables, context) => {
        // A CONFIG WRITE retires the caches whatever arm it came back on. The
        // host commits the config block and completes its rotation before it
        // reports the credential step, so a `createCustom` whose key failed has
        // still changed what the next list will say - and reporting the failure
        // while leaving the row on its old state is exactly the staleness this
        // surface is prone to.
        //
        // Everything else keeps the `done`-only rule, and one arm is the reason
        // it exists: a `pending` OAuth poll has changed nothing yet, and
        // invalidating on it would re-list - and so re-lease a managed server -
        // on every tick.
        if (
          isCustomProviderWrite(variables.action) ||
          data.result.kind === "done"
        ) {
          void invalidateAfterModelProviderMutation({
            queryClient,
            hostId: context.hostId,
          });
        }
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't reach the host for that sign-in."),
    },
  });
}

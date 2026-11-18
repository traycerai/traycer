import { everyAnswerProposes } from "@/lib/environment/settings-save-follow";
import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useSettingsSave } from "@/hooks/environment/use-settings-save";
import { useEnvironmentCloud } from "@/hooks/environment/use-environment-cloud";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

const SAVED_KINDS = ["env_override"] as const;

// Setting (or unsetting, with `value: null`) a provider env override resets the
// provider's adapter host-side, so a warm harness respawns with the new env.
// That can flip availability, so refresh the Settings panel + both harness
// selectors like the other provider mutations.
export function useProvidersSetEnvOverride(
  readValue: () => string | null,
  clearValueInput: () => void,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setEnvOverride">,
  HostRpcError,
  Omit<RequestOfMethod<HostRpcRegistry, "providers.setEnvOverride">, "value">,
  { readonly hostId: string | null }
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  const prepareSave = useSettingsSave(client, SAVED_KINDS);
  const cloudSource = useEnvironmentCloud();
  return useHostMutation<
    HostRpcRegistry,
    "providers.setEnvOverride",
    { readonly hostId: string | null },
    Omit<RequestOfMethod<HostRpcRegistry, "providers.setEnvOverride">, "value">
  >({
    client,
    method: "providers.setEnvOverride",
    mapVariables: (target) => ({ ...target, value: readValue() }),
    followSettingsSave: {
      source: cloudSource,
      follow: (request, followClient, pressedOn) =>
        prepareSave(
          { method: "providers.setEnvOverride", request },
          followClient.getActiveHostId(),
          pressedOn,
        ),
      proposes: everyAnswerProposes,
    },
    options: {
      mutationKey: providersMutationKeys.setEnvOverride(),
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: () => {
        Analytics.getInstance().track(
          AnalyticsEvent.ProviderConfigurationChanged,
          { operation: "env_override" },
        );
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't save the variable."),
      onSettled: (_data, _error, _target, context) => {
        clearValueInput();
        const hostId = context?.hostId ?? null;
        if (hostId === null) return;
        for (const method of PROVIDER_INVALIDATIONS) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(
              hostRpcServingTierHostId(
                method,
                hostId,
                readProcessHostRpcTierPlan(),
                null,
              ),
              method,
            ),
          });
        }
      },
    },
  });
}

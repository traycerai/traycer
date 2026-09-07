import type { UseMutationResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClient } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { toast } from "sonner";
import { packVersionUseRefusalMessage } from "@/components/settings/panels/provider-pack-version-manager-model";
import type { VersionManagerPanelToken } from "@/components/settings/panels/provider-pack-version-manager-presence";
import { versionManagerPanelIsMounted } from "@/components/settings/panels/provider-pack-version-manager-presence";

type UsePackVersionMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.usePackVersion">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.usePackVersion">,
  UsePackVersionMutationContext
>;

interface UsePackVersionMutationContext {
  readonly hostId: string | null;
  readonly panel: VersionManagerPanelToken | null;
}

/** Mutation-level outcomes: the popover unmounts on close. Typed refusals ride success. Toast only if the capturing panel has unmounted. */
export function useProvidersUsePackVersion(
  panel: VersionManagerPanelToken | null,
): UsePackVersionMutationResult {
  return useProvidersUsePackVersionForClient(useHostClient(), panel);
}

export function useProvidersUsePackVersionForClient(
  client: HostClient<HostRpcRegistry> | null,
  panel: VersionManagerPanelToken | null,
): UsePackVersionMutationResult {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.usePackVersion",
    UsePackVersionMutationContext
  >({
    client,
    method: "providers.usePackVersion",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.usePackVersion(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null, panel }),
      onSuccess: (response, _variables, context) => {
        if (context.hostId !== null) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(
              context.hostId,
              "providers.list",
            ),
          });
        }
        if (response.result.ok) {
          // Toast the host's echoed `pinnedVersion`, not `variables.version`. A race with another host sharing the pack store can mean the ask did not win.
          const pinned = response.result.pinnedVersion;
          toast.success(
            pinned === null
              ? "Pin cleared — new sessions follow automatic version selection"
              : `New sessions will use ${pinned}`,
          );
          return;
        }
        // A typed refusal is a SUCCESSFUL response, so `onError` never sees it.
        // The panel draws it inline - on the row, or in the header for a cleared pin - whenever it is still mounted, which is better context than a toast.
        if (!versionManagerPanelIsMounted(context.panel)) {
          toast.error(packVersionUseRefusalMessage(response.result.code));
        }
      },
      onError: (error, variables) => {
        // One RPC, two user actions: `version: null` is "use latest
        // automatically". Branching here keeps both sentences the panel used
        // to pass per call.
        toastFromHostError(
          error,
          variables.version === null
            ? "Couldn't clear the pin."
            : "Couldn't switch to this version.",
        );
      },
    },
  });
}

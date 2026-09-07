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
import { removeResultUserMessage } from "@/components/settings/panels/provider-pack-version-manager-model";
import type { VersionManagerPanelToken } from "@/components/settings/panels/provider-pack-version-manager-presence";
import { versionManagerPanelIsMounted } from "@/components/settings/panels/provider-pack-version-manager-presence";

type RemovePackVersionMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.removePackVersion">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.removePackVersion">,
  RemovePackVersionMutationContext
>;

interface RemovePackVersionMutationContext {
  readonly hostId: string | null;
  readonly panel: VersionManagerPanelToken | null;
}

/** ok false is success, not error. Mutation-level toast: the popover unmounts on close. */
export function useProvidersRemovePackVersion(
  panel: VersionManagerPanelToken | null,
): RemovePackVersionMutationResult {
  return useProvidersRemovePackVersionForClient(useHostClient(), panel);
}

export function useProvidersRemovePackVersionForClient(
  client: HostClient<HostRpcRegistry> | null,
  panel: VersionManagerPanelToken | null,
): RemovePackVersionMutationResult {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.removePackVersion",
    RemovePackVersionMutationContext
  >({
    client,
    method: "providers.removePackVersion",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.removePackVersion(),
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
        if (response.result.ok) return;
        // Typed refusals ride the success path, so `onError` cannot see them.
        // Another pack's panel being open is not a substitute - it has no row for this version and never made the request.
        if (versionManagerPanelIsMounted(context.panel)) return;
        const message = removeResultUserMessage(response.result);
        // `deferred-locked` is not a failure - the delete is recorded and runs
        // at turnover. Toasting it as an error would contradict the row, which
        // deliberately draws it as info.
        if (response.result.code === "deferred-locked") {
          toast.info(message);
          return;
        }
        toast.error(message);
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't delete this version.");
      },
    },
  });
}

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
import { installPackVersionRefusalMessage } from "@/components/settings/panels/provider-pack-version-manager-model";
import type { VersionManagerPanelToken } from "@/components/settings/panels/provider-pack-version-manager-presence";
import { versionManagerPanelIsMounted } from "@/components/settings/panels/provider-pack-version-manager-presence";

type InstallPackVersionMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.installPackVersion">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.installPackVersion">,
  InstallPackVersionMutationContext
>;

interface InstallPackVersionMutationContext {
  readonly hostId: string | null;
  readonly panel: VersionManagerPanelToken | null;
}

/** ok false is success, not error. Mutation-level outcomes: the popover unmounts on close. Toast only if the capturing panel has unmounted. */
export function useProvidersInstallPackVersion(
  panel: VersionManagerPanelToken | null,
): InstallPackVersionMutationResult {
  return useProvidersInstallPackVersionForClient(useHostClient(), panel);
}

export function useProvidersInstallPackVersionForClient(
  client: HostClient<HostRpcRegistry> | null,
  panel: VersionManagerPanelToken | null,
): InstallPackVersionMutationResult {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.installPackVersion",
    InstallPackVersionMutationContext
  >({
    client,
    method: "providers.installPackVersion",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.installPackVersion(),
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
        toast.error(installPackVersionRefusalMessage(response.result.code));
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't download this version.");
      },
    },
  });
}

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

/**
 * User-requested download of one pack version without flipping `current`.
 *
 * Non-blocking: the response is the version's state as of the kick. Progress
 * and terminal outcomes arrive through `providers.list` →
 * `managedVersions.available[]`. A typed `ok: false` result is NOT an error -
 * it is a success response the panel draws on the version row, alongside the
 * row's own `error` / `unusable` install states.
 *
 * BOTH outcomes are owned here rather than per call. The panel lives inside an
 * unforced Radix popover, so closing the version menu mid-flight unmounts the
 * observer and TanStack drops anything passed to `mutate`. That silently lost a
 * thrown failure AND a typed refusal - the latter is the easier one to miss,
 * because it never touches `onError` at all. The panel keeps drawing refusals
 * inline while it is mounted; `versionManagerPanelIsMounted` stops both surfaces
 * firing at once.
 *
 * `panel` is the token of the panel making the request, captured at `onMutate`
 * so delivery asks about THAT panel rather than about panels in general. Pass
 * null from any caller with no inline surface of its own: the hook then owns
 * every outcome.
 */
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
        // Only cover the case the panel cannot: the panel that asked unmounted
        // mid-flight. Another pack's panel being open is not a substitute - it
        // has no row for this version and never made the request.
        if (versionManagerPanelIsMounted(context.panel)) return;
        toast.error(installPackVersionRefusalMessage(response.result.code));
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't download this version.");
      },
    },
  });
}

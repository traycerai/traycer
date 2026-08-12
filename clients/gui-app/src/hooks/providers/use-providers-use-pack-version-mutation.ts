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

/**
 * Pin a pack to a version, or clear the pin (`version: null` → auto).
 *
 * EVERY OUTCOME IS OWNED HERE, not per call. The panel lives in an unforced
 * popover, so closing the version menu unmounts the observer and TanStack drops
 * anything passed to `mutate`. That covers three kinds of outcome, and only the
 * first used to survive:
 *
 *  - a thrown transport/host failure → `onError` below;
 *  - a success → the confirmation toast below;
 *  - a typed refusal (`verification-failed`, `below-security-floor`,
 *    `host-ineligible`), which is a SUCCESSFUL response and so never reaches
 *    `onError` at all.
 *
 * The panel still draws a refusal inline - on the row, or in the header for a
 * cleared pin, which has no row - while it is mounted. `versionManagerPanelIsMounted`
 * is what keeps the two surfaces from both firing.
 *
 * `panel` is the token of the panel making the request, captured at `onMutate`
 * so delivery asks about THAT panel rather than about panels in general. Pass
 * null from any caller with no inline surface of its own: the hook then owns
 * every outcome.
 */
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
          // Report the pin the HOST ended up with, not the one we asked for.
          // The schema echoes `pinnedVersion` precisely so a caller that raced
          // another host sharing the pack store re-renders the truth instead of
          // its own optimistic guess - assuming `variables.version` won could
          // announce a version that is not actually pinned, or announce a clear
          // that another host has already replaced.
          //
          // Honest semantics: running sessions keep the binary they started
          // with. Toasted from HERE rather than per call, because the panel
          // that used to own this sentence unmounts with its popover.
          const pinned = response.result.pinnedVersion;
          toast.success(
            pinned === null
              ? "Pin cleared — new sessions follow automatic version selection"
              : `New sessions will use ${pinned}`,
          );
          return;
        }
        // A typed refusal is a SUCCESSFUL response, so `onError` never sees it.
        // The panel draws it inline - on the row, or in the header for a
        // cleared pin - whenever it is still mounted, which is better context
        // than a toast. This covers only the case it cannot: the popover that
        // asked closed mid-flight and took the per-call callback with it.
        // Another pack's panel being open is not a substitute - it never made
        // the request and has no row to anchor the refusal to.
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

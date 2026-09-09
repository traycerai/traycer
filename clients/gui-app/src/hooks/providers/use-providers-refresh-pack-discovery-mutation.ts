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
import { useHostMutationWithResponseTimeout } from "@/hooks/host/use-host-query";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { toast } from "sonner";
import { PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS } from "@/lib/host-rpc-policy/provider-pack-discovery-check-timeout";
import { refreshPackDiscoveryRefusalMessage } from "@/components/settings/panels/provider-pack-version-manager-model";
import type { VersionManagerPanelToken } from "@/components/settings/panels/provider-pack-version-manager-presence";
import { versionManagerPanelIsMounted } from "@/components/settings/panels/provider-pack-version-manager-presence";

type RefreshPackDiscoveryMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.refreshPackDiscovery">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.refreshPackDiscovery">,
  RefreshPackDiscoveryMutationContext
>;

interface RefreshPackDiscoveryMutationContext {
  readonly hostId: string | null;
  readonly panel: VersionManagerPanelToken | null;
}

/**
 * Run the host's pack-discovery poll for one pack NOW.
 *
 * A host learns that a pack has a new published version only from its own
 * discovery ticker, which re-arms one to two hours out; nothing else refreshes
 * the channel head. This is the on-demand version of that tick, so a user who
 * knows a version was just published does not have to wait out the period.
 *
 * `useHostMutationWithResponseTimeout`, NOT `useHostMutation`. The extended
 * budget lives in the caller, not in the policy table: the table row is only a
 * PERMISSION for this exact number, and a plain mutation would run the call on
 * the transport's 30s default no matter what the row says. The budget is real
 * work here - the host joins an in-flight tick rather than queueing behind it,
 * so one press can be waiting on the whole enabled set's serial poll (see
 * {@link PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS}).
 *
 * Outcomes and refusals are split on purpose:
 *
 * - `ok: true` gets NO toast. The outcome is a sentence about a surface the
 *   user is looking at, and the panel draws it in the footer beside the button
 *   that produced it. If the popover closed mid-flight there is nobody to tell
 *   and nothing was lost - the `providers.list` invalidation below still lands,
 *   so the banner and the version rows are refetched either way.
 * - `ok: false` is a typed refusal riding the SUCCESS path, so `onError` never
 *   sees it. The panel renders it inline while it is mounted; once the popover
 *   closes the panel cannot, and this hook toasts instead. `panel` is the token
 *   of the panel that made the request, captured at `onMutate`, so the question
 *   asked at delivery is about THAT panel rather than about panels in general -
 *   same mechanism as `useProvidersInstallPackVersion`.
 */
export function useProvidersRefreshPackDiscovery(
  panel: VersionManagerPanelToken | null,
): RefreshPackDiscoveryMutationResult {
  return useProvidersRefreshPackDiscoveryForClient(useHostClient(), panel);
}

export function useProvidersRefreshPackDiscoveryForClient(
  client: HostClient<HostRpcRegistry> | null,
  panel: VersionManagerPanelToken | null,
): RefreshPackDiscoveryMutationResult {
  const queryClient = useQueryClient();
  return useHostMutationWithResponseTimeout<
    HostRpcRegistry,
    "providers.refreshPackDiscovery",
    RefreshPackDiscoveryMutationContext
  >({
    client,
    method: "providers.refreshPackDiscovery",
    mapVariables: (variables) => variables,
    responseTimeoutMs: PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS,
    options: {
      mutationKey: providersMutationKeys.refreshPackDiscovery(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null, panel }),
      onSuccess: (response, _variables, context) => {
        // Unconditional, on every arm. A check that moved this host's
        // knowledge changes `updateAvailable` and the version rows, and
        // `unusable` CLEARS them; only `providers.list` carries either. The
        // two refusals ran no poll, so their refetch is strictly wasted - it
        // is folded in anyway because every sibling pack mutation invalidates
        // the same way, and one hook that skips it on a subset of its own
        // outcomes is a worse thing to maintain than one redundant read.
        if (context.hostId !== null) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(
              context.hostId,
              "providers.list",
            ),
          });
        }
        if (response.result.ok) return;
        if (versionManagerPanelIsMounted(context.panel)) return;
        toast.error(refreshPackDiscoveryRefusalMessage(response.result.code));
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't check for updates.");
      },
    },
  });
}

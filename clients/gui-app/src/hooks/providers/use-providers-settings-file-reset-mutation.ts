import type { UseMutationResult } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { providersMutationKeys } from "@/lib/query-keys";

// Every provider row comes back to its default at once, so everything a
// provider mutation refreshes is refreshed - the file status this reset
// changes among them (`PROVIDER_INVALIDATIONS` names it).
const RESET_INVALIDATIONS: ReadonlyArray<keyof HostRpcRegistry & string> =
  PROVIDER_INVALIDATIONS;

/**
 * Sets the scoped host's unusable provider settings document aside and starts
 * a fresh one. Only offered once the user has confirmed what it costs (see
 * `ProviderSettingsResetAction`).
 *
 * The host refuses with `outcome: "readable"` when the document can be read by
 * the time it acts - repaired meanwhile, or never more than one malformed row -
 * and the toast says so rather than claiming a reset that did not happen.
 */
export function useProvidersSettingsFileReset(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.settingsFile.reset">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.settingsFile.reset">,
  { readonly hostId: string | null }
> {
  const client = useHostClient();
  return useHostScopedMutationForClient(client, {
    method: "providers.settingsFile.reset",
    mutationKey: providersMutationKeys.resetSettingsFile(),
    errorMessage: "Couldn't reset provider settings.",
    invalidateMethods: RESET_INVALIDATIONS,
    onSuccess: (data) => {
      if (data.outcome === "readable") {
        toast.info(
          "Provider settings can be read again, so nothing was reset.",
        );
        return;
      }
      // A committed reset whose providers could not all be restarted is still
      // a reset: the file has moved and every query above is invalidated. The
      // user needs the set-aside name and the one thing left to do. "This
      // host", not "Traycer": the panel can be administering a remote host,
      // whose providers a restart of this app would not reach.
      if (data.providersNotRestarted.length > 0) {
        toast.warning(
          `Provider settings reset. The old file was kept as ${data.movedAsideFileName}. Restart this host to finish applying the new settings.`,
        );
        return;
      }
      toast.success(
        `Provider settings reset. The old file was kept as ${data.movedAsideFileName}.`,
      );
    },
  });
}

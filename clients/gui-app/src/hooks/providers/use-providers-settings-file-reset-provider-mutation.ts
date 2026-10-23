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

type ResetProviderResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.settingsFile.resetProvider"
>;

/** "The old file was kept as a, b." for every backup the call wrote, or "". */
function backupsSentence(backupFileNames: readonly string[]): string {
  if (backupFileNames.length === 0) return "";
  return ` A copy of the old file was kept as ${backupFileNames.join(", ")}.`;
}

/**
 * The toast for each answer. Every outcome names every backup the host wrote:
 * a backup holds the whole settings file, keys included, so none is left on
 * disk without the user being told its name.
 */
export function describeResetProviderOutcome(
  providerLabel: string,
  data: ResetProviderResponse,
): { readonly kind: "success" | "warning" | "info"; readonly text: string } {
  const backups = backupsSentence(data.backupFileNames);
  switch (data.outcome) {
    case "reset": {
      // `backupFileName` is the copy of what the host read before it wrote;
      // the extra names are an earlier attempt's copies.
      const others = data.backupFileNames.filter(
        (name) => name !== data.backupFileName,
      );
      const kept = `${providerLabel} settings reset. A copy of the old file was kept as ${data.backupFileName}${
        others.length > 0 ? ` (also ${others.join(", ")})` : ""
      }. Turn ${providerLabel} on and enter its key again.`;
      // "This host", not "Traycer": the panel can be administering a remote
      // host, whose providers a restart of this app would not reach.
      if (data.providersNotRestarted.length > 0) {
        return {
          kind: "warning",
          text: `${kept} Restart this host to finish applying the new settings.`,
        };
      }
      return { kind: "success", text: kept };
    }
    case "readable":
      return {
        kind: "info",
        text: `${providerLabel} settings can be read again, so nothing was reset.${backups}`,
      };
    case "document-unreadable":
      return {
        kind: "warning",
        text: `The whole provider settings file can't be used now, so ${providerLabel} was not reset on its own. Use Reset provider settings instead.${backups}`,
      };
    case "changed":
      return {
        kind: "warning",
        text: `The provider settings file kept changing, so nothing was reset. Try again.${backups}`,
      };
    case "failed":
      return {
        kind: "warning",
        text: `Couldn't reset ${providerLabel} settings, and nothing was changed.${backups}`,
      };
  }
}

/**
 * Copies the scoped host's provider settings file aside and drops ONE
 * provider's unreadable row, so that provider starts again from its defaults.
 * Only offered once the user has confirmed what it costs (see
 * `ProviderRowResetAction`).
 */
export function useProvidersSettingsFileResetProvider(
  providerLabel: string,
): UseMutationResult<
  ResetProviderResponse,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.settingsFile.resetProvider">,
  { readonly hostId: string | null }
> {
  const client = useHostClient();
  return useHostScopedMutationForClient(client, {
    method: "providers.settingsFile.resetProvider",
    mutationKey: providersMutationKeys.resetProviderSettings(),
    errorMessage: `Couldn't reset ${providerLabel} settings.`,
    // That provider's row came back to its defaults, so everything a provider
    // mutation refreshes is refreshed - the file status among them.
    invalidateMethods: PROVIDER_INVALIDATIONS,
    onSuccess: (data) => {
      const { kind, text } = describeResetProviderOutcome(providerLabel, data);
      if (kind === "success") toast.success(text);
      else if (kind === "warning") toast.warning(text);
      else toast.info(text);
    },
  });
}

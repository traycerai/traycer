import type { UseMutationResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { invalidateConfigurationReads } from "@/hooks/environment/environment-host-list-key";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { useExecutableWriteGrant } from "@/hooks/environment/use-executable-write-grant";
import { providersMutationKeys } from "@/lib/query-keys";

/**
 * "Add to Personal" on an MCP server or skill this host has and the person's
 * settings do not (`providers.nativeMutate@1.3`'s `promoteToPersonal`): the
 * entry is uploaded so every host gets it. Never sent without the click.
 * What it uploads can run on every host, so it carries the grant. A typed
 * refusal is an answer, not a transport error: the caller shows its detail
 * beside the button, and only a failed send toasts.
 */
export function useProvidersPromoteToPersonal(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.nativeMutate">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.nativeMutate">,
  { readonly hostId: string | null }
> {
  const grant = useExecutableWriteGrant();
  const queries = useQueryClient();
  return useHostScopedMutation({
    method: "providers.nativeMutate",
    prepareRequest: grant,
    mutationKey: providersMutationKeys.promoteToPersonal(),
    errorMessage: "Couldn't add it to Personal.",
    // The native lists (the row's mark) and the host's status (where the
    // item now applies) both change.
    invalidateMethods: ["providers.list", "environment.status"],
    // The entry joins the configuration, so the MCP servers and Skills pages'
    // lists move too, on every host that read them.
    onSuccess: (data, request) => {
      if (!data.result.ok || request.expectedEnvironmentId === null) return;
      invalidateConfigurationReads(queries, request.expectedEnvironmentId, [
        "environment.configuration.mcpServers.list",
        "environment.configuration.items",
        "environment.configuration.skills.list",
      ]);
    },
  });
}

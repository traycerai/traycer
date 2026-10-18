import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { toast } from "sonner";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { useExecutableWriteGrant } from "@/hooks/environment/use-executable-write-grant";
import { providersMutationKeys } from "@/lib/query-keys";

/**
 * "Add to Personal" on an MCP server or skill this host has and the person's
 * settings do not (`providers.nativeMutate@1.2`'s `promoteToPersonal`): the
 * entry is uploaded so every host gets it. Never sent without the click.
 * What it uploads can run on every host, so it carries the grant.
 */
export function useProvidersPromoteToPersonal(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.nativeMutate">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.nativeMutate">,
  { readonly hostId: string | null }
> {
  const grant = useExecutableWriteGrant();
  return useHostScopedMutation({
    method: "providers.nativeMutate",
    prepareRequest: grant,
    mutationKey: providersMutationKeys.promoteToPersonal(),
    errorMessage: "Couldn't add it to Personal.",
    // The native lists (the row's mark) and the host's status (where the
    // item now applies) both change.
    invalidateMethods: ["providers.list", "environment.status"],
    onSuccess: (data) => {
      // A typed native refusal is an answer, not a transport error.
      if (!data.result.ok) toast.error("Couldn't add it to Personal.");
    },
  });
}

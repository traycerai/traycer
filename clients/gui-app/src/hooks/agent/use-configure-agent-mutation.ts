import type { UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { agentMutationKeys } from "@/lib/query-keys";

const CONFIGURE_INVALIDATIONS: ReadonlyArray<keyof HostRpcRegistry & string> = [
  "agent.list",
];

/**
 * Changes an existing agent's run settings via `agent.configure`. The host
 * pushes the new record to every open view of the chat itself, so the caller
 * waits on the answer only to learn whether the host took it.
 * The caller supplies the client for the host that owns the agent.
 */
export function useAgentConfigure(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "agent.configure">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "agent.configure">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutationForClient(client, {
    method: "agent.configure",
    mutationKey: agentMutationKeys.configure(),
    errorMessage: "Couldn't change what this agent does on a usage limit.",
    invalidateMethods: CONFIGURE_INVALIDATIONS,
  });
}

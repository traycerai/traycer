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

// Invalidate the agent-list cache for the host that handled the stop.
// Scoping to the captured host id survives a mid-flight host swap.
const STOP_INVALIDATIONS: ReadonlyArray<keyof HostRpcRegistry & string> = [
  "agent.list",
];

/**
 * Stops an agent via `agent.stop`. `cascade: true` also stops the agent's
 * active descendants (the subtree it delegated to); `false` stops just the
 * addressed agent. The host aborts a GUI turn or interrupts a TUI CLI
 * (Ctrl+C, tab kept alive) by surface, and clears the agent's in-flight
 * inter-agent traffic so the subtree can't revive itself. Stopping is not
 * terminal - a later message wakes any stopped agent normally.
 * `data.stoppedAgentIds` reports the ids that actually had work to stop.
 * The caller supplies the client for the host that owns the agent.
 */
export function useAgentStop(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "agent.stop">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "agent.stop">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutationForClient(client, {
    method: "agent.stop",
    mutationKey: agentMutationKeys.stop(),
    errorMessage: "Couldn't stop agent.",
    invalidateMethods: STOP_INVALIDATIONS,
  });
}

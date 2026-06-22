import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { agentMutationKeys } from "@/lib/query-keys";

// A stop changes which agents are running, so refresh the agent list (the
// Active Agents panel + TUI dropdown read it) for the host that handled the
// stop. Scoping to the captured host id survives a mid-flight host swap.
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
 */
export function useAgentStop(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "agent.stop">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "agent.stop">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "agent.stop",
    mutationKey: agentMutationKeys.stop(),
    errorMessage: "Couldn't stop agent.",
    invalidateMethods: STOP_INVALIDATIONS,
  });
}

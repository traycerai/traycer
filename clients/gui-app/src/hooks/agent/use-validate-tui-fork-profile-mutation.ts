import type { UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostMutation } from "@/hooks/host/use-host-query";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { agentMutationKeys } from "@/lib/query-keys";
import { VALIDATE_TUI_FORK_PROFILE_METHOD } from "@/hooks/agent/use-tui-fork-profile-support";

/**
 * Read-only cross-profile fork-admission preflight - the optional
 * (non-floor) `agent.tui.validateForkProfile` RPC (tech plan governing
 * mechanism 2). Callers MUST gate on
 * `useHostSupportsMethod(hostId, "agent.tui.validateForkProfile")` before
 * invoking this - an old host that lacks the method rejects the call with
 * `E_HOST_UNSUPPORTED` rather than silently degrading. Its negotiated
 * presence IS the capability signal; there is no separate flag.
 *
 * Advisory only: `agent.tui.prepareLaunch` re-runs the same guard
 * authoritatively at the top of its own resolver (TOCTOU-safe). No `onError`
 * toast here - this is consumed inline by the fork flow
 * (`use-create-tui-agent.ts`), which surfaces its own rejection messaging
 * rather than a generic host-error toast.
 */
export function useValidateTuiForkProfile(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "agent.tui.validateForkProfile">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "agent.tui.validateForkProfile">
> {
  return useHostMutation({
    client,
    method: VALIDATE_TUI_FORK_PROFILE_METHOD,
    options: {
      mutationKey: agentMutationKeys.validateForkProfile(),
    },
    mapVariables: (variables) => variables,
  });
}

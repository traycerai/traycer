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
 * Callers must gate on `useHostSupportsMethod` for `agent.tui.validateForkProfile`; an old host rejects rather than degrading. Advisory: `prepareLaunch` re-runs the guard; no toast here.
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

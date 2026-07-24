import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { providersMutationKeys } from "@/lib/query-keys";

// Saving launch args only changes the value echoed back in `providers.list`
// (the Settings field + the picker pre-fill). It can't flip a provider's
// availability, so - unlike the other provider mutations - it does not refresh
// the GUI/TUI harness selectors.
const TERMINAL_AGENT_ARGS_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = ["providers.list"];

export function useProvidersSetTerminalAgentArgs(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setTerminalAgentArgs">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.setTerminalAgentArgs">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "providers.setTerminalAgentArgs",
    mutationKey: providersMutationKeys.setTerminalAgentArgs(),
    errorMessage: "Couldn't save Terminal interface CLI arguments.",
    invalidateMethods: TERMINAL_AGENT_ARGS_INVALIDATIONS,
  });
}

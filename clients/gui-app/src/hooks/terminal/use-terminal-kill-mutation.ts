import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import {
  useTerminalKillFor,
  type KillTerminalMutationContext,
} from "@/hooks/terminal/use-terminal-kill-for-mutation";

/**
 * Kills a terminal session on the app-wide active host. Default-host
 * convenience wrapper over `useTerminalKillFor`; tab-scoped callers pass their
 * own client to that hook instead.
 */
export function useTerminalKill(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "terminal.kill">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "terminal.kill">,
  KillTerminalMutationContext
> {
  return useTerminalKillFor(
    useHostClient(),
    "Couldn't close the terminal.",
    true,
  );
}

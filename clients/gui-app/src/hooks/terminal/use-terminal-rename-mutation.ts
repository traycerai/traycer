import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import {
  useTerminalRenameFor,
  type RenameTerminalMutationContext,
} from "@/hooks/terminal/use-terminal-rename-for-mutation";

/**
 * Renames a terminal session on the app-wide active host. Default-host
 * convenience wrapper over `useTerminalRenameFor`; tab-scoped callers pass
 * their own client to that hook instead.
 */
export function useTerminalRename(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "terminal.rename">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "terminal.rename">,
  RenameTerminalMutationContext
> {
  return useTerminalRenameFor(useHostClient());
}

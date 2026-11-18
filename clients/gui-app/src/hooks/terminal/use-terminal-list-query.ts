import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useTerminalListFor } from "@/hooks/terminal/use-terminal-list-for-query";
import type { TerminalScope } from "@traycer/protocol/host/terminal/unary-schemas";

/**
 * Fetches the active host's current terminal sessions for the given scope so
 * the tile-mount reattach algorithm can decide between (a) subscribing to a
 * still-live session - the host then streams its rolling scrollback as part
 * of the initial snapshot - and (b) creating a fresh PTY.
 *
 * Default-host convenience wrapper over `useTerminalListFor`; tab-scoped
 * callers pass their own client to that hook instead.
 */
export function useTerminalList(
  scope: TerminalScope,
  client: HostClient<HostRpcRegistry> | null,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "terminal.list">,
  HostRpcError
> {
  return useTerminalListFor(client, scope);
}

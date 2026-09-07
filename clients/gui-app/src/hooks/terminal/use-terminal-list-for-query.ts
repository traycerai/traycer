import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { TerminalScope } from "@traycer/protocol/host/terminal/unary-schemas";

/**
 * `terminal.list` on the explicit bound client. Null client disables the query so liveness stays optimistic until the first response.
 */
export function useTerminalListFor(
  client: HostClient<HostRpcRegistry> | null,
  scope: TerminalScope,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "terminal.list">,
  HostRpcError
> {
  return useHostQuery<HostRpcRegistry, "terminal.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "terminal.list",
    // `useHostQuery` includes request params in its query key. The
    // discriminated scope therefore makes independent and epic lists stable,
    // distinct cache entries without a parallel GUI-only key shape.
    params: { scope },
    options: null,
  });
}

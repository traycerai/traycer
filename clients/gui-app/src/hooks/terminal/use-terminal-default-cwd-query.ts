import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

export function useTerminalDefaultCwd(args: {
  readonly epicId: string;
  readonly enabled: boolean;
}): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "terminal.defaultCwd">,
  HostRpcError
> {
  const client = useHostClient();
  return useHostQuery<HostRpcRegistry, "terminal.defaultCwd">({
    client,
    method: "terminal.defaultCwd",
    params: { epicId: args.epicId },
    cacheKeyIdentity: [args.epicId],
    options: { enabled: args.enabled, staleTime: Number.POSITIVE_INFINITY },
  });
}

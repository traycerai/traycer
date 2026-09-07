import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/**
 * Disabled until the candidate path is non-empty so we do not spawn `--version` on every keystroke. Callers should debounce the path.
 */
export function useProvidersDetectVersion(args: {
  readonly candidatePath: string;
  readonly enabled: boolean;
}): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "providers.detectVersion">,
  HostRpcError
> {
  const client = useHostClient();
  return useHostQuery<HostRpcRegistry, "providers.detectVersion">({
    cacheKeyIdentity: undefined,
    client,
    method: "providers.detectVersion",
    params: { candidatePath: args.candidatePath },
    options: { enabled: args.enabled && args.candidatePath.length > 0 },
  });
}

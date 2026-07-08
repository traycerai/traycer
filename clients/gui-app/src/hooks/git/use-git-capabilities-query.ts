import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/**
 * Hook for probing git.getCapabilities on a running directory.
 * Per CONTEXT.md and ADR-0007 (Q5 lock), returns { available, gitVersion, reason, repoMode? }.
 * Caches for 5 minutes with no retries - capability failures are stable.
 */
export function useGitCapabilitiesQuery(args: {
  readonly hostId: string | null;
  readonly runningDir: string;
  readonly enabled: boolean;
}): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "git.getCapabilities">,
  HostRpcError
> {
  const client = useHostClient();
  return useHostQuery<HostRpcRegistry, "git.getCapabilities">({
    cacheKeyIdentity: undefined,
    client,
    method: "git.getCapabilities",
    params: {
      hostId: args.hostId ?? "",
      runningDir: args.runningDir,
      ignoreWhitespace: false,
    },
    options: {
      enabled: args.enabled && args.hostId !== null,
      staleTime: 5 * 60 * 1000,
      retry: false,
      gcTime: 30 * 60 * 1000,
    },
  });
}

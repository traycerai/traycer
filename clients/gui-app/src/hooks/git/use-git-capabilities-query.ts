import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
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
  // Resolved FROM `args.hostId`, never from the app-wide host. Both callers
  // are host-pinned surfaces (the git panel and its capability gate) and pass
  // their surface's resolved host, and `hostId` in the params below does NOT
  // route the call - `HostClient.request()` sends through the client's own
  // bound messenger, so an ambient client asked host A whether host B has git
  // and cached the answer under B. The `...WithSubmodules` hook beside this one
  // already resolved its client this way; this is that pattern, not a new one.
  const client = useHostClientForHostId(args.hostId);
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

import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useHostClient } from "@/lib/host";
import type { RateLimitQueueConfig } from "@/lib/rate-limits/ephemeral-fetch-queue";

/**
 * Captures the host runtime currently provided to this subtree as an explicit
 * queue scope. In Settings this is the host selected by its host picker (the
 * panel re-provides `HostRuntimeContext` with a transient client); elsewhere it
 * is the app-wide default host. The query client is shared, while `hostId`
 * keeps each host's cache entry distinct.
 */
export function useRateLimitQueueScope(): RateLimitQueueConfig | null {
  const client = useHostClient();
  const hostId = useReactiveActiveHostId();
  const queryClient = useQueryClient();

  return useMemo(() => {
    if (hostId === null) return null;
    return {
      hostId,
      queryClient,
      request: (_hostId, method, params) => client.request(method, params),
    };
  }, [client, hostId, queryClient]);
}

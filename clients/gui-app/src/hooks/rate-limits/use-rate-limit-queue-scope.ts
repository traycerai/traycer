import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import type { RateLimitQueueConfig } from "@/lib/rate-limits/ephemeral-fetch-queue";

/**
 * Captures the host runtime currently provided to this subtree as an explicit
 * queue scope. In Settings this is the host selected by its host picker (the
 * panel re-provides `HostRuntimeContext` with a transient client); elsewhere it
 * is the app-wide default host. The query client is shared, while `hostId`
 * keeps each host's cache entry distinct.
 *
 * The client is resolved through `useHostClientForHostId` (a requester PINNED
 * to `hostId`), not the mutable app-wide `useHostClient()`. A queued pull can
 * sit in the shared lane for as long as its response budget allows, and the
 * bare default client re-points the moment the user switches hosts - so an
 * item enqueued for host A would have gone on to fetch from host B while still
 * writing the answer under A's cache key, showing one machine's usage on
 * another's row. Pinning also matches `useRunTargetHost`, which already
 * resolves its scope this way. A `hostId` that no longer resolves yields a
 * `null` scope, which every enqueue entry point already treats as a no-op.
 */
export function useRateLimitQueueScope(): RateLimitQueueConfig | null {
  const hostId = useReactiveActiveHostId();
  const client = useHostClientForHostId(hostId);
  const queryClient = useQueryClient();

  return useMemo(() => {
    if (hostId === null || client === null) return null;
    return {
      hostId,
      queryClient,
      request: (_hostId, method, params, responseTimeoutMs) =>
        client.requestWithResponseTimeout(method, params, responseTimeoutMs),
    };
  }, [client, hostId, queryClient]);
}

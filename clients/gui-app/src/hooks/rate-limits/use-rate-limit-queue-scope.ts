import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostClient } from "@/lib/host";
import type { RateLimitQueueConfig } from "@/lib/rate-limits/ephemeral-fetch-queue";

/**
 * Captures the host runtime currently provided to this subtree as an explicit
 * queue scope. In Settings this is the host selected by its host picker (the
 * panel re-provides `HostRuntimeContext` with a transient client); elsewhere it
 * is the app-wide default host. The query client is shared, while `hostId`
 * keeps each host's cache entry distinct.
 *
 * A queued pull can sit in the shared lane for as long as its response budget
 * allows, so "which host does this client address" has to stay fixed for the
 * whole wait: an item enqueued for host A that re-aimed mid-flight would fetch
 * host B and still write the answer under A's cache key, showing one machine's
 * usage on another's row. `useHostClient()` already guarantees that - it hands
 * back a requester PINNED to the host it resolved (redesign D17 / P2.1), and a
 * call already aimed at the outgoing host completes against it - so this scope
 * deliberately does NOT re-pin through `useHostClientForHostId`. Doing so would
 * also resolve a directory client and discard the pinned client a host-scoped
 * panel re-provides, which is the one thing `useHostClient()` gets right here.
 *
 * `responseTimeoutMs` is threaded per call rather than taken from the client's
 * default frame timeout: an `ephemeralProcess` read spawns a provider CLI and
 * legitimately outruns the default budget, and the queue owns that number.
 */
export function useRateLimitQueueScope(): RateLimitQueueConfig | null {
  const client = useHostClient();
  const hostId = useAddressableHostId();
  const queryClient = useQueryClient();

  return useMemo(() => {
    if (hostId === null) return null;
    return {
      hostId,
      queryClient,
      request: (_hostId, method, params, responseTimeoutMs) =>
        client.requestWithResponseTimeout(method, params, responseTimeoutMs),
    };
  }, [client, hostId, queryClient]);
}

import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostClient } from "@/lib/host";
import type { RateLimitQueueConfig } from "@/lib/rate-limits/ephemeral-fetch-queue";

/** Use the subtree's useHostClient(), not useHostClientForHostId (that would drop a scoped panel's pinned client). Thread responseTimeoutMs per call. */
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

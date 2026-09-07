import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import type { HostRpcRegistry } from "@/lib/host";
import type { RateLimitQueueConfig } from "@/lib/rate-limits/ephemeral-fetch-queue";

/**
 * Observe the host that will run the next turn, never the app-wide default. `hostId`/`isReady` and `queueScope` close over the same client so they cannot disagree.
 */
export interface RunTargetHost {
  readonly hostId: string | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly isReady: boolean;
  readonly queueScope: RateLimitQueueConfig | null;
}

/** Resolves the explicit run-target host - a tab's lifetime-bound host id, or `null` for the app-wide default host - to the client/readiness/queue-scope trio every profile-usage-comparison hook needs, all derived from the SAME `useHostClientForHostId` resolution so they can never disagree about which host is being observed. */
export function useRunTargetHost(
  runTargetHostId: string | null,
): RunTargetHost {
  const client = useHostClientForHostId(runTargetHostId);
  const readiness = useReactiveHostReadiness(client);
  const queryClient = useQueryClient();

  const queueScope = useMemo<RateLimitQueueConfig | null>(() => {
    if (client === null || !readiness.isReady || readiness.hostId === null) {
      return null;
    }
    const hostId = readiness.hostId;
    return {
      hostId,
      queryClient,
      request: (_hostId, method, params, responseTimeoutMs) =>
        client.requestWithResponseTimeout(method, params, responseTimeoutMs),
    };
  }, [client, readiness.hostId, readiness.isReady, queryClient]);

  return {
    hostId: readiness.hostId,
    client,
    isReady: readiness.isReady,
    queueScope,
  };
}

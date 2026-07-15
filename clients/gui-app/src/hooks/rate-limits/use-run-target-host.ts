import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import type { HostRpcRegistry } from "@/lib/host";
import type { RateLimitQueueConfig } from "@/lib/rate-limits/ephemeral-fetch-queue";

/**
 * The host scope one profile-usage-comparison consumer (the model picker's
 * profile selector) needs to observe and refresh rate-limit data for the host
 * that will actually execute the next run - never the app-wide default host
 * substituted in its place.
 *
 * - `hostId`/`isReady` come from `useReactiveHostReadiness` bound to the
 *   SAME client `queueScope` closes over, so a query key built from `hostId`
 *   and an enqueue routed through `queueScope` always agree on which host
 *   they target, even while the client is still resolving (both read `null`
 *   until the same client reports ready).
 * - `queueScope` is `null` whenever `client` is `null` or not yet ready - the
 *   same "no scope, no enqueue" contract `enqueueRateLimitFetchForScope`
 *   already treats as a safe no-op, so a caller can enqueue unconditionally
 *   without its own readiness gate.
 */
export interface RunTargetHost {
  readonly hostId: string | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly isReady: boolean;
  readonly queueScope: RateLimitQueueConfig | null;
}

/**
 * Resolves the explicit run-target host - a tab's lifetime-bound host id, or
 * `null` for the app-wide default host - to the client/readiness/queue-scope
 * trio every profile-usage-comparison hook needs, all derived from the SAME
 * `useHostClientForHostId` resolution so they can never disagree about which
 * host is being observed. `useHostClientForHostId` never substitutes the
 * default host for a non-null `runTargetHostId`, so an unreachable tab host
 * resolves to a `null` client (and therefore a `null` queueScope and
 * `isReady: false`) rather than silently falling back.
 */
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
      request: (_hostId, method, params) => client.request(method, params),
    };
  }, [client, readiness.hostId, readiness.isReady, queryClient]);

  return {
    hostId: readiness.hostId,
    client,
    isReady: readiness.isReady,
    queueScope,
  };
}

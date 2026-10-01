import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import type { HostRpcRegistry } from "@/lib/host";
import type { ProviderRateLimitFetchScope } from "@/lib/rate-limits/provider-rate-limit-fetch";

/**
 * The host scope one profile-usage-comparison consumer (the model picker's
 * profile selector) needs to observe and refresh rate-limit data for the host
 * that will actually execute the next run - never the app-wide default host
 * substituted in its place.
 *
 * - `hostId`/`isReady` come from `useReactiveHostReadiness` bound to the
 *   SAME client `fetchScope` closes over, so a query key built from `hostId`
 *   and a fetch routed through `fetchScope` always agree on which host they
 *   target, even while the client is still resolving (both read `null` until
 *   the same client reports ready).
 * - `fetchScope` is `null` whenever `client` is `null` or not yet ready - the
 *   same "no scope, no request" contract `fetchProviderRateLimits` already
 *   treats as a safe no-op, so a caller can fetch unconditionally without its
 *   own readiness gate.
 */
export interface RunTargetHost {
  readonly hostId: string | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly isReady: boolean;
  readonly fetchScope: ProviderRateLimitFetchScope | null;
}

/**
 * Resolves the explicit run-target host - a tab's lifetime-bound host id, or
 * `null` for the app-wide default host - to the client/readiness/fetch-scope
 * trio every profile-usage-comparison hook needs, all derived from the SAME
 * `useHostClientForHostId` resolution so they can never disagree about which
 * host is being observed. `useHostClientForHostId` never substitutes the
 * default host for a non-null `runTargetHostId`: an unresolved tab host keeps
 * an identity requester, but has no ready fetch scope until its row appears.
 */
export function useRunTargetHost(
  runTargetHostId: string | null,
): RunTargetHost {
  const client = useHostClientForHostId(runTargetHostId);
  const readiness = useReactiveHostReadiness(client);
  const queryClient = useQueryClient();

  const fetchScope = useMemo<ProviderRateLimitFetchScope | null>(() => {
    if (client === null || !readiness.isReady || readiness.hostId === null) {
      return null;
    }
    const hostId = readiness.hostId;
    return {
      hostId,
      queryClient,
      request: (method, params, responseTimeoutMs) =>
        client.requestWithResponseTimeout(method, params, responseTimeoutMs),
    };
  }, [client, readiness.hostId, readiness.isReady, queryClient]);

  return {
    hostId: readiness.hostId,
    client,
    isReady: readiness.isReady,
    fetchScope,
  };
}

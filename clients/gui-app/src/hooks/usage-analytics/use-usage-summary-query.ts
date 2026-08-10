import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { getViewerTimeZone } from "@/lib/usage-analytics/viewer-timezone";

export type UsageSummaryWindowDays = 7 | 30 | 90;

export type UsageSummaryRequest = RequestOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;
export type UsageSummaryResponse = ResponseOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;

/**
 * Builds the `host.usage.summary` request from the two dimensions the UI
 * actually varies (window length, epic filter) - the IANA zone is always the
 * viewer's own, read fresh so a request built after a system timezone change
 * (or DST boundary) never sends a stale value.
 */
export function buildUsageSummaryRequest(input: {
  readonly windowDays: UsageSummaryWindowDays;
  readonly epicId: string | null;
}): UsageSummaryRequest {
  return {
    timezone: getViewerTimeZone(),
    windowDays: input.windowDays,
    epicId: input.epicId,
  };
}

/** App-wide caller (the Usage page) - reads the ambient active-host client. */
export function useUsageSummary(
  request: UsageSummaryRequest,
): UseQueryResult<UsageSummaryResponse, HostRpcError> {
  return useUsageSummaryForClient(useHostClient(), request);
}

/**
 * Tab/scope-bound caller (the epic cost badge, or a Settings host-scoped
 * panel) - takes an explicit client so the query never reads the ambient
 * active host from inside a surface bound to a different one.
 */
export function useUsageSummaryForClient(
  client: HostClient<HostRpcRegistry> | null,
  request: UsageSummaryRequest,
): UseQueryResult<UsageSummaryResponse, HostRpcError> {
  return useHostQuery<HostRpcRegistry, "host.usage.summary">({
    cacheKeyIdentity: undefined,
    client,
    method: "host.usage.summary",
    params: request,
    options: null,
  });
}

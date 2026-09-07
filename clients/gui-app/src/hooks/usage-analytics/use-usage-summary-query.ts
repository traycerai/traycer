import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { getViewerTimeZone } from "@/lib/usage-analytics/viewer-timezone";

/** The window picker offers 7/30/90; 365 is the activity heatmap's fixed year window (ticket 15), never a picker option.
 * The wire itself accepts any positive integer (`windowDays: z.number().int().positive()`), so this union is a GUI discipline, not a protocol bound. */
export type UsageSummaryWindowDays = 7 | 30 | 90 | 365;

export type UsageSummaryRequest = RequestOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;
export type UsageSummaryResponse = ResponseOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;

export function buildUsageSummaryRequest(input: {
  readonly windowDays: UsageSummaryWindowDays;
  readonly epicId: string | null;
  /** Ticket 10 addition. Chat implies its epic - `epicId` need not also be set. */
  readonly chatId?: string | null;
  /** `"epic"` bounds the read to the epic/chat's own fact span instead of `windowDays` - only valid alongside a non-null `epicId` or `chatId`. */
  readonly window?: "epic";
  /** `null`/absent = every host on the account - the global dashboard's "All hosts" default. */
  readonly hostId?: string | null;
}): UsageSummaryRequest {
  return {
    timezone: getViewerTimeZone(),
    windowDays: input.windowDays,
    epicId: input.epicId,
    chatId: input.chatId ?? undefined,
    hostId: input.hostId ?? undefined,
    window: input.window,
  };
}

/** Pass the real client and gate with enabled; nulling the client changes the cache key. Never read the ambient host here. */
export function useUsageSummaryForClient(
  client: HostClient<HostRpcRegistry> | null,
  request: UsageSummaryRequest,
  enabled: boolean,
  poll: boolean,
): UseQueryResult<UsageSummaryResponse, HostRpcError> {
  return useHostQuery<HostRpcRegistry, "host.usage.summary">({
    cacheKeyIdentity: undefined,
    client,
    method: "host.usage.summary",
    params: request,
    options: { enabled, poll },
  });
}

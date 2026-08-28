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

/**
 * The window picker offers 7/30/90; 365 is the activity heatmap's fixed
 * year window (ticket 15), never a picker option. The wire itself accepts
 * any positive integer (`windowDays: z.number().int().positive()`), so this
 * union is a GUI discipline, not a protocol bound.
 */
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
  /**
   * Ticket 10 addition. `"epic"` bounds the read to the epic/chat's own fact
   * span instead of `windowDays` - only valid alongside a non-null `epicId`
   * or `chatId`. `windowDays` is still sent unconditionally (the request
   * schema requires it either way) even though the host ignores it for this
   * window kind.
   */
  readonly window?: "epic";
  /**
   * Ticket 13 addition. `null`/absent = every host on the account - the
   * global dashboard's "All hosts" default. Only the dashboard sets it; the
   * epic- and chat-scoped dialogs leave it alone, because at those scopes
   * the host dimension answers a question nobody asked (an epic's work is
   * an epic's work wherever it ran).
   */
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

/**
 * The one caller of `host.usage.summary` - takes an explicit client (never
 * reads the ambient active host itself, so callers stay correct whether they
 * are host-scoped or app-wide) plus an explicit `enabled`/`poll` pair rather
 * than folding `enabled` into `client` (passing `null` when the caller's own
 * gate is false).
 *
 * That "null the client instead of the query" shape looks equivalent but
 * is not: `useHostQuery`'s cache key is partly built from the bound client's
 * resolved host id, so nulling the client on every falsy-gate render changes
 * the query's IDENTITY, not just whether it runs - the first REAL fetch (once
 * the gate flips true) starts on a brand-new query with no history, in
 * whatever moment that happens to be, with no periodic self-heal if that
 * fetch is ever silently reverted by an in-flight host-identity transition
 * (`HostClient.setRequestContext`/`bind`, see `host-client.ts`). Passing the
 * real client unconditionally and gating through `enabled` keeps one stable
 * query across the gate flipping, and `poll` gives ambient (not
 * actively-supervised) callers like the epic cost badge a bounded interval to
 * self-heal from exactly that race instead of staying stuck pending forever.
 */
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

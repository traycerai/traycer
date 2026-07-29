import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { subscribeChatTurnCompletions } from "@/lib/chats/chat-turn-completions";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { queryKeys } from "@/lib/query-keys";
import {
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  rateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";
import { useRateLimitQueueScope } from "@/hooks/rate-limits/use-rate-limit-queue-scope";
import { enqueueRateLimitFetchForScope } from "@/lib/rate-limits/ephemeral-fetch-queue";

/**
 * While mounted, refreshes `host.getRateLimitUsage` for the current host scope
 * whenever a chat turn on `providerId`'s harness completes - the provider-pull
 * analog of `useRefreshRateLimitUsageOnTraycerTurn`. Branches on the provider's
 * fetch lane:
 *
 * - `ephemeralProcess` (codex, claude-code): enqueues onto the shared serial
 *   queue (`enqueueRateLimitFetch(..., { force: false })`) rather than
 *   invalidating directly, so a turn completion can't race a scheduled interval
 *   tick into two overlapping subprocess spawns. This enqueue is deliberately
 *   NOT gated by window visibility - only the interval timer pauses when hidden;
 *   a background turn finishing while the user is away must still update data.
 * - `httpFetch` (openrouter, kilocode): invalidates the query directly (no
 *   subprocess to bound), exactly as before.
 *
 * Unlike the aperture refresh hook, this uses the current `HostRuntimeContext`
 * scope so Settings-selected and future tab-scoped consumers target the same
 * host in both fetch lanes.
 *
 * Targets the exact `{ accountContext, providerId, profileId }` params key
 * (the same one `useHostProviderRateLimitsQuery` builds), NOT the whole
 * `host.getRateLimitUsage` method scope: a method-scope invalidation would
 * also refetch the aperture query and every OTHER provider's query on this
 * host, so e.g. a Codex turn completing would spawn a `claude` subprocess to
 * refresh Claude's rate limits too, for data a Codex turn can't have changed.
 *
 * Both paths are throttled by an outer cooldown ref to at most once per
 * `PROVIDER_RATE_LIMITS_STALE_TIME_MS` (a persistent, always-mounted surface
 * would otherwise refresh on every single matching turn completion); for the
 * queue path the queue's own five-minute freshness floor is a second, independent layer
 * under this ref.
 *
 * No-ops while `providerId` is `null` (surface isn't gated to a rate-limit
 * -capable provider).
 */
export function useRefreshProviderRateLimitsOnTurn(
  providerId: RateLimitProviderId | null,
  profileId: string | null,
  fetchEligible: boolean,
): void {
  const queryClient = useQueryClient();
  const queueScope = useRateLimitQueueScope();
  const lastInvalidatedAtRef = useRef(0);

  useEffect(() => {
    // Reset the cooldown whenever this effect re-runs for a new host scope/
    // providerId/profileId tuple - otherwise a selection switch on the same mounted
    // component (e.g. the chat's selected harness changes) inherits the
    // previous provider's cooldown timestamp and can skip its own first,
    // otherwise-due invalidation.
    lastInvalidatedAtRef.current = 0;
    if (providerId === null || !fetchEligible) return;
    const harnessId = providerIdToGuiHarnessId(providerId);
    return subscribeChatTurnCompletions((completion) => {
      if (completion.harnessId !== harnessId) return;
      const now = Date.now();
      if (
        now - lastInvalidatedAtRef.current <
        PROVIDER_RATE_LIMITS_STALE_TIME_MS
      ) {
        return;
      }
      lastInvalidatedAtRef.current = now;
      // ephemeralProcess providers (codex, claude-code) route through the shared
      // serial queue so this turn-completion refresh can't spawn a subprocess
      // that overlaps a scheduled interval tick. The queue's own five-minute floor is a
      // second, independent layer under this hook's outer cooldown ref. Crucially
      // this fires regardless of window visibility - only the interval timer
      // pauses when hidden, so a background turn finishing while the user is away
      // still updates that provider's data.
      if (rateLimitFetchLane(providerId) === "ephemeralProcess") {
        void enqueueRateLimitFetchForScope(
          queueScope,
          providerId,
          DEFAULT_ACCOUNT_CONTEXT,
          {
            force: false,
            profileId,
          },
        );
        return;
      }
      // httpFetch providers (openrouter, kilocode) never touch the queue - a
      // plain credential GET has no subprocess to bound, so invalidate directly.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.hostMethod<
          HostRpcRegistry,
          "host.getRateLimitUsage"
        >(queueScope?.hostId ?? null, "host.getRateLimitUsage", {
          accountContext: DEFAULT_ACCOUNT_CONTEXT,
          providerId,
          profileId,
        }),
      });
    });
  }, [fetchEligible, queryClient, profileId, providerId, queueScope]);
}

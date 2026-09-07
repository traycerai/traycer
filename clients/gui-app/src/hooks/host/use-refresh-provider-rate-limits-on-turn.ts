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

/** Refresh this provider's params key on turn complete, not the whole host.getRateLimitUsage method scope.
 * ephemeralProcess enqueues even while hidden; httpFetch invalidates. */
export function useRefreshProviderRateLimitsOnTurn(
  providerId: RateLimitProviderId | null,
  profileId: string | null,
  fetchEligible: boolean,
): void {
  const queryClient = useQueryClient();
  const queueScope = useRateLimitQueueScope();
  const lastInvalidatedAtRef = useRef(0);

  useEffect(() => {
    // Reset the cooldown whenever this effect re-runs for a new host scope/ providerId/profileId tuple - otherwise a selection switch on the same mounted component (e.g.
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
      // ephemeralProcess providers (codex, claude-code) route through the shared serial queue so this turn-completion refresh can't spawn a subprocess that overlaps a scheduled interval tick.
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
      // httpFetch providers never touch the queue - a plain credential GET has
      // no subprocess to bound, so invalidate directly.
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

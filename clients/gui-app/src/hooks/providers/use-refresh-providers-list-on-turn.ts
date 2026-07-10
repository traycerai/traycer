import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { subscribeChatTurnCompletions } from "@/lib/notifications/chat-turn-completion";
import { queryKeys } from "@/lib/query-keys";
import { PROVIDER_RATE_LIMITS_STALE_TIME_MS } from "@/lib/rate-limit-providers";

/**
 * While mounted, invalidates the tab-scoped `providers.list` query (`hostId`)
 * whenever a chat turn on `harnessId` completes - the `providers.list` analog
 * of `useRefreshProviderRateLimitsOnTurn`. Closes the gap where the rate-limit
 * switch-prompt banner (`useProfileRateLimitSwitchPrompt`, which reads
 * `providers.list`) could lag the header popover's own `host.getRateLimitUsage`
 * read by up to `providers.list`'s 15-minute steady-state `staleTime`: a turn
 * that just pushed the composer's profile into `near_limit`/`hard_limit`
 * (passively captured on the host's rate-limit gauge - see
 * `rate-limit-gauge-cache.ts`) now surfaces the banner within seconds of turn
 * end instead of waiting for the next unrelated `providers.list` refetch.
 *
 * `providers.list` is a cheap cache-only host read (no subprocess spawn, no
 * `host.getRateLimitUsage` account probe), so unlike
 * `useRefreshProviderRateLimitsOnTurn` this always invalidates directly -
 * there is no ephemeral-process serial queue to route through. The outer
 * cooldown ref still bounds a burst of turn completions on the same harness to
 * at most one invalidation per `PROVIDER_RATE_LIMITS_STALE_TIME_MS`.
 *
 * No-ops while `harnessId` is `null` (no harness selected yet).
 */
export function useRefreshProvidersListOnTurn(
  harnessId: GuiHarnessId | null,
  hostId: string | null,
): void {
  const queryClient = useQueryClient();
  const lastInvalidatedAtRef = useRef(0);

  useEffect(() => {
    // Reset the cooldown whenever this effect re-runs for a new harness/host
    // pair - otherwise switching harnesses on the same mounted composer
    // inherits the previous harness's cooldown timestamp and can skip its own
    // first, otherwise-due invalidation.
    lastInvalidatedAtRef.current = 0;
    if (harnessId === null) return;
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
      void queryClient.invalidateQueries({
        queryKey: queryKeys.hostMethod<HostRpcRegistry, "providers.list">(
          hostId,
          "providers.list",
          {},
        ),
      });
    });
  }, [queryClient, hostId, harnessId]);
}

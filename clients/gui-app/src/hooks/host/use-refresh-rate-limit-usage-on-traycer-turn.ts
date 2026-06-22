import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeChatTurnCompletions } from "@/lib/notifications/chat-turn-completion";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { queryKeys } from "@/lib/query-keys";

/**
 * While mounted, invalidates the default host's artifact rate-limit usage query
 * whenever a Traycer-harness chat turn completes - the same
 * `subscribeChatTurnCompletions` trigger the credit refresh uses, so the
 * usage bar moves in step with credits.
 *
 * Mounted by `RateLimitView` (rate-limit tiers only), mirroring
 * `useRefreshCreditsOnTraycerTurn`.
 */
export function useRefreshRateLimitUsageOnTraycerTurn(): void {
  const queryClient = useQueryClient();
  const hostId = useReactiveActiveHostId();

  useEffect(() => {
    return subscribeChatTurnCompletions((completion) => {
      if (completion.harnessId !== "traycer") return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.hostMethodScope(hostId, "host.getRateLimitUsage"),
      });
    });
  }, [queryClient, hostId]);
}

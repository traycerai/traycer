import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { AccountContext } from "@traycer/protocol/common/schemas";
import { subscribeChatTurnCompletions } from "@/lib/chats/chat-turn-completions";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { queryKeys } from "@/lib/query-keys";

/**
 * While mounted, invalidates the default host's artifact rate-limit usage query
 * whenever a Traycer-harness chat turn completes - the same
 * `subscribeChatTurnCompletions` trigger the credit refresh uses, so the
 * usage bar moves in step with credits.
 *
 * Invalidates the exact `{ accountContext }` params key
 * (`useHostRateLimitUsageQuery`'s own key), not the whole
 * `host.getRateLimitUsage` method scope: a method-scope invalidation would
 * also refetch any actively-observed provider-pull query on this host (see
 * `useRefreshProviderRateLimitsOnTurn`), spawning a CLI subprocess on every
 * Traycer turn even though a Traycer turn can't have changed a Codex/Claude
 * account's rate limits.
 *
 * Mounted by each `RateLimitView` (rate-limit tiers only) with its explicit
 * account context, mirroring `useRefreshCreditsOnTraycerTurn`.
 */
export function useRefreshRateLimitUsageOnTraycerTurn(
  accountContext: AccountContext,
): void {
  const queryClient = useQueryClient();
  const hostId = useReactiveActiveHostId();

  useEffect(() => {
    return subscribeChatTurnCompletions((completion) => {
      if (completion.harnessId !== "traycer") return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.hostMethod<
          HostRpcRegistry,
          "host.getRateLimitUsage"
        >(hostId, "host.getRateLimitUsage", {
          accountContext,
          profileId: null,
        }),
      });
    });
  }, [queryClient, hostId, accountContext]);
}

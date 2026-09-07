import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { AccountContext } from "@traycer/protocol/common/schemas";
import { subscribeChatTurnCompletions } from "@/lib/chats/chat-turn-completions";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { queryKeys } from "@/lib/query-keys";

/** Invalidate the { accountContext } key, not the whole host.getRateLimitUsage method scope. */
export function useRefreshRateLimitUsageOnTraycerTurn(
  accountContext: AccountContext,
): void {
  const queryClient = useQueryClient();
  const hostId = useAddressableHostId();

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

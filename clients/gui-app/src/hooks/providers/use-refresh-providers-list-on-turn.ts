import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { subscribeChatTurnCompletions } from "@/lib/chats/chat-turn-completions";
import { queryKeys } from "@/lib/query-keys";
import { PROVIDER_RATE_LIMITS_STALE_TIME_MS } from "@/lib/rate-limit-providers";

/** Invalidate tab-scoped providers.list on turn complete. Direct invalidate (no serial queue). Cooldown is PROVIDER_RATE_LIMITS_STALE_TIME_MS. */
export function useRefreshProvidersListOnTurn(
  harnessId: GuiHarnessId | null,
  hostId: string | null,
): void {
  const queryClient = useQueryClient();
  const lastInvalidatedAtRef = useRef(0);

  useEffect(() => {
    // Reset the cooldown whenever this effect re-runs for a new harness/host pair - otherwise switching harnesses on the same mounted composer inherits the previous harness's cooldown timestamp and can skip its own first, otherwise-due invalidation.
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
        // Exact CLASSIC key, not the method scope: `providers.list` is also the carrier for the native (MCP/plugins/skills) queries, and a turn completion says nothing about those.
        queryKey: queryKeys.hostMethod<HostRpcRegistry, "providers.list">(
          hostId,
          "providers.list",
          { native: null },
        ),
      });
    });
  }, [queryClient, hostId, harnessId]);
}

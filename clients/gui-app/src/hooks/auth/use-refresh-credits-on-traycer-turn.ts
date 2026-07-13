import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeChatTurnCompletions } from "@/lib/chats/chat-turn-completions";
import { useAuthService } from "@/lib/host";
import { authQueryKeys } from "@/lib/query-keys";

/**
 * While mounted, refreshes the signed-in user's credits whenever a
 * Traycer-harness chat turn completes - mirroring the extension's
 * `UsageInformationTracker`, which re-fetched the authenticated user after each
 * backend response.
 *
 * Mounted by `TraycerSubscriptionSection`, so it runs only while the Traycer
 * credits UI is on screen - the one place the balance is shown, and `"traycer"`
 * is the only harness that spends credits, so turns on other harnesses
 * (Claude, Codex, …) are ignored. Living here (not at the app root) also keeps
 * `useQueryClient` inside a guaranteed provider.
 *
 * Invalidation refetches the open `useAuthUser` query immediately.
 */
export function useRefreshCreditsOnTraycerTurn(): void {
  const queryClient = useQueryClient();
  const auth = useAuthService();

  useEffect(() => {
    return subscribeChatTurnCompletions((completion) => {
      if (completion.harnessId !== "traycer") return;
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.user(auth),
      });
    });
  }, [queryClient, auth]);
}

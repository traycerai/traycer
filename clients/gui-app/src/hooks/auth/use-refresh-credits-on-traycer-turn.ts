import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeChatTurnCompletions } from "@/lib/chats/chat-turn-completions";
import { useAuthService } from "@/lib/host";
import { authQueryKeys } from "@/lib/query-keys";

/**
 * While mounted, invalidate `useAuthUser` when a Traycer-harness turn completes. Other harnesses do not spend credits.
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

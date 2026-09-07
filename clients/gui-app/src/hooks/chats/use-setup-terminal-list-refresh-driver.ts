import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { hostQueryKeys } from "@/lib/query-keys";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

/** Invalidate the tab host's terminal.list when setup-terminal session ids change. Setup PTYs are not created via terminal.create. */
export function useSetupTerminalListRefreshDriver(options: {
  handle: ChatSessionStoreHandle;
}): void {
  const { handle } = options;
  const tabHostId = useTabHostId();
  const queryClient = useQueryClient();
  const binding = useStore(handle.store, (state) => state.worktreeBinding);

  // Stable signature of the setup-terminal identity + state across entries, so
  // the effect refetches only on a real setup transition - not on unrelated
  // binding-field churn. Local entries have no setup terminal.
  const signature =
    binding === null
      ? ""
      : binding.entries
          .map((entry) =>
            entry.mode === "local"
              ? "local"
              : `${entry.setupTerminalSessionId ?? ""}:${entry.setupState}`,
          )
          .join("|");

  useEffect(() => {
    void queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(tabHostId, "terminal.list"),
    });
  }, [signature, tabHostId, queryClient]);
}

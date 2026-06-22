import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { hostQueryKeys } from "@/lib/query-keys";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

/**
 * Surfaces the worktree SETUP terminal in the Terminals sidebar while it runs.
 *
 * The setup PTY is spawned server-side (inside `epic.create` /
 * `worktree.retrySetup`), never through the renderer's `terminal.create`, so
 * nothing invalidates the one-shot `terminal.list` query that feeds the sidebar
 * - the setup terminal never appears on its own. This driver watches the chat's
 * live worktree binding (kept fresh by `worktreeStateChanged` frames) and
 * invalidates the TAB host's `terminal.list` whenever the setup-terminal
 * session ids / states change, so the sidebar refetches and shows (then drops,
 * once the PTY exits + is evicted) the setup terminal.
 *
 * Scoped to the tab host (where the setup PTY lives) to match the setup
 * card's `useTabHostClient` wiring; in the common single-host case that is
 * the same host the sidebar queries, so the shared `terminal.list` cache is
 * refreshed for both. This is a live-stream (binding) → external-store (query
 * cache) sync, so it legitimately lives in an effect.
 */
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

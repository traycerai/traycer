import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { hostQueryKeys } from "@/lib/query-keys";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";

/**
 * Terminal-agent analog of `useSetupTerminalListRefreshDriver`: keeps the setup
 * card's "Open terminal" liveness fresh while a background setup PTY runs.
 *
 * The setup PTY is spawned server-side, so nothing invalidates the renderer's
 * one-shot `terminal.list` query - the setup card would show the button
 * disabled ("session ended") until an unrelated refetch. A chat drives this off
 * its live `chat.subscribe` binding, but a terminal agent has no chat store;
 * `worktree.getBinding` is its only binding source, so this watches that
 * binding (kept fresh by the tile's polling while setup is in flight) and
 * invalidates the TAB host's `terminal.list` whenever the setup-terminal
 * identity/state signature changes, so the card's liveness query refetches.
 *
 * Live-stream (binding) -> external-store (query cache) sync, so it
 * legitimately lives in an effect.
 */
export function useTuiSetupTerminalListRefreshDriver(options: {
  binding: WorktreeBinding | null;
}): void {
  const { binding } = options;
  const tabHostId = useTabHostId();
  const queryClient = useQueryClient();

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

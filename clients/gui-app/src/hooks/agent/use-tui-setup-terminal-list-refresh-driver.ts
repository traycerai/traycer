import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { hostQueryKeys } from "@/lib/query-keys";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";

/**
 * Invalidate the tab host's `terminal.list` when the setup-terminal binding signature changes. The setup PTY is server-side, so the one-shot query would otherwise stay stale.
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

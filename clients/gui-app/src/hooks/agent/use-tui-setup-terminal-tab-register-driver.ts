import { useRegisterSetupTerminalTabsFromBinding } from "@/hooks/worktree/use-register-setup-terminal-tabs-from-binding";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";

/**
 * Terminal-agent analog of `useSetupTerminalTabRegisterDriver`: a terminal
 * agent has no chat store, so the tui-agent tile passes the polled
 * `worktree.getBinding` (kept fresh while setup is in flight) as the binding
 * source and delegates the registration effect to the shared
 * `useRegisterSetupTerminalTabsFromBinding` hook (see there for the behavior
 * and the once-per-view guarantees).
 */
export function useTuiSetupTerminalTabRegisterDriver(options: {
  binding: WorktreeBinding | null;
  viewTabId: string;
}): void {
  useRegisterSetupTerminalTabsFromBinding(options);
}

import { useStore } from "zustand";
import { useRegisterSetupTerminalTabsFromBinding } from "@/hooks/worktree/use-register-setup-terminal-tabs-from-binding";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

/**
 * Chat's setup-terminal tab register driver: sources the worktree binding from
 * the chat's live `chat.subscribe` store and delegates the registration effect
 * to `useRegisterSetupTerminalTabsFromBinding` (see there for the behavior and
 * the once-per-view guarantees). The terminal-agent tile has its own driver
 * that feeds the same shared hook from a polled binding.
 */
export function useSetupTerminalTabRegisterDriver(options: {
  handle: ChatSessionStoreHandle;
  viewTabId: string;
}): void {
  const { handle, viewTabId } = options;
  const binding = useStore(handle.store, (state) => state.worktreeBinding);
  useRegisterSetupTerminalTabsFromBinding({ binding, viewTabId });
}

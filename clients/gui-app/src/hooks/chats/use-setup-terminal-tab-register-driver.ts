import { useEffect } from "react";
import { useStore } from "zustand";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSetupTerminalRegistrationStore } from "@/stores/chats/setup-terminal-registration-store";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { WorktreeBindingEntry } from "@traycer/protocol/host";

/**
 * Registers each worktree SETUP terminal as a real (background) canvas tab the
 * first time setup starts running, so it survives a host/GUI restart exactly
 * like a user-opened terminal.
 *
 * The host keeps no terminal state across a restart - persistence comes only
 * from a saved canvas tab, which re-creates the shell on next open. The setup
 * PTY is spawned server-side (never through the renderer's `terminal.create`),
 * so without this it has no saved tab and vanishes on a host restart while
 * user terminals (always opened as tabs) come back. This registers it as a
 * BACKGROUND tab (no focus change, so the user is not yanked off the chat),
 * keyed on the SAME id the card's "Open terminal" uses - so the two converge
 * on one tab.
 *
 * The tab is auto-opened EXACTLY ONCE PER VIEW. Two guards together give that:
 *  - the `running` gate, so a settled (succeeded / failed / cancelled) or
 *    historical setup is never auto-opened - only an actively-running one; and
 *  - `useSetupTerminalRegistrationStore`, which records each
 *    `${viewTabId}:${sessionId}` it opens, so a binding update or a remount
 *    while setup is still running does NOT re-open a tab the user has closed.
 * Registration is VIEW-scoped: the same chat shown in two view tabs auto-opens
 * the terminal in each, while within one view it pops once and, once closed,
 * stays closed - never returning on binding churn, remount, or completion.
 * Restart survival is unaffected (it comes from the persisted canvas tab); a
 * finished setup terminal the user wants back is one click away on the setup
 * card's "Open terminal".
 *
 * Live-stream (worktree binding) -> external-store (canvas tabs) sync, so it
 * legitimately lives in an effect. Bound to the tab host, matching the setup
 * card / focus-terminal wiring.
 */
export function useSetupTerminalTabRegisterDriver(options: {
  handle: ChatSessionStoreHandle;
  viewTabId: string;
}): void {
  const { handle, viewTabId } = options;
  const hostId = useTabHostId();
  const openTileInBackgroundTab = useEpicCanvasStore(
    (s) => s.openTileInBackgroundTab,
  );
  const registerSetupTerminalOnce = useSetupTerminalRegistrationStore(
    (s) => s.registerOnce,
  );
  const binding = useStore(handle.store, (state) => state.worktreeBinding);

  useEffect(() => {
    if (binding === null) return;
    binding.entries.forEach((entry) => {
      // Only consider an actively-running setup, never a settled or historical
      // entry whose `setupTerminalSessionId` the binding still carries.
      if (entry.setupState !== "running") return;
      const sessionId = entry.setupTerminalSessionId;
      if (sessionId === null || sessionId.length === 0) return;

      // Exactly once per (view, session): `registerOnce` returns false on
      // every call after the first, so a binding update or a remount while
      // setup is still running cannot re-open a tab the user has closed.
      // Keyed by `viewTabId` so the same chat in another view gets its own tab.
      if (!registerSetupTerminalOnce(`${viewTabId}:${sessionId}`)) return;
      openTileInBackgroundTab(viewTabId, {
        id: sessionId,
        instanceId: sessionId,
        type: "terminal",
        name: setupTerminalTitle(entry),
        titleSource: "manual",
        hostId,
        cwd: setupTerminalCwd(entry),
      });
    });
  }, [
    binding,
    viewTabId,
    hostId,
    openTileInBackgroundTab,
    registerSetupTerminalOnce,
  ]);
}

function setupTerminalCwd(entry: WorktreeBindingEntry): string {
  if (entry.mode === "worktree" && entry.worktreePath !== null) {
    return entry.worktreePath;
  }
  return entry.workspacePath;
}

function setupTerminalTitle(entry: WorktreeBindingEntry): string {
  return `Setup: ${labelForWorkspace(entry.workspacePath)} ${entry.branch}`;
}

function labelForWorkspace(workspacePath: string): string {
  const trimmed = workspacePath.replace(/[\\/]+$/u, "");
  const segments = trimmed.split(/[\\/]/u);
  const last = segments.at(-1);
  return last !== undefined && last.length > 0 ? last : workspacePath;
}

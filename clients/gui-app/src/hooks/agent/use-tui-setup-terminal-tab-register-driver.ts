import { useEffect } from "react";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSetupTerminalRegistrationStore } from "@/stores/chats/setup-terminal-registration-store";
import {
  setupTerminalCwd,
  setupTerminalTitle,
} from "@/lib/setup-terminal-tab-descriptor";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";

/**
 * Terminal-agent analog of `useSetupTerminalTabRegisterDriver`: registers each
 * worktree SETUP terminal as a real (background) canvas tab the first time setup
 * starts running, so it survives a host/GUI restart exactly like a user-opened
 * terminal.
 *
 * The host keeps no terminal state across a restart - persistence comes only
 * from a saved canvas tab, which re-creates the shell on next open. The setup
 * PTY is spawned server-side (never through the renderer's `terminal.create`),
 * so without this it has no saved tab and vanishes on a host restart while
 * user terminals (always opened as tabs) come back. This registers it as a
 * BACKGROUND tab (no focus change, so the user is not yanked off the terminal
 * agent), keyed on the SAME id the card's "Open terminal" uses - so the two
 * converge on one tab.
 *
 * The tab is auto-opened EXACTLY ONCE PER VIEW. Two guards together give that:
 *  - the `running` gate, so a settled (succeeded / failed / cancelled) or
 *    historical setup is never auto-opened - only an actively-running one; and
 *  - `useSetupTerminalRegistrationStore`, which records each
 *    `${viewTabId}:${sessionId}` it opens, so a binding update or a remount
 *    while setup is still running does NOT re-open a tab the user has closed.
 * Registration is VIEW-scoped: the same agent shown in two view tabs auto-opens
 * the terminal in each, while within one view it pops once and, once closed,
 * stays closed - never returning on binding churn, remount, or completion.
 *
 * A chat drives this off its live `chat.subscribe` binding, but a terminal
 * agent has no chat store; the polled `worktree.getBinding` (kept fresh by the
 * tile while setup is in flight) is its only binding source, so the caller
 * passes that binding in. Live-stream (worktree binding) -> external-store
 * (canvas tabs) sync, so it legitimately lives in an effect. Bound to the tab
 * host, matching the setup card / focus-terminal wiring.
 */
export function useTuiSetupTerminalTabRegisterDriver(options: {
  binding: WorktreeBinding | null;
  viewTabId: string;
}): void {
  const { binding, viewTabId } = options;
  const hostId = useTabHostId();
  const openTileInBackgroundTab = useEpicCanvasStore(
    (s) => s.openTileInBackgroundTab,
  );
  const registerSetupTerminalOnce = useSetupTerminalRegistrationStore(
    (s) => s.registerOnce,
  );

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
      // Keyed by `viewTabId` so the same agent in another view gets its own tab.
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

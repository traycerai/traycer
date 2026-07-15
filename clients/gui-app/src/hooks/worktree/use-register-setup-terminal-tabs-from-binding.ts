import { useEffect } from "react";
import { v4 as uuidv4 } from "uuid";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSetupTerminalRegistrationStore } from "@/stores/chats/setup-terminal-registration-store";
import {
  setupTerminalCwd,
  setupTerminalTitle,
} from "@/lib/setup-terminal-tab-descriptor";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";

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
 * BACKGROUND tab (no focus change, so the user is not yanked off the chat /
 * terminal agent), keyed on the SAME id the card's "Open terminal" uses - so
 * the two converge on one tab.
 *
 * The tab is auto-opened EXACTLY ONCE PER VIEW. Two guards together give that:
 *  - the `running` gate, so a settled (succeeded / failed / cancelled) or
 *    historical setup is never auto-opened - only an actively-running one; and
 *  - `useSetupTerminalRegistrationStore`, which records each
 *    `${viewTabId}:${sessionId}` it opens, so a binding update or a remount
 *    while setup is still running does NOT re-open a tab the user has closed.
 * Registration is VIEW-scoped: the same owner shown in two view tabs auto-opens
 * the terminal in each, while within one view it pops once and, once closed,
 * stays closed - never returning on binding churn, remount, or completion.
 * Restart survival is unaffected (it comes from the persisted canvas tab); a
 * finished setup terminal the user wants back is one click away on the setup
 * card's "Open terminal".
 *
 * Live-stream (worktree binding) -> external-store (canvas tabs) sync, so it
 * legitimately lives in an effect. Bound to the tab host, matching the setup
 * card / focus-terminal wiring.
 *
 * Callers differ only in how they source `binding`: a chat reads it from its
 * live `chat.subscribe` store; a terminal agent has no chat store and passes
 * the polled `worktree.getBinding`. Both delegate here so the registration
 * behavior stays in lockstep.
 */
export function useRegisterSetupTerminalTabsFromBinding(options: {
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
      // Keyed by `viewTabId` so the same owner in another view gets its own tab.
      if (!registerSetupTerminalOnce(`${viewTabId}:${sessionId}`)) return;
      // `instanceId` is per-tab-instance identity (the terminal session
      // registry keys stream handles by it); reusing the session id here
      // would alias handles when the same session opens in multiple views.
      // Dedup/convergence with the setup card's "Open terminal" is by
      // content `id`, not instance.
      openTileInBackgroundTab(viewTabId, {
        id: sessionId,
        instanceId: uuidv4(),
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

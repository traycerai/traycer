import { useEffect } from "react";
import { v4 as uuidv4 } from "uuid";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useSetupTerminalRegistrationStore } from "@/stores/chats/setup-terminal-registration-store";
import { recordSetupTerminal } from "@/stores/worktree/setup-terminals";
import {
  setupTerminalCwd,
  setupTerminalTitle,
} from "@/lib/setup-terminal-tab-descriptor";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { tileIntent } from "@/lib/canvas/tile-open/intent";

/**
 * Registers each worktree SETUP terminal as a real (background) canvas tab the
 * first time setup starts running, so the saved tab can reattach after a GUI
 * restart. The host owns the setup session: a missing session must be retried
 * through the setup controls, never recreated by the terminal tile.
 *
 * Registration leaves the chat / terminal agent focused and uses the SAME
 * id as the setup card's "Open terminal", so both converge on one tab.
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
 * The persisted tab can reattach while its session is live. A completed setup
 * whose shell is still running remains reachable through "Open terminal";
 * once that session is gone, the setup controls own starting another run.
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
  owningTileInstanceId: string;
}): void {
  const { binding, viewTabId, owningTileInstanceId } = options;
  const hostId = useTabHostId();
  const { openTile } = useEpicTileNavigation();
  const registerSetupTerminalOnce = useSetupTerminalRegistrationStore(
    (s) => s.registerOnce,
  );

  useEffect(() => {
    if (binding === null) return;
    const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
    const pane = collectPanes(canvas?.root ?? null).find((candidate) =>
      candidate.tabInstanceIds.includes(owningTileInstanceId),
    );
    // Never consume registration against an unrelated active pane.
    if (pane === undefined) return;
    binding.entries.forEach((entry) => {
      // Only consider an actively-running setup, never a settled or historical
      // entry whose `setupTerminalSessionId` the binding still carries.
      if (entry.setupState !== "running") return;
      const sessionId = entry.setupTerminalSessionId;
      if (sessionId === null || sessionId.length === 0) return;

      // Record even when this view already registered the tab: sidebar and
      // palette reopen consult the registry, not the canvas origin stamp.
      recordSetupTerminal({ hostId, sessionId });

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
      openTile({
        ...tileIntent(
          {
            id: sessionId,
            instanceId: uuidv4(),
            type: "terminal",
            name: setupTerminalTitle(entry),
            titleSource: "manual",
            hostId,
            cwd: setupTerminalCwd(entry),
            origin: "setup",
          },
          { tabId: viewTabId },
          // Keep the owner visible while setup runs in its background tab.
          "host",
          "direct_ui",
        ),
        placement: { kind: "tab", paneId: pane.id, index: null },
      });
    });
  }, [
    binding,
    viewTabId,
    owningTileInstanceId,
    hostId,
    openTile,
    registerSetupTerminalOnce,
  ]);
}

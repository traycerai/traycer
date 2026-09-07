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
import { tileIntent } from "@/lib/canvas/tile-open/intent";

/** Settled or historical setups are never auto-opened. */
export function useRegisterSetupTerminalTabsFromBinding(options: {
  binding: WorktreeBinding | null;
  viewTabId: string;
}): void {
  const { binding, viewTabId } = options;
  const hostId = useTabHostId();
  const { openTile } = useEpicTileNavigation();
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

      // Record even when this view already registered the tab: sidebar and
      // palette reopen consult the registry, not the canvas origin stamp.
      recordSetupTerminal({ hostId, sessionId });

      // Exactly once per (view, session): `registerOnce` returns false on every call after the first, so a binding update or a remount while setup is still running cannot re-open a tab the user has closed.
      if (!registerSetupTerminalOnce(`${viewTabId}:${sessionId}`)) return;
      // `instanceId` is per-tab-instance identity (the terminal session registry keys stream handles by it); reusing the session id here would alias handles when the same session opens in multiple views.
      openTile(
        tileIntent(
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
          // The host pushed this at us; there was no gesture behind it, so it
          // lands as a background tab and never steals focus (C4).
          "host",
          "direct_ui",
        ),
      );
    });
  }, [binding, viewTabId, hostId, openTile, registerSetupTerminalOnce]);
}

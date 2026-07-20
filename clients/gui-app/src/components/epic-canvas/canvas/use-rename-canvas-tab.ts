import { useCallback } from "react";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useEpicRenameChat } from "@/hooks/epic/use-epic-chat-mutations";
import { useEpicRenameTuiAgent } from "@/hooks/epic/use-epic-tui-agent-mutations";
import { useEpicRenameArtifact } from "@/hooks/epic/use-epic-node-mutations";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

/**
 * Commit handler for inline tab-title editing in the canvas tab strip, for
 * RECORD-BACKED nodes only. Mirrors the sidebar rename path so a tab renamed
 * from its right-click menu stays in lockstep with the same node renamed from
 * the sidebar tree: chat / terminal-agent / spec / ticket / story / review
 * live in the epic Y.Doc, so we update the local projection
 * (`renameArtifact`) and the tab snapshot (`renameArtifactInTab`) for instant
 * feedback, then fire the kind-specific authoritative RPC.
 *
 * Plain terminals never reach this handler: they are host sessions (not
 * Y.Doc artifacts) whose titles live on the host, so `TabItem` routes their
 * rename through `useTerminalRenameFor` against the tab's bound host - the
 * mutation's optimistic `terminal.list` patch updates every title surface at
 * once.
 *
 * `viewTabId` is the header (epic) view tab that owns the canvas snapshot;
 * `tab.id` is the content id (chat / artifact), not the per-tab `instanceId`.
 */
export function useRenameCanvasTab(
  epicId: string,
  viewTabId: string,
): (tab: EpicCanvasTileRef, title: string) => void {
  const epicHandle = useOpenEpicHandle();
  const renameArtifactInTab = useEpicCanvasStore((s) => s.renameArtifactInTab);
  const renameChat = useEpicRenameChat();
  const renameTerminalAgent = useEpicRenameTuiAgent();
  const renameArtifact = useEpicRenameArtifact(true);

  return useCallback(
    (tab, rawTitle) => {
      const trimmed = rawTitle.trim();
      // No same-title suppression: the optimistic local update can already be
      // ahead of a failed RPC, and resubmitting the visible title is the
      // user's retry path. A duplicate rename RPC is harmless (HEAD behavior);
      // the event only fires on authoritative mutation success.
      if (trimmed.length === 0) return;
      if (tab.type === "terminal") return;
      const id = tab.id;
      epicHandle.store.getState().renameArtifact(id, trimmed);
      renameArtifactInTab(viewTabId, id, trimmed);
      if (tab.type === "chat") {
        renameChat.mutate({ epicId, chatId: id, title: trimmed });
      } else if (tab.type === "terminal-agent") {
        renameTerminalAgent.mutate({ epicId, tuiAgentId: id, title: trimmed });
      } else {
        renameArtifact.mutate({ epicId, artifactId: id, title: trimmed });
      }
    },
    [
      epicHandle,
      epicId,
      renameArtifact,
      renameArtifactInTab,
      renameChat,
      renameTerminalAgent,
      viewTabId,
    ],
  );
}

import { useCallback } from "react";
import { useEpicRenameChat } from "@/hooks/epic/use-epic-chat-mutations";
import { useEpicRenameTuiAgent } from "@/hooks/epic/use-epic-tui-agent-mutations";
import { useEpicRenameArtifact } from "@/hooks/epic/use-epic-node-mutations";
import { useTerminalRenameFor } from "@/hooks/terminal/use-terminal-rename-for-mutation";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

/** The renameable kinds a mobile surface can address, and how they rename. */
export type SwitcherRowKind =
  | "chat"
  | "terminal-agent"
  | "artifact"
  | "terminal";

/**
 * The renameable kind behind a canvas tile, or null for a tile that carries no
 * name of its own (file previews, diffs, output windows, and the rest of the
 * derived kinds). Callers use null to render a title as plain text.
 */
export function tileRenameKind(ref: EpicCanvasTileRef): SwitcherRowKind | null {
  switch (ref.type) {
    case "chat":
      return "chat";
    case "terminal-agent":
      return "terminal-agent";
    case "spec":
    case "ticket":
    case "story":
    case "review":
      return "artifact";
    case "terminal":
      return "terminal";
    default:
      return null;
  }
}

/**
 * Fires the canonical rename mutation for a renameable kind: the same host RPCs
 * the desktop sidebar rows drive, so every mobile rename affordance - list rows
 * and the current-tile title alike - lands through one path.
 *
 * `nodeId` is the content id for agents and artifacts, the session id for a raw
 * terminal.
 */
export function useSwitcherRename(
  epicId: string,
): (kind: SwitcherRowKind, nodeId: string, title: string) => void {
  const renameChat = useEpicRenameChat();
  const renameTuiAgent = useEpicRenameTuiAgent();
  const renameArtifact = useEpicRenameArtifact(true);
  const renameTerminal = useTerminalRenameFor(useEpicSessionHostClient());

  return useCallback(
    (kind, nodeId, title) => {
      if (kind === "chat") renameChat.mutate({ epicId, chatId: nodeId, title });
      else if (kind === "terminal-agent")
        renameTuiAgent.mutate({ epicId, tuiAgentId: nodeId, title });
      else if (kind === "artifact")
        renameArtifact.mutate({ epicId, artifactId: nodeId, title });
      else renameTerminal.mutate({ sessionId: nodeId, title });
    },
    [epicId, renameArtifact, renameChat, renameTerminal, renameTuiAgent],
  );
}

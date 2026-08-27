import { useCallback } from "react";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
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
 *
 * ## Why this stamps an overlay now
 *
 * This hook had NO local update: it fired the RPC and waited. That was not a
 * mobile product decision - `useIsMobileViewport()` is a 768px media query, so
 * the same user on the same device got different persistence feedback either
 * side of a window drag. The overlay is what removes that width dependency;
 * the wide-viewport twin is `use-rename-canvas-tab.ts`, and the two must stay
 * observably identical (the resize test is 1.1's acceptance criterion).
 *
 * A raw `terminal` is deliberately excluded: it is a host session rather than
 * an epic node, has no row in the projection to patch, and its own rename
 * mutation already carries an optimistic `terminal.list` patch.
 */
export function useSwitcherRename(
  epicId: string,
): (kind: SwitcherRowKind, nodeId: string, title: string) => void {
  const epicHandle = useOpenEpicHandle();
  const renameChat = useEpicRenameChat();
  const renameTuiAgent = useEpicRenameTuiAgent();
  const renameArtifact = useEpicRenameArtifact(true);
  const renameTerminal = useTerminalRenameFor(useEpicSessionHostClient());

  return useCallback(
    (kind, nodeId, title) => {
      // Trimmed for BOTH the stamp and the RPC - and for the raw terminal
      // too, whose arm previously sat above this guard and would send a
      // whitespace-only title straight to `terminal.rename`. The overlay
      // stamps the trimmed value, so sending the raw string would make the
      // host land a value the landed-entry bookkeeping never acked - and the
      // desktop twin already trims, which the 768px parity contract makes
      // binding here.
      const trimmed = title.trim();
      if (trimmed.length === 0) return;
      if (kind === "terminal") {
        renameTerminal.mutate({ sessionId: nodeId, title: trimmed });
        return;
      }
      // DOC-RESIDENT terminal agents keep the direct doc write - see the
      // same branch in `use-rename-canvas-tab.ts`: `epic.renameTuiAgent`
      // refuses a row the serving host has no registry entry for
      // (`E_AGENT_NOT_LOCAL`), so the overlay path would only ever roll
      // back. No snapshot on this surface; the doc write is its own
      // synchronous feedback.
      if (kind === "terminal-agent") {
        const agents = epicHandle.store.getState().tuiAgents.byId;
        if (!Object.hasOwn(agents, nodeId) || agents[nodeId].docResident) {
          epicHandle.store.getState().renameArtifact(nodeId, trimmed);
          return;
        }
      }
      const requestId = epicHandle.store
        .getState()
        .beginRenameMutation(nodeId, trimmed);
      // Retire rides the `mutateAsync` promise - never a per-call
      // `onSettled`, which TanStack drops on unmount and replaces on a
      // consecutive `mutate()`. Contract note in `use-rename-canvas-tab.ts`.
      const retire = (outcome: "landed" | "failed"): void => {
        if (requestId === null) return;
        epicHandle.store.getState().retirePendingMutation(requestId, outcome);
      };
      const landed = (): void => {
        retire("landed");
      };
      const failed = (): void => {
        retire("failed");
      };
      if (kind === "chat") {
        void renameChat
          .mutateAsync({ epicId, chatId: nodeId, title: trimmed })
          .then(landed, failed);
      } else if (kind === "terminal-agent") {
        void renameTuiAgent
          .mutateAsync({ epicId, tuiAgentId: nodeId, title: trimmed })
          .then(landed, failed);
      } else {
        void renameArtifact
          .mutateAsync({ epicId, artifactId: nodeId, title: trimmed })
          .then(landed, failed);
      }
    },
    [
      epicHandle,
      epicId,
      renameArtifact,
      renameChat,
      renameTerminal,
      renameTuiAgent,
    ],
  );
}

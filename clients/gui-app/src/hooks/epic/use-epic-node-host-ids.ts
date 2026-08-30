import { useMemo } from "react";
import {
  useEpicChatRecords,
  useEpicTerminalAgentRecords,
} from "@/lib/epic-selectors";
import { parseHostIdStamp, stampHostIds } from "@/lib/host/host-id-stamp";

/**
 * The hosts the OPEN Epic's node records name - every GUI chat and terminal
 * agent in the projection, folded to the set of machines they live on.
 *
 * Zero RPC by construction: every node record already carries its `hostId`,
 * so this is a read of data the session has projected anyway. It is the
 * evidence behind Sweep's occupancy badge - "this Task has agents here" - and
 * deliberately NOT a claim about worktrees. It is wrong in BOTH directions,
 * by design:
 *
 *   - it UNDER-claims: a host can hold a Task's worktree with no surviving
 *     node record, because worktree owner-binding cascades on chat deletion
 *     are best-effort host-side. That is why the picker lists every usable
 *     host rather than only the ones this set names.
 *   - it OVER-claims: `ChatProjection` carries no workspace information at
 *     all, and while `TuiAgentProjection` carries `workspaceFolders`, nothing
 *     in the projection says whether a folder is a WORKTREE - the
 *     `local`/`worktree` entry mode exists only in the host's binding rows.
 *     So a badged host may have nothing to sweep, and the dialog's empty
 *     state is the correct outcome. Do not try to narrow this by reading path
 *     shapes; the only reliable per-host oracle is that host's own binding
 *     registry, which is what the dialog already asks for.
 *
 * Every word of copy built on this therefore claims AGENTS, never worktrees.
 *
 * Legacy chats that predate `Chat.hostId` contribute nothing rather than
 * falling back to the app's active host - the same rule the comm graph
 * follows, and for the same reason: a badge that moved when you switched
 * hosts somewhere else in the app would be describing the app, not the Task.
 */
export function useEpicNodeHostIds(): ReadonlySet<string> {
  const chats = useEpicChatRecords();
  const terminalAgents = useEpicTerminalAgentRecords();
  // Through a sorted string stamp so the returned Set's IDENTITY only changes
  // when the SET does. Chat projections churn constantly (titles, `updatedAt`,
  // streaming settings) and consumers key memos and dialogs on this value.
  const stamp = useMemo(
    () =>
      stampHostIds([
        ...chats.map((chat) => chat.hostId),
        ...terminalAgents.map((agent) => agent.hostId),
      ]),
    [chats, terminalAgents],
  );
  return useMemo(() => new Set(parseHostIdStamp(stamp)), [stamp]);
}

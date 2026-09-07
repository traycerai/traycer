import { useMemo } from "react";
import {
  useEpicChatRecords,
  useEpicTerminalAgentRecords,
} from "@/lib/epic-selectors";
import { parseHostIdStamp, stampHostIds } from "@/lib/host/host-id-stamp";

/** Legacy chats without Chat.hostId contribute nothing; do not fall back to the app-wide active host.
 * Occupancy of agents, never worktrees; under- and over-claims by design. */
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

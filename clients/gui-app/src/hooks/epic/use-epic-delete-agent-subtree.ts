import { useRef, useState } from "react";
import { toast } from "sonner";
import { useEpicDeleteChat } from "@/hooks/epic/use-epic-chat-mutations";
import { useEpicDeleteTuiAgent } from "@/hooks/epic/use-epic-tui-agent-mutations";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { resolveChatWriteRoute } from "@/hooks/epic/use-chat-write-route";
import {
  agentSubtreeDeleteIds,
  selectNestedAgentsKnown,
} from "@/lib/epic-tree-cascade";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { CHAT_NOT_ADOPTED_COPY } from "@/stores/epics/open-epic/chat-write-routing";

/** Reuse single-agent deletes so every member keeps its cleanup and refusals. */
export function useEpicDeleteAgentSubtree() {
  const handle = useOpenEpicHandle();
  const sessionHostId = useEpicSessionHostId();
  const deleteChat = useEpicDeleteChat();
  const deleteTuiAgent = useEpicDeleteTuiAgent();
  const running = useRef(false);
  const [isPending, setIsPending] = useState(false);

  const deleteSubtree = async (nodeId: string): Promise<void> => {
    if (running.current) throw new Error("Agent deletion is already running.");
    const state = handle.store.getState();
    if (!selectNestedAgentsKnown(state)) {
      const message =
        "Nested agents are still loading. Try again when they have loaded.";
      toast.error(message);
      throw new Error(message);
    }
    // Snapshot both membership and destination before any deletion can promote
    // children or refresh a record list. The full tree includes hidden agents.
    const targets = agentSubtreeDeleteIds(state.tree, nodeId).map((id) => {
      const kind = state.tree.nodeById[id].type;
      let ownerHostId: string | null = null;
      if (kind === "chat" && Object.hasOwn(state.chats.byId, id)) {
        ownerHostId = state.chats.byId[id].hostId;
      } else if (
        kind === "terminal-agent" &&
        Object.hasOwn(state.tuiAgents.byId, id)
      ) {
        ownerHostId = state.tuiAgents.byId[id].hostId;
      }
      const hostId = ownerHostId ?? sessionHostId;
      return { id, kind, hostId };
    });
    running.current = true;
    setIsPending(true);
    try {
      for (const target of targets) {
        let deleted: boolean;
        if (target.kind === "chat") {
          if (
            resolveChatWriteRoute({
              chatsById: handle.store.getState().chats.byId,
              isChatRow: true,
              nodeId: target.id,
              sessionHostId,
            }) === "unavailable"
          ) {
            toast.error(CHAT_NOT_ADOPTED_COPY);
            throw new Error(CHAT_NOT_ADOPTED_COPY);
          }
          deleted = (
            await deleteChat.mutateAsync({
              epicId: handle.epicId,
              chatId: target.id,
              hostId: target.hostId,
            })
          ).deleted;
        } else {
          deleted = (
            await deleteTuiAgent.mutateAsync({
              epicId: handle.epicId,
              tuiAgentId: target.id,
              hostId: target.hostId,
            })
          ).deleted;
        }
        if (!deleted) {
          const message = "Couldn't delete agent.";
          toast.error(message);
          throw new Error(message);
        }
      }
    } finally {
      running.current = false;
      setIsPending(false);
    }
  };
  return { deleteSubtree, isPending };
}

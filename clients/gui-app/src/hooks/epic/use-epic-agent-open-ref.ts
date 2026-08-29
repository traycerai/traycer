import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { makeChatOpenTileRef } from "@/lib/chats/chat-open-tile-ref";
import {
  useEpicNodeHostId,
  useEpicNodeOwnerUserId,
} from "@/lib/epic-selectors";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import type {
  EpicArtifactRef,
  PublishedChatTileRef,
} from "@/stores/epics/canvas/types";

interface EpicAgentOpenInput {
  readonly epicId: string;
  readonly nodeId: string;
  readonly name: string;
  readonly type: "chat" | "terminal-agent";
}

/**
 * Mints the tile ref for an agent reference at click time.
 *
 * This hook samples reachability for the decision but never follows it after
 * the tile opens. Live refs remain bound to their owner host for life;
 * published refs remain bound to the Epic session host that serves the read.
 */
export function useEpicAgentOpenRef(
  input: EpicAgentOpenInput,
): () => EpicArtifactRef | PublishedChatTileRef {
  const { epicId, nodeId, name, type } = input;
  const projectedOwnerHostId = useEpicNodeHostId(nodeId);
  const ownerUserId = useEpicNodeOwnerUserId(nodeId);
  const sessionHostId = useEpicSessionHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
  const ownerReachability = useHostReachability(
    projectedOwnerHostId ?? UNKNOWN_HOST_PLACEHOLDER,
  );

  return useCallback(
    () =>
      type === "chat"
        ? makeChatOpenTileRef({
            taskId: epicId,
            chatId: nodeId,
            name,
            ownerHostId: projectedOwnerHostId,
            ownerUserId,
            ownerIsUnreachable: ownerReachability.status === "unreachable",
            sessionHostId,
          })
        : {
            id: nodeId,
            instanceId: uuidv4(),
            type,
            name,
            hostId: projectedOwnerHostId ?? sessionHostId,
          },
    [
      epicId,
      nodeId,
      name,
      type,
      ownerReachability.status,
      ownerUserId,
      projectedOwnerHostId,
      sessionHostId,
    ],
  );
}

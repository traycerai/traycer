/**
 * Agents are the ONLY node class: the log records who talked to whom, so anything else on the canvas would be a node with no edges to justify it.
 */
import { useMemo } from "react";
import {
  useEpicChatRecords,
  useEpicTerminalAgentRecords,
} from "@/lib/epic-selectors";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";

export interface CommGraphAgents {
  readonly nodes: ReadonlyArray<CommGraphAgentNode>;
  /**
   * Sorted so the array identity only changes when the SET changes, keeping the subscription effect from churning on unrelated projection updates (titles, `updatedAt`, ...).
   */
  readonly hostIds: ReadonlyArray<string>;
  readonly agentIds: ReadonlySet<string>;
}

export function useCommGraphAgents(): CommGraphAgents {
  const chats = useEpicChatRecords();
  const terminalAgents = useEpicTerminalAgentRecords();

  const nodes = useMemo<ReadonlyArray<CommGraphAgentNode>>(() => {
    const chatNodes = chats.map<CommGraphAgentNode>((chat) => ({
      id: chat.id,
      kind: "chat",
      name: chat.title,
      hostId: chat.hostId,
      parentId: chat.parentId,
      // A chat's harness and model live in its persisted run settings, which
      // are absent until the chat has been given some.
      harnessId: chat.settings?.harnessId ?? null,
      model: chat.settings?.model ?? null,
      archived: chat.archivedAt !== null,
      archivedAt: chat.archivedAt,
      createdAt: chat.createdAt,
    }));
    const agentNodes = terminalAgents.map<CommGraphAgentNode>((agent) => ({
      id: agent.id,
      kind: "terminal-agent",
      name: agent.title,
      hostId: agent.hostId,
      parentId: agent.parentId,
      harnessId: agent.harnessId,
      model: agent.model,
      archived: agent.archivedAt !== null,
      archivedAt: agent.archivedAt,
      createdAt: agent.createdAt,
    }));
    return [...chatNodes, ...agentNodes];
  }, [chats, terminalAgents]);

  // JSON round-trip rather than a delimiter join: host ids are opaque, so no separator is collision-safe by contract.
  const hostKey = useMemo(
    () =>
      JSON.stringify(
        Array.from(
          new Set(
            nodes.flatMap((node) =>
              node.hostId === null ? [] : [node.hostId],
            ),
          ),
        ).sort(),
      ),
    [nodes],
  );

  const hostIds = useMemo<ReadonlyArray<string>>(() => {
    const parsed: unknown = JSON.parse(hostKey);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  }, [hostKey]);

  const agentIds = useMemo(
    () => new Set(nodes.map((node) => node.id)),
    [nodes],
  );

  return { nodes, hostIds, agentIds };
}

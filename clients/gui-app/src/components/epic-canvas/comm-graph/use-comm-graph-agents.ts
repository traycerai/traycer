/**
 * Canvas node set for the comm-graph tile: the epic's agents, projected from
 * the per-epic Y.Doc (GUI chats + terminal agents). Agents are the ONLY node
 * class: the log records who talked to whom, so anything else on the canvas
 * would be a node with no edges to justify it.
 *
 * Every value here comes from EPIC DATA only. In particular there is no
 * fallback to the app's active host for a legacy chat that predates
 * `Chat.hostId`: that is reactive global state, and reading it would make the
 * node's host - and therefore the subscription set, its events and its cursor -
 * change whenever the user switches hosts anywhere else in the app. Legacy
 * chats stay unattributed and render as "host unknown".
 */
import { useMemo } from "react";
import {
  useEpicChatRecords,
  useEpicTerminalAgentRecords,
} from "@/lib/epic-selectors";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";

const HOST_KEY_SEPARATOR = " ";

export interface CommGraphAgents {
  readonly nodes: ReadonlyArray<CommGraphAgentNode>;
  /**
   * Distinct hosts the agents live on - one `epic.communicationGraph.subscribe`
   * each. Sorted so the array identity only changes when the SET changes,
   * keeping the subscription effect from churning on unrelated projection
   * updates (titles, `updatedAt`, ...). Agents with an unresolved host
   * contribute nothing here - there is no host to subscribe to.
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
      harnessId: null,
      archived: chat.archivedAt !== null,
      createdAt: chat.createdAt,
    }));
    const agentNodes = terminalAgents.map<CommGraphAgentNode>((agent) => ({
      id: agent.id,
      kind: "terminal-agent",
      name: agent.title,
      hostId: agent.hostId,
      parentId: agent.parentId,
      harnessId: agent.harnessId,
      archived: agent.archivedAt !== null,
      createdAt: agent.createdAt,
    }));
    return [...chatNodes, ...agentNodes];
  }, [chats, terminalAgents]);

  // Derived through a string key so the array identity is stable across
  // projection churn: the subscription effect keys on `hostIds`, and a fresh
  // array on every title / `updatedAt` update would reopen every host socket.
  const hostKey = useMemo(
    () =>
      Array.from(
        new Set(
          nodes.flatMap((node) => (node.hostId === null ? [] : [node.hostId])),
        ),
      )
        .sort()
        .join(HOST_KEY_SEPARATOR),
    [nodes],
  );

  const hostIds = useMemo<ReadonlyArray<string>>(
    () => (hostKey.length === 0 ? [] : hostKey.split(HOST_KEY_SEPARATOR)),
    [hostKey],
  );

  const agentIds = useMemo(
    () => new Set(nodes.map((node) => node.id)),
    [nodes],
  );

  return { nodes, hostIds, agentIds };
}

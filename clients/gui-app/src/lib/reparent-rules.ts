import * as Y from "yjs";
import {
  getArtifactsMap,
  getChatsMap,
  getTerminalAgentsMap,
} from "@/stores/epics/open-epic/projection-helpers";

export type NodeFamily = "artifact" | "agent";
export type ReparentRejectionReason =
  | "missing-node"
  | "cross-panel"
  | "cycle"
  | "same-parent";

export interface ReparentNode {
  readonly id: string;
  readonly family: NodeFamily;
  readonly entry: Y.Map<unknown>;
}

/** Where a node's parent pointer LIVES in the epic Y.Doc. */
interface EpicNodeMaps {
  readonly artifacts: Y.Map<unknown> | null;
  readonly chats: Y.Map<unknown> | null;
  readonly tuiAgents: Y.Map<unknown> | null;
}

function resolveEpicNodeMaps(doc: Y.Doc): EpicNodeMaps {
  return {
    artifacts: getArtifactsMap(doc),
    chats: getChatsMap(doc),
    tuiAgents: getTerminalAgentsMap(doc),
  };
}

function mapEntry(
  map: Y.Map<unknown> | null,
  nodeId: string,
): Y.Map<unknown> | null {
  if (map === null) return null;
  const value = map.get(nodeId);
  if (value instanceof Y.Map) return value;
  return null;
}

function resolveNodeInMaps(
  maps: EpicNodeMaps,
  nodeId: string,
): ReparentNode | null {
  const artifactEntry = mapEntry(maps.artifacts, nodeId);
  if (artifactEntry !== null) {
    return { id: nodeId, family: "artifact", entry: artifactEntry };
  }
  const chatEntry = mapEntry(maps.chats, nodeId);
  if (chatEntry !== null) {
    return { id: nodeId, family: "agent", entry: chatEntry };
  }
  const terminalAgentEntry = mapEntry(maps.tuiAgents, nodeId);
  if (terminalAgentEntry !== null) {
    return { id: nodeId, family: "agent", entry: terminalAgentEntry };
  }
  return null;
}

export function resolveReparentNode(
  doc: Y.Doc,
  nodeId: string,
): ReparentNode | null {
  return resolveNodeInMaps(resolveEpicNodeMaps(doc), nodeId);
}

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

/**
 * Where a node's parent pointer LIVES in the epic Y.Doc.
 *
 * This module used to own a doc-based reparent EVALUATOR too, and task 4.3
 * retired it. Resolving nodes out of the doc's `artifacts` / `chats` /
 * `tuiAgents` maps was the whole truth once; it stopped being true at
 * chats-off-YJS and again at the TUI eviction, because a registry-backed chat
 * or terminal agent has no doc entry at all - so the doc evaluator answered
 * `missing-node` for a row the user was plainly dragging, and threw.
 *
 * Every reparent decision - DnD preview, DnD commit, and the store's write
 * path - is now judged by `@/lib/reparent-projection-rules` against the
 * PROJECTED tree, which is the union the sidebar actually renders. Its matrix
 * lives in `lib/__tests__/reparent-projection-rules.test.ts`, ported from this
 * module's suite when the evaluator was removed.
 *
 * What survives here is the one question a projection cannot answer: given a
 * node id, which `Y.Map` entry does a local write go to? A node with no entry
 * is registry-backed, and `epic.reparentChat` owns its pointer instead.
 *
 * `NodeFamily` and `ReparentRejectionReason` stay because both surfaces share
 * that vocabulary.
 */
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

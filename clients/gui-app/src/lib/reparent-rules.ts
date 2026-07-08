import * as Y from "yjs";
import { CrossFamilyParentError } from "@/lib/errors/cross-family-parent-error";
import { MissingNodeError } from "@/lib/errors/missing-node-error";
import { ReparentCycleError } from "@/lib/errors/reparent-cycle-error";
import {
  getArtifactsMap,
  getChatsMap,
  getTerminalAgentsMap,
} from "@/stores/epics/open-epic/projection-helpers";

export type NodeFamily = "artifact" | "agent";
export type ReparentRejectionReason =
  "missing-node" | "cross-panel" | "cycle" | "same-parent";

export interface ReparentNode {
  readonly id: string;
  readonly family: NodeFamily;
  readonly entry: Y.Map<unknown>;
}

export type ReparentEvaluation =
  | {
      readonly ok: true;
      readonly node: ReparentNode;
      readonly parent: ReparentNode | null;
    }
  | {
      readonly ok: false;
      readonly reason: ReparentRejectionReason;
    };

/**
 * The three epic node maps resolved ONCE. `evaluateReparent` and the descendant
 * walk probe a node across all three maps per ancestor on every DnD hover tick;
 * caching the sub-maps here avoids re-reading `doc.getMap("epic").get(<map>)`
 * for every probe of every node on the chain.
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

export function evaluateReparent(
  doc: Y.Doc,
  nodeId: string,
  newParentId: string | null,
): ReparentEvaluation {
  const maps = resolveEpicNodeMaps(doc);
  const node = resolveNodeInMaps(maps, nodeId);
  if (node === null) return { ok: false, reason: "missing-node" };

  // Validate the proposed parent BEFORE the same-parent short-circuit so that
  // re-dropping a node onto a corrupt cross-family / missing `currentParentId`
  // surfaces the real reason instead of being masked as a silent same-parent
  // no-op.
  let parent: ReparentNode | null = null;
  if (newParentId !== null) {
    if (newParentId === nodeId) return { ok: false, reason: "cycle" };
    parent = resolveNodeInMaps(maps, newParentId);
    if (parent === null) return { ok: false, reason: "missing-node" };
    if (parent.family !== node.family) {
      return { ok: false, reason: "cross-panel" };
    }
    if (isDescendantOf(maps, parent.id, nodeId)) {
      return { ok: false, reason: "cycle" };
    }
  }

  if (readParentId(node.entry) === newParentId) {
    return { ok: false, reason: "same-parent" };
  }
  return { ok: true, node, parent };
}

export function reparentRejectionError(
  doc: Y.Doc,
  reason: ReparentRejectionReason,
  nodeId: string,
  newParentId: string | null,
): Error {
  if (reason === "missing-node") {
    const missingRole =
      resolveReparentNode(doc, nodeId) === null ? "node" : "parent";
    return new MissingNodeError(
      missingRole === "node" ? nodeId : (newParentId ?? ""),
      missingRole,
    );
  }
  if (reason === "cycle") {
    return new ReparentCycleError(nodeId, newParentId ?? nodeId);
  }
  if (reason === "cross-panel") {
    return new CrossFamilyParentError(nodeId, newParentId ?? "");
  }
  return new Error(`Cannot reparent ${nodeId}: node already has that parent.`);
}

/**
 * True when `ancestorId` lies on `candidateId`'s parent chain (i.e. nesting a
 * node under `candidateId` would form a cycle). A revisit means the chain loops
 * WITHOUT reaching `ancestorId`, so it returns false - which keeps a node
 * trapped in a pre-existing `parentId` cycle reparentable OUT of it, and never
 * falsely flags an unrelated move whose chain merely passes through a cycle.
 */
function isDescendantOf(
  maps: EpicNodeMaps,
  candidateId: string,
  ancestorId: string,
): boolean {
  let currentId: string | null = candidateId;
  const visitedIds = new Set<string>();

  while (currentId !== null) {
    if (currentId === ancestorId) return true;
    if (visitedIds.has(currentId)) return false;
    visitedIds.add(currentId);

    const currentNode = resolveNodeInMaps(maps, currentId);
    if (currentNode === null) return false;
    currentId = readParentId(currentNode.entry);
  }

  return false;
}

function readParentId(entry: Y.Map<unknown>): string | null {
  const value = entry.get("parentId");
  return typeof value === "string" ? value : null;
}

import { CrossFamilyParentError } from "@/lib/errors/cross-family-parent-error";
import { MissingNodeError } from "@/lib/errors/missing-node-error";
import { ReparentCycleError } from "@/lib/errors/reparent-cycle-error";
import type { NodeFamily, ReparentRejectionReason } from "@/lib/reparent-rules";
import type {
  EpicTreeNodeType,
  TreeSlice,
} from "@/stores/epics/open-epic/types";

/**
 * The reparent rules evaluated against the PROJECTED tree rather than the
 * epic Y.Doc's maps.
 *
 * `@/lib/reparent-rules` resolves nodes straight out of the doc's
 * `artifacts` / `chats` / `tuiAgents` maps, which was the whole truth while
 * every node lived there. It no longer is: chats became host-owned registry
 * records (chats-off-YJS) and terminal agents follow them (the TUI
 * eviction), so a registry-backed agent has NO doc entry and the doc-based
 * evaluator answers `missing-node` for a row that is plainly on screen. The
 * projected `TreeSlice` is the union the sidebar actually renders - doc
 * entries, registry rows, pending creations - so it is the only surface that
 * can say whether a drop is legal for every node the user can grab.
 *
 * Same four verdicts as the doc evaluator, same order, so the DnD preview
 * and commit keep their existing contract:
 *   - `missing-node`  - the node, or the named parent, is not in the tree
 *   - `cross-panel`   - artifact <-> agent in either direction
 *   - `cycle`         - the parent is the node or one of its descendants
 *   - `same-parent`   - the node already has that parent (a silent no-op)
 */
export interface ProjectedReparentNode {
  readonly id: string;
  readonly family: NodeFamily;
  readonly type: EpicTreeNodeType;
  readonly parentId: string | null;
}

export type ProjectedReparentEvaluation =
  | {
      readonly ok: true;
      readonly node: ProjectedReparentNode;
      readonly parent: ProjectedReparentNode | null;
    }
  | {
      readonly ok: false;
      readonly reason: ReparentRejectionReason;
    };

export function nodeFamilyOf(type: EpicTreeNodeType): NodeFamily {
  return type === "chat" || type === "terminal-agent" ? "agent" : "artifact";
}

export function resolveProjectedReparentNode(
  tree: TreeSlice,
  nodeId: string,
): ProjectedReparentNode | null {
  if (!Object.hasOwn(tree.nodeById, nodeId)) return null;
  const node = tree.nodeById[nodeId];
  return {
    id: node.id,
    family: nodeFamilyOf(node.type),
    type: node.type,
    parentId: node.parentId,
  };
}

export function evaluateProjectedReparent(
  tree: TreeSlice,
  nodeId: string,
  newParentId: string | null,
): ProjectedReparentEvaluation {
  const node = resolveProjectedReparentNode(tree, nodeId);
  if (node === null) return { ok: false, reason: "missing-node" };

  // Validate the proposed parent BEFORE the same-parent short-circuit, for
  // the reason the doc evaluator does: re-dropping onto a corrupt parent
  // must surface the real reason, not hide behind a silent no-op.
  let parent: ProjectedReparentNode | null = null;
  if (newParentId !== null) {
    if (newParentId === nodeId) return { ok: false, reason: "cycle" };
    parent = resolveProjectedReparentNode(tree, newParentId);
    if (parent === null) return { ok: false, reason: "missing-node" };
    if (parent.family !== node.family) {
      return { ok: false, reason: "cross-panel" };
    }
    if (isProjectedDescendantOf(tree, parent.id, nodeId)) {
      return { ok: false, reason: "cycle" };
    }
  }

  if (node.parentId === newParentId) {
    return { ok: false, reason: "same-parent" };
  }
  return { ok: true, node, parent };
}

export function canReparentProjected(
  tree: TreeSlice,
  nodeId: string,
  newParentId: string | null,
): ProjectedReparentEvaluation {
  return evaluateProjectedReparent(tree, nodeId, newParentId);
}

/**
 * The projected twin of `reparentRejectionError`, so a rejection is described
 * by the SAME surface that judged it.
 *
 * Building the doc-based error for a projected rejection would report the
 * wrong thing: its `missingRole` probe asks the DOC whether the node exists,
 * and for a registry-backed row the answer is always "no" - so every
 * projected rejection would blame the node, even when the tree's actual
 * complaint was the parent. `same-parent` is never routed here; it is a
 * silent no-op at every call site.
 */
export function projectedReparentRejectionError(
  tree: TreeSlice,
  reason: ReparentRejectionReason,
  nodeId: string,
  newParentId: string | null,
): Error {
  if (reason === "missing-node") {
    const missingRole =
      resolveProjectedReparentNode(tree, nodeId) === null ? "node" : "parent";
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
 * Whether `candidateId` is `ancestorId` or sits below it, walking the
 * PROJECTED parent pointers. The projector already promotes unknown and
 * cross-family parents to root, so a walk here terminates at `null` or at a
 * revisit - the visited set is belt-and-braces against a pointer cycle that
 * arrived from a peer's doc before the projector had a say.
 */
function isProjectedDescendantOf(
  tree: TreeSlice,
  candidateId: string,
  ancestorId: string,
): boolean {
  let currentId: string | null = candidateId;
  const visited = new Set<string>();
  while (currentId !== null) {
    if (currentId === ancestorId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    currentId = Object.hasOwn(tree.nodeById, currentId)
      ? tree.nodeById[currentId].parentId
      : null;
  }
  return false;
}

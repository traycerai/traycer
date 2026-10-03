import {
  artifactProjectionsEq,
  chatProjectionsEq,
  terminalAgentProjectionsEq,
  treeNodesEq,
  arrayShallowEq,
  collectRawTreeRecords,
  type EpicRawProjectionSources,
  type ProjectionInputs,
  type RawTreeRecord,
} from "../projection-helpers";
import type { EpicProjectedSlices, TreeSlice, TreeNode } from "../types";
import { DEFAULT_SORT_MODE, makeNodeComparator } from "@/lib/epic-sort";
import {
  changedTableIds,
  markTableChanges,
  replaceSliceRows,
} from "./projection-table-changes";

export interface EpicProjectionBaseline {
  readonly raw: EpicRawProjectionSources;
  readonly inputs: ProjectionInputs;
  readonly userId: string | null;
  readonly hadOverlay: boolean;
}

interface RowSlice<T> {
  readonly byId: Readonly<Record<string, T>>;
  readonly allIds: readonly string[];
}

function changedRows<T extends { readonly parentId: string | null }>(
  before: RowSlice<T>,
  next: RowSlice<T>,
): RowSlice<T> | null {
  if (before.allIds !== next.allIds) return null;
  const ids = changedTableIds(before.byId, next.byId);
  if (ids === null) return null;
  for (const id of ids) {
    if (
      !Object.hasOwn(before.byId, id) ||
      !Object.hasOwn(next.byId, id) ||
      before.byId[id].parentId !== next.byId[id].parentId
    )
      return null;
  }
  return { byId: next.byId, allIds: [...ids] };
}

const compareNodes = makeNodeComparator(DEFAULT_SORT_MODE);

function updateTree(
  previous: TreeSlice,
  rows: readonly RawTreeRecord[],
): TreeSlice | null {
  const replacements: Record<string, TreeNode> = {};
  const parents = new Set<string | null>();
  for (const row of rows) {
    const held = previous.nodeById[row.id];
    if (!Object.hasOwn(previous.nodeById, row.id) || held.type !== row.type)
      return null;
    const next = {
      ...held,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (treeNodesEq(held, next)) continue;
    replacements[row.id] = next;
    parents.add(held.parentId);
  }
  const ids = Object.keys(replacements);
  if (ids.length === 0) return previous;
  const nodeById = markTableChanges(
    previous.nodeById,
    { ...previous.nodeById, ...replacements },
    ids,
  );
  const children: Record<string, readonly string[]> = {};
  let rootIds = previous.rootIds;
  for (const parent of parents) {
    if (parent !== null && !Object.hasOwn(previous.childrenByParent, parent))
      return null;
    const held =
      parent === null ? previous.rootIds : previous.childrenByParent[parent];
    const sorted = [...held].sort((a, b) =>
      compareNodes(nodeById[a], nodeById[b]),
    );
    if (arrayShallowEq(held, sorted)) continue;
    if (parent === null) rootIds = sorted;
    else children[parent] = sorted;
  }
  const changedParents = Object.keys(children);
  return {
    nodeById,
    rootIds,
    childrenByParent:
      changedParents.length === 0
        ? previous.childrenByParent
        : markTableChanges(
            previous.childrenByParent,
            { ...previous.childrenByParent, ...children },
            changedParents,
          ),
  };
}

function needsFullProjection(
  before: EpicProjectionBaseline,
  next: EpicProjectionBaseline,
): boolean {
  return (
    before.userId !== next.userId ||
    before.hadOverlay ||
    next.hadOverlay ||
    before.inputs.docArm.chats ||
    before.inputs.docArm.tuiAgents ||
    next.inputs.docArm.chats ||
    next.inputs.docArm.tuiAgents ||
    before.raw.roleClaims !== next.raw.roleClaims ||
    before.raw.deletedArtifacts !== next.raw.deletedArtifacts
  );
}

/** Stable membership permits row replacement and sorting only touched branches. */
export function projectIncrementalEpic(
  previous: EpicProjectedSlices,
  before: EpicProjectionBaseline,
  next: EpicProjectionBaseline,
): EpicProjectedSlices | null {
  if (needsFullProjection(before, next)) return null;
  const artifacts = changedRows(before.raw.artifacts, next.raw.artifacts);
  const chats = changedRows(before.inputs.chatRecords, next.inputs.chatRecords);
  const agents = changedRows(
    before.inputs.tuiAgentRecords,
    next.inputs.tuiAgentRecords,
  );
  if (artifacts === null || chats === null || agents === null) return null;
  const nextArtifacts = replaceSliceRows(
    previous.artifacts,
    artifacts,
    artifactProjectionsEq,
  );
  const nextChats = replaceSliceRows(previous.chats, chats, chatProjectionsEq);
  const nextAgents = replaceSliceRows(
    previous.tuiAgents,
    agents,
    terminalAgentProjectionsEq,
  );
  if (nextArtifacts === null || nextChats === null || nextAgents === null)
    return null;
  const tree = updateTree(
    previous.tree,
    collectRawTreeRecords(artifacts, chats, agents),
  );
  if (tree === null) return null;
  return {
    ...previous,
    epic: next.raw.epicHeader,
    artifacts: nextArtifacts,
    chats: nextChats,
    tuiAgents: nextAgents,
    tree,
  };
}

import { buildEpicNodeTree } from "@/lib/artifacts/node-display";
import type { EpicNodeKind } from "@/lib/artifacts/node-display";
import type { TreeNodeNested } from "@/lib/tree-types";
import { isOpenableEpicNodeKind } from "@/stores/epics/canvas/types";

export interface AutoOpenRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly type: EpicNodeKind;
  readonly hostId: string;
}

/**
 * Last-activity clock per node id, for the rows that have one.
 *
 * Only agent rows (chats, terminal-agents) carry activity; artifact rows
 * (spec / ticket / story / review) are ABSENT from this map rather than mapped
 * to `0`, because "never had an activity clock" and "last active at the epoch"
 * must not rank alike. An empty map is the legal "no recency available for this
 * epic" input.
 */
export type AutoOpenRecencyByNodeId = Readonly<Record<string, number>>;

interface AutoOpenTarget {
  readonly id: string;
  readonly type:
    | "chat"
    | "terminal-agent"
    | "spec"
    | "ticket"
    | "story"
    | "review";
  readonly name: string;
  readonly hostId: string;
}

// Plain terminals are renderer-only and never live in the cloud-backed records
// auto-open consumes, so they stay excluded. Terminal-agents (TUI agents) ARE
// record-backed and openable, so focusing one - e.g. from the resource monitor -
// must resolve to that agent rather than falling back to an arbitrary chat.
function isAutoOpenableKind(
  type: EpicNodeKind,
): type is AutoOpenTarget["type"] {
  return (
    type === "chat" ||
    type === "terminal-agent" ||
    type === "spec" ||
    type === "ticket" ||
    type === "story" ||
    type === "review"
  );
}

/**
 * Which node an epic lands on.
 *
 * The order is explicit focus, then this device's remembered focus, then the
 * epic's most recently active agent row, then the first openable node in tree
 * order. The third step is what a device with nothing persisted for this epic
 * hits - a task created on one machine and opened for the first time on
 * another - and tree order there is CREATION order, so without it the landing
 * is the oldest node in the task rather than the one being worked in.
 *
 * `recencyByNodeId` is data, not a source: this resolver never reads a store,
 * so an epic whose projection has produced no agent rows yet is expressed by
 * passing an empty map, and the resolution degrades to the tree-first
 * behaviour rather than waiting on anything.
 */
export function resolveAutoOpenTarget(
  records: ReadonlyArray<AutoOpenRecord>,
  focusArtifactId: string | null,
  persistedFocus: string | null,
  recencyByNodeId: AutoOpenRecencyByNodeId,
): AutoOpenTarget | null {
  if (focusArtifactId !== null) {
    return findOpenableRecord(records, focusArtifactId);
  }

  const persistedMatch = findOpenableRecord(records, persistedFocus);
  if (persistedMatch !== null) return persistedMatch;

  const mostRecent = findMostRecentlyActiveInTree(records, recencyByNodeId);
  if (mostRecent !== null) return mostRecent;

  return findFirstOpenableInTree(records);
}

function findOpenableRecord(
  records: ReadonlyArray<AutoOpenRecord>,
  artifactId: string | null,
): AutoOpenTarget | null {
  if (artifactId === null) return null;
  const match = records.find((record) => record.id === artifactId);
  if (match === undefined) return null;
  if (!isOpenableEpicNodeKind(match.type)) return null;
  if (!isAutoOpenableKind(match.type)) return null;
  return {
    id: match.id,
    type: match.type,
    name: match.name,
    hostId: match.hostId,
  };
}

function findFirstOpenableInTree(
  records: ReadonlyArray<AutoOpenRecord>,
): AutoOpenTarget | null {
  const tree = buildEpicNodeTree(records);
  return walkTree(tree, () => true);
}

/**
 * The openable node carrying the epic's highest recency stamp, or `null` when
 * no openable node has one.
 *
 * Resolved in two passes - find the winning stamp, then take the first node in
 * TREE order that carries it - so nodes sharing the newest stamp resolve to
 * the same node the tree-first fallback would have chosen. The alternative, a
 * single pass over `records`, would break ties by the record array's own
 * grouping (chats, then terminal-agents, then artifacts), which is not an
 * order any surface shows.
 */
function findMostRecentlyActiveInTree(
  records: ReadonlyArray<AutoOpenRecord>,
  recencyByNodeId: AutoOpenRecencyByNodeId,
): AutoOpenTarget | null {
  let newestAt: number | null = null;
  for (const record of records) {
    if (!isOpenableEpicNodeKind(record.type)) continue;
    if (!isAutoOpenableKind(record.type)) continue;
    if (!Object.hasOwn(recencyByNodeId, record.id)) continue;
    const activeAt = recencyByNodeId[record.id];
    if (newestAt === null || activeAt > newestAt) {
      newestAt = activeAt;
    }
  }
  if (newestAt === null) return null;
  const winningAt = newestAt;
  return walkTree(
    buildEpicNodeTree(records),
    (nodeId) =>
      Object.hasOwn(recencyByNodeId, nodeId) &&
      recencyByNodeId[nodeId] === winningAt,
  );
}

function walkTree(
  nodes: ReadonlyArray<
    TreeNodeNested<{
      readonly name: string;
      readonly type: AutoOpenRecord["type"];
      readonly hostId: string;
    }>
  >,
  accepts: (nodeId: string) => boolean,
): AutoOpenTarget | null {
  for (const node of nodes) {
    const nodeType = node.data.type;
    if (
      isOpenableEpicNodeKind(nodeType) &&
      isAutoOpenableKind(nodeType) &&
      accepts(node.id)
    ) {
      return {
        id: node.id,
        type: nodeType,
        name: node.data.name,
        hostId: node.data.hostId,
      };
    }
    const nested = node.children ?? [];
    if (nested.length === 0) continue;
    const childMatch = walkTree(nested, accepts);
    if (childMatch !== null) return childMatch;
  }
  return null;
}

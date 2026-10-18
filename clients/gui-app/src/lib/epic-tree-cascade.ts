import type { EpicTreeRecord } from "@/lib/epic-selectors";
import type { TreeSlice } from "@/stores/epics/open-epic/types";

export interface DescendantCounts {
  readonly spec: number;
  readonly ticket: number;
  readonly story: number;
  readonly review: number;
  readonly html: number;
  readonly canvas: number;
  readonly file: number;
  readonly chat: number;
  readonly "terminal-agent": number;
}

/**
 * BFS over the flat EpicTreeRecord list to count all descendants of
 * `rootId` by type. The unified record list covers both artifacts and
 * chats, so one pass handles all cascade-delete scenarios.
 *
 * Returns zero counts when `rootId` has no children. The root node
 * itself is NOT counted - only its descendants.
 */
export function computeDescendantCounts(
  records: ReadonlyArray<EpicTreeRecord>,
  rootId: string,
): DescendantCounts {
  const counts: { -readonly [K in keyof DescendantCounts]: number } = {
    spec: 0,
    ticket: 0,
    story: 0,
    review: 0,
    html: 0, canvas: 0, file: 0,
    chat: 0,
    "terminal-agent": 0,
  };
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift();
    if (parentId === undefined) break;
    for (const record of records) {
      if (record.parentId !== parentId) continue;
      counts[record.type] += 1;
      queue.push(record.id);
    }
  }
  return counts;
}

/**
 * Tree-structure variant of `computeDescendantCounts`. Walks the canonical
 * parent -> children index instead of the flat record list, so a caller does
 * NOT have to subscribe to the churning artifact-records projection (which the
 * sidebar nodes re-render against on every chat-stream token). The tree's
 * `parentId`/`type` are the normalised,
 * authoritative structure the sidebar already renders, so the counts match what
 * the user sees. `TreeNode.type` is `EpicTreeNodeType`, which is exactly
 * `keyof DescendantCounts`, so the indexing is total.
 */
export function computeDescendantCountsFromTree(
  tree: TreeSlice,
  rootId: string,
): DescendantCounts {
  const counts: { -readonly [K in keyof DescendantCounts]: number } = {
    spec: 0,
    ticket: 0,
    story: 0,
    review: 0,
    html: 0, canvas: 0, file: 0,
    chat: 0,
    "terminal-agent": 0,
  };
  const queue: string[] = [rootId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const parentId = queue.shift();
    if (parentId === undefined) break;
    const children = Object.hasOwn(tree.childrenByParent, parentId)
      ? tree.childrenByParent[parentId]
      : [];
    for (const childId of children) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      if (Object.hasOwn(tree.nodeById, childId)) {
        counts[tree.nodeById[childId].type] += 1;
      }
      queue.push(childId);
    }
  }
  return counts;
}

/**
 * Build a human-readable cascade summary string from counts, e.g.
 * "3 specs, 2 tickets, and 1 agent". Returns null when there are no
 * descendants (the confirm dialog omits the cascade line).
 *
 * Chat and terminal-agent descendants aggregate into a single **agent** bucket:
 * Agent is the durable entity and Chat/Terminal are only the interfaces used to
 * interact with it, so a mixed selection reads "2 agents" rather than the
 * entity-splitting "1 chat and 1 terminal agent". Each entry therefore names a
 * SET of node kinds rather than one.
 */
const CASCADE_LABELS: ReadonlyArray<{
  readonly keys: ReadonlyArray<keyof DescendantCounts>;
  readonly singular: string;
  readonly plural: string;
}> = [
  { keys: ["spec"], singular: "spec", plural: "specs" },
  { keys: ["ticket"], singular: "ticket", plural: "tickets" },
  { keys: ["story"], singular: "story", plural: "stories" },
  { keys: ["review"], singular: "review", plural: "reviews" },
  { keys: ["html"], singular: "page", plural: "pages" },
  { keys: ["canvas"], singular: "canvas", plural: "canvases" },
  { keys: ["file"], singular: "file", plural: "files" },
  { keys: ["chat", "terminal-agent"], singular: "agent", plural: "agents" },
];

export function formatCascadeSummary(counts: DescendantCounts): string | null {
  const parts = CASCADE_LABELS.flatMap((label) => {
    const n = label.keys.reduce((total, key) => total + counts[key], 0);
    if (n <= 0) return [];
    return [`${n} ${n === 1 ? label.singular : label.plural}`];
  });
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/**
 * How many agents are DIRECT children of `nodeId`: the ones that move to the
 * top level when it is deleted. Grandchildren are not counted - they stay under
 * their own, kept, parent. Artifacts never nest under agents, so only the two
 * agent kinds count.
 */
export function countDirectAgentChildren(
  tree: TreeSlice,
  nodeId: string,
): number {
  if (!Object.hasOwn(tree.childrenByParent, nodeId)) return 0;
  let count = 0;
  for (const childId of tree.childrenByParent[nodeId]) {
    if (!Object.hasOwn(tree.nodeById, childId)) continue;
    const { type } = tree.nodeById[childId];
    if (type === "chat" || type === "terminal-agent") count += 1;
  }
  return count;
}

/**
 * Sentence for an AGENT row's delete dialog, or null when it has no nested
 * agents. Deleting an agent removes that one record only: its direct children
 * are kept and the tree draws them at the top level, so the dialog says that
 * instead of the cascade sentence an artifact row gets from
 * `formatCascadeSummary`.
 */
export function formatAgentDeleteNesting(
  nestedAgentCount: number,
): string | null {
  if (nestedAgentCount <= 0) return null;
  return `${nestedAgentCount} ${nestedAgentCount === 1 ? "agent" : "agents"} nested under it will be kept and moved to the top level.`;
}

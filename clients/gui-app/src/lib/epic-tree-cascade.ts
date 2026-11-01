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
    html: 0,
    canvas: 0,
    file: 0,
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
 * What a whole SELECTION destroys BEYOND the rows the reader picked: every
 * descendant of every selected node, minus the selected nodes themselves.
 *
 * Tree-structure variant of `computeDescendantCounts`. Walks the canonical
 * parent -> children index instead of the flat record list, so a caller does
 * NOT have to subscribe to the churning artifact-records projection (which the
 * sidebar nodes re-render against on every chat-stream token). The tree's
 * `parentId`/`type` are the normalised,
 * authoritative structure the sidebar already renders, so the counts match what
 * the user sees. `TreeNode.type` is `EpicTreeNodeType`, which is exactly
 * `keyof DescendantCounts`, so the indexing is total.
 *
 * Subtracting the selection is what "will ALSO delete" means, and it is why
 * this is not a sum of per-root walks: a selected child is a row the reader
 * already named, so counting it again would promise extra destruction that is
 * really the same record. Seeding `seen` with the selection is the whole of
 * that subtraction, and it costs the selected node's own subtree nothing -
 * every selected id is in the queue as a ROOT, so the walk reaches that
 * subtree from there and counts it. The same `seen` makes a node reached from
 * two selected roots count once.
 */
function computeSelectionCascadeCounts(
  tree: TreeSlice,
  nodeIds: readonly string[],
): DescendantCounts {
  const counts: { -readonly [K in keyof DescendantCounts]: number } = {
    spec: 0,
    ticket: 0,
    story: 0,
    review: 0,
    html: 0,
    canvas: 0,
    file: 0,
    chat: 0,
    "terminal-agent": 0,
  };
  const selected = new Set(nodeIds);
  const queue: string[] = [...selected];
  const seen = new Set<string>(selected);
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

/** Artifacts never nest under agents, so only the two agent kinds count. */
function isAgentNode(tree: TreeSlice, nodeId: string): boolean {
  if (!Object.hasOwn(tree.nodeById, nodeId)) return false;
  const { type } = tree.nodeById[nodeId];
  return type === "chat" || type === "terminal-agent";
}

/**
 * How many agents a whole SELECTION promotes to the top level: the agents
 * whose parent is being deleted and which are not being deleted themselves.
 *
 * That exclusion is the reason this is not a per-row sum of direct agent
 * children. A child selected alongside its parent is deleted, not promoted, so
 * counting it would overstate what survives; and a grandchild whose parent is
 * selected IS promoted, which the same rule gives for free, since its parent is
 * the one going away. `nodeIds` is read as a set, so a repeated id cannot count
 * a child twice.
 *
 * One selected row is the same rule with a one-element set, which is why a
 * row's own menu asks this too rather than keeping a single-node twin.
 */
function countPromotedAgentChildren(
  tree: TreeSlice,
  nodeIds: readonly string[],
): number {
  const deleted = new Set(nodeIds);
  let count = 0;
  for (const nodeId of deleted) {
    if (!Object.hasOwn(tree.childrenByParent, nodeId)) continue;
    for (const childId of tree.childrenByParent[nodeId]) {
      if (deleted.has(childId)) continue;
      if (isAgentNode(tree, childId)) count += 1;
    }
  }
  return count;
}

/** Both halves of what a delete dialog says about nested rows. */
export interface TreeDeleteDisclosure {
  /** The dialog's description paragraph. */
  readonly description: string;
  /**
   * The dialog's cascade paragraph - what is destroyed BEYOND the rows picked
   * - or null when no count is owed.
   */
  readonly cascadeSummary: string | null;
  /** Whether that paragraph addresses one row or a selection. */
  readonly cascadeNestedUnder: "it" | "them";
}

export interface TreeDeleteDisclosureInput {
  readonly tree: TreeSlice;
  /**
   * What the rows being deleted ARE, which is what decides what the delete
   * does to whatever hangs off them. Deleting an AGENT removes that one
   * record: its nested agents are kept and the tree redraws them at the top
   * level. Deleting an ARTIFACT takes its subtree with it.
   */
  readonly kind: "agent" | "artifact";
  /** Read as a set, so a repeated id cannot count a child twice. */
  readonly nodeIds: readonly string[];
  /**
   * Whether every nested row is in the tree yet.
   *
   * False while the record plane has not produced its answer, when a persisted
   * child can be absent from the tree for a window - so a number read off it
   * would be low. The sentence then names the consequence and states no
   * number, which costs the reader the count and never tells them a child does
   * not exist. Deliberately not a GATE: a row that is visible and selectable,
   * with a working delete beside it, must stay deletable.
   */
  readonly nestedRowsKnown: boolean;
}

/**
 * The whole disclosure a delete dialog shows, for every route that deletes
 * sidebar rows: a row's own menu and select mode both ask here, for agents and
 * for artifacts alike.
 *
 * It is one function because the dialogs disagreeing is the defect it was
 * written for, twice over. Select mode showed the agent sentence's first half
 * and dropped the second; and a single selected ARTIFACT got no count at all
 * while its own row menu named one, for the same record. Every route composing
 * the same sentences for itself is what let that happen, so none of them
 * composes anything now.
 *
 * It reads the FULL tree, never the panel's filtered view: the delete acts on
 * the records, so an agent an archive or interface filter is hiding is still
 * promoted and still counted. The sentence stays true - the row is kept and
 * moved to the top level, and the filter is what hides it.
 */
export function describeTreeDeleteDisclosure(
  input: TreeDeleteDisclosureInput,
): TreeDeleteDisclosure {
  const nodeIds = new Set(input.nodeIds);
  const nestedUnder = nodeIds.size === 1 ? "it" : "them";
  const nested = describeNestedRows(input, nodeIds.size, nestedUnder);
  // The one place the undone sentence is joined to anything. Two call sites
  // each joining it their own way is what let the dialogs drift apart.
  return {
    description:
      nested.sentence === null
        ? DELETE_UNDONE
        : `${DELETE_UNDONE} ${nested.sentence}`,
    cascadeSummary: nested.cascadeSummary,
    cascadeNestedUnder: nestedUnder,
  };
}

const DELETE_UNDONE = "This action cannot be undone.";

/**
 * What is owed about the rows nested under a selection: a sentence for the
 * description, a count for the cascade paragraph, or neither.
 *
 * At most one of the two is ever set. A promoted agent is not destroyed, so it
 * must never reach the cascade paragraph ("This will also delete…"); and a
 * cascade count is a phrase the dialog puts in its own sentence, so it is not
 * composed here.
 */
interface NestedRowsDisclosure {
  readonly sentence: string | null;
  readonly cascadeSummary: string | null;
}

const NOTHING_NESTED: NestedRowsDisclosure = Object.freeze({
  sentence: null,
  cascadeSummary: null,
});

function describeNestedRows(
  input: TreeDeleteDisclosureInput,
  selectedCount: number,
  nestedUnder: "it" | "them",
): NestedRowsDisclosure {
  if (selectedCount === 0) return NOTHING_NESTED;
  if (!input.nestedRowsKnown) {
    return {
      sentence:
        input.kind === "agent"
          ? `Any agents nested under ${nestedUnder} will be kept and moved to the top level.`
          : `Anything nested under ${nestedUnder} will also be deleted.`,
      cascadeSummary: null,
    };
  }
  if (input.kind === "artifact") {
    return {
      sentence: null,
      cascadeSummary: formatCascadeSummary(
        computeSelectionCascadeCounts(input.tree, input.nodeIds),
      ),
    };
  }
  const promoted = countPromotedAgentChildren(input.tree, input.nodeIds);
  if (promoted === 0) return NOTHING_NESTED;
  const agents = promoted === 1 ? "agent" : "agents";
  return {
    sentence: `${promoted} ${agents} nested under ${nestedUnder} will be kept and moved to the top level.`,
    cascadeSummary: null,
  };
}

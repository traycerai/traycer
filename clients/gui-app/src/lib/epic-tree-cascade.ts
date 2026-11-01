import { isEpicArtifactKind } from "@/lib/artifacts/node-display";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";
import type { TreeSlice } from "@/stores/epics/open-epic/types";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";

type CascadeCounts = Record<EpicArtifactKind, number>;

/**
 * What a whole SELECTION destroys BEYOND the rows the reader picked: every
 * descendant of every selected node, minus the selected nodes themselves.
 *
 * Walks the canonical parent -> children index, not the flat record list, so a
 * caller does NOT have to subscribe to the churning artifact-records projection
 * (which the sidebar nodes re-render against on every chat-stream token). The
 * tree's `parentId`/`type` are the normalised, authoritative structure the
 * sidebar already renders, so the counts match what the user sees.
 *
 * Subtracting the selection is what "will ALSO delete" means, and it is why
 * this is not a sum of per-root walks: a selected child is a row the reader
 * already named, so counting it again would promise extra destruction that is
 * really the same record. Seeding `seen` with the selection is the whole of
 * that subtraction, and it costs the selected node's own subtree nothing -
 * every selected id is in the queue as a ROOT, so the walk reaches that
 * subtree from there and counts it. The same `seen` makes a node reached from
 * two selected roots count once.
 *
 * The projected tree is FAMILY-SEPARATED - `resolveEffectiveParent` promotes a
 * cross-family parent to the root, so an artifact's subtree holds only
 * artifacts and no agent can reach these counts. That is also what the delete
 * does: it scans artifacts alone, so an agent whose `parentId` corruptly names
 * an artifact outlives it. That separation is what makes the artifact
 * disclosure a question about doc-sourced records only; the kind check below
 * narrows the node type and turns nothing away.
 */
function computeSelectionCascadeCounts(
  tree: TreeSlice,
  nodeIds: readonly string[],
): CascadeCounts {
  const counts: CascadeCounts = {
    spec: 0,
    ticket: 0,
    story: 0,
    review: 0,
    html: 0,
    canvas: 0,
    file: 0,
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
        const { type } = tree.nodeById[childId];
        if (isEpicArtifactKind(type)) counts[type] += 1;
      }
      queue.push(childId);
    }
  }
  return counts;
}

const CASCADE_LABELS: ReadonlyArray<{
  readonly key: EpicArtifactKind;
  readonly singular: string;
  readonly plural: string;
}> = [
  { key: "spec", singular: "spec", plural: "specs" },
  { key: "ticket", singular: "ticket", plural: "tickets" },
  { key: "story", singular: "story", plural: "stories" },
  { key: "review", singular: "review", plural: "reviews" },
  { key: "html", singular: "page", plural: "pages" },
  { key: "canvas", singular: "canvas", plural: "canvases" },
  { key: "file", singular: "file", plural: "files" },
];

/**
 * Build a human-readable cascade summary string from counts, e.g.
 * "3 specs, 2 tickets, and 1 story". Returns null when there are no
 * descendants (the confirm dialog omits the cascade line).
 */
function formatCascadeSummary(counts: CascadeCounts): string | null {
  const parts = CASCADE_LABELS.flatMap((label) => {
    const n = counts[label.key];
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

/**
 * What the rows being deleted ARE, which decides both what the delete does to
 * whatever hangs off them and whether there is a readiness question to ask.
 *
 * The two arms differ in their inputs because they differ in their SOURCE.
 * Deleting an AGENT keeps its nested agents and the tree redraws them at the
 * top level; those nested rows come from the chat/terminal-agent record
 * planes, so whether they have all arrived is a real question. Deleting an
 * ARTIFACT takes its subtree with it, and - the projected tree being
 * family-separated - that subtree is artifacts only, which are doc-sourced.
 * There is no artifact record plane to lag behind, so the artifact arm has no
 * readiness input to take and always states its exact count.
 */
export type TreeDeleteDisclosureInput =
  | {
      readonly tree: TreeSlice;
      readonly kind: "agent";
      /** Read as a set, so a repeated id cannot count a child twice. */
      readonly nodeIds: readonly string[];
      /**
       * Whether every nested agent row is in the tree yet, read through
       * {@link selectNestedAgentsKnown}.
       *
       * False until BOTH `epic.listChatRecords` and `epic.listTuiAgents` have
       * answered - and a transient failure of either leaves it false - because
       * until then a persisted child of that family can be absent from the
       * tree, so a number read off it would be low. The sentence then names
       * the consequence and states no number, which costs the reader the count
       * and never tells them a child does not exist. Deliberately not a GATE:
       * a row that is visible and selectable, with a working delete beside it,
       * must stay deletable.
       */
      readonly nestedAgentsKnown: boolean;
    }
  | {
      readonly tree: TreeSlice;
      readonly kind: "artifact";
      /** Read as a set, so a repeated id cannot count a child twice. */
      readonly nodeIds: readonly string[];
      /**
       * Whether this host serves Deleted artifacts, the gate the tile and its
       * menu item read (`useDeletedArtifactsAvailable`). Without it nothing
       * deleted here can be brought back, so the dialog offers no restore.
       */
      readonly restoreAvailable: boolean;
    };

/**
 * Whether both record lists the agent tree is built from have answered, the
 * one reading of {@link TreeDeleteDisclosureInput}'s `nestedAgentsKnown`.
 *
 * Takes the store state rather than two flags so the pair cannot be read
 * apart: a nested agent is a chat or a terminal agent, and either list alone
 * says nothing about the other family's rows.
 */
export function selectNestedAgentsKnown(
  state: Pick<
    OpenEpicState,
    "chatRecordListAuthoritative" | "tuiAgentRecordListAuthoritative"
  >,
): boolean {
  return (
    state.chatRecordListAuthoritative && state.tuiAgentRecordListAuthoritative
  );
}

/**
 * The whole disclosure a delete dialog shows, for every route that deletes a
 * tree row: a sidebar row's own menu, sidebar select mode and the mobile
 * switcher's row menu all ask here, for agents and for artifacts alike.
 *
 * It is one function because the dialogs disagreeing is the defect it was
 * written for, three times over. Select mode showed the agent sentence's first
 * half and dropped the second; a single selected ARTIFACT got no count at all
 * while its own row menu named one, for the same record; and the switcher
 * walked raw `parentId`, so it promised to delete an agent the delete keeps.
 * Each route composing the same sentences for itself is what let that happen,
 * so none composes anything now.
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
  const cost = describeDeleteCost(input, nodeIds.size);
  // The one place the opening sentence is joined to anything. Two call sites
  // each joining it their own way is what let the dialogs drift apart.
  return {
    description: nested.sentence === null ? cost : `${cost} ${nested.sentence}`,
    cascadeSummary: nested.cascadeSummary,
    cascadeNestedUnder: nestedUnder,
  };
}

const DELETE_UNDONE = "This action cannot be undone.";

/**
 * The opening sentence: what the delete costs the rows the reader picked.
 *
 * An agent's delete is final. An artifact's is not while its host serves
 * Deleted artifacts: the delete leaves one tombstone per artifact and a restore
 * takes one artifact, which is why a selection comes back "one at a time".
 */
function describeDeleteCost(
  input: TreeDeleteDisclosureInput,
  selectedCount: number,
): string {
  if (input.kind === "agent" || !input.restoreAvailable) return DELETE_UNDONE;
  if (selectedCount === 0) return DELETE_UNDONE;
  return selectedCount === 1
    ? "You can bring it back from Deleted artifacts."
    : "You can bring them back one at a time from Deleted artifacts.";
}

/**
 * What is owed about the rows nested under a selection: a sentence for the
 * description, a count for the cascade paragraph, or neither.
 *
 * A promoted agent is not destroyed, so it must never reach the cascade
 * paragraph ("This will also delete…"), and a cascade count is a phrase the
 * dialog puts in its own sentence, so it is not composed here. An artifact arm
 * can set both: the count, and, where the opening sentence offers a restore,
 * the caveat that the restore does not bring nested artifacts with it.
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
  if (input.kind === "artifact") {
    const cascadeSummary = formatCascadeSummary(
      computeSelectionCascadeCounts(input.tree, input.nodeIds),
    );
    return {
      sentence:
        input.restoreAvailable && cascadeSummary !== null
          ? `Artifacts nested under ${nestedUnder} come back separately.`
          : null,
      cascadeSummary,
    };
  }
  // "Any" rather than a number, and the sentence is owed even where the tree
  // shows no children: not knowing how many there are includes not knowing
  // there are none. It costs the reader the count and nothing else, because
  // what it describes is a row being KEPT.
  if (!input.nestedAgentsKnown) {
    return {
      sentence: `Any agents nested under ${nestedUnder} will be kept and moved to the top level.`,
      cascadeSummary: null,
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

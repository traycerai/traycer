import type {
  WorktreeHostEntryV12,
  WorktreePrState,
  WorktreeSubmoduleMergeFactV12,
} from "@traycer/protocol/host/index";

/**
 * True-AND Task merge rollup (merge-provenance plan § Task rollup).
 *
 * A Task (epic) owns a set of branches: the superproject binding branch of every
 * worktree entry it owns, PLUS each of those entries' owned-submodule branches
 * (`entry.submodules[]`). This module rolls that whole set up into ONE honest
 * signal for the Worktrees-page Task chip.
 *
 * The load-bearing rule is TRUE AND: a Task is `merged` only when EVERY owned
 * branch has a HEAD-validated merged PR. A submodule PR that merged before the
 * superproject gitlink bump lands ⇒ `N < M` ⇒ **partial** ("Merged N/M"), NOT
 * merged - because the Task's work isn't fully landed until the superproject
 * branch merges too. Per-row per-repo PR facts (M5's pills) stay independent of
 * this rollup; this only augments the Task chip.
 *
 * We never over-claim: with no PR anywhere in the set (or nothing merged yet) the
 * rollup is `none` and the chip shows no merged indicator - a pre-M4 host or an
 * absent `gh` yields empty `submodules[]` and null PR fields, which degrades here
 * to `none` rather than a crash.
 */
export type TaskMergeRollup =
  | { readonly status: "none" }
  | {
      readonly status: "merged";
      readonly merged: number;
      readonly total: number;
    }
  | {
      readonly status: "partial";
      readonly merged: number;
      readonly total: number;
    };

/**
 * The two fields every owned branch exposes, whether it is the superproject entry
 * or one of its submodule facts. `mergedHeadShaMatches` is the host's live-HEAD
 * comparison, so "merged" here needs no SHA - the same predicate the M5 classifier
 * uses for its `merged (PR)` green.
 */
interface BranchMergeFact {
  readonly prState: WorktreePrState | null;
  readonly mergedHeadShaMatches: boolean;
}

/**
 * Per-branch "merged", applied identically to the superproject entry and each
 * submodule fact: a HEAD-validated merged PR. Anything short of that (open /
 * closed / none / null state, or a merged PR whose live HEAD has moved off the
 * merged SHA) is not merged and never greens the Task.
 */
function branchMerged(fact: BranchMergeFact): boolean {
  return fact.prState === "merged" && fact.mergedHeadShaMatches;
}

/**
 * Whether a branch carries a real PR at all. `null` (probe absent / failed) and
 * `"none"` (probe ran, found no PR) both mean "no PR"; only `open`/`closed`/
 * `merged` count. Used to keep the rollup silent when the whole set has no PR to
 * speak to.
 */
function branchHasPr(fact: BranchMergeFact): boolean {
  return fact.prState !== null && fact.prState !== "none";
}

function submoduleFact(fact: WorktreeSubmoduleMergeFactV12): BranchMergeFact {
  return {
    prState: fact.prState,
    mergedHeadShaMatches: fact.mergedHeadShaMatches,
  };
}

/**
 * Flatten a worktree entry into its owned-branch merge facts: the superproject
 * branch (the entry's own PR fields) followed by each owned submodule.
 */
function entryBranchFacts(
  entry: WorktreeHostEntryV12,
): readonly BranchMergeFact[] {
  return [
    {
      prState: entry.prState,
      mergedHeadShaMatches: entry.mergedHeadShaMatches,
    },
    ...entry.submodules.map(submoduleFact),
  ];
}

/**
 * Roll a Task's owned worktree entries up into a single merge signal. Pass every
 * listing entry the epic owns (the superproject is one branch per entry; each
 * entry contributes its own `submodules[]`). Aggregating across ALL of a Task's
 * entries keeps True-AND honest when a Task spans more than one worktree: the
 * Task is only `merged` once every owned branch across every owned entry landed.
 *
 * `M` = total owned branches, `N` = how many are merged-per-`branchMerged`:
 *  - `N === M` (and `M > 0`) → **merged** (some branch therefore has a merged PR,
 *    so the "has a PR" floor is met implicitly).
 *  - `0 < N < M` → **partial** ("Merged N/M").
 *  - `N === 0` (nothing merged, whether or not an open PR exists) → **none**. We
 *    only ever claim merged progress once at least one branch has actually landed.
 */
export function computeTaskMergeRollup(
  entries: readonly WorktreeHostEntryV12[],
): TaskMergeRollup {
  const facts = entries.flatMap(entryBranchFacts);
  const total = facts.length;
  const merged = facts.filter(branchMerged).length;
  if (merged === 0 || !facts.some(branchHasPr)) return { status: "none" };
  if (merged === total) return { status: "merged", merged, total };
  return { status: "partial", merged, total };
}

/**
 * Build the per-epic rollup map for a host's whole listing. Each epic maps to the
 * True-AND rollup over exactly the entries it owns. An epic appears here iff some
 * entry lists it in `owners`. The Task chip reads this by `epicId`; a Task with no
 * merged progress simply resolves to `none` (or is absent) and shows no indicator.
 */
export function buildTaskMergeRollups(
  worktrees: readonly WorktreeHostEntryV12[],
): ReadonlyMap<string, TaskMergeRollup> {
  const entriesByEpicId = new Map<string, WorktreeHostEntryV12[]>();
  for (const entry of worktrees) {
    for (const epicId of new Set(entry.owners.map((o) => o.epicId))) {
      const bucket = entriesByEpicId.get(epicId);
      if (bucket === undefined) entriesByEpicId.set(epicId, [entry]);
      else bucket.push(entry);
    }
  }
  return new Map(
    [...entriesByEpicId].map(([epicId, entries]) => [
      epicId,
      computeTaskMergeRollup(entries),
    ]),
  );
}

/**
 * Short chip label for a rollup: `Merged` when fully landed, `Merged N/M` when
 * partial, `null` when there's nothing honest to claim (the chip then renders
 * just the Task title).
 */
export function taskMergeRollupLabel(rollup: TaskMergeRollup): string | null {
  if (rollup.status === "merged") return "Merged";
  if (rollup.status === "partial") {
    return `Merged ${rollup.merged}/${rollup.total}`;
  }
  return null;
}

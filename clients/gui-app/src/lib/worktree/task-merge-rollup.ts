import type {
  WorktreeHostEntryV12,
  WorktreePrState,
  WorktreeSubmoduleMergeFactV12,
} from "@traycer/protocol/host/index";

/** True-AND Task merge rollup (merge-provenance plan § Task rollup). */
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
 * The two fields every owned branch exposes, whether it is the superproject entry or one of its submodule facts.
 * `mergedHeadShaMatches` is the host's live-HEAD comparison, so "merged" here needs no SHA - the same predicate the M5 classifier uses for its `merged (PR)` green.
 */
interface BranchMergeFact {
  readonly prState: WorktreePrState | null;
  readonly mergedHeadShaMatches: boolean;
}

/**
 * Per-branch "merged", applied identically to the superproject entry and each submodule fact: a HEAD-validated merged PR.
 * Anything short of that (open / closed / none / null state, or a merged PR whose live HEAD has moved off the merged SHA) is not merged and never greens the Task.
 */
function branchMerged(fact: BranchMergeFact): boolean {
  return fact.prState === "merged" && fact.mergedHeadShaMatches;
}

/**
 * Whether a branch carries a real PR at all.
 * `null` (probe absent / failed) and `"none"` (probe ran, found no PR) both mean "no PR"; only `open`/`closed`/ `merged` count.
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
 * Flatten a worktree entry into its owned-branch merge facts: the superproject branch (the entry's own PR fields) followed by each owned submodule.
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
 * Roll a Task's owned worktree entries up into a single merge signal.
 * Pass every listing entry the epic owns (the superproject is one branch per entry; each entry contributes its own `submodules[]`).
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
 * Build the per-epic rollup map for a host's whole listing.
 * Each epic maps to the True-AND rollup over exactly the entries it owns.
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
 * Value equality for two rollups (the map they live in is rebuilt wholesale on every listing/enrichment pass, so object identity says nothing).
 * Lets a memoized row compare just ITS Tasks' rollups instead of re-rendering on every rebuild of the whole map.
 */
export function taskMergeRollupEqual(
  a: TaskMergeRollup | undefined,
  b: TaskMergeRollup | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.status === "none" || b.status === "none") {
    return a.status === b.status;
  }
  return a.status === b.status && a.merged === b.merged && a.total === b.total;
}

/**
 * Short chip label for a rollup: `Merged` when fully landed, `Merged N/M` when partial, `null` when there's nothing honest to claim (the chip then renders just the Task title).
 */
export function taskMergeRollupLabel(rollup: TaskMergeRollup): string | null {
  if (rollup.status === "merged") return "Merged";
  if (rollup.status === "partial") {
    return `Merged ${rollup.merged}/${rollup.total}`;
  }
  return null;
}

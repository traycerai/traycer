import { describeReviewReasons } from "@traycer-clients/shared/worktree/classify-worktree";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import type { EpicSweepWorktreeRow } from "@/hooks/epic/use-epic-sweep-worktree-candidates-query";
import { formatUnknownHolderConsequence } from "@/lib/worktree/teardown-holder-copy";

export function worktreeIdentity(row: EpicSweepWorktreeRow): string {
  return row.entry.branch ?? row.entry.worktreePath;
}

export function isBulkScopeRow(row: EpicSweepWorktreeRow): boolean {
  if (row.disabled) return false;
  return row.note !== "in-use";
}

export function isElevatedRow(row: EpicSweepWorktreeRow): boolean {
  return (
    row.note === "in-use" || row.note === "not-landed" || row.note === "shared"
  );
}

export function selectionIsSafeOnly(
  rows: ReadonlyArray<EpicSweepWorktreeRow>,
): boolean {
  if (rows.length === 0) return false;
  return rows.every((row) => !isElevatedRow(row));
}

export function selectionHasUnproven(
  rows: ReadonlyArray<EpicSweepWorktreeRow>,
): boolean {
  return rows.some((row) => row.note === "not-landed");
}

export function selectionHasInUse(
  rows: ReadonlyArray<EpicSweepWorktreeRow>,
): boolean {
  return rows.some((row) => row.note === "in-use");
}

export function selectionHasShared(
  rows: ReadonlyArray<EpicSweepWorktreeRow>,
): boolean {
  return rows.some((row) => row.note === "shared");
}

export function finalSweepButtonLabel(
  rows: ReadonlyArray<EpicSweepWorktreeRow>,
): string {
  const inUse = selectionHasInUse(rows);
  const unproven = selectionHasUnproven(rows);
  const shared = selectionHasShared(rows);
  const categories = [inUse, unproven, shared].filter(Boolean).length;
  if (categories > 1) return "Confirm sweep";
  if (inUse) return "Stop work & sweep";
  if (unproven) return "Sweep anyway";
  if (shared) return "Break bindings & sweep";
  return "Sweep selected";
}

export function externalOwnerCount(
  row: EpicSweepWorktreeRow,
  selectedEpicIds: ReadonlySet<string>,
): number {
  return distinctExternalEpicIds([row], selectedEpicIds).length;
}

export function distinctExternalEpicIds(
  rows: ReadonlyArray<EpicSweepWorktreeRow>,
  selectedEpicIds: ReadonlySet<string>,
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const owner of row.entry.owners) {
      if (selectedEpicIds.has(owner.epicId) || seen.has(owner.epicId)) {
        continue;
      }
      seen.add(owner.epicId);
      ids.push(owner.epicId);
    }
  }
  return ids;
}

export function sharedRowHint(
  row: EpicSweepWorktreeRow,
  selectedEpicIds: ReadonlySet<string>,
): string {
  const count = externalOwnerCount(row, selectedEpicIds);
  const unit = count === 1 ? "Task" : "Tasks";
  return `Also used by ${String(count)} ${unit} outside this sweep — their worktree binding will be removed`;
}

export function unprovenRowHint(row: EpicSweepWorktreeRow): string {
  const reasons = describeReviewReasons(row.entry);
  if (reasons.length === 0) {
    return "Not proven landed — work here may be lost.";
  }
  const joined = reasons.join("; ");
  const punctuated = joined.endsWith(".") ? joined : `${joined}.`;
  return `Not proven landed — ${punctuated}`;
}

export function selectAllCountCopy(input: {
  readonly selected: number;
  readonly total: number;
  readonly inUse: number;
}): string {
  const base = `${String(input.selected)} of ${String(input.total)} selected`;
  if (input.inUse === 0) return base;
  const unit = input.inUse === 1 ? "worktree" : "worktrees";
  return `${base} · ${String(input.inUse)} in-use ${unit} require individual selection`;
}

export function safeSummaryCopy(
  worktreeCount: number,
  branchCount: number,
): string {
  const trees = worktreeCount === 1 ? "worktree" : "worktrees";
  const branches = branchCount === 1 ? "branch" : "branches";
  return `${String(worktreeCount)} ${trees} and ${String(branchCount)} local ${branches} will be removed. Nothing is running in them, and no unmerged work was found.`;
}

export function removalSummaryCopy(
  worktreeCount: number,
  branchCount: number,
): { readonly worktrees: string; readonly branches: string } {
  const trees = worktreeCount === 1 ? "worktree" : "worktrees";
  const branchWord = branchCount === 1 ? "branch" : "branches";
  return {
    worktrees: `${String(worktreeCount)} ${trees} will be removed`,
    branches: `${String(branchCount)} local ${branchWord} will be deleted from this host`,
  };
}

export function bindingHeading(taskCount: number): string {
  if (taskCount === 1) return "1 other Task is affected";
  return `${String(taskCount)} other Tasks are affected`;
}

export type SweepSessionOutcomeKind = "uncertain" | "failed";

/**
 * Per-path sweep outcome that outlives the disposable review snapshot
 * (Back, Choose re-render, later HOLDERS_CHANGED receipts).
 */
export interface SweepSessionOutcome {
  readonly kind: SweepSessionOutcomeKind;
  readonly identity: string;
}

export interface SweepReviewSnapshot {
  readonly paths: readonly string[];
  readonly unproven: readonly EpicSweepWorktreeRow[];
  readonly inUse: readonly EpicSweepWorktreeRow[];
  readonly shared: readonly EpicSweepWorktreeRow[];
  /**
   * Rows the next confirm will submit. Removed, uncertain, and failed
   * outcomes are not in this list — uncertain must not be replayed, and
   * failed needs a fresh Choose-step selection.
   */
  readonly all: readonly EpicSweepWorktreeRow[];
  readonly disclosedHolders: readonly WorktreeBusyHolder[];
  readonly branchNames: readonly string[];
  /** Identities of session-uncertain paths; merge, never rebuild from `all`. */
  readonly pendingUncertain: readonly string[];
  /** Identities of session-failed paths still awaiting a deliberate retry. */
  readonly retryableFailed: readonly string[];
}

export function captureReviewSnapshot(
  rows: ReadonlyArray<EpicSweepWorktreeRow>,
  deferred:
    | {
        readonly pendingUncertain: readonly string[];
        readonly retryableFailed: readonly string[];
      }
    | undefined,
): SweepReviewSnapshot {
  const disclosedHolders = rows.flatMap((row) =>
    row.note === "in-use" ? [...row.holders] : [],
  );
  return {
    paths: rows.map((row) => row.entry.worktreePath),
    unproven: rows.filter((row) => row.note === "not-landed"),
    inUse: rows.filter((row) => row.note === "in-use"),
    shared: rows.filter((row) => row.note === "shared"),
    all: rows,
    disclosedHolders,
    branchNames: rows.flatMap((row) =>
      row.entry.branch === null ? [] : [row.entry.branch],
    ),
    pendingUncertain: deferred?.pendingUncertain ?? [],
    retryableFailed: deferred?.retryableFailed ?? [],
  };
}

export function bannersFromSessionOutcomes(
  outcomes: ReadonlyMap<string, SweepSessionOutcome>,
): {
  readonly pendingUncertain: readonly string[];
  readonly retryableFailed: readonly string[];
} {
  const pendingUncertain: string[] = [];
  const retryableFailed: string[] = [];
  for (const outcome of outcomes.values()) {
    if (outcome.kind === "uncertain") {
      pendingUncertain.push(outcome.identity);
    } else {
      retryableFailed.push(outcome.identity);
    }
  }
  return { pendingUncertain, retryableFailed };
}

export function mergeSessionOutcomes(
  current: ReadonlyMap<string, SweepSessionOutcome>,
  result: {
    readonly removed: ReadonlyArray<string>;
    readonly uncertain: ReadonlyArray<string>;
    readonly failed: ReadonlyArray<string>;
  },
  identityByPath: ReadonlyMap<string, string>,
): ReadonlyMap<string, SweepSessionOutcome> {
  const next = new Map(current);
  for (const path of result.removed) {
    next.delete(path);
  }
  for (const path of result.uncertain) {
    next.set(path, {
      kind: "uncertain",
      identity: identityByPath.get(path) ?? path,
    });
  }
  for (const path of result.failed) {
    if (next.get(path)?.kind === "uncertain") continue;
    next.set(path, {
      kind: "failed",
      identity: identityByPath.get(path) ?? path,
    });
  }
  return next;
}

/**
 * After a completed proof/refresh: vanished uncertain paths drop (deletion
 * finished); still-listed uncertain paths re-enable (deletion did not happen).
 * Failed paths stay while listed and drop when gone.
 */
export function reconcileSessionOutcomes(
  current: ReadonlyMap<string, SweepSessionOutcome>,
  freshRows: ReadonlyArray<EpicSweepWorktreeRow>,
): ReadonlyMap<string, SweepSessionOutcome> {
  if (current.size === 0) return current;
  const listed = new Set(freshRows.map((row) => row.entry.worktreePath));
  const next = new Map<string, SweepSessionOutcome>();
  for (const [path, outcome] of current) {
    if (outcome.kind === "uncertain") continue;
    if (!listed.has(path)) continue;
    next.set(path, outcome);
  }
  return next.size === current.size ? current : next;
}

export function unknownConsequenceForRow(
  row: EpicSweepWorktreeRow,
): string | null {
  if (row.note !== "in-use") return null;
  if (row.holdersStatus !== "unknown") return null;
  return formatUnknownHolderConsequence(worktreeIdentity(row));
}

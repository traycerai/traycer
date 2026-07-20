import type {
  WorktreeCreateResponse,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";

type WorktreeIntentEntry = WorktreeIntent["entries"][number];
type WorktreePerEntryResult = WorktreeCreateResponse["perEntry"][number];

export interface WorktreeCreateResultActions {
  // Full success: clear the staging, close/resume, commit every changed path.
  readonly finishAndResume: () => void;
  // Drop one succeeded entry from the staging (failed entries stay staged).
  readonly unstageEntry: (workspacePath: string) => void;
  // Commit binding changes for the paths the host actually applied.
  readonly commitPaths: (workspacePaths: readonly string[]) => void;
  // Surface a bounded partial-failure message to the user.
  readonly showPartialFailure: (message: string) => void;
}

/**
 * Consumes `worktree.create`'s per-entry result on the workspace-selector
 * "Update" surface. The RPC resolves even when individual folders failed, so
 * resolve-as-full-success semantics would silently drop the failed folders'
 * staged intent. Pure decision over injected actions so the mixed-outcome
 * policy is unit-testable without mounting the selector.
 *
 * Policy on a partial failure: successes are committed and unstaged, failed
 * entries KEEP their staged intent, the selector stays open (no
 * `finishAndResume`), and a bounded error names the first failed folder -
 * "Update" then re-applies only the failed subset. `commitPaths` still fires
 * for the successes: the host already applied them to the binding, and the
 * surface must react to that (a live terminal re-syncs its PTY to the
 * partially updated binding). An entry the host reported nothing about is
 * treated as failed, never as silently succeeded.
 */
export function applyWorktreeCreateResult(args: {
  readonly stagedEntries: readonly WorktreeIntentEntry[];
  readonly changedWorkspacePaths: readonly string[];
  readonly perEntry: readonly WorktreePerEntryResult[];
  readonly actions: WorktreeCreateResultActions;
}): void {
  const { stagedEntries, changedWorkspacePaths, perEntry, actions } = args;
  const okPaths = new Set(
    perEntry
      .filter((entryResult) => entryResult.ok)
      .map((entryResult) => entryResult.workspacePath),
  );
  const failedEntries = stagedEntries.filter(
    (entry) => !okPaths.has(entry.workspacePath),
  );
  if (failedEntries.length === 0) {
    actions.finishAndResume();
    return;
  }

  const failedPaths = new Set(
    failedEntries.map((entry) => entry.workspacePath),
  );
  stagedEntries
    .filter((entry) => !failedPaths.has(entry.workspacePath))
    .forEach((entry) => actions.unstageEntry(entry.workspacePath));
  const committedPaths = changedWorkspacePaths.filter(
    (path) => !failedPaths.has(path),
  );
  if (committedPaths.length > 0) {
    actions.commitPaths(committedPaths);
  }
  actions.showPartialFailure(partialFailureMessage(failedEntries, perEntry));
}

// Only called with a non-empty `failedEntries` (the caller took the
// full-success early return otherwise).
function partialFailureMessage(
  failedEntries: readonly WorktreeIntentEntry[],
  perEntry: readonly WorktreePerEntryResult[],
): string {
  const first = failedEntries[0];
  const folder = workspaceFolderName(first.workspacePath);
  const hostMessage =
    perEntry.find(
      (entryResult) =>
        entryResult.workspacePath === first.workspacePath && !entryResult.ok,
    )?.errorMessage ?? null;
  const detail = hostMessage === null ? "" : ` (${hostMessage})`;
  const scope =
    failedEntries.length === 1
      ? `"${folder}"`
      : `${failedEntries.length} folders, starting with "${folder}"`;
  return `Couldn't update ${scope}${detail}. The change is still staged - press Update to retry.`;
}

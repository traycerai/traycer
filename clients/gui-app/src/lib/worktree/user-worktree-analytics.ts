import type {
  WorktreeBinding,
  WorktreeCreateResponse,
  WorktreeImportResponse,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

type WorktreeIntentEntry = WorktreeIntent["entries"][number];
type UserWorktreeWriteResult = WorktreeCreateResponse | WorktreeImportResponse;

function entrySucceededInBinding(
  entry: WorktreeIntentEntry,
  binding: WorktreeBinding | null,
): boolean {
  const bound = binding?.entries.find(
    (candidate) => candidate.workspacePath === entry.workspacePath,
  );
  if (bound === undefined || bound.mode !== "worktree") return false;
  if (entry.kind === "worktree") {
    return bound.worktreePath !== null && !bound.isImported;
  }
  if (entry.kind === "import") {
    return bound.worktreePath === entry.worktreePath && bound.isImported;
  }
  return false;
}

function entriesSucceeded(
  entries: ReadonlyArray<WorktreeIntentEntry>,
  result: UserWorktreeWriteResult,
): boolean {
  if (entries.length === 0) return false;
  if (!("perEntry" in result)) {
    return entries.every((entry) =>
      entrySucceededInBinding(entry, result.binding),
    );
  }
  return entries.every((entry) =>
    result.perEntry.some(
      (entryResult) =>
        entryResult.workspacePath === entry.workspacePath && entryResult.ok,
    ),
  );
}

/**
 * Observes a deliberate worktree picker commit, not the underlying union RPC.
 * Local-only entries intentionally produce no worktree-created/imported
 * event, and an entry that the host reports as failed does not count as
 * created/imported. Purely an observer: callers invoke it from their success
 * callback AFTER product work, never wrapping the mutation promise, so
 * telemetry can neither delay nor fail a successful write.
 */
export function trackUserInitiatedWorktreeWrite(
  entries: ReadonlyArray<WorktreeIntentEntry>,
  result: UserWorktreeWriteResult,
): void {
  const analytics = Analytics.getInstance();
  if (
    entriesSucceeded(
      entries.filter((entry) => entry.kind === "worktree"),
      result,
    )
  ) {
    analytics.track(AnalyticsEvent.WorktreeCreated, { source: "direct_ui" });
  }
  if (
    entriesSucceeded(
      entries.filter((entry) => entry.kind === "import"),
      result,
    )
  ) {
    analytics.track(AnalyticsEvent.WorktreeImported, { source: "direct_ui" });
  }
}

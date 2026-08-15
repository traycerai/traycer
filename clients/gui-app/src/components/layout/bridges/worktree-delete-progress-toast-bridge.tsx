import { useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  useWorktreeDeleteProgressSummary,
  worktreeDeleteProgressDetail,
  type WorktreeDeleteProgressSummary,
} from "@/components/settings/panels/use-worktree-delete-run";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { createReportIssueContext } from "@/lib/report-issue-context";
import {
  progressSuccessToast,
  progressToast,
} from "@/lib/toast/progress-toast";

const WORKTREE_DELETE_PROGRESS_TOAST_ID = "worktree-delete-progress";
const WORKTREE_DELETE_REPORT_CONTEXT = createReportIssueContext({
  title: "Could not delete worktree",
  message: null,
  code: null,
  source: "Worktrees",
});

export function WorktreeDeleteProgressToastBridge(): null {
  const summary = useWorktreeDeleteProgressSummary();
  const lastToastKeyRef = useRef<string | null>(null);
  const dismissedProgressScopeKeysRef = useRef<Set<string>>(new Set());
  // Whether the toast currently on screen is one that will NOT expire on its
  // own: the in-progress toast and the failure toast both use
  // `duration: Infinity`. A terminal success resets to a short duration.
  // Tracked so that when the runs drain we dismiss the former two but leave a
  // success toast to live out its time.
  const lastToastPersistentRef = useRef<boolean>(false);

  useEffect(() => {
    if (summary.total === 0) {
      if (lastToastPersistentRef.current) {
        toast.dismiss(WORKTREE_DELETE_PROGRESS_TOAST_ID);
      }
      lastToastKeyRef.current = null;
      lastToastPersistentRef.current = false;
      dismissedProgressScopeKeysRef.current.clear();
      return;
    }

    const currentScopeKeys = new Set(summary.scopeKeys);
    dismissedProgressScopeKeysRef.current.forEach((key) => {
      if (!currentScopeKeys.has(key)) {
        dismissedProgressScopeKeysRef.current.delete(key);
      }
    });

    const toastKey = worktreeDeleteToastKey(summary);
    if (lastToastKeyRef.current === toastKey) return;
    lastToastKeyRef.current = toastKey;

    const allCurrentScopesDismissed =
      summary.scopeKeys.length > 0 &&
      summary.scopeKeys.every((key) =>
        dismissedProgressScopeKeysRef.current.has(key),
      );
    const isTerminalFailure = summary.active === 0 && summary.failed > 0;
    if (allCurrentScopesDismissed && !isTerminalFailure) {
      if (lastToastPersistentRef.current) {
        toast.dismiss(WORKTREE_DELETE_PROGRESS_TOAST_ID);
      }
      lastToastPersistentRef.current = false;
      return;
    }

    lastToastPersistentRef.current = summary.active > 0 || summary.failed > 0;
    showWorktreeDeleteProgressToast(summary, () => {
      // Sonner also invokes `onDismiss` for programmatic `toast.dismiss`.
      // Those paths clear this ref before Sonner runs its asynchronous
      // callback, so only a user closing a live toast suppresses its scope.
      if (!lastToastPersistentRef.current) return;
      summary.scopeKeys.forEach((key) => {
        dismissedProgressScopeKeysRef.current.add(key);
      });
      lastToastPersistentRef.current = false;
    });
  }, [summary]);

  return null;
}

function showWorktreeDeleteProgressToast(
  summary: WorktreeDeleteProgressSummary,
  onProgressDismiss: () => void,
): void {
  const description = worktreeDeleteProgressDetail(summary);
  if (summary.active > 0) {
    progressToast("Deleting worktrees", {
      id: WORKTREE_DELETE_PROGRESS_TOAST_ID,
      description,
      duration: Infinity,
      cancel: null,
      onDismiss: onProgressDismiss,
    });
    return;
  }
  if (summary.failed === 0) {
    progressSuccessToast(`Deleted ${worktreeCountLabel(summary.deleted)}`, {
      id: WORKTREE_DELETE_PROGRESS_TOAST_ID,
      description,
      cancel: null,
      onDismiss: undefined,
    });
    return;
  }
  // A failure toast persists (no auto-expiry) and is directly dismissable, so a
  // user who never reopens the Worktrees panel to dismiss the strip can still
  // clear it.
  reportableErrorToast(
    worktreeDeleteFailureTitle(summary),
    {
      id: WORKTREE_DELETE_PROGRESS_TOAST_ID,
      description,
      duration: Infinity,
      onDismiss: undefined,
    },
    WORKTREE_DELETE_REPORT_CONTEXT,
  );
}

function worktreeDeleteToastKey(
  summary: WorktreeDeleteProgressSummary,
): string {
  const phase = summary.active > 0 ? "active" : "terminal";
  return [
    phase,
    summary.total,
    summary.deleted,
    summary.failed,
    summary.active,
    JSON.stringify(summary.scopeKeys),
  ].join(":");
}

function worktreeDeleteFailureTitle(
  summary: WorktreeDeleteProgressSummary,
): string {
  if (summary.deleted === 0) {
    return `Couldn't delete ${worktreeCountLabel(summary.total)}`;
  }
  return `Deleted ${summary.deleted} of ${worktreeCountLabel(summary.total)}`;
}

function worktreeCountLabel(count: number): string {
  return count === 1 ? "1 worktree" : `${count} worktrees`;
}

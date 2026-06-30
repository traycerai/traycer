import { useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  useWorktreeDeleteProgressSummary,
  worktreeDeleteProgressDetail,
  type WorktreeDeleteProgressSummary,
} from "@/components/settings/panels/use-worktree-delete-run";

const WORKTREE_DELETE_PROGRESS_TOAST_ID = "worktree-delete-progress";

export function WorktreeDeleteProgressToastBridge(): null {
  const summary = useWorktreeDeleteProgressSummary();
  const lastToastKeyRef = useRef<string | null>(null);
  // Whether the toast currently on screen is one that will NOT expire on its
  // own: the in-progress loading toast and the failure toast both use
  // `duration: Infinity`. A plain success toast keeps its short default
  // duration. Tracked so that when the runs drain we dismiss the former two but
  // leave a success toast to live out its time.
  const lastToastPersistentRef = useRef<boolean>(false);

  useEffect(() => {
    if (summary.total === 0) {
      if (lastToastPersistentRef.current) {
        toast.dismiss(WORKTREE_DELETE_PROGRESS_TOAST_ID);
      }
      lastToastKeyRef.current = null;
      lastToastPersistentRef.current = false;
      return;
    }

    const toastKey = worktreeDeleteToastKey(summary);
    if (lastToastKeyRef.current === toastKey) return;
    lastToastKeyRef.current = toastKey;
    lastToastPersistentRef.current = summary.active > 0 || summary.failed > 0;
    showWorktreeDeleteProgressToast(summary);
  }, [summary]);

  return null;
}

function showWorktreeDeleteProgressToast(
  summary: WorktreeDeleteProgressSummary,
): void {
  const description = worktreeDeleteProgressDetail(summary);
  if (summary.active > 0) {
    toast.loading("Deleting worktrees", {
      id: WORKTREE_DELETE_PROGRESS_TOAST_ID,
      description,
      duration: Infinity,
    });
    return;
  }
  if (summary.failed === 0) {
    toast.success(`Deleted ${worktreeCountLabel(summary.deleted)}`, {
      id: WORKTREE_DELETE_PROGRESS_TOAST_ID,
      description,
    });
    return;
  }
  // A failure toast persists (no auto-expiry) and is directly dismissable, so a
  // user who never reopens the Worktrees panel to dismiss the strip can still
  // clear it.
  toast.error(worktreeDeleteFailureTitle(summary), {
    id: WORKTREE_DELETE_PROGRESS_TOAST_ID,
    description,
    duration: Infinity,
    closeButton: true,
  });
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

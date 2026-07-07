import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TaskDeleteWorktreeCandidate } from "@/hooks/epic/use-task-delete-worktree-candidates-query";

interface DeleteTasksDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly isPending: boolean;
  readonly onConfirm: () => void;
  /**
   * Worktrees the deleted Task(s) alone reference. Empty (no candidates, or a
   * failed candidate query) collapses this dialog to exactly today's
   * confirmation - the cleanup section is additive and never blocks deletion.
   */
  readonly candidates: ReadonlyArray<TaskDeleteWorktreeCandidate>;
  readonly isPathChecked: (worktreePath: string) => boolean;
  readonly onTogglePath: (worktreePath: string, checked: boolean) => void;
}

/**
 * The Task-delete confirmation. Mirrors {@link ConfirmDestructiveDialog}'s
 * layout so the zero-candidate case is visually identical to before this
 * feature, and adds an opt-out worktree-cleanup checklist when the deleted
 * Task(s) exclusively own worktrees on this host. Copy is deliberately "no
 * longer used by any other Task" - never "orphaned", which the Settings tab
 * reserves for `gitRemovable: false`.
 */
export function DeleteTasksDialog(props: DeleteTasksDialogProps) {
  const {
    open,
    onOpenChange,
    title,
    description,
    isPending,
    onConfirm,
    candidates,
    isPathChecked,
    onTogglePath,
  } = props;

  return (
    <Dialog open={open} onOpenChange={isPending ? undefined : onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[min(92vw,28rem)] gap-0 overflow-hidden p-0 sm:max-w-md"
        data-testid="delete-tasks-dialog"
      >
        <div className="flex min-w-0 items-start gap-3 p-5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="size-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <DialogTitle className="text-ui font-semibold leading-snug wrap-anywhere">
              {title}
            </DialogTitle>
            <DialogDescription className="text-ui-sm leading-relaxed text-muted-foreground wrap-anywhere">
              {description}
            </DialogDescription>
          </div>
        </div>

        {candidates.length > 0 ? (
          <section
            className="border-t border-border/60 px-5 py-3"
            data-testid="delete-tasks-worktree-cleanup"
          >
            <p className="text-ui-sm font-medium text-foreground">
              Also remove worktrees no longer used by any other Task
            </p>
            <p className="mt-0.5 text-ui-xs text-muted-foreground">
              Cleanup is limited to worktrees on this host. Only
              proven-removable worktrees are pre-selected.
            </p>
            <ul className="mt-2 flex max-h-[min(40vh,16rem)] flex-col gap-0.5 overflow-y-auto">
              {candidates.map((candidate) => (
                <WorktreeCleanupRow
                  key={candidate.worktreePath}
                  candidate={candidate}
                  checked={isPathChecked(candidate.worktreePath)}
                  disabled={isPending}
                  onToggle={onTogglePath}
                />
              ))}
            </ul>
          </section>
        ) : null}

        <div className="flex justify-end gap-2 border-t border-border/60 bg-muted/20 px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => {
              onOpenChange(false);
            }}
            data-testid="delete-tasks-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={isPending}
            onClick={onConfirm}
            data-testid="delete-tasks-confirm"
          >
            {isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WorktreeCleanupRow(props: {
  readonly candidate: TaskDeleteWorktreeCandidate;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: (worktreePath: string, checked: boolean) => void;
}) {
  const { candidate, checked, disabled, onToggle } = props;
  const branch = candidate.branch ?? "detached HEAD";
  // Per-row loss/uncertainty hint. Dirty rows name the concrete uncommitted
  // loss; clean rows with local-only commits name that concrete loss; clean rows
  // whose branch status could not be probed carry a neutral "unverified" note
  // (never "safe" / "loss-free"). A clean, proven row is quiet.
  const status = candidate.branchStatus;
  let hint: ReactNode = null;
  if (candidate.uncommittedCount > 0) {
    hint = (
      <span className="mt-0.5 flex items-center gap-1 text-ui-xs text-amber-600 dark:text-amber-400">
        <AlertTriangle className="size-3 shrink-0" aria-hidden />
        {candidate.uncommittedCount} uncommitted change
        {candidate.uncommittedCount === 1 ? "" : "s"} will be lost
      </span>
    );
  } else if (candidate.branch === null) {
    // Detached HEAD has no branch ref, so removal can orphan its commits -
    // surface this before any branchStatus hint, which a detached row can
    // still carry (e.g. probed against the workspace's default branch).
    hint = (
      <span className="mt-0.5 flex items-center gap-1 text-ui-xs text-amber-600 dark:text-amber-400">
        <AlertTriangle className="size-3 shrink-0" aria-hidden />
        Detached HEAD — commits could be orphaned by removal
      </span>
    );
  } else if (
    status !== null &&
    status.ahead !== null &&
    status.ahead > 0 &&
    !status.mergedIntoDefault
  ) {
    hint = (
      <span className="mt-0.5 flex items-center gap-1 text-ui-xs text-amber-600 dark:text-amber-400">
        <AlertTriangle className="size-3 shrink-0" aria-hidden />
        {status.ahead} commit{status.ahead === 1 ? "" : "s"} not on the default
        branch
      </span>
    );
  } else if (
    status !== null &&
    status.ahead === null &&
    !status.mergedIntoDefault
  ) {
    // Never-pushed and not contained in the default branch: local-only commits
    // exist but the count is unknown (no upstream). The branch ref survives
    // removal, so this names the state without claiming unrecoverable loss.
    hint = (
      <span className="mt-0.5 flex items-center gap-1 text-ui-xs text-amber-600 dark:text-amber-400">
        <AlertTriangle className="size-3 shrink-0" aria-hidden />
        Local-only commits not on the default branch — never pushed
      </span>
    );
  } else if (status === null) {
    hint = (
      <span className="mt-0.5 block text-ui-xs text-muted-foreground">
        Branch status unverified — unpushed work not proven
      </span>
    );
  }
  return (
    <li>
      <label className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-accent/40">
        <Checkbox
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value) =>
            onToggle(candidate.worktreePath, value === true)
          }
          className="mt-0.5"
          aria-label={`Remove worktree ${branch}`}
          data-testid="delete-tasks-worktree-checkbox"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 text-ui-sm text-foreground">
            <span className="font-medium wrap-anywhere">{branch}</span>
            <span className="text-ui-xs text-muted-foreground wrap-anywhere">
              {candidate.repoLabel}
            </span>
          </span>
          <span className="block truncate text-ui-xs text-muted-foreground">
            {candidate.worktreePath}
          </span>
          {hint}
        </span>
      </label>
    </li>
  );
}

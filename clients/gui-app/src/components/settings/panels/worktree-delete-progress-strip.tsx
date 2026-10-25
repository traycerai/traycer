import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  worktreeDeleteProgressDetail,
  type WorktreeDeleteProgressSummary,
  type WorktreeDeleteRunRecord,
} from "./use-worktree-delete-run";

export function WorktreeDeleteProgressStrip(props: {
  readonly summary: WorktreeDeleteProgressSummary;
  readonly runs: readonly WorktreeDeleteRunRecord[];
  readonly onDismiss: () => void;
}): ReactNode {
  if (props.summary.total === 0) return null;
  // Once nothing is in flight, a batch that ended with failures stays put so the
  // user notices; offer an explicit Dismiss to clear it (and the app-wide toast)
  // rather than leaving it stuck forever.
  const showDismiss = props.summary.active === 0 && props.summary.failed > 0;
  return (
    <div
      data-testid="worktree-delete-progress-strip"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 bg-foreground/3 px-5 py-2"
    >
      <span className="text-ui-sm font-medium text-foreground">
        {worktreeDeleteProgressTitle(props.summary)}
      </span>
      <div className="flex items-center gap-3">
        <span className="text-ui-xs text-muted-foreground">
          {worktreeDeleteProgressDetail(props.summary)}
        </span>
        {showDismiss ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={props.onDismiss}
            data-testid="worktree-delete-progress-dismiss"
          >
            Dismiss
          </Button>
        ) : null}
      </div>
      <div
        data-testid="worktree-delete-batch-failures"
        className="max-h-[30vh] w-full min-h-0 space-y-2 overflow-y-auto empty:hidden"
      >
        {props.runs
          .filter(
            (record) =>
              record.backgrounded &&
              (record.run.status === "failed" ||
                (record.run.status === "complete" && !record.run.deleted)) &&
              record.run.errorTail !== undefined,
          )
          .map((record) => (
            <div
              key={record.key}
              data-testid="worktree-delete-batch-failure"
              className="w-full min-w-0"
            >
              <p className="text-ui-xs wrap-anywhere text-muted-foreground">
                {record.target.worktreePath}
              </p>
              <pre
                data-testid="worktree-delete-error-tail"
                className="w-full font-mono text-code-xs whitespace-pre-wrap wrap-anywhere text-destructive"
              >
                {record.run.errorTail}
              </pre>
            </div>
          ))}
      </div>
    </div>
  );
}

function worktreeDeleteProgressTitle(
  summary: WorktreeDeleteProgressSummary,
): string {
  if (summary.active > 0) return "Deleting worktrees";
  if (summary.failed === 0) return "Worktrees deleted";
  if (summary.deleted === 0) return "Couldn't delete worktrees";
  return "Some worktrees couldn't be deleted";
}

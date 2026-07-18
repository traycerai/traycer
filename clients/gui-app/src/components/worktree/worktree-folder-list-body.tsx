import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { WorktreeFolderList } from "@/components/worktree/worktree-folder-list";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { worktreeFolderRowBadge } from "@/lib/worktree/worktree-folder-disabled-reason";

/**
 * Loading / error / list states shared by the badge-less worktree pickers
 * (terminal creation, file tree). Surfaces that need custom row rules (the git
 * diff picker) use `WorktreeFolderList` directly.
 */
export interface WorktreeFolderListBodyProps {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly rows: ReadonlyArray<WorktreeBindingSelectorRowV12>;
  readonly selectedRow: WorktreeBindingSelectorRowV12 | null;
  readonly secondaryLabel: (row: WorktreeBindingSelectorRowV12) => string;
  readonly onSelect: (row: WorktreeBindingSelectorRowV12) => void;
  /** Forwarded to {@link WorktreeFolderList}: auto-focus the search input. */
  readonly autoFocusSearch: boolean;
}

export function WorktreeFolderListBody(props: WorktreeFolderListBodyProps) {
  if (props.isPending) {
    return (
      <div className="flex items-center gap-2 p-2.5 text-ui-sm text-muted-foreground">
        <MutedAgentSpinner />
        <span>Loading workspaces…</span>
      </div>
    );
  }
  if (props.isError) {
    return (
      <div className="flex items-center gap-2 p-2.5 text-ui-sm text-destructive">
        <span className="min-w-0 flex-1">Failed to load workspaces.</span>
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Failed to load workspaces",
            message: null,
            code: null,
            source: "Workspaces",
          })}
          presentation="icon"
          className="text-current"
        />
      </div>
    );
  }
  return (
    <WorktreeFolderList
      rows={props.rows}
      selectedRow={props.selectedRow}
      secondaryLabel={props.secondaryLabel}
      disabledBadge={worktreeFolderRowBadge}
      onSelect={props.onSelect}
      autoFocusSearch={props.autoFocusSearch}
    />
  );
}

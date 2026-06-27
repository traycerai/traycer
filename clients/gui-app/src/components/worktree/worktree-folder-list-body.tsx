import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { WorktreeFolderList } from "@/components/worktree/worktree-folder-list";
import { formatWorktreeFolderDisabledReason } from "@/lib/worktree/worktree-folder-disabled-reason";

/**
 * Loading / error / list states shared by the badge-less worktree pickers
 * (terminal creation, file tree). Surfaces that need custom row rules (the git
 * diff picker) use `WorktreeFolderList` directly.
 */
export interface WorktreeFolderListBodyProps {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly rows: ReadonlyArray<WorktreeBindingSelectorRow>;
  readonly selectedRow: WorktreeBindingSelectorRow | null;
  readonly secondaryLabel: (row: WorktreeBindingSelectorRow) => string;
  readonly onSelect: (row: WorktreeBindingSelectorRow) => void;
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
      <div className="p-2.5 text-ui-sm text-destructive">
        Failed to load workspaces.
      </div>
    );
  }
  return (
    <WorktreeFolderList
      rows={props.rows}
      selectedRow={props.selectedRow}
      secondaryLabel={props.secondaryLabel}
      disabledLabel={formatWorktreeFolderDisabledReason}
      onSelect={props.onSelect}
      autoFocusSearch={props.autoFocusSearch}
    />
  );
}

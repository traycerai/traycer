import type { ReactNode } from "react";
import type { GitFileStatus } from "@traycer/protocol/host";
import { getBasename, getDirname } from "@/lib/path/cross-platform-path";
import { statusBadgeStyle } from "@/lib/git/status-icon";
import { WorkspaceFileIcon } from "@/components/epic-canvas/workspace-file/workspace-file-icons";
import { Badge } from "@/components/ui/badge";
import { GitStatusBadge } from "./git-status-badge";

/**
 * The minimal shape shared by a submodule's worktree files (v1.1 `GitChangedFile`)
 * and its committed-ahead files (`CommitAheadFile`, which carry no stage or OIDs).
 * The row opens a diff tile via the `onClick` / `onDoubleClick` handlers supplied
 * by the owning section (which routes to the correct `repoRoot` / `compareFromSha`).
 */
export interface SubmoduleFileRowData {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: GitFileStatus;
  readonly isBinary: boolean;
  readonly insertions: number;
  readonly deletions: number;
}

export function SubmoduleFileRow(props: {
  readonly file: SubmoduleFileRowData;
  /** Open a preview (single-click). */
  readonly onClick: () => void;
  /** Open a pinned tile (double-click). */
  readonly onDoubleClick: () => void;
}): ReactNode {
  const { file } = props;
  const status = statusBadgeStyle(file.status);
  const fileName = getBasename(file.path);
  const directoryName = getDirname(file.path);
  const previousFileName =
    file.previousPath === null ? null : getBasename(file.previousPath);
  const ariaLabel =
    previousFileName !== null && previousFileName !== fileName
      ? `${status.label} ${fileName} (renamed from ${previousFileName})`
      : `${status.label} ${fileName}`;
  return (
    <button
      type="button"
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
      className="group relative flex min-h-6 w-full items-center gap-1.5 px-3 py-0.5 text-left text-ui-sm transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label={ariaLabel}
      data-testid={`submodule-file-row-${file.path}`}
    >
      <GitStatusBadge
        letter={status.letter}
        tone={status.tone}
        label={status.label}
        withNativeTitle
      />
      <WorkspaceFileIcon fileName={fileName} className="size-3.5" />
      <span className="min-w-0 shrink truncate font-normal">{fileName}</span>
      {previousFileName !== null && previousFileName !== fileName ? (
        <span className="min-w-0 shrink truncate text-ui-xs text-muted-foreground">
          from {previousFileName}
        </span>
      ) : null}
      {directoryName.length > 0 ? (
        <span className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground">
          {directoryName}
        </span>
      ) : (
        <span aria-hidden className="ml-auto" />
      )}
      <span className="flex shrink-0 items-center gap-1">
        <span className="shrink-0 text-ui-xs font-medium tabular-nums text-success">
          +{file.insertions}
        </span>
        <span className="shrink-0 text-ui-xs font-medium tabular-nums text-destructive">
          -{file.deletions}
        </span>
        {file.isBinary ? (
          <Badge variant="outline" className="shrink-0">
            bin
          </Badge>
        ) : null}
      </span>
    </button>
  );
}

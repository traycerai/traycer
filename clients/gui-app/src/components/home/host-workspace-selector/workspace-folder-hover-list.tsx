import { GitBranch } from "lucide-react";
import type { WorkspaceRunItem } from "./workspace-run-item";
import {
  workspaceRunBranchSourceLabel,
  workspaceRunPath,
} from "./workspace-run-item";
import { WorkspaceModeIcon } from "./workspace-mode-icon";

/**
 * Hover preview of every linked folder, themed like the standard tooltip:
 * `repo · branch` over the full path (left-truncated so the tail stays
 * readable). The path is where the chat actually runs — the adopted worktree
 * for worktree mode, the folder for local — not the source folder.
 *
 * Purely informational: this renders inside a Radix Tooltip, which mounts an
 * always-present visually-hidden accessible clone of its content, so any
 * focusable descendant here would exist twice in the a11y tree. The copy-path
 * action lives on the click-open folder row instead (`FolderRow`).
 */
export function WorkspaceFolderHoverList(props: {
  readonly items: ReadonlyArray<WorkspaceRunItem>;
}) {
  return (
    <div
      className="flex w-[min(92vw,24rem)] max-h-[min(60vh,20rem)] flex-col gap-1.5 overflow-y-auto overscroll-contain px-2.5 py-2"
      data-testid="workspace-folder-hover-list"
      // Chromium treats an actually-overflowing scroll container as a
      // sequential (implicit) tab stop even though its React/DOM tabIndex is
      // never set - jsdom does not model this. `tabIndex={-1}` removes it
      // from the Tab order while pointer/wheel scrolling stays unaffected.
      tabIndex={-1}
    >
      {props.items.map((item) => {
        const runPath = workspaceRunPath(item);
        return (
          <div key={item.key} className="flex min-w-0 flex-col gap-0.5">
            <div className="flex min-w-0 items-start gap-1.5">
              <WorkspaceModeIcon mode={item.mode} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span
                  className="break-words font-medium leading-5"
                  data-testid="workspace-hover-folder-name"
                >
                  {item.displayName}
                </span>
                <span className="flex min-w-0 items-start gap-1 text-background/70">
                  <GitBranch className="mt-0.5 size-3 shrink-0" aria-hidden />
                  <span
                    className="min-w-0 break-words leading-4"
                    data-testid="workspace-hover-branch-name"
                  >
                    {item.branchLabel}
                  </span>
                </span>
              </div>
            </div>
            {runPath === null ? (
              <span className="break-words pl-5 leading-5 text-background/50">
                {newWorktreeDetail(item)}
              </span>
            ) : (
              <span
                className="block min-w-0 break-all pl-5 leading-5 text-background/60"
                data-testid="workspace-hover-run-path"
              >
                {runPath}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function newWorktreeDetail(item: WorkspaceRunItem): string {
  const source = workspaceRunBranchSourceLabel(item.currentIntent);
  return source === null
    ? "New worktree · created on send"
    : `From ${source} · created on send`;
}

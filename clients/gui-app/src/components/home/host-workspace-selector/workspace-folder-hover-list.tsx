import { GitBranch } from "lucide-react";
import { HOVER_PREVIEW_SCROLL_CLASS } from "@/components/ui/hover-preview-surface";
import { cn } from "@/lib/utils";
import { CopyPathButton } from "./copy-path-button";
import type { WorkspaceRunItem } from "./workspace-run-item";
import {
  workspaceRunBranchSourceLabel,
  workspaceRunPath,
} from "./workspace-run-item";
import { WorkspaceModeIcon } from "./workspace-mode-icon";

/**
 * Hover preview of every linked folder: `repo · branch` over the full path.
 * The path is where the chat actually runs — the adopted worktree for worktree
 * mode, the folder for local — not the source folder.
 *
 * Renders on the shared hover-preview card surface (`HoverPreviewCard`), so its
 * tones are the card's own foreground/muted pair, matching the composer's
 * @mention preview panel. A HoverCard (not a Tooltip) holds this content, so
 * the per-folder copy-path button is safe here — there is no visually-hidden
 * accessible clone to duplicate it in the tab order.
 */
export function WorkspaceFolderHoverList(props: {
  readonly items: ReadonlyArray<WorkspaceRunItem>;
}) {
  return (
    <div
      className={cn(
        "flex w-[min(92vw,24rem)] max-h-[min(60vh,20rem)] flex-col gap-1.5",
        HOVER_PREVIEW_SCROLL_CLASS,
      )}
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
                  className="break-words text-ui-sm font-medium leading-5"
                  data-testid="workspace-hover-folder-name"
                >
                  {item.displayName}
                </span>
                <span className="flex min-w-0 items-start gap-1 text-ui-xs text-muted-foreground">
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
              <span className="break-words pl-5 text-ui-xs leading-5 text-muted-foreground/70">
                {newWorktreeDetail(item)}
              </span>
            ) : (
              <span className="flex min-w-0 items-start gap-1 pl-5">
                <span
                  className="block min-w-0 flex-1 break-all text-ui-xs leading-5 text-muted-foreground/70"
                  data-testid="workspace-hover-run-path"
                >
                  {runPath}
                </span>
                <CopyPathButton
                  path={runPath}
                  testId="workspace-hover-copy-path"
                />
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

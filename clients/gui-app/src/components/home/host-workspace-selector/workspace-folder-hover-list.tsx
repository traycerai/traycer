import { Check, Copy, GitBranch } from "lucide-react";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import type { WorkspaceRunItem } from "./workspace-run-item";
import { workspaceRunBranchSourceLabel } from "./workspace-run-item";
import { WorkspaceModeIcon } from "./workspace-mode-icon";

/**
 * Hover preview of every linked folder, themed like the standard tooltip:
 * `repo · branch` over the full path (left-truncated so the tail stays
 * readable), with a copy-path button to the right of the path. The path is
 * where the chat actually runs — the adopted worktree for worktree mode, the
 * folder for local — not the source folder.
 */
export function WorkspaceFolderHoverList(props: {
  readonly items: ReadonlyArray<WorkspaceRunItem>;
}) {
  return (
    <div
      className="flex max-h-[min(60vh,20rem)] flex-col gap-1.5 overflow-y-auto overscroll-contain px-2.5 py-2"
      data-testid="workspace-folder-hover-list"
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
              <div className="flex min-w-0 items-start gap-1 pl-5">
                <span className="min-w-0 flex-1 break-all leading-5 text-background/60">
                  {runPath}
                </span>
                <CopyPathButton path={runPath} />
              </div>
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

function workspaceRunPath(item: WorkspaceRunItem): string | null {
  if (item.mode === "local") return item.displayPath;
  if (item.currentIntent?.kind === "import") {
    return item.currentIntent.worktreePath;
  }
  return null;
}

function CopyPathButton(props: { readonly path: string }) {
  const { copied, copy } = useClipboardCopy({
    resetMs: 1500,
    onSuccess: null,
    onError: null,
  });
  return (
    <button
      type="button"
      aria-label="Copy folder path"
      title="Copy path"
      onClick={() => copy(props.path)}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-background/60 transition-colors hover:bg-background/15 hover:text-background focus-visible:ring-2 focus-visible:ring-background/40"
    >
      {copied ? (
        <Check className="size-3.5 text-background" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}

import { Check, Copy } from "lucide-react";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import type { WorkspaceRunItem } from "./workspace-run-item";
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
            <span className="flex min-w-0 items-center gap-1.5 leading-5">
              <WorkspaceModeIcon mode={item.mode} />
              <span className="truncate font-medium">{item.displayName}</span>
              <span className="text-background/50">·</span>
              <span className="truncate text-background/70">
                {item.branchLabel}
              </span>
            </span>
            {runPath === null ? (
              <span className="leading-5 text-background/50">
                New worktree · created on send
              </span>
            ) : (
              <div className="flex min-w-0 items-center gap-1">
                <StartTruncatedText className="min-w-0 leading-5 text-background/60">
                  {runPath}
                </StartTruncatedText>
                <CopyPathButton path={runPath} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
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

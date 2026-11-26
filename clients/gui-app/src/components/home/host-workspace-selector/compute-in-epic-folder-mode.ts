import type {
  WorktreeBindingEntryMode,
  WorktreeFolderIntent,
} from "@traycer/protocol/host/worktree-schemas";

/**
 * In-Epic chip mode + label for a single folder row.
 *
 * The row's visible choice (a staged pick over an in-flight one) wins over the
 * binding. Neither lands in the binding before the next send, so reading the
 * binding would show the folder as it was rather than as picked: a staged
 * "Create new worktree" would read "Local", and a staged Local or adopted
 * worktree would read as the old binding. A new worktree reads as its branch,
 * an adopted worktree as a worktree whose branch the caller reads from the
 * worktree on disk, and Local as Local. The binding answers when nothing is
 * visible, and for a new worktree whose name is not proposed yet. This mirrors
 * the landing page, where a captured intent drives the label.
 */
export function computeInEpicFolderMode(args: {
  readonly boundMode: WorktreeBindingEntryMode | null;
  readonly boundBranch: string | null;
  readonly visibleIntent: WorktreeFolderIntent | null;
}): { readonly mode: "local" | "worktree"; readonly label: string } {
  const intent = args.visibleIntent;
  if (intent?.kind === "local") return { mode: "local", label: "Local" };
  if (intent?.kind === "import") return { mode: "worktree", label: "Worktree" };
  if (intent?.kind === "worktree" && intent.branch.name.length > 0) {
    return { mode: "worktree", label: intent.branch.name };
  }
  if ((args.boundMode ?? "local") === "local") {
    return { mode: "local", label: "Local" };
  }
  return { mode: "worktree", label: args.boundBranch ?? "Worktree" };
}

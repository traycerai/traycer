import type { WorktreeBindingEntryMode } from "@traycer/protocol/host/worktree-schemas";

/** A staged "Create new worktree" is deferred to the next message send and never lands in the binding, so it
 * must win over the binding's still-"local" mode here. */
export function computeInEpicFolderMode(args: {
  readonly boundMode: WorktreeBindingEntryMode | null;
  readonly boundBranch: string | null;
  readonly pendingNewBranch: string | null;
}): { readonly mode: "local" | "worktree"; readonly label: string } {
  if (args.pendingNewBranch !== null) {
    return { mode: "worktree", label: args.pendingNewBranch };
  }
  if ((args.boundMode ?? "local") === "local") {
    return { mode: "local", label: "Local" };
  }
  return { mode: "worktree", label: args.boundBranch ?? "Worktree" };
}

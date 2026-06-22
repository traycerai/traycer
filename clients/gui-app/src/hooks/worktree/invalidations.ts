import type { HostRpcRegistry } from "@/lib/host";

// Listed explicitly so binding-mutation success doesn't invalidate
// unrelated caches like `terminal.list` or `agent.list`.
export const WORKTREE_BINDING_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = [
  "worktree.listBindingsForEpic",
  "worktree.listByWorkspacePaths",
  "worktree.getBinding",
  "worktree.listBranches",
];

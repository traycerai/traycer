export const worktreeMutationKeys = {
  create: () => ["worktree.create"] as const,
  import: () => ["worktree.import"] as const,
  setEntryMode: () => ["worktree.setEntryMode"] as const,
  retrySetup: () => ["worktree.retrySetup"] as const,
  delete: () => ["worktree.delete"] as const,
  setRepoScripts: () => ["worktree.setRepoScripts"] as const,
  setRepoBranchPrefix: () => ["worktree.setRepoBranchPrefix"] as const,
  refreshListing: () => ["worktree.listAllForHost", "forceRefresh"] as const,
  /**
   * The owner hover card's Refresh. Scoped by `ownerId` rather than sharing
   * {@link refreshListing}: that one forces the WHOLE host listing, this one
   * forces only the paths a single owner runs in, and keying them together
   * would make one card's spinner reflect another card's request.
   */
  refreshOwnerMetadata: (ownerId: string) =>
    ["worktree.listAllForHost", "forceRefresh", "owner", ownerId] as const,
  /**
   * The same Refresh's second leg: the owner's plain (non-worktree) folders,
   * whose branch comes from the per-workspace summary rather than the host-wide
   * worktree walk.
   */
  refreshOwnerWorkspaces: (ownerId: string) =>
    [
      "worktree.listByWorkspacePaths",
      "forceRefresh",
      "owner",
      ownerId,
    ] as const,
  /**
   * The folder-mapping picker's Refresh, scoped by the PATH SET it forces
   * rather than by a surface id. Two pickers showing the same folders read the
   * same cache entry and issue the identical request, so sharing one in-flight
   * key is the honest description of that; keying them apart would show one
   * picker idle while the very request feeding it was still running.
   */
  refreshWorkspaceSummaries: (workspacePaths: ReadonlyArray<string>) =>
    [
      "worktree.listByWorkspacePaths",
      "forceRefresh",
      "workspaces",
      [...workspacePaths],
    ] as const,
};

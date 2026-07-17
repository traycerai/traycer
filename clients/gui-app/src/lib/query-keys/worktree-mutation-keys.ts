export const worktreeMutationKeys = {
  create: () => ["worktree.create"] as const,
  import: () => ["worktree.import"] as const,
  setEntryMode: () => ["worktree.setEntryMode"] as const,
  retrySetup: () => ["worktree.retrySetup"] as const,
  delete: () => ["worktree.delete"] as const,
  setRepoScripts: () => ["worktree.setRepoScripts"] as const,
  refreshListing: () => ["worktree.listAllForHost", "forceRefresh"] as const,
};

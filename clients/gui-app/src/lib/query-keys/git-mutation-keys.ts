export const gitMutationKeys = {
  refreshWorktreeStatus: () => ["git.refreshWorktreeStatus"] as const,
  refreshSubmoduleStatus: () => ["git.refreshSubmoduleStatus"] as const,
};

export const workspaceMutationKeys = {
  prepareFolders: () => ["workspace.prepareFolders"] as const,
  addBindingFolder: () => ["workspaceBinding.addFolder"] as const,
  removeBindingEntry: () => ["workspaceBinding.removeEntry"] as const,
  removeEpicRepo: () => ["epic.removeRepo"] as const,
};

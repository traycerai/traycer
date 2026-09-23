/** Mutation keys for the `agentIdentity.*` host RPC family. */
export const identityMutationKeys = {
  create: () => ["agentIdentity.create"] as const,
  update: () => ["agentIdentity.update"] as const,
  delete: () => ["agentIdentity.delete"] as const,
  addFile: () => ["agentIdentity.files.add"] as const,
  renameFile: () => ["agentIdentity.files.rename"] as const,
  deleteFile: () => ["agentIdentity.files.delete"] as const,
  uploadBlob: () => ["agentIdentity.files.uploadBlob"] as const,
  loadOlderHistory: () => ["agentIdentity.history.loadOlder"] as const,
  restoreHistory: () => ["agentIdentity.history.restore"] as const,
};

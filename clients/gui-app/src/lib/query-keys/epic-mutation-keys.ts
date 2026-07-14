export const epicMutationKeys = {
  create: () => ["epic.create"] as const,
  batchDelete: () => ["epic.batchDelete"] as const,
  sendQueuedInvites: () => ["epic.sendQueuedInvites"] as const,
  createChat: () => ["epic.createChat"] as const,
  exportArtifacts: () => ["epic.exportArtifacts"] as const,
  updateChatRunSettings: () => ["epic.updateChatRunSettings"] as const,
};

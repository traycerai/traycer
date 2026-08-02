export const epicMutationKeys = {
  create: () => ["epic.create"] as const,
  batchDelete: () => ["epic.batchDelete"] as const,
  sweepWorktrees: () => ["epic.sweepWorktrees"] as const,
  setPinned: () => ["epic.setPinned"] as const,
  recordViewed: () => ["epic.recordViewed"] as const,
  sendQueuedInvites: () => ["epic.sendQueuedInvites"] as const,
  createChat: () => ["epic.createChat"] as const,
  exportArtifacts: () => ["epic.exportArtifacts"] as const,
  updateChatRunSettings: () => ["epic.updateChatRunSettings"] as const,
  updateChatProfile: () => ["epic.updateChatProfile"] as const,
  setChatArchived: () => ["epic.setChatArchived"] as const,
  archiveChats: () => ["epic.archiveChats"] as const,
};

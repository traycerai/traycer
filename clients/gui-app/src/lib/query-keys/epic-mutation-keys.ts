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
  setCloudChatVisibility: () => ["epic.setCloudChatVisibility"] as const,
  setChatSharingDefault: () => ["epic.setChatSharingDefault"] as const,
  /**
   * Shared family for both sharing writes so a per-chat flip and the
   * master toggle are one in-flight scope per viewer. The coordinator
   * does not serialize them; this key is the client-side gate's identity.
   */
  chatSharing: (viewerUserId: string) =>
    ["epic.chatSharing", viewerUserId] as const,
  prepareArtifactImage: () => ["epic.prepareArtifactImage"] as const,
  finishArtifactImage: () => ["epic.finishArtifactImage"] as const,
  addImageToArtifact: () => ["epic.addImageToArtifact"] as const,
  archiveChats: () => ["epic.archiveChats"] as const,
  loadOlderArtifactVersions: () => ["epic.loadOlderArtifactVersions"] as const,
  restoreArtifactVersion: () => ["epic.restoreArtifactVersion"] as const,
  reviveDeletedArtifact: () => ["epic.reviveDeletedArtifact"] as const,
  setArtifactVersionCaptureEnabled: () =>
    ["epic.setArtifactVersionCaptureEnabled"] as const,
  setArtifactVersionRetentionPolicy: () =>
    ["epic.setArtifactVersionRetentionPolicy"] as const,
  clearArtifactVersionHistory: () =>
    ["epic.clearArtifactVersionHistory"] as const,
  deleteArtifact: () => ["epic.deleteArtifact"] as const,
};

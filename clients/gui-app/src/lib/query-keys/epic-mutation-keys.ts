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
  /**
   * The file plane's three verbs. Each is keyed per `(epicId, path)` so one
   * row's in-flight delete never reads as pending on another row - the Files
   * panel renders many of these side by side.
   */
  deleteFile: (epicId: string, path: string) =>
    ["epic.deleteFile", epicId, path] as const,
  restoreFile: (epicId: string, path: string) =>
    ["epic.restoreFile", epicId, path] as const,
  openFileInBrowser: (epicId: string, path: string) =>
    ["epic.openFileInBrowser", epicId, path] as const,
  /** Local only - fetch the bytes and hand them to the shell's save route. */
  saveFile: (epicId: string, path: string) =>
    ["epic.saveFile", epicId, path] as const,
};

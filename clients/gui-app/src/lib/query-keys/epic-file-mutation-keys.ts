export const epicFileMutationKeys = {
  openInBrowser: () => ["epic.openFileInBrowser"] as const,
  download: () => ["epicFile.download"] as const,
  fetch: () => ["epic.fetchFile"] as const,
  cancelFetch: () => ["epic.cancelFetchFile"] as const,
};

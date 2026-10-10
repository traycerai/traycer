export const epicFileMutationKeys = {
  download: () => ["epicFile.download"] as const,
  fetch: () => ["epic.fetchFile"] as const,
  cancelFetch: () => ["epic.cancelFetchFile"] as const,
};

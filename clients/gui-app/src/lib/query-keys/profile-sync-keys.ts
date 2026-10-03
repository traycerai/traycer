export const profileSyncMutationKeys = {
  start: (hostId: string) =>
    ["providers.profileCopy.sync.start", hostId] as const,
  saveRule: (hostId: string) =>
    ["providers.profileCopy.sync.saveRule", hostId] as const,
  stopRule: (hostId: string) =>
    ["providers.profileCopy.sync.stopRule", hostId] as const,
  resolve: (hostId: string) =>
    ["providers.profileCopy.sync.resolve", hostId] as const,
};

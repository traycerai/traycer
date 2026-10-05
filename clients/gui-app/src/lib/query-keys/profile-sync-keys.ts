import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { ProfileSyncProvider } from "@traycer/protocol/host/profile-sync-link-schemas";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

/**
 * Keys for profile sync. Every request goes to the SOURCE host, so every key
 * leads with it; a mutation key also names the device (and, for the account
 * action, the profile) it is about, so a pending request is found again by a
 * dialog that was closed and reopened while it ran.
 */
export const profileSyncKeys = {
  overview: (sourceHostId: string) =>
    hostQueryKeys.method<HostRpcRegistry, "providers.profileSync.overview">(
      sourceHostId,
      "providers.profileSync.overview",
      { sourceHostId },
    ),
  syncNow: (sourceHostId: string, destinationHostId: string) =>
    ["providers.profileSync.syncNow", sourceHostId, destinationHostId] as const,
  setKeepInSync: (sourceHostId: string, destinationHostId: string) =>
    [
      "providers.profileSync.setKeepInSync",
      sourceHostId,
      destinationHostId,
    ] as const,
  acceptAccount: (
    sourceHostId: string,
    destinationHostId: string,
    providerId: ProfileSyncProvider,
    sourceProfileId: string,
  ) =>
    [
      "providers.profileSync.acceptAccount",
      sourceHostId,
      destinationHostId,
      providerId,
      sourceProfileId,
    ] as const,
};

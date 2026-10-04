import type { ProfileSyncItem } from "@traycer/protocol/host/profile-sync-schemas";

/** Bind a row action and its error to the source/receipt state it reviewed. */
export function profileSyncItemObservationKey(item: ProfileSyncItem): string {
  return JSON.stringify([
    item.providerId,
    item.sourceProfileId,
    item.destinationHostId,
    item.state,
    item.outcome?.attempt.attemptId,
    item.outcome?.revision,
    item.sourceIdentityStamp,
    item.identityChanged,
    item.sourceSettings,
    item.destinationSettings,
    item.baseline,
  ]);
}

export const SYNC_STATE_LABELS: Record<ProfileSyncItem["state"], string> = {
  ready: "Ready",
  queued: "Queued",
  copying: "In progress",
  synced: "Synced",
  "already-present": "Already present · unchanged",
  "needs-action": "Needs attention",
  conflict: "Destination edited",
  paused: "Paused",
  unavailable: "Unavailable",
  "update-required":
    "Update Traycer on the destination device, then check status",
  unconfirmed: "Waiting for confirmation",
  "source-removed": "Profile removed",
};

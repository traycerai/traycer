import type { ProfileSyncItem } from "@traycer/protocol/host/profile-sync-schemas";
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

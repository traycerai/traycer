import type {
  ProfileSyncBatch,
  ProfileSyncItem,
} from "@traycer/protocol/host/profile-sync-schemas";
import {
  reconcileProfileCopyRetryOutcome,
  type ProfileCopyAttempt,
  type ProfileCopyOutcome,
} from "@/lib/profile-copy/profile-copy-model";

export interface ProfileSyncRetryReceipt {
  readonly batchId: string;
  readonly requested: ProfileCopyAttempt;
  readonly outcome: ProfileCopyOutcome;
}

const RETRY_PRESERVED_STATES: ReadonlySet<ProfileSyncItem["state"]> = new Set([
  "synced",
  "already-present",
  "paused",
  "conflict",
  "source-removed",
]);

function retrySyncState(outcome: ProfileCopyOutcome): ProfileSyncItem["state"] {
  switch (outcome.state) {
    case "already-present":
      return "already-present";
    case "outcome-unknown":
      return "unconfirmed";
    case "signed-in":
    case "used-without-verification":
      return "queued";
    case "preparing":
    case "signing-in":
    case "verifying":
      return "copying";
    default:
      return "needs-action";
  }
}

/** Retry updates a copy receipt; it does not confirm applied sync settings. */
export function reconcileSyncRetryBatch(
  batch: ProfileSyncBatch,
  receipt: ProfileSyncRetryReceipt,
): ProfileSyncBatch {
  if (
    batch.batchId !== receipt.batchId ||
    batch.sourceHostId !== receipt.requested.sourceHostId
  )
    return batch;
  const items = batch.items.map((item) => {
    if (
      item.operationId !== receipt.requested.operationId ||
      item.outcome === null
    )
      return item;
    const outcome = reconcileProfileCopyRetryOutcome(
      item.outcome,
      receipt.requested,
      receipt.outcome,
    );
    if (outcome === item.outcome) return item;
    return {
      ...item,
      outcome,
      state:
        item.identityChanged || RETRY_PRESERVED_STATES.has(item.state)
          ? item.state
          : retrySyncState(outcome),
    };
  });
  return items.some((item, index) => item !== batch.items[index])
    ? { ...batch, items }
    : batch;
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

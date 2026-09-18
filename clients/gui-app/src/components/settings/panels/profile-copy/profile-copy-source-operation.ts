import type {
  ProfileCopyAttempt,
  ProfileCopyOutcome,
} from "@/lib/profile-copy/profile-copy-model";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import {
  useProfileCopyOperationsStore,
  type ProfileCopyOperationHandle,
} from "@/stores/settings/profile-copy-operations-store";

/** The start request a handle records, before the source has answered. */
export type ProfileCopyStartRecord = Omit<
  ProfileCopyOperationHandle,
  "createdAt" | "startAcknowledged" | "cancelConfirmedAt"
>;

/**
 * Records the handle for a start about to be sent. It is recorded BEFORE
 * dispatch: a lost answer reopens from Recent copies and can send this same
 * request again.
 */
export function recordProfileCopyStart(record: ProfileCopyStartRecord): void {
  useProfileCopyOperationsStore.getState().record({
    ...record,
    createdAt: Date.now(),
    startAcknowledged: false,
    cancelConfirmedAt: null,
  });
}

/**
 * Opens the SOURCE's view of an incoming draft's operation: `retry` is served
 * by the source only, against the revision the source holds, so it is offered
 * there. A handle is rebuilt for an operation this window never started - it
 * names only this destination, and the source's answer lists the rest.
 */
export function openProfileCopySourceOperation(
  attempt: ProfileCopyAttempt,
): void {
  const operations = useProfileCopyOperationsStore.getState();
  const known = operations.handles.some(
    (handle) => handle.operationId === attempt.operationId,
  );
  if (!known) {
    operations.record({
      operationId: attempt.operationId,
      sourceHostId: attempt.sourceHostId,
      sourceProfileId: attempt.sourceProfileId,
      providerId: attempt.providerId,
      destinationHostIds: [attempt.destinationHostId],
      previewRevision: null,
      previewRecords: [],
      createdAt: Date.now(),
      startAcknowledged: true,
      cancelConfirmedAt: null,
    });
  }
  useProfileCopyFlowStore
    .getState()
    .open({ kind: "operation", operationId: attempt.operationId });
}

/** Interrupted and not yet replaced: only the source can make a fresh copy. */
export function retryFromSourceOffered(outcome: ProfileCopyOutcome): boolean {
  return (
    outcome.state === "quarantined" && outcome.replacementAttemptId === null
  );
}

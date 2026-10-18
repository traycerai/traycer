import {
  HostRequestAbortedError,
  RetryableTransportError,
  type HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { toast } from "sonner";
import {
  isHostTransportFailure,
  isSilentHostError,
  isUnknownOutcomeTransportFailure,
  toastFromHostError,
  toastFromHostRefusalsInBatch,
  toastHostUnknownOutcome,
} from "@/lib/host-error-toast";

/**
 * One id for every attempt, so a person who retries a few times against a host
 * that cannot be reached reads a single line rather than a stack of them.
 */
const OWNER_HOST_UNREACHABLE_TOAST_ID = "owner-host-unreachable-notice";

export const OWNER_HOST_UNREACHABLE_NOTICE =
  "Traycer can't reach that host right now, so nothing on it was changed. Try again once it is reachable.";

const OWNER_HOST_UNREACHABLE_BATCH_ONE_HOST_NOTICE =
  "Traycer can't reach the host these agents run on, so nothing on it was changed. Try again once it is reachable.";

const OWNER_HOST_UNREACHABLE_BATCH_HOSTS_NOTICE =
  "Traycer can't reach the hosts these agents run on, so nothing on them was changed. Try again once they are reachable.";

/**
 * Whether this failure proves the request never reached the host.
 *
 * A `RetryableTransportError` with no `fatalDetails` and
 * `replaySafetyFromKey: false` is the pre-send class - the session was not
 * ready, the host was detached from the relay, the dial failed - which is the
 * guarantee that makes "nothing on it was changed" true. It says nothing about
 * WHY the host could not be reached (it may be off, or this machine's network
 * or the relay may be what is down), so the notice names only the symptom. It
 * is deliberately not the broader transport class: a post-send drop may have
 * been executed (the ordinary notice says so), a retryable error carrying
 * `fatalDetails` is the host's own attestation that it WAS reached, and one
 * with `replaySafetyFromKey: true` is the timeout or drop of a keyed request
 * that was already sent, which the host may have run.
 */
export function isOwnerHostUnreachableFailure(error: HostRpcError): boolean {
  return (
    error instanceof RetryableTransportError &&
    error.fatalDetails === null &&
    !error.replaySafetyFromKey
  );
}

/**
 * The prefix of each action's result notice id: a batch's, and a single
 * write's whose outcome is unknown. Every action gets its own id
 * ({@link nextBatchResultToastId}), so a result finishing in one Task never
 * replaces the result of an action in another.
 */
const OWNER_HOST_BATCH_RESULT_TOAST_ID = "owner-host-batch-result";

let batchResultSequence = 0;

/** A fresh notice id for one action. */
function nextBatchResultToastId(): string {
  batchResultSequence += 1;
  return `${OWNER_HOST_BATCH_RESULT_TOAST_ID}:${String(batchResultSequence)}`;
}

/**
 * An abort after the request may have reached its host: the caller stopped
 * waiting, but the host may still have run the write.
 */
function isDispatchedAbort(error: HostRpcError): boolean {
  return error instanceof HostRequestAbortedError && error.mayHaveDispatched;
}

/**
 * Whether a failed write may still have applied: it was sent and its answer
 * was lost, unkeyed (`isUnknownOutcomeTransportFailure`) or keyed
 * (`replaySafetyFromKey`), or it was aborted after it was sent.
 */
function writeMayHaveApplied(error: HostRpcError): boolean {
  // `isUnknownOutcomeTransportFailure` covers the keyed sent-and-dropped
  // `RetryableTransportError` too, attested or not.
  return isUnknownOutcomeTransportFailure(error) || isDispatchedAbort(error);
}

/**
 * The error toast for a write that has to run on the host that owns the record
 * (archive or delete an agent, delete a Task): when the request never reached
 * that host, say so and say nothing on it changed.
 *
 * A write whose outcome is unknown - its answer was lost, or it was aborted
 * after it was sent - says so under its own id (row 3 of the spec in
 * traycerai/traycer#2546). The ordinary toast says nothing for an abort, which
 * is right only when the request never left.
 *
 * Every other failure keeps the ordinary toast. This changes the wording only;
 * where the write is sent is unchanged.
 */
export function toastFromOwnerHostWriteError(
  error: HostRpcError,
  fallback: string,
): void {
  if (writeMayHaveApplied(error)) {
    toastHostUnknownOutcome(nextBatchResultToastId());
    return;
  }
  if (isOwnerHostUnreachableFailure(error)) {
    toast.message(OWNER_HOST_UNREACHABLE_NOTICE, {
      id: OWNER_HOST_UNREACHABLE_TOAST_ID,
    });
    return;
  }
  toastFromHostError(error, fallback);
}

/**
 * One write of a batch: what it wrote (an agent on its owning host, or an
 * artifact on the Task's host), the host it was sent to, how many SELECTED
 * rows it stands for, and its failure if any.
 *
 * `selectedRows` is 1 for an agent. An artifact delete cascades to its
 * subtree, so a selection holding an artifact and artifacts under it sends
 * one delete for all of them; that write stands for every selected row it
 * covers, and the notice counts them all as deleted or not deleted with it.
 */
export interface OwnerHostBatchWriteOutcome {
  readonly kind: "agent" | "artifact";
  readonly hostId: string | null;
  readonly selectedRows: number;
  readonly error: HostRpcError | null;
}

/** What a batch's notice says, in the words of the write it ran. */
export interface OwnerHostBatchWriteCopy {
  /** The failure of a batch with one write in it, e.g. "Couldn't archive agent." */
  readonly single: string;
  /** Some selected rows were changed and the rest were not. */
  readonly partial: (applied: number, failed: number) => string;
  /** No selected row was changed, for more than one reason. */
  readonly none: (attempted: number) => string;
  /** At least one write may or may not have applied. */
  readonly unconfirmed: (attempted: number) => string;
}

/**
 * Whether a failure is left out of the batch's notice: a write cancelled
 * before it was sent, or one the app is quietly re-authorizing. A cancel
 * after the send is NOT left out - the host may have run it.
 */
function isLeftOutOfBatch(error: HostRpcError): boolean {
  return isSilentHostError(error) && !isDispatchedAbort(error);
}

function selectedRowsOf(
  outcomes: readonly OwnerHostBatchWriteOutcome[],
): number {
  return outcomes.reduce((sum, outcome) => sum + outcome.selectedRows, 0);
}

/**
 * The one notice for a batch of writes (archive or delete several agents, or
 * delete a selection of agents and artifacts), whose members raise none of
 * their own. Each row below is a row of the spec in traycerai/traycer#2546.
 *
 *  - Left out first: a write cancelled before it was sent, or one being
 *    re-authorized, says nothing and counts for nothing.
 *  - One counted write reads like the single write it is; if its outcome is
 *    unknown (a lost answer, a keyed retry failure, or an abort after its
 *    send), it says its answer never came back.
 *  - A write that may have applied makes the result unknown: the notice says
 *    so, always, followed by the advice of any refusals.
 *  - "Nothing on it was changed" holds only for a batch of agents in which
 *    every write never reached its host.
 *  - Otherwise the counts of selected rows, followed by every distinct piece
 *    of refusal advice (`toastFromHostRefusalsInBatch`).
 */
export function toastFromOwnerHostBatchWriteFailures(
  outcomes: readonly OwnerHostBatchWriteOutcome[],
  copy: OwnerHostBatchWriteCopy,
): void {
  toastFromOwnerHostBatchWriteFailuresWithUnconfirmed(outcomes, 0, copy);
}

/**
 * {@link toastFromOwnerHostBatchWriteFailures} for a batch with
 * `unconfirmedRows` more selected rows whose write the host answered without
 * confirming it changed them - neither applied nor failed. They stay in the
 * selection's count, and beside any failure they make the result unknown, so
 * the notice is the `unconfirmed` summary. With no failure the batch stays
 * quiet, as an all-applied one does.
 */
export function toastFromOwnerHostBatchWriteFailuresWithUnconfirmed(
  outcomes: readonly OwnerHostBatchWriteOutcome[],
  unconfirmedRows: number,
  copy: OwnerHostBatchWriteCopy,
): void {
  const counted = outcomes.filter(
    (outcome) => outcome.error === null || !isLeftOutOfBatch(outcome.error),
  );
  const failed = counted.filter((outcome) => outcome.error !== null);
  const failures = failed.flatMap((outcome) =>
    outcome.error === null ? [] : [outcome.error],
  );
  if (failures.length === 0) return;
  const toastId = nextBatchResultToastId();
  if (counted.length === 1 && unconfirmedRows === 0) {
    if (writeMayHaveApplied(failures[0])) {
      toastHostUnknownOutcome(toastId);
      return;
    }
    toastFromOwnerHostWriteError(failures[0], copy.single);
    return;
  }
  const attempted = selectedRowsOf(counted) + unconfirmedRows;
  const refusals = failures.filter(
    (failure) => !isHostTransportFailure(failure),
  );
  if (unconfirmedRows > 0 || failures.some(writeMayHaveApplied)) {
    // The unconfirmed rows changed nothing, so the reachability line the
    // counted rows would carry on their own stays true beside them.
    const unreachable =
      unconfirmedRows > 0
        ? unreachableNoticeOfCounted(counted, failures)
        : null;
    const lead =
      unreachable === null
        ? copy.unconfirmed(attempted)
        : `${copy.unconfirmed(attempted)} ${unreachable}`;
    if (refusals.length > 0) {
      toastFromHostRefusalsInBatch(refusals, copy.single, lead, toastId);
      return;
    }
    toast.error(lead, { id: toastId });
    return;
  }
  const notChanged = selectedRowsOf(failed);
  const applied = attempted - notChanged;
  if (
    applied === 0 &&
    counted.every((outcome) => outcome.kind === "agent") &&
    failures.every(isOwnerHostUnreachableFailure)
  ) {
    toast.message(
      ownerHostsUnreachableBatchNotice(
        counted.map((outcome) => outcome.hostId),
      ),
      { id: toastId },
    );
    return;
  }
  const summary =
    applied === 0 ? copy.none(attempted) : copy.partial(applied, notChanged);
  if (refusals.length > 0) {
    toastFromHostRefusalsInBatch(refusals, copy.single, summary, toastId);
    return;
  }
  toast.error(summary, { id: toastId });
}

/**
 * The notice for a batch write in which every request failed with
 * `isOwnerHostUnreachableFailure`. A batch can span agents on several hosts, so
 * the copy is singular only when one host owns them all.
 */
function ownerHostsUnreachableBatchNotice(
  ownerHostIds: readonly (string | null)[],
): string {
  return new Set(ownerHostIds).size === 1
    ? OWNER_HOST_UNREACHABLE_BATCH_ONE_HOST_NOTICE
    : OWNER_HOST_UNREACHABLE_BATCH_HOSTS_NOTICE;
}

/**
 * The reachability line the counted rows give when no unconfirmed row is
 * beside them, or `null` when they give none: one write that never reached its
 * host, or a batch of agents in which every write never reached its host.
 * Only those cases, so "nothing on it was changed" is never said beside a
 * write that applied.
 */
function unreachableNoticeOfCounted(
  counted: readonly OwnerHostBatchWriteOutcome[],
  failures: readonly HostRpcError[],
): string | null {
  if (!failures.every(isOwnerHostUnreachableFailure)) return null;
  if (counted.length === 1) return OWNER_HOST_UNREACHABLE_NOTICE;
  if (
    failures.length !== counted.length ||
    !counted.every((outcome) => outcome.kind === "agent")
  ) {
    return null;
  }
  return ownerHostsUnreachableBatchNotice(
    counted.map((outcome) => outcome.hostId),
  );
}

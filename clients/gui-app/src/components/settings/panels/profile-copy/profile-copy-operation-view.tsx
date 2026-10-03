import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { observeProfileCopyOutcome } from "@/hooks/providers/profile-copy/profile-copy-observations";
import {
  useProfileCopyCancelMutation,
  useProfileCopyRetryMutation,
  useProfileCopyStartMutation,
} from "@/hooks/providers/profile-copy/use-profile-copy-operation-mutations";
import { useProfileCopyStatusQuery } from "@/hooks/providers/profile-copy/use-profile-copy-queries";
import {
  isOutcomePromoted,
  isOutcomeSettled,
  isRecordedOutcome,
  knownRouteFromRecord,
  profileCopyOperationRows,
  profileCopySourceRecovery,
  type ProfileCopyKnownRoute,
  type ProfileCopyOperationRow,
  type ProfileCopyOutcome,
  type ProfileCopyPreviewRecord,
} from "@/lib/profile-copy/profile-copy-model";
import {
  presentProfileCopyOutcome,
  presentProfileCopyPreview,
  type ProfileCopyNames,
} from "@/lib/profile-copy/profile-copy-presentation";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import {
  useProfileCopyOperationHandle,
  useProfileCopyOperationsStore,
  type ProfileCopyOperationHandle,
} from "@/stores/settings/profile-copy-operations-store";
import { ProfileCopyDraftPanel } from "./profile-copy-draft-panel";
import { ProfileCopyBadge } from "./profile-copy-badge";
import {
  profileCopyProviderLabel,
  profileCopyRequestErrorText,
  useProfileCopySettingsNavigation,
  useProfileCopySourceProfile,
  type ProfileCopyHosts,
} from "./profile-copy-shared";

/**
 * One operation, reopened from its handle: every destination's head as the
 * SOURCE reports it, with the destination's own draft panel for a row the
 * destination holds. Everything here dials the source and destination ids the
 * handle captured; closing the dialog stops the reads and nothing else.
 */
export function ProfileCopyOperationView(props: {
  readonly operationId: string;
  readonly hosts: ProfileCopyHosts;
}): ReactNode {
  const handle = useProfileCopyOperationHandle(props.operationId);
  const closeFlow = useProfileCopyFlowStore((state) => state.close);
  if (handle === null) {
    return (
      <>
        <DialogHeader className="gap-1.5">
          <DialogTitle>Copy not found</DialogTitle>
          <DialogDescription>
            This copy is no longer in this window&apos;s list. It was removed
            here or from another window.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={closeFlow}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }
  return <ProfileCopyOperationBody handle={handle} hosts={props.hosts} />;
}

function ProfileCopyOperationBody(props: {
  readonly handle: ProfileCopyOperationHandle;
  readonly hosts: ProfileCopyHosts;
}): ReactNode {
  const { handle, hosts } = props;
  const sourceHostId = handle.sourceHostId;
  const operationId = handle.operationId;
  const sourceName = hosts.nameFor(sourceHostId);
  const providerLabel = profileCopyProviderLabel(handle.providerId);
  const queryClient = useQueryClient();
  const closeFlow = useProfileCopyFlowStore((state) => state.close);
  const openView = useProfileCopyFlowStore((state) => state.open);
  const acknowledgeStart = useProfileCopyOperationsStore(
    (state) => state.acknowledgeStart,
  );
  const markCancelConfirmed = useProfileCopyOperationsStore(
    (state) => state.markCancelConfirmed,
  );
  const removeHandle = useProfileCopyOperationsStore((state) => state.remove);
  const markSettled = useProfileCopyOperationsStore(
    (state) => state.markSettled,
  );

  const profileName = useProfileCopySourceProfile(
    sourceHostId,
    handle.providerId,
    handle.sourceProfileId,
  ).profileName;

  const status = useProfileCopyStatusQuery(sourceHostId, operationId);
  const start = useProfileCopyStartMutation(sourceHostId, "keep-handle");
  const cancel = useProfileCopyCancelMutation(sourceHostId, operationId);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const outcomes = status.data?.outcomes ?? null;

  // The source answered, so the operation exists there: a start this window
  // never heard back from is acknowledged by the first read that finds it.
  const statusSucceeded = status.isSuccess;
  useEffect(() => {
    if (statusSucceeded && !handle.startAcknowledged) {
      acknowledgeStart(operationId);
    }
  }, [
    acknowledgeStart,
    handle.startAcknowledged,
    operationId,
    statusSucceeded,
  ]);

  useEffect(() => {
    if (outcomes === null) return;
    for (const outcome of outcomes)
      observeProfileCopyOutcome(queryClient, outcome);
  }, [outcomes, queryClient]);

  const rows = profileCopyOperationRows(
    handle.destinationHostIds,
    handle.previewRecords,
    outcomes,
  );
  // Recent copies lets a handle fall off past its cap only once a read found
  // nothing left to move: every destination settled or never attempted.
  const observedSettled =
    outcomes === null
      ? null
      : rows.every(
          (row) =>
            row.kind === "preview-only" ||
            (row.kind === "attempt" && isOutcomeSettled(row.outcome)),
        );
  useEffect(() => {
    if (observedSettled !== null) markSettled(operationId, observedSettled);
  }, [markSettled, observedSettled, operationId]);
  // Offered while anything is unsettled, whatever this window already sent:
  // the source treats a repeated cancel as the same cancel, and a cancel
  // whose answer was lost may never have reached it.
  const cancelOffered =
    outcomes !== null && outcomes.some((outcome) => !isOutcomeSettled(outcome));

  const names = (destinationHostId: string): ProfileCopyNames => ({
    source: sourceName,
    destination: hosts.nameFor(destinationHostId),
    provider: providerLabel,
    profile: profileName,
  });

  const copyAgain = (): void => {
    openView({
      kind: "new",
      sourceHostId,
      providerId: handle.providerId,
      sourceProfileId: handle.sourceProfileId,
    });
  };

  const previewRevision = handle.previewRevision;
  const startAgain = (): void => {
    if (previewRevision === null) return;
    // An empty answer (nothing started) is handled by the start hook itself:
    // it forgets the handle and returns this dialog to the device list.
    start.mutate({
      sourceHostId,
      sourceProfileId: handle.sourceProfileId,
      providerId: handle.providerId,
      destinationHostIds: [...handle.destinationHostIds],
      operationId,
      previewRevision,
    });
  };

  const onConfirmCancel = (): void => {
    cancel.mutate(
      { sourceHostId, operationId },
      {
        // Only a confirmed cancel is remembered: it words the rows as
        // cancelling and withholds Retry. A failed one leaves no mark.
        onSuccess: () => markCancelConfirmed(operationId, Date.now()),
        onSettled: () => setConfirmCancel(false),
      },
    );
  };

  // Before the source's first answer an error is the whole story; after it,
  // the last answer stays on screen with a note that it may be stale.
  const statusError = status.isError ? status.error : null;
  const staleStatus = outcomes !== null && statusError !== null;

  return (
    <>
      <DialogHeader className="gap-1.5">
        <DialogTitle>
          Copying “{profileName}” from {sourceName}
        </DialogTitle>
        <DialogDescription>
          Each device finishes on its own. Devices that need you show what to do
          next.
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 py-4">
        {outcomes === null && status.isPending ? (
          <div className="flex items-center gap-2 text-ui-xs text-muted-foreground">
            <MutedAgentSpinner />
            Checking with {sourceName}…
          </div>
        ) : null}
        {outcomes === null && statusError !== null ? (
          <ProfileCopyStatusErrorNotice
            error={statusError}
            handle={handle}
            sourceName={sourceName}
            startPending={start.isPending}
            startError={start.error}
            checkPending={status.isFetching}
            onStartAgain={startAgain}
            onCheckAgain={() => void status.refetch()}
            onCopyAgain={copyAgain}
            onRemove={() => {
              removeHandle(operationId);
              closeFlow();
            }}
          />
        ) : null}
        {staleStatus ? (
          <p className="text-ui-xs text-muted-foreground" role="status">
            Couldn&apos;t reach {sourceName} just now. Showing its last answer.
          </p>
        ) : null}
        <ul className="flex flex-col gap-2" aria-label="Devices">
          {rows.map((row) => (
            <ProfileCopyOperationRowView
              key={row.destinationHostId}
              row={row}
              handle={handle}
              names={names(row.destinationHostId)}
              destinationIsLocal={hosts.isLocalMachine(row.destinationHostId)}
              statusKnown={outcomes !== null}
              checkPending={status.isFetching}
              onCheckAgain={() => void status.refetch()}
              onCopyAgain={copyAgain}
            />
          ))}
        </ul>
        {cancel.isError ? (
          <p className="text-ui-xs text-destructive" role="alert">
            {profileCopyRequestErrorText(cancel.error, sourceName)}
          </p>
        ) : null}
      </div>
      <ProfileCopyOperationFooter
        cancelOffered={cancelOffered}
        cancelPending={cancel.isPending}
        onCancel={() => setConfirmCancel(true)}
        onClose={closeFlow}
      />
      <ConfirmDestructiveDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this copy?"
        description="Devices that haven't finished get nothing. Devices that already finished keep their profile."
        cascadeSummary={null}
        actionLabel="Cancel copy"
        isPending={cancel.isPending}
        blockedReason={null}
        onConfirm={onConfirmCancel}
      />
    </>
  );
}

function ProfileCopyOperationFooter(props: {
  readonly cancelOffered: boolean;
  readonly cancelPending: boolean;
  readonly onCancel: () => void;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <DialogFooter className="gap-2">
      <p className="mr-auto self-center text-ui-xs text-muted-foreground">
        Closing doesn&apos;t stop the copy. Find it under Recent copies.
      </p>
      {props.cancelOffered ? (
        <Button
          type="button"
          variant="ghost"
          disabled={props.cancelPending}
          onClick={props.onCancel}
        >
          {props.cancelPending ? <MutedAgentSpinner /> : null}
          Cancel copy
        </Button>
      ) : null}
      <Button type="button" variant="outline" onClick={props.onClose}>
        Close
      </Button>
    </DialogFooter>
  );
}

function statusErrorMessage(
  error: HostRpcError,
  unacknowledged: boolean,
  sourceName: string,
): string {
  if (unacknowledged) {
    return `This copy may not have started — ${sourceName} has no record of it, or couldn't check your devices just now. Starting again is safe: it never makes a second copy.`;
  }
  switch (error.code) {
    case "FORBIDDEN":
      return `${sourceName} couldn't confirm this copy right now. This is usually temporary.`;
    case "E_HOST_UNSUPPORTED":
      return `Update Traycer on ${sourceName} to see this copy.`;
    default:
      return profileCopyRequestErrorText(error, sourceName);
  }
}

/**
 * The source could not show the operation. Which recovery is honest depends
 * on whether this window ever heard the start land: FORBIDDEN is both "no
 * such operation" and "couldn't read your devices", and only an
 * unacknowledged start can be the first.
 */
function ProfileCopyStatusErrorNotice(props: {
  readonly error: HostRpcError;
  readonly handle: ProfileCopyOperationHandle;
  readonly sourceName: string;
  readonly startPending: boolean;
  readonly startError: HostRpcError | null;
  readonly checkPending: boolean;
  readonly onStartAgain: () => void;
  readonly onCheckAgain: () => void;
  readonly onCopyAgain: () => void;
  readonly onRemove: () => void;
}): ReactNode {
  const { error, handle, sourceName } = props;
  const unacknowledged =
    error.code === "FORBIDDEN" &&
    !handle.startAcknowledged &&
    handle.previewRevision !== null;
  const message = statusErrorMessage(error, unacknowledged, sourceName);
  const startRefused = props.startError?.code === "E_INVALID_ARGUMENT";
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 p-3"
      role="status"
    >
      <p className="text-ui-xs text-warning-foreground">{message}</p>
      {startRefused ? (
        <p className="text-ui-xs text-warning-foreground">
          The check this copy was started from is out of date. Start a new copy
          instead.
        </p>
      ) : null}
      {props.startError !== null && !startRefused ? (
        <p className="text-ui-xs text-destructive" role="alert">
          {profileCopyRequestErrorText(props.startError, sourceName)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {unacknowledged && !startRefused ? (
          <Button
            type="button"
            size="sm"
            disabled={props.startPending}
            onClick={props.onStartAgain}
          >
            {props.startPending ? <MutedAgentSpinner /> : null}
            Start again
          </Button>
        ) : null}
        {startRefused ? (
          <Button type="button" size="sm" onClick={props.onCopyAgain}>
            Copy again
          </Button>
        ) : null}
        {error.code !== "E_HOST_UNSUPPORTED" && !unacknowledged ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.checkPending}
            onClick={props.onCheckAgain}
          >
            {props.checkPending ? <MutedAgentSpinner /> : null}
            Check again
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={props.onRemove}
        >
          Remove from list
        </Button>
      </div>
    </div>
  );
}

function ProfileCopyOperationRowView(props: {
  readonly row: ProfileCopyOperationRow;
  readonly handle: ProfileCopyOperationHandle;
  readonly names: ProfileCopyNames;
  readonly destinationIsLocal: boolean;
  /** The source has answered at least once. */
  readonly statusKnown: boolean;
  readonly checkPending: boolean;
  readonly onCheckAgain: () => void;
  readonly onCopyAgain: () => void;
}): ReactNode {
  const { row, names } = props;
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-border/60 p-2.5">
      <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">
        {names.destination}
      </span>
      {row.kind === "attempt" ? (
        <ProfileCopyAttemptRow
          outcome={row.outcome}
          route={knownRouteFromRecord(row.preview)}
          handle={props.handle}
          names={names}
          destinationIsLocal={props.destinationIsLocal}
          checkPending={props.checkPending}
          onCheckAgain={props.onCheckAgain}
          onCopyAgain={props.onCopyAgain}
        />
      ) : null}
      {row.kind === "preview-only" ? (
        <ProfileCopyPreviewOnlyRow record={row.preview} names={names} />
      ) : null}
      {row.kind === "unreported" ? (
        <p className="text-ui-xs text-muted-foreground">
          {props.statusKnown
            ? `${names.source} reports no copy to ${names.destination} for this operation.`
            : `Waiting for ${names.source} to report ${names.destination}.`}
        </p>
      ) : null}
    </li>
  );
}

function ProfileCopyPreviewOnlyRow(props: {
  readonly record: ProfileCopyPreviewRecord;
  readonly names: ProfileCopyNames;
}): ReactNode {
  const presentation = presentProfileCopyPreview(props.record, props.names);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <ProfileCopyBadge tone={presentation.tone} label={presentation.badge} />
      </div>
      <p className="text-ui-xs text-muted-foreground">
        Not included in this copy. {presentation.body}
      </p>
    </div>
  );
}

/** Retry answers other than `current`, for the revision they came back at. */
interface RetryNotice {
  readonly kind: "stale-revision" | "unavailable";
  readonly revision: number;
}

interface AttemptRetry {
  readonly pending: boolean;
  readonly error: HostRpcError | null;
  /** A non-`current` answer, while the row has not moved past it. */
  readonly notice: RetryNotice | null;
  readonly run: () => void;
}

function useProfileCopyAttemptRetry(
  handle: ProfileCopyOperationHandle,
  outcome: ProfileCopyOutcome,
): AttemptRetry {
  const retry = useProfileCopyRetryMutation(
    handle.sourceHostId,
    handle.operationId,
  );
  // A lost answer can be retried after reopening this view, with the same ID.
  const getRetryRequestId = useProfileCopyFlowStore(
    (state) => state.getProfileCopyRetryRequestId,
  );
  const [notice, setNotice] = useState<RetryNotice | null>(null);

  const run = (): void => {
    const retryRequestId = getRetryRequestId(outcome.attempt, outcome.revision);
    setNotice(null);
    retry.mutate(
      {
        attempt: outcome.attempt,
        expectedRevision: outcome.revision,
        retryRequestId,
      },
      {
        onSuccess: (response) => {
          if (response.result !== "current") {
            setNotice({
              kind: response.result,
              revision: response.outcome.revision,
            });
          }
        },
      },
    );
  };

  return {
    pending: retry.isPending,
    error: retry.isError ? retry.error : null,
    notice:
      notice !== null && notice.revision >= outcome.revision ? notice : null,
    run,
  };
}

function ProfileCopyRetryFeedback(props: {
  readonly retry: AttemptRetry;
  readonly names: ProfileCopyNames;
}): ReactNode {
  const { notice, error } = props.retry;
  const { names } = props;
  return (
    <>
      {notice !== null ? (
        <p className="text-ui-xs text-warning-foreground" role="status">
          {notice.kind === "stale-revision"
            ? "This changed since you last looked. Review it again."
            : `Retry isn't possible right now. ${names.destination} may be offline, a sign-in there may still be holding a shared resource, or this copy was cancelled.`}
        </p>
      ) : null}
      {error !== null ? (
        <p className="text-ui-xs text-destructive" role="alert">
          {profileCopyRequestErrorText(error, names.source)}
        </p>
      ) : null}
    </>
  );
}

/** What the SOURCE offers for one attempt, in display order. */
type AttemptSourceAction = "retry" | "copy-again" | "check-again" | "set-up";

function attemptSourceActions(
  outcome: ProfileCopyOutcome,
  cancelRequested: boolean,
): readonly AttemptSourceAction[] {
  const recovery = profileCopySourceRecovery(outcome, cancelRequested);
  const installRequired =
    !isRecordedOutcome(outcome) &&
    outcome.state === "blocked" &&
    outcome.reason === "install-required";
  const offered: readonly (AttemptSourceAction | null)[] = [
    recovery === "retry" ? "retry" : null,
    recovery === "copy-again" ? "copy-again" : null,
    outcome.state === "outcome-unknown" ? "check-again" : null,
    installRequired ? "set-up" : null,
  ];
  return offered.filter(
    (action): action is AttemptSourceAction => action !== null,
  );
}

function ProfileCopyAttemptSourceButtons(props: {
  readonly actions: readonly AttemptSourceAction[];
  readonly destinationName: string;
  readonly retry: AttemptRetry;
  readonly checkPending: boolean;
  readonly onCopyAgain: () => void;
  readonly onCheckAgain: () => void;
  readonly onSetUp: () => void;
}): ReactNode {
  const { retry, checkPending } = props;
  return props.actions.map((action) => {
    switch (action) {
      case "retry":
        return (
          <Button
            key={action}
            type="button"
            size="sm"
            disabled={retry.pending}
            onClick={retry.run}
          >
            {retry.pending ? <MutedAgentSpinner /> : null}
            Retry
          </Button>
        );
      case "copy-again":
        return (
          <Button
            key={action}
            type="button"
            size="sm"
            variant="outline"
            onClick={props.onCopyAgain}
          >
            Copy again
          </Button>
        );
      case "check-again":
        return (
          <Button
            key={action}
            type="button"
            size="sm"
            variant="outline"
            disabled={checkPending}
            onClick={props.onCheckAgain}
          >
            {checkPending ? <MutedAgentSpinner /> : null}
            Check again
          </Button>
        );
      case "set-up":
        return (
          <Button
            key={action}
            type="button"
            size="sm"
            variant="outline"
            onClick={props.onSetUp}
          >
            Set up on {props.destinationName}
          </Button>
        );
    }
  });
}

function ProfileCopyAttemptRow(props: {
  readonly outcome: ProfileCopyOutcome;
  readonly route: ProfileCopyKnownRoute;
  readonly handle: ProfileCopyOperationHandle;
  readonly names: ProfileCopyNames;
  readonly destinationIsLocal: boolean;
  readonly checkPending: boolean;
  readonly onCheckAgain: () => void;
  readonly onCopyAgain: () => void;
}): ReactNode {
  const { outcome, handle, names } = props;
  const cancelRequested = handle.cancelConfirmedAt !== null;
  const retry = useProfileCopyAttemptRetry(handle, outcome);
  const navigation = useProfileCopySettingsNavigation();
  const actions = attemptSourceActions(outcome, cancelRequested);
  const sourceButtons =
    actions.length === 0 ? null : (
      <ProfileCopyAttemptSourceButtons
        actions={actions}
        destinationName={names.destination}
        retry={retry}
        checkPending={props.checkPending}
        onCopyAgain={props.onCopyAgain}
        onCheckAgain={props.onCheckAgain}
        onSetUp={() =>
          navigation.openDestinationSetup({
            destinationHostId: outcome.attempt.destinationHostId,
            provider: outcome.attempt.providerId,
          })
        }
      />
    );

  // A row the destination holds and has not finished - or has promoted -
  // is driven from the destination's own draft panel.
  if (
    isRecordedOutcome(outcome) &&
    (!isOutcomeSettled(outcome) || isOutcomePromoted(outcome))
  ) {
    return (
      <>
        <ProfileCopyDraftPanel
          outcome={outcome}
          names={names}
          route={props.route}
          cancelRequested={cancelRequested}
          destinationIsLocal={props.destinationIsLocal}
          extraActions={sourceButtons}
        />
        <ProfileCopyRetryFeedback retry={retry} names={names} />
      </>
    );
  }

  const presentation = presentProfileCopyOutcome(outcome, {
    names,
    route: props.route,
    cancelRequested,
  });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <ProfileCopyBadge tone={presentation.tone} label={presentation.badge} />
      </div>
      <p className="text-ui-xs leading-relaxed text-muted-foreground">
        {presentation.body}
      </p>
      {presentation.note !== null ? (
        <p className="text-ui-xs text-muted-foreground">{presentation.note}</p>
      ) : null}
      <ProfileCopyRetryFeedback retry={retry} names={names} />
      {sourceButtons !== null ? (
        <div className="flex flex-wrap gap-2 pt-0.5">{sourceButtons}</div>
      ) : null}
    </div>
  );
}

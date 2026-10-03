import { SYNC_STATE_LABELS } from "./profile-sync-state";
import { useState, type ReactNode } from "react";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProfileSyncBatch,
  ProfileSyncItem,
} from "@traycer/protocol/host/profile-sync-schemas";
import { Button } from "@/components/ui/button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useProfileSyncResolve } from "@/hooks/providers/use-profile-sync";
import { useProfileCopyRetryMutation } from "@/hooks/providers/profile-copy/use-profile-copy-operation-mutations";
import { useProfileCopyDraftPending } from "@/hooks/providers/profile-copy/use-profile-copy-draft-pending";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import {
  profileCopySourceRecovery,
  profileCopyPreviewRecord,
  knownRouteFromRecord,
  isRecordedOutcome,
} from "@/lib/profile-copy/profile-copy-model";
import { presentProfileCopyOutcome } from "@/lib/profile-copy/profile-copy-presentation";
import { ProfileCopyDraftPanel } from "../profile-copy/profile-copy-draft-panel";
import { ProfileCopyBadge } from "../profile-copy/profile-copy-badge";
import {
  profileCopyProviderLabel,
  profileCopyRequestErrorText,
  type ProfileCopyHosts,
} from "../profile-copy/profile-copy-shared";

export function ProfileSyncResults(props: {
  readonly sourceHostId: string;
  readonly batch: ProfileSyncBatch;
  readonly hosts: ProfileCopyHosts;
}): ReactNode {
  if (props.batch.sourceHostId !== props.sourceHostId)
    return (
      <p role="alert" className="text-ui-xs text-destructive">
        The device returned a run for another source. Check sync history again.
      </p>
    );
  const destinations = [
    ...new Set(props.batch.items.map((i) => i.destinationHostId)),
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-ui-xs text-muted-foreground">
        Completed profiles stay completed. Closing this dialog does not cancel
        the run.
      </p>
      {destinations.map((id) => (
        <section key={id} className="rounded-lg border border-border/60 p-3">
          <h3 className="text-ui-sm font-medium">{props.hosts.nameFor(id)}</h3>
          <div className="flex flex-col divide-y divide-border/50">
            {props.batch.items
              .filter((i) => i.destinationHostId === id)
              .map((item) => (
                <ProfileSyncResultItem
                  key={item.operationId}
                  sourceHostId={props.sourceHostId}
                  item={item}
                  batch={props.batch}
                  hosts={props.hosts}
                />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
function ProfileSyncResultItem(props: {
  readonly sourceHostId: string;
  readonly batch: ProfileSyncBatch;
  readonly item: ProfileSyncItem;
  readonly hosts: ProfileCopyHosts;
}): ReactNode {
  const { item, batch, hosts, sourceHostId } = props;
  const [expanded, setExpanded] = useState(false);
  const resolve = useProfileSyncResolve(sourceHostId);
  const resolveError = useProfileSyncItemError(item, resolve.error);
  const retry = useProfileSyncItemRetry(sourceHostId, item);
  const draftPending = useProfileCopyDraftPending(
    sourceHostId,
    item.operationId,
    item.destinationHostId,
  );
  const sourceName = hosts.nameFor(sourceHostId);
  const pending = resolve.isPending || retry.pending || draftPending;
  const doResolve = (
    action: "check" | "keep-destination" | "use-source",
  ): void => {
    if (pending || (action === "use-source" && item.identityChanged)) return;
    resolveError.capture();
    resolve.mutate({
      sourceHostId,
      batchId: batch.batchId,
      operationId: item.operationId,
      action,
      expectedDestination: item.destinationSettings,
    });
  };
  const error = resolveError.error ?? retry.error;
  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-ui-sm">
            {profileCopyProviderLabel(item.providerId)} / {item.name}
          </p>
          <p className="text-ui-xs text-muted-foreground">
            {SYNC_STATE_LABELS[item.state]}
          </p>
        </div>
        <ProfileSyncResultActions
          item={item}
          pending={pending}
          checkPending={resolve.isPending}
          retry={retry}
          expanded={expanded}
          onCheck={() => doResolve("check")}
          onToggleDetails={() => {
            if (!pending) setExpanded(!expanded);
          }}
        />
      </div>
      {item.identityChanged ? (
        <p className="text-ui-xs text-warning-foreground">
          The source account changed. This relationship is paused; sign in to
          the original account or create a new profile to copy the new account.
        </p>
      ) : null}
      {item.state === "unconfirmed" ? (
        <p className="text-ui-xs text-muted-foreground">
          The destination may have received this profile. Check status before
          starting another transfer.
        </p>
      ) : null}
      {expanded ? (
        <ProfileSyncResultDetails
          item={item}
          hosts={hosts}
          sourceName={sourceName}
          pending={pending}
          doResolve={doResolve}
        />
      ) : null}
      <ProfileSyncRetryFeedback
        notice={retry.notice}
        destinationName={hosts.nameFor(item.destinationHostId)}
      />
      {error !== null ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {profileCopyRequestErrorText(error, sourceName)}
        </p>
      ) : null}
    </div>
  );
}

function ProfileSyncResultActions(props: {
  readonly item: ProfileSyncItem;
  readonly pending: boolean;
  readonly checkPending: boolean;
  readonly retry: SyncItemRetry;
  readonly expanded: boolean;
  readonly onCheck: () => void;
  readonly onToggleDetails: () => void;
}): ReactNode {
  const { item, pending, retry } = props;
  return (
    <div className="flex gap-1">
      {["unconfirmed", "unavailable", "copying", "update-required"].includes(
        item.state,
      ) ? (
        <Button
          size="xs"
          variant="outline"
          disabled={pending}
          onClick={props.onCheck}
        >
          {props.checkPending ? <MutedAgentSpinner /> : null}Check status
        </Button>
      ) : null}
      {canRetrySyncItem(item) ? (
        <Button
          size="xs"
          variant="outline"
          disabled={pending}
          onClick={retry.run}
        >
          {retry.pending ? <MutedAgentSpinner /> : null}Retry
        </Button>
      ) : null}
      {item.outcome !== null || item.state === "conflict" ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending}
          aria-expanded={props.expanded}
          onClick={props.onToggleDetails}
        >
          {props.expanded ? "Hide details" : "Review…"}
        </Button>
      ) : null}
    </div>
  );
}

function canRetrySyncItem(item: ProfileSyncItem): boolean {
  return (
    !item.identityChanged &&
    ["needs-action", "unavailable", "update-required", "unconfirmed"].includes(
      item.state,
    ) &&
    item.outcome !== null &&
    profileCopySourceRecovery(item.outcome, false) === "retry"
  );
}

interface ScopedSyncItemError {
  readonly capture: () => void;
  readonly error: HostRpcError | null;
}
function useProfileSyncItemError(
  item: ProfileSyncItem,
  error: HostRpcError | null,
): ScopedSyncItemError {
  const current = JSON.stringify([
    item.state,
    item.outcome?.attempt.attemptId,
    item.outcome?.revision,
    item.sourceIdentityStamp,
    item.identityChanged,
    item.sourceSettings,
    item.destinationSettings,
    item.baseline,
  ]);
  const [submitted, setSubmitted] = useState<string | null>(null);
  return {
    capture: () => setSubmitted(current),
    error: submitted === current ? error : null,
  };
}

interface SyncRetryNotice {
  readonly kind: "stale-revision" | "unavailable";
  readonly attemptId: string;
  readonly revision: number;
}
interface SyncItemRetry {
  readonly pending: boolean;
  readonly error: HostRpcError | null;
  readonly notice: SyncRetryNotice | null;
  readonly run: () => void;
}
function useProfileSyncItemRetry(
  sourceHostId: string,
  item: ProfileSyncItem,
): SyncItemRetry {
  const retry = useProfileCopyRetryMutation(sourceHostId, item.operationId);
  const error = useProfileSyncItemError(item, retry.error);
  const getRetryRequestId = useProfileCopyFlowStore(
    (state) => state.getProfileCopyRetryRequestId,
  );
  const [notice, setNotice] = useState<SyncRetryNotice | null>(null);
  const outcome = item.outcome;
  const run = (): void => {
    if (outcome === null || retry.isPending || !canRetrySyncItem(item)) return;
    const id = getRetryRequestId(outcome.attempt, outcome.revision);
    setNotice(null);
    error.capture();
    retry.mutate(
      {
        attempt: outcome.attempt,
        expectedRevision: outcome.revision,
        retryRequestId: id,
      },
      {
        onSuccess: (response) => {
          if (response.result !== "current") {
            setNotice({
              kind: response.result,
              attemptId: outcome.attempt.attemptId,
              revision: response.outcome.revision,
            });
          }
        },
      },
    );
  };
  return {
    pending: retry.isPending,
    error: error.error,
    notice:
      notice !== null &&
      outcome !== null &&
      notice.attemptId === outcome.attempt.attemptId &&
      notice.revision >= outcome.revision
        ? notice
        : null,
    run,
  };
}
function ProfileSyncRetryFeedback(props: {
  readonly notice: SyncRetryNotice | null;
  readonly destinationName: string;
}): ReactNode {
  if (props.notice === null) return null;
  return (
    <p role="status" className="text-ui-xs text-warning-foreground">
      {props.notice.kind === "stale-revision"
        ? "This changed since you last looked. Review it again."
        : `Retry isn't possible right now. ${props.destinationName} may be offline, a sign-in there may still be holding a shared resource, or this copy was cancelled.`}
    </p>
  );
}

function ProfileSyncResultDetails({
  item,
  hosts,
  sourceName,
  pending,
  doResolve,
}: {
  readonly item: ProfileSyncItem;
  readonly hosts: ProfileCopyHosts;
  readonly sourceName: string;
  readonly pending: boolean;
  readonly doResolve: (
    action: "check" | "keep-destination" | "use-source",
  ) => void;
}): ReactNode {
  return (
    <>
      {item.state === "conflict" ? (
        <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 p-3">
          <p className="text-ui-xs text-warning-foreground">
            This profile was edited on the destination. Other profiles can
            continue syncing.
          </p>
          <p className="text-ui-xs">
            Source: {item.sourceSettings.name} ·{" "}
            {item.sourceSettings.enabled
              ? "Available to agents"
              : "Unavailable to agents"}{" "}
            · {item.sourceSettings.color}
          </p>
          <p className="text-ui-xs">
            Destination: {item.destinationSettings?.name} ·{" "}
            {item.destinationSettings?.enabled
              ? "Available to agents"
              : "Unavailable to agents"}{" "}
            · {item.destinationSettings?.color}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={pending}
              onClick={() => doResolve("keep-destination")}
            >
              Keep destination & pause
            </Button>
            <Button
              size="xs"
              disabled={pending || item.identityChanged}
              onClick={() => doResolve("use-source")}
            >
              Use source settings
            </Button>
          </div>
        </div>
      ) : null}
      {item.state !== "conflict" ? (
        <ProfileSyncOutcomeDetails
          item={item}
          hosts={hosts}
          sourceName={sourceName}
        />
      ) : null}
    </>
  );
}

function ProfileSyncOutcomeDetails(props: {
  readonly item: ProfileSyncItem;
  readonly hosts: ProfileCopyHosts;
  readonly sourceName: string;
}): ReactNode {
  const { item, hosts, sourceName } = props;
  const outcome = item.outcome;
  if (outcome === null) return null;
  const preview = item.preview?.destinations.find(
    (d) => d.destinationHostId === item.destinationHostId,
  );
  const names = {
    source: sourceName,
    destination: hosts.nameFor(item.destinationHostId),
    provider: profileCopyProviderLabel(item.providerId),
    profile: item.name,
  };
  const route = knownRouteFromRecord(
    preview === undefined ? undefined : profileCopyPreviewRecord(preview),
  );
  if (isRecordedOutcome(outcome))
    return (
      <ProfileCopyDraftPanel
        outcome={outcome}
        names={names}
        route={route}
        cancelRequested={false}
        destinationIsLocal={hosts.isLocalMachine(item.destinationHostId)}
        extraActions={null}
      />
    );
  const presentation = presentProfileCopyOutcome(outcome, {
    names,
    route,
    cancelRequested: false,
  });
  return (
    <div className="flex flex-col gap-2">
      <ProfileCopyBadge tone={presentation.tone} label={presentation.badge} />
      <p className="text-ui-xs leading-relaxed text-muted-foreground">
        {presentation.body}
      </p>
      {presentation.note !== null ? (
        <p className="text-ui-xs text-muted-foreground">{presentation.note}</p>
      ) : null}
    </div>
  );
}

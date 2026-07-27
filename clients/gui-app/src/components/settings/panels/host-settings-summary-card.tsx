import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { HostNameEditForm } from "@/components/settings/panels/host-settings-name-edit";
import { HostProgressBanner } from "@/components/settings/panels/host-settings-progress-banner";
import { HostUpdateRegion } from "@/components/settings/panels/host-settings-update-region";
import {
  statusColorClass,
  statusDescription,
  statusLabel,
  type HostProgressState,
} from "@/components/settings/panels/host-settings-panel-model";
import { cn } from "@/lib/utils";
import type {
  DownloadProgress,
  HostNameSettings,
  HostRegistryUpdateState,
  ServiceStatusSnapshot,
} from "@traycer-clients/shared/platform/runner-host";

export interface HostSummaryTerminalOutcome {
  readonly message: string;
}

interface HostSummaryBannerProps {
  readonly progress: HostProgressState | null;
  readonly terminalOutcome: HostSummaryTerminalOutcome | null;
  readonly onRetryTerminalOutcome: () => void;
  readonly onDismissTerminalOutcome: () => void;
}

interface HostSummaryNameEditProps {
  readonly settings: HostNameSettings | undefined;
  readonly pending: boolean;
  // The name query settled to an error - distinct from `pending` (still
  // loading) so the identity block can render a truthful "unavailable"
  // fallback for the name alone instead of blocking on it forever.
  readonly error: boolean;
  readonly draft: string;
  readonly savePending: boolean;
  readonly editing: boolean;
  readonly onDraftChange: (value: string) => void;
  readonly onSave: () => void;
  readonly onReset: () => void;
  readonly onOpenEditing: () => void;
  readonly onCancel: () => void;
}

interface HostSummaryActionsProps {
  readonly anyPending: boolean;
  readonly installPending: boolean;
  readonly restartPending: boolean;
  readonly onInstall: () => void;
  readonly onRestart: () => void;
  readonly onOpenDoctor: () => void;
}

interface HostSummaryUpdatesProps {
  readonly hidden: boolean;
  readonly registryState: HostRegistryUpdateState | undefined;
  readonly registryFetching: boolean;
  readonly anyPending: boolean;
  readonly updatePending: boolean;
  readonly latestReleasedAt: string | null;
  readonly nowMs: number;
  readonly updateReady: boolean;
  readonly stagedVersion: string | null;
  readonly downloadProgress: DownloadProgress | null;
  readonly onUpdate: () => void;
  readonly onRefresh: () => void;
}

interface HostSummaryCardProps {
  readonly status: ServiceStatusSnapshot | undefined;
  readonly statusPending: boolean;
  readonly banner: HostSummaryBannerProps;
  readonly nameEdit: HostSummaryNameEditProps;
  readonly actions: HostSummaryActionsProps;
  readonly updates: HostSummaryUpdatesProps;
}

/**
 * Flow 5's self-identifying summary card: identity (name, health state,
 * version/endpoint/pid) and contextual actions lead the page with no
 * external "Overview" label, install/restart/update progress and
 * recoverable failures render inside it, and the update state occupies a
 * compact bottom region of the same card.
 */
export function HostSummaryCard(props: HostSummaryCardProps): ReactNode {
  const { status, statusPending, banner, nameEdit, actions, updates } = props;

  // Focus restoration: the "Edit name" trigger unmounts while editing and
  // remounts on close (Cancel, or a successful Save/Reset). Track the prior
  // `editing` value so the trigger is refocused only on that true->false
  // transition, never on the panel's initial mount.
  const editNameTriggerRef = useRef<HTMLButtonElement>(null);
  const wasEditingRef = useRef(nameEdit.editing);
  useEffect(() => {
    if (wasEditingRef.current && !nameEdit.editing) {
      editNameTriggerRef.current?.focus();
    }
    wasEditingRef.current = nameEdit.editing;
  }, [nameEdit.editing]);

  // Opening a disabled editor (no name data to edit yet) is itself the other
  // half of the focus-loss finding - block the trigger, not just the input,
  // while the name is still loading or failed to load.
  const editNameDisabled = nameEdit.pending || nameEdit.settings === undefined;

  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-card/40">
      {banner.progress !== null ? (
        <HostProgressBanner progress={banner.progress} />
      ) : null}
      {banner.terminalOutcome !== null ? (
        <HostTerminalOutcomeBanner
          message={banner.terminalOutcome.message}
          onRetry={banner.onRetryTerminalOutcome}
          onDismiss={banner.onDismissTerminalOutcome}
        />
      ) : null}
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <HostIdentity
            status={status}
            statusPending={statusPending}
            nameEdit={nameEdit}
          />
          {nameEdit.editing ? null : (
            <HostSummaryActions
              actions={actions}
              status={status}
              onEditName={nameEdit.onOpenEditing}
              editNameDisabled={editNameDisabled}
              editNameRef={editNameTriggerRef}
            />
          )}
        </div>
        {nameEdit.editing ? (
          <HostNameEditForm
            settings={nameEdit.settings}
            pending={nameEdit.pending}
            draftName={nameEdit.draft}
            savePending={nameEdit.savePending}
            onDraftNameChange={nameEdit.onDraftChange}
            onSave={nameEdit.onSave}
            onReset={nameEdit.onReset}
            onCancel={nameEdit.onCancel}
          />
        ) : null}
      </div>
      {updates.hidden ? null : (
        <HostUpdateRegion
          registryState={updates.registryState}
          registryFetching={updates.registryFetching}
          anyPending={updates.anyPending}
          updatePending={updates.updatePending}
          latestReleasedAt={updates.latestReleasedAt}
          nowMs={updates.nowMs}
          updateReady={updates.updateReady}
          stagedVersion={updates.stagedVersion}
          downloadProgress={updates.downloadProgress}
          onUpdate={updates.onUpdate}
          onRefresh={updates.onRefresh}
        />
      )}
    </div>
  );
}

function HostTerminalOutcomeBanner(props: {
  readonly message: string;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}): ReactNode {
  const { message, onRetry, onDismiss } = props;
  return (
    <div
      data-testid="settings-host-deferred-outcome"
      className="flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-5 py-3 text-ui-sm text-destructive"
    >
      <span className="min-w-0 flex-1">{message}</span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onRetry}
        data-testid="settings-host-deferred-retry"
      >
        Retry
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

/**
 * Status, version, endpoint, and PID come from an entirely separate query
 * than the display name - a rejected `getHostName()` must not mask already-
 * loaded operational state. Only the health block as a whole waits on
 * `status`; the name line degrades independently via `HostIdentityName`.
 */
function HostIdentity(props: {
  readonly status: ServiceStatusSnapshot | undefined;
  readonly statusPending: boolean;
  readonly nameEdit: HostSummaryNameEditProps;
}): ReactNode {
  const { status, statusPending, nameEdit } = props;

  if (statusPending || status === undefined) {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-56" />
      </div>
    );
  }

  return (
    <div className="min-w-0 flex-1" data-testid="settings-host-identity">
      <HostIdentityName nameEdit={nameEdit} />
      <div
        className={cn("font-medium text-ui-sm", statusColorClass(status.state))}
        data-testid="settings-host-status"
      >
        {statusLabel(status.state)}
      </div>
      <p className="text-ui-xs text-muted-foreground">
        {statusDescription(status.state)}
      </p>
      <HostIdentityMetaLine status={status} />
    </div>
  );
}

function HostIdentityName(props: {
  readonly nameEdit: HostSummaryNameEditProps;
}): ReactNode {
  const { nameEdit } = props;
  const displayName =
    nameEdit.settings?.effectiveName ?? nameEdit.settings?.systemName ?? null;

  if (displayName !== null) {
    return (
      <div className="truncate font-semibold text-foreground text-title-sm">
        {displayName}
      </div>
    );
  }
  if (nameEdit.error) {
    return (
      <div
        className="truncate font-medium text-muted-foreground text-title-sm"
        data-testid="settings-host-name-unavailable"
      >
        Host name unavailable
      </div>
    );
  }
  return <Skeleton className="h-5 w-40" />;
}

function HostIdentityMetaLine(props: {
  readonly status: ServiceStatusSnapshot;
}): ReactNode {
  const { status } = props;
  const parts: string[] = [];
  if (status.version !== null) parts.push(`v${status.version}`);
  if (status.listenUrl !== null) parts.push(status.listenUrl);
  if (status.pid !== null) parts.push(`pid ${status.pid}`);
  if (parts.length === 0) return null;
  return (
    <p className="mt-1 break-all font-mono text-code-xs text-muted-foreground">
      {parts.join(" · ")}
    </p>
  );
}

function HostSummaryActions(props: {
  readonly actions: HostSummaryActionsProps;
  readonly status: ServiceStatusSnapshot | undefined;
  readonly onEditName: () => void;
  readonly editNameDisabled: boolean;
  readonly editNameRef: RefObject<HTMLButtonElement | null>;
}): ReactNode {
  const { actions, status, onEditName, editNameDisabled, editNameRef } = props;
  const state = status?.state;
  const isNotInstalled = state === "not-installed";
  const isStopped = state === "stopped";
  const restartVariant = isStopped ? "default" : "secondary";
  const primaryDisabled = actions.anyPending || status === undefined;

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
      {isNotInstalled ? (
        <Button
          variant="default"
          size="sm"
          disabled={primaryDisabled}
          onClick={actions.onInstall}
        >
          {actions.installPending ? (
            <AgentSpinningDots
              className="mr-2 size-3"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Install host
        </Button>
      ) : (
        <Button
          variant={restartVariant}
          size="sm"
          disabled={primaryDisabled}
          onClick={actions.onRestart}
        >
          {actions.restartPending ? (
            <AgentSpinningDots
              className="mr-2 size-3"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Restart
        </Button>
      )}
      <Button variant="secondary" size="sm" onClick={actions.onOpenDoctor}>
        Run doctor
      </Button>
      <Button
        ref={editNameRef}
        type="button"
        variant="ghost"
        size="sm"
        disabled={editNameDisabled}
        onClick={onEditName}
        data-testid="settings-host-edit-name-toggle"
      >
        Edit name
      </Button>
    </div>
  );
}

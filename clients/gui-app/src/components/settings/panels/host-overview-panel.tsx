import { useEffect, useRef, useState, type ReactNode } from "react";
import { useIsMutating, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type { HostDoctorIssue } from "@traycer/protocol/host/maintenance/index";
import { RestartHostConfirmDialog } from "@/components/host/restart-host-confirm-dialog";
import { HostBusyForceDeferDialog } from "@/components/host/host-busy-force-defer-dialog";
import {
  busyRestartMessage,
  HOST_CHANGED_DESCRIPTION,
} from "@/components/host/host-restart-copy";
import { DoctorSheet } from "@/components/settings/panels/host-settings-doctor-sheet";
import {
  InstallationDetailsDisclosure,
  type InstallationDetailsRecord,
} from "@/components/settings/panels/host-settings-installation-details";
import { HostIdentityCard } from "@/components/settings/host-scope/host-identity-card";
import { HostUpdateRequiredAction } from "@/components/settings/host-scope/host-update-required-action";
import { useHostLease } from "@/hooks/host/use-host-lease";
import { HostDangerZone } from "@/components/settings/host-scope/host-danger-zone";
import { HostUpdateDrainGateRow } from "@/components/settings/host-scope/host-registry-updates";
import { useHostRegistryUpdateMutation } from "@/components/settings/host-scope/use-host-registry-update-mutation";
import { SettingsGroup } from "@/components/settings/settings-group";
import {
  HostOverviewHeaderActions,
  HostOverviewNameAction,
  HostOverviewNotice,
  HostOverviewUpdateProgress,
} from "@/components/settings/panels/host-overview-status-card";
import { HostOverviewOperationCard } from "@/components/settings/panels/host-overview-operation-card";
import { HostOverviewUpdatesRegion } from "@/components/settings/panels/host-overview-updates";
import { useHostOverviewUpdates } from "@/components/settings/panels/host-overview-updates-state";
import { useOverviewOsService } from "@/components/settings/panels/host-overview-os-service";
import { HostOverviewAdvancedDisclosure } from "@/components/settings/panels/host-overview-advanced";
import {
  customNameFromIdentityDraft,
  describeOverviewDegrade,
  overviewMethodDegrade,
  resolveOverviewMethodDegrade,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";
import {
  liveBusyBreakdown,
  liveBusySessionCount,
  liveHostBusy,
  settledBusyBreakdown,
  settledBusySessionCount,
  settledHostBusy,
} from "@/components/settings/panels/my-hosts-model";
import { persistedDraftFromIdentity } from "@/components/settings/panels/host-settings-panel-model";
import { HostImportMigrationSection } from "@/components/settings/panels/host-import-migration-section";
import { LocalPackageManagerUpgradeHint } from "@/components/settings/panels/host-settings-package-manager-upgrade-hint";
import { useRunnerConvergeReady } from "@/hooks/runner/use-runner-converge-ready-mutation";
import { useRunnerHostRemovalStateQuery } from "@/hooks/runner/use-runner-host-removal-state-query";
import { useRunnerReinstallTraycer } from "@/hooks/runner/use-runner-reinstall-traycer-mutation";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  managedInstallation,
  useHostIdentityQuery,
  useHostIdentitySet,
  useHostInstallationInfoQuery,
  useHostOverviewStatusQuery,
  useHostRestart,
  useHostServiceStatusQuery,
  useRefreshOverviewStatusOnSessionActivity,
} from "@/components/settings/panels/host-overview-rpc";
import { newTransitionId } from "@/components/settings/panels/host-overview-transition-id";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useInlineRename } from "@/hooks/ui/use-inline-rename";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import {
  hostServiceWriteLatches,
  useHostServiceWriteLatchStore,
} from "@/components/settings/panels/host-service-write-latch-store";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import {
  holdsLifecycleGate,
  isQuietUpdateView,
  projectFleetUpdateView,
  UNKNOWN_FLEET_UPDATE_VIEW,
} from "@/lib/host/fleet-update/fleet-update-view";
import { observationFromCanonicalRead } from "@/lib/host/fleet-update/canonical-status-observation";
import { useActiveUpdatePollAccelerator } from "@/hooks/host/use-active-update-poll-accelerator";
import {
  toastHostRestartDeclined,
  toastHostRestartRequested,
} from "@/lib/host-restart-toast";
import { runnerMutationKeys } from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import type { HostRestartRequestResult } from "@traycer-clients/shared/platform/runner-host";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { cn } from "@/lib/utils";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { HostIdentity } from "@traycer/protocol/host/identity/index";
import type { HostRestartBusyVerdict } from "@traycer/protocol/host/restart/index";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostBusyBreakdown,
  HostStatusUpdateProgress,
  HostStatusUpdateOperation,
} from "@traycer/protocol/host/status/index";

// Matches the RPC Doctor card's own tail size, so a report read over the
// bridge shows the same amount of log as one read over `diagnostics.logs.tail`.
const DOCTOR_BRIDGE_LOG_TAIL_LINES = 200;

/** How long an accepted install may hold the page before progress appears. */
const UPDATE_INSTALL_ACCEPTED_LATCH_MS = 60_000;

/** An old host can support `host.status` and not `host.restart`; a current host on a box with no Traycer CLI
 * can restart but cannot run doctor or update itself. */
// eslint-disable-next-line complexity
// The identity card, the Installation group and the two dialogs are each their
export function HostOverviewPanel(props: {
  readonly scope: HostScope;
  /** True when this shell has a CLI bridge for the local-only doctor repairs. */
  readonly hasLocalBridge: boolean;
  readonly onLocalDoctorFix: (issue: HostDoctorIssue) => void;
  readonly localDoctorFixPendingCode: string | null;
}): ReactNode {
  const { scope } = props;
  const compact = useSettingsDensity() === "compact";
  const host = scope.host;

  // The rule they owe is stated once, in `host-scope-status.ts`.
  const client = scope.client;
  // The ambient binding, still read here - but only for `directory`, never for a client.
  const binding = useHostBinding();
  // A query hook mounted under a non-ready scope still fires against the ambient host and caches the answer
  // under this page's key, however well a gate hides the result.
  const usable = isHostScopeUsable(scope.status) && client !== null;
  // `unreachable` only - while `connecting` the route may still resolve.
  const localDown =
    scope.status === "unreachable" &&
    (host?.isLocalMachine ?? false) &&
    props.hasLocalBridge;

  const [doctorOpen, setDoctorOpen] = useState(false);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  // Cleared on every definitive answer, so a genuinely new action never inherits a stale claim.
  const armedRestartIdRef = useRef<string | null>(null);
  const hostIdCopy = useClipboardCopy({
    resetMs: 1600,
    onSuccess: () => toast.success("Host ID copied"),
    onError: () => toast.error("Couldn't copy the host ID"),
  });

  // Local machine with a bridge only, by the nature of the transport rather than a scope rule.
  const management = useRunnerHostOrNull()?.hostManagement ?? null;
  // One value rather than a boolean gate beside an id, because the two must never disagree.
  const forceRestartLocalHostId =
    host !== null &&
    host.isLocalMachine &&
    props.hasLocalBridge &&
    management !== null
      ? host.hostId
      : null;

  const {
    identity: identityDegrade,
    identitySet: identitySetDegrade,
    restart: restartDegrade,
    restartViaForceFallback,
    restartSupported,
    logsSupported,
    doctor: doctorDegrade,
    installInfo: installInfoDegrade,
    updateCheck: updateCheckDegrade,
    updateInstall: updateInstallDegrade,
    serviceStatus: serviceStatusDegrade,
    serviceRegister: serviceRegisterDegrade,
    serviceDeregister: serviceDeregisterDegrade,
  } = useOverviewCapabilities(scope.hostId, {
    maintenanceFallback: scope.localMaintenanceFallback,
    restartForceRoute: forceRestartLocalHostId !== null,
  });

  const statusQuery = useHostOverviewStatusQuery({
    client,
    enabled: usable,
    hostId: scope.hostId,
  });
  useRefreshOverviewStatusOnSessionActivity({
    hostId: scope.hostId,
    enabled: usable,
  });
  const identityQuery = useHostIdentityQuery({
    client,
    enabled: usable && identityDegrade === null,
  });
  const installationQuery = useHostInstallationInfoQuery({
    client,
    enabled: usable && installInfoDegrade === null,
  });

  const identitySet = useHostIdentitySet(client);
  const restart = useHostRestart(client);
  // Instantiated before the busy gate: its most consequential write is the drain-force PATCH ("Apply now" sets
  // force.
  const policyMutation = useHostRegistryUpdateMutation(scope.hostId);

  const view = useOverviewDisplay({
    scope,
    host,
    identity: identityQuery.data ?? null,
    status: statusQuery.data ?? null,
    // The drain count is only as trustworthy as the read behind it, so the read's health travels with its value.
    // See `liveBusySessionCount`.
    statusHealth: {
      isError: statusQuery.isError,
      fetchStatus: statusQuery.fetchStatus,
      isStale: statusQuery.isStale,
      hasLiveSource: usable,
    },
  });
  const { identity, displayName } = view;

  // An offer that outlived a local host identity change would therefore state A's session count above a button
  // that kills B - whose claim was never asked and whose sessions were never counted.
  const [forceRestartOffer, setForceRestartOffer] = useState<{
    readonly hostId: string;
    readonly hostName: string;
    readonly verdict: HostRestartBusyVerdict;
  } | null>(null);
  // No variables: the unified toast wording (`toastHostRestartRequested` / `toastHostRestartDeclined`,
  // host-restart-toast.ts) dropped the host name from the message entirely.
  const forceRestart = useMutation<HostRestartRequestResult>({
    mutationKey: runnerMutationKeys.hostRestart(),
    mutationFn: () => {
      if (management === null) {
        return Promise.reject(new Error("No local host bridge is available."));
      }
      // `restartHost` queues behind whatever owns the desktop's exclusive mutation lane, which the tray and menu
      // keep deliberately.
      const expectedHostId = forceRestartLocalHostId;
      if (expectedHostId === null) {
        return Promise.reject(new Error("No local host bridge is available."));
      }
      return management.restartHostIfIdle({ expectedHostId });
    },
    onSuccess: (result) => {
      // Leaving the dialog up would re-offer a decision already made.
      setForceRestartOffer(null);
      setRestartConfirmOpen(false);
      // `declined` survives even a forced respawn (removed-by-user, another
      // process holds the management lock) - informational, not an error.
      if (result.kind === "declined") {
        toastHostRestartDeclined(result.message);
        return;
      }
      toastHostRestartRequested();
    },
    onError: (error) => {
      setForceRestartOffer(null);
      setRestartConfirmOpen(false);
      toastFromRunnerError(error, "Couldn't restart host");
    },
  });
  // Same file, read from this machine instead of asked for over an RPC the host does not have, so the report's
  // Show logs button keeps working rather than becoming a refusal.
  const bridgeDoctorLogs = useMutation<readonly string[]>({
    mutationKey: runnerMutationKeys.hostDoctorBridgeLogs(),
    mutationFn: async () => {
      if (management === null) {
        throw new Error("No local host bridge is available.");
      }
      // `null` means this page's host is not this machine, where a local log has nothing to do with the report;
      // refused rather than read, exactly like `restartHostIfIdle`'s own null arm above.
      if (forceRestartLocalHostId === null) {
        throw new Error("This page's host is not this computer.");
      }
      const result = await management.getHostLogs({
        tailLines: DOCTOR_BRIDGE_LOG_TAIL_LINES,
        expectedHostId: forceRestartLocalHostId,
      });
      return result.tail.length === 0 ? [] : result.tail.split("\n");
    },
  });

  // Cache-derived, not observer-derived, for the page-wide gate.
  const forceRestartInFlight =
    useIsMutating({ mutationKey: runnerMutationKeys.hostRestart() }) > 0;
  // A host identity change arrives as a store update, so a press processed against the previous render would
  // compare stale against stale and sail through - the same reason the menu/tray flow re-reads here.
  const liveLocalHostIdNow = (): string | null => {
    if (binding === null) return null;
    const entry = binding.directory.getLocalEntry();
    return entry === null ? null : entry.hostId;
  };

  // Save and Reset are the same write with a different argument - `null` clears the override and falls the name
  // back to the host's own default.
  const { mutate: mutateIdentity } = identitySet;
  // The inline editor closes on commit - before the mutation settles.
  const [failedRename, setFailedRename] = useState<{
    readonly draft: string;
    readonly attempt: number;
  } | null>(null);
  const reopenRenameRef = useRef<() => void>(() => undefined);
  const submitRename = (customName: string | null): void => {
    // Belt to the Save button's braces.
    if (customName === (identity?.customName ?? null)) return;
    mutateIdentity(
      { customName },
      {
        onSuccess: (next) => {
          setFailedRename(null);
          toast.success(`Renamed to ${next.effectiveName}`);
        },
        onError: (error) => {
          // The reopen happens in the effect below, one render later, not here.
          setFailedRename((previous) => ({
            draft: customName ?? "",
            attempt: (previous?.attempt ?? 0) + 1,
          }));
          toastFromHostError(error, "Couldn't rename this host.");
        },
      },
    );
  };

  const renameDegrade = identitySetDegrade ?? identityDegrade;

  // `observationFromCanonicalRead` now carries those conditions with the fact, and it is the same function the
  // landing banner and the fleet's coalesced reads use.
  const operationObservation =
    view.updateOperation === null || statusQuery.data === undefined
      ? null
      : observationFromCanonicalRead({
          hostId: scope.hostId ?? "",
          status: statusQuery.data,
          dataUpdatedAt: statusQuery.dataUpdatedAt,
          health: {
            isError: statusQuery.isError,
            fetchStatus: statusQuery.fetchStatus,
            isStale: statusQuery.isStale,
            hasLiveSource: usable,
          },
          source: "selected",
        });
  const operationView =
    operationObservation === null
      ? null
      : projectFleetUpdateView({
          observation: operationObservation,
          // `nowMs` only has to be a finite instant at or after the observation for that to apply, and a render-time
          // clock would be both impure and less reactive.
          nowMs: statusQuery.dataUpdatedAt,
          connected: usable,
        });
  // Not a correctness mechanism - freshness is settled above.
  useActiveUpdatePollAccelerator({
    hostId: scope.hostId,
    view: operationView ?? UNKNOWN_FLEET_UPDATE_VIEW,
  });
  // Attempt-aware, with the coarse field as the fallback - and the difference is a lockout bug, not a
  // refinement.
  const updateInFlight =
    operationView === null
      ? view.updateProgress?.state === "updating"
      : holdsLifecycleGate(operationView);
  const corePending =
    restart.isPending ||
    // Unscoped on purpose: the forced bridge respawn replaces the local host process, and no lifecycle write on
    // this page should dispatch beside that regardless of which host the page is currently scoped to.
    forceRestartInFlight ||
    identitySet.isPending ||
    updateInFlight ||
    policyMutation.isPending;

  const serviceStatusQuery = useHostServiceStatusQuery({
    client,
    enabled: usable && serviceStatusDegrade === null,
  });
  const service = useOverviewOsService({
    client,
    hostName: displayName,
    status: serviceStatusQuery.data,
    loading: serviceStatusQuery.isPending,
    statusFailed: serviceStatusQuery.isError,
    statusDegrade: serviceStatusDegrade,
    registerDegrade: serviceRegisterDegrade,
    deregisterDegrade: serviceDeregisterDegrade,
    busy: corePending,
    hostId: scope.hostId,
    scopeUsable: usable,
    settledBusy: view.settledBusy,
    settledBusySessionCount: view.settledBusySessionCount,
    settledBusyBreakdown: view.settledBusyBreakdown,
    refetchStatus: () => {
      void serviceStatusQuery.refetch();
    },
  });
  // Re-registering cycles the OS service and replaces this very host process, so a Restart or a detached update
  // launched beside it races that lifecycle.
  const gatePending =
    corePending || service.registerPending || service.deregisterPending;
  // The install request is in the gate too, not only the detached progress.
  const updateInstallAcceptedAt = useHostServiceWriteLatchStore(
    (state) =>
      hostServiceWriteLatches(state.byHost, scope.hostId)
        .updateInstallAcceptedAt,
  );
  useEffect(() => {
    if (scope.hostId === null || updateInstallAcceptedAt === null) return;
    const hostId = scope.hostId;
    // A retry that itself fails fast without an `updating` frame is covered by the bounded timer, in the safe
    // direction.
    if (view.updateProgress?.state === "updating") {
      useHostServiceWriteLatchStore
        .getState()
        .releaseUpdateInstallAccepted(hostId);
      return;
    }
    const remaining = Math.max(
      0,
      updateInstallAcceptedAt + UPDATE_INSTALL_ACCEPTED_LATCH_MS - Date.now(),
    );
    const timer = setTimeout(() => {
      useHostServiceWriteLatchStore
        .getState()
        .releaseUpdateInstallAccepted(hostId);
    }, remaining);
    return () => clearTimeout(timer);
  }, [scope.hostId, updateInstallAcceptedAt, view.updateProgress]);
  // The accepted latch is part of the gate the update controls consume too.
  const updateGatePending = gatePending || updateInstallAcceptedAt !== null;

  // One instance of each hook, so the two halves cannot disagree about what the last check returned or which
  // write is in flight.
  const updates = useHostOverviewUpdates({
    client,
    hostName: displayName,
    // Identifies whose filter the RC override belongs to. `HostScopeGate` can swap the scoped host under a mounted
    // subtree, and an override carried across that swap would apply one machine's decision to another.
    hostId: scope.hostId,
    installedVersion: view.hostVersion,
    platformKey: host?.platform ?? null,
    // The check reads on its own now, so this gate is load-bearing rather than cosmetic.
    enabled: usable,
    checkDegrade: updateCheckDegrade,
    installDegrade: updateInstallDegrade,
    busy: updateGatePending,
  });
  const anyPending = updateGatePending || updates.summary.installing;

  // The dialog's spinner, its stale-open close below, and the header item's pending state must all read the same
  // answer, or a fallback confirm would close itself the moment it dispatched.
  const restartDialogOwnDispatch = restartViaForceFallback
    ? forceRestart.isPending
    : restart.isPending;
  // The restart confirmation has the same stale-open window the OS-service confirms do
  // (`host-overview-advanced.tsx`).
  if (restartConfirmOpen && anyPending && !restartDialogOwnDispatch) {
    setRestartConfirmOpen(false);
  }
  // Two exclusions, both for writes that are this action rather than a competing one.
  if (
    forceRestartOffer !== null &&
    anyPending &&
    !restart.isPending &&
    !forceRestartInFlight
  ) {
    setForceRestartOffer(null);
  }
  // Drop the offer rather than leave a kill button over a count that no longer describes its target; `⋯ →
  // Restart` re-asks the new host cooperatively.
  if (
    forceRestartOffer !== null &&
    forceRestartOffer.hostId !== forceRestartLocalHostId
  ) {
    setForceRestartOffer(null);
  }

  // The name edits in place, exactly as a tab title does - same hook, so Enter commits, Escape reverts, blur
  // settles once, and the input can never commit an empty string.
  const rename = useInlineRename({
    value: failedRename?.draft ?? view.persistedNameDraft,
    // `!anyPending` covers the identity write itself (via `corePending`).
    canEdit:
      usable && renameDegrade === null && identity !== null && !anyPending,
    onCommit: (next) => submitRename(customNameFromIdentityDraft(next)),
  });
  // Ref-carried so the reopen effect below always calls THIS render's
  // `startEditing` - the closure that captured the failed draft as value.
  useEffect(() => {
    reopenRenameRef.current = rename.startEditing;
  });
  // Reopen after the failed draft is the hook's current value (see onError).
  useEffect(() => {
    if (failedRename === null) return;
    reopenRenameRef.current();
  }, [failedRename]);

  // Focus restoration: the pencil unmounts while the input is up and comes back on close, so the trigger is
  // refocused on that true->false transition only - never on mount, where it would steal focus from the page.
  const editNameRef = useRef<HTMLButtonElement>(null);
  const wasEditingRef = useRef(rename.isEditing);
  useEffect(() => {
    if (wasEditingRef.current && !rename.isEditing) {
      editNameRef.current?.focus();
    }
    wasEditingRef.current = rename.isEditing;
  }, [rename.isEditing]);
  if (host === null) return null;

  const registryItem = host.item;

  // Either one false means there is no update this app can perform, and the row falls back to naming the problem
  // without offering a control that cannot reach it.
  const canManageHost = host.isLocalMachine && management !== null;

  // Every one of its verbs needs a live host to answer, so on an unreachable host they would be dead controls
  // under a card that already says the host cannot be reached.
  let headerActions: ReactNode = null;
  if (localDown) {
    headerActions = (
      <LocalHostDownActions
        hostName={displayName}
        settingUp={host.settingUp}
        onOpenDoctor={() => setDoctorOpen(true)}
      />
    );
  } else if (usable) {
    headerActions = (
      <HostOverviewHeaderActions
        hostName={displayName}
        // Nothing extra: this page only renders for a host that has
        // already answered, so there is never an Install to offer.
        primaryAction={null}
        restartDegrade={restartDegrade}
        doctorDegrade={doctorDegrade}
        restartPending={restartDialogOwnDispatch}
        anyPending={anyPending}
        isActive={host.isActive}
        connectable={host.connectable}
        // Only offered when there is an override to clear. A host running under its own default name has nothing to
        // reset, and the write would be the no-op `submitRename` already guards.
        onResetName={
          (identity?.customName ?? null) === null
            ? null
            : () => submitRename(null)
        }
        resetNameDegrade={renameDegrade}
        onRestart={() => setRestartConfirmOpen(true)}
        onOpenDoctor={() => setDoctorOpen(true)}
        onMakeActive={() => scope.makeActive(host.hostId)}
        activateBusy={scope.isActivating}
        onCopyHostId={() => hostIdCopy.copy(host.hostId)}
      />
    );
  }

  return (
    <div className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}>
      <HostIdentityCard
        host={host}
        displayName={displayName}
        // Same two-layer rule as the name: the process's own answer when there
        // is a route, the registry copy when there is not.
        version={view.hostVersion ?? host.version}
        // What the HOST says about its own work, which is the fact that decides
        // whether Restart is safe to press. `null` until it answers.
        busy={view.busy}
        busySessionCount={view.busySessionCount}
        busyBreakdown={view.busyBreakdown}
        nameAction={
          !usable ? null : (
            <HostOverviewNameAction
              hostName={displayName}
              pendingWrite={identitySet.isPending}
              // The page-wide gate, distinct from `pendingWrite`: it locks the trigger during any lifecycle write (install,
              // restart, service register/deregister) without claiming an identity write is in flight.
              locked={anyPending}
              // The pencil and "Retry name" both lead to `host.identity.set`, so a host that can be read but not written
              // must degrade them - otherwise Save calls a method the handshake already declined.
              degrade={renameDegrade}
              loaded={identity !== null}
              // TanStack's `fetchState` clears `error` and returns `status` to `pending` whenever a fetch begins with no
              // data behind it, so an `isError` gate unmounts the arm on the click that starts the read.
              failed={identity === null && identityQuery.errorUpdateCount > 0}
              retrying={identityQuery.isFetching}
              onRetry={() => {
                void identityQuery.refetch();
              }}
              onEdit={rename.startEditing}
              buttonRef={editNameRef}
            />
          )
        }
        nameInput={
          !rename.isEditing ? null : (
            <input
              {...rename.inputProps}
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 font-semibold text-foreground text-title-sm outline-hidden focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              aria-label="Host name"
              data-testid="host-overview-name-input"
            />
          )
        }
        actions={headerActions}
        healthAction={
          <HostUpdateRequiredSlot host={host} canManageHost={canManageHost} />
        }
      >
        {/* Supersedes the coarse notice below rather than sitting beside it - two update lines describing one operation
           in different vocabularies is the drift the shared projection exists to prevent. */}
        {operationView === null || isQuietUpdateView(operationView) ? null : (
          <HostOverviewOperationCard
            view={operationView}
            hostName={displayName}
            onForceRestart={() => {
              // This never restarts on the first click and never consumes update-force authorization.
              setRestartConfirmOpen(true);
            }}
          />
        )}
        {operationView !== null || view.updateProgress === null ? null : (
          <HostOverviewUpdateProgress
            state={view.updateProgress.state}
            error={view.updateProgress.error}
          />
        )}
        {/* Everything that is a decision rather than an answer is down in Advanced. */}
        {!usable ? null : (
          <HostOverviewUpdatesRegion
            summary={updates.summary}
            degrade={updates.degrade}
          />
        )}
        {/* This is the only control on the page with a deadline - it renders solely while an update is blocked on open
           sessions - and a collapsed disclosure is where a deadline goes to be missed. */}
        {registryItem === null ? null : (
          <HostUpdateDrainGateRow
            item={registryItem}
            mutation={policyMutation}
            liveBusySessionCount={view.busySessionCount}
            liveBusyBreakdown={view.busyBreakdown}
            settledBusySessionCount={view.settledBusySessionCount}
            settledBusyBreakdown={view.settledBusyBreakdown}
          />
        )}
      </HostIdentityCard>

      <HostOverviewInstallationCard
        usable={usable}
        hostName={displayName}
        degrade={installInfoDegrade}
        record={
          managedInstallation(installationQuery.data)?.installRecord ?? null
        }
        loading={installationQuery.isPending}
        readFailed={installationQuery.isError}
        advanced={
          // Withheld entirely when every section inside would be: no registry row kills the policy switch, and no route
          // kills the service and version sections.
          registryItem === null && !usable ? null : (
            <HostOverviewAdvancedDisclosure
              hostName={displayName}
              registryItem={registryItem}
              policyMutation={policyMutation}
              // The full gate at render time, not the hook-time `corePending`: the service verbs must also lock during the
              // install-request window, and `anyPending` only exists after the updates hook the service adapter feeds.
              service={usable ? { ...service, busy: anyPending } : null}
              // Picking a version means asking the host which ones exist, so an unreachable host gets no picker at all
              // rather than a checkbox and an invitation to press a Check now that is not on screen.
              versions={
                usable && updates.degrade === null ? updates.picker : null
              }
            />
          )
        }
      />

      {/* The section applies a second, narrower check of its own: the stream beneath it must already name this host. */}
      {!usable ? null : <HostImportMigrationSection hostId={scope.hostId} />}

      {/* Local machine only, by the nature of the fact rather than a scope rule. */}
      {props.hasLocalBridge ? <LocalPackageManagerUpgradeHint /> : null}

      {/* No list of the other hosts, and no "Add host": a page about one host is the wrong place to manage the
         collection it belongs to. */}
      <HostDangerZone scope={scope} />

      <RestartHostConfirmDialog
        open={restartConfirmOpen}
        onOpenChange={(open) => {
          if (!open) setRestartConfirmOpen(false);
        }}
        isPending={restartDialogOwnDispatch}
        onConfirm={() => {
          // So on the fallback route the confirm IS the force consent: same click-time identity guard and same shared
          // mutation key as the busy-offer dialog's Force, so menu/tray/Settings respawns keep deduping.
          if (restartViaForceFallback) {
            const liveHostId = liveLocalHostIdNow();
            if (liveHostId !== null && liveHostId !== forceRestartLocalHostId) {
              setRestartConfirmOpen(false);
              toast.info("Host changed", {
                description: HOST_CHANGED_DESCRIPTION,
              });
              return;
            }
            forceRestart.mutate();
            return;
          }
          // Minted at confirm - the moment the action is armed - then reused for every attempt at that same action,
          // including a retry after an ambiguous transport failure.
          const transitionId = armedRestartIdRef.current ?? newTransitionId();
          armedRestartIdRef.current = transitionId;
          restart.mutate(
            { transitionId },
            {
              onSuccess: (response) => {
                setRestartConfirmOpen(false);
                // A definitive answer ends this action: accepted means the claim is spent, busy means it was refused outright.
                // Either way the next confirm is a new action and must not adopt it.
                armedRestartIdRef.current = null;
                if (response.outcome === "busy") {
                  // Not an error: the host closed admission, found work in flight, and reopened it.
                  if (forceRestartLocalHostId === null) {
                    toastHostRestartDeclined(
                      busyRestartMessage(response.verdict, false),
                    );
                    return;
                  }
                  setForceRestartOffer({
                    hostId: forceRestartLocalHostId,
                    hostName: displayName,
                    verdict: response.verdict,
                  });
                  return;
                }
                toastHostRestartRequested();
              },
              onError: (error) => {
                setRestartConfirmOpen(false);
                // Deliberately not cleared: a transport failure says nothing about whether the host granted the claim, so the
                // id stays armed for the retry that adopts it.
                toastFromHostError(error, "Couldn't restart this host.");
              },
            },
          );
        }}
      />
      {/* The busy verdict's whole affordance, and the same dialog the menu/tray restart flow shows for the same
         answer: Defer or Force restart, with the session count stated where the decision is made. */}
      <HostBusyForceDeferDialog
        open={forceRestartOffer !== null}
        message={
          forceRestartOffer === null
            ? ""
            : busyRestartMessage(forceRestartOffer.verdict, true)
        }
        // So this goes inert for any respawn in flight, not just the one pressed here - deliberately, so a second
        // respawn cannot be stacked on the first.
        isForcing={forceRestartInFlight}
        forceLabel="Force restart"
        onForce={() => {
          if (forceRestartOffer === null) return;
          // `null` here is "cannot tell" (no binding, or the local entry went away because the host is down) - not
          // evidence of a swap, and the state where a respawn is most legitimate.
          const liveHostId = liveLocalHostIdNow();
          if (liveHostId !== null && liveHostId !== forceRestartOffer.hostId) {
            setForceRestartOffer(null);
            toast.info("Host changed", {
              description: HOST_CHANGED_DESCRIPTION,
            });
            return;
          }
          forceRestart.mutate();
        }}
        onDefer={() => setForceRestartOffer(null)}
      />
      <DoctorSheet
        open={doctorOpen}
        onOpenChange={setDoctorOpen}
        source={
          // The bridge branch's one production caller: a stopped local host cannot shell its own CLI over an RPC it
          // cannot answer, and the report this machine's bridge produces IS about the machine the page names.
          localDown
            ? {
                kind: "bridge",
                // Not a fail-closed default: an empty id is allowed against a host with no identity machinery (the
                // `unenrolled` arm), so this rests on the proof above, not on the fallback.
                expectedHostId: forceRestartLocalHostId ?? "",
              }
            : {
                kind: "rpc",
                client,
                hostName: displayName,
                isLocalMachine: host.isLocalMachine,
                hasLocalBridge: props.hasLocalBridge,
                degrade: doctorDegrade,
                // The capability itself, not `!restartViaForceFallback`: a remote host can refuse `host.restart` too, where no
                // force route exists and the inverse would misread as "the RPC works".
                rpcRestartSupported: restartSupported,
                // The same derived fact the confirm dialog's dispatch leg branches on, threaded rather than re-derived from
                // `isLocalMachine && hasLocalBridge` inside the card.
                bridgeRestartRoute: restartViaForceFallback,
                // On the fallback route the dialog's confirm IS the force consent: same click-time identity guard, same
                // page-wide lifecycle gate, same cross-surface mutation key.
                onBridgeRestart: () => {
                  if (anyPending) return;
                  setRestartConfirmOpen(true);
                },
                bridgeRestartPending: forceRestartInFlight || anyPending,
                // `diagnostics.logs.tail` is absent from every released host below the maintenance floor (verified against the
                // `host-v1.1.11` protocol-surface asset.
                rpcLogsSupported: logsSupported,
                onBridgeLogs: () => bridgeDoctorLogs.mutateAsync(),
                bridgeLogsPending: bridgeDoctorLogs.isPending,
                onLocalFix: props.onLocalDoctorFix,
                localFixPendingCode: props.localDoctorFixPendingCode,
              }
        }
      />
    </div>
  );
}

/** Gated ON both the rendered health state and the lease, and the conjunction is the point rather than
 * belt-and-braces. */
export function HostUpdateRequiredSlot(props: {
  readonly host: HostScopeOption;
  readonly canManageHost: boolean;
}): ReactNode {
  const lease = useHostLease(props.host.hostId);
  const convergeReady = useRunnerConvergeReady();
  if (props.host.health.state !== "update-required") return null;
  if (lease === null || lease.status !== "dead") return null;
  if (lease.dead.reason !== "incompatible") return null;
  return (
    <HostUpdateRequiredAction
      detail={lease.dead.detail}
      canManageHost={props.canManageHost}
      pending={convergeReady.isPending}
      onUpdateHost={() => {
        convergeReady.mutate(
          { force: true },
          {
            onSuccess: () => {
              toast.success(`Updating ${props.host.name}…`);
            },
            onError: (error) =>
              toastFromRunnerError(
                error,
                `Couldn't update ${props.host.name}.`,
              ),
          },
        );
      }}
    />
  );
}

/** Two things remain, both bridge-backed and so both honest without a route: - reinstall, only when the user
 * removed Traycer from this computer. */
function LocalHostDownActions(props: {
  readonly hostName: string;
  readonly settingUp: boolean;
  readonly onOpenDoctor: () => void;
}): ReactNode {
  const management = useRunnerHostOrNull()?.hostManagement ?? null;
  const removal = useRunnerHostRemovalStateQuery({
    enabled: management !== null,
  });
  const reinstall = useRunnerReinstallTraycer();
  const removed = removal.data?.removedByUser === true;
  // The first attempt never showed that, because `removed` is still true until the sentinel refetch lands, which
  // is why it needs its own test.
  const removalRepairable = removed || reinstall.isError || reinstall.isPending;
  const busy = props.settingUp || reinstall.isPending;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {removalRepairable ? (
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={busy}
          data-testid="host-overview-reinstall-local"
          onClick={() => {
            reinstall.mutate(undefined, {
              onSuccess: () => {
                toast.success(`Reinstalling Traycer on ${props.hostName}…`);
              },
              onError: (error) =>
                toastFromRunnerError(
                  error,
                  `Couldn't reinstall Traycer on ${props.hostName}.`,
                ),
            });
          }}
        >
          {reinstall.isPending ? (
            <AgentSpinningDots
              className="mr-2 size-3"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Reinstall Traycer
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        data-testid="host-overview-recovery-doctor"
        onClick={props.onOpenDoctor}
      >
        Run doctor
      </Button>
    </div>
  );
}

/** Six questions rather than one, because they have six different answers on a fleet mid-update. */
interface OverviewCapabilities {
  readonly identity: OverviewDegradeReason | null;
  readonly restart: OverviewDegradeReason | null;
  /** Reads the same two inputs as `restart` above, so the button and its routing cannot tear. */
  readonly restartViaForceFallback: boolean;
  /** The Doctor sheet needs this fact and not its routing consequence: a remote host can refuse `host.restart`
   * too, where no force route exists and `!restartViaForceFallback` would misread as "the RPC works". */
  readonly restartSupported: boolean;
  /** `false` only for a host below the maintenance floor, whose Doctor sheet this fallback enables - its log read
   * has to go over the bridge or the Show logs button cannot work. */
  readonly logsSupported: boolean;
  readonly doctor: OverviewDegradeReason | null;
  readonly installInfo: OverviewDegradeReason | null;
  readonly updateCheck: OverviewDegradeReason | null;
  readonly updateInstall: OverviewDegradeReason | null;
  readonly identitySet: OverviewDegradeReason | null;
  /** The three OS-service methods, asked separately for the same reason as the rest. */
  readonly serviceStatus: OverviewDegradeReason | null;
  readonly serviceRegister: OverviewDegradeReason | null;
  readonly serviceDeregister: OverviewDegradeReason | null;
}

/** What can stand in for a method the handshake refused, threaded from the page rather than re-derived here so
 * enablement and routing read the same facts the client construction read. */
interface OverviewFallbackRoutes {
  /** `scope.localMaintenanceFallback`: the scope's client is the decorator that serves the pinned four
   * maintenance methods over the desktop CLI lane (`lib/host/local-maintenance-fallback-client.ts`). */
  readonly maintenanceFallback: boolean;
  readonly restartForceRoute: boolean;
}

function useOverviewCapabilities(
  hostId: string | null,
  fallback: OverviewFallbackRoutes,
): OverviewCapabilities {
  const restartSupport = useHostMethodSupport(hostId, "host.restart");
  const logsSupport = useHostMethodSupport(hostId, "diagnostics.logs.tail");
  return {
    identity: overviewMethodDegrade(
      useHostMethodSupport(hostId, "host.identity.get"),
    ),
    // A ≤1.1.11 host never reads `host-name.json`, so a bridge-written rename would split this page's name from
    // the registry `displayName` every other surface shows for as long as the host stays old.
    identitySet: overviewMethodDegrade(
      useHostMethodSupport(hostId, "host.identity.set"),
    ),
    restart: resolveOverviewMethodDegrade(
      restartSupport,
      fallback.restartForceRoute,
    ),
    restartViaForceFallback:
      restartSupport === false && fallback.restartForceRoute,
    restartSupported: restartSupport !== false,
    logsSupported: logsSupport !== false,
    doctor: resolveOverviewMethodDegrade(
      useHostMethodSupport(hostId, "host.doctor"),
      fallback.maintenanceFallback,
    ),
    installInfo: resolveOverviewMethodDegrade(
      useHostMethodSupport(hostId, "host.getInstallationInfo"),
      fallback.maintenanceFallback,
    ),
    updateCheck: resolveOverviewMethodDegrade(
      useHostMethodSupport(hostId, "host.update.check"),
      fallback.maintenanceFallback,
    ),
    updateInstall: resolveOverviewMethodDegrade(
      useHostMethodSupport(hostId, "host.update.install"),
      fallback.maintenanceFallback,
    ),
    // They keep today's unsupported notice until the host updates.
    serviceStatus: overviewMethodDegrade(
      useHostMethodSupport(hostId, "host.service.status"),
    ),
    serviceRegister: overviewMethodDegrade(
      useHostMethodSupport(hostId, "host.service.register"),
    ),
    serviceDeregister: overviewMethodDegrade(
      useHostMethodSupport(hostId, "host.service.deregister"),
    ),
  };
}

/** So the hand-off is a settle onto the fresher of two agreeing sources, never a blank waiting to be filled,
 * and there is no state in which this returns an empty name. */
interface OverviewDisplay {
  readonly identity: HostIdentity | null;
  readonly displayName: string;
  /** What the rename input shows before the user types. */
  readonly persistedNameDraft: string;
  readonly hostVersion: string | null;
  readonly updateProgress: HostStatusUpdateProgress | null;
  /** Distinct from `updateProgress`: the coarse field cannot tell a parked attempt from an executing one, which
   * is the difference between informing the user and locking them out of their own host. */
  readonly updateOperation: HostStatusUpdateOperation | null;
  /** The display read: it survives a refetch of stale data so the row does not blank for a round trip. */
  readonly busy: boolean;
  readonly busySessionCount: number | null;
  readonly busyBreakdown: HostBusyBreakdown | null;
  /** Diverges from the display fields exactly while a fetch is in flight. */
  readonly settledBusy: boolean;
  readonly settledBusySessionCount: number | null;
  readonly settledBusyBreakdown: HostBusyBreakdown | null;
}

function useOverviewDisplay(input: {
  readonly scope: HostScope;
  readonly host: HostScopeOption | null;
  readonly identity: HostIdentity | null;
  readonly status: ResponseOfMethod<HostRpcRegistry, "host.status"> | null;
  /** Freshness of the read above - retained cache data is not a live read. */
  readonly statusHealth: {
    readonly isError: boolean;
    readonly fetchStatus: "fetching" | "paused" | "idle";
    readonly isStale: boolean;
    readonly hasLiveSource: boolean;
  };
}): OverviewDisplay {
  const { scope, host, identity, status, statusHealth } = input;
  const busy = overviewBusySnapshot(status, statusHealth);
  return {
    identity,
    displayName: identity?.effectiveName ?? host?.name ?? scope.hostLabel,
    persistedNameDraft: persistedDraftFromIdentity(identity),
    // They were the page's one legitimate per-kind difference, and what they bought was a monospace band nobody
    // acts on from Settings.
    hostVersion: status?.hostVersion ?? null,
    updateProgress: status?.updateProgress ?? null,
    updateOperation: status?.updateOperation ?? null,
    ...busy,
  };
}

/** Routed through the live-source helpers rather than read straight off the response: a retained cache entry is
 * not a live read, and this snapshot is what the chip states and the drain force is sized from. */
function overviewBusySnapshot(
  status: ResponseOfMethod<HostRpcRegistry, "host.status"> | null,
  statusHealth: {
    readonly isError: boolean;
    readonly fetchStatus: "fetching" | "paused" | "idle";
    readonly isStale: boolean;
    readonly hasLiveSource: boolean;
  },
): Pick<
  OverviewDisplay,
  | "busy"
  | "busySessionCount"
  | "busyBreakdown"
  | "settledBusy"
  | "settledBusySessionCount"
  | "settledBusyBreakdown"
> {
  const liveSource = {
    reportedCount: status?.busySessionCount ?? null,
    isError: statusHealth.isError,
    fetchStatus: statusHealth.fetchStatus,
    isStale: statusHealth.isStale,
    hasLiveSource: statusHealth.hasLiveSource,
  };
  return {
    busy: liveHostBusy({
      ...liveSource,
      reportedBusy: status?.busy ?? false,
    }),
    busySessionCount: liveBusySessionCount(liveSource),
    busyBreakdown: liveBusyBreakdown({
      ...liveSource,
      reportedBreakdown: status?.busyBreakdown ?? null,
    }),
    settledBusy: settledHostBusy({
      ...liveSource,
      reportedBusy: status?.busy ?? false,
    }),
    settledBusySessionCount: settledBusySessionCount(liveSource),
    settledBusyBreakdown: settledBusyBreakdown({
      ...liveSource,
      reportedBreakdown: status?.busyBreakdown ?? null,
    }),
  };
}

/** The install record is pure host RPC, so with no route that row renders nothing rather than a gate notice. A
 * second gate here printed the same "can't reach this host" notice twice on one page. */
function HostOverviewInstallationCard(props: {
  readonly usable: boolean;
  readonly hostName: string;
  readonly degrade: OverviewDegradeReason | null;
  readonly record: InstallationDetailsRecord | null;
  readonly loading: boolean;
  /** The read itself failed - which is NOT the same as "no record". */
  readonly readFailed: boolean;
  readonly advanced: ReactNode;
}): ReactNode {
  return (
    <SettingsGroup
      title="Installation"
      tone="default"
      dataTestId="host-installation"
      fill={false}
    >
      {!props.usable ? null : (
        <HostOverviewInstallationBody
          hostName={props.hostName}
          degrade={props.degrade}
          record={props.record}
          loading={props.loading}
          readFailed={props.readFailed}
        />
      )}
      {props.advanced}
    </SettingsGroup>
  );
}

/** Collapsing both to `record: null` made the card assert that this host runs from a checkout or an unpacked
 * tree - a fact the RPC never established, stated to the user as if it had. */
function HostOverviewInstallationBody(props: {
  readonly hostName: string;
  readonly degrade: OverviewDegradeReason | null;
  readonly record: InstallationDetailsRecord | null;
  readonly loading: boolean;
  readonly readFailed: boolean;
}): ReactNode {
  if (props.degrade !== null) {
    return (
      <HostOverviewNotice testId="host-overview-installation-degraded">
        {describeOverviewDegrade(props.degrade, props.hostName)}
      </HostOverviewNotice>
    );
  }
  if (props.readFailed && props.record === null) {
    return (
      <HostOverviewNotice testId="host-overview-installation-unreadable">
        {`Couldn't read ${props.hostName}'s installation record.`}
      </HostOverviewNotice>
    );
  }
  return (
    <InstallationDetailsDisclosure
      record={props.record}
      loading={props.loading}
      emptyMessage={`${props.hostName} is running from a checkout or an unpacked tree, so it has no installation record.`}
    />
  );
}

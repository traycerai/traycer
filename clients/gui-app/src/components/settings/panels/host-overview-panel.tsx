import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { HostDoctorIssue } from "@traycer/protocol/host/maintenance/index";
import { RestartHostConfirmDialog } from "@/components/host/restart-host-confirm-dialog";
import { DoctorSheet } from "@/components/settings/panels/host-settings-doctor-sheet";
import {
  InstallationDetailsDisclosure,
  type InstallationDetailsRecord,
} from "@/components/settings/panels/host-settings-installation-details";
import { HostIdentityCard } from "@/components/settings/host-scope/host-identity-card";
import { HostDangerZone } from "@/components/settings/host-scope/host-danger-zone";
import { HostUpdateDrainGateRow } from "@/components/settings/host-scope/host-registry-updates";
import { useHostRegistryUpdateMutation } from "@/components/settings/host-scope/use-host-registry-update-mutation";
import { SettingsGroup } from "@/components/settings/settings-group";
import {
  HostOverviewHeaderActions,
  HostOverviewNameAction,
  HostOverviewNotice,
  HostOverviewUpdateProgress,
  HostRestartBusyNotice,
} from "@/components/settings/panels/host-overview-status-card";
import { HostOverviewUpdatesRegion } from "@/components/settings/panels/host-overview-updates";
import { useHostOverviewUpdates } from "@/components/settings/panels/host-overview-updates-state";
import { useOverviewOsService } from "@/components/settings/panels/host-overview-os-service";
import { HostOverviewAdvancedDisclosure } from "@/components/settings/panels/host-overview-advanced";
import {
  customNameFromIdentityDraft,
  describeOverviewDegrade,
  overviewMethodDegrade,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";
import {
  liveBusySessionCount,
  settledBusySessionCount,
} from "@/components/settings/panels/my-hosts-model";
import { persistedDraftFromIdentity } from "@/components/settings/panels/host-settings-panel-model";
import { LocalPackageManagerUpgradeHint } from "@/components/settings/panels/host-settings-package-manager-upgrade-hint";
import { useRunnerConvergeReady } from "@/hooks/runner/use-runner-converge-ready-mutation";
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
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { cn } from "@/lib/utils";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { HostIdentity } from "@traycer/protocol/host/identity/index";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostStatusUpdateProgress } from "@traycer/protocol/host/status/index";

/** How long an accepted install may hold the page before progress appears. */
const UPDATE_INSTALL_ACCEPTED_LATCH_MS = 60_000;

/**
 * ONE Overview, for every host.
 *
 * This page describes the SCOPED host by asking that host: `host.status` for
 * what it is running, `host.identity.get` for what it is called, and
 * `host.getInstallationInfo` for how it was installed. A machine on this desk
 * and a machine in a datacenter render the same components from the same
 * answers — that equivalence is the deliverable, not a side effect, and it is
 * what the fixture-parity test pins.
 *
 * What USED to be here was the local CLI bridge as primary source, which is why
 * a remote host got a thinner page describing it in a different dialect. The
 * bridge is gone from this page entirely — it can only ever speak for the local
 * machine, so no surface built on it can be part of a page that promises to
 * describe any host.
 *
 * TWO regions, not three. The identity card carries what this host IS, and that
 * includes the update ANSWER — is there a newer version, install it — because
 * that is a fact about the host in the same register as its version and its
 * session count. Everything that is a decision rather than an answer sits in
 * Installation, behind Advanced: the auto-update policy, the OS service, the
 * full version list. Updates used to own a titled section between the two, which
 * put a section header on a single sentence and read as a second subject.
 *
 * Every button degrades on its OWN capability. An old host can support
 * `host.status` and not `host.restart`; a current host on a box with no Traycer
 * CLI can restart but cannot run doctor or update itself. Collapsing those into
 * one page-level gate is how a capability downgrade during a fleet update turns
 * into "this page is broken".
 */
// The identity card, the Installation group and the two dialogs are each their
// own component; what is left here is the page's own state and the handful of
// conditions that decide which of its regions apply. That residue is
// irreducible branching over surfaced concerns rather than nesting, and the same
// disable sat on the page this replaced, for the same reason.
// eslint-disable-next-line complexity
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

  // The BINDING rather than `useHostClient()`: same context, re-provided by the
  // panel above for an explicit pick, but `null` instead of a throw when there
  // is no host runtime at all. Every read below is null-gated.
  const client = useHostBinding()?.hostClient ?? null;
  // MOUNTING, not rendering. A query hook mounted under a non-ready scope still
  // fires against the ambient host and caches the answer under this page's key,
  // however well a gate hides the result.
  const usable = isHostScopeUsable(scope.status) && client !== null;
  // THIS machine's host, affirmatively down, with the bridge right here to
  // revive it. The one state where the RPC-only rule would strand a user: the
  // page can describe the host from the registry but nothing on it could
  // start the process back up. `unreachable` only — while `connecting` the
  // route may still resolve, and offering Start against a host that is about
  // to answer would race the very process it spawns. This is what remains of
  // the recovery console's Start/doctor half (its uninstall half lives on the
  // empty-account path); `LocalHostGate` no longer renders in production, so
  // Settings cannot delegate this state upstream.
  const localRecovery =
    scope.status === "unreachable" &&
    (host?.isLocalMachine ?? false) &&
    props.hasLocalBridge;

  const [doctorOpen, setDoctorOpen] = useState(false);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [restartBusyCount, setRestartBusyCount] = useState<number | null>(null);
  // The id of a restart whose DISPATCH OUTCOME IS UNKNOWN - the transport threw
  // after the host may already have granted the claim. `host.restart` is
  // claim-gated, so the retry has to carry that same id to adopt the claim it
  // may already hold; minting a fresh one turns the idempotent retry this
  // contract exists for into a busy refusal. Cleared on every DEFINITIVE
  // answer, so a genuinely new action never inherits a stale claim.
  const armedRestartIdRef = useRef<string | null>(null);
  const hostIdCopy = useClipboardCopy({
    resetMs: 1600,
    onSuccess: () => toast.success("Host ID copied"),
    onError: () => toast.error("Couldn't copy the host ID"),
  });

  const {
    identity: identityDegrade,
    identitySet: identitySetDegrade,
    restart: restartDegrade,
    doctor: doctorDegrade,
    installInfo: installInfoDegrade,
    updateCheck: updateCheckDegrade,
    updateInstall: updateInstallDegrade,
    serviceStatus: serviceStatusDegrade,
    serviceRegister: serviceRegisterDegrade,
    serviceDeregister: serviceDeregisterDegrade,
  } = useOverviewCapabilities(scope.hostId);

  const statusQuery = useHostOverviewStatusQuery({ client, enabled: usable });
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
  // Instantiated BEFORE the busy gate: its most consequential write is the
  // drain-force PATCH ("Apply now" sets force: true so the host bypasses its
  // session drain), and a gate that excluded it left Restart and the service
  // verbs live in exactly the window that write exists to make exclusive.
  const policyMutation = useHostRegistryUpdateMutation(scope.hostId);

  const view = useOverviewDisplay({
    scope,
    host,
    identity: identityQuery.data ?? null,
    status: statusQuery.data ?? null,
    // The drain count is only as trustworthy as the read behind it, so the
    // read's HEALTH travels with its value. See `liveBusySessionCount`.
    statusHealth: {
      isError: statusQuery.isError,
      fetchStatus: statusQuery.fetchStatus,
      isStale: statusQuery.isStale,
      hasLiveSource: usable,
    },
  });
  const { identity, displayName } = view;

  // Save and Reset are the SAME write with a different argument — `null` clears
  // the override and falls the name back to the host's own default. Sharing the
  // handler is what keeps their success and failure behaviour identical; two
  // copies drifted the moment one of them grew a toast the other did not.
  const { mutate: mutateIdentity } = identitySet;
  // A rejected rename's draft, kept so a failed save is RETRYABLE. The inline
  // editor closes on commit - before the mutation settles - so by the time a
  // rejection arrives the typed name is off screen; the page this replaced
  // deliberately kept the editor open with its draft on rejection. Cleared on
  // the next successful write; seeds `value` below so the reopened editor
  // holds the attempted name, not the persisted one.
  const [failedRename, setFailedRename] = useState<{
    readonly draft: string;
    readonly attempt: number;
  } | null>(null);
  const reopenRenameRef = useRef<() => void>(() => undefined);
  const submitRename = (customName: string | null): void => {
    // Belt to the Save button's braces. The button is the UI guard against a
    // no-op write; this is the one that holds if a caller ever routes here
    // another way, because the write is not harmless: storing the current
    // effective name as an explicit `customName` FREEZES a registration label
    // that would otherwise keep tracking the host.
    if (customName === (identity?.customName ?? null)) return;
    mutateIdentity(
      { customName },
      {
        onSuccess: (next) => {
          setFailedRename(null);
          toast.success(`Renamed to ${next.effectiveName}`);
        },
        onError: (error) => {
          // The reopen happens in the EFFECT below, one render later, not
          // here: `startEditing` seeds the editor from the value its render
          // captured, so a same-batch reopen would copy the persisted name in
          // before the failed draft ever became the hook's value. The attempt
          // counter makes a repeat failure with identical text re-fire it.
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

  // An accepted `host.update.install` returns the moment the CLI takes the job;
  // the swap itself continues DETACHED and is reported only through
  // `host.status.updateProgress`. Gating on the mutation alone therefore
  // re-enables Update now and every version row the instant the request is
  // ACCEPTED rather than when the update finishes - and a second selection from
  // there sends another install that can retarget the one already running.
  //
  // `updating` is the only state that means "still going". `failed` is terminal
  // and deliberately leaves the controls live, because that is exactly when
  // someone needs to retry.
  const updateInFlight = view.updateProgress?.state === "updating";
  const corePending =
    restart.isPending ||
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
    settledBusySessionCount: view.settledBusySessionCount,
    refetchStatus: () => {
      void serviceStatusQuery.refetch();
    },
  });
  // The service writes are IN the page-wide gate, not only gated BY it.
  // Re-registering cycles the OS service and replaces this very host process,
  // so a Restart or a detached update launched beside it races that lifecycle;
  // the section locks the page for the same reason the page locks the section.
  const gatePending =
    corePending || service.registerPending || service.deregisterPending;
  // The install REQUEST is in the gate too, not only the detached progress:
  // between pressing Install and the `accepted` answer, `updateProgress` has
  // not started yet, and that gap is exactly wide enough for a Restart or a
  // service write to race the install being granted. The ACCEPTED latch then
  // bridges the second gap - after the answer, before the detached updater
  // publishes progress - and releases the moment progress appears, on a scope
  // flip, or by its bounded timer (the host-keyed store survives remounts).
  const updateInstallAcceptedAt = useHostServiceWriteLatchStore(
    (state) =>
      hostServiceWriteLatches(state.byHost, scope.hostId)
        .updateInstallAcceptedAt,
  );
  useEffect(() => {
    if (scope.hostId === null || updateInstallAcceptedAt === null) return;
    const hostId = scope.hostId;
    // ONLY an `updating` frame releases: it is the one progress state that
    // proves the NEW detached updater is publishing. A `failed` frame can be
    // the terminal state of the PREVIOUS attempt, still on `host.status` when
    // a retry arms the latch - releasing on it reopened exactly the gap the
    // latch closes. A retry that itself fails fast without an `updating`
    // frame is covered by the bounded timer, in the safe direction.
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
  // The accepted latch is part of the gate the UPDATE controls consume too:
  // read before the hook below so Check now, Update now and the version rows
  // freeze during the accepted-to-first-progress gap, not only the rest of
  // the page.
  const updateGatePending = gatePending || updateInstallAcceptedAt !== null;

  // The update story lives at PAGE level because its two halves now render in
  // two different containers: the answer — is there an update, install it — as a
  // band on the identity card, and the decisions behind Advanced down in
  // Installation. One instance of each hook, so the two halves cannot disagree
  // about what the last check returned or which write is in flight.
  //
  // This is also the single `useHostRegistryUpdateMutation`, which BOTH the
  // drain gate and the auto-update switch write through. Two instances would
  // each track their own `isPending`, so one control would stay live while the
  // other's write was still going.
  const updates = useHostOverviewUpdates({
    client,
    hostName: displayName,
    installedVersion: view.hostVersion,
    platformKey: host?.platform ?? null,
    // The check reads on its own now, so this gate is load-bearing rather than
    // cosmetic: without it the page would spawn a CLI process on the host from
    // a scope that has not resolved, and cache the answer under this page's key.
    enabled: usable,
    checkDegrade: updateCheckDegrade,
    installDegrade: updateInstallDegrade,
    busy: updateGatePending,
  });
  const anyPending = updateGatePending || updates.summary.installing;

  // The restart confirmation has the same stale-open window the OS-service
  // confirms do (`host-overview-advanced.tsx`): opened while idle, it stays
  // answerable while an automatic install or another lifecycle write arms the
  // page-wide gate under it. Close it for every arming EXCEPT its own
  // dispatch — this dialog deliberately stays open through `restart.mutate`
  // to show its spinner and route the busy verdict. Adjust-during-render so
  // the close lands in the arming commit.
  if (restartConfirmOpen && anyPending && !restart.isPending) {
    setRestartConfirmOpen(false);
  }

  // The name edits in place, exactly as a tab title does — same hook, so Enter
  // commits, Escape reverts, blur settles once, and the input can never commit
  // an empty string. That last rule is why "Reset name to default" is a menu
  // item rather than a third button under the input: clearing the override is a
  // DIFFERENT write (`null`), not an empty save, and the editor deliberately has
  // no way to express it.
  const rename = useInlineRename({
    value: failedRename?.draft ?? view.persistedNameDraft,
    // `!anyPending` covers the identity write itself (via `corePending`) — the
    // editor closes on commit BEFORE the write settles, and an editor reopened
    // in that window enqueues a second `host.identity.set` the first one's
    // failure callback would then clobber — and the page-wide gate with it: a
    // rename must not dispatch while the host is swapping versions, restarting,
    // or rewriting its OS service, where the expected transport drop would
    // reject the write and strand its retry draft on an unusable scope. This is
    // why the hook lives BELOW the gate chain rather than with the other
    // identity wiring above.
    canEdit:
      usable && renameDegrade === null && identity !== null && !anyPending,
    onCommit: (next) => submitRename(customNameFromIdentityDraft(next)),
  });
  // Ref-carried so the reopen effect below always calls THIS render's
  // `startEditing` - the closure that captured the failed draft as value.
  useEffect(() => {
    reopenRenameRef.current = rename.startEditing;
  });
  // Reopen AFTER the failed draft is the hook's current value (see onError).
  useEffect(() => {
    if (failedRename === null) return;
    reopenRenameRef.current();
  }, [failedRename]);

  // Focus restoration: the pencil unmounts while the input is up and comes back
  // on close, so the trigger is refocused on that true->false transition only —
  // never on mount, where it would steal focus from the page. Same pattern (and
  // the same `wasEditingRef`) the summary card uses for the same reason.
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

  // The header cluster, withheld entirely when there is no route rather than
  // rendered and disabled. Every one of its verbs needs a live host to answer,
  // so on an unreachable host they would be dead controls under a card that
  // already says the host cannot be reached — and "disabled" would wrongly
  // imply a capability verdict rather than a connectivity one. What survives
  // an outage is the account-backed half below: the update policy, which
  // needs no route at all. The ONE exception is this computer's own stopped
  // host, whose revival verbs run over the CLI bridge and need no route by
  // construction.
  let headerActions: ReactNode = null;
  if (localRecovery) {
    headerActions = (
      <LocalHostRecoveryActions
        hostName={displayName}
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
        restartPending={restart.isPending}
        anyPending={anyPending}
        isActive={host.isActive}
        connectable={host.connectable}
        // Only offered when there is an override to clear. A host running
        // under its own default name has nothing to reset, and the write
        // would be the no-op `submitRename` already guards.
        onResetName={
          (identity?.customName ?? null) === null
            ? null
            : () => submitRename(null)
        }
        resetNameDegrade={renameDegrade}
        onRestart={() => {
          setRestartBusyCount(null);
          setRestartConfirmOpen(true);
        }}
        onOpenDoctor={() => setDoctorOpen(true)}
        onMakeActive={() => scope.makeActive(host.hostId)}
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
        sessionCount={view.busySessionCount}
        nameAction={
          !usable ? null : (
            <HostOverviewNameAction
              hostName={displayName}
              pendingWrite={identitySet.isPending}
              // The page-wide gate, distinct from `pendingWrite`: it locks the
              // trigger during ANY lifecycle write (install, restart, service
              // register/deregister) without claiming an identity write is in
              // flight — only `pendingWrite` swaps the pencil for the spinner.
              locked={anyPending}
              // The WRITE capability gates the rename affordance, not the read.
              // The pencil and "Retry name" both lead to `host.identity.set`,
              // so a host that can be read but not written must degrade them -
              // otherwise Save calls a method the handshake already declined.
              degrade={renameDegrade}
              loaded={identity !== null}
              failed={identity === null && identityQuery.isError}
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
      >
        {view.updateProgress === null ? null : (
          <HostOverviewUpdateProgress
            state={view.updateProgress.state}
            error={view.updateProgress.error}
          />
        )}
        {restartBusyCount === null ? null : (
          <HostRestartBusyNotice
            busySessionCount={restartBusyCount}
            retryPending={restart.isPending}
            onRetry={() => {
              setRestartBusyCount(null);
              setRestartConfirmOpen(true);
            }}
            onDismiss={() => setRestartBusyCount(null)}
          />
        )}
        {/* The update ANSWER, on the card that describes the host — not under a
            section header of its own. "Is there an update, and install it" is a
            fact about this host in the same register as its version and its
            session count, and giving it a titled section of its own implied a
            second subject where there is only one. Everything that is a decision
            rather than an answer is down in Advanced. */}
        {!usable ? null : (
          <HostOverviewUpdatesRegion
            summary={updates.summary}
            degrade={updates.degrade}
          />
        )}
        {/* Stays OUT of Advanced, deliberately. This is the only control on the
            page with a deadline — it renders solely while an update is blocked
            on open sessions — and a collapsed disclosure is where a deadline
            goes to be missed. */}
        {registryItem === null ? null : (
          <HostUpdateDrainGateRow
            item={registryItem}
            mutation={policyMutation}
            liveBusySessionCount={view.busySessionCount}
            settledBusySessionCount={view.settledBusySessionCount}
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
          // Withheld entirely when every section inside would be: no registry
          // row kills the policy switch, and no route kills the service and
          // version sections. An "Advanced" that opens onto nothing reads as
          // a broken page, not an empty one.
          registryItem === null && !usable ? null : (
            <HostOverviewAdvancedDisclosure
              hostName={displayName}
              registryItem={registryItem}
              policyMutation={policyMutation}
              // The FULL gate at render time, not the hook-time `corePending`:
              // the service verbs must also lock during the install-request
              // window, and `anyPending` only exists after the updates hook
              // the service adapter feeds - so the override happens here,
              // where both are in hand.
              service={usable ? { ...service, busy: anyPending } : null}
              // Gated on the ROUTE as well as the capability. Picking a version
              // means asking the host which ones exist, so an unreachable host
              // gets no picker at all rather than a checkbox and an invitation
              // to press a Check now that is not on screen.
              versions={
                usable && updates.degrade === null ? updates.picker : null
              }
            />
          )
        }
      />

      {/* Local machine only, by the nature of the fact rather than a scope
          rule: the hint is Desktop's launch-time comparison of ITS bundled CLI
          against THIS machine's package-manager CLI, recorded in Desktop-local
          reconcile state the bridge alone can read. There is no remote
          equivalent to render. */}
      {props.hasLocalBridge ? <LocalPackageManagerUpgradeHint /> : null}

      {/* No list of the OTHER hosts, and no "Add host": a page about one host
          is the wrong place to manage the collection it belongs to. The
          sidebar switcher owns both.

          Not gated from out here: the zone's rows sit on three different
          capability planes (host RPC, the local CLI bridge, an account write)
          and it gates each of them itself. A gate around all three took the
          recovery actions away in the states that need them. */}
      <HostDangerZone scope={scope} />

      <RestartHostConfirmDialog
        open={restartConfirmOpen}
        onOpenChange={(open) => {
          if (!open) setRestartConfirmOpen(false);
        }}
        isPending={restart.isPending}
        onConfirm={() => {
          // Minted at CONFIRM — the moment the action is armed — then REUSED
          // for every attempt at that same action, including a retry after an
          // ambiguous transport failure. See `newTransitionId` for why neither
          // a fresh id per network retry nor a shared constant is correct.
          const transitionId = armedRestartIdRef.current ?? newTransitionId();
          armedRestartIdRef.current = transitionId;
          restart.mutate(
            { transitionId },
            {
              onSuccess: (response) => {
                setRestartConfirmOpen(false);
                // A definitive answer ends this action: accepted means the
                // claim is spent, busy means it was refused outright. Either
                // way the next confirm is a NEW action and must not adopt it.
                armedRestartIdRef.current = null;
                if (response.outcome === "busy") {
                  // Not an error: the host closed admission, found work in
                  // flight, and reopened it. Nothing was interrupted.
                  setRestartBusyCount(response.verdict.busySessionCount);
                  return;
                }
                toast.success(`Restarting ${displayName}`);
              },
              onError: (error) => {
                setRestartConfirmOpen(false);
                // Deliberately NOT cleared: a transport failure says nothing
                // about whether the host granted the claim, so the id stays
                // armed for the retry that adopts it.
                toastFromHostError(error, "Couldn't restart this host.");
              },
            },
          );
        }}
      />
      <DoctorSheet
        open={doctorOpen}
        onOpenChange={setDoctorOpen}
        source={
          // The bridge branch's one production caller: a stopped local host
          // cannot shell its own CLI over an RPC it cannot answer, and the
          // report this machine's bridge produces IS about the machine the
          // page names — the misattribution the rpc-only rule guards against
          // cannot happen when the subject is this computer.
          localRecovery
            ? { kind: "bridge" }
            : {
                kind: "rpc",
                client,
                hostName: displayName,
                isLocalMachine: host.isLocalMachine,
                hasLocalBridge: props.hasLocalBridge,
                degrade: doctorDegrade,
                onLocalFix: props.onLocalDoctorFix,
                localFixPendingCode: props.localDoctorFixPendingCode,
              }
        }
      />
    </div>
  );
}

/**
 * The header cluster for this computer's host when it is affirmatively DOWN.
 *
 * Two verbs, both bridge-backed and so both honest without a route: Start
 * (`convergeReady` — install + register + start, the same intent the post-auth
 * gate uses) and the bridge doctor. Success needs no explicit refresh here:
 * the host coming up flips the scope status through its ordinary reactivity
 * and the live cluster replaces this one.
 */
function LocalHostRecoveryActions(props: {
  readonly hostName: string;
  readonly onOpenDoctor: () => void;
}): ReactNode {
  const convergeReady = useRunnerConvergeReady();
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        type="button"
        variant="default"
        size="sm"
        disabled={convergeReady.isPending}
        data-testid="host-overview-start-local"
        onClick={() => {
          convergeReady.mutate(
            { force: false },
            {
              onSuccess: () => {
                toast.success(`Starting ${props.hostName}…`);
              },
              onError: (error) =>
                toastFromRunnerError(
                  error,
                  `Couldn't start ${props.hostName}.`,
                ),
            },
          );
        }}
      >
        {convergeReady.isPending ? (
          <AgentSpinningDots
            className="mr-2 size-3"
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        Start host
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        // Same overlap rule as the live host's page-wide gate: opening the
        // sheet mounts a doctor card that dispatches immediately, and a CLI
        // inspecting the installation converge is mid-rewrite would report
        // (and offer to fix) states that are simply "not done yet".
        disabled={convergeReady.isPending}
        data-testid="host-overview-recovery-doctor"
        onClick={props.onOpenDoctor}
      >
        Run doctor
      </Button>
    </div>
  );
}

/**
 * Every Overview control's capability, asked separately.
 *
 * Six questions rather than one, because they have six different answers on a
 * fleet mid-update: a host can support `host.status` and not `host.restart`, and
 * a current host on a box with no Traycer CLI can restart but cannot run doctor
 * or update itself. One page-level gate would turn any of those into "this page
 * is broken", which is the ambiguity the whole track exists to remove.
 */
interface OverviewCapabilities {
  readonly identity: OverviewDegradeReason | null;
  readonly restart: OverviewDegradeReason | null;
  readonly doctor: OverviewDegradeReason | null;
  readonly installInfo: OverviewDegradeReason | null;
  readonly updateCheck: OverviewDegradeReason | null;
  readonly updateInstall: OverviewDegradeReason | null;
  /** `host.identity.set` support, negotiated apart from the read. */
  readonly identitySet: OverviewDegradeReason | null;
  /**
   * The three OS-service methods, asked separately for the same reason as the
   * rest: they landed together, but a host can be new enough to read its
   * registration and too old to change it, and the read is the one worth having
   * on its own — knowing a service is unregistered is useful even where nothing
   * here can fix it.
   */
  readonly serviceStatus: OverviewDegradeReason | null;
  readonly serviceRegister: OverviewDegradeReason | null;
  readonly serviceDeregister: OverviewDegradeReason | null;
}

function useOverviewCapabilities(hostId: string | null): OverviewCapabilities {
  return {
    identity: overviewMethodDegrade(
      useHostMethodSupport(hostId, "host.identity.get"),
    ),
    // SEPARATE from the read. `host.identity.get` and `host.identity.set` are
    // independent registry capabilities, so a peer can advertise one without
    // the other - and inferring write support from a readable identity opened
    // Edit name against a host whose handshake said it cannot save, turning
    // Save into an RPC the negotiation already ruled out.
    identitySet: overviewMethodDegrade(
      useHostMethodSupport(hostId, "host.identity.set"),
    ),
    restart: overviewMethodDegrade(
      useHostMethodSupport(hostId, "host.restart"),
    ),
    doctor: overviewMethodDegrade(useHostMethodSupport(hostId, "host.doctor")),
    installInfo: overviewMethodDegrade(
      useHostMethodSupport(hostId, "host.getInstallationInfo"),
    ),
    updateCheck: overviewMethodDegrade(
      useHostMethodSupport(hostId, "host.update.check"),
    ),
    updateInstall: overviewMethodDegrade(
      useHostMethodSupport(hostId, "host.update.install"),
    ),
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

/**
 * Everything the card DISPLAYS, derived in one place from the two host reads
 * plus the scope row.
 *
 * Pulled out of the component for a reason beyond tidiness: this is where the
 * name-precedence rule lives, and it is a rule about which of two sources wins,
 * not a rendering detail. `effectiveName` from a reachable host outranks the
 * registry `displayName` the scope row carries — and because the registry's copy
 * FOLLOWS that exact value over the presence heartbeat, the two agree on a
 * healthy fleet. So the hand-off is a settle onto the fresher of two agreeing
 * sources, never a blank waiting to be filled, and there is no state in which
 * this returns an empty name.
 */
interface OverviewDisplay {
  readonly identity: HostIdentity | null;
  readonly displayName: string;
  /** What the rename input shows before the user types. */
  readonly persistedNameDraft: string;
  readonly hostVersion: string | null;
  readonly updateProgress: HostStatusUpdateProgress | null;
  /**
   * Live open-session count from `host.status`, or `null` when this client has
   * no live read of the host. `null` is not zero — see `deriveUpdateAffordance`.
   *
   * The DISPLAY read: it survives a refetch of stale data so the row does not
   * blank for a round trip.
   */
  readonly busySessionCount: number | null;
  /**
   * The same count, but only when the read is SETTLED — what the drain force
   * may be armed and confirmed against. Diverges from `busySessionCount`
   * exactly while a fetch is in flight, which is the window in which the
   * confirm-time equality guard would otherwise compare a retained number to
   * itself and wave through a force sized to a count nobody was shown.
   */
  readonly settledBusySessionCount: number | null;
}

function useOverviewDisplay(input: {
  readonly scope: HostScope;
  readonly host: HostScopeOption | null;
  readonly identity: HostIdentity | null;
  /** The negotiated `host.status` response, as this client's registry sees it. */
  readonly status: ResponseOfMethod<HostRpcRegistry, "host.status"> | null;
  /** Freshness of the read above — retained cache data is not a live read. */
  readonly statusHealth: {
    readonly isError: boolean;
    readonly fetchStatus: "fetching" | "paused" | "idle";
    readonly isStale: boolean;
    readonly hasLiveSource: boolean;
  };
}): OverviewDisplay {
  const { scope, host, identity, status, statusHealth } = input;
  return {
    identity,
    displayName: identity?.effectiveName ?? host?.name ?? scope.hostLabel,
    persistedNameDraft: persistedDraftFromIdentity(identity),
    // The loopback URL and pid that used to ride alongside this are GONE, and
    // with them the local/remote fork in the meta line. They were the page's
    // one legitimate per-kind difference, and what they bought was a monospace
    // band nobody acts on from Settings; the session count is the half that
    // answers a question the buttons below actually depend on.
    //
    // Routed through `liveBusySessionCount` rather than read straight off the
    // response: a retained cache entry is not a live read, and this count is
    // what the chip states and the drain force is sized from.
    busySessionCount: liveBusySessionCount({
      reportedCount: status?.busySessionCount ?? null,
      isError: statusHealth.isError,
      fetchStatus: statusHealth.fetchStatus,
      isStale: statusHealth.isStale,
      hasLiveSource: statusHealth.hasLiveSource,
    }),
    hostVersion: status?.hostVersion ?? null,
    updateProgress: status?.updateProgress ?? null,
    settledBusySessionCount: settledBusySessionCount({
      reportedCount: status?.busySessionCount ?? null,
      isError: statusHealth.isError,
      fetchStatus: statusHealth.fetchStatus,
      isStale: statusHealth.isStale,
      hasLiveSource: statusHealth.hasLiveSource,
    }),
  };
}

/**
 * How this host is installed and everything about it a person opens a
 * disclosure to find: the install record, and Advanced.
 *
 * The two are one section because they answer one question — how this host is
 * set up — and neither is urgent enough to sit on the card above. Updates used
 * to own a titled section of its own next to this one, which read as two
 * subjects on a page that has exactly one.
 *
 * The install record is pure host RPC, so with no route that row renders
 * NOTHING rather than a gate notice. That is deliberate and was a bug once:
 * this page already states an unreachable host exactly once — the identity
 * card's health line says so, and the danger zone's gate explains which rows it
 * costs. A second gate here printed the same "can't reach this host" notice
 * twice on one page. An absent row under a card that already says why is
 * quieter and truer than repeating the reason.
 *
 * Advanced is NOT gated the same way, which is why `usable` reaches the row
 * rather than this whole component: the auto-update policy inside it is an
 * account write that needs no route, and an unreachable host is a common moment
 * to want exactly that. Returning `null` for the section as a unit is how that
 * control would go missing in the state it is most wanted.
 *
 * `unmanaged` IS a real state rather than an error: a host run from a checkout
 * has no install record, and reporting that as "nothing is installed" put a
 * false alarm on every developer's machine.
 */
function HostOverviewInstallationCard(props: {
  readonly usable: boolean;
  readonly hostName: string;
  readonly degrade: OverviewDegradeReason | null;
  readonly record: InstallationDetailsRecord | null;
  readonly loading: boolean;
  /** The read itself failed - which is NOT the same as "no record". */
  readonly readFailed: boolean;
  /** Advanced, built by the page so its state is shared with the card above. */
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

/**
 * Three outcomes, and the middle one is the finding: a FAILED read is not an
 * unmanaged host. Collapsing both to `record: null` made the card assert that
 * this host runs from a checkout or an unpacked tree - a fact the RPC never
 * established, stated to the user as if it had.
 */
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

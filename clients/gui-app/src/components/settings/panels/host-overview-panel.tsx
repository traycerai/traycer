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
  liveBusySessionCount,
  settledBusySessionCount,
} from "@/components/settings/panels/my-hosts-model";
import { persistedDraftFromIdentity } from "@/components/settings/panels/host-settings-panel-model";
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
import type { HostStatusUpdateProgress } from "@traycer/protocol/host/status/index";

// Matches the RPC Doctor card's own tail size, so a report read over the
// bridge shows the same amount of log as one read over `diagnostics.logs.tail`.
const DOCTOR_BRIDGE_LOG_TAIL_LINES = 200;

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

  // THE SCOPE'S OWN CLIENT, read directly rather than through the ambient
  // binding.
  //
  // This was `useHostBinding()?.hostClient`, and that was CORRECT — but only
  // because of something two files away. `HostSettingsPanel` wraps this
  // subtree in `<HostRuntimeContext.Provider value={scopedBinding}>` (`:148`),
  // so the binding read here was already the scoped host's. The wrapper is the
  // load-bearing part and it is not greppable from the words its old comment
  // used: searching `HostBindingProvider|HostRuntimeProvider` finds nothing,
  // because it is only ever spelled as the context's own `.Provider`. A
  // correct mechanism that reads as absent is one a future refactor removes
  // without noticing.
  //
  // Reading `scope.client` is behaviour-equivalent in both reachable arms —
  // under `ready` it is the same client the wrapper re-provides, and under
  // `following` `use-host-scope.ts:190` makes it the ambient one — and it
  // removes the dependency: this panel now addresses the host it names whether
  // or not anything above it re-provides. That matters because of what hangs
  // off this value. Eight reads, and three of them WRITE:
  // `host.identity.set` renames a machine, `host.restart` ends its sessions,
  // and the drain-gate force ends them without waiting. The rule they owe is
  // stated once, in `host-scope-status.ts`: "a visible host name must always
  // match the client used by every read, stream and mutation beneath it."
  //
  // `host-overview-scoped-client.test.tsx` is the guard, and it works by
  // forcing exactly the divergence the wrapper would otherwise hide.
  //
  // Still nullable, so the null-gating below is unchanged: `scope.client` is
  // null for `connecting`, `unreachable` and `vanished` — the states
  // `isHostScopeUsable` already refuses.
  const client = scope.client;
  // The ambient BINDING, still read here — but ONLY for `directory`, never
  // for a client. `#1253`'s local-restart flow needs THIS machine's own entry
  // (`:315`), and `useScopedHostBinding` overrides only `hostClient`, so
  // `binding.directory` stays ambient and `getLocalEntry()` keeps meaning this
  // machine rather than the scoped one. Deliberately NOT `binding.hostClient`:
  // that is precisely the read the line above replaced, and taking it back
  // would re-point every write below at whatever host happens to be bound.
  const binding = useHostBinding();
  // MOUNTING, not rendering. A query hook mounted under a non-ready scope still
  // fires against the ambient host and caches the answer under this page's key,
  // however well a gate hides the result.
  const usable = isHostScopeUsable(scope.status) && client !== null;
  // THIS machine's host, affirmatively down, with the bridge right here.
  // `unreachable` only — while `connecting` the route may still resolve. What
  // this state gets is NOT a Start verb: this machine's host is brought back
  // automatically whichever host the window is pointed at (the desktop's
  // launch reconciler and retrying boot actor, the selection authority's
  // ensure, the health monitor's crash respawn, the OS service manager), so a
  // button here was a second actor for the same process and read as "the app
  // forgot to start my host". It gets the bridge doctor, and — in the one
  // state the automation deliberately leaves alone, the user having removed
  // Traycer from this computer — the consent-reversing Reinstall.
  const localDown =
    scope.status === "unreachable" &&
    (host?.isLocalMachine ?? false) &&
    props.hasLocalBridge;

  const [doctorOpen, setDoctorOpen] = useState(false);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
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

  // The pre-rework recovery console offered Force restart when the host
  // denied the shutdown claim (OSS #1156 dropped the offer); this is that
  // offer's home on the one-page Overview. LOCAL machine with a bridge only,
  // by the nature of the transport rather than a scope rule: the bridge
  // respawn recycles THIS machine's host process, so surfacing it for a
  // remote host would kill the wrong process. The claim-gated `host.restart`
  // stays the default path for every host; force is the explicit consent to
  // end the sessions the claim protects.
  const management = useRunnerHostOrNull()?.hostManagement ?? null;
  // The host a force offer would be ABOUT, or `null` when this page has no
  // force route at all: the respawn goes over THIS machine's CLI bridge, so it
  // exists for the local host with a bridge attached and for nothing else. A
  // remote host has no transport that can kill its process.
  //
  // One value rather than a boolean gate beside an id, because the two must
  // never disagree - the id IS the reason the route exists, and reading them
  // apart is how an offer ends up pinned to a host the gate already refused.
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

  // The busy verdict, as the offer it is: `host.restart` refused, and force is
  // the explicit consent to end the sessions it refused to interrupt.
  //
  // It renders through `HostBusyForceDeferDialog` — the SAME second modal the
  // menu/tray restart flow shows for the same answer (`LocalHostRestartFlow`).
  // What it replaces was an inline amber band on the card whose Force button
  // dispatched the respawn on the first press, so the identical verdict was
  // strictly more destructive answered here than from the Help menu. One
  // verdict, one affordance, one force/defer decision.
  //
  // Held as the OFFER rather than a boolean so the count the dialog states is
  // the count the force is sized from - captured when the verdict lands, not
  // re-read from whatever the page shows when the button is pressed.
  //
  // `hostId` is the host that PRODUCED the verdict, and it is carried because
  // the respawn is not host-scoped: `restartHost()` kills whichever host this
  // machine has local at the moment it runs. An offer that outlived a local
  // host identity change would therefore state A's session count above a button
  // that kills B - whose claim was never asked and whose sessions were never
  // counted. Both guards below compare against it, exactly as
  // `LocalHostRestartFlow` does; an id nothing checked would be worse than no
  // id at all. `null` is "no offer open".
  const [forceRestartOffer, setForceRestartOffer] = useState<{
    readonly hostId: string;
    readonly hostName: string;
    readonly verdict: HostRestartBusyVerdict;
  } | null>(null);
  // No variables: the unified toast wording (`toastHostRestartRequested` /
  // `toastHostRestartDeclined`, host-restart-toast.ts) dropped the host name
  // from the message entirely - the surface the click came from already
  // names the host being restarted - so there is nothing left for the settle
  // callbacks to need carried past the mutation boundary.
  const forceRestart = useMutation<HostRestartRequestResult>({
    mutationKey: runnerMutationKeys.hostRestart(),
    mutationFn: () => {
      if (management === null) {
        return Promise.reject(new Error("No local host bridge is available."));
      }
      // The REFUSING respawn, for both of this page's callers — the busy-force
      // offer and the fallback confirm. `restartHost()` queues behind whatever
      // owns the desktop's exclusive mutation lane, which the tray and menu
      // keep deliberately — they are RECOVERY surfaces, reachable when this
      // page cannot render, so they must never learn to refuse — and which is
      // wrong for a restart someone is watching: an install or service cycle
      // running underneath would swallow the click and fire the kill
      // afterwards, against a host in a state they never saw. Force overrides
      // the HOST's veto — a live claim, busy work — never the desktop's own
      // serialization. The refusal comes
      // back as `declined`, which this mutation already renders as
      // information rather than an error.
      // The host this page is scoped to, not whatever is local by the time
      // main handles it: `forceRestartLocalHostId` is this machine's host as
      // this render saw it, and main refuses if that is no longer true.
      const expectedHostId = forceRestartLocalHostId;
      if (expectedHostId === null) {
        return Promise.reject(new Error("No local host bridge is available."));
      }
      return management.restartHostIfIdle({ expectedHostId });
    },
    onSuccess: (result) => {
      // The offer is answered either way — a `declined` respawn performed
      // nothing, but it did ANSWER, and the toast below carries what happened.
      // Leaving the dialog up would re-offer a decision already made. The
      // fallback confirm (a capability-`false` host's Restart dispatches the
      // respawn from the confirm dialog itself) closes for the same reason.
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
  // The Doctor sheet's log read for a host with no `diagnostics.*` family —
  // every released host below the maintenance floor, which is exactly the
  // population this fallback serves. Same file, read from this machine
  // instead of asked for over an RPC the host does not have, so the report's
  // Show logs button keeps working rather than becoming a refusal. Keyed on
  // the shared runner key so it dedupes with any other read of this log.
  const bridgeDoctorLogs = useMutation<readonly string[]>({
    mutationKey: runnerMutationKeys.hostDoctorBridgeLogs(),
    mutationFn: async () => {
      if (management === null) {
        throw new Error("No local host bridge is available.");
      }
      // Fenced on the SAME id the page's other bridge writes use. Without it
      // this read is the one place a replaced local host still gets rendered
      // under the old host's report — a log is host-scoped content, and the
      // fallback exists precisely for hosts too old to answer for themselves.
      // `null` means this page's host is not this machine, where a local log
      // has nothing to do with the report; refused rather than read, exactly
      // like `restartHostIfIdle`'s own null arm above.
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

  // CACHE-derived, not observer-derived, for the page-wide gate. The panel's
  // inner tree is keyed per scope, so switching hosts unmounts this
  // component and a remounted `useMutation` observer starts idle even while
  // the bridge respawn it armed is still in flight - `forceRestart.isPending`
  // would read false and reopen every lifecycle write the gate exists to
  // exclude. `useIsMutating` counts pending mutations in the shared cache
  // under this key, which survives any number of remounts.
  const forceRestartInFlight =
    useIsMutating({ mutationKey: runnerMutationKeys.hostRestart() }) > 0;
  // The live local host at the instant of a CLICK, not as of the last committed
  // render. A host identity change arrives as a store update, so a press
  // processed against the previous render would compare stale against stale and
  // sail through - the same reason the menu/tray flow re-reads here.
  // `getLocalEntry()` is synchronous and current.
  const liveLocalHostIdNow = (): string | null => {
    if (binding === null) return null;
    const entry = binding.directory.getLocalEntry();
    return entry === null ? null : entry.hostId;
  };

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
    // Unscoped on purpose: the forced bridge respawn replaces the LOCAL host
    // process, and no lifecycle write on this page should dispatch beside
    // that regardless of which host the page is currently scoped to.
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

  // Which write IS this dialog's own dispatch: the cooperative `host.restart`
  // ordinarily, the bridge respawn when the fallback routes Restart to the
  // force leg (`restartViaForceFallback`). The dialog's spinner, its stale-open
  // close below, and the header item's pending state must all read the same
  // answer, or a fallback confirm would close itself the moment it dispatched.
  // OBSERVER-derived on both legs, unlike the page-wide gate above: this
  // panel's `forceRestart.mutate` is the only dispatch that is OURS, while the
  // cache-wide `forceRestartInFlight` also counts a menu/tray respawn — which
  // must close this confirm like any competing write, not impersonate its
  // spinner and hand back an answerable dialog when the external settle lands.
  const restartDialogOwnDispatch = restartViaForceFallback
    ? forceRestart.isPending
    : restart.isPending;
  // The restart confirmation has the same stale-open window the OS-service
  // confirms do (`host-overview-advanced.tsx`): opened while idle, it stays
  // answerable while an automatic install or another lifecycle write arms the
  // page-wide gate under it. Close it for every arming EXCEPT its own
  // dispatch — this dialog deliberately stays open through its own dispatch
  // to show its spinner (and, on the cooperative leg, route the busy
  // verdict). Adjust-during-render so the close lands in the arming commit.
  if (restartConfirmOpen && anyPending && !restartDialogOwnDispatch) {
    setRestartConfirmOpen(false);
  }
  // The force offer has the same window and a sharper reason to close in it: no
  // lifecycle write on this page may dispatch beside a bridge respawn, and an
  // offer left answerable while one arms walks straight through that rule. Two
  // exclusions, both for writes that ARE this action rather than a competing
  // one — the `host.restart` whose busy answer OPENS the offer, and the respawn
  // the offer itself dispatched (which is what puts `forceRestartInFlight` into
  // `anyPending` to begin with).
  if (
    forceRestartOffer !== null &&
    anyPending &&
    !restart.isPending &&
    !forceRestartInFlight
  ) {
    setForceRestartOffer(null);
  }
  // The other way the offer goes stale: the host it describes stopped being the
  // one the respawn would hit. `forceRestartLocalHostId` goes null the moment
  // this page's host is no longer this machine's - which is exactly a local
  // host identity change under an open dialog - and non-null it can only be
  // this host's own id, since that is where it comes from. Drop the offer
  // rather than leave a kill button over a count that no longer describes its
  // target; `⋯ → Restart` re-asks the new host cooperatively.
  if (
    forceRestartOffer !== null &&
    forceRestartOffer.hostId !== forceRestartLocalHostId
  ) {
    setForceRestartOffer(null);
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

  // The two facts the window modal's own update gate reduces to, asked once
  // here rather than inside the JSX. Force-provisioning is the BUNDLED host's
  // lifecycle on this computer: `hostManagement` is the bridge that can run it,
  // and `isLocalMachine` is whether this row is the machine it would run
  // against. Either one false means there is no update this app can perform,
  // and the row falls back to naming the problem without offering a control
  // that cannot reach it.
  const canManageHost = host.isLocalMachine && management !== null;

  // The header cluster, withheld entirely when there is no route rather than
  // rendered and disabled. Every one of its verbs needs a live host to answer,
  // so on an unreachable host they would be dead controls under a card that
  // already says the host cannot be reached — and "disabled" would wrongly
  // imply a capability verdict rather than a connectivity one. What survives
  // an outage is the account-backed half below: the update policy, which
  // needs no route at all. The ONE exception is this computer's own down
  // host, whose doctor (and, after a removal, Reinstall) run over the CLI
  // bridge and need no route by construction.
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
        // Only offered when there is an override to clear. A host running
        // under its own default name has nothing to reset, and the write
        // would be the no-op `submitRename` already guards.
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
              // NOT `isError`, which goes false the instant the retry starts.
              // TanStack's `fetchState` clears `error` and returns `status` to
              // `pending` whenever a fetch begins with no data behind it, so an
              // `isError` gate unmounts the arm on the click that starts the
              // read — taking the spinner inside it with it, and flickering the
              // disabled pencil in for the duration of the very retry the
              // person just pressed. `errorUpdateCount` is the settle counter
              // the reducer never resets, so `no identity && it has settled in
              // error at least once` says exactly what this prop means: the
              // last settled read failed and there is still no name to edit.
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
        {view.updateProgress === null ? null : (
          <HostOverviewUpdateProgress
            state={view.updateProgress.state}
            error={view.updateProgress.error}
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
        isPending={restartDialogOwnDispatch}
        onConfirm={() => {
          // A host whose handshake refused `host.restart` has no cooperative
          // leg to dispatch — the only restart this page can perform is the
          // bridge respawn, and this dialog's copy already states the force
          // consequences (sessions end, in-flight requests cancel). So on the
          // fallback route the confirm IS the force consent: same click-time
          // identity guard and same shared mutation key as the busy-offer
          // dialog's Force, so menu/tray/Settings respawns keep deduping.
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
                  //
                  // Where a force route exists, the verdict IS the offer, and
                  // it opens the force/defer dialog below. Where none does —
                  // a remote host, or this machine with no CLI bridge — there
                  // is no second choice to put in a modal, so it is REPORTED:
                  // `toastHostRestartDeclined` is the same "deliberately not
                  // restarted, this clears on its own" register the declined
                  // respawn uses, deliberately not an error toast.
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
                // Deliberately NOT cleared: a transport failure says nothing
                // about whether the host granted the claim, so the id stays
                // armed for the retry that adopts it.
                toastFromHostError(error, "Couldn't restart this host.");
              },
            },
          );
        }}
      />
      {/* The busy verdict's whole affordance, and the SAME dialog the menu/tray
          restart flow shows for the same answer: Defer or Force restart, with
          the session count stated where the decision is made. Deferring ends
          the action exactly as it does there — Restart is one menu item away,
          and re-asking a host that may have drained since is the honest retry.
          The amber band with an inline one-press Force that used to sit on the
          card is gone; see `host-overview-status-card.tsx`. */}
      <HostBusyForceDeferDialog
        open={forceRestartOffer !== null}
        message={
          forceRestartOffer === null
            ? ""
            : busyRestartMessage(forceRestartOffer.verdict, true)
        }
        // CACHE-derived, matching what the menu/tray flow passes here
        // (`forceRestart.isPending || respawnInFlight`), and for its reason
        // rather than the page gate's: menu, tray and Settings all submit
        // respawns under ONE mutation key against ONE bridge lane, and each
        // surface's own observer sees only its own dispatches. So this goes
        // inert for ANY respawn in flight, not just the one pressed here —
        // deliberately, so a second respawn cannot be stacked on the first.
        isForcing={forceRestartInFlight}
        forceLabel="Force restart"
        onForce={() => {
          if (forceRestartOffer === null) return;
          // Refuse on a POSITIVE mismatch only. `null` here is "cannot tell"
          // (no binding, or the local entry went away because the host is
          // down) - not evidence of a swap, and the state where a respawn is
          // most legitimate - so it falls through to the dispatch exactly as
          // the menu/tray flow does.
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
          // The bridge branch's one production caller: a stopped local host
          // cannot shell its own CLI over an RPC it cannot answer, and the
          // report this machine's bridge produces IS about the machine the
          // page names — the misattribution the rpc-only rule guards against
          // cannot happen when the subject is this computer.
          localDown
            ? {
                kind: "bridge",
                // Non-null in this branch by construction, and the `??` is
                // unreachable: `localDown` requires `hasLocalBridge`, which the
                // parent defines as `management !== null && isLocalMachine` —
                // every conjunct `forceRestartLocalHostId` needs. Not a
                // fail-closed default: an empty id is ALLOWED against a host
                // with no identity machinery (the `unenrolled` arm), so this
                // rests on the proof above, not on the fallback.
                expectedHostId: forceRestartLocalHostId ?? "",
              }
            : {
                kind: "rpc",
                client,
                hostName: displayName,
                isLocalMachine: host.isLocalMachine,
                hasLocalBridge: props.hasLocalBridge,
                degrade: doctorDegrade,
                // The capability itself, NOT `!restartViaForceFallback`: a
                // remote host can refuse `host.restart` too, where no force
                // route exists and the inverse would misread as "the RPC
                // works" — putting a live Restart button on the one host it
                // cannot restart.
                rpcRestartSupported: restartSupported,
                // The same derived fact the confirm dialog's dispatch leg
                // branches on, threaded rather than re-derived from
                // `isLocalMachine && hasLocalBridge` inside the card: the two
                // readings could tear (the force route also needs a runner
                // bridge), and a torn pair routes a Doctor restart to a
                // confirm whose dispatch leg then sends the refused RPC.
                bridgeRestartRoute: restartViaForceFallback,
                // OPENS THE SAME CONFIRM the header's Restart uses rather
                // than dispatching — the bridge respawn always forces, ending
                // sessions and cancelling in-flight requests, and the header
                // puts that consent behind `RestartHostConfirmDialog`. On the
                // fallback route the dialog's confirm IS the force consent:
                // same click-time identity guard, same page-wide lifecycle
                // gate, same cross-surface mutation key. A one-click Doctor
                // dispatch here was the one surface skipping all three.
                onBridgeRestart: () => {
                  if (anyPending) return;
                  setRestartConfirmOpen(true);
                },
                bridgeRestartPending: forceRestartInFlight || anyPending,
                // `diagnostics.logs.tail` is absent from every released host
                // below the maintenance floor (verified against the
                // `host-v1.1.11` protocol-surface asset: no `diagnostics.*`
                // at all), and this fallback is what puts a Doctor report —
                // and its Show logs button — in front of those hosts.
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

/**
 * The "Update host" remedy, mounted beside the health word that names the
 * problem (rider 1: Settings renders `dead(incompatible)` with its affordance).
 *
 * GATED ON BOTH the rendered health state and the lease, and the conjunction is
 * the point rather than belt-and-braces. `health.state` respects the derivation
 * precedence — this machine's own stopped service outranks the authority's
 * verdict — so a local host that is BOTH incompatible and not running reads
 * "Stopped", and offering "Update host" beside that word would answer a
 * question the card is not asking. The lease is then what carries the
 * structured skew the action needs, which `health` deliberately does not.
 *
 * The lane is `convergeReady({ force: true })` — the SAME mutation and the same
 * `runnerMutationKeys.hostConvergeReady()` key the window modal's "Update host"
 * drives through `forceProvisioning`, and the same one `LocalHostDownActions`
 * below drives (with `force: false`) for a Reinstall. So a click here is
 * narrated by the existing
 * actor-agnostic progress lane ("Applying the host update…") with no second
 * observer and no new key; nothing about this surface needed a mechanism of its
 * own, which is why it does not have one.
 */
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

/**
 * The header cluster for this computer's host when it is affirmatively DOWN.
 *
 * NO START VERB, by decision (2026-08-19). The local host's lifecycle is
 * automatic and independent of which host a window is pointed at: launch
 * converge and the retrying boot actor (main), the selection authority's
 * ensure, the health monitor's crash respawn, and the OS service manager
 * between them bring this machine's host back. A Start button here was a
 * second process actor for the same host and read as "the app forgot to start
 * my host" - which is exactly how it was reported. Two things remain, both
 * bridge-backed and so both honest without a route:
 *
 *  - REINSTALL, only when the user removed Traycer from this computer. That is
 *    the one down state the automation deliberately leaves alone (consent),
 *    and the danger-zone dialog promises "you can reinstall anytime from
 *    Settings" - this is where. It clears the removal sentinel and converges;
 *    `convergeReady` under the sentinel short-circuits `ok {running:false}`
 *    without installing, which is why the old Start button was a silent no-op
 *    in precisely this state (`useRunnerReinstallTraycer` does both steps).
 *  - the bridge doctor, which diagnoses without a route. Disabled while this
 *    machine's lifecycle lane is busy (`settingUp`, actor-agnostic): a CLI
 *    inspecting an installation the converge is mid-rewrite reports (and
 *    offers to fix) states that are simply "not done yet".
 *
 * Success needs no explicit refresh here: the host coming up flips the scope
 * status through its ordinary reactivity and the live cluster replaces this
 * one.
 */
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
  // The verb SURVIVES ITS OWN FAILURE. `reinstall` clears the removal
  // sentinel first and converges second, so a converge that comes back
  // `failed`/`deferred` leaves the sentinel already cleared - `removed` flips
  // to false, and this cluster would drop the only affordance for a machine
  // that still has no host. Nothing else picks it up in this session either:
  // main's boot actor settled at launch on the sentinel it saw then. Keeping
  // the button on `isError` makes the retry the user's to take now; the next
  // launch sees a cleared sentinel and boots on the ladder without them.
  //
  // `isPending` is in here for the RETRY, and its absence was a real hole: a
  // second click flips the mutation error -> pending, so with the sentinel
  // already cleared BOTH other terms go false and the button unmounted for
  // the length of the attempt - taking its own spinner with it. The first
  // attempt never showed that, because `removed` is still true until the
  // sentinel refetch lands, which is why it needs its own test.
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
  /**
   * `host.restart` came back handshake-`false` and this page has a force
   * route: Restart stays live but the confirm dispatches the bridge respawn —
   * there is no cooperative leg to send. Reads the same two inputs as
   * `restart` above, so the button and its routing cannot tear.
   */
  readonly restartViaForceFallback: boolean;
  /**
   * Whether `host.restart` itself is servable — the capability alone, apart
   * from any fallback route. The Doctor sheet needs this fact and not its
   * routing consequence: a REMOTE host can refuse `host.restart` too, where
   * no force route exists and `!restartViaForceFallback` would misread as
   * "the RPC works". Same tri-state treatment as `logsSupported` below.
   */
  readonly restartSupported: boolean;
  /**
   * Whether `diagnostics.logs.tail` is servable. `false` only for a host below
   * the maintenance floor, whose Doctor sheet this fallback enables — its log
   * read has to go over the bridge or the Show logs button cannot work.
   */
  readonly logsSupported: boolean;
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

/**
 * What can stand in for a method the handshake refused, threaded from the
 * page rather than re-derived here so enablement and routing read the same
 * facts the client construction read.
 */
interface OverviewFallbackRoutes {
  /**
   * `scope.localMaintenanceFallback`: the scope's client is the decorator
   * that serves the pinned four maintenance methods over the desktop CLI
   * lane (`lib/host/local-maintenance-fallback-client.ts`).
   */
  readonly maintenanceFallback: boolean;
  /** A bridge respawn exists to stand in for a refused `host.restart`. */
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
    // SEPARATE from the read. `host.identity.get` and `host.identity.set` are
    // independent registry capabilities, so a peer can advertise one without
    // the other - and inferring write support from a readable identity opened
    // Edit name against a host whose handshake said it cannot save, turning
    // Save into an RPC the negotiation already ruled out.
    //
    // DELIBERATELY NOT fallback-served. A ≤1.1.11 host never reads
    // `host-name.json`, so a bridge-written rename would split this page's
    // name from the registry `displayName` every other surface shows for as
    // long as the host stays old. A degraded pencil is honest; identity
    // split-brain is not.
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
    // The service trio is DELIBERATELY outside the fallback: no IPC member
    // carries service state, `label`, or `manifestPath` (required in the ok
    // arm), and the old bridge derivation lacked `externally-managed` — the
    // NORMAL state on a Desktop-managed macOS. They keep today's unsupported
    // notice until the host updates.
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

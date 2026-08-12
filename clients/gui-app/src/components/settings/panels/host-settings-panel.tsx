import { useState, type ReactNode } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { RestartHostConfirmDialog } from "@/components/host/restart-host-confirm-dialog";
import { HostBusyForceDeferDialog } from "@/components/host/host-busy-force-defer-dialog";
import { AdvancedDisclosure } from "@/components/settings/panels/host-settings-advanced-disclosure";
import { DoctorSheet } from "@/components/settings/panels/host-settings-doctor-sheet";
import {
  useLocalHostSnapshot,
  useNowMs,
} from "@/components/settings/panels/host-settings-panel-hooks";
import {
  customNameFromDraft,
  deriveStatus,
  extractErrorMessage,
  findReleasedAt,
} from "@/components/settings/panels/host-settings-panel-model";
import {
  HostIdentityCard,
  HostIdRow,
  ThisWindowCard,
  ThisWindowCardStandalone,
} from "@/components/settings/host-scope/host-identity-card";
import {
  HostDangerZone,
  LocalRecoveryDangerZone,
} from "@/components/settings/host-scope/host-danger-zone";
import {
  HostScopeConnecting,
  HostScopeGate,
} from "@/components/settings/host-scope/host-scope-gate";
import { HostRegistryUpdates } from "@/components/settings/host-scope/host-registry-updates";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { HostSummaryCard } from "@/components/settings/panels/host-settings-summary-card";
import { HostUpdateRegion } from "@/components/settings/panels/host-settings-update-region";
import { InstallationDetailsDisclosure } from "@/components/settings/panels/host-settings-installation-details";
import { PackageManagerUpgradeHint } from "@/components/settings/panels/host-settings-package-manager-upgrade-hint";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { cn } from "@/lib/utils";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { toastHostRestartDeclined } from "@/lib/host-restart-toast";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useRunnerHostControllerStatusQuery } from "@/hooks/runner/use-runner-host-controller-status-query";
import { useRunnerConvergeReady } from "@/hooks/runner/use-runner-converge-ready-mutation";
import { useRunnerApplyStaged } from "@/hooks/runner/use-runner-apply-staged-mutation";
import { useRunnerActivateInstalled } from "@/hooks/runner/use-runner-activate-installed-mutation";
import { useRunnerInstallVersion } from "@/hooks/runner/use-runner-install-version-mutation";
import { useHostUpdateBannerStore } from "@/stores/settings/host-update-banner-store";
import type {
  ApplyStagedOk,
  BusyContinuation,
  CliInstallManifestSnapshot,
  HostAvailableSnapshot,
  HostInstalledRecord,
  HostNameSettings,
  HostRegistryUpdateState,
  IHostManagement,
  InstallVersionOk,
  IRunnerHost,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";

type SettingsUpdateIntent = "apply" | "installVersion";

interface SettingsBusyState {
  readonly intent: SettingsUpdateIntent;
  readonly continuation: BusyContinuation;
  readonly message: string;
  // The pin being installed, when `intent === "installVersion"` - needed so
  // a `"retry-with-force"` Force click re-submits `installVersion{pin, force}`
  // rather than losing which version was being pinned.
  readonly pin: string | null;
}

interface SettingsTerminalOutcomeState {
  readonly intent: SettingsUpdateIntent;
  readonly message: string;
  readonly pin: string | null;
}

export function HostSettingsPanel() {
  const runnerHost = useRunnerHost();
  const scope = useHostScope();
  const management = runnerHost.hostManagement;
  // Keyed by scoped host, both variants: every piece of page state below — an
  // open restart confirmation, a busy-force prompt, a half-typed rename —
  // belongs to ONE host. `HostRegistryUpdates` already buys this per-row;
  // without it here, a scope switch while a confirmation was open left the
  // dialog mounted and armed at the local bridge under another host's page.
  const scopeKey = scope.hostId ?? "unresolved";
  if (management === null) {
    return <HostSettingsPanelWithoutManagement key={scopeKey} />;
  }
  return (
    <HostSettingsPanelInner
      key={scopeKey}
      management={management}
      runnerHost={runnerHost}
    />
  );
}

/**
 * Shells without the Traycer CLI (web, mobile) can still ADMINISTER a host
 * over its RPC — they simply cannot install, restart or register a local
 * service, because there is no local service here. So the page keeps the
 * scoped host's identity and says exactly which capability is missing instead
 * of degrading to a bare sentence.
 */
function HostSettingsPanelWithoutManagement() {
  const scope = useHostScope();
  const registryItem = scope.host?.item ?? null;
  return (
    <SettingsPanelShell
      title="Overview"
      description={
        scope.host === null
          ? "Status and maintenance for the selected host."
          : `Status and maintenance for ${scope.host.name}.`
      }
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      {scope.host === null || scope.status === "vanished" ? (
        // Nothing resolved to administer, so the gate owns the whole panel and
        // says which of the two reasons it is.
        <HostScopeGate
          scope={scope}
          skeleton={<HostScopeConnecting hostName={scope.hostLabel} />}
        >
          {null}
        </HostScopeGate>
      ) : (
        <div className="flex flex-col gap-5">
          <HostIdentityCard host={scope.host} onRename={null} renameDisabled>
            <ThisWindowCard scope={scope} host={scope.host} />
          </HostIdentityCard>
          <p className="px-1 text-ui-sm text-muted-foreground">
            Installing and restarting a local host service is only available in
            the desktop app — this shell doesn&apos;t bundle the Traycer CLI.
          </p>
          {/* Update policy is an ACCOUNT-level write — `PATCH /api/v3/hosts/:id`
              through AuthService — applied by the host on its next check-in. It
              needs neither the CLI bridge this shell lacks nor a live route to
              the machine. `MyHostsList` exposed auto-update, a version pin and
              force here; deleting it without re-homing these controls removed
              update management from web and mobile entirely, for a machine the
              account fully owns. */}
          {registryItem === null ? null : (
            <SettingsGroup
              title="Updates"
              tone="default"
              dataTestId="host-updates"
              fill={false}
            >
              <div className="[&>*:first-child]:border-t-0">
                <HostRegistryUpdates
                  key={registryItem.hostId}
                  item={registryItem}
                  isLocalHost={scope.host.isLocalMachine}
                />
              </div>
            </SettingsGroup>
          )}
          {/* Not gated from out here. The two rows inside sit on different
              capability planes — clearing snapshots is host RPC, removing
              Traycer is the local CLI bridge — so the region gates its own
              rows and renders nothing when it has neither. In this shell there
              is no CLI bridge at all, so only the snapshots row can appear. */}
          <HostDangerZone scope={scope} />
        </div>
      )}
    </SettingsPanelShell>
  );
}

interface HostSettingsPanelInnerProps {
  readonly management: IHostManagement;
  readonly runnerHost: IRunnerHost;
}

// Panel aggregates many independent settings sections / async states; the
// branch count reflects surfaced concerns, not reducible nesting.
// eslint-disable-next-line complexity
function HostSettingsPanelInner(props: HostSettingsPanelInnerProps) {
  const { management, runnerHost } = props;
  const queryClient = useQueryClient();
  const compact = useSettingsDensity() === "compact";
  const scope = useHostScope();
  const nowMs = useNowMs();
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [hostNameDraftOverride, setHostNameDraftOverride] = useState<
    string | null
  >(null);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState<boolean>(false);
  const [includePreReleases, setIncludePreReleases] = useState(false);
  const [busy, setBusy] = useState<SettingsBusyState | null>(null);
  const [terminalOutcome, setTerminalOutcome] =
    useState<SettingsTerminalOutcomeState | null>(null);
  const localHost = useLocalHostSnapshot(runnerHost);
  const hostIdCopy = useClipboardCopy({
    resetMs: 1600,
    onSuccess: () => toast.success("Host ID copied"),
    onError: () => toast.error("Couldn't copy the host ID"),
  });

  // The scoped host is the SUBJECT of this page. The local service console
  // below renders only when that subject is the host running on this computer
  // — a remote host has no local service to install, restart or register, and
  // pretending otherwise is what produced two cards describing one host in two
  // dialects.
  // `?? false`, never `?? true`. A null host means the scope resolved to
  // NOTHING — vanished, unreachable, or still loading — and defaulting that to
  // "yes, this is your machine" put this computer's install / restart /
  // deregister-service console on screen under a host that no longer exists.
  // The gate below withholds the body in those states; this is the second
  // line, so a future caller that forgets the gate fails closed.
  // Declared before the queries because it also gates the five local-bridge
  // queries: their results render only in the local branch, so a remote scope
  // was paying five CLI-bridge calls per visit for data nothing displayed.
  const scopedIsLocalMachine = scope.host?.isLocalMachine ?? false;

  // The fresh-install carve-out. On a first run there is no local host id
  // yet, so the union has no local row at all: the scope resolves to NOTHING
  // and the honest-state rule above would leave only an empty notice — while
  // the CLI bridge sits right here reporting `not-installed`, which is the
  // one state the install console exists for. An EMPTY account (both lists
  // answered, nothing failed, no vanished pick) is exactly when this
  // computer's console is recovery rather than misattribution: there is no
  // other host the controls could be mistaken for.
  const emptyAccountLocalRecovery =
    scope.host === null &&
    scope.vanishedHostId === null &&
    scope.hosts.length === 0 &&
    !scope.isLoading &&
    !scope.listsFailed;
  const showLocalConsole = scopedIsLocalMachine || emptyAccountLocalRecovery;

  // Canonical two-lane `HostControllerStatus` (Host Update Layer Redesign
  // Tech Plan), shared with the landing-page banner, the tray/menu, and any
  // other open window via the same query key. The mutation lane drives the
  // progress banner and the disable-gating below regardless of which surface
  // (or the background auto-update reconciler) actually started the
  // operation; the download lane is purely informational here and never
  // disables anything (Renderer surfaces cutover ticket).
  const statusQuery = useRunnerHostControllerStatusQuery();
  const controllerStatus = statusQuery.data;
  const mutationLane = controllerStatus?.mutation ?? null;
  const sharedMutationActive = mutationLane !== null;
  const progress = mutationLane;

  const {
    data: availableSnapshot,
    error: availableError,
    isFetching: availableFetching,
    isPending: availablePending,
  } = useQuery(
    queryOptions<HostAvailableSnapshot>({
      queryKey: runnerQueryKeys.hostAvailableVersions(
        management,
        includePreReleases,
      ),
      queryFn: () => management.availableVersions({ includePreReleases }),
      staleTime: 5 * 60 * 1000,
      enabled: showLocalConsole,
    }),
  );

  const { data: registryState, isFetching: registryFetching } = useQuery(
    queryOptions<HostRegistryUpdateState>({
      queryKey: runnerQueryKeys.hostRegistryUpdate(management),
      queryFn: () => management.registryCheck({ force: false }),
      staleTime: 60 * 60 * 1000,
      enabled: showLocalConsole,
    }),
  );

  const { data: installedRecord, isPending: installedPending } = useQuery(
    queryOptions<HostInstalledRecord | null>({
      queryKey: runnerQueryKeys.hostInstalledRecord(management),
      queryFn: () => management.installedRecord(),
      staleTime: 30_000,
      enabled: showLocalConsole,
    }),
  );

  const { data: cliManifest } = useQuery(
    queryOptions<CliInstallManifestSnapshot | null>({
      queryKey: runnerQueryKeys.hostCliManifest(management),
      queryFn: () => management.cliManifest(),
      staleTime: 5 * 60 * 1000,
      enabled: showLocalConsole,
    }),
  );

  const {
    data: hostNameSettings,
    isPending: hostNamePending,
    isError: hostNameError,
  } = useQuery(
    queryOptions<HostNameSettings>({
      queryKey: runnerQueryKeys.hostName(management),
      queryFn: () => management.getHostName(),
      staleTime: 30_000,
      enabled: showLocalConsole,
    }),
  );

  const persistedHostNameDraft =
    hostNameSettings === undefined
      ? ""
      : (hostNameSettings.customName ?? hostNameSettings.systemName);
  const hostNameDraft = hostNameDraftOverride ?? persistedHostNameDraft;

  const invalidate = (): void => {
    void queryClient.invalidateQueries({
      queryKey: runnerQueryKeys.hostAvailableVersionsScope(management),
    });
    void queryClient.invalidateQueries({
      queryKey: runnerQueryKeys.hostRegistryUpdate(management),
    });
    void queryClient.invalidateQueries({
      queryKey: runnerQueryKeys.hostInstalledRecord(management),
    });
  };

  // Bootstrap "Install host" (shown only when `status === "not-installed"`).
  // Busy is structurally unreachable here (nothing can hold the mutation
  // lane on a host that was never installed), so this reuses the gate's
  // throw-on-non-ok convergeReady hook rather than the Force/Defer flow.
  const convergeReadyMutation = useRunnerConvergeReady();

  const applyStagedMutation = useRunnerApplyStaged();
  const activateInstalledMutation = useRunnerActivateInstalled();
  const installVersionMutation = useRunnerInstallVersion();

  const handleApplyOutcome = (
    outcome: MutationOutcome<ApplyStagedOk>,
  ): void => {
    if (outcome.kind === "ok") {
      toast.success(`Updated host to v${outcome.value.appliedVersion}`);
      useHostUpdateBannerStore
        .getState()
        .clearSnooze(outcome.value.appliedVersion);
      setBusy(null);
      setTerminalOutcome(null);
      invalidate();
      return;
    }
    if (outcome.kind === "busy") {
      setBusy({
        intent: "apply",
        continuation: outcome.continuation,
        message: outcome.message,
        pin: null,
      });
      return;
    }
    setBusy(null);
    setTerminalOutcome({
      intent: "apply",
      message: outcome.message,
      pin: null,
    });
  };

  const handleInstallVersionOutcome = (
    outcome: MutationOutcome<InstallVersionOk>,
    pin: string,
  ): void => {
    if (outcome.kind === "ok") {
      toast.success(`Installed host v${outcome.value.installedVersion}`);
      useHostUpdateBannerStore
        .getState()
        .clearSnooze(outcome.value.installedVersion);
      setBusy(null);
      setTerminalOutcome(null);
      invalidate();
      return;
    }
    if (outcome.kind === "busy") {
      setBusy({
        intent: "installVersion",
        continuation: outcome.continuation,
        message: outcome.message,
        pin,
      });
      return;
    }
    setBusy(null);
    setTerminalOutcome({
      intent: "installVersion",
      message: outcome.message,
      pin,
    });
  };

  const runApply = (force: boolean): void => {
    applyStagedMutation.mutate(
      { trigger: "manual", force },
      { onSuccess: handleApplyOutcome },
    );
  };

  const runInstallVersion = (pin: string, force: boolean): void => {
    installVersionMutation.mutate(
      { pin, force },
      { onSuccess: (outcome) => handleInstallVersionOutcome(outcome, pin) },
    );
  };

  // Force continuation after a post-commit busy outcome (packaged macOS):
  // activates the already-committed install rather than re-running the
  // consumed apply/pin.
  const runForceActivate = (): void => {
    if (busy === null) return;
    const { intent, pin } = busy;
    activateInstalledMutation.mutate(
      { force: true },
      {
        onSuccess: (outcome) => {
          if (outcome.kind === "ok") {
            toast.success("Host activated");
            setBusy(null);
            setTerminalOutcome(null);
            invalidate();
            return;
          }
          if (outcome.kind === "busy") {
            setBusy({
              intent,
              continuation: outcome.continuation,
              message: outcome.message,
              pin,
            });
            return;
          }
          setBusy(null);
          setTerminalOutcome({ intent, message: outcome.message, pin });
        },
      },
    );
  };

  const restartMutation = useMutation({
    mutationKey: runnerMutationKeys.hostRestart(),
    mutationFn: () => management.restartHost(),
    onSuccess: (result) => {
      setRestartConfirmOpen(false);
      // `declined` resolves (rather than rejecting) because it is not an
      // error - the host deliberately was not restarted and a later retry
      // succeeds on its own; see `toastHostRestartDeclined`.
      if (result.kind === "declined") {
        toastHostRestartDeclined(result.message);
        return;
      }
      toast.success("Host restart requested");
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostInstalledRecord(management),
      });
      invalidate();
    },
    onError: (err) => {
      setRestartConfirmOpen(false);
      toastFromRunnerError(err, "Couldn't restart host");
    },
  });

  const registerServiceMutation = useMutation({
    mutationKey: runnerMutationKeys.hostRegisterService(),
    mutationFn: async () => {
      const outcome = await management.registerService();
      if (outcome.kind !== "ok") {
        throw new Error(outcome.message);
      }
      return outcome.value;
    },
    onSuccess: () => {
      toast.success("Service registered");
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostInstalledRecord(management),
      });
      invalidate();
    },
    onError: (err) => {
      toastFromRunnerError(err, "Couldn't register service");
    },
  });

  const deregisterServiceMutation = useMutation({
    mutationKey: runnerMutationKeys.hostDeregisterService(),
    mutationFn: () => management.deregisterService(),
    onSuccess: () => {
      toast.success("Service deregistered");
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostInstalledRecord(management),
      });
      invalidate();
    },
    onError: (err) => toastFromRunnerError(err, "Couldn't deregister service"),
  });

  const refreshRegistryMutation = useMutation({
    mutationKey: runnerMutationKeys.hostRegistryCheck(),
    mutationFn: () => management.registryCheck({ force: true }),
    onSuccess: (data) => {
      queryClient.setQueryData(
        runnerQueryKeys.hostRegistryUpdate(management),
        data,
      );
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostAvailableVersionsScope(management),
      });
    },
    onError: (err) =>
      toastFromRunnerError(err, "Couldn't refresh the update check"),
  });

  const hostNameMutation = useMutation({
    mutationKey: runnerMutationKeys.hostNameSet(),
    mutationFn: (customName: string | null) =>
      management.setHostName({ customName }),
    onSuccess: (data) => {
      queryClient.setQueryData(runnerQueryKeys.hostName(management), data);
      setHostNameDraftOverride(null);
      setEditingName(false);
      toast.success("Host name updated");
    },
    onError: (err) => toastFromRunnerError(err, "Couldn't update host name"),
  });

  // Disables off the mutation lane only - a background download (the
  // download lane) must never disable unrelated actions here (Renderer
  // surfaces cutover ticket).
  const anyPending =
    convergeReadyMutation.isPending ||
    applyStagedMutation.isPending ||
    activateInstalledMutation.isPending ||
    installVersionMutation.isPending ||
    restartMutation.isPending ||
    registerServiceMutation.isPending ||
    deregisterServiceMutation.isPending ||
    // A mutation started from another surface (the landing-page banner, a
    // second window, the tray/menu, or the background auto-update
    // reconciler) - none of this panel's own mutations are pending, but the
    // mutation lane is still held, so every trigger here must stay disabled
    // too.
    sharedMutationActive;
  const installPending =
    convergeReadyMutation.isPending || mutationLane?.kind === "ensure";
  const updatePending =
    applyStagedMutation.isPending || mutationLane?.kind === "apply";
  const registerPending =
    registerServiceMutation.isPending || mutationLane?.kind === "register";

  const status = deriveStatus(localHost, installedRecord);
  const statusPending = status === undefined;
  const latestReleasedAt = findReleasedAt(
    availableSnapshot,
    registryState?.latestVersion ?? null,
  );
  const packageManagerUpgrade = cliManifest?.packageManagerUpgrade ?? null;

  const handleRefreshRegistry = (): void => {
    refreshRegistryMutation.mutate();
  };

  const handleRetryTerminalOutcome = (): void => {
    if (terminalOutcome === null) return;
    const { intent, pin } = terminalOutcome;
    setTerminalOutcome(null);
    if (intent === "apply") {
      runApply(false);
    } else if (pin !== null) {
      runInstallVersion(pin, false);
    }
  };

  // ONE Updates card, holding both halves of a host's update story.
  //
  // They are genuinely two mechanisms — the local controller stages and
  // applies a build on this computer, while the account registry carries the
  // policy and target version any host reads on its next check-in — and they
  // used to live on two different pages because of it. A person does not have
  // two update questions, so the mechanisms sit in one card and the copy
  // distinguishes them.
  const registryItem = scope.host?.item ?? null;
  let dangerZone: ReactNode = null;
  if (scope.host !== null) {
    dangerZone = <HostDangerZone scope={scope} />;
  } else if (showLocalConsole && (installedRecord ?? null) !== null) {
    dangerZone = <LocalRecoveryDangerZone />;
  }

  const localUpdateRegion =
    scopedIsLocalMachine && status?.state !== "not-installed" ? (
      <HostUpdateRegion
        registryState={registryState}
        registryFetching={registryFetching || refreshRegistryMutation.isPending}
        anyPending={anyPending}
        updatePending={updatePending}
        latestReleasedAt={latestReleasedAt}
        nowMs={nowMs}
        updateReady={controllerStatus?.updateReady ?? false}
        stagedVersion={controllerStatus?.stagedVersion ?? null}
        downloadProgress={controllerStatus?.download?.progress ?? null}
        onUpdate={() => runApply(false)}
        onRefresh={handleRefreshRegistry}
      />
    ) : null;
  const updatesCard =
    localUpdateRegion === null && registryItem === null ? null : (
      <SettingsGroup
        title="Updates"
        tone="default"
        dataTestId="host-updates"
        fill={false}
      >
        {/* Every row brings its own top rule as a separator; the first one
            would otherwise double up with the card's own border. */}
        <div className="[&>*:first-child]:border-t-0">
          {localUpdateRegion}
          {registryItem === null ? null : (
            // Keyed by host: every piece of state inside — an open drain-gate
            // confirmation, a half-typed version pin — belongs to ONE host, so
            // changing hosts must destroy it rather than re-point it. The
            // controls also capture their target at arm time; this is the
            // structural half of the same guarantee.
            <HostRegistryUpdates
              key={registryItem.hostId}
              item={registryItem}
              isLocalHost={scopedIsLocalMachine}
            />
          )}
        </div>
      </SettingsGroup>
    );

  return (
    <SettingsPanelShell
      title="Overview"
      // The card below names the host, in bigger type, next to its status and
      // its Rename control. Repeating it as the page title printed the same
      // string twice, two lines apart, and made the header look like a bug.
      description={
        scope.host === null
          ? "Status, updates and maintenance for the selected host."
          : `Status, updates and maintenance for ${scope.host.name}.`
      }
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      {/* Overview owes the same contract as the rest of its group — say NOTHING
          about a host the scope cannot resolve, which is how a vanished remote
          host once ended up showing this computer's service console — but it
          cannot buy that with the whole-panel gate the others use, because most
          of what it renders never touches the scoped host's RPC:

            - the local service console runs over the CLI bridge
              (`IHostManagement`), and it is the RECOVERY surface. Gating it on
              dialability took Install / Start / Restart away in precisely the
              state they exist for: a local host that is stopped while this
              window is active on some other machine. The page offered "Can't
              reach this computer" and no way to fix it.
            - the Updates card writes update policy through the account API,
              which a host applies on its next check-in. It needs no route.

          So the gate now wraps the one region that IS host RPC. What replaces
          it above is the weaker, correct question — did the scope settle on a
          host at all — and `scopedIsLocalMachine` (`?? false`) is what keeps a
          non-local host from reaching the local console. One carve-out: an
          EMPTY account with the CLI bridge present renders the console anyway
          (`emptyAccountLocalRecovery`) — a first run has no local host id and
          therefore no row to resolve, and hiding Install behind "No hosts
          yet" left a fresh install with no way to create its first host. */}
      {(scope.host === null && !emptyAccountLocalRecovery) ||
      scope.status === "vanished" ? (
        <HostScopeGate
          scope={scope}
          skeleton={<HostScopeConnecting hostName={scope.hostLabel} />}
        >
          {null}
        </HostScopeGate>
      ) : (
        <div className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}>
          {showLocalConsole || scope.host === null ? null : (
            <HostIdentityCard host={scope.host} onRename={null} renameDisabled>
              <ThisWindowCard scope={scope} host={scope.host} />
              <HostIdRow
                hostId={scope.host.hostId}
                onCopy={(value) => hostIdCopy.copy(value)}
              />
            </HostIdentityCard>
          )}

          {showLocalConsole ? null : updatesCard}

          {showLocalConsole ? (
            <>
              {packageManagerUpgrade !== null ? (
                <PackageManagerUpgradeHint hint={packageManagerUpgrade} />
              ) : null}

              <HostSummaryCard
                status={status}
                statusPending={statusPending}
                banner={{
                  progress,
                  terminalOutcome:
                    terminalOutcome === null
                      ? null
                      : { message: terminalOutcome.message },
                  onRetryTerminalOutcome: handleRetryTerminalOutcome,
                  onDismissTerminalOutcome: () => setTerminalOutcome(null),
                }}
                nameEdit={{
                  settings: hostNameSettings,
                  pending: hostNamePending,
                  error: hostNameError,
                  draft: hostNameDraft,
                  savePending: hostNameMutation.isPending,
                  editing: editingName,
                  onDraftChange: (value) => setHostNameDraftOverride(value),
                  onSave: () => {
                    hostNameMutation.mutate(
                      customNameFromDraft(hostNameDraft, hostNameSettings),
                    );
                  },
                  onReset: () => {
                    hostNameMutation.mutate(null);
                  },
                  onOpenEditing: () => setEditingName(true),
                  onCancel: () => {
                    setEditingName(false);
                    setHostNameDraftOverride(null);
                  },
                }}
                actions={{
                  anyPending,
                  installPending,
                  restartPending: restartMutation.isPending,
                  onInstall: () =>
                    convergeReadyMutation.mutate(
                      { force: false },
                      {
                        onSuccess: (outcome) => {
                          if (outcome.kind === "ok" && outcome.value.running) {
                            toast.success(
                              outcome.value.version !== null
                                ? `Installed host v${outcome.value.version}`
                                : "Host installed",
                            );
                          }
                          invalidate();
                        },
                        onError: (err) => {
                          toastFromRunnerError(err, "Couldn't install host");
                        },
                      },
                    ),
                  onRestart: () => setRestartConfirmOpen(true),
                  onOpenDoctor: () => setDoctorOpen(true),
                }}
                updates={{
                  // Rendered in the Updates card below instead, so the page has
                  // exactly one place that answers "is this host up to date?".
                  hidden: true,
                  registryState,
                  registryFetching:
                    registryFetching || refreshRegistryMutation.isPending,
                  anyPending,
                  updatePending,
                  latestReleasedAt,
                  nowMs,
                  updateReady: controllerStatus?.updateReady ?? false,
                  stagedVersion: controllerStatus?.stagedVersion ?? null,
                  downloadProgress:
                    controllerStatus?.download?.progress ?? null,
                  onUpdate: () => runApply(false),
                  onRefresh: handleRefreshRegistry,
                }}
              />

              {updatesCard}

              {/* Null only in the fresh-install carve-out, where there is no
                host row yet for this card to describe. */}
              {scope.host === null ? null : (
                <ThisWindowCardStandalone scope={scope} host={scope.host} />
              )}

              <SettingsGroup
                title="Installation"
                tone="default"
                dataTestId={undefined}
                fill={false}
              >
                <InstallationDetailsDisclosure
                  record={installedRecord ?? null}
                  loading={installedPending}
                />
                <AdvancedDisclosure
                  installedVersion={installedRecord?.version ?? null}
                  availableSnapshot={availableSnapshot}
                  availablePending={availablePending}
                  availableErrorMessage={extractErrorMessage(
                    availableError,
                    registryState,
                  )}
                  availableFetching={availableFetching}
                  includePreReleases={includePreReleases}
                  registryState={registryState}
                  statusState={status?.state}
                  anyPending={anyPending}
                  registerPending={registerPending}
                  deregisterPending={deregisterServiceMutation.isPending}
                  onInstallVersion={(version) =>
                    runInstallVersion(version, false)
                  }
                  onRegisterService={() => registerServiceMutation.mutate()}
                  onDeregisterService={() => deregisterServiceMutation.mutate()}
                  onRefreshAvailable={handleRefreshRegistry}
                  onIncludePreReleasesChange={setIncludePreReleases}
                />
              </SettingsGroup>
            </>
          ) : null}

          {/* No list of the OTHER hosts, and no "Add host": a page about one
            host is the wrong place to manage the collection it belongs to.
            The switcher in the sidebar owns both.

            Not gated from out here either: clearing snapshots is host RPC and
            needs a live route, but removing Traycer runs over the local CLI
            bridge and is exactly what someone reaches for when the service is
            stopped or broken. A gate around both took the recovery action away
            in the only state that needs it, so the region gates its own rows.

            With no host row the RPC row has nothing to clear — but "no row"
            is an enrollment fact, not an installation fact: an install that
            completed while sign-in did not leaves components on this machine
            with nothing in the account, and this page is the only uninstall
            surface. In the same empty-account carve-out that shows the
            install console, a record of installed components keeps the
            local-bridge removal row reachable; a truly fresh machine (no
            record) still shows nothing. */}
          {dangerZone}
        </div>
      )}

      <RestartHostConfirmDialog
        open={restartConfirmOpen}
        onOpenChange={(open) => {
          if (!open) setRestartConfirmOpen(false);
        }}
        isPending={restartMutation.isPending}
        onConfirm={() => restartMutation.mutate()}
      />
      <DoctorSheet
        open={doctorOpen}
        onOpenChange={setDoctorOpen}
        management={management}
      />
      <HostBusyForceDeferDialog
        open={busy !== null}
        message={busy?.message ?? ""}
        isForcing={
          applyStagedMutation.isPending ||
          installVersionMutation.isPending ||
          activateInstalledMutation.isPending
        }
        forceLabel={
          busy?.continuation === "activate" ? "Force restart" : "Force update"
        }
        onForce={() => {
          if (busy === null) return;
          if (busy.continuation === "activate") {
            runForceActivate();
            return;
          }
          if (busy.intent === "apply") {
            runApply(true);
          } else if (busy.pin !== null) {
            runInstallVersion(busy.pin, true);
          }
        }}
        onDefer={() => {
          setBusy(null);
        }}
      />
    </SettingsPanelShell>
  );
}

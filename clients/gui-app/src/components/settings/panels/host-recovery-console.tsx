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
import { ThisWindowCardStandalone } from "@/components/settings/host-scope/host-identity-card";
import {
  HostDangerZone,
  LocalRecoveryDangerZone,
} from "@/components/settings/host-scope/host-danger-zone";
import { HostRegistryUpdates } from "@/components/settings/host-scope/host-registry-updates";
import { HostSummaryCard } from "@/components/settings/panels/host-settings-summary-card";
import { HostUpdateRegion } from "@/components/settings/panels/host-settings-update-region";
import { InstallationDetailsDisclosure } from "@/components/settings/panels/host-settings-installation-details";
import { PackageManagerUpgradeHint } from "@/components/settings/panels/host-settings-package-manager-upgrade-hint";
import { SettingsGroup } from "@/components/settings/settings-group";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { toastHostRestartDeclined } from "@/lib/host-restart-toast";
import { useRunnerHostControllerStatusQuery } from "@/hooks/runner/use-runner-host-controller-status-query";
import { useRunnerConvergeReady } from "@/hooks/runner/use-runner-converge-ready-mutation";
import { useRunnerApplyStaged } from "@/hooks/runner/use-runner-apply-staged-mutation";
import { useRunnerActivateInstalled } from "@/hooks/runner/use-runner-activate-installed-mutation";
import { useRunnerInstallVersion } from "@/hooks/runner/use-runner-install-version-mutation";
import { useHostUpdateBannerStore } from "@/stores/settings/host-update-banner-store";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
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

export interface HostRecoveryConsoleProps {
  readonly management: IHostManagement;
  readonly runnerHost: IRunnerHost;
  readonly scope: HostScope;
  /**
   * The fresh-install carve-out: no host ROW exists yet, so `scope.host` is
   * null and the console is here purely to create the first one.
   */
  readonly emptyAccountLocalRecovery: boolean;
}

/**
 * THE RECOVERY CONSOLE — the last surface still built on the local CLI bridge.
 *
 * The Overview proper is one RPC-driven page that describes local and remote
 * hosts identically. This is what is left over: the states where there is no
 * host process to ask, so nothing on that page can answer. It renders for THIS
 * COMPUTER only, and only when the host here is unreachable or not installed.
 *
 * It is deliberately NOT gated on reachability — that would be exactly
 * backwards. Install, Start and Restart exist for a host that is down; hiding
 * them behind "can we dial it?" removed them precisely when they were the only
 * things worth showing, which is the defect the `showLocalConsole` split was
 * introduced to fix. The gate is the SUBJECT (`isLocalMachine`), never the
 * route.
 *
 * Restart falls back to `HostController.respawn()` here rather than
 * `host.restart`: an RPC restart needs a process to accept the call, and this
 * console renders when there isn't one.
 *
 * The code below is today's local console, moved rather than rewritten. Its
 * comments describe decisions that are still load-bearing.
 */
// Aggregates many independent bridge operations and async states; the branch
// count reflects surfaced concerns, not reducible nesting.
// eslint-disable-next-line complexity
export function HostRecoveryConsole(
  props: HostRecoveryConsoleProps,
): ReactNode {
  const { management, runnerHost, scope, emptyAccountLocalRecovery } = props;
  const queryClient = useQueryClient();
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
    }),
  );

  const { data: registryState, isFetching: registryFetching } = useQuery(
    queryOptions<HostRegistryUpdateState>({
      queryKey: runnerQueryKeys.hostRegistryUpdate(management),
      queryFn: () => management.registryCheck({ force: false }),
      staleTime: 60 * 60 * 1000,
    }),
  );

  const { data: installedRecord, isPending: installedPending } = useQuery(
    queryOptions<HostInstalledRecord | null>({
      queryKey: runnerQueryKeys.hostInstalledRecord(management),
      queryFn: () => management.installedRecord(),
      staleTime: 30_000,
    }),
  );

  const { data: cliManifest } = useQuery(
    queryOptions<CliInstallManifestSnapshot | null>({
      queryKey: runnerQueryKeys.hostCliManifest(management),
      queryFn: () => management.cliManifest(),
      staleTime: 5 * 60 * 1000,
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

  const registryItem = scope.host?.item ?? null;
  let dangerZone: ReactNode = null;
  if (scope.host !== null) {
    dangerZone = <HostDangerZone scope={scope} />;
  } else if (emptyAccountLocalRecovery && (installedRecord ?? null) !== null) {
    dangerZone = <LocalRecoveryDangerZone />;
  }

  const localUpdateRegion =
    status?.state !== "not-installed" ? (
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

  return (
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
          downloadProgress: controllerStatus?.download?.progress ?? null,
          onUpdate: () => runApply(false),
          onRefresh: handleRefreshRegistry,
        }}
      />

      {/* ONE Updates card, holding both halves of a host's update story: the
          local controller stages and applies a build on this computer, while
          the account registry carries the policy and target version any host
          reads on its next check-in. A person does not have two update
          questions, so the mechanisms sit in one card and the copy
          distinguishes them. */}
      {localUpdateRegion === null && registryItem === null ? null : (
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
                // Structurally `null` here, not a placeholder: this console
                // renders only when the local host is unreachable or not
                // installed, so there is no process answering `host.status` and
                // therefore no live session count to state. The drain notice
                // and its "ends N sessions" force correctly withhold.
                liveBusySessionCount={null}
                settledBusySessionCount={null}
              />
            )}
          </div>
        </SettingsGroup>
      )}

      {/* Null only in the fresh-install carve-out, where there is no host row
          yet for this card to describe. */}
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
          emptyMessage="No host currently installed."
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
          onInstallVersion={(version) => runInstallVersion(version, false)}
          onRegisterService={() => registerServiceMutation.mutate()}
          onDeregisterService={() => deregisterServiceMutation.mutate()}
          onRefreshAvailable={handleRefreshRegistry}
          onIncludePreReleasesChange={setIncludePreReleases}
        />
      </SettingsGroup>

      {dangerZone}

      <RestartHostConfirmDialog
        open={restartConfirmOpen}
        onOpenChange={(open) => {
          if (!open) setRestartConfirmOpen(false);
        }}
        isPending={restartMutation.isPending}
        onConfirm={() => restartMutation.mutate()}
      />
      {/* The BRIDGE doctor, deliberately: this console renders when the host
          process cannot answer, and `host.doctor` needs one that can. */}
      <DoctorSheet
        open={doctorOpen}
        onOpenChange={setDoctorOpen}
        source={{ kind: "bridge" }}
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
    </>
  );
}

import { useState } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { RestartHostConfirmDialog } from "@/components/host/restart-host-confirm-dialog";
import { HostBusyForceDeferDialog } from "@/components/host/host-busy-force-defer-dialog";
import { ActionsRow } from "@/components/settings/panels/host-settings-actions-row";
import { AdvancedDisclosure } from "@/components/settings/panels/host-settings-advanced-disclosure";
import { DoctorSheet } from "@/components/settings/panels/host-settings-doctor-sheet";
import {
  useLocalHostSnapshot,
  useNowMs,
} from "@/components/settings/panels/host-settings-panel-hooks";
import {
  deriveStatus,
  extractErrorMessage,
  findReleasedAt,
} from "@/components/settings/panels/host-settings-panel-model";
import { HostProgressBanner } from "@/components/settings/panels/host-settings-progress-banner";
import { InstallationDetailsDisclosure } from "@/components/settings/panels/host-settings-installation-details";
import { PackageManagerUpgradeHint } from "@/components/settings/panels/host-settings-package-manager-upgrade-hint";
import { StatusRow } from "@/components/settings/panels/host-settings-status-row";
import { UpdatesRow } from "@/components/settings/panels/host-settings-updates-row";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsRow } from "@/components/settings/settings-row";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Input } from "@/components/ui/input";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useRunnerHost } from "@/providers/use-runner-host";
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
  const management = runnerHost.hostManagement;
  if (management === null) {
    return (
      <SettingsPanelShell
        title="Host"
        description="Host management is only available on the desktop app."
      >
        <div className="px-5 py-6 text-ui-sm text-muted-foreground">
          This shell doesn&apos;t bundle the Traycer CLI.
        </div>
      </SettingsPanelShell>
    );
  }
  return (
    <HostSettingsPanelInner management={management} runnerHost={runnerHost} />
  );
}

interface HostNameRowProps {
  readonly settings: HostNameSettings | undefined;
  readonly pending: boolean;
  readonly draftName: string;
  readonly savePending: boolean;
  readonly onDraftNameChange: (value: string) => void;
  readonly onSave: () => void;
  readonly onReset: () => void;
}

function HostNameRow(props: HostNameRowProps) {
  const { settings, pending, draftName, savePending } = props;
  const disabled = pending || savePending || settings === undefined;
  const dirty =
    settings === undefined
      ? false
      : customNameFromDraft(draftName, settings) !== settings.customName;
  const systemName = settings === undefined ? "" : settings.systemName;
  const resetDisabled =
    settings === undefined ||
    pending ||
    savePending ||
    settings.customName === null;

  return (
    <SettingsRow
      label="Display Name"
      control={
        <div className="flex w-[min(68vw,28rem)] max-w-full flex-col gap-2">
          <Input
            aria-label="Display Name"
            value={draftName}
            maxLength={80}
            placeholder={systemName.length === 0 ? "Display Name" : systemName}
            disabled={disabled}
            onChange={(event) => {
              props.onDraftNameChange(event.currentTarget.value);
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={resetDisabled}
              onClick={props.onReset}
            >
              Reset
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={disabled || !dirty}
              onClick={props.onSave}
            >
              {savePending ? (
                <AgentSpinningDots
                  testId={undefined}
                  variant="orbit"
                  className="text-current"
                />
              ) : null}
              Save
            </Button>
          </div>
        </div>
      }
    />
  );
}

function customNameFromDraft(
  draftName: string,
  settings: HostNameSettings | undefined,
): string | null {
  const normalized = draftName.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return null;
  if (settings !== undefined && normalized === settings.systemName) {
    return null;
  }
  return normalized;
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
  const nowMs = useNowMs();
  const [doctorOpen, setDoctorOpen] = useState(false);
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

  const { data: hostNameSettings, isPending: hostNamePending } = useQuery(
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
    onSuccess: () => {
      setRestartConfirmOpen(false);
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

  return (
    <SettingsPanelShell
      title="Host"
      description="Local background service that runs Traycer on your machine."
    >
      {progress !== null ? <HostProgressBanner progress={progress} /> : null}
      {terminalOutcome !== null ? (
        <div
          data-testid="settings-host-deferred-outcome"
          className="flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-5 py-3 text-ui-sm text-destructive"
        >
          <span className="min-w-0 flex-1">{terminalOutcome.message}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              const { intent, pin } = terminalOutcome;
              setTerminalOutcome(null);
              if (intent === "apply") {
                runApply(false);
              } else if (pin !== null) {
                runInstallVersion(pin, false);
              }
            }}
            data-testid="settings-host-deferred-retry"
          >
            Retry
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setTerminalOutcome(null)}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      {packageManagerUpgrade !== null ? (
        <PackageManagerUpgradeHint hint={packageManagerUpgrade} />
      ) : null}

      <HostNameRow
        settings={hostNameSettings}
        pending={hostNamePending}
        draftName={hostNameDraft}
        savePending={hostNameMutation.isPending}
        onDraftNameChange={(value) => setHostNameDraftOverride(value)}
        onSave={() => {
          hostNameMutation.mutate(
            customNameFromDraft(hostNameDraft, hostNameSettings),
          );
        }}
        onReset={() => {
          hostNameMutation.mutate(null);
        }}
      />
      <StatusRow status={status} pending={statusPending} />
      <ActionsRow
        status={status}
        pending={statusPending}
        anyPending={anyPending}
        installPending={installPending}
        restartPending={restartMutation.isPending}
        onInstall={() =>
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
          )
        }
        onRestart={() => setRestartConfirmOpen(true)}
        onOpenDoctor={() => setDoctorOpen(true)}
      />
      <RestartHostConfirmDialog
        open={restartConfirmOpen}
        onOpenChange={(open) => {
          if (!open) setRestartConfirmOpen(false);
        }}
        isPending={restartMutation.isPending}
        onConfirm={() => restartMutation.mutate()}
      />
      {status?.state === "not-installed" ? null : (
        <UpdatesRow
          registryState={registryState}
          registryFetching={
            registryFetching || refreshRegistryMutation.isPending
          }
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
      )}

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
        onInstallVersion={(version) => runInstallVersion(version, false)}
        onRegisterService={() => registerServiceMutation.mutate()}
        onDeregisterService={() => deregisterServiceMutation.mutate()}
        onRefreshAvailable={handleRefreshRegistry}
        onIncludePreReleasesChange={setIncludePreReleases}
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

import { useState } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { RestartHostConfirmDialog } from "@/components/host/restart-host-confirm-dialog";
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
  projectAppHostAvailableSnapshot,
  type HostProgressState,
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
import { useRunnerHostOperationStatusQuery } from "@/hooks/runner/use-runner-host-operation-status-query";
import { useHostUpdateBannerStore } from "@/stores/settings/host-update-banner-store";
import { useDesktopAppUpdates } from "@/hooks/runner/use-desktop-app-updates";
import type {
  CliInstallManifestSnapshot,
  HostAvailableSnapshot,
  HostInstalledRecord,
  HostInstallResult,
  HostNameSettings,
  HostRegistryUpdateState,
  IHostManagement,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";

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
  const { snapshot: appUpdateSnapshot } = useDesktopAppUpdates();
  const includePreReleases = appUpdateSnapshot.allowPrerelease;
  const localHost = useLocalHostSnapshot(runnerHost);

  // Canonical cross-surface "is a host mutation running" status (Ticket:
  // host-update-race-conditions), shared with the landing-page banner and any
  // other open window via the same query key. Drives the progress banner and
  // the disable-gating below regardless of which surface (or the background
  // auto-update reconciler) actually started the operation - so this panel no
  // longer needs its own per-mutation `onProgress` callback or local
  // `progress` state.
  const { data: operationStatus } =
    useRunnerHostOperationStatusQuery(management);
  const sharedOperationActive =
    operationStatus !== undefined && operationStatus !== null;
  const progress: HostProgressState | null =
    operationStatus !== undefined && operationStatus !== null
      ? {
          kind: operationStatus.kind,
          event: {
            operationId: operationStatus.operationId,
            stage: operationStatus.stage ?? "",
            percent: operationStatus.percent,
            bytes: operationStatus.bytes,
            totalBytes: operationStatus.totalBytes,
            message: operationStatus.message,
          },
        }
      : null;

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
      queryFn: () =>
        management
          .availableVersions({ includePreReleases })
          .then((snapshot) =>
            projectAppHostAvailableSnapshot(snapshot, includePreReleases),
          ),
      staleTime: 5 * 60 * 1000,
    }),
  );

  const { data: registryState, isFetching: registryFetching } = useQuery(
    queryOptions<HostRegistryUpdateState>({
      queryKey: runnerQueryKeys.hostRegistryUpdate(
        management,
        includePreReleases,
      ),
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
      queryKey: runnerQueryKeys.hostRegistryUpdateScope(management),
    });
    void queryClient.invalidateQueries({
      queryKey: runnerQueryKeys.hostInstalledRecord(management),
    });
  };

  const installMutation = useMutation({
    mutationKey: runnerMutationKeys.hostInstall(),
    mutationFn: (version: string | null) =>
      management.installHost({ version, onProgress: null }),
    onSuccess: (data) => {
      toast.success(`Installed host v${data.version}`);
      useHostUpdateBannerStore.getState().clearSnooze(data.version);
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostInstalledRecord(management),
      });
      invalidate();
    },
    onError: (err) => {
      toastFromRunnerError(err, "Couldn't install host");
    },
  });

  const updateMutation = useMutation<HostInstallResult, Error, string | null>({
    mutationKey: runnerMutationKeys.hostUpdate(),
    // Pin the install to the version the Updates row is showing, so a channel
    // switch in another window can't redirect this click to another target.
    mutationFn: (expectedVersion) =>
      management.updateHost({ expectedVersion, onProgress: null }),
    onSuccess: (data) => {
      toast.success(`Updated host to v${data.version}`);
      useHostUpdateBannerStore.getState().clearSnooze(data.version);
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostInstalledRecord(management),
      });
      invalidate();
    },
    onError: (err) => {
      toastFromRunnerError(err, "Couldn't update host");
    },
  });

  const restartMutation = useMutation({
    mutationKey: runnerMutationKeys.hostRestart(),
    mutationFn: () => management.restartHost(),
    onSuccess: () => {
      toast.success("Host restart requested");
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostInstalledRecord(management),
      });
      invalidate();
    },
    onError: (err) => {
      toastFromRunnerError(err, "Couldn't restart host");
    },
  });

  const registerServiceMutation = useMutation({
    mutationKey: runnerMutationKeys.hostRegisterService(),
    mutationFn: () => management.registerService({ onProgress: null }),
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
      // Key off the channel the probe actually ran under, not this render's
      // value - they diverge if the channel changed while the probe was in
      // flight (see `HostRegistryUpdateListener`).
      queryClient.setQueryData(
        runnerQueryKeys.hostRegistryUpdate(management, data.includePreReleases),
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

  const anyPending =
    installMutation.isPending ||
    updateMutation.isPending ||
    restartMutation.isPending ||
    registerServiceMutation.isPending ||
    deregisterServiceMutation.isPending ||
    // A mutation started from another surface (the landing-page banner, a
    // second window, or the background auto-update reconciler) - none of
    // this panel's own mutations are pending, but the CLI lock is still
    // held, so every trigger here must stay disabled too.
    sharedOperationActive;
  const installPending =
    installMutation.isPending ||
    (operationStatus !== undefined &&
      operationStatus !== null &&
      operationStatus.kind === "install");
  const updatePending =
    updateMutation.isPending ||
    (operationStatus !== undefined &&
      operationStatus !== null &&
      operationStatus.kind === "update");
  const registerPending =
    registerServiceMutation.isPending ||
    (operationStatus !== undefined &&
      operationStatus !== null &&
      operationStatus.kind === "register-service");
  const restartPending =
    restartMutation.isPending ||
    (operationStatus !== undefined &&
      operationStatus !== null &&
      operationStatus.kind === "restart");

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
        restartPending={restartPending}
        onInstall={() => installMutation.mutate(null)}
        onRestart={() => setRestartConfirmOpen(true)}
        onOpenDoctor={() => setDoctorOpen(true)}
      />
      <RestartHostConfirmDialog
        open={restartConfirmOpen}
        onOpenChange={(open) => {
          if (!open) setRestartConfirmOpen(false);
        }}
        isPending={restartMutation.isPending}
        onConfirm={() => {
          // Close optimistically instead of waiting for onSuccess/onError -
          // the mutation can legitimately run tens of seconds, and holding
          // the dialog open+locked for that whole window is what made it
          // read as "stuck". Progress/failure still surface via toast.
          setRestartConfirmOpen(false);
          restartMutation.mutate();
        }}
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
          onUpdate={() =>
            updateMutation.mutate(registryState?.latestVersion ?? null)
          }
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
        registryState={registryState}
        statusState={status?.state}
        anyPending={anyPending}
        registerPending={registerPending}
        deregisterPending={deregisterServiceMutation.isPending}
        onInstallVersion={(version) => installMutation.mutate(version)}
        onRegisterService={() => registerServiceMutation.mutate()}
        onDeregisterService={() => deregisterServiceMutation.mutate()}
        onRefreshAvailable={handleRefreshRegistry}
      />

      <DoctorSheet
        open={doctorOpen}
        onOpenChange={setDoctorOpen}
        management={management}
      />
    </SettingsPanelShell>
  );
}

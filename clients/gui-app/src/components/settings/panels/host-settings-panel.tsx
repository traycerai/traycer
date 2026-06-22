import { useState } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
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
  type HostProgressKind,
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
import { useHostUpdateBannerStore } from "@/stores/settings/host-update-banner-store";
import type {
  CliInstallManifestSnapshot,
  HostAvailableSnapshot,
  HostInstalledRecord,
  HostNameSettings,
  HostProgressEvent,
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
  const [progress, setProgress] = useState<HostProgressState | null>(null);
  const [hostNameDraftOverride, setHostNameDraftOverride] = useState<
    string | null
  >(null);
  const [includePreReleases, setIncludePreReleases] = useState(false);
  const localHost = useLocalHostSnapshot(runnerHost);

  const makeProgressHandler = (
    kind: HostProgressKind,
  ): ((event: HostProgressEvent) => void) => {
    return (event) => setProgress({ kind, event });
  };

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

  const installMutation = useMutation({
    mutationKey: runnerMutationKeys.hostInstall(),
    mutationFn: (version: string | null) =>
      management.installHost({
        version,
        onProgress: makeProgressHandler("install"),
      }),
    onSuccess: (data) => {
      setProgress(null);
      toast.success(`Installed host v${data.version}`);
      useHostUpdateBannerStore.getState().clearSnooze(data.version);
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostInstalledRecord(management),
      });
      invalidate();
    },
    onError: (err) => {
      setProgress(null);
      toastFromRunnerError(err, "Couldn't install host");
    },
  });

  const updateMutation = useMutation({
    mutationKey: runnerMutationKeys.hostUpdate(),
    mutationFn: () =>
      management.updateHost({ onProgress: makeProgressHandler("update") }),
    onSuccess: (data) => {
      setProgress(null);
      toast.success(`Updated host to v${data.version}`);
      useHostUpdateBannerStore.getState().clearSnooze(data.version);
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostInstalledRecord(management),
      });
      invalidate();
    },
    onError: (err) => {
      setProgress(null);
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
    onError: (err) => toastFromRunnerError(err, "Couldn't restart host"),
  });

  const registerServiceMutation = useMutation({
    mutationKey: runnerMutationKeys.hostRegisterService(),
    mutationFn: () =>
      management.registerService({
        onProgress: makeProgressHandler("register-service"),
      }),
    onSuccess: () => {
      setProgress(null);
      toast.success("Service registered");
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostInstalledRecord(management),
      });
      invalidate();
    },
    onError: (err) => {
      setProgress(null);
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

  const anyPending =
    installMutation.isPending ||
    updateMutation.isPending ||
    restartMutation.isPending ||
    registerServiceMutation.isPending ||
    deregisterServiceMutation.isPending;

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
        installPending={installMutation.isPending}
        restartPending={restartMutation.isPending}
        onInstall={() => installMutation.mutate(null)}
        onRestart={() => restartMutation.mutate()}
        onOpenDoctor={() => setDoctorOpen(true)}
      />
      {status?.state === "not-installed" ? null : (
        <UpdatesRow
          registryState={registryState}
          registryFetching={
            registryFetching || refreshRegistryMutation.isPending
          }
          anyPending={anyPending}
          updatePending={updateMutation.isPending}
          latestReleasedAt={latestReleasedAt}
          nowMs={nowMs}
          onUpdate={() => updateMutation.mutate()}
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
        registerPending={registerServiceMutation.isPending}
        deregisterPending={deregisterServiceMutation.isPending}
        onInstallVersion={(version) => installMutation.mutate(version)}
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
    </SettingsPanelShell>
  );
}

import { ipcRenderer, type IpcRendererEvent } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  ActivateInstalledOk,
  ApplyStagedOk,
  ApplyStagedTrigger,
  CliInstallManifestSnapshot,
  ConvergeReadyOk,
  HostAvailableSnapshot,
  HostAvailableVersionsInput,
  HostControllerStatus,
  HostDoctorReport,
  HostGetInstallationInfoResponse,
  HostInstalledRecord,
  HostLogsTailResult,
  HostNameSettings,
  HostRegistryUpdateState,
  HostRemovalState,
  HostRestartRequestResult,
  HostTrayCommand,
  HostUninstallResult,
  HostUpdateCheckResponseV11,
  InstallVersionOk,
  MaintenanceDoctorProjection,
  MaintenanceInstallDispatch,
  DoctorRepairDispatch,
  QueuedDoctorRepair,
  QueuedDoctorRepairResult,
  DoctorRepairIntent,
  MutationOutcome,
  ServiceRegistrationOk,
  TraycerUninstallResult,
  FreePortAndRestartInput,
} from "../ipc-contracts/host-management-types";

/**
 * Browser-safe surface for the host gate, update banner, Settings → Host,
 * and the Doctor failure card. Query commands resolve once with the CLI's
 * final NDJSON `result` data payload; mutation intents resolve a
 * `MutationOutcome` (the mutation lane never rejects - "wait-never-reject",
 * Host Update Layer Redesign Tech Plan). Live status (both lanes) is
 * consumed via `getHostControllerStatus` + the desktop-only
 * `hostControllerStatus` push bridge (see `desktop-runner-host.ts`).
 *
 * The renderer never spawns the CLI directly; this bridge is the only seam.
 */
export interface HostManagementBridgeSurface {
  getHostControllerStatus(): Promise<HostControllerStatus>;
  convergeReady(force: boolean): Promise<MutationOutcome<ConvergeReadyOk>>;
  applyStaged(
    trigger: ApplyStagedTrigger,
    force: boolean,
  ): Promise<MutationOutcome<ApplyStagedOk>>;
  activateInstalled(
    force: boolean,
  ): Promise<MutationOutcome<ActivateInstalledOk>>;
  installVersion(
    pin: string,
    force: boolean,
  ): Promise<MutationOutcome<InstallVersionOk>>;
  uninstallHost(input: { readonly all: boolean }): Promise<HostUninstallResult>;
  uninstallTraycer(): Promise<TraycerUninstallResult>;
  getRemovalState(): Promise<HostRemovalState>;
  clearRemoval(): Promise<void>;
  restartHost(): Promise<HostRestartRequestResult>;
  getHostLogs(input: {
    readonly tailLines: number;
    readonly expectedHostId: string;
  }): Promise<HostLogsTailResult>;
  runDoctor(input: {
    readonly expectedHostId: string;
  }): Promise<HostDoctorReport>;
  availableVersions(
    input: HostAvailableVersionsInput,
  ): Promise<HostAvailableSnapshot>;
  installedRecord(): Promise<HostInstalledRecord | null>;
  registerService(): Promise<MutationOutcome<ServiceRegistrationOk>>;
  deregisterService(): Promise<void>;
  registryCheck(input: {
    readonly force: boolean;
  }): Promise<HostRegistryUpdateState>;
  freePortAndRestart(
    input: FreePortAndRestartInput & { readonly expectedHostId: string },
  ): Promise<FreePortAndRestartInput>;
  freePortAndRestartIfIdle(
    input: FreePortAndRestartInput & { readonly expectedHostId: string },
  ): Promise<DoctorRepairDispatch>;
  cliManifest(): Promise<CliInstallManifestSnapshot | null>;
  // Maintenance-RPC projections for the GUI's local fallback — protocol
  // response shapes, classified in main (see `host-management-ipc.ts`).
  maintenanceUpdateCheck(
    input: HostAvailableVersionsInput & { readonly expectedHostId: string },
  ): Promise<HostUpdateCheckResponseV11>;
  maintenanceDoctor(input: {
    readonly expectedHostId: string;
  }): Promise<MaintenanceDoctorProjection>;
  maintenanceInstallationInfo(input: {
    readonly expectedHostId: string;
  }): Promise<HostGetInstallationInfoResponse>;
  maintenanceInstallVersion(input: {
    readonly version: string;
    readonly force: boolean;
    readonly expectedHostId: string;
  }): Promise<MaintenanceInstallDispatch>;
  restartHostIfIdle(input: {
    readonly expectedHostId: string;
  }): Promise<HostRestartRequestResult>;
  runDoctorRepairQueued(input: {
    readonly repair: QueuedDoctorRepair;
    readonly expectedHostId: string;
  }): Promise<QueuedDoctorRepairResult>;
  runDoctorRepairIfIdle(input: {
    readonly repair: DoctorRepairIntent;
    readonly expectedHostId: string;
  }): Promise<DoctorRepairDispatch>;
  getHostName(): Promise<HostNameSettings>;
  setHostName(input: {
    readonly customName: string | null;
  }): Promise<HostNameSettings>;
}

export function buildHostManagementBridge(): HostManagementBridgeSurface {
  return {
    getHostControllerStatus: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerHostControllerStatusGet,
      ) as Promise<HostControllerStatus>,
    convergeReady: (force) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerHostConvergeReady, {
        force,
      }) as Promise<MutationOutcome<ConvergeReadyOk>>,
    applyStaged: (trigger, force) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerHostApplyStaged, {
        trigger,
        force,
      }) as Promise<MutationOutcome<ApplyStagedOk>>,
    activateInstalled: (force) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerHostActivateInstalled, {
        force,
      }) as Promise<MutationOutcome<ActivateInstalledOk>>,
    installVersion: (pin, force) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerHostInstallVersion, {
        pin,
        force,
      }) as Promise<MutationOutcome<InstallVersionOk>>,
    uninstallHost: ({ all }) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerHostUninstall, {
        all,
      }) as Promise<HostUninstallResult>,
    uninstallTraycer: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerAppUninstall,
      ) as Promise<TraycerUninstallResult>,
    getRemovalState: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerHostRemovalGet,
      ) as Promise<HostRemovalState>,
    clearRemoval: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerHostRemovalClear,
      ) as Promise<void>,
    restartHost: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerHostRestart,
      ) as Promise<HostRestartRequestResult>,
    getHostLogs: ({ tailLines, expectedHostId }) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerHostLogs, {
        tailLines,
        expectedHostId,
      }) as Promise<HostLogsTailResult>,
    runDoctor: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerHostDoctor,
        input,
      ) as Promise<HostDoctorReport>,
    availableVersions: ({ includePreReleases }) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerHostAvailable, {
        includePreReleases,
      }) as Promise<HostAvailableSnapshot>,
    installedRecord: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerHostInstalled,
      ) as Promise<HostInstalledRecord | null>,
    registerService: () =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerServiceRegister) as Promise<
        MutationOutcome<ServiceRegistrationOk>
      >,
    deregisterService: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerServiceDeregister,
      ) as Promise<void>,
    registryCheck: ({ force }) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerRegistryCheck, {
        force,
      }) as Promise<HostRegistryUpdateState>,
    freePortAndRestart: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerFreePortAndRestart,
        input,
      ) as Promise<FreePortAndRestartInput>,
    freePortAndRestartIfIdle: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerFreePortAndRestartIfIdle,
        input,
      ) as Promise<DoctorRepairDispatch>,
    cliManifest: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerCliManifestRead,
      ) as Promise<CliInstallManifestSnapshot | null>,
    maintenanceUpdateCheck: ({ includePreReleases, expectedHostId }) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerMaintenanceUpdateCheck, {
        includePreReleases,
        expectedHostId,
      }) as Promise<HostUpdateCheckResponseV11>,
    maintenanceDoctor: ({ expectedHostId }) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerMaintenanceDoctor, {
        expectedHostId,
      }) as Promise<MaintenanceDoctorProjection>,
    maintenanceInstallationInfo: ({ expectedHostId }) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerMaintenanceInstallationInfo, {
        expectedHostId,
      }) as Promise<HostGetInstallationInfoResponse>,
    maintenanceInstallVersion: ({ version, force, expectedHostId }) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerMaintenanceInstallVersion, {
        version,
        force,
        expectedHostId,
      }) as Promise<MaintenanceInstallDispatch>,
    restartHostIfIdle: ({ expectedHostId }) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerHostRestartIfIdle, {
        expectedHostId,
      }) as Promise<HostRestartRequestResult>,
    runDoctorRepairQueued: ({ repair, expectedHostId }) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerDoctorRepairQueued, {
        repair,
        expectedHostId,
      }) as Promise<QueuedDoctorRepairResult>,
    runDoctorRepairIfIdle: ({ repair, expectedHostId }) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerDoctorRepairIfIdle, {
        repair,
        expectedHostId,
      }) as Promise<DoctorRepairDispatch>,
    getHostName: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerHostNameGet,
      ) as Promise<HostNameSettings>,
    setHostName: ({ customName }) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerHostNameSet, {
        customName,
      }) as Promise<HostNameSettings>,
  };
}

/**
 * Push subscription for the two-lane `HostControllerStatus`. Desktop-only
 * (mirrors the `hostRegistryUpdates`/`hostOperationStatus` duck-typed
 * bridges it replaces) - not part of the cross-shell `IHostManagement`.
 */
export interface HostControllerStatusBridgeSurface {
  onChange(handler: (status: HostControllerStatus) => void): {
    dispose: () => void;
  };
}

export function buildHostControllerStatusSubscriber(): HostControllerStatusBridgeSurface {
  return {
    onChange(handler) {
      const listener = (_event: IpcRendererEvent, payload: unknown): void => {
        if (!isHostControllerStatus(payload)) return;
        handler(payload);
      };
      ipcRenderer.on(RunnerHostEvent.hostControllerStatusChange, listener);
      return {
        dispose: () =>
          ipcRenderer.removeListener(
            RunnerHostEvent.hostControllerStatusChange,
            listener,
          ),
      };
    },
  };
}

function isHostControllerStatus(value: unknown): value is HostControllerStatus {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.updateReady === "boolean" &&
    typeof candidate.reachable === "boolean" &&
    typeof candidate.removedByUser === "boolean" &&
    typeof candidate.checkedAt === "string" &&
    (candidate.activation === "activated" ||
      candidate.activation === "pendingActivation" ||
      candidate.activation === "activationUnknown" ||
      candidate.activation === "unavailable")
  );
}

/**
 * Subscribes to tray-side host commands forwarded from main.
 * Renderer wires this to the Doctor / Settings router so a tray click
 * deep-links into the right surface.
 */
export interface HostTrayBridgeSurface {
  onCommand(handler: (command: HostTrayCommand) => void): {
    dispose: () => void;
  };
}

export function buildHostTrayCommandSubscriber(): HostTrayBridgeSurface {
  return {
    onCommand(handler: (command: HostTrayCommand) => void): {
      dispose: () => void;
    } {
      const listener = (_event: IpcRendererEvent, payload: unknown): void => {
        if (!isHostTrayCommand(payload)) return;
        handler(payload);
      };
      ipcRenderer.on(RunnerHostEvent.hostTrayCommand, listener);
      return {
        dispose: () =>
          ipcRenderer.removeListener(RunnerHostEvent.hostTrayCommand, listener),
      };
    },
  };
}

function isHostTrayCommand(value: unknown): value is HostTrayCommand {
  if (value === null || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "openSettingsHost") return true;
  if (kind === "restartHost") return true;
  if (kind === "openLogs") return true;
  if (kind === "installUpdate") {
    return typeof (value as { version?: unknown }).version === "string";
  }
  return false;
}

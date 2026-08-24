/**
 * Desktop IPC re-exports of the shared host-management contract. The
 * canonical definitions live in `@traycer-clients/shared/platform/
 * runner-host` so `gui-app`, mock runner host, and the desktop preload
 * agree on a single shape; this file lets the Electron main code and the
 * preload bridge keep their existing import paths.
 *
 * Long-running operations (install / update / uninstall / service register)
 * stream `HostProgressEvent` records through `RunnerHostEvent.cliOperationProgress`
 * keyed by `operationId`, with the IPC `invoke` resolving to the terminal
 * `result.data` payload on success.
 */

export type {
  ActivateInstalledOk,
  ApplyStagedOk,
  ApplyStagedTrigger,
  BusyContinuation,
  CliInstallManifestSnapshot,
  ConvergeReadyOk,
  DownloadLaneStatus,
  DownloadProgress,
  HostActivationState,
  HostAvailableSnapshot,
  HostAvailableVersionAsset,
  HostAvailableVersionEntry,
  HostAvailableVersionsInput,
  HostControllerStatus,
  HostDoctorIssue,
  HostDoctorReport,
  HostDoctorSeverity,
  HostInstallSourceTag,
  HostInstalledRecord,
  HostLogsTailResult,
  HostNameSettings,
  HostRegistryUpdateState,
  HostRemovalState,
  HostRestartRequestResult,
  HostTrayCommand,
  HostUninstallResult,
  InstallVersionOk,
  MaintenanceDoctorProjection,
  MaintenanceInstallDispatch,
  DoctorRepairDispatch,
  QueuedDoctorRepair,
  QueuedDoctorRepairResult,
  DoctorRepairIntent,
  MutationKind,
  MutationLaneStatus,
  MutationOutcome,
  MutationProgress,
  ServiceRegistrationOk,
  TraycerUninstallResult,
  FreePortAndRestartInput,
} from "@traycer-clients/shared/platform/runner-host";

// The `maintenance:*` handlers resolve protocol response shapes verbatim (see
// `IHostManagement`'s maintenance members for why); re-exported here so main
// and the preload keep their single ipc-contracts import path.
export type {
  HostGetInstallationInfoResponse,
  HostUpdateCheckResponseV11,
} from "@traycer/protocol/host/maintenance/index";

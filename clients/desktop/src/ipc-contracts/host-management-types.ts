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
  CliInstallManifestSnapshot,
  HostAvailableSnapshot,
  HostAvailableVersionAsset,
  HostAvailableVersionEntry,
  HostAvailableVersionsInput,
  HostDoctorIssue,
  HostDoctorReport,
  HostDoctorSeverity,
  HostEnsureResult,
  HostInstallResult,
  HostInstallSourceTag,
  HostInstalledRecord,
  HostLogsTailResult,
  HostNameSettings,
  HostOperationKind,
  HostOperationStatus,
  HostProgressEvent,
  HostRegistryUpdateState,
  HostRemovalState,
  HostTrayCommand,
  HostUninstallResult,
  TraycerUninstallResult,
  FreePortAndRestartInput,
} from "@traycer-clients/shared/platform/runner-host";

import { ipcRenderer, type IpcRendererEvent } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  CliInstallManifestSnapshot,
  HostAvailableSnapshot,
  HostAvailableVersionsInput,
  HostDoctorReport,
  HostEnsureResult,
  HostInstallResult,
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
} from "../ipc-contracts/host-management-types";

/**
 * Browser-safe surface for Settings → Host and the Doctor failure card.
 * Each method either resolves once with the CLI's final NDJSON `result`
 * data payload (query commands), or - for long-running operations - accepts
 * a synchronous `onProgress` callback that fires for every NDJSON
 * `progress` event the CLI emits along the way.
 *
 * The renderer never spawns the CLI directly; this bridge is the only seam.
 */
export interface HostManagementBridgeSurface {
  installHost(input: {
    readonly version: string | null;
    readonly onProgress: ((event: HostProgressEvent) => void) | null;
  }): Promise<HostInstallResult>;
  updateHost(input: {
    readonly expectedVersion: string | null;
    readonly onProgress: ((event: HostProgressEvent) => void) | null;
  }): Promise<HostInstallResult>;
  uninstallHost(input: { readonly all: boolean }): Promise<HostUninstallResult>;
  uninstallTraycer(): Promise<TraycerUninstallResult>;
  getRemovalState(): Promise<HostRemovalState>;
  clearRemoval(): Promise<void>;
  restartHost(): Promise<void>;
  getHostLogs(input: {
    readonly tailLines: number;
  }): Promise<HostLogsTailResult>;
  runDoctor(): Promise<HostDoctorReport>;
  availableVersions(
    input: HostAvailableVersionsInput,
  ): Promise<HostAvailableSnapshot>;
  installedRecord(): Promise<HostInstalledRecord | null>;
  registerService(input: {
    readonly onProgress: ((event: HostProgressEvent) => void) | null;
  }): Promise<void>;
  ensureHost(input: {
    readonly onProgress: ((event: HostProgressEvent) => void) | null;
    readonly force: boolean;
  }): Promise<HostEnsureResult>;
  deregisterService(): Promise<void>;
  registryCheck(input: {
    readonly force: boolean;
  }): Promise<HostRegistryUpdateState>;
  onRegistryUpdateState(handler: (state: HostRegistryUpdateState) => void): {
    dispose: () => void;
  };
  getOperationStatus(): Promise<HostOperationStatus | null>;
  onOperationStatus(handler: (status: HostOperationStatus | null) => void): {
    dispose: () => void;
  };
  freePortAndRestart(
    input: FreePortAndRestartInput,
  ): Promise<FreePortAndRestartInput>;
  cliManifest(): Promise<CliInstallManifestSnapshot | null>;
  getHostName(): Promise<HostNameSettings>;
  setHostName(input: {
    readonly customName: string | null;
  }): Promise<HostNameSettings>;
}

function withOperationListener<T>(
  channel: string,
  payload: Record<string, unknown> | null,
  onProgress: ((event: HostProgressEvent) => void) | null,
): Promise<T> {
  const operationId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const args = { ...(payload ?? {}), operationId };
  const listener =
    onProgress === null
      ? null
      : (_event: IpcRendererEvent, rawPayload: unknown): void => {
          if (rawPayload === null || typeof rawPayload !== "object") return;
          const event = rawPayload as HostProgressEvent;
          if (event.operationId !== operationId) return;
          onProgress(event);
        };
  if (listener !== null) {
    ipcRenderer.on(RunnerHostEvent.cliOperationProgress, listener);
  }
  const settle = (): void => {
    if (listener !== null) {
      ipcRenderer.removeListener(
        RunnerHostEvent.cliOperationProgress,
        listener,
      );
    }
  };
  return (ipcRenderer.invoke(channel, args) as Promise<T>).then(
    (value) => {
      settle();
      return value;
    },
    (err) => {
      settle();
      throw err;
    },
  );
}

export function buildHostManagementBridge(): HostManagementBridgeSurface {
  return {
    installHost: ({ version, onProgress }) =>
      withOperationListener<HostInstallResult>(
        RunnerHostInvoke.traycerHostInstall,
        { version },
        onProgress,
      ),
    updateHost: ({ expectedVersion, onProgress }) =>
      withOperationListener<HostInstallResult>(
        RunnerHostInvoke.traycerHostUpdate,
        { expectedVersion },
        onProgress,
      ),
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
      ipcRenderer.invoke(RunnerHostInvoke.traycerHostRestart) as Promise<void>,
    getHostLogs: ({ tailLines }) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerHostLogs, {
        tailLines,
      }) as Promise<HostLogsTailResult>,
    runDoctor: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerHostDoctor,
      ) as Promise<HostDoctorReport>,
    availableVersions: ({ includePreReleases }) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerHostAvailable, {
        includePreReleases,
      }) as Promise<HostAvailableSnapshot>,
    installedRecord: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerHostInstalled,
      ) as Promise<HostInstalledRecord | null>,
    registerService: ({ onProgress }) =>
      withOperationListener<void>(
        RunnerHostInvoke.traycerServiceRegister,
        null,
        onProgress,
      ),
    ensureHost: ({ onProgress, force }) =>
      withOperationListener<HostEnsureResult>(
        RunnerHostInvoke.traycerHostEnsure,
        { force },
        onProgress,
      ),
    deregisterService: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerServiceDeregister,
      ) as Promise<void>,
    registryCheck: ({ force }) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerRegistryCheck, {
        force,
      }) as Promise<HostRegistryUpdateState>,
    onRegistryUpdateState(handler) {
      const listener = (_event: IpcRendererEvent, payload: unknown): void => {
        if (!isHostRegistryUpdateState(payload)) return;
        handler(payload);
      };
      ipcRenderer.on(RunnerHostEvent.hostRegistryUpdateStateChange, listener);
      return {
        dispose: () =>
          ipcRenderer.removeListener(
            RunnerHostEvent.hostRegistryUpdateStateChange,
            listener,
          ),
      };
    },
    getOperationStatus: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerHostOperationStatusGet,
      ) as Promise<HostOperationStatus | null>,
    onOperationStatus(handler) {
      const listener = (_event: IpcRendererEvent, payload: unknown): void => {
        if (!isHostOperationStatusOrNull(payload)) return;
        handler(payload);
      };
      ipcRenderer.on(RunnerHostEvent.hostOperationStatusChange, listener);
      return {
        dispose: () =>
          ipcRenderer.removeListener(
            RunnerHostEvent.hostOperationStatusChange,
            listener,
          ),
      };
    },
    freePortAndRestart: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerFreePortAndRestart,
        input,
      ) as Promise<FreePortAndRestartInput>,
    cliManifest: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerCliManifestRead,
      ) as Promise<CliInstallManifestSnapshot | null>,
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

function isHostRegistryUpdateState(
  value: unknown,
): value is HostRegistryUpdateState {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const checkedAt = candidate.checkedAt;
  const latestVersion = candidate.latestVersion;
  const installedVersion = candidate.installedVersion;
  const errorMessage = candidate.errorMessage;
  // `includePreReleases` is the query-key discriminator for registry state
  // (channel-scoped cache). Accepting a payload without a boolean would let
  // older/malformed pushes file under `undefined` and clobber the live key
  // (cold-review #9).
  return (
    (typeof checkedAt === "string" || checkedAt === null) &&
    (typeof latestVersion === "string" || latestVersion === null) &&
    (typeof installedVersion === "string" || installedVersion === null) &&
    typeof candidate.updateAvailable === "boolean" &&
    typeof candidate.reachable === "boolean" &&
    (typeof errorMessage === "string" || errorMessage === null) &&
    typeof candidate.includePreReleases === "boolean"
  );
}

// `Record<HostOperationKind, true>` requires a key for every member of the
// union - if `HostOperationKind` ever gains a member without a matching key
// added here, this object literal fails to compile instead of silently
// dropping that kind's broadcasts at runtime (the exact bug: `restart` and
// `free-port-and-restart` were added to the shared type without updating
// this preload's validation, so `onOperationStatus` rejected main's
// broadcasts for them before they ever reached the query cache).
const HOST_OPERATION_KINDS: Record<HostOperationKind, true> = {
  install: true,
  update: true,
  "register-service": true,
  ensure: true,
  restart: true,
  "free-port-and-restart": true,
};

function isHostOperationKind(value: unknown): value is HostOperationKind {
  return (
    typeof value === "string" && Object.hasOwn(HOST_OPERATION_KINDS, value)
  );
}

function isHostOperationStatusOrNull(
  value: unknown,
): value is HostOperationStatus | null {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const stage = candidate.stage;
  const percent = candidate.percent;
  const bytes = candidate.bytes;
  const totalBytes = candidate.totalBytes;
  const message = candidate.message;
  return (
    typeof candidate.operationId === "string" &&
    isHostOperationKind(candidate.kind) &&
    (typeof stage === "string" || stage === null) &&
    (typeof percent === "number" || percent === null) &&
    (typeof bytes === "number" || bytes === null) &&
    (typeof totalBytes === "number" || totalBytes === null) &&
    (typeof message === "string" || message === null) &&
    typeof candidate.startedAt === "string"
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

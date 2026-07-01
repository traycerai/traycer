import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  AccessibilityThemeSnapshot,
  BackgroundMaterial,
  DisplayTopology,
  LogLevel,
  LogLevelScope,
  LogLevelsSnapshot,
  PendingCertificateError,
  ProcessMetricsSnapshot,
  TrustedCertificateEntry,
  Vibrancy,
} from "../ipc-contracts/platform-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

export type {
  AccessibilityThemeSnapshot,
  BackgroundMaterial,
  DisplaySnapshot,
  DisplayTopology,
  PendingCertificateError,
  ProcessMetricsSnapshot,
  TrustedCertificateEntry,
  Vibrancy,
} from "../ipc-contracts/platform-types";

export interface PlatformBridgeSurface {
  recentDocuments: {
    add(path: string): Promise<void>;
  };
  window: {
    flashFrame(shouldFlash: boolean): Promise<void>;
    setProgressBar(value: number): Promise<void>;
    setRepresentedFilename(path: string): Promise<void>;
    setDocumentEdited(edited: boolean): Promise<void>;
    setContentProtection(enabled: boolean): Promise<void>;
    setVibrancy(vibrancy: Vibrancy | null): Promise<void>;
    setBackgroundMaterial(material: BackgroundMaterial): Promise<void>;
    setVisibleOnAllWorkspaces(visible: boolean): Promise<void>;
  };
  app: {
    setBadge(text: string): Promise<void>;
  };
  diagnostics: {
    getMetrics(): Promise<ProcessMetricsSnapshot>;
    takeHeapSnapshot(): Promise<string | null>;
    traceStart(): Promise<boolean>;
    traceStop(): Promise<string | null>;
  };
  systemPreferences: {
    getAccentColor(): Promise<string | null>;
    getAppearance(): Promise<"dark" | "light" | null>;
    getAccessibilityTheme(): Promise<AccessibilityThemeSnapshot>;
    onAccessibilityThemeChange(
      handler: Listener<AccessibilityThemeSnapshot>,
    ): Disposable;
  };
  touchId: {
    isAvailable(): Promise<boolean>;
    prompt(reason: string): Promise<boolean>;
  };
  proxyAuth: {
    list(): Promise<
      ReadonlyArray<{ readonly key: string; readonly username: string }>
    >;
    save(
      host: string,
      realm: string,
      username: string,
      password: string,
    ): Promise<boolean>;
    clear(host: string, realm: string): Promise<void>;
  };
  proxy: {
    setConfig(config: unknown): Promise<void>;
    resolve(url: string): Promise<string>;
  };
  certTrust: {
    list(): Promise<ReadonlyArray<TrustedCertificateEntry>>;
    trust(hostname: string, certificate: unknown): Promise<unknown>;
    untrust(fingerprint: string, hostname: string): Promise<void>;
    listPending(): Promise<ReadonlyArray<PendingCertificateError>>;
    dismissPending(id: string): Promise<void>;
    showSystemDialog(certificate: unknown, message: string): Promise<boolean>;
    onPending(handler: Listener<PendingCertificateError>): Disposable;
  };
  display: {
    list(): Promise<DisplayTopology>;
    onTopologyChange(
      handler: Listener<{
        readonly reason:
          "display-added" | "display-removed" | "display-metrics-changed";
        readonly topology: DisplayTopology;
      }>,
    ): Disposable;
  };
  gpu: {
    getAccelerationEnabled(): Promise<boolean>;
    setAccelerationEnabled(enabled: boolean): Promise<boolean>;
  };
  logLevels: {
    get(): Promise<LogLevelsSnapshot>;
    set(scope: LogLevelScope, level: LogLevel): Promise<LogLevelsSnapshot>;
  };
  windowEx: {
    setOverlayIcon(image: string | null, description: string): Promise<void>;
  };
}

export function buildPlatformBridge(): PlatformBridgeSurface {
  return {
    recentDocuments: {
      add: (path) =>
        ipcRenderer.invoke(RunnerHostInvoke.recentDocumentAdd, path),
    },
    window: {
      flashFrame: (shouldFlash) =>
        ipcRenderer.invoke(RunnerHostInvoke.windowFlashFrame, shouldFlash),
      setProgressBar: (value) =>
        ipcRenderer.invoke(RunnerHostInvoke.windowSetProgressBar, value),
      setRepresentedFilename: (path) =>
        ipcRenderer.invoke(RunnerHostInvoke.windowSetRepresentedFilename, path),
      setDocumentEdited: (edited) =>
        ipcRenderer.invoke(RunnerHostInvoke.windowSetDocumentEdited, edited),
      setContentProtection: (enabled) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.windowSetContentProtection,
          enabled,
        ),
      setVibrancy: (vibrancy) =>
        ipcRenderer.invoke(RunnerHostInvoke.windowSetVibrancy, vibrancy),
      setBackgroundMaterial: (material) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.windowSetBackgroundMaterial,
          material,
        ),
      setVisibleOnAllWorkspaces: (visible) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.windowSetVisibleOnAllWorkspaces,
          visible,
        ),
    },
    app: {
      setBadge: (text) =>
        ipcRenderer.invoke(RunnerHostInvoke.windowSetBadge, text),
    },
    diagnostics: {
      getMetrics: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.diagnosticsGetMetrics,
        ) as Promise<ProcessMetricsSnapshot>,
      takeHeapSnapshot: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.diagnosticsTakeHeapSnapshot,
        ) as Promise<string | null>,
      traceStart: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.diagnosticsTraceStart,
        ) as Promise<boolean>,
      traceStop: () =>
        ipcRenderer.invoke(RunnerHostInvoke.diagnosticsTraceStop) as Promise<
          string | null
        >,
    },
    systemPreferences: {
      getAccentColor: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.systemPreferencesAccentColor,
        ) as Promise<string | null>,
      getAppearance: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.systemPreferencesAppearance,
        ) as Promise<"dark" | "light" | null>,
      getAccessibilityTheme: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.systemPreferencesAccessibilityTheme,
        ) as Promise<AccessibilityThemeSnapshot>,
      onAccessibilityThemeChange: (handler) =>
        subscribe<AccessibilityThemeSnapshot>(
          RunnerHostEvent.accessibilityThemeChange,
          handler,
        ),
    },
    touchId: {
      isAvailable: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.touchIdAvailable,
        ) as Promise<boolean>,
      prompt: (reason) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.touchIdPrompt,
          reason,
        ) as Promise<boolean>,
    },
    proxyAuth: {
      list: () =>
        ipcRenderer.invoke(RunnerHostInvoke.proxyAuthList) as Promise<
          ReadonlyArray<{ readonly key: string; readonly username: string }>
        >,
      save: (host, realm, username, password) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.proxyAuthSave,
          host,
          realm,
          username,
          password,
        ) as Promise<boolean>,
      clear: (host, realm) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.proxyAuthClear,
          host,
          realm,
        ) as Promise<void>,
    },
    proxy: {
      setConfig: (config) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.proxySetConfig,
          config,
        ) as Promise<void>,
      resolve: (url) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.proxyResolve,
          url,
        ) as Promise<string>,
    },
    certTrust: {
      list: () =>
        ipcRenderer.invoke(RunnerHostInvoke.certTrustList) as Promise<
          ReadonlyArray<TrustedCertificateEntry>
        >,
      trust: (hostname, certificate) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.certTrustAdd,
          hostname,
          certificate,
        ),
      untrust: (fingerprint, hostname) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.certTrustRemove,
          fingerprint,
          hostname,
        ) as Promise<void>,
      listPending: () =>
        ipcRenderer.invoke(RunnerHostInvoke.certTrustListPending) as Promise<
          ReadonlyArray<PendingCertificateError>
        >,
      dismissPending: (id) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.certTrustDismissPending,
          id,
        ) as Promise<void>,
      showSystemDialog: (certificate, message) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.certTrustSystemDialog,
          certificate,
          message,
        ) as Promise<boolean>,
      onPending: (handler) =>
        subscribe(RunnerHostEvent.certificateErrorPending, handler),
    },
    display: {
      list: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.displayList,
        ) as Promise<DisplayTopology>,
      onTopologyChange: (handler) =>
        subscribe(RunnerHostEvent.displayTopologyChange, handler),
    },
    gpu: {
      getAccelerationEnabled: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.gpuAccelerationGet,
        ) as Promise<boolean>,
      setAccelerationEnabled: (enabled) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.gpuAccelerationSet,
          enabled,
        ) as Promise<boolean>,
    },
    logLevels: {
      get: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.logLevelsGet,
        ) as Promise<LogLevelsSnapshot>,
      set: (scope, level) =>
        ipcRenderer.invoke(RunnerHostInvoke.logLevelsSet, {
          scope,
          level,
        }) as Promise<LogLevelsSnapshot>,
    },
    windowEx: {
      setOverlayIcon: (image, description) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.windowSetOverlayIcon,
          image,
          description,
        ) as Promise<void>,
    },
  };
}

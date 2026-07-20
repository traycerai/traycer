import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";

/**
 * Shared `IRunnerHost` stub base for renderer/bridge-provider tests that need
 * a fully-typed host without the real desktop IPC/HTTP backing. Every field
 * here is a deterministic no-op; pass `overrides` for whatever a given test
 * actually exercises (spies, `hostTray`/`hostManagement` doubles, etc.).
 */
export function createFakeRunnerHost(
  overrides: Partial<IRunnerHost>,
): IRunnerHost {
  const base: IRunnerHost = {
    signInUrl: "https://auth.example.invalid/sign-in",
    authnBaseUrl: "https://auth.example.invalid",
    relayBaseUrl: "wss://relay.example.invalid/attach",
    hasLocalHost: true,
    validateAuthToken: () => Promise.resolve({ kind: "rejected" as const }),
    validateAuthTokenIdentity: () =>
      Promise.resolve({ kind: "rejected" as const }),
    refreshAuthToken: () => Promise.resolve({ kind: "network-error" as const }),
    listRegisteredHosts: () =>
      Promise.resolve({ kind: "network-error" as const }),
    listUserSessions: () => Promise.resolve({ kind: "network-error" as const }),
    revokeUserSession: () =>
      Promise.resolve({ kind: "network-error" as const }),
    revokeAllSessions: () =>
      Promise.resolve({ kind: "network-error" as const }),
    requestStepUpChallenge: () =>
      Promise.resolve({ kind: "network-error" as const }),
    verifyStepUpChallenge: () =>
      Promise.resolve({ kind: "network-error" as const }),
    updateHostVersionPolicy: () =>
      Promise.resolve({ kind: "network-error" as const }),
    openExternalLink: () => Promise.resolve(),
    getRegisteredUrlSchemes: () => Promise.resolve([]),
    requestMicrophoneAccess: () => Promise.resolve("granted" as const),
    openMicrophoneSettings: () => Promise.resolve(),
    beginAuthAttempt: () => undefined,
    onAuthCallback: () => ({ dispose: () => undefined }),
    deviceFlow: { start: () => Promise.resolve(null) },
    secureStorage: {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    notifications: {
      show: () => Promise.resolve(),
      onClick: () => ({ dispose: () => undefined }),
    },
    tray: {
      setEpics: () => Promise.resolve(),
      setIndicator: () => Promise.resolve(),
      onEpicSelected: () => ({ dispose: () => undefined }),
    },
    hostPicker: {
      get isOpen() {
        return false;
      },
      requestOpen: () => undefined,
      requestClose: () => undefined,
      onChange: () => ({ dispose: () => undefined }),
    },
    workspaceFolders: {
      pickFolders: () => Promise.resolve([]),
    },
    fileDrops: {
      resolveDroppedFilePaths: () => Promise.resolve([]),
      copyDroppedFilePaths: (paths) => Promise.resolve(paths),
      readNativeClipboardFilePaths: () => Promise.resolve([]),
    },
    tokenStore: {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    onLocalHostChange: () => ({ dispose: () => undefined }),
    onSystemResumed: () => ({ dispose: () => undefined }),
    requestHostRespawn: () => Promise.resolve(),
    service: null,
    traycerCli: null,
    migration: null,
    hostManagement: null,
    hostTray: null,
    zoom: null,
  };
  return { ...base, ...overrides };
}

import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import {
  createInProcessSelectionAuthority,
  inertLocalHostOutageSignal,
  InMemoryAuthorityIdentitySource,
  InMemoryHostFleetSource,
  InMemoryPreferredHostStore,
  unavailableLocalHostEnsurePort,
} from "@traycer-clients/shared/host-selection/in-process-selection-authority";
import {
  createIncrementingIncarnationIds,
  silentAuthorityLog,
  systemAuthorityClock,
} from "@traycer-clients/shared/host-selection/selection-authority-engine";

/** In-window authority with one local host so HostRuntimeProvider boot gets a real derivation, not the inert double. */
function createDefaultLocalSelectionAuthority(localHostId: string) {
  const fleet = new InMemoryHostFleetSource({
    revision: 0,
    identityGeneration: 0,
    localHostId,
    hosts: [{ hostId: localHostId, kind: "local" as const }],
  });
  const identity = new InMemoryAuthorityIdentitySource(null);
  const mount = createInProcessSelectionAuthority({
    fleet,
    identity,
    localHostEnsure: unavailableLocalHostEnsurePort,
    localOutage: inertLocalHostOutageSignal,
    preferredStore: new InMemoryPreferredHostStore(),
    clock: systemAuthorityClock,
    newIncarnationId: createIncrementingIncarnationIds(),
    log: silentAuthorityLog,
  });
  fleet.publish(identity.current().generation, localHostId, [
    { hostId: localHostId, kind: "local" as const },
  ]);
  return mount.client;
}

/**
 * Fully-typed IRunnerHost no-op stub. Pass overrides for spies and doubles.
 */
export function createFakeRunnerHost(
  overrides: Partial<IRunnerHost>,
): IRunnerHost {
  const base: IRunnerHost = {
    browserView: null,
    signInUrl: "https://auth.example.invalid/sign-in",
    authnBaseUrl: "https://auth.example.invalid",
    relayBaseUrl: "wss://relay.example.invalid/attach",
    hasLocalHost: true,
    canCopyImages: true,
    validateAuthTokenIdentity: () =>
      Promise.resolve({ kind: "rejected" as const }),
    listRegisteredHosts: () =>
      Promise.resolve({ kind: "network-error" as const }),
    // Result-free idempotent fleet announcement. Override to republish a
    // snapshot.
    refreshHostFleet: () => Promise.resolve(),
    // `null` = this shell owns no registry cadence, so a consumer keeps its own
    // timer. The same answer the browser/dev topology gives.
    onRegisteredHostsChange: () => null,
    listUserSessions: () => Promise.resolve({ kind: "network-error" as const }),
    revokeUserSession: () =>
      Promise.resolve({ kind: "network-error" as const }),
    revokeAllSessions: () =>
      Promise.resolve({ kind: "network-error" as const }),
    mintHostCredential: () =>
      Promise.resolve({ kind: "network-error" as const }),
    requestStepUpChallenge: () =>
      Promise.resolve({ kind: "network-error" as const }),
    verifyStepUpChallenge: () =>
      Promise.resolve({ kind: "network-error" as const }),
    mintLinkLoginCode: () =>
      Promise.resolve({ kind: "network-error" as const }),
    linkLoginStatus: () => Promise.resolve({ kind: "network-error" as const }),
    respondLinkLogin: () => Promise.resolve({ kind: "network-error" as const }),
    linkCodeScanner: null,
    linkLoginDeepLinks: null,
    deviceDescriber: null,
    updateHostVersionPolicy: () =>
      Promise.resolve({ kind: "network-error" as const }),
    deregisterHostFromAccount: () =>
      Promise.resolve({ kind: "network-error" as const }),
    openExternalLink: () => Promise.resolve(),
    getRegisteredUrlSchemes: () => Promise.resolve([]),
    requestMicrophoneAccess: () => Promise.resolve("granted" as const),
    openMicrophoneSettings: () => Promise.resolve(),
    openFullDiskAccessSettings: () => Promise.resolve(),
    beginAuthAttempt: () => undefined,
    onAuthCallback: () => ({ dispose: () => undefined }),
    deviceFlow: { start: () => Promise.resolve(null) },
    secureStorage: {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    notifications: {
      systemSettings: null,
      show: () => Promise.resolve("presented" as const),
      onForegroundDisplay: () => ({ dispose: () => undefined }),
      onClick: () => ({ dispose: () => undefined }),
    },
    tray: {
      setEpics: () => Promise.resolve(),
      setIndicator: () => Promise.resolve(),
      onEpicSelected: () => ({ dispose: () => undefined }),
    },
    workspaceFolders: {
      canPickNatively: true,
      pickFolders: () => Promise.resolve([]),
    },
    fileDrops: {
      resolveDroppedFilePaths: () => Promise.resolve([]),
      copyDroppedFilePaths: (paths) => Promise.resolve(paths),
      readNativeClipboardFilePaths: () => Promise.resolve([]),
    },
    fileSave: null,
    tokenStore: {
      get: () => Promise.resolve(null),
      signIn: () => Promise.resolve(),
      rotate: () =>
        Promise.resolve({ outcome: "deleted" as const, pair: null }),
      delete: () => Promise.resolve(),
      deleteIfToken: () => Promise.resolve("kept" as const),
      subscribe: () => ({ dispose: () => undefined }),
      migrateLegacyCredentials: () =>
        Promise.resolve("identity-unknown" as const),
    },
    onLocalHostChange: () => ({ dispose: () => undefined }),
    onSystemResumed: () => ({ dispose: () => undefined }),
    onNetworkPathChanged: () => ({ dispose: () => undefined }),
    requestHostRespawn: () => Promise.resolve({ kind: "restarted" as const }),
    getLastKnownLocalHostId: () => Promise.resolve(null),
    service: null,
    traycerCli: null,
    migration: null,
    hostManagement: null,
    hostTray: null,
    // Default: attach-able in-window authority with one local host. Pass
    // createInertSelectionAuthorityClient() to assert detached/superseded UI.
    selectionAuthority: createDefaultLocalSelectionAuthority("fake-local-host"),
    zoom: null,
    // Desktop-shaped by default; a phone-shaped test passes its own
    // `pushPermission` double through `overrides`.
    pushPermission: null,
    // Likewise: a shell that raises an OS back request passes its own
    // `systemBack` double through `overrides`.
    systemBack: null,
  };
  return { ...base, ...overrides };
}

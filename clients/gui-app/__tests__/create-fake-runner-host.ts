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

/**
 * Browser/dev topology (D16): the same in-window authority engine
 * `MockRunnerHost` mounts, seeded with a single usable local host so app-boot
 * suites that render through `HostRuntimeProvider` get a real derivation
 * instead of the always-refused inert double - see the doc comment below.
 */
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
    validateAuthTokenIdentity: () =>
      Promise.resolve({ kind: "rejected" as const }),
    listRegisteredHosts: () =>
      Promise.resolve({ kind: "network-error" as const }),
    // The membership announcement the renderer makes when it observes a fleet
    // change (redesign P1.2 F6). Result-free and idempotent by contract, so
    // the inert default is the honest one; a test that cares overrides it to
    // republish its own snapshot, exactly as a real shell does.
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
    beginAuthAttempt: () => undefined,
    onAuthCallback: () => ({ dispose: () => undefined }),
    deviceFlow: { start: () => Promise.resolve(null) },
    secureStorage: {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    notifications: {
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
    // A real, attach-able in-window authority by default (D16) - the same
    // topology `MockRunnerHost` mounts - seeded with one usable local host,
    // so a suite that boots through `HostRuntimeProvider`/the selection
    // bridge without caring about selection still gets a real effective
    // host instead of silently binding nothing. A test that wants NO
    // authority (e.g. to assert the detached/superseded UI) passes
    // `createInertSelectionAuthorityClient()` through `overrides` instead.
    selectionAuthority: createDefaultLocalSelectionAuthority("fake-local-host"),
    zoom: null,
    // Desktop-shaped by default; a phone-shaped test passes its own
    // `pushPermission` double through `overrides`.
    pushPermission: null,
  };
  return { ...base, ...overrides };
}

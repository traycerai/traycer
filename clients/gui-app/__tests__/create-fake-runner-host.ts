import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { SelectionAuthorityClient } from "@traycer-clients/shared/host-selection/selection-authority-contract";
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
  type AuthorityClock,
} from "@traycer-clients/shared/host-selection/selection-authority-engine";

/**
 * The engine arms a deadline timer to retry a refused local ensure, and the
 * default authority's port refuses every ensure, so on a real clock the
 * authority would tick every 30 s for as long as its host lives. A suite that
 * drains its fake clock fires that timer and the engine arms the next, so the
 * clock never goes quiet. The fixture's authority arms nothing: its clock
 * reads the wall time and never schedules.
 */
const FIXTURE_AUTHORITY_CLOCK: AuthorityClock = {
  now: () => Date.now(),
  schedule: () => () => {},
};

/**
 * Browser/dev topology (D16): the same in-window authority engine
 * `MockRunnerHost` mounts, seeded with a single usable local host so app-boot
 * suites that render through `HostRuntimeProvider` get a real derivation
 * instead of the always-refused inert double - see the doc comment below.
 */
function createDefaultLocalSelectionAuthority(localHostId: string): {
  readonly client: SelectionAuthorityClient;
  readonly republish: () => void;
} {
  const fleet = new InMemoryHostFleetSource({
    revision: 0,
    identityGeneration: 0,
    localHostId,
    hosts: [{ hostId: localHostId, kind: "local" as const, teamOwned: false }],
  });
  const identity = new InMemoryAuthorityIdentitySource(null);
  const mount = createInProcessSelectionAuthority({
    fleet,
    identity,
    localHostEnsure: unavailableLocalHostEnsurePort,
    localOutage: inertLocalHostOutageSignal,
    preferredStore: new InMemoryPreferredHostStore(),
    clock: FIXTURE_AUTHORITY_CLOCK,
    newIncarnationId: createIncrementingIncarnationIds(),
    log: silentAuthorityLog,
  });
  fleet.publish(identity.current().generation, localHostId, [
    { hostId: localHostId, kind: "local" as const, teamOwned: false },
  ]);
  return {
    client: mount.client,
    // What a real shell's fleet refresh does when its read succeeds: publish
    // the fleet it read, here the one this authority already serves.
    republish: () => {
      const current = fleet.snapshot();
      fleet.publish(
        current.identityGeneration,
        current.localHostId,
        current.hosts,
      );
    },
  };
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
  const authorityOverride = overrides.selectionAuthority;
  // The default engine is built only when the test brings none of its own, so
  // an overriding test never gets a second engine it does not use. Without it
  // there is no fleet of its own to republish.
  const authority: {
    readonly client: SelectionAuthorityClient;
    readonly republish: (() => void) | null;
  } =
    authorityOverride === undefined
      ? createDefaultLocalSelectionAuthority("fake-local-host")
      : { client: authorityOverride, republish: null };
  const base: IRunnerHost = {
    browserView: null,
    sandboxArtifacts: null,
    signInUrl: "https://auth.example.invalid/sign-in",
    authnBaseUrl: "https://auth.example.invalid",
    relayBaseUrl: "wss://relay.example.invalid/attach",
    poolBaseUrl: "",
    hasLocalHost: true,
    sandboxControlUnavailableReason: null,
    canCopyImages: true,
    validateAuthTokenIdentity: () =>
      Promise.resolve({ kind: "rejected" as const }),
    listRegisteredHosts: () =>
      Promise.resolve({ kind: "network-error" as const }),
    // The membership announcement the renderer makes when it observes a fleet
    // change (redesign P1.2 F6). It republishes the default authority's own
    // fleet, so `published` is true of that authority; a test that overrides
    // `selectionAuthority` overrides this with it, exactly as a real shell
    // pairs the two.
    refreshHostFleet: () => {
      if (authority.republish === null) {
        return Promise.resolve({ kind: "unavailable" as const });
      }
      authority.republish();
      return Promise.resolve({ kind: "published" as const });
    },
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
    readHostOwnership: () => Promise.resolve({ kind: "unauthorized" as const }),
    listTeamComputers: () => Promise.resolve({ kind: "unauthorized" as const }),
    setEnvironmentBotHost: () =>
      Promise.resolve({ kind: "unauthorized" as const }),
    mintTeamComputerInstallToken: () =>
      Promise.resolve({ kind: "unauthorized" as const }),
    releaseTeamComputer: () =>
      Promise.resolve({ kind: "unauthorized" as const }),
    deregisterHostFromAccount: () =>
      Promise.resolve({ kind: "network-error" as const }),
    listSandboxes: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    getSandboxCosts: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    getSandboxCatalogue: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    getTraycerModels: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    createSandbox: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    destroySandbox: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    patchSandbox: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    keepSandbox: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    runSandboxVerb: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    // As a server without the route answers: no Automations entry anywhere.
    getSandboxAutomation: () =>
      Promise.resolve({
        kind: "ok" as const,
        automation: { available: false, sandbox: null, pods: [] },
      }),
    openSandboxAutomation: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    readSlackApp: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    getSlackAppManifest: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    registerSlackApp: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    mintSlackAppInstallUrl: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    disconnectSlackApp: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    setSlackAppDms: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    getSandboxGrants: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    getTeamEnvironment: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    getEnvironmentProviders: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    decideSecretRequest: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    mintExecutableWriteGrant: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
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
      showsEpics: true,
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
      getSignInStorageLow: () => Promise.resolve(false),
      subscribeSignInStorageLow: () => ({ dispose: () => undefined }),
      get: () => Promise.resolve(null),
      signIn: () => Promise.resolve("saved" as const),
      rotate: () =>
        Promise.resolve({
          outcome: "deleted" as const,
          pair: null,
          diskPressure: null,
          rejection: null,
        }),
      delete: () => Promise.resolve(),
      deleteIfToken: () => Promise.resolve("kept" as const),
      subscribe: () => ({ dispose: () => undefined }),
      migrateLegacyCredentials: () =>
        Promise.resolve("identity-unknown" as const),
    },
    onLocalHostChange: () => ({ dispose: () => undefined }),
    onLocalHostUnresponsive: (handler) => {
      handler(null);
      return { dispose: () => undefined };
    },
    onSystemResumed: () => ({ dispose: () => undefined }),
    onSystemSuspended: () => ({ dispose: () => undefined }),
    onVoiceTrayAction: () => ({ dispose: () => undefined }),
    onNetworkPathChanged: () => ({ dispose: () => undefined }),
    // Voice is off for a shell with no server behind it: the dormant answers.
    getVoiceAvailability: () =>
      Promise.resolve({
        kind: "ok" as const,
        available: false,
        voiceSelection: null,
      }),
    mintVoiceSession: () => Promise.resolve({ kind: "dormant" as const }),
    endVoiceSession: () =>
      Promise.resolve({ kind: "ok" as const, closedAt: null }),
    setVoiceSessionLive: () => Promise.resolve(),
    setVoiceSessionIndicator: () => Promise.resolve(),
    requestHostRespawn: () => Promise.resolve({ kind: "restarted" as const }),
    forceRestartUnresponsiveHost: () =>
      Promise.resolve({ kind: "restarted" as const }),
    getLastKnownLocalHostId: () => Promise.resolve(null),
    service: null,
    traycerCli: null,
    migration: null,
    hostManagement: null,
    hostTray: null,
    hostLifecycle: null,
    // A real, attach-able in-window authority by default (D16) - the same
    // topology `MockRunnerHost` mounts - seeded with one usable local host,
    // so a suite that boots through `HostRuntimeProvider`/the selection
    // bridge without caring about selection still gets a real effective
    // host instead of silently binding nothing. A test that wants NO
    // authority (e.g. to assert the detached/superseded UI) passes
    // `createInertSelectionAuthorityClient()` through `overrides` instead.
    selectionAuthority: authority.client,
    zoom: null,
    // Desktop-shaped by default; a phone-shaped test passes its own
    // `pushPermission` double through `overrides`.
    pushPermission: null,
    // A test of on-device dictation passes its own double through
    // `overrides`.
    deviceDictation: null,
    // Likewise: a shell that raises an OS back request passes its own
    // `systemBack` double through `overrides`.
    systemBack: null,
    // The iOS status-bar tap, passed the same way by a test that needs it.
    statusBarTap: null,
  };
  return { ...base, ...overrides };
}

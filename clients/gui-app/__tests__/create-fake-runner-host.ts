import {
  fetchEnvironmentTransport,
  type EnvironmentTransport,
  type EnvironmentTransportAnswer,
  type EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import { AuthService } from "@/lib/auth/auth-service";
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
 * The auth-facing part of the fake runner host. App readers use the real
 * `auth.listEnvironments()` and `auth.environmentCloud()` seams; these return
 * the fixture directory and send authn requests through the supplied fake
 * transport.
 */
export interface FakeEnvironmentCloudAuthOptions {
  readonly listEnvironments: () => Promise<EnvironmentDirectoryResult>;
  readonly transport: EnvironmentTransport;
}

export interface FakeEnvironmentCloudServicesOptions extends FakeEnvironmentCloudAuthOptions {
  readonly runnerHostOverrides: Partial<IRunnerHost>;
}

export interface FakeEnvironmentCloudServices {
  readonly auth: AuthService;
  readonly runnerHost: IRunnerHost;
}

export function createFakeEnvironmentCloudServices(
  options: FakeEnvironmentCloudServicesOptions,
): FakeEnvironmentCloudServices {
  const runnerHost = createFakeRunnerHost({
    ...options.runnerHostOverrides,
    listEnvironments: () => options.listEnvironments(),
    environmentTransport: options.transport,
  });
  const auth = new AuthService({ runnerHost });
  auth.listEnvironments = () => runnerHost.listEnvironments("test-bearer");
  auth.environmentCloud = () => ({
    authnBaseUrl: runnerHost.authnBaseUrl,
    bearer: {
      kind: "cloud",
      getBearerToken: () => "test-bearer",
    },
    transport: runnerHost.environmentTransport,
    onOriginSignIn: () => true,
  });
  return { auth, runnerHost };
}

export function createFakeEnvironmentCloudAuth(
  options: FakeEnvironmentCloudAuthOptions,
): AuthService {
  return createFakeEnvironmentCloudServices({
    ...options,
    runnerHostOverrides: {},
  }).auth;
}

/** Shared authn transport fake for the list join and settings reads. */
export function createFakeEnvironmentCloudTransport(options: {
  readonly environments: () => readonly EnvironmentDescriptorV11[];
  readonly onRequest?: (
    request: EnvironmentTransportRequest,
  ) =>
    | EnvironmentTransportAnswer
    | null
    | Promise<EnvironmentTransportAnswer | null>;
}): EnvironmentTransport {
  return async (request) => {
    const customAnswer = await options.onRequest?.(request);
    if (customAnswer !== null && customAnswer !== undefined) {
      return customAnswer;
    }
    return (
      answerEnvironmentHostRead(request, options.environments()) ??
      answerEnvironmentGetRead(request) ?? { status: 404, text: "{}" }
    );
  };
}

function answerEnvironmentHostRead(
  request: EnvironmentTransportRequest,
  environments: readonly EnvironmentDescriptorV11[],
): EnvironmentTransportAnswer | null {
  const url = new URL(request.url);
  const route =
    /\/api\/v3\/environments\/([^/]+)\/(hosts|members|review)$/u.exec(
      url.pathname,
    );
  if (route === null) return null;

  const environmentId = decodeURIComponent(route[1]);
  const row = environments.find(
    (environment) => environment.environmentId === environmentId,
  );
  switch (route[2]) {
    case "hosts":
      return jsonEnvironmentAnswer({
        hosts: url.searchParams.has("include")
          ? []
          : Array.from({ length: row?.hostCount ?? 0 }, () => ({
              purgePending: false,
            })),
      });
    case "members":
      if (row === undefined || row.providerHandle === null) {
        return { status: 404, text: "{}" };
      }
      return jsonEnvironmentAnswer({
        viewer: { effectiveRole: row.effectiveRole },
      });
    case "review":
      return jsonEnvironmentAnswer({ review: null });
    default:
      return null;
  }
}

function answerEnvironmentGetRead(
  request: EnvironmentTransportRequest,
): EnvironmentTransportAnswer | null {
  if (request.method !== "GET") return null;
  const pathname = new URL(request.url).pathname;
  const responses = [
    ["/items", { items: [] }],
    ["/revision", { revision: 0 }],
    ["/mcp-servers", { servers: [] }],
    ["/secrets/harness-connections", { connections: [] }],
    ["/secrets", { secrets: [], removed: [] }],
  ] as const;
  const match = responses.find(([suffix]) => pathname.endsWith(suffix));
  return match === undefined ? null : jsonEnvironmentAnswer(match[1]);
}

export function jsonEnvironmentAnswer(
  body: unknown,
): EnvironmentTransportAnswer {
  return { status: 200, text: JSON.stringify(body) };
}

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
    hosts: [{ hostId: localHostId, kind: "local" as const, teamOwned: false }],
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
    { hostId: localHostId, kind: "local" as const, teamOwned: false },
  ]);
  return mount.client;
}

/**
 * Shared `IRunnerHost` stub base for renderer/bridge-provider tests that need
 * a fully-typed host without the real desktop IPC/HTTP backing. Every field
 * here is a deterministic no-op; pass `overrides` for whatever a given test
 * actually exercises (spies, `hostTray`/`hostManagement` doubles, etc.).
 */
/** A token source that never mints: the fake has no verified sign-in. */
export function inertHostTokenSource(): HostTokenSource {
  return createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () => Promise.resolve({ kind: "no-sign-in" }),
    signIn: null,
    now: () => 0,
  });
}

/** A token source holding one live host-only token, so a door can open. */
export async function heldHostTokenSource(
  userId: string,
  hostId: string,
): Promise<HostTokenSource> {
  const tokens = inertHostTokenSource();
  await tokens.adopt(
    userId,
    hostId,
    {
      token: `host-token-${hostId}`,
      expiresAtMs: Date.now() + 3_600_000,
    },
    tokens.era(userId),
  );
  return tokens;
}

export function createFakeRunnerHost(
  overrides: Partial<IRunnerHost>,
): IRunnerHost {
  const base: IRunnerHost = {
    browserView: null,
    sandboxArtifacts: null,
    signInUrl: "https://auth.example.invalid/sign-in",
    authnBaseUrl: "https://auth.example.invalid",
    environmentTransport: fetchEnvironmentTransport,
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
    hostTokens: inertHostTokenSource(),
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
    mintTeamComputerInstallToken: () =>
      Promise.resolve({ kind: "unauthorized" as const }),
    releaseTeamComputer: () =>
      Promise.resolve({ kind: "unauthorized" as const }),
    deregisterHostFromAccount: () =>
      Promise.resolve({ kind: "network-error" as const }),
    listSandboxes: () =>
      Promise.resolve({ kind: "network-error" as const, detail: "fake" }),
    listEnvironments: () => Promise.resolve({ kind: "unauthorized" as const }),
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
      Promise.resolve({ kind: "ok" as const, available: false }),
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
    selectionAuthority: createDefaultLocalSelectionAuthority("fake-local-host"),
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

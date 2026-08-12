import { vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  HostAvailableSnapshot,
  HostControllerStatus,
  HostInstalledRecord,
  HostRegistryUpdateState,
  IHostManagement,
} from "@traycer-clients/shared/platform/runner-host";
import type { HostIdentity } from "@traycer/protocol/host/identity/index";
import type { HostGetInstallationInfoResponse } from "@traycer/protocol/host/maintenance/index";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";

/**
 * The Overview's whole RPC surface, over one in-memory `HostClient`.
 *
 * Mirrors `buildConfigHostFixture` (`host-config-rpc-test-support.ts`): a real
 * `HostClient` wired to an in-memory messenger, so writes exercise the real
 * `useHostQuery`/`useHostMutation` wiring rather than a hand-rolled stub. Every
 * handler is overridable per-call via `overrideHandlers`, which is how the
 * arm-time-capture suite parks a mutation on a promise it resolves by hand.
 */
export interface OverviewHostFixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  /** The identity this fixture is currently answering `host.identity.get` with. */
  readonly identity: () => HostIdentity;
  /** How many times `host.identity.set` was answered by this fixture. */
  readonly identitySetCalls: () => number;
  /** How many times `host.restart` was answered by this fixture. */
  readonly restartCalls: () => number;
  /** Every `transitionId` a `host.restart` request carried, in call order. */
  readonly restartTransitionIds: () => readonly string[];
  /** How many times `host.status` was answered — the released-floor method. */
  readonly hostStatusCalls: () => number;
}

export function buildOverviewHostFixture(options: {
  readonly hostId: string;
  readonly isLocalMachine: boolean;
  readonly effectiveName?: string;
  readonly customName?: string | null;
  readonly systemName?: string;
  readonly hostVersion?: string;
  readonly busySessionCount?: number;
  readonly installation?: HostGetInstallationInfoResponse;
  /**
   * Replaces (rather than merges into) individual method handlers after the
   * defaults are built — for a test that needs a pending/erroring RPC, or a
   * non-default outcome such as a busy restart or an externally-managed
   * update.
   */
  readonly overrideHandlers?: MockHandlerMap<HostRpcRegistry>;
}): OverviewHostFixture {
  let identity: HostIdentity = {
    systemName: options.systemName ?? options.hostId,
    customName: options.customName ?? null,
    effectiveName: options.effectiveName ?? options.hostId,
  };
  let hostStatusCalls = 0;
  let restartCalls = 0;
  let identitySetCalls = 0;
  const restartTransitionIds: string[] = [];

  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "host.status": () => {
      hostStatusCalls += 1;
      return {
        ready: true,
        hostVersion: options.hostVersion ?? "1.5.0",
        protocolVersion: { major: 1, minor: 1 },
        busy: false,
        busySessionCount: options.busySessionCount ?? 0,
        updateProgress: null,
      };
    },
    "host.identity.get": () => ({ ...identity }),
    "host.identity.set": (req) => {
      identitySetCalls += 1;
      identity = {
        ...identity,
        customName: req.customName,
        effectiveName: req.customName ?? identity.systemName,
      };
      return { ...identity };
    },
    "host.getInstallationInfo": () =>
      options.installation ?? { status: "unmanaged" as const },
    "host.restart": (req) => {
      restartCalls += 1;
      restartTransitionIds.push(req.transitionId);
      return { outcome: "accepted" as const };
    },
    "host.doctor": () => ({
      status: "ok" as const,
      issues: [],
      triviallyGreenIssueCodes: [],
    }),
    "host.update.check": () => ({
      outcome: "ok" as const,
      manifest: {
        schemaVersion: 1 as const,
        generatedAt: "2026-08-12T00:00:00Z",
        latest: options.hostVersion ?? "1.5.0",
        versions: [],
      },
    }),
    "host.update.install": () => ({ outcome: "accepted" as const }),
    "diagnostics.logs.tail": () => ({
      status: "available" as const,
      target: "host" as const,
      path: "/tmp/host.log",
      lines: [],
      truncated: false,
    }),
  };

  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${options.hostId}`,
      handlers: { ...handlers, ...options.overrideHandlers },
    }),
  });

  const entry: HostDirectoryEntry = {
    hostId: options.hostId,
    label: options.hostId,
    kind: options.isLocalMachine ? "local" : "remote",
    websocketUrl: options.isLocalMachine
      ? "ws://127.0.0.1:0"
      : "wss://mock-remote.invalid/rpc",
    version: options.hostVersion ?? "1.5.0",
    status: "available",
  };
  client.bind(entry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );

  return {
    client,
    hostId: options.hostId,
    identity: () => identity,
    identitySetCalls: () => identitySetCalls,
    restartCalls: () => restartCalls,
    restartTransitionIds: () => [...restartTransitionIds],
    hostStatusCalls: () => hostStatusCalls,
  };
}

const NOT_INSTALLED_CONTROLLER_STATUS: HostControllerStatus = {
  download: null,
  mutation: null,
  installedVersion: null,
  latestVersion: null,
  stagedVersion: null,
  installedRuntimeVersion: null,
  runningRuntimeVersion: null,
  updateReady: false,
  activation: "unavailable",
  reachable: false,
  removedByUser: false,
  checkedAt: "2026-08-12T00:00:00Z",
};

/**
 * The local CLI bridge (`IHostManagement`) for the recovery-console suite.
 *
 * Mirrors `makeManagement` in `host-settings-panel-mutations.test.tsx` (read
 * for the pattern, not imported — that file is owned by another concurrent
 * writer). Every method is stubbed with a benign default so the recovery
 * console can mount without every query rejecting; `installedRecord` is the
 * one override that matters for these tests, since `deriveStatus` reads it to
 * tell "stopped" (a record exists) from "not installed" (`null`).
 */
export function buildOverviewManagement(
  overrides: Partial<IHostManagement>,
): IHostManagement {
  const notImplemented = (method: string) => (): Promise<never> =>
    Promise.reject(new Error(`${method} not implemented in mock`));
  return {
    getHostControllerStatus: vi.fn(() =>
      Promise.resolve(NOT_INSTALLED_CONTROLLER_STATUS),
    ),
    convergeReady: vi.fn(notImplemented("convergeReady")),
    applyStaged: vi.fn(notImplemented("applyStaged")),
    activateInstalled: vi.fn(notImplemented("activateInstalled")),
    installVersion: vi.fn(notImplemented("installVersion")),
    uninstallHost: vi.fn(notImplemented("uninstallHost")),
    uninstallTraycer: vi.fn(notImplemented("uninstallTraycer")),
    getRemovalState: vi.fn(() => Promise.resolve({ removedByUser: false })),
    clearRemoval: vi.fn(() => Promise.resolve()),
    restartHost: vi.fn(() => Promise.resolve({ kind: "restarted" as const })),
    getHostLogs: vi.fn(() => Promise.resolve({ path: null, tail: "" })),
    runDoctor: vi.fn(() =>
      Promise.resolve({ issues: [], ranAt: "2026-08-12T00:00:00Z" }),
    ),
    availableVersions: vi.fn(() =>
      Promise.resolve<HostAvailableSnapshot>({
        generatedAt: "2026-08-12T00:00:00Z",
        latest: "1.5.0",
        platformKey: "darwin-arm64",
        manifestUrl: "",
        versions: [],
      }),
    ),
    installedRecord: vi.fn(() => Promise.resolve(null)),
    registerService: vi.fn(notImplemented("registerService")),
    deregisterService: vi.fn(() => Promise.resolve()),
    registryCheck: vi.fn(() =>
      Promise.resolve<HostRegistryUpdateState>({
        checkedAt: null,
        latestVersion: null,
        installedVersion: null,
        updateAvailable: false,
        reachable: false,
        errorMessage: null,
      }),
    ),
    freePortAndRestart: vi.fn((input) => Promise.resolve(input)),
    cliManifest: vi.fn(() => Promise.resolve(null)),
    getHostName: vi.fn(() =>
      Promise.resolve({
        systemName: "recovery-host",
        customName: null,
        effectiveName: "recovery-host",
      }),
    ),
    setHostName: vi.fn((input: { readonly customName: string | null }) =>
      Promise.resolve({
        systemName: "recovery-host",
        customName: input.customName,
        effectiveName: input.customName ?? "recovery-host",
      }),
    ),
    // Spread LAST, over the whole interface rather than field by field. The
    // old shape admitted exactly two overridable methods, so a test needing a
    // third had to edit this shared fixture - which every other suite then
    // inherits.
    ...overrides,
  };
}

export function makeInstalledRecord(version: string): HostInstalledRecord {
  return {
    version,
    installedAt: "2026-08-10T00:00:00Z",
    executablePath: `/tmp/traycer/${version}/host`,
    source: { kind: "registry", value: version },
    archiveSha256: "abc",
    signatureKeyId: "key",
    sizeBytes: 1024,
    signatureVerifiedAt: "2026-08-10T00:00:00Z",
    platform: "darwin",
    arch: "arm64",
  };
}

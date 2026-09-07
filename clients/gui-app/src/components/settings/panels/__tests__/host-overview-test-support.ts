import { useEffect } from "react";
import { vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useMutation } from "@tanstack/react-query";
import {
  HostClient,
  type IHostQueryInvalidator,
} from "@traycer-clients/shared/host-client/host-client";
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
  HostRestartRequestResult,
  IHostManagement,
} from "@traycer-clients/shared/platform/runner-host";
import { runnerMutationKeys } from "@/lib/query-keys/runner-mutation-keys";
import type { HostIdentity } from "@traycer/protocol/host/identity/index";
import type {
  HostAvailableManifest,
  HostGetInstallationInfoResponseV11,
} from "@traycer/protocol/host/maintenance/index";
import type { HostBusyBreakdown } from "@traycer/protocol/host/status/index";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";

/** Every handler is overridable per-call via `overrideHandlers`, which is how the arm-time-capture suite parks
 * a mutation on a promise it resolves by hand. */
export interface OverviewHostFixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  readonly identity: () => HostIdentity;
  readonly identitySetCalls: () => number;
  readonly restartCalls: () => number;
  readonly restartTransitionIds: () => readonly string[];
  readonly hostStatusCalls: () => number;
}

/** `fireEvent.click` on it silently does nothing. */
export async function openHostOverviewMenu(): Promise<void> {
  fireEvent.pointerDown(await screen.findByTestId("host-overview-menu"), {
    button: 0,
  });
  await screen.findByTestId("host-overview-restart");
}

/** Shared by the doctor-fixes and local-maintenance-fallback suites: both pin how the panel reacts to a restart
 * that some other surface started (the pending flag, the disabled states). */
export function ExternalHostRestartTrigger(props: {
  readonly mutationFn: () => Promise<HostRestartRequestResult>;
  readonly onReady: (mutate: () => void) => void;
}): null {
  const { mutate } = useMutation({
    mutationKey: runnerMutationKeys.hostRestart(),
    mutationFn: props.mutationFn,
  });
  const { onReady } = props;
  useEffect(() => {
    onReady(() => {
      mutate();
    });
  }, [mutate, onReady]);
  return null;
}

/** Awaited on the heading rather than a control, because which controls are present is exactly what the callers
 * vary. */
export async function openHostOverviewAdvanced(): Promise<void> {
  const trigger = await screen.findByRole("button", { name: "Advanced" });
  fireEvent.click(trigger);
  // Settled on the trigger's own `data-state`, not on any control inside.
  await waitFor(() => {
    if (trigger.getAttribute("data-state") !== "open") {
      throw new Error("Advanced disclosure did not open");
    }
  });
}

export function buildOverviewHostFixture(options: {
  readonly hostId: string;
  readonly isLocalMachine: boolean;
  readonly effectiveName?: string;
  readonly customName?: string | null;
  readonly systemName?: string;
  readonly hostVersion?: string;
  readonly busy?: boolean;
  readonly busySessionCount?: number;
  readonly busyBreakdown?: HostBusyBreakdown | null;
  readonly installation?: HostGetInstallationInfoResponseV11;
  /** Replaces (rather than merges into) individual method handlers after the defaults are built. */
  readonly overrideHandlers?: MockHandlerMap<HostRpcRegistry>;
  /** Wired into the fixture's `HostClient` so a test can fire `notifyHostAvailabilityRecovered` against the real
   * query-invalidation port. */
  readonly invalidator?: IHostQueryInvalidator;
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
        protocolVersion: {
          major: 1,
          minor: options.busyBreakdown === undefined ? 1 : 2,
        },
        busy: options.busy ?? false,
        busySessionCount: options.busySessionCount ?? 0,
        updateProgress: null,
        busyBreakdown: options.busyBreakdown ?? null,
        // `null` = this fixture's host did not report the durable attempt,
        // which is exactly what host.status@1.2-and-older peers send.
        updateOperation: null,
        updateTransaction: null,
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
      effectiveIncludePreReleases: false,
      includePreReleasesSource: "stable-default" as const,
      manifest: {
        schemaVersion: 1 as const,
        generatedAt: "2026-08-12T00:00:00Z",
        latest: options.hostVersion ?? "1.5.0",
        versions: [],
      },
    }),
    "host.update.install": () => ({
      outcome: "accepted" as const,
      attemptId: null,
    }),
    // Left unanswered, the query rejects and every suite that opens Advanced would read the "couldn't be read"
    // copy - a fixture gap that would look like a product state.
    "host.service.status": () => ({
      outcome: "ok" as const,
      state: "running" as const,
      label: "ai.traycer.host",
      manifestPath: "/tmp/ai.traycer.host.plist",
    }),
    "host.service.register": () => ({ outcome: "ok" as const }),
    "host.service.deregister": () => ({ outcome: "accepted" as const }),
    "diagnostics.logs.tail": () => ({
      status: "available" as const,
      target: "host" as const,
      path: "/tmp/host.log",
      lines: [],
      truncated: false,
    }),
  };

  const entry: HostDirectoryEntry = {
    hostId: options.hostId,
    label: options.hostId,
    kind: options.isLocalMachine ? "local" : "remote",
    websocketUrl: options.isLocalMachine
      ? "ws://127.0.0.1:0"
      : "wss://mock-remote.invalid/rpc",
    version: options.hostVersion ?? "1.5.0",
    transportDialability: "dialable",
  };
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: options.invalidator ?? {
      invalidateHostScope: () => undefined,
    },
    // Required for the requester below: `captureAuthority` re-resolves a requester's entry against the live
    // directory and refuses one it cannot find.
    findHostById: (hostId) => (hostId === entry.hostId ? entry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${options.hostId}`,
      handlers: { ...handlers, ...options.overrideHandlers },
    }),
  });

  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );

  return {
    // The exported shape is unchanged - a requester is a `HostClient<HostRpcRegistry>` and forwards every request
    // to the spine below, so the per-fixture RPC counters this module hands out keep counting the same calls.
    client: client.createRequester(entry),
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
  localAttempt: null,
  removedByUser: false,
  checkedAt: "2026-08-12T00:00:00Z",
};

/** Mirrors `makeManagement` in `host-settings-panel-mutations.test.tsx` (read for the pattern, not imported -
 * that file is owned by another concurrent writer). */
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
    runDoctor: vi.fn((_input: { readonly expectedHostId: string }) =>
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
    runDoctorRepairQueued: vi.fn(() =>
      Promise.resolve({ kind: "applied" as const }),
    ),
    freePortAndRestartIfIdle: vi.fn((_input) =>
      Promise.resolve({
        kind: "dispatched" as const,
        outcome: { kind: "ok" as const, value: null },
      }),
    ),
    cliManifest: vi.fn(() => Promise.resolve(null)),
    maintenanceUpdateCheck: vi.fn(notImplemented("maintenanceUpdateCheck")),
    maintenanceDoctor: vi.fn(notImplemented("maintenanceDoctor")),
    maintenanceInstallationInfo: vi.fn(
      notImplemented("maintenanceInstallationInfo"),
    ),
    maintenanceInstallVersion: vi.fn(
      notImplemented("maintenanceInstallVersion"),
    ),
    restartHostIfIdle: vi.fn(notImplemented("restartHostIfIdle")),
    runDoctorRepairIfIdle: vi.fn(notImplemented("runDoctorRepairIfIdle")),
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
    // Spread last, over the whole interface rather than field by field.
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

/** `platforms` deliberately holds exactly one key, matching what a current CLI emits. */
export function updateCheckManifest(version: string): HostAvailableManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-12T00:00:00Z",
    latest: version,
    versions: [
      {
        version,
        releasedAt: "2026-08-12T00:00:00Z",
        releaseNotesUrl: "https://example.invalid/notes",
        yanked: false,
        deprecationReason: null,
        requiredCliVersion: null,
        platforms: {
          "darwin-arm64": {
            available: true,
            unavailableReason: null,
            url: "https://example.invalid/host.tar.gz",
            sizeBytes: 1024,
            sha256: "a".repeat(64),
            signatureUrl: "https://example.invalid/host.tar.gz.minisig",
            signatureAlgorithm: "minisign",
            publicKeyId: "key-1",
          },
        },
      },
    ],
  };
}

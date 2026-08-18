import { vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
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
import type {
  HostAvailableManifest,
  HostGetInstallationInfoResponse,
} from "@traycer/protocol/host/maintenance/index";
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

/**
 * Open the Overview card's `⋯` menu and wait for its items to mount.
 *
 * Restart, Run doctor, Reset name and Copy host ID moved off a footer verb bar
 * into this menu, so none of those test ids exists in the tree until it is
 * open. Two ways to get this wrong, both of which fail as "element not found"
 * and read like the control was DELETED rather than merely not yet mounted:
 *
 *  - Radix's trigger opens on POINTERDOWN, not click. `fireEvent.click` on it
 *    silently does nothing.
 *  - The menu portals asynchronously, so the item lookup has to be awaited.
 *
 * Awaiting `host-overview-restart` here is what makes a caller's subsequent
 * `getByTestId` safe.
 */
export async function openHostOverviewMenu(): Promise<void> {
  fireEvent.pointerDown(await screen.findByTestId("host-overview-menu"), {
    button: 0,
  });
  await screen.findByTestId("host-overview-restart");
}

/**
 * Open the Updates card's **Advanced** disclosure and wait for its body.
 *
 * The auto-update switch, the OS service controls and the whole version picker
 * live behind it, and Radix does not MOUNT `CollapsibleContent` while closed —
 * so before this runs, none of them is in the DOM at all. The failure mode is
 * the same trap as the `⋯` menu above: `queryByRole("switch")` returns null and
 * reads as "the control was deleted" rather than "the drawer is shut".
 *
 * Awaited on the heading rather than a control, because which controls are
 * present is exactly what the callers vary — a host with no registry row has no
 * policy switch, and one that cannot answer `host.service.status` has no service
 * buttons. The heading is the one thing every open Advanced section has.
 */
export async function openHostOverviewAdvanced(): Promise<void> {
  const trigger = await screen.findByRole("button", { name: "Advanced" });
  fireEvent.click(trigger);
  // Settled on the TRIGGER's own `data-state`, not on any control inside.
  // Which controls the drawer holds is exactly what callers vary — an
  // unreachable host has no version picker, a host with no registry row has no
  // policy switch, an old host has no service buttons — so waiting on one of
  // them would make this helper quietly wrong for the cases that matter most.
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
    // Answered by default so the Advanced disclosure's OS service section
    // renders its normal shape. Left unanswered, the query rejects and every
    // suite that opens Advanced would read the "couldn't be read" copy — a
    // fixture gap that would look like a product state.
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
    invalidator: { invalidateHostScope: () => undefined },
    // REQUIRED for the requester below: `captureAuthority` re-resolves a
    // requester's entry against the live directory and refuses one it cannot
    // find. `bind()` used to satisfy that lookup through the client's own
    // slot-reading fallback.
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
    // A requester pinned to this fixture's host, where `bind()` used to put
    // the same host in the client's slot. The EXPORTED SHAPE is unchanged - a
    // requester is a `HostClient<HostRpcRegistry>` and forwards every request
    // to the spine below, so the per-fixture RPC counters this module hands
    // out keep counting the same calls.
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

/**
 * A `host.update.check` manifest carrying one installable version.
 *
 * `versions` is what the Overview's list renders, so a suite that stubs the
 * check with an EMPTY array has no Install row to click — which is how four
 * install-path tests stopped reaching the RPC they were about the moment the
 * single "Update to v…" button became a list.
 *
 * `platforms` deliberately holds exactly ONE key, matching what a current CLI
 * emits: `host available --json` projects every entry to
 * `currentHostPlatformKey()` before printing it, and the client takes a sole
 * key as the host's own answer rather than re-deriving one.
 */
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

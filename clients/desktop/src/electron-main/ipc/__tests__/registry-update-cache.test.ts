import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcHostController } from "../runner-ipc-bridge";
import type { HostControllerStatus } from "../../host/host-controller-types";
import { DEV_DESKTOP_SLOT_ENV } from "../../host/dev-desktop-slot";
import { registerHostControllerStatusBroadcast } from "../host-controller-status-broadcast";
import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";

// `refreshRegistryUpdateState` is the launch-time host registry
// probe (Flow 6). It owns the 24h cache the tray + Settings + banner
// all read from. Behaviour we pin here:
//
//   - Fresh successful cache (< 24h) short-circuits without hitting the CLI.
//   - Stale cache (>= 24h) re-probes through the CLI.
//   - Failed cache entries re-probe on the next launch so repo/tag migrations
//     don't leave Settings showing stale 404s for the full TTL.
//   - `force: true` always re-probes.
//   - Registry failures are non-blocking: the cache file still
//     gets written with `reachable: false` so Settings can render the
//     `Last checked: failed` chip and the banner stays silent.
//   - Update availability is derived from installed != latest only
//     when both are present and reachable.

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp"),
    isPackaged: false,
    getAppPath: vi.fn(() => "/tmp"),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info", resolvePathFn: vi.fn() } },
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  transports: { file: { level: "info", resolvePathFn: vi.fn() } },
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

interface RegistryProbeFixture {
  readonly manifest: RegistryManifestFixture;
  readonly platformKey: string;
  readonly manifestUrl: string;
}

interface RegistryManifestFixture {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly latest: string;
  readonly versions: readonly RegistryVersionFixture[];
}

interface RegistryVersionFixture {
  readonly version: string;
  readonly releasedAt: string;
  readonly releaseNotesUrl: string;
  readonly yanked: boolean;
  readonly deprecationReason: string | null;
  readonly requiredCliVersion: string | null;
  readonly platforms: Readonly<Record<string, RegistryPlatformAssetFixture>>;
}

interface RegistryPlatformAssetFixture {
  readonly available: boolean;
  readonly unavailableReason: string | null;
  readonly url: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly signatureUrl: string;
  readonly signatureAlgorithm: "minisign";
  readonly publicKeyId: string;
}

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-registry-cache-"));
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_USERPROFILE === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  }
  rmSync(workHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock("../../cli/traycer-cli");
});

function writeCache(opts: {
  readonly checkedAt: string;
  readonly latestVersion: string | null;
  readonly installedVersion: string | null;
  readonly reachable: boolean;
  readonly errorMessage: string | null;
  readonly environment?: "production" | "dev";
}): void {
  const environment = opts.environment ?? "production";
  const dir = join(workHome, ".traycer", "desktop");
  mkdirSync(dir, { recursive: true });
  // production has no suffix; dev/staging nest under their name.
  const fileName =
    environment === "production"
      ? "registry-update-cache.json"
      : `registry-update-cache-${environment}.json`;
  writeFileSync(
    join(dir, fileName),
    JSON.stringify({ ...opts, environment }),
    "utf8",
  );
}

function registryProbeResult(
  latest: string,
  assetAvailable: boolean,
  unavailableReason: string | null,
): RegistryProbeFixture {
  return {
    manifest: {
      schemaVersion: 1,
      generatedAt: "2026-05-15T00:00:00Z",
      latest,
      versions: [registryVersion(latest, assetAvailable, unavailableReason)],
    },
    platformKey: "darwin-arm64",
    manifestUrl: "https://example.invalid/versions.json",
  };
}

function registryVersion(
  version: string,
  assetAvailable: boolean,
  unavailableReason: string | null,
): RegistryVersionFixture {
  return {
    version,
    releasedAt: "2026-05-15T00:00:00Z",
    releaseNotesUrl: "https://example.invalid/release-notes",
    yanked: false,
    deprecationReason: null,
    requiredCliVersion: null,
    platforms: {
      "darwin-arm64": {
        available: assetAvailable,
        unavailableReason,
        url: "https://example.invalid/host.tar.gz",
        sizeBytes: 1024,
        sha256: "abc",
        signatureUrl: "https://example.invalid/host.tar.gz.minisig",
        signatureAlgorithm: "minisign",
        publicKeyId: "test-key",
      },
    },
  };
}

function writeInstallRecord(
  environment: "production" | "dev",
  version: string,
): void {
  const dir =
    environment === "dev"
      ? join(workHome, ".traycer", "host", "dev", "install")
      : join(workHome, ".traycer", "host", "install");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "install.json"),
    JSON.stringify({
      version,
      installedAt: "2026-05-15T00:00:00Z",
      executablePath: `/tmp/traycer/${version}/host`,
      source: { kind: "registry", value: version },
      archiveSha256: "abc",
      signatureKeyId: "test-key",
      sizeBytes: 1024,
      signatureVerifiedAt: "2026-05-15T00:00:00Z",
      platform: "darwin",
      arch: "arm64",
    }),
    "utf8",
  );
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolveValue: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}

// Fixup B1: `refreshRegistryUpdateState` now takes an explicit
// `IpcHostController` - `updateAvailable` is projected from its
// `getStatus().updateReady` (bytes actually staged), not derived from the
// registry probe's raw installed/latest comparison anymore, and a
// successful fresh probe now triggers `stageLatest()` in the background.
// This file is about the CACHE/PROBE mechanics, not the controller's own
// staging decision (that's `host-controller.test.ts`'s job) - `updateReady`
// is just a fixed, test-controlled input here.
function fakeHostController(updateReady: boolean): IpcHostController & {
  readonly stageLatestCalls: number[];
  setUpdateReady(updateReady: boolean): void;
} {
  const stageLatestCalls: number[] = [];
  let currentUpdateReady = updateReady;
  return {
    get stageLatestCalls() {
      return stageLatestCalls;
    },
    async getStatus(): Promise<HostControllerStatus> {
      return {
        download: null,
        mutation: null,
        installedVersion: null,
        latestVersion: null,
        stagedVersion: null,
        installedRuntimeVersion: null,
        runningRuntimeVersion: null,
        updateReady: currentUpdateReady,
        activation: "unavailable",
        reachable: false,
        removedByUser: false,
        checkedAt: new Date().toISOString(),
      };
    },
    async stageLatest(): Promise<void> {
      stageLatestCalls.push(1);
    },
    setUpdateReady(nextUpdateReady: boolean): void {
      currentUpdateReady = nextUpdateReady;
    },
    convergeReady: () => {
      throw new Error(
        "fakeHostController.convergeReady: not used by these tests",
      );
    },
    applyStaged: () => {
      throw new Error(
        "fakeHostController.applyStaged: not used by these tests",
      );
    },
    activateInstalled: () => {
      throw new Error(
        "fakeHostController.activateInstalled: not used by these tests",
      );
    },
    installVersion: () => {
      throw new Error(
        "fakeHostController.installVersion: not used by these tests",
      );
    },
    registerService: () => {
      throw new Error(
        "fakeHostController.registerService: not used by these tests",
      );
    },
    deregisterService: () => {
      throw new Error(
        "fakeHostController.deregisterService: not used by these tests",
      );
    },
    respawn: () => {
      throw new Error("fakeHostController.respawn: not used by these tests");
    },
    recoverIfDown: () => {
      throw new Error(
        "fakeHostController.recoverIfDown: not used by these tests",
      );
    },
    freePortAndRestart: () => {
      throw new Error(
        "fakeHostController.freePortAndRestart: not used by these tests",
      );
    },
    uninstallHost: () => {
      throw new Error(
        "fakeHostController.uninstallHost: not used by these tests",
      );
    },
    removeTraycer: () => {
      throw new Error(
        "fakeHostController.removeTraycer: not used by these tests",
      );
    },
    isPendingRevisionRefreshQuarantined: () => false,
    onMutationProgress: () => () => undefined,
  };
}

// Pre-Ticket 398e84f4 cache layout. Used to assert that an upgraded
// Desktop ignores the legacy unscoped file rather than projecting it
// through as either environment's state.
describe("refreshRegistryUpdateState - launch-time probe", () => {
  it("returns cached state without probing when cache is fresh", async () => {
    const probeSpy = vi.fn();
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    writeCache({
      checkedAt: new Date().toISOString(),
      latestVersion: "1.4.2",
      installedVersion: "1.4.1",
      reachable: true,
      errorMessage: null,
    });
    const { refreshRegistryUpdateState } =
      await import("../host-management-ipc");
    const state = await refreshRegistryUpdateState(fakeHostController(true), {
      force: false,
      maxAgeMs: null,
    });
    expect(probeSpy).not.toHaveBeenCalled();
    expect(state.updateAvailable).toBe(true);
    expect(state.latestVersion).toBe("1.4.2");
    expect(state.installedVersion).toBe("1.4.1");
  });

  // Renderer surfaces cutover (Host Update Layer Redesign): the in-process
  // `onHostRegistryUpdateStateChange` listener this pair exercised was the
  // push side-channel for the old registry-only `HostRegistryUpdateState`
  // model and has been retired along with it - `host-management-ipc.ts` no
  // longer exports it. Every renderer surface now reads the canonical
  // two-lane `HostControllerStatus` from `host-controller-status-broadcast.ts`
  // instead, which re-reads `hostController.getStatus()` fresh on every tick
  // rather than replaying a captured value, so "does a refresh notify
  // listeners" and "does a throwing listener still let refresh succeed" no
  // longer have a production analogue to test.

  it("re-probes when force is true even with a fresh cache", async () => {
    const probeSpy = vi
      .fn()
      .mockResolvedValue(registryProbeResult("1.4.3", true, null));
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    writeCache({
      checkedAt: new Date().toISOString(),
      latestVersion: "1.4.2",
      installedVersion: "1.4.1",
      reachable: true,
      errorMessage: null,
    });
    const { refreshRegistryUpdateState } =
      await import("../host-management-ipc");
    const state = await refreshRegistryUpdateState(fakeHostController(false), {
      force: true,
      maxAgeMs: null,
    });
    expect(probeSpy).toHaveBeenCalledOnce();
    expect(state.latestVersion).toBe("1.4.3");
  });

  it("P6: republishes updateReady false to true after the background stage lands", async () => {
    vi.useFakeTimers();
    const probeSpy = vi
      .fn()
      .mockResolvedValue(registryProbeResult("1.4.3", true, null));
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    const controller = fakeHostController(false);
    controller.stageLatest = async (): Promise<void> => {
      controller.setUpdateReady(true);
    };
    const fanOutCalls: Array<readonly [string, HostControllerStatus]> = [];
    const bridge = {
      options: { hostController: controller },
      disposeFns: [] as Array<() => void>,
      fanOut(channel: string, payload: HostControllerStatus): void {
        fanOutCalls.push([channel, payload]);
      },
    };
    registerHostControllerStatusBroadcast(bridge as never);
    const { refreshRegistryUpdateState } =
      await import("../host-management-ipc");

    const beforeStage = await refreshRegistryUpdateState(controller, {
      force: true,
      maxAgeMs: null,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(beforeStage.updateAvailable).toBe(false);
    expect(fanOutCalls).toContainEqual([
      RunnerHostEvent.hostControllerStatusChange,
      expect.objectContaining({ updateReady: true }),
    ]);
    for (const dispose of bridge.disposeFns) dispose();
    vi.useRealTimers();
  });

  it("re-probes when cache is stale (>= 24h)", async () => {
    const probeSpy = vi
      .fn()
      .mockResolvedValue(registryProbeResult("1.4.3", true, null));
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    // 48h old
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeCache({
      checkedAt: old,
      latestVersion: "1.4.0",
      installedVersion: null,
      reachable: true,
      errorMessage: null,
    });
    const { refreshRegistryUpdateState } =
      await import("../host-management-ipc");
    const state = await refreshRegistryUpdateState(fakeHostController(false), {
      force: false,
      maxAgeMs: null,
    });
    expect(probeSpy).toHaveBeenCalledOnce();
    expect(state.latestVersion).toBe("1.4.3");
  });

  // Ticket: host-update-race-conditions - the periodic/resume re-check
  // (desktop-startup.ts) passes a much shorter `maxAgeMs` than the default
  // 24h TTL so a long-running session (or a machine waking from sleep)
  // notices a new release without requiring a relaunch or a manual click.
  it("maxAgeMs overrides the default 24h TTL - a 2h-old cache re-probes under a 1h threshold", async () => {
    const probeSpy = vi
      .fn()
      .mockResolvedValue(registryProbeResult("1.4.3", true, null));
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeCache({
      checkedAt: twoHoursAgo,
      latestVersion: "1.4.0",
      installedVersion: null,
      reachable: true,
      errorMessage: null,
    });
    const { refreshRegistryUpdateState } =
      await import("../host-management-ipc");
    const state = await refreshRegistryUpdateState(fakeHostController(false), {
      force: false,
      maxAgeMs: 60 * 60 * 1000,
    });
    expect(probeSpy).toHaveBeenCalledOnce();
    expect(state.latestVersion).toBe("1.4.3");
  });

  it("maxAgeMs still honours a fresh cache - a 2h-old cache under a 4h threshold does not re-probe", async () => {
    const probeSpy = vi.fn();
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeCache({
      checkedAt: twoHoursAgo,
      latestVersion: "1.4.2",
      installedVersion: "1.4.1",
      reachable: true,
      errorMessage: null,
    });
    const { refreshRegistryUpdateState } =
      await import("../host-management-ipc");
    const state = await refreshRegistryUpdateState(fakeHostController(false), {
      force: false,
      maxAgeMs: 4 * 60 * 60 * 1000,
    });
    expect(probeSpy).not.toHaveBeenCalled();
    expect(state.latestVersion).toBe("1.4.2");
  });

  it("does not advertise latest when the platform asset is unavailable", async () => {
    writeInstallRecord("production", "1.4.1");
    const probeSpy = vi
      .fn()
      .mockResolvedValue(
        registryProbeResult(
          "1.4.3",
          false,
          "Build unavailable for this platform.",
        ),
      );
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));

    const { refreshRegistryUpdateState } =
      await import("../host-management-ipc");
    const state = await refreshRegistryUpdateState(fakeHostController(false), {
      force: true,
      maxAgeMs: null,
    });

    expect(state.latestVersion).toBeNull();
    expect(state.installedVersion).toBe("1.4.1");
    expect(state.updateAvailable).toBe(false);
  });

  it("serializes concurrent registry refreshes", async () => {
    writeInstallRecord("production", "1.4.1");
    const firstProbe = deferred<RegistryProbeFixture>();
    const firstProbeStarted = deferred<void>();
    const probeSpy = vi
      .fn()
      .mockImplementationOnce(() => {
        firstProbeStarted.resolve(undefined);
        return firstProbe.promise;
      })
      .mockResolvedValueOnce(registryProbeResult("1.4.2", true, null));
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    const { refreshRegistryUpdateState } =
      await import("../host-management-ipc");

    const first = refreshRegistryUpdateState(fakeHostController(false), {
      force: true,
      maxAgeMs: null,
    });
    await firstProbeStarted.promise;
    const second = refreshRegistryUpdateState(fakeHostController(false), {
      force: true,
      maxAgeMs: null,
    });

    expect(probeSpy).toHaveBeenCalledTimes(1);
    firstProbe.resolve(registryProbeResult("1.4.2", true, null));
    await first;
    await second;
    expect(probeSpy).toHaveBeenCalledTimes(2);
  });

  it("treats registry failures as non-blocking and records reachable=false", async () => {
    const probeSpy = vi
      .fn()
      .mockRejectedValue(new Error("registry unreachable: network"));
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    const { refreshRegistryUpdateState } =
      await import("../host-management-ipc");
    const state = await refreshRegistryUpdateState(fakeHostController(false), {
      force: false,
      maxAgeMs: null,
    });
    expect(state.reachable).toBe(false);
    expect(state.updateAvailable).toBe(false);
    expect(state.errorMessage).toContain("registry unreachable");
  });

  // Fixup B1: `updateAvailable` is now a pure projection of
  // `HostController.getStatus().updateReady` (bytes actually staged) - the
  // registry probe's own installed/latest comparison (still exercised via
  // `latestVersion`/`installedVersion` above, and via `compareHostVersions`'s
  // own dedicated suite in `clients/shared/host-version/`) no longer feeds
  // `updateAvailable` at all. These two cases prove real decoupling, not
  // just "usually agrees with the old comparison": a registry-detected
  // update with nothing staged yet reads as unavailable (quiet-until-ready,
  // Tech Plan D3), and a case the OLD comparison would have called
  // "up to date" reads as available once bytes are actually staged.
  it("does not advertise an update the registry detected but nothing has staged yet (quiet-until-ready)", async () => {
    const probeSpy = vi.fn();
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    writeCache({
      checkedAt: new Date().toISOString(),
      latestVersion: "1.4.2",
      installedVersion: "1.4.1",
      reachable: true,
      errorMessage: null,
    });
    const { refreshRegistryUpdateState } =
      await import("../host-management-ipc");
    const state = await refreshRegistryUpdateState(fakeHostController(false), {
      force: false,
      maxAgeMs: null,
    });
    expect(state.latestVersion).toBe("1.4.2");
    expect(state.installedVersion).toBe("1.4.1");
    expect(state.updateAvailable).toBe(false);
  });

  it("advertises an update once bytes are staged, even for a pair the raw registry comparison alone would call up to date", async () => {
    const probeSpy = vi.fn();
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    writeCache({
      checkedAt: new Date().toISOString(),
      latestVersion: "1.4.2",
      installedVersion: "1.4.2",
      reachable: true,
      errorMessage: null,
    });
    const { refreshRegistryUpdateState } =
      await import("../host-management-ipc");
    const state = await refreshRegistryUpdateState(fakeHostController(true), {
      force: false,
      maxAgeMs: null,
    });
    expect(state.updateAvailable).toBe(true);
  });

  it("re-probes a fresh failed cache instead of replaying a stale error", async () => {
    const probeSpy = vi
      .fn()
      .mockResolvedValue(registryProbeResult("1.4.3", true, null));
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    writeCache({
      checkedAt: new Date().toISOString(),
      latestVersion: "1.4.2",
      installedVersion: "1.4.1",
      reachable: false,
      errorMessage: "offline",
    });
    const { refreshRegistryUpdateState } =
      await import("../host-management-ipc");
    const state = await refreshRegistryUpdateState(fakeHostController(false), {
      force: false,
      maxAgeMs: null,
    });
    expect(probeSpy).toHaveBeenCalledOnce();
    expect(state.reachable).toBe(true);
    expect(state.latestVersion).toBe("1.4.3");
    expect(state.errorMessage).toBeNull();
  });

  // Fixup B1: successful registry refreshes never called `stageLatest()` -
  // there was no production caller of it at all. A long session would
  // advertise "Update host" (under the old registry-only detection) while
  // never background-downloading the bytes that advertisement implied.
  it("stages the eligible update in the background on a successful fresh probe, but not on a cache hit", async () => {
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: vi
        .fn()
        .mockResolvedValue(registryProbeResult("1.4.3", true, null)),
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    const { refreshRegistryUpdateState } =
      await import("../host-management-ipc");

    const cacheHitController = fakeHostController(false);
    writeCache({
      checkedAt: new Date().toISOString(),
      latestVersion: "1.4.2",
      installedVersion: "1.4.1",
      reachable: true,
      errorMessage: null,
    });
    await refreshRegistryUpdateState(cacheHitController, {
      force: false,
      maxAgeMs: null,
    });
    expect(cacheHitController.stageLatestCalls).toHaveLength(0);

    const freshProbeController = fakeHostController(false);
    await refreshRegistryUpdateState(freshProbeController, {
      force: true,
      maxAgeMs: null,
    });
    expect(freshProbeController.stageLatestCalls).toHaveLength(1);
  });

  // Renderer surfaces cutover: P6 and F10 exercised `onHostRegistryUpdateStateChange`
  // republishing `updateReady` once a fire-and-forget background `stageLatest()`
  // completed, and guarded against an older, slower stage's completion
  // clobbering a newer one's published state. That listener is retired (see
  // the comment above "re-probes when force is true even with a fresh
  // cache"). The staleness guard F10 exercised now lives one layer down, in
  // `HostController.stageLatest()`'s own in-flight coalescing
  // (`stageLatestInFlight`/`stageLatestPending`) - see
  // "P10: concurrent stageLatest calls share the production reconcile and
  // download" in `host-controller.test.ts`, which pins exactly this
  // concurrent-call ordering guarantee at the source instead of at a
  // since-deleted IPC-layer push.

  it("does not stage anything after a failed registry probe", async () => {
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: vi
        .fn()
        .mockRejectedValue(new Error("registry unreachable: network")),
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    const { refreshRegistryUpdateState } =
      await import("../host-management-ipc");
    const controller = fakeHostController(false);

    const state = await refreshRegistryUpdateState(controller, {
      force: false,
      maxAgeMs: null,
    });

    expect(state.reachable).toBe(false);
    expect(controller.stageLatestCalls).toHaveLength(0);
  });
});

// Ticket 398e84f4 - Desktop host registry update cache must be
// environment-scoped so a dev launch does not project prod cache state
// (and vice-versa). `installedVersion` in the cache is derived from
// the active environment's install record, so any cross-environment reuse
// would mis-report "installed" / "update available" on Settings →
// Host and the tray.
describe("refreshRegistryUpdateState - environment-scoped cache", () => {
  it("prod launch reads only the prod-scoped cache file", async () => {
    const probeSpy = vi.fn();
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    writeCache({
      checkedAt: new Date().toISOString(),
      latestVersion: "1.4.2",
      installedVersion: "1.4.1",
      reachable: true,
      errorMessage: null,
      environment: "production",
    });
    // Seed a poisoned dev cache that, if accidentally read, would
    // hand the prod launch the wrong installed/latest pair.
    writeCache({
      checkedAt: new Date().toISOString(),
      latestVersion: "DEV-99.0.0",
      installedVersion: "DEV-98.0.0",
      reachable: true,
      errorMessage: null,
      environment: "dev",
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const state = await mgmt.refreshRegistryUpdateState(
      fakeHostController(false),
      {
        force: false,
        maxAgeMs: null,
      },
    );
    expect(probeSpy).not.toHaveBeenCalled();
    expect(state.latestVersion).toBe("1.4.2");
    expect(state.installedVersion).toBe("1.4.1");
  });

  it("dev launch reads only the dev-scoped cache file", async () => {
    const probeSpy = vi.fn();
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    writeCache({
      checkedAt: new Date().toISOString(),
      latestVersion: "PROD-1.4.2",
      installedVersion: "PROD-1.4.1",
      reachable: true,
      errorMessage: null,
      environment: "production",
    });
    writeCache({
      checkedAt: new Date().toISOString(),
      latestVersion: "DEV-2.0.0",
      installedVersion: "DEV-1.0.0",
      reachable: true,
      errorMessage: null,
      environment: "dev",
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("dev");
    const state = await mgmt.refreshRegistryUpdateState(
      fakeHostController(false),
      {
        force: false,
        maxAgeMs: null,
      },
    );
    expect(probeSpy).not.toHaveBeenCalled();
    expect(state.latestVersion).toBe("DEV-2.0.0");
    expect(state.installedVersion).toBe("DEV-1.0.0");
  });

  it("dev launch ignores stale prod cache and re-probes when no dev cache exists", async () => {
    const probeSpy = vi
      .fn()
      .mockResolvedValue(registryProbeResult("DEV-2.0.0", true, null));
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    writeCache({
      checkedAt: new Date().toISOString(),
      latestVersion: "PROD-1.4.2",
      installedVersion: "PROD-1.4.1",
      reachable: true,
      errorMessage: null,
      environment: "production",
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("dev");
    const state = await mgmt.refreshRegistryUpdateState(
      fakeHostController(false),
      {
        force: false,
        maxAgeMs: null,
      },
    );
    expect(probeSpy).toHaveBeenCalledOnce();
    expect(state.latestVersion).toBe("DEV-2.0.0");
    // The freshly written cache must land in the dev file, not the
    // prod file.
    const devPath = join(
      workHome,
      ".traycer",
      "desktop",
      "registry-update-cache-dev.json",
    );
    expect(existsSync(devPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(devPath, "utf8"));
    expect(persisted.environment).toBe("dev");
    expect(persisted.latestVersion).toBe("DEV-2.0.0");
  });

  it("prod launch ignores stale dev cache and re-probes when no prod cache exists", async () => {
    const probeSpy = vi
      .fn()
      .mockResolvedValue(registryProbeResult("PROD-1.4.2", true, null));
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    writeCache({
      checkedAt: new Date().toISOString(),
      latestVersion: "DEV-2.0.0",
      installedVersion: "DEV-1.0.0",
      reachable: true,
      errorMessage: null,
      environment: "dev",
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const state = await mgmt.refreshRegistryUpdateState(
      fakeHostController(false),
      {
        force: false,
        maxAgeMs: null,
      },
    );
    expect(probeSpy).toHaveBeenCalledOnce();
    expect(state.latestVersion).toBe("PROD-1.4.2");
    const prodPath = join(
      workHome,
      ".traycer",
      "desktop",
      "registry-update-cache.json",
    );
    expect(existsSync(prodPath)).toBe(true);
  });

  it("does not allow a environment-scoped file whose body claims the other environment to leak through (defence in depth)", async () => {
    const probeSpy = vi
      .fn()
      .mockResolvedValue(registryProbeResult("PROD-1.4.2", true, null));
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    // Write a file at the prod-scoped path whose body says environment=dev
    // (could only happen via manual edit / corrupted state). The probe
    // must run and overwrite with a correct prod-environment snapshot.
    const dir = join(workHome, ".traycer", "desktop");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "registry-update-cache.json"),
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        latestVersion: "DEV-99.0.0",
        installedVersion: "DEV-98.0.0",
        reachable: true,
        errorMessage: null,
        environment: "dev",
      }),
      "utf8",
    );
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const state = await mgmt.refreshRegistryUpdateState(
      fakeHostController(false),
      {
        force: false,
        maxAgeMs: null,
      },
    );
    expect(probeSpy).toHaveBeenCalledOnce();
    expect(state.latestVersion).toBe("PROD-1.4.2");
  });

  it("registry probe failure on dev environment stays non-blocking and writes a dev-scoped error snapshot", async () => {
    const probeSpy = vi
      .fn()
      .mockRejectedValue(new Error("registry unreachable: network"));
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("dev");
    const state = await mgmt.refreshRegistryUpdateState(
      fakeHostController(false),
      {
        force: false,
        maxAgeMs: null,
      },
    );
    expect(state.reachable).toBe(false);
    expect(state.updateAvailable).toBe(false);
    expect(state.errorMessage).toContain("registry unreachable");
    const devPath = join(
      workHome,
      ".traycer",
      "desktop",
      "registry-update-cache-dev.json",
    );
    expect(existsSync(devPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(devPath, "utf8"));
    expect(persisted.environment).toBe("dev");
    expect(persisted.reachable).toBe(false);
  });

  // Fixup B5: dev runs are per-worktree ("Dev run slots") - every other
  // piece of dev state (install dir, pid file, CLI home) is already scoped
  // under `dev-runs/<slot>/` so concurrent worktrees never collide. This
  // cache was keyed on environment alone, so two dev worktrees running
  // `make dev-desktop` at once (each with its own install/`DEV_DESKTOP_SLOT`)
  // shared one `registry-update-cache-dev.json` and could overwrite each
  // other's cached state. Two module instances stand in for two concurrent
  // desktop processes, one per slot, exactly as two real `make dev-desktop`
  // runs would never share a Node module registry either.
  it("keeps registry caches for two concurrent dev slots separate", async () => {
    const originalSlot = process.env[DEV_DESKTOP_SLOT_ENV];
    try {
      process.env[DEV_DESKTOP_SLOT_ENV] = "worktree-a";
      const probeA = vi
        .fn()
        .mockResolvedValue(registryProbeResult("DEV-A-2.0.0", true, null));
      vi.doMock("../../cli/traycer-cli", () => ({
        runTraycerCliJson: probeA,
        streamTraycerCliJson: vi.fn(),
        TraycerCliError: class extends Error {},
      }));
      const mgmtA = await import("../host-management-ipc");
      mgmtA.setActiveEnvironment("dev");
      const stateA = await mgmtA.refreshRegistryUpdateState(
        fakeHostController(false),
        { force: false, maxAgeMs: null },
      );
      expect(stateA.latestVersion).toBe("DEV-A-2.0.0");

      // A second, independently-resolved module instance for a different
      // slot - mirrors a separate concurrent `make dev-desktop` process.
      vi.resetModules();
      vi.doUnmock("../../cli/traycer-cli");
      process.env[DEV_DESKTOP_SLOT_ENV] = "worktree-b";
      const probeB = vi
        .fn()
        .mockResolvedValue(registryProbeResult("DEV-B-3.0.0", true, null));
      vi.doMock("../../cli/traycer-cli", () => ({
        runTraycerCliJson: probeB,
        streamTraycerCliJson: vi.fn(),
        TraycerCliError: class extends Error {},
      }));
      const mgmtB = await import("../host-management-ipc");
      mgmtB.setActiveEnvironment("dev");
      const stateB = await mgmtB.refreshRegistryUpdateState(
        fakeHostController(false),
        { force: false, maxAgeMs: null },
      );
      expect(stateB.latestVersion).toBe("DEV-B-3.0.0");

      const pathA = join(
        workHome,
        ".traycer",
        "desktop",
        "registry-update-cache-dev-worktree-a.json",
      );
      const pathB = join(
        workHome,
        ".traycer",
        "desktop",
        "registry-update-cache-dev-worktree-b.json",
      );
      expect(existsSync(pathA)).toBe(true);
      expect(existsSync(pathB)).toBe(true);
      // Slot A's own file must still hold slot A's data - proves slot B's
      // write landed in a separate file rather than clobbering it.
      expect(JSON.parse(readFileSync(pathA, "utf8")).latestVersion).toBe(
        "DEV-A-2.0.0",
      );
      expect(JSON.parse(readFileSync(pathB, "utf8")).latestVersion).toBe(
        "DEV-B-3.0.0",
      );
    } finally {
      if (originalSlot === undefined) {
        delete process.env[DEV_DESKTOP_SLOT_ENV];
      } else {
        process.env[DEV_DESKTOP_SLOT_ENV] = originalSlot;
      }
    }
  });
});

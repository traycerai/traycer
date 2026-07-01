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
    const state = await refreshRegistryUpdateState({ force: false });
    expect(probeSpy).not.toHaveBeenCalled();
    expect(state.updateAvailable).toBe(true);
    expect(state.latestVersion).toBe("1.4.2");
    expect(state.installedVersion).toBe("1.4.1");
  });

  it("notifies registry update listeners when state is read from cache", async () => {
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: vi.fn(),
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
    const { refreshRegistryUpdateState, onHostRegistryUpdateStateChange } =
      await import("../host-management-ipc");
    const listener = vi.fn();
    const unsubscribe = onHostRegistryUpdateStateChange(listener);

    await refreshRegistryUpdateState({ force: false });
    unsubscribe();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        latestVersion: "1.4.2",
        installedVersion: "1.4.1",
        updateAvailable: true,
      }),
    );
  });

  it("keeps refresh successful when a registry update listener throws", async () => {
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: vi.fn(),
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
    const { refreshRegistryUpdateState, onHostRegistryUpdateStateChange } =
      await import("../host-management-ipc");
    const throwingListener = vi.fn(() => {
      throw new Error("listener failed");
    });
    const succeedingListener = vi.fn();
    const unsubscribeThrowing =
      onHostRegistryUpdateStateChange(throwingListener);
    const unsubscribeSucceeding =
      onHostRegistryUpdateStateChange(succeedingListener);

    const state = await refreshRegistryUpdateState({ force: false });
    unsubscribeThrowing();
    unsubscribeSucceeding();

    expect(state).toEqual(
      expect.objectContaining({
        latestVersion: "1.4.2",
        installedVersion: "1.4.1",
        updateAvailable: true,
      }),
    );
    expect(throwingListener).toHaveBeenCalledOnce();
    expect(succeedingListener).toHaveBeenCalledWith(
      expect.objectContaining({
        latestVersion: "1.4.2",
        installedVersion: "1.4.1",
        updateAvailable: true,
      }),
    );
  });

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
    const state = await refreshRegistryUpdateState({ force: true });
    expect(probeSpy).toHaveBeenCalledOnce();
    expect(state.latestVersion).toBe("1.4.3");
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
    const state = await refreshRegistryUpdateState({ force: false });
    expect(probeSpy).toHaveBeenCalledOnce();
    expect(state.latestVersion).toBe("1.4.3");
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
    const state = await refreshRegistryUpdateState({ force: true });

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

    const first = refreshRegistryUpdateState({ force: true });
    await firstProbeStarted.promise;
    const second = refreshRegistryUpdateState({ force: true });

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
    const state = await refreshRegistryUpdateState({ force: false });
    expect(state.reachable).toBe(false);
    expect(state.updateAvailable).toBe(false);
    expect(state.errorMessage).toContain("registry unreachable");
  });

  it("derives updateAvailable=false when installed equals latest", async () => {
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
    const state = await refreshRegistryUpdateState({ force: false });
    expect(state.updateAvailable).toBe(false);
  });

  it("derives updateAvailable=false when installed is newer than latest", async () => {
    // A host ahead of the registry pointer (a local/staging build, or a
    // stale cache that never re-read the post-update install record) must
    // read as "up to date", not advertise a downgrade. `!==` got this
    // wrong; the semver compare fixes it.
    const probeSpy = vi.fn();
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    writeCache({
      checkedAt: new Date().toISOString(),
      latestVersion: "0.0.2",
      installedVersion: "0.0.3",
      reachable: true,
      errorMessage: null,
    });
    const { refreshRegistryUpdateState } =
      await import("../host-management-ipc");
    const state = await refreshRegistryUpdateState({ force: false });
    expect(probeSpy).not.toHaveBeenCalled();
    expect(state.updateAvailable).toBe(false);
  });

  it("derives updateAvailable=true when a release-candidate host has a GA available", async () => {
    // The reported bug: host installed from 1.0.0-rc.1, registry latest 1.0.0.
    // The pre-release must sort below its GA so both the manual "Check for
    // updates" and the launch auto-update see the upgrade.
    const probeSpy = vi.fn();
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    writeCache({
      checkedAt: new Date().toISOString(),
      latestVersion: "1.0.0",
      installedVersion: "1.0.0-rc.1",
      reachable: true,
      errorMessage: null,
    });
    const { refreshRegistryUpdateState } =
      await import("../host-management-ipc");
    const state = await refreshRegistryUpdateState({ force: false });
    expect(probeSpy).not.toHaveBeenCalled();
    expect(state.updateAvailable).toBe(true);
  });

  it("derives updateAvailable=false when a GA host sees an older pre-release as latest", async () => {
    // Don't advertise a downgrade from GA back to a release candidate.
    const probeSpy = vi.fn();
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: probeSpy,
      streamTraycerCliJson: vi.fn(),
      TraycerCliError: class extends Error {},
    }));
    writeCache({
      checkedAt: new Date().toISOString(),
      latestVersion: "1.0.0-rc.1",
      installedVersion: "1.0.0",
      reachable: true,
      errorMessage: null,
    });
    const { refreshRegistryUpdateState } =
      await import("../host-management-ipc");
    const state = await refreshRegistryUpdateState({ force: false });
    expect(probeSpy).not.toHaveBeenCalled();
    expect(state.updateAvailable).toBe(false);
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
    const state = await refreshRegistryUpdateState({ force: false });
    expect(probeSpy).toHaveBeenCalledOnce();
    expect(state.reachable).toBe(true);
    expect(state.latestVersion).toBe("1.4.3");
    expect(state.errorMessage).toBeNull();
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
    const state = await mgmt.refreshRegistryUpdateState({ force: false });
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
    const state = await mgmt.refreshRegistryUpdateState({ force: false });
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
    const state = await mgmt.refreshRegistryUpdateState({ force: false });
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
    const state = await mgmt.refreshRegistryUpdateState({ force: false });
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
    const state = await mgmt.refreshRegistryUpdateState({ force: false });
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
    const state = await mgmt.refreshRegistryUpdateState({ force: false });
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
});

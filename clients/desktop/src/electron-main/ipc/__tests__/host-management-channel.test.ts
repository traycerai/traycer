import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

// Ticket 29cf341f - Desktop host-management IPC must respect the same
// prod/dev environment selected by Desktop main and `HostLifecycle`. These
// tests pin:
//
//   - Settings → Host installed-record read paths
//     (prod = ~/.traycer/host/install/install.json,
//     dev   = ~/.traycer/host/dev/install/install.json).
//   - Every long-running and short-lived host/service CLI call goes out
//     WITHOUT `--environment`; the CLI derives its slot from
//     `config.environment`, so it touches only the active environment's
//     pid/log/install paths.
//   - Dev Desktop never reads or mutates the prod install record even
//     when both records exist on disk.

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

vi.mock("../../cli/host-update-cli", async () => {
  const actual = await vi.importActual<
    typeof import("../../cli/host-update-cli")
  >("../../cli/host-update-cli");
  return {
    ...actual,
    resolveExactHostUpdateCli: vi.fn().mockResolvedValue({
      command: "/mock/capable-traycer",
      args: [],
    }),
  };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-host-mgmt-environment-"));
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
  vi.doUnmock("../../host/host-removal-state");
  vi.doUnmock("../../app/update-preferences");
});

function writeInstallRecord(
  environment: "production" | "dev",
  body: Record<string, unknown>,
): string {
  const dir =
    environment === "dev"
      ? join(workHome, ".traycer", "host", "dev", "install")
      : join(workHome, ".traycer", "host", "install");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "install.json");
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
}

/**
 * Manual Host update requires `updateAvailable === true`, which needs an
 * installed host *older* than the registry latest. Seed that for every
 * fixture whose intent is to exercise the update path (success, concurrency,
 * expectedVersion mismatch after refresh). Leave refusal fixtures that never
 * reach the spawn boundary without an install unless they specifically assert
 * the no-update guard.
 */
const OLDER_HOST_VERSION = "1.6.0";

function writeOlderInstalledHost(environment: "production" | "dev"): void {
  const version = OLDER_HOST_VERSION;
  writeInstallRecord(environment, {
    version,
    platform: process.platform,
    arch: process.arch,
    installedAt: "2026-05-15T00:00:00Z",
    executablePath: "/opt/traycer/host",
    source: { kind: "registry", value: version },
    archiveSha256: "a".repeat(64),
    signatureKeyId: "k",
    sizeBytes: 1234,
  });
}

function writeRegistryCache(opts: {
  readonly checkedAt: string;
  readonly latestVersion: string | null;
  readonly installedVersion: string | null;
  readonly reachable: boolean;
  readonly errorMessage: string | null;
  readonly includePreReleases?: boolean;
}): void {
  const dir = join(workHome, ".traycer", "desktop");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "registry-update-cache.json"),
    JSON.stringify({
      ...opts,
      environment: "production",
      includePreReleases: opts.includePreReleases ?? false,
    }),
    "utf8",
  );
}

interface RecordedCall {
  readonly kind: "run" | "stream";
  readonly args: readonly string[];
  readonly timeoutMs: number | undefined;
}

interface FakeCli {
  readonly calls: RecordedCall[];
  readonly runResult: unknown;
  readonly streamResult: unknown;
}

function fakeHostAvailablePayload(latest: string): unknown {
  return {
    manifest: {
      schemaVersion: 1,
      generatedAt: "2026-05-15T00:00:00Z",
      latest,
      versions: [
        {
          version: latest,
          releasedAt: "2026-05-15T00:00:00Z",
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
              sha256: "abc",
              signatureUrl: "https://example.invalid/host.tar.gz.minisig",
              signatureAlgorithm: "minisign",
              publicKeyId: "test-key",
            },
          },
        },
      ],
    },
    platformKey: "darwin-arm64",
    manifestUrl: "https://example.invalid/versions.json",
  };
}

function installFakeCli(opts: {
  readonly runResult: unknown;
  readonly streamResult: unknown;
}): FakeCli {
  const calls: RecordedCall[] = [];
  vi.doMock("../../cli/traycer-cli", () => ({
    runTraycerCliJson: vi.fn((args: readonly string[]) => {
      calls.push({ kind: "run", args: [...args], timeoutMs: undefined });
      // Host update always refreshes registry state first and now refuses
      // without an exact target; provide a healthy available payload for
      // those probes while preserving the caller-supplied result elsewhere.
      if (args[0] === "host" && args[1] === "available") {
        return Promise.resolve(fakeHostAvailablePayload("1.7.0"));
      }
      return Promise.resolve(opts.runResult);
    }),
    streamTraycerCliJson: vi.fn(
      ({
        args,
        timeoutMs,
      }: {
        readonly args: readonly string[];
        readonly timeoutMs: number;
      }) => {
        calls.push({ kind: "stream", args: [...args], timeoutMs });
        return Promise.resolve({ data: opts.streamResult });
      },
    ),
    resolveTraycerCliInvocation: vi.fn().mockResolvedValue({
      command: "/mock/traycer",
      args: [],
    }),
    TraycerCliError: class extends Error {},
  }));
  return { calls, runResult: opts.runResult, streamResult: opts.streamResult };
}

interface FakeBridge {
  readonly handlers: Map<
    string,
    (event: unknown, raw: unknown) => Promise<unknown>
  >;
  readonly fanOut: Mock;
  readonly disposeFns: Array<() => void>;
  readonly options: {
    readonly host: {
      readonly reloadSnapshotFromDisk: Mock;
    };
  };
  handleInvoke(
    environment: string,
    handler: (event: unknown, raw: unknown) => unknown | Promise<unknown>,
  ): void;
}

function makeBridge(): FakeBridge {
  const handlers = new Map<
    string,
    (event: unknown, raw: unknown) => Promise<unknown>
  >();
  return {
    handlers,
    fanOut: vi.fn(),
    disposeFns: [],
    options: {
      host: {
        reloadSnapshotFromDisk: vi.fn(() => Promise.resolve(null)),
      },
    },
    handleInvoke(environment, handler) {
      handlers.set(environment, async (event, raw) => handler(event, raw));
    },
  };
}

describe("host-management IPC - configurable host name", () => {
  it("persists a custom host name in the active host layout and reloads the snapshot", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const setHandler = bridge.handlers.get(RunnerHostInvoke.traycerHostNameSet);
    const getHandler = bridge.handlers.get(RunnerHostInvoke.traycerHostNameGet);
    expect(setHandler).toBeDefined();
    expect(getHandler).toBeDefined();

    const settings = (await setHandler!(null, {
      customName: "  Studio   Mac  ",
    })) as { customName: string | null; effectiveName: string };

    expect(settings.customName).toBe("Studio Mac");
    expect(settings.effectiveName).toBe("Studio Mac");
    expect(bridge.options.host.reloadSnapshotFromDisk).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(
      readFileSync(
        join(workHome, ".traycer", "host", "host-name.json"),
        "utf8",
      ),
    ) as { customName: string | null };
    expect(stored.customName).toBe("Studio Mac");

    const readBack = (await getHandler!(null, null)) as {
      customName: string | null;
      effectiveName: string;
    };
    expect(readBack.customName).toBe("Studio Mac");
    expect(readBack.effectiveName).toBe("Studio Mac");
  });
});
describe("host-management IPC - installed record reads the active environment", () => {
  it("prod environment reads ~/.traycer/host/install/install.json", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const prodPath = writeInstallRecord("production", {
      version: "1.7.0",
      platform: process.platform,
      arch: process.arch,
      installedAt: "2026-05-15T00:00:00Z",
      executablePath: "/opt/traycer/prod-host",
      source: { kind: "registry", value: "1.7.0" },
      archiveSha256: "a".repeat(64),
      signatureKeyId: "prod-key",
      sizeBytes: 1234,
    });
    writeInstallRecord("dev", {
      version: "DEV-2.0.0",
      platform: process.platform,
      arch: process.arch,
      installedAt: "2026-05-15T01:00:00Z",
      executablePath: "/opt/traycer/dev-host",
      source: { kind: "registry", value: "DEV-2.0.0" },
      archiveSha256: "b".repeat(64),
      signatureKeyId: "dev-key",
      sizeBytes: 4321,
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const handler = bridge.handlers.get(RunnerHostInvoke.traycerHostInstalled);
    expect(handler).toBeDefined();
    const record = (await handler!(null, null)) as { version: string };
    expect(record).not.toBeNull();
    expect(record.version).toBe("1.7.0");
    expect(prodPath.endsWith(join("host", "install", "install.json"))).toBe(
      true,
    );
  });

  it("dev environment reads ~/.traycer/host/dev/install/install.json and ignores any prod record", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    writeInstallRecord("production", {
      version: "PROD-1.7.0",
      platform: process.platform,
      arch: process.arch,
      installedAt: "2026-05-15T00:00:00Z",
      executablePath: "/opt/traycer/prod-host",
      source: { kind: "registry", value: "PROD-1.7.0" },
      archiveSha256: "a".repeat(64),
      signatureKeyId: "prod-key",
      sizeBytes: 1234,
    });
    writeInstallRecord("dev", {
      version: "DEV-2.0.0",
      platform: process.platform,
      arch: process.arch,
      installedAt: "2026-05-15T01:00:00Z",
      executablePath: "/opt/traycer/dev-host",
      source: { kind: "registry", value: "DEV-2.0.0" },
      archiveSha256: "b".repeat(64),
      signatureKeyId: "dev-key",
      sizeBytes: 4321,
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("dev");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const handler = bridge.handlers.get(RunnerHostInvoke.traycerHostInstalled);
    const record = (await handler!(null, null)) as { version: string };
    expect(record).not.toBeNull();
    expect(record.version).toBe("DEV-2.0.0");
  });

  it("dev environment returns null when only the prod install record exists (never reads prod)", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    writeInstallRecord("production", {
      version: "PROD-1.7.0",
      platform: process.platform,
      arch: process.arch,
      installedAt: "2026-05-15T00:00:00Z",
      executablePath: "/opt/traycer/prod-host",
      source: { kind: "registry", value: "PROD-1.7.0" },
      archiveSha256: "a".repeat(64),
      signatureKeyId: "prod-key",
      sizeBytes: 1234,
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("dev");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const handler = bridge.handlers.get(RunnerHostInvoke.traycerHostInstalled);
    const record = await handler!(null, null);
    expect(record).toBeNull();
  });
});

describe("host-management IPC - CLI subprocess argv carries NO --environment (CLI derives its slot)", () => {
  it("production environment passes no --environment for host install/update/uninstall/restart/logs/doctor/available", async () => {
    writeOlderInstalledHost("production");
    const fake = installFakeCli({
      runResult: {
        // `host available` projector needs a manifest envelope; the
        // other run-style callers (logs, doctor, uninstall, restart)
        // tolerate this shape since they only read specific fields.
        manifest: {
          generatedAt: "2026-05-15T00:00:00Z",
          latest: "1.7.0",
          versions: [],
        },
        platformKey: "darwin-arm64",
        manifestUrl: "https://example.invalid/versions.json",
        issues: [],
      },
      streamResult: {
        version: "1.7.0",
        installedAt: "2026-05-15T00:00:00Z",
        executablePath: "/opt/traycer/host",
        source: { kind: "registry", value: "1.7.0" },
        archiveSha256: "a".repeat(64),
        signatureKeyId: "k",
        sizeBytes: 0,
      },
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await bridge.handlers.get(RunnerHostInvoke.traycerHostInstall)!(null, {
      version: "1.7.0",
      operationId: "op-install",
    });
    await bridge.handlers.get(RunnerHostInvoke.traycerHostUpdate)!(null, {
      operationId: "op-update",
    });
    await bridge.handlers.get(RunnerHostInvoke.traycerHostUninstall)!(null, {
      all: true,
    });
    await bridge.handlers.get(RunnerHostInvoke.traycerHostRestart)!(null, null);
    await bridge.handlers.get(RunnerHostInvoke.traycerHostLogs)!(null, {
      tailLines: 50,
    });
    await bridge.handlers.get(RunnerHostInvoke.traycerHostDoctor)!(null, null);
    await bridge.handlers.get(RunnerHostInvoke.traycerHostAvailable)!(
      null,
      null,
    );
    await bridge.handlers.get(RunnerHostInvoke.traycerServiceRegister)!(null, {
      operationId: "op-register",
    });
    await bridge.handlers.get(RunnerHostInvoke.traycerServiceDeregister)!(
      null,
      null,
    );

    // No --environment - the CLI resolves its slot from config.environment.
    for (const call of fake.calls) {
      expect(call.args).not.toContain("--environment");
    }
    const installCall = fake.calls.find(
      (c) => c.args.includes("install") && c.args.includes("host"),
    );
    expect(installCall?.args.slice(0, 4)).toEqual([
      "host",
      "install",
      "--release",
      "1.7.0",
    ]);
  });

  it("passes --include-pre-releases to host available only when requested", async () => {
    const fake = installFakeCli({
      runResult: {
        manifest: {
          generatedAt: "2026-05-15T00:00:00Z",
          latest: "1.7.0",
          versions: [],
        },
        platformKey: "darwin-arm64",
        manifestUrl: "https://example.invalid/versions.json",
      },
      streamResult: {},
    });
    const mgmt = await import("../host-management-ipc");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await bridge.handlers.get(RunnerHostInvoke.traycerHostAvailable)!(
      null,
      null,
    );
    await bridge.handlers.get(RunnerHostInvoke.traycerHostAvailable)!(null, {
      includePreReleases: true,
    });

    expect(fake.calls[0]?.args).toEqual(["host", "available", "--json"]);
    expect(fake.calls[1]?.args).toEqual([
      "host",
      "available",
      "--json",
      "--include-pre-releases",
    ]);
  });

  it("dev environment passes no --environment for the same set of CLI calls", async () => {
    const fake = installFakeCli({
      runResult: { issues: [] },
      streamResult: {
        version: "DEV-2.0.0",
        installedAt: "2026-05-15T00:00:00Z",
        executablePath: "/opt/traycer/dev-host",
        source: { kind: "registry", value: "DEV-2.0.0" },
        archiveSha256: "b".repeat(64),
        signatureKeyId: "k",
        sizeBytes: 0,
      },
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("dev");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await bridge.handlers.get(RunnerHostInvoke.traycerHostInstall)!(null, {
      version: "latest",
      operationId: "op-install",
    });
    await bridge.handlers.get(RunnerHostInvoke.traycerHostUninstall)!(null, {
      all: true,
    });
    await bridge.handlers.get(RunnerHostInvoke.traycerHostRestart)!(null, null);
    await bridge.handlers.get(RunnerHostInvoke.traycerHostDoctor)!(null, null);
    await bridge.handlers.get(RunnerHostInvoke.traycerServiceDeregister)!(
      null,
      null,
    );

    // No --environment - the CLI resolves its slot from config.environment.
    for (const call of fake.calls) {
      expect(call.args).not.toContain("--environment");
    }
    const uninstall = fake.calls.find((c) => c.args.includes("uninstall"));
    expect(uninstall?.args).toContain("--all");
    // --purge was removed: uninstall must never wipe ~/.traycer user data.
    expect(uninstall?.args).not.toContain("--purge");
  });

  // Ticket f0ae4530 - dev service reregister must resolve the dev CLI
  // wrapper (staged by `make dev-desktop` at
  // `~/.traycer/cli/dev/bin/traycer`). The CLI no longer accepts an
  // explicit `--cli-bin <path>` override (that flag was removed -
  // see `traycer-cli/src/service/cli-binary.ts` `override` comment), so
  // the IPC handler simply passes `--allow-self-invocation` and trusts
  // the well-known bin-dir convention to resolve the wrapper.
  it("dev service register passes --allow-self-invocation", async () => {
    const fake = installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("dev");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await bridge.handlers.get(RunnerHostInvoke.traycerServiceRegister)!(null, {
      operationId: "op-register",
    });

    const call = fake.calls[0];
    expect(call.args).not.toContain("--environment");
    expect(call.args.slice(0, 3)).toEqual(["host", "service", "install"]);
    expect(call.args).toContain("--allow-self-invocation");
    // `--cli-bin` was removed from the CLI surface; if the IPC handler
    // ever sends it again the CLI will reject the call with
    // `unknown option '--cli-bin'`.
    expect(call.args).not.toContain("--cli-bin");
  });

  it("prod service register does NOT pass --allow-self-invocation even if dev wrapper exists on disk", async () => {
    const fake = installFakeCli({ runResult: {}, streamResult: {} });
    // Simulate a developer machine that has both prod packaged Desktop
    // and a staged dev wrapper. The prod IPC path must ignore dev state.
    const wrapperFilename =
      process.platform === "win32" ? "traycer.cmd" : "traycer";
    const wrapperDir = join(workHome, ".traycer", "cli", "dev", "bin");
    mkdirSync(wrapperDir, { recursive: true });
    closeSync(openSync(join(wrapperDir, wrapperFilename), "w"));

    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await bridge.handlers.get(RunnerHostInvoke.traycerServiceRegister)!(null, {
      operationId: "op-register",
    });
    const call = fake.calls[0];
    expect(call.args).toEqual(["host", "service", "install"]);
  });

  it("dev deregister + reregister does not mutate prod service/install state", async () => {
    const fake = installFakeCli({ runResult: {}, streamResult: {} });
    // Pre-seed both prod and dev install records.
    writeInstallRecord("production", {
      version: "PROD-1.7.0",
      platform: process.platform,
      arch: process.arch,
      installedAt: "2026-05-15T00:00:00Z",
      executablePath: "/opt/traycer/prod-host",
      source: { kind: "registry", value: "PROD-1.7.0" },
      archiveSha256: "a".repeat(64),
      signatureKeyId: "prod-key",
      sizeBytes: 1234,
    });
    writeInstallRecord("dev", {
      version: "DEV-2.0.0",
      platform: process.platform,
      arch: process.arch,
      installedAt: "2026-05-15T01:00:00Z",
      executablePath: "/opt/traycer/dev-host",
      source: { kind: "registry", value: "DEV-2.0.0" },
      archiveSha256: "b".repeat(64),
      signatureKeyId: "dev-key",
      sizeBytes: 4321,
    });
    const wrapperFilename =
      process.platform === "win32" ? "traycer.cmd" : "traycer";
    const wrapperDir = join(workHome, ".traycer", "cli", "dev", "bin");
    mkdirSync(wrapperDir, { recursive: true });
    closeSync(openSync(join(wrapperDir, wrapperFilename), "w"));

    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("dev");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await bridge.handlers.get(RunnerHostInvoke.traycerServiceDeregister)!(
      null,
      null,
    );
    await bridge.handlers.get(RunnerHostInvoke.traycerServiceRegister)!(null, {
      operationId: "op-rereg",
    });

    // Every emitted call must omit --environment; the CLI resolves its slot
    // from config.environment, so a dev re-register sequence never
    // accidentally touches the prod environment.
    for (const call of fake.calls) {
      expect(call.args).not.toContain("--environment");
    }
  });

  // Pin the per-environment CLI manifest path read by Settings → Host
  // (Ticket: agent-7 second-pass). The handler must read
  //   prod → ~/.traycer/cli/manifest.json
  //   dev  → ~/.traycer/cli/dev/manifest.json
  // and never cross-read the other environment's file. We capture the actual
  // path by spying on `fs/promises.readFile`.
  it("traycerCliManifestRead reads ~/.traycer/cli/manifest.json on prod environment", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const prodDir = join(workHome, ".traycer", "cli");
    const devDir = join(workHome, ".traycer", "cli", "dev");
    mkdirSync(prodDir, { recursive: true });
    mkdirSync(devDir, { recursive: true });
    const prodManifest = {
      version: "1.5.0",
      installedAt: "2026-05-15T00:00:00.000Z",
      binaryPath: "/usr/local/bin/traycer-prod",
      source: "manual",
    };
    const devManifest = {
      version: "9.9.9-dev",
      installedAt: "2026-05-15T00:00:00.000Z",
      binaryPath: "/usr/local/bin/traycer-dev",
      source: "manual",
    };
    writeFileSync(join(prodDir, "manifest.json"), JSON.stringify(prodManifest));
    writeFileSync(join(devDir, "manifest.json"), JSON.stringify(devManifest));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const result = (await bridge.handlers.get(
      RunnerHostInvoke.traycerCliManifestRead,
    )!(null, null)) as { version: string; binaryPath: string } | null;
    expect(result?.version).toBe("1.5.0");
    expect(result?.binaryPath).toBe("/usr/local/bin/traycer-prod");
  });

  it("traycerCliManifestRead reads ~/.traycer/cli/dev/manifest.json on dev environment", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const prodDir = join(workHome, ".traycer", "cli");
    const devDir = join(workHome, ".traycer", "cli", "dev");
    mkdirSync(prodDir, { recursive: true });
    mkdirSync(devDir, { recursive: true });
    const prodManifest = {
      version: "1.5.0",
      installedAt: "2026-05-15T00:00:00.000Z",
      binaryPath: "/usr/local/bin/traycer-prod",
      source: "manual",
    };
    const devManifest = {
      version: "9.9.9-dev",
      installedAt: "2026-05-15T00:00:00.000Z",
      binaryPath: "/usr/local/bin/traycer-dev",
      source: "manual",
    };
    writeFileSync(join(prodDir, "manifest.json"), JSON.stringify(prodManifest));
    writeFileSync(join(devDir, "manifest.json"), JSON.stringify(devManifest));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("dev");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const result = (await bridge.handlers.get(
      RunnerHostInvoke.traycerCliManifestRead,
    )!(null, null)) as { version: string; binaryPath: string } | null;
    expect(result?.version).toBe("9.9.9-dev");
    expect(result?.binaryPath).toBe("/usr/local/bin/traycer-dev");
  });

  it("omits --environment for host free-port-and-restart so slot resolution stays CLI-owned", async () => {
    const fake = installFakeCli({
      runResult: { port: 7000, pid: 1234, processName: "rogue" },
      streamResult: {},
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("dev");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    await bridge.handlers.get(RunnerHostInvoke.traycerFreePortAndRestart)!(
      null,
      { port: 7000, pid: 1234, processName: "rogue" },
    );
    const call = fake.calls[0];
    expect(call.args).not.toContain("--environment");
    expect(call.args.slice(0, 2)).toEqual(["host", "free-port-and-restart"]);
  });
});

// Dev builds ship without trusted registry signing keys, so the CLI rejects
// `host available --json` and the registry probe with
// `E_HOST_VERIFY_FAILED`. There's no user action that can recover from
// that - Settings → Host used to surface the raw stderr ("host registry:
// no trusted signing keys are configured for this build, …") in the Updates
// row and the Pick-a-version list. The IPC handlers now normalise this into
// a "no updates available" / empty version snapshot for dev/staging and
// keep propagating it for production (where the same error means a real
// signing-key bug).
function installFakeCliRejectingWithVerifyFailed(): {
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  class FakeTraycerCliError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  vi.doMock("../../cli/traycer-cli", () => ({
    runTraycerCliJson: vi.fn((args: readonly string[]) => {
      calls.push({ kind: "run", args: [...args], timeoutMs: undefined });
      return Promise.reject(
        new FakeTraycerCliError(
          "E_HOST_VERIFY_FAILED",
          "host registry: no trusted signing keys are configured for this build",
        ),
      );
    }),
    streamTraycerCliJson: vi.fn(
      ({
        args,
        timeoutMs,
      }: {
        readonly args: readonly string[];
        readonly timeoutMs: number;
      }) => {
        calls.push({ kind: "stream", args: [...args], timeoutMs });
        return Promise.resolve({ data: {} });
      },
    ),
    TraycerCliError: FakeTraycerCliError,
  }));
  return { calls };
}

describe("host-management IPC - verify-disabled normalisation for dev builds", () => {
  it("traycerHostAvailable returns an empty snapshot when the CLI rejects with E_HOST_VERIFY_FAILED in dev", async () => {
    installFakeCliRejectingWithVerifyFailed();
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("dev");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const result = await bridge.handlers.get(
      RunnerHostInvoke.traycerHostAvailable,
    )!(null, null);
    expect(result).toMatchObject({
      latest: "",
      versions: [],
    });
  });

  it("traycerHostAvailable normalises E_HOST_VERIFY_FAILED to an empty snapshot in production too - end user can't act on a missing-pubkeys release-engineering bug from the UI", async () => {
    installFakeCliRejectingWithVerifyFailed();
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const result = await bridge.handlers.get(
      RunnerHostInvoke.traycerHostAvailable,
    )!(null, null);
    expect(result).toMatchObject({ latest: "", versions: [] });
  });

  it("traycerRegistryCheck reports `reachable: true` with `updateAvailable: false` when verify is disabled in dev", async () => {
    installFakeCliRejectingWithVerifyFailed();
    writeInstallRecord("dev", {
      version: "DEV-1.0.0",
      platform: process.platform,
      arch: process.arch,
      installedAt: "2026-05-15T00:00:00Z",
      executablePath: "/opt/traycer/dev-host",
      source: { kind: "registry", value: "DEV-1.0.0" },
      archiveSha256: "a".repeat(64),
      signatureKeyId: "k",
      sizeBytes: 1,
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("dev");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const result = (await bridge.handlers.get(
      RunnerHostInvoke.traycerRegistryCheck,
    )!(null, { force: true })) as {
      readonly reachable: boolean;
      readonly updateAvailable: boolean;
      readonly errorMessage: string | null;
      readonly installedVersion: string | null;
      readonly latestVersion: string | null;
    };
    expect(result.reachable).toBe(true);
    expect(result.updateAvailable).toBe(false);
    expect(result.errorMessage).toBeNull();
    // latestVersion is pinned to installedVersion so the diff in
    // buildUpdateState yields updateAvailable=false.
    expect(result.latestVersion).toBe("DEV-1.0.0");
    expect(result.installedVersion).toBe("DEV-1.0.0");
  });
});

// Ticket: host-update-race-conditions. The banner and Settings → Host each
// run their own independent `useMutation`, so two near-simultaneous clicks
// used to spawn two `traycer host …` subprocesses that raced the CLI's
// file lock - the loser waited 30s then surfaced `CLI_LOCK_BUSY` while the
// winner's UI kept spinning. Main is now the single-flight serializer: a
// second concurrent install/update/register-service call is rejected
// synchronously, before a second subprocess is ever spawned, and every
// surface (any open window) observes the same canonical
// `hostOperationStatusChange` broadcast regardless of which one triggered it.
function installFakeCliWithDeferredStream(): {
  readonly calls: RecordedCall[];
  readonly resolveStream: (data: unknown) => void;
  readonly rejectStream: (err: unknown) => void;
} {
  const calls: RecordedCall[] = [];
  let resolveStream: (data: unknown) => void = () => undefined;
  let rejectStream: (err: unknown) => void = () => undefined;
  vi.doMock("../../cli/traycer-cli", () => ({
    runTraycerCliJson: vi.fn((args: readonly string[]) => {
      calls.push({ kind: "run", args: [...args], timeoutMs: undefined });
      if (args[0] === "host" && args[1] === "available") {
        return Promise.resolve(fakeHostAvailablePayload("1.7.0"));
      }
      return Promise.resolve({});
    }),
    streamTraycerCliJson: vi.fn(
      ({
        args,
        onEvent,
        timeoutMs,
      }: {
        readonly args: readonly string[];
        readonly onEvent: (event: unknown) => void;
        readonly timeoutMs: number;
      }) => {
        calls.push({ kind: "stream", args: [...args], timeoutMs });
        return new Promise((resolve, reject) => {
          resolveStream = (data: unknown) => {
            onEvent({
              type: "progress",
              stage: "download",
              percent: 50,
              bytes: 50,
              totalBytes: 100,
              message: "downloading",
            });
            resolve({ data });
          };
          rejectStream = reject;
        });
      },
    ),
    TraycerCliError: class extends Error {},
  }));
  return {
    calls,
    resolveStream: (data) => resolveStream(data),
    rejectStream: (err) => rejectStream(err),
  };
}

// Both `traycerHostUpdate` et al. and `trackHostOperation`'s single-flight
// check are separated by an `await clearHostRemovalIfSet()`, so a call's
// promise being created doesn't guarantee the guard has run yet. Poll for the
// CLI subprocess call landing (proof the guard already ran) before treating a
// call as "in flight" - asserting or firing a second call any earlier would
// be racing the same microtask ordering these tests exist to pin down.
async function waitForStreamCallCount(
  fake: { readonly calls: RecordedCall[] },
  count: number,
): Promise<void> {
  await vi.waitFor(() => {
    if (fake.calls.filter((c) => c.kind === "stream").length < count) {
      throw new Error("stream call not reached yet");
    }
  });
}

// Review findings 4/6: manual update must pin an exact registry target via
// `host update --release` and refuse when the registry is unreachable or no
// consented latest exists — never bare `host update`.
describe("host-management IPC - exact host update target safety", () => {
  it("streams host update --release <latestVersion> through the capability-resolved CLI", async () => {
    writeOlderInstalledHost("production");
    const fake = installFakeCli({
      runResult: {},
      streamResult: {
        version: "1.7.0",
        installedAt: "2026-05-15T00:00:00Z",
        executablePath: "/opt/traycer/host",
        source: { kind: "registry", value: "1.7.0" },
        archiveSha256: "a".repeat(64),
        signatureKeyId: "k",
        sizeBytes: 0,
      },
    });
    const { resolveExactHostUpdateCli } =
      await import("../../cli/host-update-cli");
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await bridge.handlers.get(RunnerHostInvoke.traycerHostUpdate)!(null, {
      operationId: "op-exact-update",
    });

    const streamCall = fake.calls.find(
      (c) =>
        c.kind === "stream" && c.args[0] === "host" && c.args[1] === "update",
    );
    expect(streamCall?.args).toEqual(["host", "update", "--release", "1.7.0"]);
    expect(resolveExactHostUpdateCli).toHaveBeenCalled();
    // No bare `host update` without --release ever left the process.
    for (const call of fake.calls.filter((c) => c.kind === "stream")) {
      if (call.args[0] === "host" && call.args[1] === "update") {
        expect(call.args).toContain("--release");
      }
    }
  });

  it("refuses manual update when the registry is unreachable (no bare host update stream)", async () => {
    const calls: RecordedCall[] = [];
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: vi.fn((args: readonly string[]) => {
        calls.push({ kind: "run", args: [...args], timeoutMs: undefined });
        if (args[0] === "host" && args[1] === "available") {
          return Promise.reject(new Error("registry unreachable: network"));
        }
        return Promise.resolve({});
      }),
      streamTraycerCliJson: vi.fn(
        ({ args }: { readonly args: readonly string[] }) => {
          calls.push({ kind: "stream", args: [...args], timeoutMs: undefined });
          return Promise.resolve({ data: {} });
        },
      ),
      resolveTraycerCliInvocation: vi.fn().mockResolvedValue({
        command: "/mock/traycer",
        args: [],
      }),
      TraycerCliError: class extends Error {},
    }));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await expect(
      bridge.handlers.get(RunnerHostInvoke.traycerHostUpdate)!(null, {
        operationId: "op-unreachable",
      }),
    ).rejects.toThrow(/reachable exact target version/i);

    expect(calls.filter((c) => c.kind === "stream")).toHaveLength(0);
  });

  it("refuses manual update when latestVersion is null (no consented target)", async () => {
    const calls: RecordedCall[] = [];
    // Platform-unavailable stable pointer → availableLatestVersion returns null.
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: vi.fn((args: readonly string[]) => {
        calls.push({ kind: "run", args: [...args], timeoutMs: undefined });
        if (args[0] === "host" && args[1] === "available") {
          return Promise.resolve({
            manifest: {
              schemaVersion: 1,
              generatedAt: "2026-05-15T00:00:00Z",
              latest: "1.7.0",
              versions: [
                {
                  version: "1.7.0",
                  releasedAt: "2026-05-15T00:00:00Z",
                  releaseNotesUrl: "https://example.invalid/notes",
                  yanked: false,
                  deprecationReason: null,
                  requiredCliVersion: null,
                  platforms: {
                    "darwin-arm64": {
                      available: false,
                      unavailableReason: "not published for platform",
                      url: "https://example.invalid/host.tar.gz",
                      sizeBytes: 1024,
                      sha256: "abc",
                      signatureUrl:
                        "https://example.invalid/host.tar.gz.minisig",
                      signatureAlgorithm: "minisign",
                      publicKeyId: "test-key",
                    },
                  },
                },
              ],
            },
            platformKey: "darwin-arm64",
            manifestUrl: "https://example.invalid/versions.json",
          });
        }
        return Promise.resolve({});
      }),
      streamTraycerCliJson: vi.fn(
        ({ args }: { readonly args: readonly string[] }) => {
          calls.push({ kind: "stream", args: [...args], timeoutMs: undefined });
          return Promise.resolve({ data: {} });
        },
      ),
      resolveTraycerCliInvocation: vi.fn().mockResolvedValue({
        command: "/mock/traycer",
        args: [],
      }),
      TraycerCliError: class extends Error {},
    }));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await expect(
      bridge.handlers.get(RunnerHostInvoke.traycerHostUpdate)!(null, {
        operationId: "op-null-latest",
      }),
    ).rejects.toThrow(/reachable exact target version/i);

    expect(calls.filter((c) => c.kind === "stream")).toHaveLength(0);
  });

  // Review finding 5: the surface that triggered this update (banner,
  // Settings row, native menu/tray) showed the user a specific version. If a
  // release-channel switch in another window/the tray resolves a different
  // exact target in the meantime, main must refuse rather than install
  // something the user never confirmed.
  it("refuses when expectedVersion disagrees with the freshly-resolved latestVersion, and makes no CLI invocation", async () => {
    // Older install so updateAvailable passes and the expectedVersion guard
    // is the one that fires (not the no-newer-update guard).
    writeOlderInstalledHost("production");
    const fake = installFakeCli({
      runResult: {},
      streamResult: {
        version: "1.7.0",
        installedAt: "2026-05-15T00:00:00Z",
        executablePath: "/opt/traycer/host",
        source: { kind: "registry", value: "1.7.0" },
        archiveSha256: "a".repeat(64),
        signatureKeyId: "k",
        sizeBytes: 0,
      },
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await expect(
      bridge.handlers.get(RunnerHostInvoke.traycerHostUpdate)!(null, {
        operationId: "op-stale-expected",
        // installFakeCli's `host available` fixture resolves latest 1.7.0.
        expectedVersion: "1.4.2",
      }),
    ).rejects.toThrow(/changed from 1\.4\.2 to 1\.7\.0/i);

    expect(fake.calls.filter((c) => c.kind === "stream")).toHaveLength(0);
  });

  it("proceeds when expectedVersion agrees with the freshly-resolved latestVersion", async () => {
    writeOlderInstalledHost("production");
    const fake = installFakeCli({
      runResult: {},
      streamResult: {
        version: "1.7.0",
        installedAt: "2026-05-15T00:00:00Z",
        executablePath: "/opt/traycer/host",
        source: { kind: "registry", value: "1.7.0" },
        archiveSha256: "a".repeat(64),
        signatureKeyId: "k",
        sizeBytes: 0,
      },
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await bridge.handlers.get(RunnerHostInvoke.traycerHostUpdate)!(null, {
      operationId: "op-matching-expected",
      expectedVersion: "1.7.0",
    });

    const streamCall = fake.calls.find(
      (c) =>
        c.kind === "stream" && c.args[0] === "host" && c.args[1] === "update",
    );
    expect(streamCall?.args).toEqual(["host", "update", "--release", "1.7.0"]);
  });

  it("proceeds when expectedVersion is null (caller had no version on screen)", async () => {
    writeOlderInstalledHost("production");
    const fake = installFakeCli({
      runResult: {},
      streamResult: {
        version: "1.7.0",
        installedAt: "2026-05-15T00:00:00Z",
        executablePath: "/opt/traycer/host",
        source: { kind: "registry", value: "1.7.0" },
        archiveSha256: "a".repeat(64),
        signatureKeyId: "k",
        sizeBytes: 0,
      },
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await bridge.handlers.get(RunnerHostInvoke.traycerHostUpdate)!(null, {
      operationId: "op-no-expected",
      expectedVersion: null,
    });

    const streamCall = fake.calls.find(
      (c) =>
        c.kind === "stream" && c.args[0] === "host" && c.args[1] === "update",
    );
    expect(streamCall?.args).toEqual(["host", "update", "--release", "1.7.0"]);
  });
});

describe("host-management IPC - single-flight guard on concurrent host mutations", () => {
  it("rejects a second concurrent host update without spawning a second CLI subprocess", async () => {
    writeOlderInstalledHost("production");
    const fake = installFakeCliWithDeferredStream();
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const updateHandler = bridge.handlers.get(
      RunnerHostInvoke.traycerHostUpdate,
    )!;

    const first = updateHandler(null, { operationId: "op-first" });
    await waitForStreamCallCount(fake, 1);
    // The first call's `streamTraycerCliJson` is still pending (deferred),
    // so a second call landing now is exactly the banner-then-Settings race.
    await expect(
      updateHandler(null, { operationId: "op-second" }),
    ).rejects.toThrow(/already in progress/i);

    // Only ONE CLI subprocess was ever spawned - the second click never
    // reached the CLI lock at all.
    expect(fake.calls.filter((c) => c.kind === "stream")).toHaveLength(1);

    fake.resolveStream({
      version: "1.7.0",
      installedAt: "2026-05-15T00:00:00Z",
      executablePath: "/opt/traycer/host",
      source: { kind: "registry", value: "1.7.0" },
      archiveSha256: "a".repeat(64),
      signatureKeyId: "k",
      sizeBytes: 0,
    });
    await first;
  });

  it("blocks an install while an update is in flight (the lock is not scoped per-kind)", async () => {
    writeOlderInstalledHost("production");
    const fake = installFakeCliWithDeferredStream();
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const updatePromise = bridge.handlers.get(
      RunnerHostInvoke.traycerHostUpdate,
    )!(null, { operationId: "op-update" });
    await waitForStreamCallCount(fake, 1);
    await expect(
      bridge.handlers.get(RunnerHostInvoke.traycerHostInstall)!(null, {
        version: "latest",
        operationId: "op-install",
      }),
    ).rejects.toThrow(/already in progress/i);

    fake.resolveStream({
      version: "1.7.0",
      installedAt: "2026-05-15T00:00:00Z",
      executablePath: "/opt/traycer/host",
      source: { kind: "registry", value: "1.7.0" },
      archiveSha256: "a".repeat(64),
      signatureKeyId: "k",
      sizeBytes: 0,
    });
    await updatePromise;
  });

  it("broadcasts hostOperationStatusChange on start, on progress, and clears it to null on settle", async () => {
    writeOlderInstalledHost("production");
    const fake = installFakeCliWithDeferredStream();
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke, RunnerHostEvent } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const updatePromise = bridge.handlers.get(
      RunnerHostInvoke.traycerHostUpdate,
    )!(null, { operationId: "op-update" });
    await waitForStreamCallCount(fake, 1);

    // Started: broadcast with no progress yet.
    const statusCalls = () =>
      bridge.fanOut.mock.calls.filter(
        ([channel]) => channel === RunnerHostEvent.hostOperationStatusChange,
      );
    expect(statusCalls()[0]?.[1]).toMatchObject({
      kind: "update",
      percent: null,
    });
    expect(mgmt.getHostOperationStatus()).toMatchObject({ kind: "update" });

    fake.resolveStream({
      version: "1.7.0",
      installedAt: "2026-05-15T00:00:00Z",
      executablePath: "/opt/traycer/host",
      source: { kind: "registry", value: "1.7.0" },
      archiveSha256: "a".repeat(64),
      signatureKeyId: "k",
      sizeBytes: 0,
    });
    await updatePromise;

    // The deferred stream fixture fires one progress tick right before
    // resolving - assert it landed before the terminal null.
    const afterSettle = statusCalls();
    const progressCall = afterSettle.find(
      ([, payload]) =>
        payload !== null &&
        typeof payload === "object" &&
        (payload as { percent: number | null }).percent === 50,
    );
    expect(progressCall).toBeDefined();
    expect(afterSettle[afterSettle.length - 1]?.[1]).toBeNull();
    expect(mgmt.getHostOperationStatus()).toBeNull();
  });

  it("a failed operation still clears the status so a retry isn't permanently blocked", async () => {
    writeOlderInstalledHost("production");
    const fake = installFakeCliWithDeferredStream();
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const updatePromise = bridge.handlers.get(
      RunnerHostInvoke.traycerHostUpdate,
    )!(null, { operationId: "op-update" });
    await waitForStreamCallCount(fake, 1);
    fake.rejectStream(new Error("network unreachable"));
    await expect(updatePromise).rejects.toThrow(/network unreachable/);

    expect(mgmt.getHostOperationStatus()).toBeNull();
    // A subsequent attempt is allowed through - the failed op didn't wedge
    // the guard. Reuses the same fake CLI: each `streamTraycerCliJson` call
    // creates a fresh deferred promise, so `resolveStream` below settles
    // THIS retry, not the already-rejected first attempt.
    const retryHandler = bridge.handlers.get(
      RunnerHostInvoke.traycerHostUpdate,
    )!;
    const retry = retryHandler(null, { operationId: "op-retry" });
    await waitForStreamCallCount(fake, 2);
    expect(mgmt.getHostOperationStatus()).toMatchObject({ kind: "update" });
    fake.resolveStream({
      version: "1.7.0",
      installedAt: "2026-05-15T00:00:00Z",
      executablePath: "/opt/traycer/host",
      source: { kind: "registry", value: "1.7.0" },
      archiveSha256: "a".repeat(64),
      signatureKeyId: "k",
      sizeBytes: 0,
    });
    await retry;
  });

  it("traycerHostOperationStatusGet reflects the in-flight operation for a component that mounts mid-operation", async () => {
    writeOlderInstalledHost("production");
    const fake = installFakeCliWithDeferredStream();
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const statusHandler = bridge.handlers.get(
      RunnerHostInvoke.traycerHostOperationStatusGet,
    )!;
    expect(await statusHandler(null, null)).toBeNull();

    const updatePromise = bridge.handlers.get(
      RunnerHostInvoke.traycerHostUpdate,
    )!(null, { operationId: "op-update" });
    await waitForStreamCallCount(fake, 1);
    expect(await statusHandler(null, null)).toMatchObject({ kind: "update" });

    fake.resolveStream({
      version: "1.7.0",
      installedAt: "2026-05-15T00:00:00Z",
      executablePath: "/opt/traycer/host",
      source: { kind: "registry", value: "1.7.0" },
      archiveSha256: "a".repeat(64),
      signatureKeyId: "k",
      sizeBytes: 0,
    });
    await updatePromise;
    expect(await statusHandler(null, null)).toBeNull();
  });

  // Cold-review finding 5: operation reservation covers registry/capability
  // prework, so a concurrent click while capability resolution is still
  // awaiting never spawns a second CLI update.
  it("rejects a second concurrent update while capability prework is still in flight (no second spawn)", async () => {
    writeOlderInstalledHost("production");
    const fake = installFakeCliWithDeferredStream();
    let releaseCapability!: () => void;
    let markCapabilityEntered!: () => void;
    const capabilityGate = new Promise<void>((resolve) => {
      releaseCapability = resolve;
    });
    const capabilityEntered = new Promise<void>((resolve) => {
      markCapabilityEntered = resolve;
    });

    const { resolveExactHostUpdateCli } =
      await import("../../cli/host-update-cli");
    vi.mocked(resolveExactHostUpdateCli).mockImplementation(async () => {
      markCapabilityEntered();
      await capabilityGate;
      return { command: "/mock/capable-traycer", args: [] };
    });

    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const updateHandler = bridge.handlers.get(
      RunnerHostInvoke.traycerHostUpdate,
    )!;

    const first = updateHandler(null, { operationId: "op-prework-first" });
    await capabilityEntered;
    expect(mgmt.getHostOperationStatus()).toMatchObject({
      kind: "update",
      operationId: "op-prework-first",
    });
    // Still in prework - stream has not started.
    expect(fake.calls.filter((c) => c.kind === "stream")).toHaveLength(0);

    await expect(
      updateHandler(null, { operationId: "op-prework-second" }),
    ).rejects.toThrow(/already in progress/i);

    expect(fake.calls.filter((c) => c.kind === "stream")).toHaveLength(0);

    releaseCapability();
    await waitForStreamCallCount(fake, 1);
    fake.resolveStream({
      version: "1.7.0",
      installedAt: "2026-05-15T00:00:00Z",
      executablePath: "/opt/traycer/host",
      source: { kind: "registry", value: "1.7.0" },
      archiveSha256: "a".repeat(64),
      signatureKeyId: "k",
      sizeBytes: 0,
    });
    await first;
    expect(fake.calls.filter((c) => c.kind === "stream")).toHaveLength(1);
  });
});

// Cold-review findings 5/6: generation-bound admission after awaits, ABA, and
// app-facing stable/RC-only picker + install validation.

function multiVersionAvailablePayload(): unknown {
  return {
    manifest: {
      schemaVersion: 1,
      generatedAt: "2026-05-15T00:00:00Z",
      latest: "1.7.0",
      versions: [
        "1.7.0",
        "1.7.0-rc.2",
        "1.7.0-alpha.1",
        "1.7.0-beta.3",
        "1.7.0-nightly.20260515",
        "2.0.0-dev.1",
      ].map((version) => ({
        version,
        releasedAt: "2026-05-15T00:00:00Z",
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
            sha256: "abc",
            signatureUrl: "https://example.invalid/host.tar.gz.minisig",
            signatureAlgorithm: "minisign",
            publicKeyId: "test-key",
          },
        },
      })),
    },
    platformKey: "darwin-arm64",
    manifestUrl: "https://example.invalid/versions.json",
  };
}

function installChannelSnapshotMock(initial: {
  readonly allowPrerelease: boolean;
  readonly generation: number;
}): {
  readonly get: () => { allowPrerelease: boolean; generation: number };
  readonly set: (next: {
    readonly allowPrerelease: boolean;
    readonly generation: number;
  }) => void;
} {
  const state = {
    allowPrerelease: initial.allowPrerelease,
    generation: initial.generation,
  };
  vi.doMock("../../app/update-preferences", () => ({
    getUpdateChannelSnapshot: () => ({
      allowPrerelease: state.allowPrerelease,
      generation: state.generation,
    }),
    prereleaseUpdatesEnabled: () => state.allowPrerelease,
  }));
  return {
    get: () => ({ ...state }),
    set: (next) => {
      state.allowPrerelease = next.allowPrerelease;
      state.generation = next.generation;
    },
  };
}

describe("host-management IPC - channel admission after readiness/capability awaits", () => {
  it("refuses spawn when the channel generation changes during capability resolution", async () => {
    writeOlderInstalledHost("production");
    const calls: RecordedCall[] = [];
    let releaseCapability!: () => void;
    let markCapabilityEntered!: () => void;
    const capabilityGate = new Promise<void>((resolve) => {
      releaseCapability = resolve;
    });
    const capabilityEntered = new Promise<void>((resolve) => {
      markCapabilityEntered = resolve;
    });
    const channel = installChannelSnapshotMock({
      allowPrerelease: true,
      generation: 3,
    });
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: vi.fn((args: readonly string[]) => {
        calls.push({ kind: "run", args: [...args], timeoutMs: undefined });
        if (args[0] === "host" && args[1] === "available") {
          return Promise.resolve(fakeHostAvailablePayload("1.7.0-rc.1"));
        }
        return Promise.resolve({});
      }),
      streamTraycerCliJson: vi.fn(
        ({ args }: { readonly args: readonly string[] }) => {
          calls.push({ kind: "stream", args: [...args], timeoutMs: undefined });
          return Promise.resolve({
            data: {
              version: "1.7.0-rc.1",
              installedAt: "2026-05-15T00:00:00Z",
              executablePath: "/opt/traycer/host",
              source: { kind: "registry", value: "1.7.0-rc.1" },
              archiveSha256: "a".repeat(64),
              signatureKeyId: "k",
              sizeBytes: 0,
            },
          });
        },
      ),
      resolveTraycerCliInvocation: vi.fn().mockResolvedValue({
        command: "/mock/traycer",
        args: [],
      }),
      TraycerCliError: class extends Error {},
    }));

    const { resolveExactHostUpdateCli } =
      await import("../../cli/host-update-cli");
    vi.mocked(resolveExactHostUpdateCli).mockImplementation(async () => {
      markCapabilityEntered();
      await capabilityGate;
      return { command: "/mock/capable-traycer", args: [] };
    });

    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const updatePromise = bridge.handlers.get(
      RunnerHostInvoke.traycerHostUpdate,
    )!(null, {
      operationId: "op-channel-flip",
      expectedVersion: "1.7.0-rc.1",
    });

    await capabilityEntered;
    // Opt out while capability/prework is still awaiting. Generation advances;
    // final admission must refuse the captured RC.
    channel.set({ allowPrerelease: false, generation: 4 });
    releaseCapability();

    await expect(updatePromise).rejects.toThrow(/channel changed/i);
    expect(calls.filter((c) => c.kind === "stream")).toHaveLength(0);
  });

  it("rejects an ABA-captured admission after A→B→A (first generation never re-admits)", async () => {
    const channel = installChannelSnapshotMock({
      allowPrerelease: false,
      generation: 0,
    });
    const firstA = channel.get();

    channel.set({ allowPrerelease: true, generation: 1 });
    channel.set({ allowPrerelease: false, generation: 2 });
    const secondA = channel.get();
    expect(secondA).toEqual({ allowPrerelease: false, generation: 2 });

    const mgmt = await import("../host-management-ipc");
    expect(() =>
      mgmt.captureHostUpdateAdmission("1.7.0", false, firstA),
    ).toThrow(/channel changed/i);

    // The live A epoch still admits.
    expect(
      mgmt.captureHostUpdateAdmission("1.7.0", false, secondA),
    ).toMatchObject({
      targetVersion: "1.7.0",
      allowPrerelease: false,
      generation: 2,
    });
  });

  it("streamExactHostUpdateWithinOperation refuses when the operation reservation is lost", async () => {
    installChannelSnapshotMock({ allowPrerelease: false, generation: 0 });
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    const admission = mgmt.captureHostUpdateAdmission("1.7.0", false, {
      allowPrerelease: false,
      generation: 0,
    });

    // Admission asserts run synchronously before the CLI stream promise is
    // created, so a missing reservation is a throw rather than a rejection.
    expect(() =>
      mgmt.streamExactHostUpdateWithinOperation(
        ["host", "update", "--release", "1.7.0"],
        1_000,
        { command: "/mock/capable-traycer", args: [] },
        vi.fn(),
        "op-missing-reservation",
        admission,
      ),
    ).toThrow(/admission was lost before spawn/i);
  });
});

// Cold-review finding 5 (automatic path): defaultHostAutoUpdateDeps + real
// capture/stream admission. Gate readiness, ABA the live channel generation,
// release, and prove the final CLI stream/spawn boundary is never reached.
describe("automatic host update - channel admission race", () => {
  it("ABA during readiness/busy await never reaches the real stream spawn boundary", async () => {
    const channel = installChannelSnapshotMock({
      allowPrerelease: false,
      generation: 0,
    });
    const fake = installFakeCli({
      runResult: {},
      streamResult: {
        version: "1.7.0",
        installedAt: "2026-05-15T00:00:00Z",
        executablePath: "/opt/traycer/host",
        source: { kind: "registry", value: "1.7.0" },
        archiveSha256: "a".repeat(64),
        signatureKeyId: "k",
        sizeBytes: 0,
      },
    });

    let releaseReady!: () => void;
    let markReadyEntered!: () => void;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const readyEntered = new Promise<void>((resolve) => {
      markReadyEntered = resolve;
    });

    // Import host-management first so defaultHostAutoUpdateDeps binds the
    // same real admission/reservation exports this suite already exercises.
    await import("../host-management-ipc");
    const { defaultHostAutoUpdateDeps, reconcileHostAutoUpdate } =
      await import("../../host/host-auto-update");

    const host = { getSnapshot: () => null } as never;
    const bridge = makeBridge();
    const base = defaultHostAutoUpdateDeps(
      host,
      5_000,
      async () => {
        markReadyEntered();
        await readyGate;
      },
      bridge as never,
    );
    const refreshAfter = vi.fn().mockResolvedValue(undefined);
    const deps = {
      ...base,
      // Keep registry state deterministic so the race is only about channel
      // generation, not probe/cache timing.
      checkUpdateState: vi.fn().mockResolvedValue({
        checkedAt: "2026-05-15T00:00:00Z",
        latestVersion: "1.7.0",
        installedVersion: "1.6.0",
        updateAvailable: true,
        reachable: true,
        errorMessage: null,
        includePreReleases: false,
      }),
      getHostWebsocketUrl: vi.fn(() => "ws://127.0.0.1:5000/rpc"),
      probeBusy: vi.fn().mockResolvedValue(false),
      refreshAfter,
    };

    const outcomePromise = reconcileHostAutoUpdate("auto-race", deps);
    await readyEntered;
    // A → B → A: allowPrerelease returns to false but generation is new, so
    // work captured under the first A must not re-admit.
    channel.set({ allowPrerelease: true, generation: 1 });
    channel.set({ allowPrerelease: false, generation: 2 });
    releaseReady();

    await expect(outcomePromise).resolves.toBe("failed");
    expect(fake.calls.filter((c) => c.kind === "stream")).toHaveLength(0);
    expect(refreshAfter).not.toHaveBeenCalled();
  });

  // Genuine RC opt-out (finding 5): capture an RC under includePreReleases,
  // flip the durable channel off during capability prework, and prove the
  // final stream/spawn boundary never runs.
  it("RC opt-out during capability prework never streams a captured release candidate", async () => {
    const channel = installChannelSnapshotMock({
      allowPrerelease: true,
      generation: 5,
    });
    const fake = installFakeCli({
      runResult: {},
      streamResult: {
        version: "1.7.0-rc.1",
        installedAt: "2026-05-15T00:00:00Z",
        executablePath: "/opt/traycer/host",
        source: { kind: "registry", value: "1.7.0-rc.1" },
        archiveSha256: "a".repeat(64),
        signatureKeyId: "k",
        sizeBytes: 0,
      },
    });

    let releaseCapability!: () => void;
    let markCapabilityEntered!: () => void;
    const capabilityGate = new Promise<void>((resolve) => {
      releaseCapability = resolve;
    });
    const capabilityEntered = new Promise<void>((resolve) => {
      markCapabilityEntered = resolve;
    });

    const { resolveExactHostUpdateCli } =
      await import("../../cli/host-update-cli");
    vi.mocked(resolveExactHostUpdateCli).mockImplementation(async () => {
      markCapabilityEntered();
      await capabilityGate;
      return { command: "/mock/capable-traycer", args: [] };
    });

    await import("../host-management-ipc");
    const { defaultHostAutoUpdateDeps, reconcileHostAutoUpdate } =
      await import("../../host/host-auto-update");

    const host = { getSnapshot: () => null } as never;
    const bridge = makeBridge();
    const base = defaultHostAutoUpdateDeps(
      host,
      5_000,
      () => Promise.resolve(),
      bridge as never,
    );
    const refreshAfter = vi.fn().mockResolvedValue(undefined);
    const deps = {
      ...base,
      checkUpdateState: vi.fn().mockResolvedValue({
        checkedAt: "2026-05-15T00:00:00Z",
        latestVersion: "1.7.0-rc.1",
        installedVersion: "1.6.0",
        updateAvailable: true,
        reachable: true,
        errorMessage: null,
        includePreReleases: true,
      }),
      getHostWebsocketUrl: vi.fn(() => null),
      probeBusy: vi.fn(),
      refreshAfter,
    };

    const outcomePromise = reconcileHostAutoUpdate("auto-rc-opt-out", deps);
    await capabilityEntered;
    // Single opt-out: RC consent withdrawn while capability is still awaiting.
    channel.set({ allowPrerelease: false, generation: 6 });
    releaseCapability();

    await expect(outcomePromise).resolves.toBe("failed");
    expect(fake.calls.filter((c) => c.kind === "stream")).toHaveLength(0);
    expect(refreshAfter).not.toHaveBeenCalled();
  });
});

describe("host-management IPC - app-facing stable/RC-only lists and installs", () => {
  it("filters alpha/beta/nightly from available versions even when includePreReleases is true", async () => {
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: vi.fn((args: readonly string[]) => {
        if (args[0] === "host" && args[1] === "available") {
          return Promise.resolve(multiVersionAvailablePayload());
        }
        return Promise.resolve({});
      }),
      streamTraycerCliJson: vi.fn(() => Promise.resolve({ data: {} })),
      TraycerCliError: class extends Error {},
    }));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const snapshot = (await bridge.handlers.get(
      RunnerHostInvoke.traycerHostAvailable,
    )!(null, { includePreReleases: true })) as {
      readonly versions: ReadonlyArray<{ readonly version: string }>;
    };

    expect(snapshot.versions.map((entry) => entry.version)).toEqual([
      "1.7.0",
      "1.7.0-rc.2",
    ]);
  });

  it("returns only stable versions when includePreReleases is false", async () => {
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: vi.fn((args: readonly string[]) => {
        if (args[0] === "host" && args[1] === "available") {
          return Promise.resolve(multiVersionAvailablePayload());
        }
        return Promise.resolve({});
      }),
      streamTraycerCliJson: vi.fn(() => Promise.resolve({ data: {} })),
      TraycerCliError: class extends Error {},
    }));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const snapshot = (await bridge.handlers.get(
      RunnerHostInvoke.traycerHostAvailable,
    )!(null, { includePreReleases: false })) as {
      readonly versions: ReadonlyArray<{ readonly version: string }>;
    };

    expect(snapshot.versions.map((entry) => entry.version)).toEqual(["1.7.0"]);
  });

  it("rejects explicit app installs of alpha/beta/nightly without spawning the CLI", async () => {
    const calls: RecordedCall[] = [];
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: vi.fn((args: readonly string[]) => {
        calls.push({ kind: "run", args: [...args], timeoutMs: undefined });
        return Promise.resolve({});
      }),
      streamTraycerCliJson: vi.fn(
        ({ args }: { readonly args: readonly string[] }) => {
          calls.push({ kind: "stream", args: [...args], timeoutMs: undefined });
          return Promise.resolve({ data: {} });
        },
      ),
      TraycerCliError: class extends Error {},
    }));
    // Even while RC is opted in, alpha/beta/nightly stay outside app admission.
    installChannelSnapshotMock({ allowPrerelease: true, generation: 1 });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const install = bridge.handlers.get(RunnerHostInvoke.traycerHostInstall)!;

    for (const version of [
      "1.7.0-alpha.1",
      "1.7.0-beta.3",
      "1.7.0-nightly.20260515",
    ]) {
      await expect(
        install(null, { version, operationId: `op-install-${version}` }),
      ).rejects.toThrow(/outside the currently selected release channel/i);
    }
    expect(calls.filter((c) => c.kind === "stream")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "run")).toHaveLength(0);
  });

  // Ticket enforce-current-channel: explicit app install re-reads the live
  // channel snapshot. Stable is always admitted; RC only while opted in;
  // a stale/crafted RC after opt-out must not start a Host operation or CLI.
  it("allows explicit stable installs under both update channels", async () => {
    const channel = installChannelSnapshotMock({
      allowPrerelease: false,
      generation: 0,
    });
    const fake = installFakeCli({
      runResult: {},
      streamResult: {
        version: "1.7.0",
        installedAt: "2026-05-15T00:00:00Z",
        executablePath: "/opt/traycer/host",
        source: { kind: "registry", value: "1.7.0" },
        archiveSha256: "a".repeat(64),
        signatureKeyId: "k",
        sizeBytes: 0,
      },
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const install = bridge.handlers.get(RunnerHostInvoke.traycerHostInstall)!;

    await install(null, {
      version: "1.7.0",
      operationId: "op-install-stable-channel-off",
    });
    channel.set({ allowPrerelease: true, generation: 1 });
    await install(null, {
      version: "1.7.0",
      operationId: "op-install-stable-channel-on",
    });

    const installStreams = fake.calls
      .filter(
        (c) =>
          c.kind === "stream" &&
          c.args[0] === "host" &&
          c.args[1] === "install",
      )
      .map((c) => c.args);
    expect(installStreams).toEqual([
      ["host", "install", "--release", "1.7.0"],
      ["host", "install", "--release", "1.7.0"],
    ]);
  });

  it("allows explicit RC install only while the prerelease channel is enabled", async () => {
    installChannelSnapshotMock({ allowPrerelease: true, generation: 3 });
    const fake = installFakeCli({
      runResult: {},
      streamResult: {
        version: "1.7.0-rc.2",
        installedAt: "2026-05-15T00:00:00Z",
        executablePath: "/opt/traycer/host",
        source: { kind: "registry", value: "1.7.0-rc.2" },
        archiveSha256: "a".repeat(64),
        signatureKeyId: "k",
        sizeBytes: 0,
      },
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const install = bridge.handlers.get(RunnerHostInvoke.traycerHostInstall)!;

    await install(null, {
      version: "1.7.0-rc.2",
      operationId: "op-install-rc-opted-in",
    });

    const installStreams = fake.calls.filter(
      (c) =>
        c.kind === "stream" && c.args[0] === "host" && c.args[1] === "install",
    );
    expect(installStreams).toHaveLength(1);
    expect(installStreams[0]?.args).toEqual([
      "host",
      "install",
      "--release",
      "1.7.0-rc.2",
    ]);
  });

  it("rejects stale/crafted RC install after opt-out before Host operation or CLI", async () => {
    installChannelSnapshotMock({ allowPrerelease: false, generation: 4 });
    const fake = installFakeCli({
      runResult: {},
      streamResult: {
        version: "1.7.0-rc.2",
        installedAt: "2026-05-15T00:00:00Z",
        executablePath: "/opt/traycer/host",
        source: { kind: "registry", value: "1.7.0-rc.2" },
        archiveSha256: "a".repeat(64),
        signatureKeyId: "k",
        sizeBytes: 0,
      },
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke, RunnerHostEvent } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const install = bridge.handlers.get(RunnerHostInvoke.traycerHostInstall)!;

    await expect(
      install(null, {
        version: "1.7.0-rc.2",
        operationId: "op-install-rc-opted-out",
      }),
    ).rejects.toThrow(/outside the currently selected release channel/i);

    // Rejected before clearHostRemoval / runHostOperation / streamCliWithProgress.
    expect(fake.calls.filter((c) => c.kind === "stream")).toHaveLength(0);
    expect(fake.calls.filter((c) => c.kind === "run")).toHaveLength(0);
    expect(mgmt.getHostOperationStatus()).toBeNull();
    expect(
      bridge.fanOut.mock.calls.filter(
        ([channel]) => channel === RunnerHostEvent.hostOperationStatusChange,
      ),
    ).toHaveLength(0);
  });

  it("refuses a manual update whose expectedVersion is outside stable/RC", async () => {
    const fake = installFakeCli({
      runResult: {},
      streamResult: {},
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await expect(
      bridge.handlers.get(RunnerHostInvoke.traycerHostUpdate)!(null, {
        operationId: "op-bad-expected",
        expectedVersion: "1.7.0-alpha.1",
      }),
    ).rejects.toThrow(/stable and release-candidate channels/i);
    expect(fake.calls.filter((c) => c.kind === "stream")).toHaveLength(0);
  });
});

// Final Host admission hardening: force-refresh + updateAvailable on manual
// update; exact pin for null/latest install; channel revalidation before
// install spawn; install prework reservation; unavailable current-channel
// target refusal.
describe("host-management IPC - final admission hardening", () => {
  it("force-refreshes and refuses a stale-cache external-upgrade downgrade (no stream)", async () => {
    // Cache claims installed 1.4.0 with an "update" to 1.5.0, but the real
    // install is already 1.6.0 (operator `host install` outside Desktop).
    // Manual update must force-refresh and refuse via updateAvailable, not
    // trust the 24h cache to authorize a downgrade.
    writeRegistryCache({
      checkedAt: new Date().toISOString(),
      latestVersion: "1.5.0",
      installedVersion: "1.4.0",
      reachable: true,
      errorMessage: null,
    });
    writeInstallRecord("production", {
      version: "1.6.0",
      platform: process.platform,
      arch: process.arch,
      installedAt: "2026-05-15T00:00:00Z",
      executablePath: "/opt/traycer/host",
      source: { kind: "registry", value: "1.6.0" },
      archiveSha256: "a".repeat(64),
      signatureKeyId: "k",
      sizeBytes: 1234,
    });

    const calls: RecordedCall[] = [];
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: vi.fn((args: readonly string[]) => {
        calls.push({ kind: "run", args: [...args], timeoutMs: undefined });
        if (args[0] === "host" && args[1] === "available") {
          // Fresh registry still only knows about 1.5.0.
          return Promise.resolve(fakeHostAvailablePayload("1.5.0"));
        }
        return Promise.resolve({});
      }),
      streamTraycerCliJson: vi.fn(
        ({ args }: { readonly args: readonly string[] }) => {
          calls.push({ kind: "stream", args: [...args], timeoutMs: undefined });
          return Promise.resolve({ data: {} });
        },
      ),
      TraycerCliError: class extends Error {},
    }));

    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await expect(
      bridge.handlers.get(RunnerHostInvoke.traycerHostUpdate)!(null, {
        operationId: "op-stale-cache-downgrade",
        expectedVersion: "1.5.0",
      }),
    ).rejects.toThrow(/No newer host update is available/i);

    expect(calls.filter((c) => c.kind === "stream")).toHaveLength(0);
    // Force-refresh must have re-probed the registry rather than serving cache.
    expect(
      calls.some(
        (c) =>
          c.kind === "run" && c.args[0] === "host" && c.args[1] === "available",
      ),
    ).toBe(true);
  });

  it("pins exact stable version for null and latest install (never streams host install latest)", async () => {
    installChannelSnapshotMock({ allowPrerelease: false, generation: 0 });
    const fake = installFakeCli({
      runResult: {},
      streamResult: {
        version: "1.7.0",
        installedAt: "2026-05-15T00:00:00Z",
        executablePath: "/opt/traycer/host",
        source: { kind: "registry", value: "1.7.0" },
        archiveSha256: "a".repeat(64),
        signatureKeyId: "k",
        sizeBytes: 0,
      },
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const install = bridge.handlers.get(RunnerHostInvoke.traycerHostInstall)!;

    // Doctor repair path: version null.
    await install(null, {
      version: null,
      operationId: "op-install-null",
    });
    // Explicit "latest" pointer from older callers.
    await install(null, {
      version: "latest",
      operationId: "op-install-latest",
    });

    const installStreams = fake.calls.filter(
      (c) =>
        c.kind === "stream" && c.args[0] === "host" && c.args[1] === "install",
    );
    expect(installStreams.map((c) => c.args)).toEqual([
      ["host", "install", "--release", "1.7.0"],
      ["host", "install", "--release", "1.7.0"],
    ]);
    for (const call of installStreams) {
      expect(call.args).not.toContain("latest");
    }
  });

  it("pins exact RC version for null install while the prerelease channel is enabled", async () => {
    // Doctor host-install-latest with version:null must follow the shared
    // channel: RC opt-in → exact newest consented RC (never the moving
    // stable `latest` pointer).
    installChannelSnapshotMock({ allowPrerelease: true, generation: 2 });
    const calls: RecordedCall[] = [];
    // Stable 1.7.0 plus a newer RC so the channel-aware pick is the RC.
    const rcAheadPayload = {
      manifest: {
        schemaVersion: 1,
        generatedAt: "2026-05-15T00:00:00Z",
        latest: "1.7.0",
        versions: ["1.7.0", "1.8.0-rc.1"].map((version) => ({
          version,
          releasedAt: "2026-05-15T00:00:00Z",
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
              sha256: "abc",
              signatureUrl: "https://example.invalid/host.tar.gz.minisig",
              signatureAlgorithm: "minisign",
              publicKeyId: "test-key",
            },
          },
        })),
      },
      platformKey: "darwin-arm64",
      manifestUrl: "https://example.invalid/versions.json",
    };
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: vi.fn((args: readonly string[]) => {
        calls.push({ kind: "run", args: [...args], timeoutMs: undefined });
        if (args[0] === "host" && args[1] === "available") {
          return Promise.resolve(rcAheadPayload);
        }
        return Promise.resolve({});
      }),
      streamTraycerCliJson: vi.fn(
        ({ args }: { readonly args: readonly string[] }) => {
          calls.push({ kind: "stream", args: [...args], timeoutMs: undefined });
          return Promise.resolve({
            data: {
              version: "1.8.0-rc.1",
              installedAt: "2026-05-15T00:00:00Z",
              executablePath: "/opt/traycer/host",
              source: { kind: "registry", value: "1.8.0-rc.1" },
              archiveSha256: "a".repeat(64),
              signatureKeyId: "k",
              sizeBytes: 0,
            },
          });
        },
      ),
      resolveTraycerCliInvocation: vi.fn().mockResolvedValue({
        command: "/mock/traycer",
        args: [],
      }),
      TraycerCliError: class extends Error {},
    }));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await bridge.handlers.get(RunnerHostInvoke.traycerHostInstall)!(null, {
      version: null,
      operationId: "op-doctor-rc-latest",
    });

    const installStreams = calls.filter(
      (c) =>
        c.kind === "stream" && c.args[0] === "host" && c.args[1] === "install",
    );
    expect(installStreams).toHaveLength(1);
    expect(installStreams[0]?.args).toEqual([
      "host",
      "install",
      "--release",
      "1.8.0-rc.1",
    ]);
    expect(
      calls.some(
        (c) =>
          c.kind === "run" &&
          c.args[0] === "host" &&
          c.args[1] === "available" &&
          c.args.includes("--include-pre-releases"),
      ),
    ).toBe(true);
  });

  it("refuses null/latest install when the current-channel target is unavailable (no stream)", async () => {
    installChannelSnapshotMock({ allowPrerelease: false, generation: 0 });
    const calls: RecordedCall[] = [];
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: vi.fn((args: readonly string[]) => {
        calls.push({ kind: "run", args: [...args], timeoutMs: undefined });
        if (args[0] === "host" && args[1] === "available") {
          return Promise.resolve({
            manifest: {
              schemaVersion: 1,
              generatedAt: "2026-05-15T00:00:00Z",
              latest: "1.7.0",
              versions: [
                {
                  version: "1.7.0",
                  releasedAt: "2026-05-15T00:00:00Z",
                  releaseNotesUrl: "https://example.invalid/notes",
                  yanked: false,
                  deprecationReason: null,
                  requiredCliVersion: null,
                  platforms: {
                    "darwin-arm64": {
                      available: false,
                      unavailableReason: "not published for platform",
                      url: "https://example.invalid/host.tar.gz",
                      sizeBytes: 1024,
                      sha256: "abc",
                      signatureUrl:
                        "https://example.invalid/host.tar.gz.minisig",
                      signatureAlgorithm: "minisign",
                      publicKeyId: "test-key",
                    },
                  },
                },
              ],
            },
            platformKey: "darwin-arm64",
            manifestUrl: "https://example.invalid/versions.json",
          });
        }
        return Promise.resolve({});
      }),
      streamTraycerCliJson: vi.fn(
        ({ args }: { readonly args: readonly string[] }) => {
          calls.push({ kind: "stream", args: [...args], timeoutMs: undefined });
          return Promise.resolve({ data: {} });
        },
      ),
      TraycerCliError: class extends Error {},
    }));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await expect(
      bridge.handlers.get(RunnerHostInvoke.traycerHostInstall)!(null, {
        version: null,
        operationId: "op-install-unavailable",
      }),
    ).rejects.toThrow(/available exact target version/i);
    expect(calls.filter((c) => c.kind === "stream")).toHaveLength(0);
  });

  it("refuses explicit RC install spawn when the channel flips during removal prework", async () => {
    const channel = installChannelSnapshotMock({
      allowPrerelease: true,
      generation: 7,
    });
    let releasePrework!: () => void;
    let markPreworkEntered!: () => void;
    const preworkGate = new Promise<void>((resolve) => {
      releasePrework = resolve;
    });
    const preworkEntered = new Promise<void>((resolve) => {
      markPreworkEntered = resolve;
    });
    vi.doMock("../../host/host-removal-state", () => ({
      isHostRemovedByUser: async () => {
        markPreworkEntered();
        await preworkGate;
        return false;
      },
      clearHostRemovedByUser: async () => undefined,
      markHostRemovedByUser: async () => undefined,
    }));
    const fake = installFakeCli({
      runResult: {},
      streamResult: {
        version: "1.7.0-rc.2",
        installedAt: "2026-05-15T00:00:00Z",
        executablePath: "/opt/traycer/host",
        source: { kind: "registry", value: "1.7.0-rc.2" },
        archiveSha256: "a".repeat(64),
        signatureKeyId: "k",
        sizeBytes: 0,
      },
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const installPromise = bridge.handlers.get(
      RunnerHostInvoke.traycerHostInstall,
    )!(null, {
      version: "1.7.0-rc.2",
      operationId: "op-install-opt-out-prework",
    });

    await preworkEntered;
    channel.set({ allowPrerelease: false, generation: 8 });
    releasePrework();

    await expect(installPromise).rejects.toThrow(/channel changed/i);
    expect(fake.calls.filter((c) => c.kind === "stream")).toHaveLength(0);
  });

  it("refuses explicit RC install spawn when the channel flips during CLI discovery", async () => {
    const channel = installChannelSnapshotMock({
      allowPrerelease: true,
      generation: 9,
    });
    let releaseDiscovery!: () => void;
    let markDiscoveryEntered!: () => void;
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const discoveryEntered = new Promise<void>((resolve) => {
      markDiscoveryEntered = resolve;
    });
    const calls: RecordedCall[] = [];
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: vi.fn(() => Promise.resolve({})),
      resolveTraycerCliInvocation: vi.fn(async () => {
        markDiscoveryEntered();
        await discoveryGate;
        return { command: "/mock/traycer", args: [] };
      }),
      streamTraycerCliJson: vi.fn(
        ({ args }: { readonly args: readonly string[] }) => {
          calls.push({ kind: "stream", args: [...args], timeoutMs: undefined });
          return Promise.resolve({ data: {} });
        },
      ),
      TraycerCliError: class extends Error {},
    }));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const installPromise = bridge.handlers.get(
      RunnerHostInvoke.traycerHostInstall,
    )!(null, {
      version: "1.7.0-rc.2",
      operationId: "op-install-opt-out-discovery",
    });

    await discoveryEntered;
    channel.set({ allowPrerelease: false, generation: 10 });
    releaseDiscovery();

    await expect(installPromise).rejects.toThrow(/channel changed/i);
    expect(calls.filter((c) => c.kind === "stream")).toHaveLength(0);
  });

  it("rejects a concurrent install while install registry prework is still reserved", async () => {
    installChannelSnapshotMock({ allowPrerelease: false, generation: 0 });
    let releaseAvailable!: () => void;
    let markAvailableEntered!: () => void;
    const availableGate = new Promise<void>((resolve) => {
      releaseAvailable = resolve;
    });
    const availableEntered = new Promise<void>((resolve) => {
      markAvailableEntered = resolve;
    });
    const calls: RecordedCall[] = [];
    vi.doMock("../../cli/traycer-cli", () => ({
      runTraycerCliJson: vi.fn(async (args: readonly string[]) => {
        calls.push({ kind: "run", args: [...args], timeoutMs: undefined });
        if (args[0] === "host" && args[1] === "available") {
          markAvailableEntered();
          await availableGate;
          return fakeHostAvailablePayload("1.7.0");
        }
        return {};
      }),
      streamTraycerCliJson: vi.fn(
        ({ args }: { readonly args: readonly string[] }) => {
          calls.push({ kind: "stream", args: [...args], timeoutMs: undefined });
          return Promise.resolve({
            data: {
              version: "1.7.0",
              installedAt: "2026-05-15T00:00:00Z",
              executablePath: "/opt/traycer/host",
              source: { kind: "registry", value: "1.7.0" },
              archiveSha256: "a".repeat(64),
              signatureKeyId: "k",
              sizeBytes: 0,
            },
          });
        },
      ),
      resolveTraycerCliInvocation: vi.fn().mockResolvedValue({
        command: "/mock/traycer",
        args: [],
      }),
      TraycerCliError: class extends Error {},
    }));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const install = bridge.handlers.get(RunnerHostInvoke.traycerHostInstall)!;

    const first = install(null, {
      version: null,
      operationId: "op-install-prework-first",
    });
    await availableEntered;
    expect(mgmt.getHostOperationStatus()).toMatchObject({
      kind: "install",
      operationId: "op-install-prework-first",
    });
    expect(calls.filter((c) => c.kind === "stream")).toHaveLength(0);

    await expect(
      install(null, {
        version: "1.7.0",
        operationId: "op-install-prework-second",
      }),
    ).rejects.toThrow(/already in progress/i);

    releaseAvailable();
    await first;
    expect(calls.filter((c) => c.kind === "stream")).toHaveLength(1);
  });
});

// Dialog-hang RCA finding 2: `traycerHostRestart` used to call
// `runTraycerCliJson`, whose hardcoded 10s default is shorter than the CLI's
// stop-grace (32s) - a slow-draining host got SIGKILLed between `stop` and
// `start`, leaving it down. The fix routes this handler through
// `streamTraycerCliJson` with the shared `HOST_RESTART_SUBPROCESS_TIMEOUT_MS`
// budget instead.
describe("host-management IPC - restart timeout budget", () => {
  it("traycerHostRestart streams the CLI restart with the shared HOST_RESTART_SUBPROCESS_TIMEOUT_MS budget, not the 10s runTraycerCliJson default", async () => {
    const fake = installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const { HOST_RESTART_SUBPROCESS_TIMEOUT_MS } =
      await import("@traycer/protocol/host/lifecycle-constants");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await bridge.handlers.get(RunnerHostInvoke.traycerHostRestart)!(null, null);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.kind).toBe("stream");
    expect(fake.calls[0]?.args).toEqual(["host", "restart"]);
    expect(fake.calls[0]?.timeoutMs).toBe(HOST_RESTART_SUBPROCESS_TIMEOUT_MS);
  });

  it("keeps the restart budget comfortably above the macOS CLI's stop-grace so a slow drain can't regress into a mid-restart SIGKILL", async () => {
    const {
      HOST_RESTART_SUBPROCESS_TIMEOUT_MS,
      SHUTDOWN_FORCE_EXIT_MS,
      STOP_EXIT_GRACE_MARGIN_MS,
    } = await import("@traycer/protocol/host/lifecycle-constants");
    const stopGrace = SHUTDOWN_FORCE_EXIT_MS + STOP_EXIT_GRACE_MARGIN_MS;
    // A budget merely equal to the stop-grace regresses to the original
    // bug (SIGKILL lands the instant `stop` finishes, before `start` runs).
    // Require real headroom above it, not just `>`.
    expect(HOST_RESTART_SUBPROCESS_TIMEOUT_MS).toBeGreaterThanOrEqual(
      stopGrace + 30_000,
    );
  });

  // Review finding 1: a budget sized only for macOS's stop-grace can still
  // SIGKILL a legitimate, slow-but-successful Windows restart mid-sequence -
  // `schtasks /End` + the PowerShell process scan + `taskkill` + `schtasks
  // /Run` can cumulatively take longer than the macOS-only 92s budget did.
  it("keeps the restart budget comfortably above the Windows restart sequence's own worst case", async () => {
    const {
      HOST_RESTART_SUBPROCESS_TIMEOUT_MS,
      WINDOWS_RESTART_SEQUENCE_TIMEOUT_MS,
    } = await import("@traycer/protocol/host/lifecycle-constants");
    // A budget merely equal to the Windows sequence's own worst case
    // regresses to the same class of bug - SIGKILL lands the instant the
    // sequence would have finished. Require real headroom above it.
    expect(HOST_RESTART_SUBPROCESS_TIMEOUT_MS).toBeGreaterThanOrEqual(
      WINDOWS_RESTART_SEQUENCE_TIMEOUT_MS + 15_000,
    );
  });

  // Review finding 3: Doctor's "Free Port + Restart" also SIGTERMs a
  // confirmed foreign process and then awaits a platform service restart
  // with the same 10-100s deadlines, so it needs the same restart-safe
  // budget as `traycerHostRestart` instead of the 10s `runTraycerCliJson`
  // default it used to carry.
  it("traycerFreePortAndRestart streams the CLI restart with the shared HOST_RESTART_SUBPROCESS_TIMEOUT_MS budget, not the 10s runTraycerCliJson default", async () => {
    const fake = installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const { HOST_RESTART_SUBPROCESS_TIMEOUT_MS } =
      await import("@traycer/protocol/host/lifecycle-constants");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await bridge.handlers.get(RunnerHostInvoke.traycerFreePortAndRestart)!(
      null,
      { port: 7000, pid: 1234, processName: "rogue" },
    );

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.kind).toBe("stream");
    expect(fake.calls[0]?.args.slice(0, 2)).toEqual([
      "host",
      "free-port-and-restart",
    ]);
    expect(fake.calls[0]?.timeoutMs).toBe(HOST_RESTART_SUBPROCESS_TIMEOUT_MS);
  });
});

// Review finding 4: `traycerHostRestart` used to call `streamTraycerCliJson`
// directly with a no-op event sink, so `HostOperationStatus` stayed null
// during a restart - a second Settings window showed no banner and could
// launch a competing restart that lost on `cli-lock` with a spurious error.
// The fix routes restart through the same `trackHostOperation` seam
// install/update/register-service already use.
describe("host-management IPC - restart routes through the canonical operation-status/single-flight guard", () => {
  it("reports HostOperationStatus.kind === 'restart' while a restart is running and clears it back to null on settle", async () => {
    const fake = installFakeCliWithDeferredStream();
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke, RunnerHostEvent } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const statusHandler = bridge.handlers.get(
      RunnerHostInvoke.traycerHostOperationStatusGet,
    )!;
    expect(await statusHandler(null, null)).toBeNull();

    const restartPromise = bridge.handlers.get(
      RunnerHostInvoke.traycerHostRestart,
    )!(null, null);
    await waitForStreamCallCount(fake, 1);

    expect(await statusHandler(null, null)).toMatchObject({ kind: "restart" });
    const statusCalls = () =>
      bridge.fanOut.mock.calls.filter(
        ([channel]) => channel === RunnerHostEvent.hostOperationStatusChange,
      );
    expect(statusCalls()[0]?.[1]).toMatchObject({
      kind: "restart",
      percent: null,
    });

    fake.resolveStream({});
    await restartPromise;

    expect(mgmt.getHostOperationStatus()).toBeNull();
    expect(await statusHandler(null, null)).toBeNull();
  });

  it("rejects a second concurrent host operation while a restart is in flight, without spawning a second CLI subprocess", async () => {
    const fake = installFakeCliWithDeferredStream();
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const restartPromise = bridge.handlers.get(
      RunnerHostInvoke.traycerHostRestart,
    )!(null, null);
    await waitForStreamCallCount(fake, 1);

    await expect(
      bridge.handlers.get(RunnerHostInvoke.traycerHostUpdate)!(null, {
        operationId: "op-update",
      }),
    ).rejects.toThrow(
      /Another host operation \(restart\) is already in progress/i,
    );

    // Only ONE CLI subprocess was ever spawned - the second call never
    // reached the CLI lock at all.
    expect(fake.calls.filter((c) => c.kind === "stream")).toHaveLength(1);

    fake.resolveStream({});
    await restartPromise;
  });

  // Review follow-up finding: neither `host restart` nor the hidden
  // `host free-port-and-restart` CLI command takes the CLI's own file lock
  // (`withCliLock`), so `trackHostOperation` is the ONLY same-process
  // protection against the two interleaving their stop/kill/start
  // sequences. Both directions must be covered - either one racing the
  // other must lose without spawning a second CLI subprocess.
  it("rejects a concurrent traycerFreePortAndRestart while a tracked restart is in flight, without spawning a second CLI subprocess", async () => {
    const fake = installFakeCliWithDeferredStream();
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const restartPromise = bridge.handlers.get(
      RunnerHostInvoke.traycerHostRestart,
    )!(null, null);
    await waitForStreamCallCount(fake, 1);

    await expect(
      bridge.handlers.get(RunnerHostInvoke.traycerFreePortAndRestart)!(null, {
        port: 7000,
        pid: 1234,
        processName: "rogue",
      }),
    ).rejects.toThrow(
      /Another host operation \(restart\) is already in progress/i,
    );

    expect(fake.calls.filter((c) => c.kind === "stream")).toHaveLength(1);

    fake.resolveStream({});
    await restartPromise;
  });

  it("rejects a concurrent traycerHostRestart while a tracked free-port-and-restart is in flight, without spawning a second CLI subprocess", async () => {
    const fake = installFakeCliWithDeferredStream();
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const freePortPromise = bridge.handlers.get(
      RunnerHostInvoke.traycerFreePortAndRestart,
    )!(null, { port: 7000, pid: 1234, processName: "rogue" });
    await waitForStreamCallCount(fake, 1);

    await expect(
      bridge.handlers.get(RunnerHostInvoke.traycerHostRestart)!(null, null),
    ).rejects.toThrow(
      /Another host operation \(free-port-and-restart\) is already in progress/i,
    );

    expect(fake.calls.filter((c) => c.kind === "stream")).toHaveLength(1);

    fake.resolveStream({});
    await freePortPromise;
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "../../__tests__/sandbox-home";
import { TraycerCliError } from "../../cli/traycer-cli";
import { classifyCliShellError } from "../host-management-ipc";

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

describe("classifyCliShellError", () => {
  it("maps a plain Error to cli-unavailable", () => {
    expect(classifyCliShellError(new Error("no CLI on PATH"))).toBe(
      "cli-unavailable",
    );
  });

  it("maps TraycerCliError with exitCode 0 and code null to invalid-output", () => {
    expect(
      classifyCliShellError(
        new TraycerCliError(
          {
            message: "CLI exited cleanly with no result line",
            code: null,
            details: null,
            exitCode: 0,
            stderrTail: "",
          },
          null,
        ),
      ),
    ).toBe("invalid-output");
  });

  it("maps TraycerCliError with a code to cli-failed", () => {
    expect(
      classifyCliShellError(
        new TraycerCliError(
          {
            message: "install failed",
            code: "E_HOST_INSTALL_FAILED",
            details: null,
            exitCode: 1,
            stderrTail: "failed",
          },
          null,
        ),
      ),
    ).toBe("cli-failed");
  });

  it("maps TraycerCliError with a non-zero exit to cli-failed", () => {
    expect(
      classifyCliShellError(
        new TraycerCliError(
          {
            message: "process crashed",
            code: null,
            details: null,
            exitCode: 2,
            stderrTail: "segfault",
          },
          null,
        ),
      ),
    ).toBe("cli-failed");
  });
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

function beginSandbox(): void {
  workHome = mkdtempSync(join(tmpdir(), "traycer-maintenance-ipc-"));
  sandboxHome(workHome);
  vi.resetModules();
}

function endSandbox(): void {
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
}

function installFakeCli(runResult: unknown): void {
  vi.doMock("../../cli/traycer-cli", async () => {
    const actual = await vi.importActual<
      typeof import("../../cli/traycer-cli")
    >("../../cli/traycer-cli");
    return {
      ...actual,
      runBundledTraycerCliJson: vi.fn(() => Promise.resolve(runResult)),
    };
  });
}

interface HandlerBridge {
  readonly handlers: Map<
    string,
    (event: unknown, raw: unknown) => Promise<unknown>
  >;
  handleInvoke(
    channel: string,
    handler: (event: unknown, raw: unknown) => unknown | Promise<unknown>,
  ): void;
  readonly options: {
    readonly host: {
      readonly reloadSnapshotFromDisk: () => Promise<null>;
      readonly getSnapshot: () => { readonly version: string };
    };
    readonly hostController: {
      readonly getStatus: () => Promise<{ readonly updateReady: boolean }>;
    };
  };
}

function makeBridge(): HandlerBridge {
  const handlers = new Map<
    string,
    (event: unknown, raw: unknown) => Promise<unknown>
  >();
  return {
    handlers,
    options: {
      host: {
        reloadSnapshotFromDisk: () => Promise.resolve(null),
        getSnapshot: () => ({ version: "1.1.11" }),
      },
      hostController: {
        getStatus: () => Promise.resolve({ updateReady: false }),
      },
    },
    handleInvoke(channel, handler) {
      handlers.set(channel, async (event, raw) => handler(event, raw));
    },
  };
}

function realShapedAvailablePayload(): unknown {
  return {
    platformKey: "darwin-arm64",
    manifestUrl: "https://example.invalid/manifest.json",
    manifest: {
      schemaVersion: 1,
      generatedAt: "2026-08-12T00:00:00Z",
      latest: "1.2.0",
      versions: [
        {
          version: "1.2.0",
          releasedAt: "2026-08-12T00:00:00Z",
          releaseNotesUrl: "https://example.invalid/notes",
          yanked: false,
          deprecationReason: null,
          requiredCliVersion: "1.4.0",
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
    },
  };
}

describe("maintenanceUpdateCheck IPC", () => {
  beforeEach(beginSandbox);
  afterEach(endSandbox);

  it("parses a real-shaped CLI manifest on the ok arm", async () => {
    installFakeCli(realShapedAvailablePayload());
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const handler = bridge.handlers.get(
      RunnerHostInvoke.traycerMaintenanceUpdateCheck,
    );
    expect(handler).toBeDefined();
    if (handler === undefined) {
      throw new Error("expected maintenanceUpdateCheck handler");
    }
    const result = await handler(null, { includePreReleases: false });
    expect(result).toEqual({
      outcome: "ok",
      manifest: {
        schemaVersion: 1,
        generatedAt: "2026-08-12T00:00:00Z",
        latest: "1.2.0",
        versions: [
          {
            version: "1.2.0",
            releasedAt: "2026-08-12T00:00:00Z",
            releaseNotesUrl: "https://example.invalid/notes",
            yanked: false,
            deprecationReason: null,
            requiredCliVersion: "1.4.0",
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
      },
    });
  });

  it("returns invalid-output for a malformed manifest", async () => {
    installFakeCli({ manifest: { schemaVersion: 1 } });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const handler = bridge.handlers.get(
      RunnerHostInvoke.traycerMaintenanceUpdateCheck,
    );
    expect(handler).toBeDefined();
    if (handler === undefined) {
      throw new Error("expected maintenanceUpdateCheck handler");
    }
    await expect(handler(null, { includePreReleases: false })).resolves.toEqual(
      {
        outcome: "invalid-output",
      },
    );
  });
});

describe("maintenanceInstallationInfo IPC", () => {
  beforeEach(beginSandbox);
  afterEach(endSandbox);

  it("answers unmanaged when install.json is missing", async () => {
    installFakeCli({});
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const handler = bridge.handlers.get(
      RunnerHostInvoke.traycerMaintenanceInstallationInfo,
    );
    expect(handler).toBeDefined();
    if (handler === undefined) {
      throw new Error("expected maintenanceInstallationInfo handler");
    }
    await expect(handler(null, null)).resolves.toEqual({
      status: "unmanaged",
    });
  });

  it("answers managed from protocol-shaped install, staged, and CLI records", async () => {
    installFakeCli({});
    const installDir = join(workHome, ".traycer", "host", "install");
    const stagedDir = join(workHome, ".traycer", "host", "staged");
    const cliDir = join(workHome, ".traycer", "cli");
    mkdirSync(installDir, { recursive: true });
    mkdirSync(stagedDir, { recursive: true });
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(
      join(installDir, "install.json"),
      JSON.stringify({
        installId: "inst-1",
        version: "1.1.11",
        runtimeVersion: "1.1.11",
        platform: "darwin",
        arch: "arm64",
        installedAt: "2026-08-10T00:00:00Z",
        source: { kind: "registry", value: "1.1.11" },
        archiveSha256: "b".repeat(64),
        signatureVerifiedAt: "2026-08-10T00:00:00Z",
        signatureKeyId: "key-1",
        sizeBytes: 2048,
        executablePath: "/tmp/traycer/1.1.11/host",
      }),
      "utf8",
    );
    writeFileSync(
      join(stagedDir, "staged.json"),
      JSON.stringify({
        schemaVersion: 1,
        stageId: "stage-1",
        version: "1.2.0",
        runtimeVersion: "1.2.0",
        archiveSha256: "c".repeat(64),
        sizeBytes: 4096,
        source: { kind: "registry", value: "1.2.0" },
        signatureKeyId: "key-1",
        signatureVerifiedAt: "2026-08-12T00:00:00Z",
        executablePath: "host",
        platform: "darwin",
        arch: "arm64",
      }),
      "utf8",
    );
    writeFileSync(
      join(cliDir, "manifest.json"),
      JSON.stringify({
        version: "1.4.0",
        installedAt: "2026-08-01T00:00:00Z",
        binaryPath: "/usr/local/bin/traycer",
        source: "desktop",
        pendingUpgrade: null,
      }),
      "utf8",
    );

    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    const handler = bridge.handlers.get(
      RunnerHostInvoke.traycerMaintenanceInstallationInfo,
    );
    expect(handler).toBeDefined();
    if (handler === undefined) {
      throw new Error("expected maintenanceInstallationInfo handler");
    }
    const result = await handler(null, null);
    expect(result).toEqual({
      status: "managed",
      installRecord: {
        installId: "inst-1",
        version: "1.1.11",
        runtimeVersion: "1.1.11",
        platform: "darwin",
        arch: "arm64",
        installedAt: "2026-08-10T00:00:00Z",
        source: { kind: "registry", value: "1.1.11" },
        archiveSha256: "b".repeat(64),
        signatureVerifiedAt: "2026-08-10T00:00:00Z",
        signatureKeyId: "key-1",
        sizeBytes: 2048,
        executablePath: "/tmp/traycer/1.1.11/host",
      },
      stagedRecord: {
        schemaVersion: 1,
        stageId: "stage-1",
        version: "1.2.0",
        runtimeVersion: "1.2.0",
        archiveSha256: "c".repeat(64),
        sizeBytes: 4096,
        source: { kind: "registry", value: "1.2.0" },
        signatureKeyId: "key-1",
        signatureVerifiedAt: "2026-08-12T00:00:00Z",
        executablePath: "host",
        platform: "darwin",
        arch: "arm64",
      },
      cliManifest: {
        version: "1.4.0",
        installedAt: "2026-08-01T00:00:00Z",
        binaryPath: "/usr/local/bin/traycer",
        source: "desktop",
        pendingUpgrade: null,
      },
    });
  });
});

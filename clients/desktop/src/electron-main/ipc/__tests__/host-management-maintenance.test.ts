import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InstallVersionOk,
  MutationKind,
  MutationLaneStatus,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import type { LifecycleAdmissionBlock } from "../../host/host-controller-types";
import { sandboxHome } from "../../__tests__/sandbox-home";
import { TraycerCliError } from "../../cli/traycer-cli";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import {
  admissionBlockRestartMessage,
  classifyCliShellError,
  laneBusyRestartMessage,
} from "../host-management-ipc";

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

// Enumerated independently of the switch so a new MutationKind fails here
// instead of silently inheriting a default (there is none — the switch is
// exhaustive, and this list is the second fence).
const ALL_MUTATION_KINDS: readonly MutationKind[] = [
  "ensure",
  "apply",
  "activate",
  "install",
  "register",
  "deregister",
  "respawn",
  "recoverIfDown",
  "freePortAndRestart",
  "uninstallHost",
  "removeTraycer",
];

describe("laneBusyRestartMessage", () => {
  it("returns a non-empty message for every MutationKind", () => {
    for (const kind of ALL_MUTATION_KINDS) {
      expect(laneBusyRestartMessage(kind).length).toBeGreaterThan(0);
    }
  });

  it("groups kinds by the operation the watcher should wait for", () => {
    const installing =
      "Traycer is installing an update on this host. Restart it once that finishes.";
    const service =
      "Traycer is changing this host's background service. Restart it once that finishes.";
    const removing =
      "Traycer is removing this host. There is nothing to restart until that finishes.";
    const restarting = "This host is already restarting.";
    expect(laneBusyRestartMessage("install")).toBe(installing);
    expect(laneBusyRestartMessage("apply")).toBe(installing);
    expect(laneBusyRestartMessage("activate")).toBe(installing);
    expect(laneBusyRestartMessage("ensure")).toBe(installing);
    expect(laneBusyRestartMessage("register")).toBe(service);
    expect(laneBusyRestartMessage("deregister")).toBe(service);
    expect(laneBusyRestartMessage("uninstallHost")).toBe(removing);
    expect(laneBusyRestartMessage("removeTraycer")).toBe(removing);
    expect(laneBusyRestartMessage("respawn")).toBe(restarting);
    expect(laneBusyRestartMessage("recoverIfDown")).toBe(restarting);
    expect(laneBusyRestartMessage("freePortAndRestart")).toBe(restarting);
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

const bundledCliCalls: string[][] = [];

type CliErrorCtor = typeof TraycerCliError;

function installFakeCli(
  run: (args: readonly string[], CliError: CliErrorCtor) => Promise<unknown>,
): void {
  bundledCliCalls.length = 0;
  vi.doMock("../../cli/traycer-cli", async () => {
    const actual = await vi.importActual<
      typeof import("../../cli/traycer-cli")
    >("../../cli/traycer-cli");
    const runJson = (args: readonly string[]) => {
      bundledCliCalls.push([...args]);
      return run(args, actual.TraycerCliError);
    };
    return {
      ...actual,
      // Both the maintenance projections and `traycerHostAvailable` have to
      // see the same throw so a test can pin that the two lanes now DIVERGE
      // on `E_HOST_VERIFY_FAILED`.
      runBundledTraycerCliJson: vi.fn(runJson),
      runTraycerCliJson: vi.fn(runJson),
    };
  });
}

function resolveWith(
  result: unknown,
): (args: readonly string[], _cliError: CliErrorCtor) => Promise<unknown> {
  return () => Promise.resolve(result);
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
      readonly identityEnrollmentFile: string;
      readonly pidMetadataFile: string;
    };
    readonly hostController: {
      lifecycleAdmissionBlock: LifecycleAdmissionBlock | null;
      readonly getStatus: () => Promise<{ readonly updateReady: boolean }>;
      installVersion: (
        version: string,
        force: boolean,
      ) => Promise<MutationOutcome<InstallVersionOk>>;
      respawn: () => Promise<MutationOutcome<{ readonly activated: boolean }>>;
      convergeReady: (force: boolean) => Promise<MutationOutcome<null>>;
      registerService: () => Promise<MutationOutcome<null>>;
      freePortAndRestart: (
        pid: number | undefined,
        port: number | undefined,
      ) => Promise<MutationOutcome<{ readonly activated: boolean }>>;
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
        identityEnrollmentFile: join(workHome, "identity", "enrollment.json"),
        pidMetadataFile: join(workHome, "pid.json"),
      },
      hostController: {
        lifecycleAdmissionBlock: null,
        getStatus: () => Promise.resolve({ updateReady: false }),
        installVersion: () =>
          Promise.resolve({
            kind: "ok" as const,
            value: { installedVersion: "1.2.0", runningActivated: true },
          }),
        respawn: () =>
          Promise.resolve({
            kind: "ok" as const,
            value: { activated: true },
          }),
        convergeReady: () =>
          Promise.resolve({ kind: "ok" as const, value: null }),
        registerService: () =>
          Promise.resolve({ kind: "ok" as const, value: null }),
        freePortAndRestart: () =>
          Promise.resolve({
            kind: "ok" as const,
            value: { activated: true },
          }),
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
    installFakeCli(resolveWith(realShapedAvailablePayload()));
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
    installFakeCli(resolveWith({ manifest: { schemaVersion: 1 } }));
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

  it("shells host available --json without --include-pre-releases when the flag is false", async () => {
    installFakeCli(resolveWith(realShapedAvailablePayload()));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const handler = bridge.handlers.get(
      RunnerHostInvoke.traycerMaintenanceUpdateCheck,
    );
    if (handler === undefined) {
      throw new Error("expected maintenanceUpdateCheck handler");
    }
    await handler(null, { includePreReleases: false });
    expect(bundledCliCalls).toEqual([["host", "available", "--json"]]);
  });

  it("passes --include-pre-releases when the flag is true", async () => {
    installFakeCli(resolveWith(realShapedAvailablePayload()));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const handler = bridge.handlers.get(
      RunnerHostInvoke.traycerMaintenanceUpdateCheck,
    );
    if (handler === undefined) {
      throw new Error("expected maintenanceUpdateCheck handler");
    }
    await handler(null, { includePreReleases: true });
    expect(bundledCliCalls).toEqual([
      ["host", "available", "--json", "--include-pre-releases"],
    ]);
  });

  it("maps a bundled-resolver plain Error to cli-unavailable", async () => {
    installFakeCli(() => Promise.reject(new Error("no bundled CLI")));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const handler = bridge.handlers.get(
      RunnerHostInvoke.traycerMaintenanceUpdateCheck,
    );
    if (handler === undefined) {
      throw new Error("expected maintenanceUpdateCheck handler");
    }
    await expect(handler(null, { includePreReleases: false })).resolves.toEqual(
      {
        outcome: "cli-unavailable",
      },
    );
  });

  it("classifies E_HOST_VERIFY_FAILED as cli-failed — the host never synthesises a manifest", async () => {
    // The host's own `host.update.check` resolver returns
    // `{outcome: result.kind}` for any non-ok CLI result and never
    // synthesises a manifest. A protocol manifest with `latest: ""`
    // renders "v is available, but <host> can't install it." whenever the
    // installed version is unknown. This lane answers that same wire
    // contract, so every failure — including a build without trusted
    // registry keys — classifies through `classifyCliShellError`.
    installFakeCli((_args, CliError) =>
      Promise.reject(
        new CliError(
          {
            message: "no trusted registry keys",
            code: "E_HOST_VERIFY_FAILED",
            details: null,
            exitCode: 1,
            stderrTail: "E_HOST_VERIFY_FAILED",
          },
          null,
        ),
      ),
    );
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const handler = bridge.handlers.get(
      RunnerHostInvoke.traycerMaintenanceUpdateCheck,
    );
    if (handler === undefined) {
      throw new Error("expected maintenanceUpdateCheck handler");
    }
    await expect(handler(null, { includePreReleases: false })).resolves.toEqual(
      {
        outcome: "cli-failed",
      },
    );
  });

  it("E_HOST_VERIFY_FAILED classifies on the maintenance lane while traycerHostAvailable still returns an empty snapshot", async () => {
    // Deliberate divergence: `traycerHostAvailable`'s consumer reads an
    // empty snapshot as "nothing to install". The maintenance wire
    // contract must not synthesise that same empty `latest`. This test
    // is red if the maintenance handler starts normalising again.
    installFakeCli((_args, CliError) =>
      Promise.reject(
        new CliError(
          {
            message: "no trusted registry keys",
            code: "E_HOST_VERIFY_FAILED",
            details: null,
            exitCode: 1,
            stderrTail: "E_HOST_VERIFY_FAILED",
          },
          null,
        ),
      ),
    );
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const maintenance = bridge.handlers.get(
      RunnerHostInvoke.traycerMaintenanceUpdateCheck,
    );
    const available = bridge.handlers.get(
      RunnerHostInvoke.traycerHostAvailable,
    );
    if (maintenance === undefined || available === undefined) {
      throw new Error("expected both update-check handlers");
    }
    const maintenanceResult = await maintenance(null, {
      includePreReleases: false,
    });
    const availableResult = await available(null, null);
    expect(maintenanceResult).toEqual({ outcome: "cli-failed" });
    expect(availableResult).toEqual({
      generatedAt: "",
      latest: "",
      platformKey: "",
      manifestUrl: "",
      versions: [],
    });
  });
});

function realShapedDoctorPayload(): unknown {
  return {
    issues: [
      {
        code: "SERVICE_STOPPED",
        severity: "warning",
        title: "Host service is stopped",
        message: "The launch agent is not loaded.",
        fixAction: "host-service-register",
        terminalCommand: "traycer host service install",
        details: null,
      },
    ],
  };
}

describe("maintenanceDoctor IPC", () => {
  beforeEach(beginSandbox);
  afterEach(endSandbox);

  it("parses a real-shaped doctor report on the ok arm", async () => {
    installFakeCli(resolveWith(realShapedDoctorPayload()));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const handler = bridge.handlers.get(
      RunnerHostInvoke.traycerMaintenanceDoctor,
    );
    if (handler === undefined) {
      throw new Error("expected maintenanceDoctor handler");
    }
    await expect(handler(null, null)).resolves.toEqual({
      status: "ok",
      issues: [
        {
          code: "SERVICE_STOPPED",
          severity: "warning",
          title: "Host service is stopped",
          message: "The launch agent is not loaded.",
          fixAction: "host-service-register",
          terminalCommand: "traycer host service install",
          details: null,
        },
      ],
    });
    expect(bundledCliCalls).toEqual([["host", "doctor", "--json"]]);
  });

  it("returns invalid-output for a malformed doctor payload", async () => {
    installFakeCli(resolveWith({ issues: "not-an-array" }));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const handler = bridge.handlers.get(
      RunnerHostInvoke.traycerMaintenanceDoctor,
    );
    if (handler === undefined) {
      throw new Error("expected maintenanceDoctor handler");
    }
    await expect(handler(null, null)).resolves.toEqual({
      status: "invalid-output",
    });
  });
});

describe("maintenanceInstallationInfo IPC", () => {
  beforeEach(beginSandbox);
  afterEach(endSandbox);

  it("answers unmanaged when install.json is missing", async () => {
    installFakeCli(resolveWith({}));
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
    installFakeCli(resolveWith({}));
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

describe("maintenanceInstallVersion IPC", () => {
  beforeEach(beginSandbox);
  afterEach(endSandbox);

  async function registerInstallHandler(
    bridge: HandlerBridge,
  ): Promise<(event: unknown, raw: unknown) => Promise<unknown>> {
    installFakeCli(resolveWith({}));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    mgmt.registerHostManagementIpc(bridge as never);
    const handler = bridge.handlers.get(
      RunnerHostInvoke.traycerMaintenanceInstallVersion,
    );
    if (handler === undefined) {
      throw new Error("expected maintenanceInstallVersion handler");
    }
    return handler;
  }

  it("returns lane-busy when the mutation lane is occupied, without calling installVersion", async () => {
    const installVersion = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { installedVersion: "1.2.0", runningActivated: true },
      }),
    );
    const bridge = makeBridge();
    bridge.options.hostController.lifecycleAdmissionBlock = {
      kind: "mutation",
      lane: {
        kind: "apply",
        progress: null,
        startedAt: "2026-08-12T00:00:00Z",
      },
    };
    bridge.options.hostController.installVersion = installVersion;
    const handler = await registerInstallHandler(bridge);

    await expect(
      handler(null, { version: "1.2.0", force: false }),
    ).resolves.toEqual({ kind: "lane-busy" });
    expect(installVersion).not.toHaveBeenCalled();
  });

  it("dispatches installVersion when nothing blocks admission", async () => {
    const installVersion = vi.fn((version: string, force: boolean) =>
      Promise.resolve({
        kind: "ok" as const,
        value: { installedVersion: version, runningActivated: true },
      }),
    );
    const bridge = makeBridge();
    bridge.options.hostController.lifecycleAdmissionBlock = null;
    bridge.options.hostController.installVersion = installVersion;
    const handler = await registerInstallHandler(bridge);

    await expect(
      handler(null, { version: "1.3.0", force: true }),
    ).resolves.toEqual({
      kind: "dispatched",
      outcome: {
        kind: "ok",
        value: { installedVersion: "1.3.0", runningActivated: true },
      },
    });
    expect(installVersion).toHaveBeenCalledWith("1.3.0", true);
  });

  it("reads admission before submitting — occupying the lane inside installVersion still dispatches", async () => {
    // Discriminator: if the handler checked the lane AFTER awaiting
    // installVersion, occupying it inside the submit would flip the
    // answer to lane-busy. Reading first, with no await in between,
    // still dispatches.
    const bridge = makeBridge();
    const occupied: { current: MutationLaneStatus | null } = {
      current: null,
    };
    const installVersion = vi.fn((version: string, _force: boolean) => {
      occupied.current = {
        kind: "install",
        progress: null,
        startedAt: "2026-08-12T00:00:00Z",
      };
      bridge.options.hostController.lifecycleAdmissionBlock =
        occupied.current === null
          ? null
          : { kind: "mutation", lane: occupied.current };
      return Promise.resolve({
        kind: "ok" as const,
        value: { installedVersion: version, runningActivated: true },
      });
    });
    bridge.options.hostController.installVersion = installVersion;
    const handler = await registerInstallHandler(bridge);

    await expect(
      handler(null, { version: "1.2.0", force: false }),
    ).resolves.toEqual({
      kind: "dispatched",
      outcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
    });
    expect(installVersion).toHaveBeenCalledTimes(1);
    if (occupied.current === null) {
      throw new Error("expected installVersion to occupy the mutation lane");
    }
    expect(occupied.current.kind).toBe("install");
  });
});

describe("restartHostIfIdle IPC", () => {
  beforeEach(beginSandbox);
  afterEach(endSandbox);

  async function registerRestartIfIdleHandler(
    bridge: HandlerBridge,
  ): Promise<(event: unknown, raw: unknown) => Promise<unknown>> {
    installFakeCli(resolveWith({}));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    mgmt.registerHostManagementIpc(bridge as never);
    const handler = bridge.handlers.get(
      RunnerHostInvoke.traycerHostRestartIfIdle,
    );
    if (handler === undefined) {
      throw new Error("expected restartHostIfIdle handler");
    }
    return handler;
  }

  it("returns declined when the mutation lane is occupied, without calling respawn", async () => {
    const respawn = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { activated: true },
      }),
    );
    const bridge = makeBridge();
    bridge.options.hostController.lifecycleAdmissionBlock = {
      kind: "mutation",
      lane: {
        kind: "install",
        progress: null,
        startedAt: "2026-08-12T00:00:00Z",
      },
    };
    bridge.options.hostController.respawn = respawn;
    const handler = await registerRestartIfIdleHandler(bridge);

    await expect(handler(null, null)).resolves.toEqual({
      kind: "declined",
      message: laneBusyRestartMessage("install"),
    });
    expect(respawn).not.toHaveBeenCalled();
  });

  it("calls respawn when nothing blocks admission and maps an ok outcome to restarted", async () => {
    const respawn = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { activated: true },
      }),
    );
    const bridge = makeBridge();
    bridge.options.hostController.lifecycleAdmissionBlock = null;
    bridge.options.hostController.respawn = respawn;
    const handler = await registerRestartIfIdleHandler(bridge);

    await expect(handler(null, null)).resolves.toEqual({
      kind: "restarted",
    });
    expect(respawn).toHaveBeenCalledTimes(1);
  });

  it("reads admission before submitting — occupying the lane inside respawn still dispatches", async () => {
    const bridge = makeBridge();
    const occupied: { current: MutationLaneStatus | null } = {
      current: null,
    };
    const respawn = vi.fn(() => {
      occupied.current = {
        kind: "respawn",
        progress: null,
        startedAt: "2026-08-12T00:00:00Z",
      };
      bridge.options.hostController.lifecycleAdmissionBlock =
        occupied.current === null
          ? null
          : { kind: "mutation", lane: occupied.current };
      return Promise.resolve({
        kind: "ok" as const,
        value: { activated: true },
      });
    });
    bridge.options.hostController.respawn = respawn;
    const handler = await registerRestartIfIdleHandler(bridge);

    await expect(handler(null, null)).resolves.toEqual({
      kind: "restarted",
    });
    expect(respawn).toHaveBeenCalledTimes(1);
    if (occupied.current === null) {
      throw new Error("expected respawn to occupy the mutation lane");
    }
    expect(occupied.current.kind).toBe("respawn");
  });
});

const HOST_CHANGED_MESSAGE =
  "This computer's host changed while that was open. Reopen Settings and try again.";
const HOST_UNVERIFIED_MESSAGE =
  "This computer's host can't confirm its identity right now. Try again in a moment.";
const LOGIN_ITEM_REFRESH_MESSAGE =
  "Traycer is refreshing this host's background service registration. Try again once that finishes.";
const LIVE_HOST_ID = "host-local";
const OTHER_HOST_ID = "host-other";

function writeEnrollment(hostId: string): void {
  const dir = join(workHome, "identity");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "enrollment.json"), JSON.stringify({ hostId }));
}

function writeMalformedEnrollment(): void {
  const dir = join(workHome, "identity");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "enrollment.json"), "{not-json");
}

function writePid(hostId: string): void {
  writeFileSync(
    join(workHome, "pid.json"),
    JSON.stringify({
      hostId,
      websocketUrl: "ws://127.0.0.1:1/rpc",
      version: "1.1.11",
      pid: 42,
    }),
  );
}

function occupyLaneOnIdentityFileAccess(bridge: HandlerBridge): void {
  const path = bridge.options.host.identityEnrollmentFile;
  Object.defineProperty(bridge.options.host, "identityEnrollmentFile", {
    configurable: true,
    enumerable: true,
    get() {
      bridge.options.hostController.lifecycleAdmissionBlock = {
        kind: "mutation",
        lane: {
          kind: "install",
          progress: null,
          startedAt: "2026-08-12T00:00:00Z",
        },
      };
      return path;
    },
  });
}

describe("maintenance identity + doctorRepairIfIdle IPC", () => {
  beforeEach(beginSandbox);
  afterEach(endSandbox);

  async function registerHandler(
    bridge: HandlerBridge,
    channel: string,
  ): Promise<(event: unknown, raw: unknown) => Promise<unknown>> {
    installFakeCli(resolveWith({}));
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    mgmt.registerHostManagementIpc(bridge as never);
    const handler = bridge.handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`expected handler for ${channel}`);
    }
    return handler;
  }

  it("refuses a mismatched host on every maintenance write/read, without doing the work", async () => {
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const installVersion = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { installedVersion: "1.2.0", runningActivated: true },
      }),
    );
    const respawn = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { activated: true },
      }),
    );
    const convergeReady = vi.fn(() =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const registerService = vi.fn(() =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const bridge = makeBridge();
    bridge.options.hostController.installVersion = installVersion;
    bridge.options.hostController.respawn = respawn;
    bridge.options.hostController.convergeReady = convergeReady;
    bridge.options.hostController.registerService = registerService;

    const updateCheck = await registerHandler(
      bridge,
      invoke.traycerMaintenanceUpdateCheck,
    );
    const doctor = bridge.handlers.get(invoke.traycerMaintenanceDoctor);
    const installInfo = bridge.handlers.get(
      invoke.traycerMaintenanceInstallationInfo,
    );
    const install = bridge.handlers.get(
      invoke.traycerMaintenanceInstallVersion,
    );
    const restart = bridge.handlers.get(invoke.traycerHostRestartIfIdle);
    const repair = bridge.handlers.get(invoke.traycerDoctorRepairIfIdle);
    if (
      doctor === undefined ||
      installInfo === undefined ||
      install === undefined ||
      restart === undefined ||
      repair === undefined
    ) {
      throw new Error("expected every maintenance handler");
    }

    const mismatched = { expectedHostId: OTHER_HOST_ID };
    await expect(updateCheck(null, mismatched)).rejects.toThrow(
      HOST_CHANGED_MESSAGE,
    );
    await expect(doctor(null, mismatched)).rejects.toThrow(
      HOST_CHANGED_MESSAGE,
    );
    await expect(installInfo(null, mismatched)).rejects.toThrow(
      HOST_CHANGED_MESSAGE,
    );
    await expect(
      install(null, { version: "1.2.0", force: false, ...mismatched }),
    ).rejects.toThrow(HOST_CHANGED_MESSAGE);
    await expect(restart(null, mismatched)).resolves.toEqual({
      kind: "declined",
      message: HOST_CHANGED_MESSAGE,
    });
    await expect(
      repair(null, { repair: "converge-ready", ...mismatched }),
    ).resolves.toEqual({
      kind: "host-changed",
      message: HOST_CHANGED_MESSAGE,
    });

    expect(bundledCliCalls).toEqual([]);
    expect(installVersion).not.toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
    expect(convergeReady).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalled();
  });

  it("treats a null live id as not a change, so a repair still runs", async () => {
    const invoke = RunnerHostInvoke;
    const respawn = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { activated: true },
      }),
    );
    const installVersion = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { installedVersion: "1.2.0", runningActivated: true },
      }),
    );
    const bridge = makeBridge();
    bridge.options.hostController.respawn = respawn;
    bridge.options.hostController.installVersion = installVersion;
    const restart = await registerHandler(
      bridge,
      invoke.traycerHostRestartIfIdle,
    );
    const install = bridge.handlers.get(
      invoke.traycerMaintenanceInstallVersion,
    );
    if (install === undefined) {
      throw new Error("expected install handler");
    }

    await expect(
      restart(null, { expectedHostId: OTHER_HOST_ID }),
    ).resolves.toEqual({ kind: "restarted" });
    await expect(
      install(null, {
        version: "1.2.0",
        force: false,
        expectedHostId: OTHER_HOST_ID,
      }),
    ).resolves.toEqual({
      kind: "dispatched",
      outcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
    });
    expect(respawn).toHaveBeenCalledTimes(1);
    expect(installVersion).toHaveBeenCalledTimes(1);
  });

  it("refuses when the enrollment record exists but is unreadable, without calling installVersion", async () => {
    // Discriminator: the old fence treated unusable enrollment as "no
    // change" and submitted. A pid file naming another host must not leak
    // through either — that would refuse with the *changed* message.
    writeMalformedEnrollment();
    writePid(OTHER_HOST_ID);
    const invoke = RunnerHostInvoke;
    const installVersion = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { installedVersion: "1.2.0", runningActivated: true },
      }),
    );
    const respawn = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { activated: true },
      }),
    );
    const convergeReady = vi.fn(() =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const bridge = makeBridge();
    bridge.options.hostController.installVersion = installVersion;
    bridge.options.hostController.respawn = respawn;
    bridge.options.hostController.convergeReady = convergeReady;
    const install = await registerHandler(
      bridge,
      invoke.traycerMaintenanceInstallVersion,
    );
    const restart = bridge.handlers.get(invoke.traycerHostRestartIfIdle);
    const repair = bridge.handlers.get(invoke.traycerDoctorRepairIfIdle);
    const updateCheck = bridge.handlers.get(
      invoke.traycerMaintenanceUpdateCheck,
    );
    const doctor = bridge.handlers.get(invoke.traycerMaintenanceDoctor);
    const installInfo = bridge.handlers.get(
      invoke.traycerMaintenanceInstallationInfo,
    );
    if (
      restart === undefined ||
      repair === undefined ||
      updateCheck === undefined ||
      doctor === undefined ||
      installInfo === undefined
    ) {
      throw new Error("expected every maintenance handler");
    }

    const payload = { expectedHostId: LIVE_HOST_ID };
    await expect(
      install(null, { version: "1.2.0", force: false, ...payload }),
    ).rejects.toThrow(HOST_UNVERIFIED_MESSAGE);
    await expect(restart(null, payload)).resolves.toEqual({
      kind: "declined",
      message: HOST_UNVERIFIED_MESSAGE,
    });
    await expect(
      repair(null, { repair: "converge-ready", ...payload }),
    ).resolves.toEqual({
      kind: "host-changed",
      message: HOST_UNVERIFIED_MESSAGE,
    });
    await expect(updateCheck(null, payload)).rejects.toThrow(
      HOST_UNVERIFIED_MESSAGE,
    );
    await expect(doctor(null, payload)).rejects.toThrow(
      HOST_UNVERIFIED_MESSAGE,
    );
    await expect(installInfo(null, payload)).rejects.toThrow(
      HOST_UNVERIFIED_MESSAGE,
    );
    expect(installVersion).not.toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
    expect(convergeReady).not.toHaveBeenCalled();
    expect(bundledCliCalls).toEqual([]);
  });

  it("refuses when enrollment is absent and pid.json names a different host", async () => {
    writePid(OTHER_HOST_ID);
    const invoke = RunnerHostInvoke;
    const installVersion = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { installedVersion: "1.2.0", runningActivated: true },
      }),
    );
    const respawn = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { activated: true },
      }),
    );
    const bridge = makeBridge();
    bridge.options.hostController.installVersion = installVersion;
    bridge.options.hostController.respawn = respawn;
    const install = await registerHandler(
      bridge,
      invoke.traycerMaintenanceInstallVersion,
    );
    const restart = bridge.handlers.get(invoke.traycerHostRestartIfIdle);
    if (restart === undefined) {
      throw new Error("expected restart handler");
    }

    await expect(
      install(null, {
        version: "1.2.0",
        force: false,
        expectedHostId: LIVE_HOST_ID,
      }),
    ).rejects.toThrow(HOST_CHANGED_MESSAGE);
    await expect(
      restart(null, { expectedHostId: LIVE_HOST_ID }),
    ).resolves.toEqual({
      kind: "declined",
      message: HOST_CHANGED_MESSAGE,
    });
    expect(installVersion).not.toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
  });

  it("refuses watched writes during a login-item-refresh admission block", async () => {
    expect(admissionBlockRestartMessage({ kind: "login-item-refresh" })).toBe(
      LOGIN_ITEM_REFRESH_MESSAGE,
    );
    const invoke = RunnerHostInvoke;
    const installVersion = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { installedVersion: "1.2.0", runningActivated: true },
      }),
    );
    const respawn = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { activated: true },
      }),
    );
    const convergeReady = vi.fn(() =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const bridge = makeBridge();
    bridge.options.hostController.lifecycleAdmissionBlock = {
      kind: "login-item-refresh",
    };
    bridge.options.hostController.installVersion = installVersion;
    bridge.options.hostController.respawn = respawn;
    bridge.options.hostController.convergeReady = convergeReady;
    const install = await registerHandler(
      bridge,
      invoke.traycerMaintenanceInstallVersion,
    );
    const restart = bridge.handlers.get(invoke.traycerHostRestartIfIdle);
    const repair = bridge.handlers.get(invoke.traycerDoctorRepairIfIdle);
    if (restart === undefined || repair === undefined) {
      throw new Error("expected restart and repair handlers");
    }

    await expect(
      install(null, {
        version: "1.2.0",
        force: false,
        expectedHostId: LIVE_HOST_ID,
      }),
    ).resolves.toEqual({ kind: "lane-busy" });
    await expect(
      restart(null, { expectedHostId: LIVE_HOST_ID }),
    ).resolves.toEqual({
      kind: "declined",
      message: LOGIN_ITEM_REFRESH_MESSAGE,
    });
    await expect(
      repair(null, {
        repair: "converge-ready",
        expectedHostId: LIVE_HOST_ID,
      }),
    ).resolves.toEqual({
      kind: "lane-busy",
      message: LOGIN_ITEM_REFRESH_MESSAGE,
    });
    expect(installVersion).not.toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
    expect(convergeReady).not.toHaveBeenCalled();
  });

  it("checks identity before the lane — a mismatch on an occupied lane is host-changed, not lane-busy", async () => {
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const installVersion = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { installedVersion: "1.2.0", runningActivated: true },
      }),
    );
    const convergeReady = vi.fn(() =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const bridge = makeBridge();
    bridge.options.hostController.lifecycleAdmissionBlock = {
      kind: "mutation",
      lane: {
        kind: "apply",
        progress: null,
        startedAt: "2026-08-12T00:00:00Z",
      },
    };
    bridge.options.hostController.installVersion = installVersion;
    bridge.options.hostController.convergeReady = convergeReady;
    const install = await registerHandler(
      bridge,
      invoke.traycerMaintenanceInstallVersion,
    );
    const repair = bridge.handlers.get(invoke.traycerDoctorRepairIfIdle);
    const restart = bridge.handlers.get(invoke.traycerHostRestartIfIdle);
    if (repair === undefined || restart === undefined) {
      throw new Error("expected repair and restart handlers");
    }

    await expect(
      install(null, {
        version: "1.2.0",
        force: false,
        expectedHostId: OTHER_HOST_ID,
      }),
    ).rejects.toThrow(HOST_CHANGED_MESSAGE);
    await expect(
      repair(null, {
        repair: "converge-ready",
        expectedHostId: OTHER_HOST_ID,
      }),
    ).resolves.toEqual({
      kind: "host-changed",
      message: HOST_CHANGED_MESSAGE,
    });
    await expect(
      restart(null, { expectedHostId: OTHER_HOST_ID }),
    ).resolves.toEqual({
      kind: "declined",
      message: HOST_CHANGED_MESSAGE,
    });
    expect(installVersion).not.toHaveBeenCalled();
    expect(convergeReady).not.toHaveBeenCalled();
  });

  it("reads identity before the lane test — occupying the lane during the identity read still refuses", async () => {
    // Discriminator: if identity ran AFTER the lane test, the lane would be
    // idle at the check, then this getter would occupy it, then the submit
    // would still fire. Identity first sees the occupied lane and refuses.
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const installVersion = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { installedVersion: "1.2.0", runningActivated: true },
      }),
    );
    const respawn = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { activated: true },
      }),
    );
    const convergeReady = vi.fn(() =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const bridge = makeBridge();
    occupyLaneOnIdentityFileAccess(bridge);
    bridge.options.hostController.installVersion = installVersion;
    bridge.options.hostController.respawn = respawn;
    bridge.options.hostController.convergeReady = convergeReady;
    const install = await registerHandler(
      bridge,
      invoke.traycerMaintenanceInstallVersion,
    );
    const restart = bridge.handlers.get(invoke.traycerHostRestartIfIdle);
    const repair = bridge.handlers.get(invoke.traycerDoctorRepairIfIdle);
    if (restart === undefined || repair === undefined) {
      throw new Error("expected restart and repair handlers");
    }

    await expect(
      install(null, {
        version: "1.2.0",
        force: false,
        expectedHostId: LIVE_HOST_ID,
      }),
    ).resolves.toEqual({ kind: "lane-busy" });
    await expect(
      restart(null, { expectedHostId: LIVE_HOST_ID }),
    ).resolves.toEqual({
      kind: "declined",
      message: laneBusyRestartMessage("install"),
    });
    await expect(
      repair(null, {
        repair: "converge-ready",
        expectedHostId: LIVE_HOST_ID,
      }),
    ).resolves.toEqual({
      kind: "lane-busy",
      message: laneBusyRestartMessage("install"),
    });
    expect(installVersion).not.toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
    expect(convergeReady).not.toHaveBeenCalled();
  });

  it("runDoctorRepairIfIdle returns lane-busy when occupied, without calling either controller", async () => {
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const convergeReady = vi.fn(() =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const registerService = vi.fn(() =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const bridge = makeBridge();
    bridge.options.hostController.lifecycleAdmissionBlock = {
      kind: "mutation",
      lane: {
        kind: "install",
        progress: null,
        startedAt: "2026-08-12T00:00:00Z",
      },
    };
    bridge.options.hostController.convergeReady = convergeReady;
    bridge.options.hostController.registerService = registerService;
    const handler = await registerHandler(
      bridge,
      invoke.traycerDoctorRepairIfIdle,
    );

    await expect(
      handler(null, {
        repair: "converge-ready",
        expectedHostId: LIVE_HOST_ID,
      }),
    ).resolves.toEqual({
      kind: "lane-busy",
      message: laneBusyRestartMessage("install"),
    });
    await expect(
      handler(null, {
        repair: "register-service",
        expectedHostId: LIVE_HOST_ID,
      }),
    ).resolves.toEqual({
      kind: "lane-busy",
      message: laneBusyRestartMessage("install"),
    });
    expect(convergeReady).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalled();
  });

  it("runDoctorRepairIfIdle dispatches convergeReady for converge-ready and registerService for register-service", async () => {
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const convergeReady = vi.fn((force: boolean) => {
      expect(force).toBe(false);
      return Promise.resolve({ kind: "ok" as const, value: null });
    });
    const registerService = vi.fn(() =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const bridge = makeBridge();
    bridge.options.hostController.convergeReady = convergeReady;
    bridge.options.hostController.registerService = registerService;
    const handler = await registerHandler(
      bridge,
      invoke.traycerDoctorRepairIfIdle,
    );

    await expect(
      handler(null, {
        repair: "converge-ready",
        expectedHostId: LIVE_HOST_ID,
      }),
    ).resolves.toEqual({
      kind: "dispatched",
      outcome: { kind: "ok", value: null },
    });
    expect(convergeReady).toHaveBeenCalledTimes(1);
    expect(registerService).not.toHaveBeenCalled();

    await expect(
      handler(null, {
        repair: "register-service",
        expectedHostId: LIVE_HOST_ID,
      }),
    ).resolves.toEqual({
      kind: "dispatched",
      outcome: { kind: "ok", value: null },
    });
    expect(registerService).toHaveBeenCalledTimes(1);
  });

  it("runDoctorRepairIfIdle surfaces a non-ok controller outcome as dispatched, not thrown", async () => {
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const bridge = makeBridge();
    bridge.options.hostController.convergeReady = () =>
      Promise.resolve({
        kind: "failed" as const,
        message: "converge failed",
      });
    const handler = await registerHandler(
      bridge,
      invoke.traycerDoctorRepairIfIdle,
    );

    await expect(
      handler(null, {
        repair: "converge-ready",
        expectedHostId: LIVE_HOST_ID,
      }),
    ).resolves.toEqual({
      kind: "dispatched",
      outcome: { kind: "failed", message: "converge failed" },
    });
  });

  it("runDoctorRepairIfIdle rejects an unknown repair without touching the lane", async () => {
    const invoke = RunnerHostInvoke;
    const convergeReady = vi.fn(() =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const bridge = makeBridge();
    bridge.options.hostController.convergeReady = convergeReady;
    const handler = await registerHandler(
      bridge,
      invoke.traycerDoctorRepairIfIdle,
    );

    await expect(
      handler(null, { repair: "free-port", expectedHostId: LIVE_HOST_ID }),
    ).rejects.toThrow("Unknown doctor repair: free-port");
    expect(convergeReady).not.toHaveBeenCalled();
  });

  it("runDoctorRepairIfIdle reads the lane before submitting — occupying inside convergeReady still dispatches", async () => {
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const bridge = makeBridge();
    const occupied: { current: MutationLaneStatus | null } = {
      current: null,
    };
    const convergeReady = vi.fn((_force: boolean) => {
      occupied.current = {
        kind: "ensure",
        progress: null,
        startedAt: "2026-08-12T00:00:00Z",
      };
      bridge.options.hostController.lifecycleAdmissionBlock =
        occupied.current === null
          ? null
          : { kind: "mutation", lane: occupied.current };
      return Promise.resolve({ kind: "ok" as const, value: null });
    });
    bridge.options.hostController.convergeReady = convergeReady;
    const handler = await registerHandler(
      bridge,
      invoke.traycerDoctorRepairIfIdle,
    );

    await expect(
      handler(null, {
        repair: "converge-ready",
        expectedHostId: LIVE_HOST_ID,
      }),
    ).resolves.toEqual({
      kind: "dispatched",
      outcome: { kind: "ok", value: null },
    });
    expect(convergeReady).toHaveBeenCalledTimes(1);
    if (occupied.current === null) {
      throw new Error("expected convergeReady to occupy the mutation lane");
    }
    expect(occupied.current.kind).toBe("ensure");
  });

  it("traycerHostLogs throws on a mismatched expectedHostId and never shells the CLI", async () => {
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const bridge = makeBridge();
    const logs = await registerHandler(bridge, invoke.traycerHostLogs);

    await expect(
      logs(null, { tailLines: 50, expectedHostId: OTHER_HOST_ID }),
    ).rejects.toThrow(HOST_CHANGED_MESSAGE);
    expect(bundledCliCalls).toEqual([]);
  });

  it("traycerHostLogs returns the tail when expectedHostId matches the enrolled host", async () => {
    writeEnrollment(LIVE_HOST_ID);
    installFakeCli(
      resolveWith({ path: "/tmp/host.log", tail: "matching-host-line" }),
    );
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const invoke = RunnerHostInvoke;
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const logs = bridge.handlers.get(invoke.traycerHostLogs);
    if (logs === undefined) {
      throw new Error("expected traycerHostLogs handler");
    }

    await expect(
      logs(null, { tailLines: 50, expectedHostId: LIVE_HOST_ID }),
    ).resolves.toEqual({
      path: "/tmp/host.log",
      tail: "matching-host-line",
    });
    expect(bundledCliCalls).toEqual([
      ["host", "logs", "--tail", "50", "--json"],
    ]);
  });

  it("traycerHostLogs refuses when the enrollment record exists but is unreadable, without shelling the CLI", async () => {
    // Discriminator: round 7 treated unusable enrollment as "no change".
    writeMalformedEnrollment();
    const invoke = RunnerHostInvoke;
    const bridge = makeBridge();
    const logs = await registerHandler(bridge, invoke.traycerHostLogs);

    await expect(
      logs(null, { tailLines: 50, expectedHostId: LIVE_HOST_ID }),
    ).rejects.toThrow(HOST_UNVERIFIED_MESSAGE);
    expect(bundledCliCalls).toEqual([]);
  });

  it("traycerHostDoctor throws on a mismatched expectedHostId and never shells the CLI", async () => {
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const bridge = makeBridge();
    const doctor = await registerHandler(bridge, invoke.traycerHostDoctor);

    await expect(
      doctor(null, { expectedHostId: OTHER_HOST_ID }),
    ).rejects.toThrow(HOST_CHANGED_MESSAGE);
    expect(bundledCliCalls).toEqual([]);
  });

  it("freePortAndRestartIfIdle returns lane-busy when occupied and never calls the controller", async () => {
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const freePortAndRestart = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { activated: true },
      }),
    );
    const bridge = makeBridge();
    const occupied: LifecycleAdmissionBlock = {
      kind: "mutation",
      lane: {
        kind: "install",
        progress: null,
        startedAt: "2026-08-12T00:00:00Z",
      },
    };
    bridge.options.hostController.lifecycleAdmissionBlock = occupied;
    bridge.options.hostController.freePortAndRestart = freePortAndRestart;
    const handler = await registerHandler(
      bridge,
      invoke.traycerFreePortAndRestartIfIdle,
    );

    await expect(
      handler(null, {
        port: 8765,
        pid: 4242,
        processName: "node",
        expectedHostId: LIVE_HOST_ID,
      }),
    ).resolves.toEqual({
      kind: "lane-busy",
      message: admissionBlockRestartMessage(occupied),
    });
    expect(freePortAndRestart).not.toHaveBeenCalled();
  });

  it("freePortAndRestartIfIdle returns host-changed on a mismatched id and never calls the controller", async () => {
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const freePortAndRestart = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { activated: true },
      }),
    );
    const bridge = makeBridge();
    bridge.options.hostController.freePortAndRestart = freePortAndRestart;
    const handler = await registerHandler(
      bridge,
      invoke.traycerFreePortAndRestartIfIdle,
    );

    await expect(
      handler(null, {
        port: 8765,
        pid: 4242,
        processName: "node",
        expectedHostId: OTHER_HOST_ID,
      }),
    ).resolves.toEqual({
      kind: "host-changed",
      message: HOST_CHANGED_MESSAGE,
    });
    expect(freePortAndRestart).not.toHaveBeenCalled();
  });

  it("freePortAndRestartIfIdle dispatches when idle and the expected host still matches", async () => {
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const freePortAndRestart = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { activated: true },
      }),
    );
    const bridge = makeBridge();
    bridge.options.hostController.freePortAndRestart = freePortAndRestart;
    const handler = await registerHandler(
      bridge,
      invoke.traycerFreePortAndRestartIfIdle,
    );

    await expect(
      handler(null, {
        port: 8765,
        pid: 4242,
        processName: "node",
        expectedHostId: LIVE_HOST_ID,
      }),
    ).resolves.toEqual({
      kind: "dispatched",
      outcome: { kind: "ok", value: null },
    });
    expect(freePortAndRestart).toHaveBeenCalledTimes(1);
  });

  it("freePortAndRestartIfIdle reads identity before the lane — occupying during the identity read still refuses", async () => {
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const freePortAndRestart = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { activated: true },
      }),
    );
    const bridge = makeBridge();
    occupyLaneOnIdentityFileAccess(bridge);
    bridge.options.hostController.freePortAndRestart = freePortAndRestart;
    const handler = await registerHandler(
      bridge,
      invoke.traycerFreePortAndRestartIfIdle,
    );

    await expect(
      handler(null, {
        port: 8765,
        pid: 4242,
        processName: "node",
        expectedHostId: LIVE_HOST_ID,
      }),
    ).resolves.toEqual({
      kind: "lane-busy",
      message: admissionBlockRestartMessage({
        kind: "mutation",
        lane: {
          kind: "install",
          progress: null,
          startedAt: "2026-08-12T00:00:00Z",
        },
      }),
    });
    expect(freePortAndRestart).not.toHaveBeenCalled();
  });
});

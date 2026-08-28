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
import type {
  GuardedMutationOutcome,
  LifecycleAdmissionBlock,
  LocalHostMutationIntent,
} from "../../host/host-controller-types";
import { sandboxHome } from "../../__tests__/sandbox-home";
import { TraycerCliError } from "../../cli/traycer-cli";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import {
  admissionBlockRestartMessage,
  classifyCliShellError,
  laneBusyRestartMessage,
} from "../host-management-ipc";

const testUserData = vi.hoisted(() => ({ current: "/tmp" }));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => testUserData.current),
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
  testUserData.current = join(workHome, "userData");
  mkdirSync(testUserData.current, { recursive: true });
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
      getStatus: () => Promise<{ readonly updateReady: boolean }>;
      installVersion: (
        version: string,
        force: boolean,
      ) => Promise<MutationOutcome<InstallVersionOk>>;
      respawn: (
        intent: LocalHostMutationIntent,
      ) => Promise<GuardedMutationOutcome<{ readonly activated: boolean }>>;
      convergeReady: (
        force: boolean,
        intent: LocalHostMutationIntent,
      ) => Promise<GuardedMutationOutcome<null>>;
      registerService: (
        intent: LocalHostMutationIntent,
      ) => Promise<GuardedMutationOutcome<null>>;
      freePortAndRestart: (
        pid: number | undefined,
        port: number | undefined,
        intent: LocalHostMutationIntent,
      ) => Promise<GuardedMutationOutcome<{ readonly activated: boolean }>>;
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
      // Reconstructed from the REQUEST, because this fixture's CLI envelope
      // carries no inclusion metadata — the fail-closed path for a CLI that
      // predates the fields. It never claims `installed-rc`, which asserts a
      // derivation only a reporting CLI can have performed.
      effectiveIncludePreReleases: false,
      includePreReleasesSource: "explicit-exclude",
    });
  });

  it("preserves the CLI envelope's own resolved inclusion and provenance", async () => {
    // The Settings explanation is keyed off `installed-rc`, and only the CLI
    // can know it: dropping the metadata here would make the same CLI output
    // explain itself on a remote host and stay silent on a local one.
    installFakeCli(
      resolveWith({
        ...(realShapedAvailablePayload() as Record<string, unknown>),
        includePreReleases: true,
        includePreReleasesSource: "installed-rc",
      }),
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

    const result = await handler(null, {});

    expect(result).toMatchObject({
      outcome: "ok",
      effectiveIncludePreReleases: true,
      includePreReleasesSource: "installed-rc",
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

  it("shells the NEGATIVE flag when the override is explicitly false", async () => {
    // Not omission. Omission now means "derive from the installed host", and
    // on a host running a release candidate that DERIVES inclusion — so an
    // unchecked filter that sent nothing would keep returning the RC rows it
    // was just asked to hide.
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
    expect(bundledCliCalls).toEqual([
      ["host", "available", "--json", "--no-include-pre-releases"],
    ]);
  });

  it("shells NO flag when the override is absent, leaving the default to the CLI", async () => {
    // The CLI is the catalog-default authority: it is the process that can
    // read this environment's install record. Picking a flag here would
    // override the derivation the absent state exists to request.
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
    await handler(null, {});
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
        // Ticket 03 added an executable digest to the shared installation
        // schema and normalises a MISSING one to `null` for legacy records.
        // The fixture above deliberately omits it - that is the legacy-read
        // path this case exercises - so the decoded record carries the
        // explicit `null` rather than dropping the key.
        executableSha256: null,
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
        executableSha256: null,
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
    ).resolves.toEqual({
      kind: "lane-busy",
      // An install holding the lane IS update work, so this arm may honestly
      // become the protocol's `already-updating`.
      updateInFlight: true,
      message: expect.stringContaining("installing an update"),
    });
    expect(installVersion).not.toHaveBeenCalled();
  });

  it("classifies every version-moving lane as update work, and only those", async () => {
    // This bit never admits anything - the install is already refused - it
    // only chooses between `already-updating` (which ARMS the caller's
    // accepted-update latch) and a retryable refusal. On a pre-1.2.0 host
    // nothing releases that latch before the full 60s timer (these hosts
    // never publish `host.status.updateProgress`), so `true` is reserved
    // for lanes whose work can OUTLAST the latch: the minutes-long
    // version movers. `activate` is deliberately `false` - the lane kind
    // cannot separate the genuine update tail from the legacy
    // `activationUnknown` stamp-repair, and both are seconds-long either
    // way.
    //
    // Compile-time exhaustive: `satisfies Record<MutationKind, boolean>`
    // makes a NEW MutationKind a type error here until it gets an explicit
    // decision, and the sorted-census equality below pins the runtime loop
    // to the same set - `readonly MutationKind[]` alone would permit a
    // subset, letting a new kind compile without ever entering the loop.
    const updateWorkByKind = {
      install: true,
      apply: true,
      activate: false,
      // At `progress: null`. The numeric-evidence gate that can flip an
      // ensure to `true` has its own tests below.
      ensure: false,
      register: false,
      deregister: false,
      respawn: false,
      recoverIfDown: false,
      freePortAndRestart: false,
      uninstallHost: false,
      removeTraycer: false,
    } satisfies Record<MutationKind, boolean>;
    expect([...ALL_MUTATION_KINDS].sort()).toEqual(
      Object.keys(updateWorkByKind).sort(),
    );
    const bridge = makeBridge();
    const handler = await registerInstallHandler(bridge);
    for (const kind of ALL_MUTATION_KINDS) {
      bridge.options.hostController.lifecycleAdmissionBlock = {
        kind: "mutation",
        lane: { kind, progress: null, startedAt: "2026-08-12T00:00:00Z" },
      };
      await expect(
        handler(null, { version: "1.2.0", force: false }),
      ).resolves.toEqual({
        kind: "lane-busy",
        updateInFlight: updateWorkByKind[kind],
        message: laneBusyRestartMessage(kind),
      });
    }
  });

  it("counts an ensure lane as update work only on numeric progress evidence", async () => {
    // The evidence must be a NUMBER, not mere progress presence: `host
    // ensure`'s service branches (register, start, the repair retry)
    // narrate through the same null-metric `host-provision` events without
    // touching the version, so presence alone would lock the caller's
    // update controls for a minute over a service repair. Only the
    // version-moving path reports numerics - the staging download's
    // `bytes`/`totalBytes`/`percent`, the extract's `workUnits`.
    const bridge = makeBridge();
    const handler = await registerInstallHandler(bridge);
    const cases = [
      {
        // The Codex round-3 case: a service-only ensure on an
        // already-current host - same stage string, no numerics.
        progress: {
          stage: "host-provision",
          percent: null,
          bytes: null,
          totalBytes: null,
          message: "registering OS service for installed host",
          workUnits: null,
        },
        updateInFlight: false,
      },
      {
        // Staging download: bytes are moving toward a version change.
        progress: {
          stage: "download",
          percent: 42,
          bytes: 42_000_000,
          totalBytes: 100_000_000,
          message: "downloading host 1.2.0",
          workUnits: null,
        },
        updateInFlight: true,
      },
      {
        // Extract: entry-driven work units, the other numeric producer.
        progress: {
          stage: "extract",
          percent: null,
          bytes: null,
          totalBytes: null,
          message: "extracting host 1.2.0",
          workUnits: 120,
        },
        updateInFlight: true,
      },
    ];
    for (const testCase of cases) {
      bridge.options.hostController.lifecycleAdmissionBlock = {
        kind: "mutation",
        lane: {
          kind: "ensure",
          progress: testCase.progress,
          startedAt: "2026-08-12T00:00:00Z",
        },
      };
      await expect(
        handler(null, { version: "1.2.0", force: false }),
      ).resolves.toEqual({
        kind: "lane-busy",
        updateInFlight: testCase.updateInFlight,
        message: laneBusyRestartMessage("ensure"),
      });
    }
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
    // Drain the post-install fire-and-forget registry re-probe before the
    // test ends - `bundledCliCalls` is shared across tests, so a probe left
    // in flight here would land in a later test's call log.
    await vi.waitFor(() => {
      expect(bundledCliCalls).toContainEqual(["host", "available", "--json"]);
    });
  });

  it("re-probes the registry after a successful dispatch even when the cache is fresh", async () => {
    // Discriminator: the pre-install cache is minutes old and reachable, so
    // an UNFORCED refresh (or none at all) would serve it and never shell
    // the probe - the tray and Updates row would keep advertising the
    // version this dispatch just installed for the rest of the 24h TTL.
    // Only the forced post-install re-probe fires `host available` here.
    const cacheDir = join(workHome, ".traycer", "desktop");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "registry-update-cache.json"),
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        latestVersion: "1.2.0",
        installedVersion: "1.1.11",
        reachable: true,
        errorMessage: null,
        environment: "production",
      }),
      "utf8",
    );
    const bridge = makeBridge();
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
    await vi.waitFor(() => {
      expect(bundledCliCalls).toContainEqual(["host", "available", "--json"]);
    });
  });

  it("returns the committed dispatch when the post-install registry projection rejects", async () => {
    // Mirror of the sibling `traycerHostInstallVersion` pin: the refresh is
    // fire-and-forget, so a rejecting status projection inside it must never
    // turn the already-committed dispatch into a rejected invoke.
    const bridge = makeBridge();
    bridge.options.hostController.getStatus = () =>
      Promise.reject(new Error("status projection failed"));
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
    // The refresh still ran - its probe is on record - and its rejection was
    // swallowed by the handler's own catch, not surfaced to the invoker.
    await vi.waitFor(() => {
      expect(bundledCliCalls).toContainEqual(["host", "available", "--json"]);
    });
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
    // Drain the post-install re-probe so it cannot land in a later test's
    // shared `bundledCliCalls` log.
    await vi.waitFor(() => {
      expect(bundledCliCalls).toContainEqual(["host", "available", "--json"]);
    });
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
    // Drain the post-install re-probe so it cannot land in a later test's
    // shared `bundledCliCalls` log.
    await vi.waitFor(() => {
      expect(bundledCliCalls).toContainEqual(["host", "available", "--json"]);
    });
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
    ).resolves.toEqual({
      kind: "lane-busy",
      // A login-item refresh is NOT update work. Reporting it as
      // `already-updating` would arm the caller's accepted-update latch to
      // wait on progress this operation never publishes.
      updateInFlight: false,
      message: expect.stringContaining("service registration"),
    });
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
    ).resolves.toEqual({
      kind: "lane-busy",
      // An `install` occupying the lane IS update work, so this arm may
      // honestly become the protocol's `already-updating`.
      updateInFlight: true,
      message: laneBusyRestartMessage("install"),
    });
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

  it("queued converge-ready hands the controller a user-repair intent", async () => {
    // The sentinel clear and the identity re-ask BOTH moved into the
    // controller (`admitReprovision`), because this route queues: doing
    // either one here would prove something about a moment minutes before
    // the mutation runs. What the HANDLER still owes is a correctly built
    // intent, so that is what this pins — and, below, that its guard really
    // answers the identity question rather than being a stub.
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const bridge = makeBridge();
    const handler = await registerHandler(
      bridge,
      invoke.traycerDoctorRepairQueued,
    );
    const convergeReady = vi.fn(
      (_force: boolean, _intent: LocalHostMutationIntent) =>
        Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const registerService = vi.fn((_intent: LocalHostMutationIntent) =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const respawn = vi.fn(() =>
      Promise.resolve({ kind: "ok" as const, value: { activated: true } }),
    );
    bridge.options.hostController.convergeReady = convergeReady;
    bridge.options.hostController.registerService = registerService;
    bridge.options.hostController.respawn = respawn;

    await expect(
      handler(null, {
        repair: "converge-ready",
        expectedHostId: LIVE_HOST_ID,
      }),
    ).resolves.toEqual({ kind: "applied" });
    expect(convergeReady).toHaveBeenCalledTimes(1);
    expect(registerService).not.toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();

    const [force, intent] = convergeReady.mock.calls[0] ?? [];
    expect(force).toBe(false);
    if (intent?.kind !== "user-repair") {
      throw new Error("expected a user-repair intent");
    }
    // The guard is the whole point of the intent, so exercise it rather than
    // trusting its shape: matching identity proceeds...
    await expect(intent.guard()).resolves.toEqual({ kind: "proceed" });
    // ...and a host swapped underneath it abandons, which is the case the
    // pre-enqueue check structurally cannot see.
    writeEnrollment("some-other-host");
    await expect(intent.guard()).resolves.toEqual({
      kind: "abandon",
      message: expect.stringContaining("host changed"),
    });
  });

  it("queued register-service hands the controller a user-repair intent", async () => {
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const bridge = makeBridge();
    const handler = await registerHandler(
      bridge,
      invoke.traycerDoctorRepairQueued,
    );
    const registerService = vi.fn((_intent: LocalHostMutationIntent) =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const convergeReady = vi.fn(
      (_force: boolean, _intent: LocalHostMutationIntent) =>
        Promise.resolve({ kind: "ok" as const, value: null }),
    );
    bridge.options.hostController.registerService = registerService;
    bridge.options.hostController.convergeReady = convergeReady;

    await expect(
      handler(null, {
        repair: "register-service",
        expectedHostId: LIVE_HOST_ID,
      }),
    ).resolves.toEqual({ kind: "applied" });
    expect(registerService).toHaveBeenCalledTimes(1);
    expect(convergeReady).not.toHaveBeenCalled();

    const [intent] = registerService.mock.calls[0] ?? [];
    if (intent?.kind !== "user-repair") {
      throw new Error("expected a user-repair intent");
    }
    await expect(intent.guard()).resolves.toEqual({ kind: "proceed" });
  });

  it("queued restart hands the controller a user-repair intent", async () => {
    // The third sibling. A restart queues exactly like converge/register, so
    // a pre-enqueue check alone proves nothing about the host a zero-argument
    // respawn would eventually force-restart — the identity question has to
    // ride the intent to the head of the lane.
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const bridge = makeBridge();
    const handler = await registerHandler(
      bridge,
      invoke.traycerDoctorRepairQueued,
    );
    const respawn = vi.fn((_intent: LocalHostMutationIntent) =>
      Promise.resolve({ kind: "ok" as const, value: { activated: true } }),
    );
    bridge.options.hostController.respawn = respawn;

    await expect(
      handler(null, { repair: "restart", expectedHostId: LIVE_HOST_ID }),
    ).resolves.toEqual({ kind: "applied" });
    expect(respawn).toHaveBeenCalledTimes(1);

    const [intent] = respawn.mock.calls[0] ?? [];
    if (intent?.kind !== "user-repair") {
      throw new Error("expected a user-repair intent");
    }
    await expect(intent.guard()).resolves.toEqual({ kind: "proceed" });
    writeEnrollment("some-other-host");
    await expect(intent.guard()).resolves.toEqual({
      kind: "abandon",
      message: expect.stringContaining("host changed"),
    });
  });

  it("a LATE identity refusal on the queued restart reports declined, not a failure", async () => {
    // Same presentation rule as the lifecycle repairs: an identity refusal
    // noticed at the head of the lane must render exactly like one noticed
    // before enqueueing, or the recurrence lock counts it as a failure.
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const bridge = makeBridge();
    const handler = await registerHandler(
      bridge,
      invoke.traycerDoctorRepairQueued,
    );
    bridge.options.hostController.respawn = async (
      intent: LocalHostMutationIntent,
    ) => {
      if (intent.kind !== "user-repair")
        throw new Error("expected user-repair");
      writeEnrollment("some-other-host");
      const verdict = await intent.guard();
      return verdict.kind === "abandon"
        ? { kind: "abandoned" as const, message: verdict.message }
        : { kind: "ok" as const, value: { activated: true } };
    };

    await expect(
      handler(null, { repair: "restart", expectedHostId: LIVE_HOST_ID }),
    ).resolves.toEqual({
      kind: "declined",
      message: expect.stringContaining("host changed"),
    });
  });

  it("the watched restart passes a user-repair intent and reports a late refusal as declined", async () => {
    // `traycerHostRestartIfIdle` is admitted only against an empty lane, but
    // admission-to-execution still crosses a microtask boundary, so the
    // guard re-asks the identity question at the head of the lane and its
    // refusal renders as the same `declined` the pre-submit check resolves.
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const bridge = makeBridge();
    const handler = await registerHandler(
      bridge,
      invoke.traycerHostRestartIfIdle,
    );
    bridge.options.hostController.respawn = async (
      intent: LocalHostMutationIntent,
    ) => {
      if (intent.kind !== "user-repair")
        throw new Error("expected user-repair");
      writeEnrollment("some-other-host");
      const verdict = await intent.guard();
      return verdict.kind === "abandon"
        ? { kind: "abandoned" as const, message: verdict.message }
        : { kind: "ok" as const, value: { activated: true } };
    };

    await expect(
      handler(null, { expectedHostId: LIVE_HOST_ID }),
    ).resolves.toEqual({
      kind: "declined",
      message: expect.stringContaining("host changed"),
    });
  });

  it("a LATE identity refusal is reported like an early one, not as a failure", async () => {
    // The presentation must not depend on WHEN the mismatch was noticed. A
    // guard refusal arrives as the `abandoned` arm of the SHARED settled
    // outcome — not as caller-local state, which a waiter that coalesced
    // onto another window's identical repair would never see. Getting this
    // wrong is not cosmetic: the legacy console counts a failure toward the
    // recurrence lock that disables Doctor after three clicks.
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const bridge = makeBridge();
    const handler = await registerHandler(
      bridge,
      invoke.traycerDoctorRepairQueued,
    );
    // The controller runs the guard at the head of the lane, by which time
    // this machine's host has been replaced.
    bridge.options.hostController.convergeReady = async (
      _force: boolean,
      intent: LocalHostMutationIntent,
    ) => {
      if (intent.kind !== "user-repair")
        throw new Error("expected user-repair");
      writeEnrollment("some-other-host");
      const verdict = await intent.guard();
      return verdict.kind === "abandon"
        ? { kind: "abandoned" as const, message: verdict.message }
        : { kind: "ok" as const, value: null };
    };

    const result = await handler(null, {
      repair: "converge-ready",
      expectedHostId: LIVE_HOST_ID,
    });
    expect(result).toEqual({
      kind: "declined",
      message: expect.stringContaining("host changed"),
    });
  });

  it("a LATE identity refusal on the watched free-port repair reports host-changed", async () => {
    // The same rule on the other twin. Pinned separately because free-port
    // was missed when the guard was first added to the lifecycle repairs.
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const bridge = makeBridge();
    const handler = await registerHandler(
      bridge,
      invoke.traycerFreePortAndRestartIfIdle,
    );
    bridge.options.hostController.freePortAndRestart = async (
      _pid: number | undefined,
      _port: number | undefined,
      intent: LocalHostMutationIntent,
    ) => {
      if (intent.kind !== "user-repair")
        throw new Error("expected user-repair");
      writeEnrollment("some-other-host");
      const verdict = await intent.guard();
      return verdict.kind === "abandon"
        ? { kind: "abandoned" as const, message: verdict.message }
        : { kind: "ok" as const, value: { activated: true } };
    };

    const result = await handler(null, {
      pid: 4321,
      port: 51234,
      expectedHostId: LIVE_HOST_ID,
    });
    expect(result).toEqual({
      kind: "host-changed",
      message: expect.stringContaining("host changed"),
    });
  });

  it("watched repair hands the controller a user-repair intent too", async () => {
    // The twin. `traycerDoctorRepairIfIdle` cannot clear the sentinel itself
    // without putting an await between its lane test and its submit, so it
    // routes the same intent — which is what stops the two arms from drifting
    // apart again.
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const bridge = makeBridge();
    const handler = await registerHandler(
      bridge,
      invoke.traycerDoctorRepairIfIdle,
    );
    const convergeReady = vi.fn(
      (_force: boolean, _intent: LocalHostMutationIntent) =>
        Promise.resolve({ kind: "ok" as const, value: null }),
    );
    bridge.options.hostController.convergeReady = convergeReady;

    await expect(
      handler(null, {
        repair: "converge-ready",
        expectedHostId: LIVE_HOST_ID,
      }),
    ).resolves.toEqual({
      kind: "dispatched",
      outcome: { kind: "ok", value: null },
    });
    const [force, intent] = convergeReady.mock.calls[0] ?? [];
    expect(force).toBe(false);
    if (intent?.kind !== "user-repair") {
      throw new Error("expected a user-repair intent");
    }
    await expect(intent.guard()).resolves.toEqual({ kind: "proceed" });
  });

  it("queued restart does not clear the removal sentinel", async () => {
    // A restart is not a reprovision; its own removed-by-user deferral
    // must stay. Fails if someone later clears for all three repairs.
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const bridge = makeBridge();
    const handler = await registerHandler(
      bridge,
      invoke.traycerDoctorRepairQueued,
    );
    const removal = await import("../../host/host-removal-state");
    await removal.markHostRemovedByUser();
    expect(await removal.isHostRemovedByUser()).toBe(true);

    const respawn = vi.fn(async () => {
      expect(await removal.isHostRemovedByUser()).toBe(true);
      return {
        kind: "ok" as const,
        value: { activated: true },
      };
    });
    const convergeReady = vi.fn(() =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const registerService = vi.fn(() =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    bridge.options.hostController.respawn = respawn;
    bridge.options.hostController.convergeReady = convergeReady;
    bridge.options.hostController.registerService = registerService;

    await expect(
      handler(null, { repair: "restart", expectedHostId: LIVE_HOST_ID }),
    ).resolves.toEqual({ kind: "applied" });
    expect(respawn).toHaveBeenCalledTimes(1);
    expect(convergeReady).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalled();
    expect(await removal.isHostRemovedByUser()).toBe(true);
  });

  it("queued repair identity mismatch declines without dispatching any controller", async () => {
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const convergeReady = vi.fn(() =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const registerService = vi.fn(() =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const respawn = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { activated: true },
      }),
    );
    const bridge = makeBridge();
    bridge.options.hostController.convergeReady = convergeReady;
    bridge.options.hostController.registerService = registerService;
    bridge.options.hostController.respawn = respawn;
    const handler = await registerHandler(
      bridge,
      invoke.traycerDoctorRepairQueued,
    );
    const mismatched = { expectedHostId: OTHER_HOST_ID };

    await expect(
      handler(null, { repair: "converge-ready", ...mismatched }),
    ).resolves.toEqual({
      kind: "declined",
      message: HOST_CHANGED_MESSAGE,
    });
    await expect(
      handler(null, { repair: "register-service", ...mismatched }),
    ).resolves.toEqual({
      kind: "declined",
      message: HOST_CHANGED_MESSAGE,
    });
    await expect(
      handler(null, { repair: "restart", ...mismatched }),
    ).resolves.toEqual({
      kind: "declined",
      message: HOST_CHANGED_MESSAGE,
    });
    expect(convergeReady).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
  });

  it("queued repair unverifiable enrollment declines without dispatching any controller", async () => {
    writeMalformedEnrollment();
    const invoke = RunnerHostInvoke;
    const convergeReady = vi.fn(() =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const registerService = vi.fn(() =>
      Promise.resolve({ kind: "ok" as const, value: null }),
    );
    const respawn = vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { activated: true },
      }),
    );
    const bridge = makeBridge();
    bridge.options.hostController.convergeReady = convergeReady;
    bridge.options.hostController.registerService = registerService;
    bridge.options.hostController.respawn = respawn;
    const handler = await registerHandler(
      bridge,
      invoke.traycerDoctorRepairQueued,
    );
    const payload = { expectedHostId: LIVE_HOST_ID };

    await expect(
      handler(null, { repair: "converge-ready", ...payload }),
    ).resolves.toEqual({
      kind: "declined",
      message: HOST_UNVERIFIED_MESSAGE,
    });
    await expect(
      handler(null, { repair: "register-service", ...payload }),
    ).resolves.toEqual({
      kind: "declined",
      message: HOST_UNVERIFIED_MESSAGE,
    });
    await expect(
      handler(null, { repair: "restart", ...payload }),
    ).resolves.toEqual({
      kind: "declined",
      message: HOST_UNVERIFIED_MESSAGE,
    });
    expect(convergeReady).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
  });

  it("queued converge-ready and register-service reject a non-ok controller outcome", async () => {
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const bridge = makeBridge();
    bridge.options.hostController.convergeReady = vi.fn(() =>
      Promise.resolve({
        kind: "failed" as const,
        message: "converge failed",
      }),
    );
    bridge.options.hostController.registerService = vi.fn(() =>
      Promise.resolve({
        kind: "failed" as const,
        message: "register failed",
      }),
    );
    const handler = await registerHandler(
      bridge,
      invoke.traycerDoctorRepairQueued,
    );

    await expect(
      handler(null, {
        repair: "converge-ready",
        expectedHostId: LIVE_HOST_ID,
      }),
    ).rejects.toThrow("converge failed");
    await expect(
      handler(null, {
        repair: "register-service",
        expectedHostId: LIVE_HOST_ID,
      }),
    ).rejects.toThrow("register failed");
  });

  it("queued restart that the host declines resolves declined with the host's message", async () => {
    writeEnrollment(LIVE_HOST_ID);
    const invoke = RunnerHostInvoke;
    const bridge = makeBridge();
    bridge.options.hostController.respawn = vi.fn(() =>
      Promise.resolve({
        kind: "deferred" as const,
        message: "Another process holds the host lock.",
      }),
    );
    const handler = await registerHandler(
      bridge,
      invoke.traycerDoctorRepairQueued,
    );

    await expect(
      handler(null, { repair: "restart", expectedHostId: LIVE_HOST_ID }),
    ).resolves.toEqual({
      kind: "declined",
      message: "Another process holds the host lock.",
    });
  });
});

/**
 * `traycerHostAvailable` resolves the DISCOVERED manifest/PATH CLI, which —
 * unlike the bundled, version-matched CLI the maintenance projections use —
 * can be older than the app driving it. Sending it a flag it does not have
 * turned "untick Include release candidates" into a hard error.
 */
describe("traycerHostAvailable old-CLI compatibility", () => {
  beforeEach(beginSandbox);
  afterEach(endSandbox);

  const NEGATIVE_FLAG = "--no-include-pre-releases";

  function rejectUnknownOption(
    flag: string,
  ): (args: readonly string[], CliError: CliErrorCtor) => Promise<unknown> {
    return (args, CliError) => {
      if (args.includes(flag)) {
        // The real envelope: the CLI entry's `applyRunnerErrorRouting` routes
        // commander's parse failure into the JSON error contract under
        // `--json`, carrying commander's own code in `details`.
        return Promise.reject(
          new CliError(
            {
              message: `unknown option '${flag}'\n(Did you mean --include-pre-releases?)`,
              code: "E_INVALID_ARGUMENT",
              details: { commanderCode: "commander.unknownOption" },
              exitCode: 1,
              stderrTail: "",
            },
            null,
          ),
        );
      }
      return Promise.resolve(realShapedAvailablePayload());
    };
  }

  async function availableHandler(): Promise<
    (event: unknown, raw: unknown) => Promise<unknown>
  > {
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const handler = bridge.handlers.get(RunnerHostInvoke.traycerHostAvailable);
    if (handler === undefined) {
      throw new Error("expected traycerHostAvailable handler");
    }
    return handler;
  }

  it("retries once without the negative flag when the CLI does not know it", async () => {
    installFakeCli(rejectUnknownOption(NEGATIVE_FLAG));
    const handler = await availableHandler();

    const result = await handler(null, { includePreReleases: false });

    expect(bundledCliCalls).toEqual([
      ["host", "available", "--json", NEGATIVE_FLAG],
      // Dropping the flag is not a degradation: a CLI that lacks it also
      // predates derived defaults, so its no-flag behaviour IS stable-only.
      ["host", "available", "--json"],
    ]);
    expect(result).toMatchObject({ latest: "1.2.0" });
  });

  it("does NOT retry a generic CLI failure", async () => {
    installFakeCli((_args, CliError) =>
      Promise.reject(
        new CliError(
          {
            message: "registry unreachable",
            code: "E_REGISTRY_UNREACHABLE",
            details: null,
            exitCode: 1,
            stderrTail: "",
          },
          null,
        ),
      ),
    );
    const handler = await availableHandler();

    await expect(handler(null, { includePreReleases: false })).rejects.toThrow(
      "registry unreachable",
    );
    expect(bundledCliCalls).toHaveLength(1);
  });

  it("does NOT retry when an unrelated option is the unknown one", async () => {
    // The refusal names a DIFFERENT flag, so it is a caller bug rather than
    // version skew and must surface rather than trigger a second run.
    installFakeCli((_args, CliError) =>
      Promise.reject(
        new CliError(
          {
            message: "unknown option '--totally-unrelated'",
            code: "E_INVALID_ARGUMENT",
            details: { commanderCode: "commander.unknownOption" },
            exitCode: 1,
            stderrTail: "",
          },
          null,
        ),
      ),
    );
    const handler = await availableHandler();

    await expect(handler(null, { includePreReleases: false })).rejects.toThrow(
      "unknown option",
    );
    expect(bundledCliCalls).toHaveLength(1);
  });

  it("does NOT retry an include or derive request", async () => {
    installFakeCli(rejectUnknownOption("--include-pre-releases"));
    const handler = await availableHandler();

    await expect(handler(null, { includePreReleases: true })).rejects.toThrow(
      "unknown option",
    );
    expect(bundledCliCalls).toHaveLength(1);
  });
});

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
import type { IpcHostController } from "../runner-ipc-bridge";
import type {
  ActivateInstalledOk,
  ApplyStagedOk,
  ApplyStagedTrigger,
  ConvergeReadyOk,
  HostControllerStatus,
  InstallVersionOk,
  MutationOutcome,
  MutationProgress,
  MutationKind,
  MutationLaneStatus,
  RemoveTraycerOk,
  ServiceRegistrationOk,
  UninstallOk,
} from "../../host/host-controller-types";

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

interface RecordedCall {
  readonly kind: "run" | "stream";
  readonly args: readonly string[];
}

interface FakeCli {
  readonly calls: RecordedCall[];
  readonly runResult: unknown;
  readonly streamResult: unknown;
}

function installFakeCli(opts: {
  readonly runResult: unknown;
  readonly streamResult: unknown;
}): FakeCli {
  const calls: RecordedCall[] = [];
  vi.doMock("../../cli/traycer-cli", () => ({
    runTraycerCliJson: vi.fn((args: readonly string[]) => {
      calls.push({ kind: "run", args: [...args] });
      return Promise.resolve(opts.runResult);
    }),
    streamTraycerCliJson: vi.fn(
      ({ args }: { readonly args: readonly string[] }) => {
        calls.push({ kind: "stream", args: [...args] });
        return Promise.resolve({ data: opts.streamResult });
      },
    ),
    TraycerCliError: class extends Error {},
  }));
  return { calls, runResult: opts.runResult, streamResult: opts.streamResult };
}

interface RecordedControllerCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/**
 * Fake `HostController` for the handlers `host-management-ipc.ts` now
 * delegates to (install/update/uninstall/remove/restart/register/deregister
 * /free-port-and-restart/ensure). Records every call so a test can assert
 * delegation + argument threading without spawning a real CLI subprocess;
 * `installVersionResult` / `applyStagedResult` / etc. are mutable so a test
 * can steer a specific outcome kind (busy/deferred/failed) before invoking
 * the handler. Deep behavioural coverage of what each `HostController`
 * method itself does (macOS SMAppService cycles, busy detection, dev-slot
 * CLI argv, ...) lives in `host-controller.test.ts` - this fake only proves
 * the IPC layer wires the right method + args and re-shapes the outcome.
 */
class FakeHostController implements IpcHostController {
  readonly calls: RecordedControllerCall[] = [];
  private progressListeners = new Set<(progress: MutationProgress) => void>();

  installVersionResult: MutationOutcome<InstallVersionOk> = {
    kind: "ok",
    value: { installedVersion: "1.7.0", runningActivated: true },
  };
  applyStagedResult: MutationOutcome<ApplyStagedOk> = {
    kind: "ok",
    value: { appliedVersion: "1.7.0", runningActivated: true },
  };
  activateInstalledResult: MutationOutcome<ActivateInstalledOk> = {
    kind: "ok",
    value: { activated: true },
  };
  uninstallHostResult: MutationOutcome<UninstallOk> = {
    kind: "ok",
    value: { removedInstallDir: true, deregisteredService: true },
  };
  removeTraycerResult: MutationOutcome<RemoveTraycerOk> = {
    kind: "ok",
    value: {
      removedHost: true,
      deregisteredService: true,
      removedLoginItem: false,
    },
  };
  respawnResult: MutationOutcome<ActivateInstalledOk> = {
    kind: "ok",
    value: { activated: true },
  };
  registerServiceResult: MutationOutcome<ServiceRegistrationOk> = {
    kind: "ok",
    value: { registered: true },
  };
  deregisterServiceResult: MutationOutcome<ServiceRegistrationOk> = {
    kind: "ok",
    value: { registered: false },
  };
  freePortAndRestartResult: MutationOutcome<ActivateInstalledOk> = {
    kind: "ok",
    value: { activated: true },
  };
  convergeReadyResult: MutationOutcome<ConvergeReadyOk> = {
    kind: "ok",
    value: { running: true, version: "1.7.0" },
  };
  // Fixup B1: `refreshRegistryUpdateState` now reads `getStatus().updateReady`
  // to project the legacy `updateAvailable` field - every handler that
  // force-refreshes after a mutation calls it, so this fake must answer
  // rather than throw.
  getStatusResult: HostControllerStatus = {
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
    checkedAt: "2026-01-01T00:00:00.000Z",
  };

  // Lets a test simulate the forced post-mutation registry refresh's
  // `getStatus()` read rejecting (fs/identity/endpoint work can genuinely
  // fail) without touching the mutation call itself.
  getStatusError: Error | null = null;

  async getStatus(): Promise<HostControllerStatus> {
    if (this.getStatusError !== null) {
      throw this.getStatusError;
    }
    return this.getStatusResult;
  }
  async convergeReady(
    force: boolean,
  ): Promise<MutationOutcome<ConvergeReadyOk>> {
    this.calls.push({ method: "convergeReady", args: [force] });
    return this.convergeReadyResult;
  }
  async stageLatest(): Promise<void> {
    this.calls.push({ method: "stageLatest", args: [] });
  }
  // Set to defer `applyStaged`'s resolution until `resolveApplyStaged` is
  // called - lets a test observe an in-flight mutation (progress broadcast,
  // status-get mid-operation, a second concurrent call landing) instead of
  // the call resolving synchronously.
  applyStagedDeferred = false;
  private pendingApplyStaged: Array<
    (outcome: MutationOutcome<ApplyStagedOk>) => void
  > = [];

  async applyStaged(
    trigger: ApplyStagedTrigger,
    force: boolean,
  ): Promise<MutationOutcome<ApplyStagedOk>> {
    this.calls.push({ method: "applyStaged", args: [trigger, force] });
    if (this.applyStagedDeferred) {
      return new Promise((resolve) => {
        this.pendingApplyStaged.push(resolve);
      });
    }
    return this.applyStagedResult;
  }

  // Fixup B16: resolves exactly the OLDEST still-pending `applyStaged` call
  // (FIFO), one per invocation - mirrors the real `HostController`'s
  // exclusive mutation lane, where a second concurrent call doesn't settle
  // until the first one's own job has. The previous version resolved every
  // pending call at once regardless of submission order, which is why the
  // concurrent-call test never actually exercised the legacy shim's
  // cross-attribution bug (fixup B16) - nothing ever queued behind
  // anything else's still-running progress window.
  resolveApplyStaged(outcome: MutationOutcome<ApplyStagedOk>): void {
    const resolve = this.pendingApplyStaged.shift();
    if (resolve !== undefined) resolve(outcome);
  }
  async activateInstalled(
    force: boolean,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    this.calls.push({ method: "activateInstalled", args: [force] });
    return this.activateInstalledResult;
  }
  async installVersion(
    pin: string,
    force: boolean,
  ): Promise<MutationOutcome<InstallVersionOk>> {
    this.calls.push({ method: "installVersion", args: [pin, force] });
    return this.installVersionResult;
  }
  async registerService(): Promise<MutationOutcome<ServiceRegistrationOk>> {
    this.calls.push({ method: "registerService", args: [] });
    return this.registerServiceResult;
  }
  async deregisterService(): Promise<MutationOutcome<ServiceRegistrationOk>> {
    this.calls.push({ method: "deregisterService", args: [] });
    return this.deregisterServiceResult;
  }
  async respawn(): Promise<MutationOutcome<ActivateInstalledOk>> {
    this.calls.push({ method: "respawn", args: [] });
    return this.respawnResult;
  }
  async recoverIfDown(): Promise<
    MutationOutcome<ActivateInstalledOk> | { readonly kind: "suppressed" }
  > {
    throw new Error(
      "FakeHostController.recoverIfDown: not used by these tests",
    );
  }
  async freePortAndRestart(
    pid: number | null,
    port: number | null,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    this.calls.push({ method: "freePortAndRestart", args: [pid, port] });
    return this.freePortAndRestartResult;
  }
  async uninstallHost(all: boolean): Promise<MutationOutcome<UninstallOk>> {
    this.calls.push({ method: "uninstallHost", args: [all] });
    return this.uninstallHostResult;
  }
  async removeTraycer(): Promise<MutationOutcome<RemoveTraycerOk>> {
    this.calls.push({ method: "removeTraycer", args: [] });
    return this.removeTraycerResult;
  }
  isPendingRevisionRefreshQuarantined(): boolean {
    return false;
  }
  onMutationProgress(
    listener: (progress: MutationProgress) => void,
  ): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }
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
      readonly getSnapshot: Mock;
    };
    readonly hostController: FakeHostController;
  };
  handleInvoke(
    environment: string,
    handler: (event: unknown, raw: unknown) => unknown | Promise<unknown>,
  ): void;
}

function makeBridge(): FakeBridge {
  return makeBridgeWithHostController(new FakeHostController());
}

function makeBridgeWithHostController(
  hostController: FakeHostController,
): FakeBridge {
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
        getSnapshot: vi.fn(() => ({ version: "1.7.0" })),
      },
      hostController,
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
  it("production environment passes no --environment for host logs/doctor/available", async () => {
    const fake = installFakeCli({
      runResult: {
        // `host available` projector needs a manifest envelope; the
        // other run-style callers (logs, doctor) tolerate this shape since
        // they only read specific fields.
        manifest: {
          generatedAt: "2026-05-15T00:00:00Z",
          latest: "1.7.0",
          versions: [],
        },
        platformKey: "darwin-arm64",
        manifestUrl: "https://example.invalid/versions.json",
        issues: [],
      },
      streamResult: {},
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await bridge.handlers.get(RunnerHostInvoke.traycerHostLogs)!(null, {
      tailLines: 50,
    });
    await bridge.handlers.get(RunnerHostInvoke.traycerHostDoctor)!(null, null);
    await bridge.handlers.get(RunnerHostInvoke.traycerHostAvailable)!(
      null,
      null,
    );

    // No --environment - the CLI resolves its slot from config.environment.
    for (const call of fake.calls) {
      expect(call.args).not.toContain("--environment");
    }
  });

  // Host Update Layer Redesign Tech Plan ("Single-writer cutover"): install /
  // update / uninstall / remove / restart / register / deregister /
  // free-port-and-restart no longer shell out to the CLI directly from this
  // IPC layer - they delegate to `HostController`, the single writer, which
  // owns the CLI invocation (and the macOS SMAppService path) itself. These
  // tests pin the delegation + argument threading; `HostController`'s own
  // CLI argv (including the dev-slot service-install flags) is covered by
  // `host-controller.test.ts`.
  it("delegates install/update/uninstall/remove/restart/register/deregister/free-port to HostController with the right args", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const hostController = bridge.options.hostController;

    await bridge.handlers.get(RunnerHostInvoke.traycerHostInstallVersion)!(
      null,
      { pin: "1.7.0", force: true },
    );
    await bridge.handlers.get(RunnerHostInvoke.traycerHostApplyStaged)!(null, {
      trigger: "manual",
      force: false,
    });
    await bridge.handlers.get(RunnerHostInvoke.traycerHostUninstall)!(null, {
      all: true,
    });
    await bridge.handlers.get(RunnerHostInvoke.traycerAppUninstall)!(
      null,
      null,
    );
    await bridge.handlers.get(RunnerHostInvoke.traycerHostRestart)!(null, null);
    await bridge.handlers.get(RunnerHostInvoke.traycerServiceRegister)!(
      null,
      null,
    );
    await bridge.handlers.get(RunnerHostInvoke.traycerServiceDeregister)!(
      null,
      null,
    );
    await bridge.handlers.get(RunnerHostInvoke.traycerFreePortAndRestart)!(
      null,
      { port: 7000, pid: 1234, processName: "rogue" },
    );

    expect(hostController.calls).toEqual([
      { method: "installVersion", args: ["1.7.0", true] },
      { method: "applyStaged", args: ["manual", false] },
      { method: "uninstallHost", args: [true] },
      { method: "removeTraycer", args: [] },
      { method: "respawn", args: [] },
      { method: "registerService", args: [] },
      { method: "deregisterService", args: [] },
      { method: "freePortAndRestart", args: [1234, 7000] },
    ]);
  });

  it("returns applyStaged's committed ok outcome when its post-apply registry projection rejects", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    bridge.options.hostController.getStatusError = new Error(
      "status projection failed",
    );
    bridge.options.hostController.applyStagedResult = {
      kind: "ok",
      value: { appliedVersion: "2.0.0", runningActivated: true },
    };
    mgmt.registerHostManagementIpc(bridge as never);

    await expect(
      bridge.handlers.get(RunnerHostInvoke.traycerHostApplyStaged)!(null, {
        trigger: "manual",
        force: false,
      }),
    ).resolves.toEqual(bridge.options.hostController.applyStagedResult);
  });

  it("returns installVersion's committed ok outcome when its post-pin registry projection rejects", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    bridge.options.hostController.getStatusError = new Error(
      "status projection failed",
    );
    bridge.options.hostController.installVersionResult = {
      kind: "ok",
      value: { installedVersion: "2.0.0", runningActivated: true },
    };
    mgmt.registerHostManagementIpc(bridge as never);

    await expect(
      bridge.handlers.get(RunnerHostInvoke.traycerHostInstallVersion)!(null, {
        pin: "2.0.0",
        force: false,
      }),
    ).resolves.toEqual(bridge.options.hostController.installVersionResult);
  });

  it("passes applyStaged's busy continuation through unchanged", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    bridge.options.hostController.applyStagedResult = {
      kind: "busy",
      continuation: "activate",
      message: "finish activating the installed host",
    };
    mgmt.registerHostManagementIpc(bridge as never);

    await expect(
      bridge.handlers.get(RunnerHostInvoke.traycerHostApplyStaged)!(null, {
        trigger: "manual",
        force: false,
      }),
    ).resolves.toEqual(bridge.options.hostController.applyStagedResult);
  });

  it("passes activateInstalled's deferred outcome through unchanged", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    bridge.options.hostController.activateInstalledResult = {
      kind: "deferred",
      message: "the host is unavailable",
    };
    mgmt.registerHostManagementIpc(bridge as never);

    await expect(
      bridge.handlers.get(RunnerHostInvoke.traycerHostActivateInstalled)!(
        null,
        {
          force: true,
        },
      ),
    ).resolves.toEqual(bridge.options.hostController.activateInstalledResult);
  });

  it("passes installVersion's installed-not-converged outcome through unchanged", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    bridge.options.hostController.installVersionResult = {
      kind: "installed-not-converged",
      message: "installed but not reachable",
    };
    mgmt.registerHostManagementIpc(bridge as never);

    await expect(
      bridge.handlers.get(RunnerHostInvoke.traycerHostInstallVersion)!(null, {
        pin: "2.0.0",
        force: true,
      }),
    ).resolves.toEqual(bridge.options.hostController.installVersionResult);
  });

  it("passes registerService's failed outcome through unchanged", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    bridge.options.hostController.registerServiceResult = {
      kind: "failed",
      message: "service registration failed",
    };
    mgmt.registerHostManagementIpc(bridge as never);

    await expect(
      bridge.handlers.get(RunnerHostInvoke.traycerServiceRegister)!(null, null),
    ).resolves.toEqual(bridge.options.hostController.registerServiceResult);
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

  it("dev environment passes no --environment for host doctor", async () => {
    const fake = installFakeCli({
      runResult: { issues: [] },
      streamResult: {},
    });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("dev");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);

    await bridge.handlers.get(RunnerHostInvoke.traycerHostDoctor)!(null, null);

    for (const call of fake.calls) {
      expect(call.args).not.toContain("--environment");
    }
  });

  // Dev-slot CLI argv (the `--allow-self-invocation` dev wrapper flag,
  // Ticket f0ae4530) is now HostController's own concern
  // (`devServiceInstallExtras()` on the controller, environment-aware since
  // it already carries `environment`) - pinned by `host-controller.test.ts`.
  // This IPC layer only has to prove it delegates register/deregister/
  // install/uninstall/restart to the controller regardless of which
  // environment is active, and never itself threads an `--environment` flag
  // anywhere (there is nothing left here that could).
  it("dev environment delegates install/uninstall/restart/register/deregister to HostController", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("dev");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const hostController = bridge.options.hostController;

    await bridge.handlers.get(RunnerHostInvoke.traycerHostInstallVersion)!(
      null,
      { pin: "latest", force: true },
    );
    await bridge.handlers.get(RunnerHostInvoke.traycerHostUninstall)!(null, {
      all: true,
    });
    await bridge.handlers.get(RunnerHostInvoke.traycerHostRestart)!(null, null);
    await bridge.handlers.get(RunnerHostInvoke.traycerServiceRegister)!(
      null,
      null,
    );
    await bridge.handlers.get(RunnerHostInvoke.traycerServiceDeregister)!(
      null,
      null,
    );

    expect(hostController.calls).toEqual([
      { method: "installVersion", args: ["latest", true] },
      { method: "uninstallHost", args: [true] },
      { method: "respawn", args: [] },
      { method: "registerService", args: [] },
      { method: "deregisterService", args: [] },
    ]);
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

  it("echoes the confirmed port/pid/processName back after HostController.freePortAndRestart succeeds", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("dev");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const result = await bridge.handlers.get(
      RunnerHostInvoke.traycerFreePortAndRestart,
    )!(null, { port: 7000, pid: 1234, processName: "rogue" });
    expect(result).toEqual({ port: 7000, pid: 1234, processName: "rogue" });
    expect(bridge.options.hostController.calls).toContainEqual({
      method: "freePortAndRestart",
      args: [1234, 7000],
    });
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
      calls.push({ kind: "run", args: [...args] });
      return Promise.reject(
        new FakeTraycerCliError(
          "E_HOST_VERIFY_FAILED",
          "host registry: no trusted signing keys are configured for this build",
        ),
      );
    }),
    streamTraycerCliJson: vi.fn(
      ({ args }: { readonly args: readonly string[] }) => {
        calls.push({ kind: "stream", args: [...args] });
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

// Renderer surfaces cutover (Host Update Layer Redesign Tech Plan): the old
// `traycerHostEnsure` handler (collapsed in from the deleted
// `host-ensure-ipc.ts`) re-shaped `HostController.convergeReady`'s outcome
// into a bespoke `HostEnsureResult` union (`action: "provisioned" |
// "removed" | "host-busy"`) and rejected the invoke on a deferred/failed
// outcome. `traycerHostConvergeReady` replaces it with a raw pass-through of
// `MutationOutcome<ConvergeReadyOk>` - every renderer surface branches on
// `kind` itself now, so there is no re-shaping left to pin, and "wait-never-
// reject" means a failed/deferred outcome resolves rather than rejects. The
// busy-outcome-triggers-a-disk-reload side effect is gone too: the old
// mapping needed a live `version` to synthesize a plausible
// `HostEnsureResult`; the new outcome only needs to forward `continuation`
// and `message`, so nothing needs re-reading from disk. What every branch
// still owned by `HostController.convergeReady` itself (reachability,
// SMAppService registration, busy detection, readiness polling) does is
// covered by `host-controller.test.ts`.
describe("host-management IPC - traycerHostConvergeReady delegates to HostController.convergeReady", () => {
  it("forwards force and returns the raw ok outcome unchanged", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    bridge.options.hostController.convergeReadyResult = {
      kind: "ok",
      value: { running: true, version: "1.7.0" },
    };

    const result = await bridge.handlers.get(
      RunnerHostInvoke.traycerHostConvergeReady,
    )!(null, { force: true });

    expect(result).toEqual({
      kind: "ok",
      value: { running: true, version: "1.7.0" },
    });
    expect(bridge.options.hostController.calls).toContainEqual({
      method: "convergeReady",
      args: [true],
    });
  });

  it("defaults force to false when omitted", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    bridge.options.hostController.convergeReadyResult = {
      kind: "ok",
      value: { running: false, version: null },
    };

    const result = await bridge.handlers.get(
      RunnerHostInvoke.traycerHostConvergeReady,
    )!(null, null);

    expect(result).toEqual({
      kind: "ok",
      value: { running: false, version: null },
    });
    expect(bridge.options.hostController.calls).toContainEqual({
      method: "convergeReady",
      args: [false],
    });
  });

  it("forwards a busy outcome unchanged, with no disk-reload side effect", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    bridge.options.hostController.convergeReadyResult = {
      kind: "busy",
      continuation: "activate",
      message: "host busy",
    };

    const result = await bridge.handlers.get(
      RunnerHostInvoke.traycerHostConvergeReady,
    )!(null, null);

    expect(result).toEqual({
      kind: "busy",
      continuation: "activate",
      message: "host busy",
    });
    expect(bridge.options.host.reloadSnapshotFromDisk).not.toHaveBeenCalled();
  });

  it("resolves (never rejects) a deferred/failed outcome", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    bridge.options.hostController.convergeReadyResult = {
      kind: "failed",
      message: "no host installed",
    };

    const result = await bridge.handlers.get(
      RunnerHostInvoke.traycerHostConvergeReady,
    )!(null, null);

    expect(result).toEqual({
      kind: "failed",
      message: "no host installed",
    });
  });
});

// Renderer surfaces cutover (Host Update Layer Redesign Tech Plan): this
// whole describe block ("legacy progress broadcast over HostController's
// mutation lane") pinned the caller-supplied-`operationId` attribution layer
// - `cliOperationProgress`/`hostOperationStatusChange` events,
// `getHostOperationStatus()`/`traycerHostOperationStatusGet`, and the
// `*ForOperation` fake-controller overloads that carried a renderer-chosen id
// through to progress ticks. None of it exists in production
// `host-management-ipc.ts` anymore (`registerHostManagementIpc` no longer
// registers those channels or exports `getHostOperationStatus`) - it's
// superseded by `host-controller-status-broadcast.ts`, which pushes the
// single canonical `HostControllerStatus.mutation` value (no caller-supplied
// id) to every window.
//
// The "attribution" problem these tests solved (which of several concurrent
// legacy calls does a progress tick belong to?) does not exist in the new
// model: `HostController`'s mutation lane is exclusive - there is only ever
// one lane-owning operation, so there is nothing to attribute between. That
// exclusivity, and "a second concurrent submission is served (FIFO), never
// rejected," are pinned at the source in `host-controller.test.ts` (see "two
// concurrent applyStaged submissions both resolve - no 'Another host
// operation' rejection" and the "P10: ... coalesce" cluster). "Status clears
// so a retry isn't blocked" is structural in the new design too: the
// broadcaster always re-reads `hostController.getStatus()` fresh, so a
// settled/failed mutation is reflected as `mutation: null` on the very next
// tick, with no separate clear-up step that could leave a wedge.
// `host-controller-status-broadcast.test.ts` covers the broadcaster's own
// push/poll behavior directly.

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
  private progressListenersWithKind = new Set<
    (progress: MutationProgress, kind: MutationKind) => void
  >();

  installVersionResult: MutationOutcome<InstallVersionOk> = {
    kind: "ok",
    value: { installedVersion: "1.7.0", runningActivated: true },
  };
  applyStagedResult: MutationOutcome<ApplyStagedOk> = {
    kind: "ok",
    value: { appliedVersion: "1.7.0", runningActivated: true },
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

  async getStatus(): Promise<HostControllerStatus> {
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
    _force: boolean,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    throw new Error(
      "FakeHostController.activateInstalled: not used by these tests",
    );
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
  onMutationProgressWithKind(
    listener: (progress: MutationProgress, kind: MutationKind) => void,
  ): () => void {
    this.progressListenersWithKind.add(listener);
    return () => {
      this.progressListenersWithKind.delete(listener);
    };
  }
  emitProgress(progress: MutationProgress, kind: MutationKind): void {
    for (const listener of this.progressListeners) {
      listener(progress);
    }
    for (const listener of this.progressListenersWithKind) {
      listener(progress, kind);
    }
  }
}

// Mirrors the production controller's explicit lane identity without making
// every IPC wiring test simulate the mutation scheduler. This lets the F9
// test drive a same-kind launch apply and a renderer update independently.
class AttributedFakeHostController extends FakeHostController {
  private attributedProgressListeners = new Set<
    (
      progress: MutationProgress,
      kind: MutationKind,
      operationId: string | null,
    ) => void
  >();
  private mutationStatusListeners = new Set<
    (status: MutationLaneStatus | null) => void
  >();

  async applyStagedForOperation(
    trigger: ApplyStagedTrigger,
    force: boolean,
    _operationId: string,
  ): Promise<MutationOutcome<ApplyStagedOk>> {
    return super.applyStaged(trigger, force);
  }

  async convergeReadyForOperation(
    force: boolean,
    _operationId: string,
  ): Promise<MutationOutcome<ConvergeReadyOk>> {
    return super.convergeReady(force);
  }

  async installVersionForOperation(
    pin: string,
    force: boolean,
    _operationId: string,
  ): Promise<MutationOutcome<InstallVersionOk>> {
    return super.installVersion(pin, force);
  }

  async registerServiceForOperation(
    _operationId: string,
  ): Promise<MutationOutcome<ServiceRegistrationOk>> {
    return super.registerService();
  }

  onMutationProgressWithKind(
    listener: (
      progress: MutationProgress,
      kind: MutationKind,
      operationId: string | null,
    ) => void,
  ): () => void {
    this.attributedProgressListeners.add(listener);
    return () => {
      this.attributedProgressListeners.delete(listener);
    };
  }

  onMutationStatus(
    listener: (status: MutationLaneStatus | null) => void,
  ): () => void {
    this.mutationStatusListeners.add(listener);
    return () => {
      this.mutationStatusListeners.delete(listener);
    };
  }

  emitAttributedProgress(
    progress: MutationProgress,
    kind: MutationKind,
    operationId: string | null,
  ): void {
    for (const listener of this.attributedProgressListeners) {
      listener(progress, kind, operationId);
    }
  }

  emitMutationStatus(status: MutationLaneStatus | null): void {
    for (const listener of this.mutationStatusListeners) {
      listener(status);
    }
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
    await bridge.handlers.get(RunnerHostInvoke.traycerAppUninstall)!(
      null,
      null,
    );
    await bridge.handlers.get(RunnerHostInvoke.traycerHostRestart)!(null, null);
    await bridge.handlers.get(RunnerHostInvoke.traycerServiceRegister)!(null, {
      operationId: "op-register",
    });
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

    await bridge.handlers.get(RunnerHostInvoke.traycerHostInstall)!(null, {
      version: "latest",
      operationId: "op-install",
    });
    await bridge.handlers.get(RunnerHostInvoke.traycerHostUninstall)!(null, {
      all: true,
    });
    await bridge.handlers.get(RunnerHostInvoke.traycerHostRestart)!(null, null);
    await bridge.handlers.get(RunnerHostInvoke.traycerServiceRegister)!(null, {
      operationId: "op-register",
    });
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

// `traycerHostEnsure` was collapsed in from the deleted `host-ensure-ipc.ts`
// (Host Update Layer Redesign Tech Plan, "Single-writer cutover"): every
// branch it used to hand-roll (fast reachability check, macOS SMAppService
// registration, busy detection, readiness polling, the pending-LaunchAgent-
// revision opportunistic refresh) now lives in `HostController.convergeReady`
// - covered by `host-controller.test.ts`. This only pins the IPC layer's
// re-shaping of `MutationOutcome<ConvergeReadyOk>` into the legacy
// `HostEnsureResult` union the renderer still expects.
describe("host-management IPC - traycerHostEnsure delegates to HostController.convergeReady", () => {
  it("maps an ok outcome with running=true to action 'provisioned'", async () => {
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
      RunnerHostInvoke.traycerHostEnsure,
    )!(null, { operationId: "op-ensure", force: true });

    expect(result).toEqual({
      action: "provisioned",
      running: true,
      version: "1.7.0",
    });
    expect(bridge.options.hostController.calls).toContainEqual({
      method: "convergeReady",
      args: [true],
    });
  });

  it("maps an ok outcome with running=false (removed-by-user short-circuit) to action 'removed'", async () => {
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
      RunnerHostInvoke.traycerHostEnsure,
    )!(null, null);

    expect(result).toEqual({
      action: "removed",
      running: false,
      version: null,
    });
  });

  it("maps a busy outcome to action 'host-busy', surfacing the reloaded snapshot's version", async () => {
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
      RunnerHostInvoke.traycerHostEnsure,
    )!(null, null);

    expect(result).toEqual({
      action: "host-busy",
      running: true,
      version: "1.7.0",
    });
    expect(bridge.options.host.reloadSnapshotFromDisk).toHaveBeenCalled();
  });

  it("rejects the invoke on a deferred/failed outcome", async () => {
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

    await expect(
      bridge.handlers.get(RunnerHostInvoke.traycerHostEnsure)!(null, null),
    ).rejects.toThrow(/no host installed/);
  });
});

// Host Update Layer Redesign Tech Plan ("Single-writer cutover") - Ticket:
// host-update-race-conditions originally fixed the banner/Settings-→-Host
// double-click race with an IPC-layer single-flight guard that rejected a
// second concurrent call outright ("Another host operation (…) is already
// in progress"). That guard is now GONE from this file entirely -
// `HostController`'s own two-lane mutation scheduler is the single writer,
// and it queues a concurrent submission (wait-never-reject) instead of
// rejecting it. These tests pin the replacement contract: a second
// concurrent call is served, not rejected, and the legacy
// `hostOperationStatusChange` / `cliOperationProgress` broadcast still works
// by re-emitting `HostController.onMutationProgress` ticks.
async function waitForCallCount(
  hostController: FakeHostController,
  method: string,
  count: number,
): Promise<void> {
  await vi.waitFor(() => {
    if (
      hostController.calls.filter((c) => c.method === method).length < count
    ) {
      throw new Error(`${method} call not reached yet`);
    }
  });
}

describe("host-management IPC - legacy progress broadcast over HostController's mutation lane", () => {
  it("no longer rejects a second concurrent host update - both calls reach HostController instead of one being refused synchronously", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const hostController = bridge.options.hostController;
    hostController.applyStagedDeferred = true;
    const updateHandler = bridge.handlers.get(
      RunnerHostInvoke.traycerHostUpdate,
    )!;

    const first = updateHandler(null, { operationId: "op-first" });
    await waitForCallCount(hostController, "applyStaged", 1);
    const second = updateHandler(null, { operationId: "op-second" });
    await waitForCallCount(hostController, "applyStaged", 2);

    // Fixup B16: `resolveApplyStaged` now settles exactly one pending call
    // per invocation, FIFO - mirrors HostController's real exclusive
    // mutation lane, where the second call's own job doesn't settle until
    // the first one's has. One call each, in submission order.
    hostController.resolveApplyStaged({
      kind: "ok",
      value: { appliedVersion: "1.7.0", runningActivated: true },
    });
    await expect(first).resolves.toBeDefined();
    hostController.resolveApplyStaged({
      kind: "ok",
      value: { appliedVersion: "1.7.0", runningActivated: true },
    });
    await expect(second).resolves.toBeDefined();
    expect(
      hostController.calls.filter((c) => c.method === "applyStaged"),
    ).toHaveLength(2);
  });

  // Fixup B16: a second legacy-tracked call queued behind a first one on
  // HostController's real exclusive FIFO mutation lane used to overwrite
  // `currentOperationStatus` with its own (still-queued) identity the
  // moment it was invoked, and its progress listener received the FIRST
  // call's progress ticks too (both listeners are registered on the same
  // shared `onMutationProgress` source) - mislabeling A's progress as B's.
  // The first call's own `finally` then cleared the status to `null` while
  // the second was still genuinely in flight.
  it("attributes progress to the queued-first call and doesn't clear status early when a second legacy call is still in flight", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostEvent, RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const hostController = bridge.options.hostController;
    hostController.applyStagedDeferred = true;
    const updateHandler = bridge.handlers.get(
      RunnerHostInvoke.traycerHostUpdate,
    )!;

    const first = updateHandler(null, { operationId: "op-A" });
    await waitForCallCount(hostController, "applyStaged", 1);
    const second = updateHandler(null, { operationId: "op-B" });
    await waitForCallCount(hostController, "applyStaged", 2);

    // A progress tick while both are queued must be attributed to A - it's
    // the one HostController's real lane is actually running (mirrored
    // here by resolving strictly in submission order below).
    hostController.emitProgress(
      {
        stage: "download",
        percent: 40,
        bytes: 40,
        totalBytes: 100,
        message: "downloading",
      },
      "apply",
    );
    const progressCalls = () =>
      bridge.fanOut.mock.calls.filter(
        ([channel]) => channel === RunnerHostEvent.cliOperationProgress,
      );
    // The shared controller emitter has two registered legacy calls here,
    // but exactly one front-of-lane legacy update may publish A's progress.
    expect(progressCalls()).toHaveLength(1);
    expect(progressCalls()[0]?.[1]).toMatchObject({ operationId: "op-A" });
    expect(mgmt.getHostOperationStatus()).toMatchObject({
      operationId: "op-A",
      percent: 40,
    });

    // A non-legacy mutation must not be attributed to the queued legacy
    // update merely because the legacy listener is currently registered.
    hostController.emitProgress(
      {
        stage: "activate",
        percent: null,
        bytes: null,
        totalBytes: null,
        message: "non-legacy respawn",
      },
      "respawn",
    );
    expect(progressCalls()).toHaveLength(1);

    // A settles first - B is still legitimately in flight, so status must
    // hand off to B's identity, never drop to null.
    hostController.resolveApplyStaged({
      kind: "ok",
      value: { appliedVersion: "1.7.0", runningActivated: true },
    });
    await first;
    expect(mgmt.getHostOperationStatus()).toMatchObject({
      operationId: "op-B",
    });

    hostController.resolveApplyStaged({
      kind: "ok",
      value: { appliedVersion: "1.7.0", runningActivated: true },
    });
    await second;
    expect(mgmt.getHostOperationStatus()).toBeNull();
  });

  it("F9: ignores same-kind progress from a non-legacy lane operation until the renderer update owns the lane", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostEvent, RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const hostController = new AttributedFakeHostController();
    hostController.applyStagedDeferred = true;
    const bridge = makeBridgeWithHostController(hostController);
    mgmt.registerHostManagementIpc(bridge as never);
    const updateHandler = bridge.handlers.get(
      RunnerHostInvoke.traycerHostUpdate,
    )!;

    const update = updateHandler(null, { operationId: "renderer-update" });
    await waitForCallCount(hostController, "applyStaged", 1);

    // A launch apply has the same MutationKind as a renderer update, but it
    // carries no renderer operation identity. It must not light up the
    // renderer's update progress or status just because a legacy update is
    // waiting behind it.
    hostController.emitMutationStatus({
      kind: "apply",
      operationId: null,
      progress: null,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    hostController.emitAttributedProgress(
      {
        stage: "apply",
        percent: 20,
        bytes: 20,
        totalBytes: 100,
        message: "launch apply",
      },
      "apply",
      null,
    );
    const progressCalls = () =>
      bridge.fanOut.mock.calls.filter(
        ([channel]) => channel === RunnerHostEvent.cliOperationProgress,
      );
    expect(progressCalls()).toHaveLength(0);
    expect(mgmt.getHostOperationStatus()).toBeNull();

    hostController.emitMutationStatus({
      kind: "apply",
      operationId: "renderer-update",
      progress: null,
      startedAt: "2026-01-01T00:00:01.000Z",
    });
    hostController.emitAttributedProgress(
      {
        stage: "apply",
        percent: 70,
        bytes: 70,
        totalBytes: 100,
        message: "renderer apply",
      },
      "apply",
      "renderer-update",
    );
    expect(progressCalls()).toHaveLength(1);
    expect(progressCalls()[0]?.[1]).toMatchObject({
      operationId: "renderer-update",
      percent: 70,
    });
    expect(mgmt.getHostOperationStatus()).toMatchObject({
      operationId: "renderer-update",
      percent: 70,
    });

    hostController.resolveApplyStaged({
      kind: "ok",
      value: { appliedVersion: "1.7.0", runningActivated: true },
    });
    await update;
  });

  it("broadcasts hostOperationStatusChange on start, re-broadcasts HostController's progress ticks, and clears status to null on settle", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke, RunnerHostEvent } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const hostController = bridge.options.hostController;
    hostController.applyStagedDeferred = true;

    const updatePromise = bridge.handlers.get(
      RunnerHostInvoke.traycerHostUpdate,
    )!(null, { operationId: "op-update" });
    await waitForCallCount(hostController, "applyStaged", 1);

    const statusCalls = () =>
      bridge.fanOut.mock.calls.filter(
        ([channel]) => channel === RunnerHostEvent.hostOperationStatusChange,
      );
    expect(statusCalls()[0]?.[1]).toMatchObject({
      kind: "update",
      percent: null,
    });
    expect(mgmt.getHostOperationStatus()).toMatchObject({ kind: "update" });

    hostController.emitProgress(
      {
        stage: "download",
        percent: 50,
        bytes: 50,
        totalBytes: 100,
        message: "downloading",
      },
      "apply",
    );
    hostController.resolveApplyStaged({
      kind: "ok",
      value: { appliedVersion: "1.7.0", runningActivated: true },
    });
    await updatePromise;

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
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const hostController = bridge.options.hostController;
    hostController.applyStagedDeferred = true;

    const updatePromise = bridge.handlers.get(
      RunnerHostInvoke.traycerHostUpdate,
    )!(null, { operationId: "op-update" });
    await waitForCallCount(hostController, "applyStaged", 1);
    hostController.resolveApplyStaged({
      kind: "failed",
      message: "network unreachable",
    });
    await expect(updatePromise).rejects.toThrow(/network unreachable/);
    expect(mgmt.getHostOperationStatus()).toBeNull();

    // A subsequent attempt is served normally - the failed op left no wedge.
    hostController.applyStagedResult = {
      kind: "ok",
      value: { appliedVersion: "1.7.0", runningActivated: true },
    };
    hostController.applyStagedDeferred = false;
    const retry = bridge.handlers.get(RunnerHostInvoke.traycerHostUpdate)!(
      null,
      { operationId: "op-retry" },
    );
    await expect(retry).resolves.toBeDefined();
    expect(mgmt.getHostOperationStatus()).toBeNull();
  });

  it("traycerHostOperationStatusGet reflects the in-flight operation for a component that mounts mid-operation", async () => {
    installFakeCli({ runResult: {}, streamResult: {} });
    const mgmt = await import("../host-management-ipc");
    mgmt.setActiveEnvironment("production");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    mgmt.registerHostManagementIpc(bridge as never);
    const hostController = bridge.options.hostController;
    hostController.applyStagedDeferred = true;

    const statusHandler = bridge.handlers.get(
      RunnerHostInvoke.traycerHostOperationStatusGet,
    )!;
    expect(await statusHandler(null, null)).toBeNull();

    const updatePromise = bridge.handlers.get(
      RunnerHostInvoke.traycerHostUpdate,
    )!(null, { operationId: "op-update" });
    await waitForCallCount(hostController, "applyStaged", 1);
    expect(await statusHandler(null, null)).toMatchObject({ kind: "update" });

    hostController.resolveApplyStaged({
      kind: "ok",
      value: { appliedVersion: "1.7.0", runningActivated: true },
    });
    await updatePromise;
    expect(await statusHandler(null, null)).toBeNull();
  });
});

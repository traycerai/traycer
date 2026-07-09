import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";

// Pins the `host ensure` state machine: a lock-free fast no-op when the
// host is already installed + registered + running, and the three
// mutating branches (full install, service-only register, start) keyed
// off the current install record + service status.

const mocks = vi.hoisted(() => ({
  installHostMock: vi.fn(),
  resolveBundledHostArchiveMock: vi.fn(),
  readHostInstallRecordMock: vi.fn(),
  resolveServiceCliInvocationMock: vi.fn(),
  createServiceControllerMock: vi.fn(),
  serviceLabelForMock: vi.fn(),
  createServiceInstallLifecycleMock: vi.fn(),
  withCliLockMock: vi.fn(),
  assertHostNotBusyMock: vi.fn(),
}));

vi.mock("../../installer", () => ({
  installHost: mocks.installHostMock,
}));

vi.mock("../../installer/bundled-host", () => ({
  resolveBundledHostArchive: mocks.resolveBundledHostArchiveMock,
}));

vi.mock("../../manifest/host-install", () => ({
  readHostInstallRecord: mocks.readHostInstallRecordMock,
}));

vi.mock("../../service", () => ({
  createServiceController: mocks.createServiceControllerMock,
  serviceLabelFor: mocks.serviceLabelForMock,
}));

vi.mock("../../service/cli-binary", () => ({
  resolveServiceCliInvocation: mocks.resolveServiceCliInvocationMock,
}));

vi.mock("../../service/install-lifecycle", () => ({
  createServiceInstallLifecycle: mocks.createServiceInstallLifecycleMock,
}));

vi.mock("../../store/cli-lock", () => ({
  withCliLock: mocks.withCliLockMock,
}));

vi.mock("../busy-check", () => ({
  assertHostNotBusy: mocks.assertHostNotBusyMock,
}));

const {
  installHostMock,
  resolveBundledHostArchiveMock,
  readHostInstallRecordMock,
  resolveServiceCliInvocationMock,
  createServiceControllerMock,
  serviceLabelForMock,
  createServiceInstallLifecycleMock,
  withCliLockMock,
  assertHostNotBusyMock,
} = mocks;

import { ensureHost, type EnsureHostOptions } from "../ensure";
import { config } from "../../config";
import { cliError, CLI_ERROR_CODES } from "../../runner/errors";

function makeRuntime(): RuntimeContext {
  return {
    json: false,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: "production",
    logger: noopLogger,
  };
}

function makeOpts(overrides: Partial<EnsureHostOptions>): EnsureHostOptions {
  return {
    runtime: makeRuntime(),
    versionRequest: null,
    fromPath: null,
    enableLinger: true,
    allowSelfInvocation: true,
    noServiceRegister: false,
    force: false,
    onProgress: null,
    ...overrides,
  };
}

function makeController(state: "running" | "stopped" | "not-installed") {
  let current = state;
  return {
    status: vi.fn(async () => ({
      state: current,
      version: null,
      listenUrl: null,
      pid: null,
    })),
    install: vi.fn(async () => {
      current = "running";
    }),
    start: vi.fn(async () => {
      current = "running";
    }),
    uninstall: vi.fn(async () => {
      current = "not-installed";
    }),
    stop: vi.fn(async () => {
      current = "stopped";
    }),
    restart: vi.fn(async () => {
      current = "running";
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  config.supportedHostVersion = null;
  serviceLabelForMock.mockImplementation(
    (environment: "production" | "dev") => ({
      id: environment === "dev" ? "ai.traycer.host.dev" : "ai.traycer.host",
      displayName: "Traycer Host",
      environment,
      devSlot: null,
    }),
  );
  resolveServiceCliInvocationMock.mockResolvedValue({
    command: "/usr/local/bin/traycer",
    args: [],
  });
  resolveBundledHostArchiveMock.mockResolvedValue(null);
  withCliLockMock.mockImplementation(
    async (_opts: unknown, fn: () => Promise<unknown>) => fn(),
  );
  createServiceInstallLifecycleMock.mockImplementation(() => ({
    state: {
      priorState: "not-installed",
      stoppedBeforeSwap: false,
      postSwapAction: "install",
      postSwapError: null,
    },
    lifecycle: { beforeSwap: vi.fn(), afterSwap: vi.fn() },
  }));
  installHostMock.mockResolvedValue({ record: { version: "1.6.0" } });
  assertHostNotBusyMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("ensureHost", () => {
  it("fast no-op when installed + registered + running (no lock, no install)", async () => {
    readHostInstallRecordMock.mockResolvedValue({ version: "1.5.0" });
    const controller = makeController("running");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({}));

    expect(result.action).toBe("noop");
    expect(result.running).toBe(true);
    expect(withCliLockMock).not.toHaveBeenCalled();
    expect(installHostMock).not.toHaveBeenCalled();
    expect(controller.install).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
  });

  it("starts a registered-but-stopped host without reinstalling", async () => {
    readHostInstallRecordMock.mockResolvedValue({ version: "1.5.0" });
    const controller = makeController("stopped");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({}));

    expect(result.action).toBe("started");
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(installHostMock).not.toHaveBeenCalled();
    expect(controller.install).not.toHaveBeenCalled();
  });

  it("registers the service when installed but not registered (no download)", async () => {
    readHostInstallRecordMock.mockResolvedValue({ version: "1.5.0" });
    const controller = makeController("not-installed");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({}));

    expect(result.action).toBe("service-registered");
    expect(controller.install).toHaveBeenCalledTimes(1);
    expect(resolveServiceCliInvocationMock).toHaveBeenCalledTimes(1);
    expect(installHostMock).not.toHaveBeenCalled();
  });

  it("installs from the registry (latest) when no host is installed", async () => {
    readHostInstallRecordMock.mockResolvedValue(null);
    const controller = makeController("not-installed");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({}));

    expect(result.action).toBe("installed");
    expect(result.version).toBe("1.6.0");
    expect(installHostMock).toHaveBeenCalledTimes(1);
    expect(installHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "registry", versionRequest: "latest" },
      }),
    );
  });

  it("uses the configured supported host version for default registry installs", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue(null);
    const controller = makeController("not-installed");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({}));

    expect(result.action).toBe("installed");
    expect(installHostMock).toHaveBeenCalledTimes(1);
    expect(installHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "registry", versionRequest: "1.7.2" },
      }),
    );
  });

  it("reinstalls when the supported host version does not match the record", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue({ version: "1.6.0" });
    const controller = makeController("running");
    createServiceControllerMock.mockReturnValue(controller);
    installHostMock.mockResolvedValue({ record: { version: "1.7.2" } });

    const result = await ensureHost(makeOpts({}));

    expect(result.action).toBe("installed");
    expect(installHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "registry", versionRequest: "1.7.2" },
      }),
    );
  });

  it("probes the busy check before reinstalling a running host (not forced)", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue({ version: "1.6.0" });
    createServiceControllerMock.mockReturnValue(makeController("running"));

    const result = await ensureHost(makeOpts({}));

    expect(assertHostNotBusyMock).toHaveBeenCalledTimes(1);
    expect(result.action).toBe("installed");
  });

  it("aborts the reinstall when the busy probe throws E_HOST_BUSY", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue({ version: "1.6.0" });
    createServiceControllerMock.mockReturnValue(makeController("running"));
    assertHostNotBusyMock.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "busy",
        details: null,
        exitCode: 1,
      }),
    );

    await expect(ensureHost(makeOpts({}))).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
    expect(installHostMock).not.toHaveBeenCalled();
  });

  it("--force skips the busy probe and reinstalls a running host", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue({ version: "1.6.0" });
    createServiceControllerMock.mockReturnValue(makeController("running"));

    const result = await ensureHost(makeOpts({ force: true }));

    expect(assertHostNotBusyMock).not.toHaveBeenCalled();
    expect(result.action).toBe("installed");
  });

  it("always consults the busy check when reinstalling (the check no-ops when no live host)", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue({ version: "1.6.0" });
    createServiceControllerMock.mockReturnValue(makeController("stopped"));

    const result = await ensureHost(makeOpts({}));

    // The gate no longer keys on the service `running` flag; the busy-check
    // module itself returns for a dead/absent host (see busy-check.test.ts).
    // Here the mock no-ops, so the install proceeds.
    expect(assertHostNotBusyMock).toHaveBeenCalledTimes(1);
    expect(result.action).toBe("installed");
  });

  it("--force reinstalls even when the install record already matches (no satisfied no-op)", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue({ version: "1.7.2" });
    createServiceControllerMock.mockReturnValue(makeController("running"));
    installHostMock.mockResolvedValue({ record: { version: "1.7.2" } });

    const result = await ensureHost(makeOpts({ force: true }));

    // Without force this is a no-op (installed + registered + running + version
    // matches); force must still reinstall + restart (D5).
    expect(result.action).toBe("installed");
    expect(installHostMock).toHaveBeenCalledTimes(1);
    expect(assertHostNotBusyMock).not.toHaveBeenCalled();
  });

  it("noServiceRegister installs bytes only - no service register/start, no lifecycle", async () => {
    readHostInstallRecordMock.mockResolvedValue(null);
    const controller = makeController("not-installed");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({ noServiceRegister: true }));

    expect(result.action).toBe("installed");
    expect(installHostMock).toHaveBeenCalledTimes(1);
    // Host (desktop SMAppService) owns registration - the CLI must not
    // touch the OS service or build a registering lifecycle.
    expect(controller.install).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
    expect(createServiceInstallLifecycleMock).not.toHaveBeenCalled();
    expect(result.serviceLifecycle).toBeNull();
  });

  it("noServiceRegister no-ops when bytes already installed (ignores service state)", async () => {
    readHostInstallRecordMock.mockResolvedValue({ version: "1.5.0" });
    const controller = makeController("not-installed");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({ noServiceRegister: true }));

    expect(result.action).toBe("noop");
    expect(installHostMock).not.toHaveBeenCalled();
    expect(controller.install).not.toHaveBeenCalled();
  });

  it("prefers the packaged host archive over the registry for latest", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue(null);
    resolveBundledHostArchiveMock.mockResolvedValue("/bundle/host.tar.gz");
    const controller = makeController("not-installed");
    createServiceControllerMock.mockReturnValue(controller);

    await ensureHost(makeOpts({}));

    expect(installHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "local-file", path: "/bundle/host.tar.gz" },
      }),
    );
  });

  it("keeps explicit latest as a live registry request even when a default version is configured", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue(null);
    const controller = makeController("not-installed");
    createServiceControllerMock.mockReturnValue(controller);

    await ensureHost(makeOpts({ versionRequest: "latest" }));

    expect(installHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "registry", versionRequest: "latest" },
      }),
    );
  });

  it("reinstalls when an explicit --release version does not match the record", async () => {
    readHostInstallRecordMock.mockResolvedValue({ version: "1.5.0" });
    const controller = makeController("running");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({ versionRequest: "1.6.0" }));

    expect(result.action).toBe("installed");
    expect(installHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "registry", versionRequest: "1.6.0" },
      }),
    );
  });
});

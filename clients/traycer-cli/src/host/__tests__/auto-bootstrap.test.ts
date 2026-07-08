import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";

// Pin Ticket a440ec2d: auto-bootstrap must distinguish "host already
// installed but service missing" (service-only repair) from "no host
// at all" (full install). The full installer must not be invoked when a
// host install record is present, and the service-only branch must
// not depend on the registry being reachable.

// vi.mock factory hoists above the surrounding module, so the per-mock
// `vi.fn()` references must live inside `vi.hoisted(...)` so they are
// initialized before the factory runs. The hoisted block also keeps
// the mocks reusable across test cases via the returned handle.
const mocks = vi.hoisted(() => ({
  installHostMock: vi.fn(),
  resolveBundledHostArchiveMock: vi.fn(),
  readHostInstallRecordMock: vi.fn(),
  resolveServiceCliInvocationMock: vi.fn(),
  createServiceControllerMock: vi.fn(),
  serviceLabelForMock: vi.fn(),
  createServiceInstallLifecycleMock: vi.fn(),
  withCliLockMock: vi.fn(),
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

vi.mock("../../service/cli-binary", () => ({
  resolveServiceCliInvocation: mocks.resolveServiceCliInvocationMock,
}));

vi.mock("../../service", () => ({
  createServiceController: mocks.createServiceControllerMock,
  serviceLabelFor: mocks.serviceLabelForMock,
}));

vi.mock("../../service/install-lifecycle", () => ({
  createServiceInstallLifecycle: mocks.createServiceInstallLifecycleMock,
}));

vi.mock("../../store/cli-lock", () => ({
  withCliLock: mocks.withCliLockMock,
}));

vi.mock("../busy-check", () => ({
  assertHostNotBusy: vi.fn(async () => undefined),
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
} = mocks;

import { evaluateAutoBootstrap, maybeAutoBootstrap } from "../auto-bootstrap";
import { config } from "../../config";

function makeRuntime(overrides: Partial<RuntimeContext>): RuntimeContext {
  return {
    json: false,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: "production",
    logger: noopLogger,
    ...overrides,
  };
}

interface FakeServiceControllerState {
  state: "running" | "stopped" | "not-installed";
  installCalls: number;
  startCalls: number;
  installShouldThrow: Error | null;
}

function makeFakeServiceController(state: FakeServiceControllerState): {
  controller: {
    status: Mock;
    install: Mock;
    uninstall: Mock;
    start: Mock;
    stop: Mock;
    restart: Mock;
  };
  state: FakeServiceControllerState;
} {
  const controller = {
    status: vi.fn(async () => ({
      state: state.state,
      version: null,
      listenUrl: null,
      pid: null,
    })),
    install: vi.fn(async () => {
      state.installCalls += 1;
      if (state.installShouldThrow !== null) {
        throw state.installShouldThrow;
      }
      state.state = "running";
    }),
    uninstall: vi.fn(async () => {
      state.state = "not-installed";
    }),
    start: vi.fn(async () => {
      state.startCalls += 1;
      state.state = "running";
    }),
    stop: vi.fn(async () => {
      state.state = "stopped";
    }),
    restart: vi.fn(async () => {
      state.state = "running";
    }),
  };
  return { controller, state };
}

beforeEach(() => {
  vi.clearAllMocks();
  config.supportedHostVersion = null;
  resolveBundledHostArchiveMock.mockResolvedValue(null);
  serviceLabelForMock.mockImplementation(
    (environment: "production" | "dev") => ({
      id: environment === "dev" ? "ai.traycer.host.dev" : "ai.traycer.host",
      displayName: "Traycer Host",
      environment,
    }),
  );
  resolveServiceCliInvocationMock.mockReturnValue({
    command: "/usr/local/bin/traycer",
    args: [],
  });
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
    lifecycle: {
      beforeSwap: vi.fn(),
      afterSwap: vi.fn(),
    },
  }));
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("evaluateAutoBootstrap", () => {
  it("returns ready when host installed and service registered", async () => {
    readHostInstallRecordMock.mockReturnValue({
      version: "1.5.0",
    });
    const fake = makeFakeServiceController({
      state: "running",
      installCalls: 0,
      startCalls: 0,
      installShouldThrow: null,
    });
    createServiceControllerMock.mockReturnValue(fake.controller);

    const decision = await evaluateAutoBootstrap({
      runtime: makeRuntime({}),
      trigger: "host-status",
      onProgress: null,
    });

    expect(decision.status).toBe("ready");
    expect(decision.reason).toBe("already-installed");
    expect(decision.hostInstalled).toBe(true);
    expect(decision.serviceRegistered).toBe(true);
  });

  it("returns service-registered placeholder when host installed but service missing", async () => {
    readHostInstallRecordMock.mockReturnValue({ version: "1.5.0" });
    const fake = makeFakeServiceController({
      state: "not-installed",
      installCalls: 0,
      startCalls: 0,
      installShouldThrow: null,
    });
    createServiceControllerMock.mockReturnValue(fake.controller);

    const decision = await evaluateAutoBootstrap({
      runtime: makeRuntime({}),
      trigger: "host-status",
      onProgress: null,
    });

    expect(decision.status).toBe("service-registered");
    expect(decision.reason).toBe("service-registered");
    expect(decision.hostInstalled).toBe(true);
    expect(decision.serviceRegistered).toBe(false);
  });

  it("returns installed placeholder when neither host nor service is present", async () => {
    readHostInstallRecordMock.mockReturnValue(null);
    const fake = makeFakeServiceController({
      state: "not-installed",
      installCalls: 0,
      startCalls: 0,
      installShouldThrow: null,
    });
    createServiceControllerMock.mockReturnValue(fake.controller);

    const decision = await evaluateAutoBootstrap({
      runtime: makeRuntime({}),
      trigger: "host-status",
      onProgress: null,
    });

    expect(decision.status).toBe("installed");
    expect(decision.reason).toBe("installed");
    expect(decision.hostInstalled).toBe(false);
  });

  it("respects --no-bootstrap even when host is installed but service is missing", async () => {
    readHostInstallRecordMock.mockReturnValue({ version: "1.5.0" });
    const fake = makeFakeServiceController({
      state: "not-installed",
      installCalls: 0,
      startCalls: 0,
      installShouldThrow: null,
    });
    createServiceControllerMock.mockReturnValue(fake.controller);

    const decision = await evaluateAutoBootstrap({
      runtime: makeRuntime({ noBootstrap: true }),
      trigger: "host-status",
      onProgress: null,
    });

    expect(decision.status).toBe("skipped");
    expect(decision.reason).toBe("explicit-no-bootstrap");
  });

  it("respects TRAYCER_NONINTERACTIVE / CI when host is installed but service is missing", async () => {
    readHostInstallRecordMock.mockReturnValue({ version: "1.5.0" });
    const fake = makeFakeServiceController({
      state: "not-installed",
      installCalls: 0,
      startCalls: 0,
      installShouldThrow: null,
    });
    createServiceControllerMock.mockReturnValue(fake.controller);

    const decision = await evaluateAutoBootstrap({
      runtime: makeRuntime({ nonInteractive: true }),
      trigger: "host-status",
      onProgress: null,
    });

    expect(decision.status).toBe("skipped");
    expect(decision.reason).toBe("noninteractive-cannot-prompt");
  });
});

describe("maybeAutoBootstrap", () => {
  it("service-only recovery: installed host + missing service registers service without running installHost", async () => {
    readHostInstallRecordMock.mockReturnValue({ version: "1.5.0" });
    const fake = makeFakeServiceController({
      state: "not-installed",
      installCalls: 0,
      startCalls: 0,
      installShouldThrow: null,
    });
    createServiceControllerMock.mockReturnValue(fake.controller);

    const decision = await maybeAutoBootstrap({
      runtime: makeRuntime({}),
      trigger: "login",
      onProgress: null,
    });

    expect(installHostMock).not.toHaveBeenCalled();
    expect(fake.controller.install).toHaveBeenCalledTimes(1);
    expect(decision.status).toBe("service-registered");
    expect(decision.reason).toBe("service-registered");
    expect(decision.installedVersion).toBe("1.5.0");
    expect(decision.error).toBeNull();
  });

  it("missing host → runs the full install pipeline (installHost called)", async () => {
    readHostInstallRecordMock.mockReturnValue(null);
    const fake = makeFakeServiceController({
      state: "not-installed",
      installCalls: 0,
      startCalls: 0,
      installShouldThrow: null,
    });
    createServiceControllerMock.mockReturnValue(fake.controller);
    installHostMock.mockResolvedValue({
      record: { version: "1.5.0" },
      previous: null,
    });
    // After install, status reports running (simulate post-install state).
    fake.controller.status.mockImplementation(async () => ({
      state: "running",
      version: "1.5.0",
      listenUrl: null,
      pid: null,
    }));

    const decision = await maybeAutoBootstrap({
      runtime: makeRuntime({}),
      trigger: "login",
      onProgress: null,
    });

    expect(installHostMock).toHaveBeenCalledTimes(1);
    expect(installHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "registry", versionRequest: "latest" },
      }),
    );
    expect(decision.status).toBe("installed");
    expect(decision.reason).toBe("installed");
    expect(decision.installedVersion).toBe("1.5.0");
  });

  it("missing host → installs the configured supported host version", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockReturnValue(null);
    const fake = makeFakeServiceController({
      state: "not-installed",
      installCalls: 0,
      startCalls: 0,
      installShouldThrow: null,
    });
    createServiceControllerMock.mockReturnValue(fake.controller);
    installHostMock.mockResolvedValue({
      record: { version: "1.7.2" },
      previous: null,
    });
    fake.controller.status.mockImplementation(async () => ({
      state: "running",
      version: "1.7.2",
      listenUrl: null,
      pid: null,
    }));

    const decision = await maybeAutoBootstrap({
      runtime: makeRuntime({}),
      trigger: "login",
      onProgress: null,
    });

    expect(installHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "registry", versionRequest: "1.7.2" },
      }),
    );
    expect(decision.status).toBe("installed");
    expect(decision.installedVersion).toBe("1.7.2");
  });

  it("already ready → no-op (no installHost, no service.install)", async () => {
    readHostInstallRecordMock.mockReturnValue({ version: "1.5.0" });
    const fake = makeFakeServiceController({
      state: "running",
      installCalls: 0,
      startCalls: 0,
      installShouldThrow: null,
    });
    createServiceControllerMock.mockReturnValue(fake.controller);

    const decision = await maybeAutoBootstrap({
      runtime: makeRuntime({}),
      trigger: "host-status",
      onProgress: null,
    });

    expect(installHostMock).not.toHaveBeenCalled();
    expect(fake.controller.install).not.toHaveBeenCalled();
    expect(decision.status).toBe("ready");
    expect(decision.reason).toBe("already-installed");
  });

  it("noninteractive + service missing → skipped (no installHost, no service.install)", async () => {
    readHostInstallRecordMock.mockReturnValue({ version: "1.5.0" });
    const fake = makeFakeServiceController({
      state: "not-installed",
      installCalls: 0,
      startCalls: 0,
      installShouldThrow: null,
    });
    createServiceControllerMock.mockReturnValue(fake.controller);

    const decision = await maybeAutoBootstrap({
      runtime: makeRuntime({ nonInteractive: true }),
      trigger: "host-status",
      onProgress: null,
    });

    expect(installHostMock).not.toHaveBeenCalled();
    expect(fake.controller.install).not.toHaveBeenCalled();
    expect(decision.status).toBe("skipped");
    expect(decision.reason).toBe("noninteractive-cannot-prompt");
  });

  it("--no-bootstrap + service missing → skipped (no installHost, no service.install)", async () => {
    readHostInstallRecordMock.mockReturnValue({ version: "1.5.0" });
    const fake = makeFakeServiceController({
      state: "not-installed",
      installCalls: 0,
      startCalls: 0,
      installShouldThrow: null,
    });
    createServiceControllerMock.mockReturnValue(fake.controller);

    const decision = await maybeAutoBootstrap({
      runtime: makeRuntime({ noBootstrap: true }),
      trigger: "login",
      onProgress: null,
    });

    expect(installHostMock).not.toHaveBeenCalled();
    expect(fake.controller.install).not.toHaveBeenCalled();
    expect(decision.status).toBe("skipped");
    expect(decision.reason).toBe("explicit-no-bootstrap");
  });

  it("offline registry must not block service-only recovery (installHost is never called)", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockReturnValue({ version: "1.5.0" });
    const fake = makeFakeServiceController({
      state: "not-installed",
      installCalls: 0,
      startCalls: 0,
      installShouldThrow: null,
    });
    createServiceControllerMock.mockReturnValue(fake.controller);
    // Set up installHost to throw - if the wrong branch is taken,
    // the test will fail with an offline-style error rather than
    // succeeding with `service-registered`.
    installHostMock.mockRejectedValue(
      new Error("registry unreachable (E_REGISTRY_UNREACHABLE)"),
    );

    const decision = await maybeAutoBootstrap({
      runtime: makeRuntime({}),
      trigger: "login",
      onProgress: null,
    });

    expect(installHostMock).not.toHaveBeenCalled();
    expect(decision.status).toBe("service-registered");
    expect(decision.error).toBeNull();
  });

  it("service-only recovery surfaces failure decision on controller.install error without touching install dir", async () => {
    readHostInstallRecordMock.mockReturnValue({ version: "1.5.0" });
    const fake = makeFakeServiceController({
      state: "not-installed",
      installCalls: 0,
      startCalls: 0,
      installShouldThrow: new Error("launchctl denied"),
    });
    createServiceControllerMock.mockReturnValue(fake.controller);

    const decision = await maybeAutoBootstrap({
      runtime: makeRuntime({}),
      trigger: "login",
      onProgress: null,
    });

    expect(installHostMock).not.toHaveBeenCalled();
    expect(decision.status).toBe("failed");
    expect(decision.reason).toBe("service-registration-failed");
    expect(decision.error?.message).toContain("launchctl denied");
  });
});

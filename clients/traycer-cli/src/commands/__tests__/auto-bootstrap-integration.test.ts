import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";
import type { AutoBootstrapDecision } from "../../host/auto-bootstrap";

// Pin Core Flow 7 wiring: `traycer login` and `traycer host status`
// must call `maybeAutoBootstrap`, honour --no-bootstrap / CI /
// TRAYCER_NONINTERACTIVE skips, surface a structured `bootstrap` field on
// the command payload, and never crash the originating command when
// bootstrap fails. We mock `maybeAutoBootstrap` directly so the tests
// stay independent of the registry / install pipeline.

vi.mock("../../host/auto-bootstrap", () => {
  return {
    maybeAutoBootstrap: vi.fn(),
  };
});

vi.mock("../../auth/login-flow", () => ({
  runDeviceAuthFlow: vi.fn(),
}));

vi.mock("../../host/pid-metadata", () => ({
  readHostPidMetadata: vi.fn(),
}));

vi.mock("../../host/bootstrap-log", () => ({
  readBootstrapMarkers: vi.fn(),
  readBootstrapLogTail: vi.fn(),
}));

vi.mock("../../store/paths", () => ({
  bootstrapLogPath: vi.fn(() => "/tmp/test-bootstrap.log"),
}));

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

function makeCtx(runtime: RuntimeContext): CommandContext {
  return {
    runtime,
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

const decisionReady: AutoBootstrapDecision = {
  status: "ready",
  reason: "already-installed",
  hostInstalled: true,
  serviceRegistered: true,
  installedVersion: null,
  postSwapError: null,
  error: null,
};

const decisionInstalled: AutoBootstrapDecision = {
  status: "installed",
  reason: "installed",
  hostInstalled: true,
  serviceRegistered: true,
  installedVersion: "1.5.0",
  postSwapError: null,
  error: null,
};

const decisionSkippedNoBootstrap: AutoBootstrapDecision = {
  status: "skipped",
  reason: "explicit-no-bootstrap",
  hostInstalled: false,
  serviceRegistered: false,
  installedVersion: null,
  postSwapError: null,
  error: null,
};

const decisionFailed: AutoBootstrapDecision = {
  status: "failed",
  reason: "install-failed",
  hostInstalled: false,
  serviceRegistered: false,
  installedVersion: null,
  postSwapError: null,
  error: {
    code: "E_HOST_INSTALL_FAILED",
    message: "registry unreachable",
    details: null,
  },
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("loginCommand", () => {
  it("authenticates without provisioning the host (no auto-bootstrap)", async () => {
    const autoBootstrap = await import("../../host/auto-bootstrap");
    const loginFlow = await import("../../auth/login-flow");

    (loginFlow.runDeviceAuthFlow as Mock).mockResolvedValue({
      token: "t",
      user: { id: "u", email: "a@b", name: "A" },
      authnBaseUrl: "https://authn",
    });

    const { loginCommand } = await import("../login");
    const ctx = makeCtx(makeRuntime({}));
    const result = await loginCommand(ctx);

    // Sign-in must NOT trigger a host download/install as a side effect.
    expect(autoBootstrap.maybeAutoBootstrap).not.toHaveBeenCalled();
    expect(loginFlow.runDeviceAuthFlow).toHaveBeenCalledWith(ctx);
    const data = result.data as { bootstrap: null; user: { id: string } };
    expect(data.bootstrap).toBeNull();
    expect(data.user.id).toBe("u");
    expect(result.exitCode).toBe(0);
  });

  it("reports the signed-in user in human mode", async () => {
    const loginFlow = await import("../../auth/login-flow");

    (loginFlow.runDeviceAuthFlow as Mock).mockResolvedValue({
      token: "t",
      user: { id: "u", email: "a@b", name: "A" },
      authnBaseUrl: "https://authn",
    });

    const { loginCommand } = await import("../login");
    const ctx = makeCtx(makeRuntime({ json: false }));
    const result = await loginCommand(ctx);
    expect(result.human).toBe("Signed in as a@b.");
  });
});

describe("hostStatusCommand auto-bootstrap wiring", () => {
  it("attempts bootstrap on first run (no host installed) and surfaces the decision in the payload", async () => {
    const autoBootstrap = await import("../../host/auto-bootstrap");
    const pid = await import("../../host/pid-metadata");
    const log = await import("../../host/bootstrap-log");

    (autoBootstrap.maybeAutoBootstrap as Mock).mockResolvedValue(
      decisionInstalled,
    );
    (pid.readHostPidMetadata as Mock).mockResolvedValue(null);
    (log.readBootstrapMarkers as Mock).mockResolvedValue([]);
    (log.readBootstrapLogTail as Mock).mockResolvedValue("");

    const { hostStatusCommand } = await import("../host-status");
    const ctx = makeCtx(makeRuntime({}));
    const result = await hostStatusCommand(ctx);
    expect(autoBootstrap.maybeAutoBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "host-status" }),
    );
    const data = result.data as { bootstrap: AutoBootstrapDecision; running: boolean };
    expect(data.bootstrap.status).toBe("installed");
    expect(data.bootstrap.installedVersion).toBe("1.5.0");
  });

  it("does not bootstrap when the host is already ready", async () => {
    const autoBootstrap = await import("../../host/auto-bootstrap");
    const pid = await import("../../host/pid-metadata");
    const log = await import("../../host/bootstrap-log");

    (autoBootstrap.maybeAutoBootstrap as Mock).mockResolvedValue(
      decisionReady,
    );
    (pid.readHostPidMetadata as Mock).mockResolvedValue({
      // Use the live test-process pid so the status command's liveness
      // check (isProcessAlive) sees the host as actually running, not
      // a stale pid.json record.
      pid: process.pid,
      hostId: "d-1",
      version: "1.5.0",
      websocketUrl: "ws://127.0.0.1:7100/rpc",
      startedAt: "2026-05-15T00:00:00Z",
    });
    (log.readBootstrapMarkers as Mock).mockResolvedValue([]);
    (log.readBootstrapLogTail as Mock).mockResolvedValue("");

    const { hostStatusCommand } = await import("../host-status");
    const ctx = makeCtx(makeRuntime({}));
    const result = await hostStatusCommand(ctx);
    const data = result.data as { bootstrap: AutoBootstrapDecision; running: boolean };
    expect(data.bootstrap.status).toBe("ready");
    expect(data.running).toBe(true);
  });

  it("--no-bootstrap surfaces a structured skipped result without corrupting the rest of the payload", async () => {
    const autoBootstrap = await import("../../host/auto-bootstrap");
    const pid = await import("../../host/pid-metadata");
    const log = await import("../../host/bootstrap-log");

    (autoBootstrap.maybeAutoBootstrap as Mock).mockResolvedValue(
      decisionSkippedNoBootstrap,
    );
    (pid.readHostPidMetadata as Mock).mockResolvedValue(null);
    (log.readBootstrapMarkers as Mock).mockResolvedValue([]);
    (log.readBootstrapLogTail as Mock).mockResolvedValue("");

    const { hostStatusCommand } = await import("../host-status");
    const ctx = makeCtx(makeRuntime({ noBootstrap: true }));
    const result = await hostStatusCommand(ctx);
    const data = result.data as {
      bootstrap: AutoBootstrapDecision;
      running: boolean;
      bootstrapLogPath: string;
    };
    expect(data.bootstrap.status).toBe("skipped");
    expect(data.bootstrap.reason).toBe("explicit-no-bootstrap");
    expect(data.running).toBe(false);
    expect(data.bootstrapLogPath).toContain("bootstrap.log");
  });

  it("bootstrap failure surfaces structured error data without corrupting the rest of the payload", async () => {
    const autoBootstrap = await import("../../host/auto-bootstrap");
    const pid = await import("../../host/pid-metadata");
    const log = await import("../../host/bootstrap-log");

    (autoBootstrap.maybeAutoBootstrap as Mock).mockResolvedValue(
      decisionFailed,
    );
    (pid.readHostPidMetadata as Mock).mockResolvedValue(null);
    (log.readBootstrapMarkers as Mock).mockResolvedValue([]);
    (log.readBootstrapLogTail as Mock).mockResolvedValue("");

    const { hostStatusCommand } = await import("../host-status");
    const ctx = makeCtx(makeRuntime({}));
    const result = await hostStatusCommand(ctx);
    const data = result.data as {
      bootstrap: AutoBootstrapDecision;
      running: boolean;
    };
    expect(data.bootstrap.status).toBe("failed");
    expect(data.bootstrap.error?.code).toBe("E_HOST_INSTALL_FAILED");
    // Failed bootstrap does not flip the command into a non-zero exit -
    // the user can still read the status payload.
    expect(result.exitCode).toBe(0);
    expect(data.running).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";
import type { HostPidMetadata } from "../../host/pid-metadata";
import type { BootstrapLogEntry } from "../../host/bootstrap-log";

// CLI-001: `host status` reads state, it never provisions. This used to call
// `maybeAutoBootstrap` first, so asking a clean machine for its status could
// install a host, register an OS service, and start it - none of which the
// command's own help text ("Show host status") promised. The fix deleted
// `host/auto-bootstrap.ts` entirely and pinned the payload's `bootstrap`
// field at `null` (mirroring `commands/login.ts`, which had already dropped
// its own auto-bootstrap call for the same reason).
//
// This file replaces the deleted `auto-bootstrap-integration.test.ts`, which
// pinned the OPPOSITE contract (status triggers bootstrap). The strong
// property worth pinning now is not just "the payload looks right" but
// "status never even imports a provisioning path" - so `../../host/provision`
// and `../../service` are mocked and asserted untouched, not merely absent
// from the payload.

const mocks = vi.hoisted(() => ({
  readHostPidMetadataMock: vi.fn(),
  readBootstrapMarkersMock: vi.fn(),
  readBootstrapLogTailMock: vi.fn(),
  isProcessAliveMock: vi.fn(),
  provisionHostMock: vi.fn(),
  createServiceControllerMock: vi.fn(),
  readHostLifecycleSnapshotMock: vi.fn(),
}));

vi.mock("../../host/pid-metadata", async () => {
  // Only the read is stubbed; `publishedHostProcessGone` stays real so
  // `running` follows the (mocked) `isProcessAlive` as the command does.
  const actual = await vi.importActual<
    typeof import("../../host/pid-metadata")
  >("../../host/pid-metadata");
  return {
    ...actual,
    readHostPidMetadata: mocks.readHostPidMetadataMock,
  };
});

vi.mock("../../host/bootstrap-log", () => ({
  readBootstrapMarkers: mocks.readBootstrapMarkersMock,
  readBootstrapLogTail: mocks.readBootstrapLogTailMock,
}));

vi.mock("../../store/paths", () => ({
  bootstrapLogPath: () => "/tmp/test-bootstrap.log",
}));

// The lifecycle read probes pids and reads the real host home; only the read
// is stubbed, the row rendering stays real.
vi.mock("../../host/lifecycle-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("../../host/lifecycle-snapshot")
  >("../../host/lifecycle-snapshot");
  return {
    ...actual,
    readHostLifecycleSnapshot: mocks.readHostLifecycleSnapshotMock,
  };
});

vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return { ...actual, isProcessAlive: mocks.isProcessAliveMock };
});

// A read of host status must never import (let alone call) a provisioning
// path - this is the strong property CLI-001 asks for, not merely "the
// payload's bootstrap field is null".
vi.mock("../../host/provision", () => ({
  provisionHost: mocks.provisionHostMock,
}));

vi.mock("../../service", () => ({
  createServiceController: mocks.createServiceControllerMock,
}));

import { hostStatusCommand } from "../host-status";
import type { HostLifecycleSnapshot } from "../../host/lifecycle-snapshot";

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

const runningPidMetadata: HostPidMetadata = {
  pid: 4242,
  hostId: "host-1",
  version: "1.7.2",
  websocketUrl: "ws://127.0.0.1:9876",
  startedAt: "2026-08-01T00:00:00.000Z",
  processStartIdentity: null,
  processStartIdentityRead: "absent",
  layer0: null,
  layer0Slot: null,
};

const bootstrapMarkers: readonly BootstrapLogEntry[] = [];

const lifecycleSnapshot: HostLifecycleSnapshot = {
  policy: {
    state: "absent",
    mode: "background",
    rev: null,
    updatedAt: null,
    updatedBy: null,
    path: "/tmp/lifecycle-policy.json",
  },
  presence: {
    state: "absent",
    pid: null,
    onExit: null,
    policyRev: null,
    liveness: null,
  },
  supervisor: {
    state: "absent",
    pid: null,
    cliVersion: null,
    capabilities: [],
    liveness: null,
    enforcesLifecyclePolicy: false,
  },
  run: null,
  owner: { kind: "unknown" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readHostPidMetadataMock.mockResolvedValue(null);
  mocks.readBootstrapMarkersMock.mockResolvedValue(bootstrapMarkers);
  mocks.readBootstrapLogTailMock.mockResolvedValue("");
  mocks.isProcessAliveMock.mockReturnValue(false);
  mocks.readHostLifecycleSnapshotMock.mockResolvedValue(lifecycleSnapshot);
});

describe("hostStatusCommand - observational (CLI-001)", () => {
  it("never touches provisioning: provisionHost and createServiceController are not called", async () => {
    await hostStatusCommand(makeCtx(makeRuntime({})));

    expect(mocks.provisionHostMock).not.toHaveBeenCalled();
    expect(mocks.createServiceControllerMock).not.toHaveBeenCalled();
  });

  it("payload pins bootstrap: null and leaves the observed fields as read", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(runningPidMetadata);
    mocks.isProcessAliveMock.mockReturnValue(true);
    mocks.readBootstrapMarkersMock.mockResolvedValue(bootstrapMarkers);
    mocks.readBootstrapLogTailMock.mockResolvedValue("log tail");

    const result = await hostStatusCommand(makeCtx(makeRuntime({})));

    expect(result.data).toEqual({
      running: true,
      pidMetadata: runningPidMetadata,
      bootstrapMarkers,
      bootstrapLogPath: "/tmp/test-bootstrap.log",
      bootstrapLogTail: "log tail",
      bootstrap: null,
      lifecycle: lifecycleSnapshot,
    });
    expect(mocks.readHostLifecycleSnapshotMock).toHaveBeenCalledWith(
      "production",
      true,
    );
    expect(result.exitCode).toBe(0);
  });

  it("completes with exit 0 even when nothing is installed (pidMetadata null, not running)", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(null);
    mocks.isProcessAliveMock.mockReturnValue(false);

    const result = await hostStatusCommand(makeCtx(makeRuntime({})));

    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ running: false, bootstrap: null });
    expect(mocks.provisionHostMock).not.toHaveBeenCalled();
  });

  it("human output on the not-running branch includes the 'host ensure' hint", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(null);
    mocks.isProcessAliveMock.mockReturnValue(false);

    const result = await hostStatusCommand(makeCtx(makeRuntime({})));

    expect(result.human).toContain(
      "Run 'traycer host ensure' to install, register, and start the host.",
    );
  });

  it("human output on the running branch omits the 'host ensure' hint", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(runningPidMetadata);
    mocks.isProcessAliveMock.mockReturnValue(true);

    const result = await hostStatusCommand(makeCtx(makeRuntime({})));

    expect(result.human).not.toContain("traycer host ensure");
  });

  it("human output includes the 'Lifecycle' section", async () => {
    const result = await hostStatusCommand(makeCtx(makeRuntime({})));

    expect(result.human).toContain("Lifecycle");
    // The rows themselves, not just the heading.
    expect(result.human).toContain("Lifecycle mode");
    expect(result.human).toContain("Supervisor");
  });

  it("names a corrupt lifecycle policy file as corrupt in the Lifecycle section", async () => {
    mocks.readHostLifecycleSnapshotMock.mockResolvedValue({
      ...lifecycleSnapshot,
      policy: {
        ...lifecycleSnapshot.policy,
        state: "invalid",
        path: "/tmp/lifecycle-policy.json",
      },
    });

    const result = await hostStatusCommand(makeCtx(makeRuntime({})));

    expect(result.human).toContain("Lifecycle");
    expect(result.human).toContain("corrupt");
  });

  // O-WIN-1: a Windows requested-kill is recorded as `killed` with the
  // handle-bound kill's exit CODE and no signal (`persistChildExit`). The
  // human renderer must show that code, not silently drop it the way a bare
  // `killed` (no code, no signal) would.
  it("renders a killed marker's exit code in both the Recent activity list and the Last phase row", async () => {
    mocks.readBootstrapMarkersMock.mockResolvedValue([
      {
        timestamp: "2026-08-01T00:00:00.000Z",
        phase: "killed",
        fields: { code: "4294967295" },
        writer: "supervisor",
      },
    ] satisfies readonly BootstrapLogEntry[]);

    const result = await hostStatusCommand(makeCtx(makeRuntime({})));

    expect(result.human).toContain("Recent activity");
    expect(result.human).toContain("code=4294967295");
    // The single-row "Last phase" summary uses the parenthesized form.
    expect(result.human).toContain("killed (code=4294967295)");
  });
});

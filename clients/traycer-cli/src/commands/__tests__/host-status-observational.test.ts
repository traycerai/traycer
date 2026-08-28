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
}));

vi.mock("../../host/pid-metadata", () => ({
  readHostPidMetadata: mocks.readHostPidMetadataMock,
}));

vi.mock("../../host/bootstrap-log", () => ({
  readBootstrapMarkers: mocks.readBootstrapMarkersMock,
  readBootstrapLogTail: mocks.readBootstrapLogTailMock,
}));

vi.mock("../../store/paths", () => ({
  bootstrapLogPath: () => "/tmp/test-bootstrap.log",
}));

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
  layer0: null,
  layer0Slot: null,
};

const bootstrapMarkers: readonly BootstrapLogEntry[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readHostPidMetadataMock.mockResolvedValue(null);
  mocks.readBootstrapMarkersMock.mockResolvedValue(bootstrapMarkers);
  mocks.readBootstrapLogTailMock.mockResolvedValue("");
  mocks.isProcessAliveMock.mockReturnValue(false);
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
    });
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
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";
import type { HostPidMetadata } from "../../host/pid-metadata";
import type { BootstrapLogEntry } from "../../host/bootstrap-log";
import type {
  HostUpdateAttemptRead,
  HostUpdateAttemptRecord,
} from "@traycer-clients/shared/host-update";

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
  readUpdateAttemptRecordMock: vi.fn(),
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
  hostHomeDir: () => "/tmp/test-host-home",
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

// Only `readUpdateAttemptRecord` is stubbed - everything else (types,
// `parkedActivationMatchesInstall`, etc.) stays the real module via
// `importOriginal`, matching this file's pattern for `store/cli-lock` above.
vi.mock("@traycer-clients/shared/host-update", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@traycer-clients/shared/host-update")>();
  return { ...actual, readUpdateAttemptRecord: mocks.readUpdateAttemptRecordMock };
});

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
  processStartIdentityRead: "absent",
  layer0: null,
  layer0Slot: null,
};

const bootstrapMarkers: readonly BootstrapLogEntry[] = [];

// Mirrors `attempt-record-test-support.ts`'s `attemptRecord()` fixture -
// only the fields these tests override differ per case, everything else is
// a plain terminal-shaped default. Kept local because this file mocks the
// whole shared `host-update` read, not a real on-disk record.
function attemptRecord(
  overrides: Partial<HostUpdateAttemptRecord>,
): HostUpdateAttemptRecord {
  return {
    schemaVersion: 2,
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    trigger: "manual",
    targetVersion: "1.2.3",
    phase: "downloading",
    execution: "active",
    continuation: null,
    progress: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
    ...overrides,
  };
}

function validRead(overrides: Partial<HostUpdateAttemptRecord>): HostUpdateAttemptRead {
  return { kind: "valid", value: attemptRecord(overrides), version: 2 };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readHostPidMetadataMock.mockResolvedValue(null);
  mocks.readBootstrapMarkersMock.mockResolvedValue(bootstrapMarkers);
  mocks.readBootstrapLogTailMock.mockResolvedValue("");
  mocks.isProcessAliveMock.mockReturnValue(false);
  // No update attempt record by default - most of these tests are about the
  // pre-existing payload shape and must not gain a hidden dependency on it.
  mocks.readUpdateAttemptRecordMock.mockResolvedValue({ kind: "absent" });
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
      updateAttempt: null,
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

  // The 2026-09-27 staging outage: a parked record made `host ensure` and
  // every service command refuse, and `host status` still pointed at
  // `ensure` - the exact refusal loop the reader had no way out of. `host
  // update` is the one command that resumes a park, so the not-running hint
  // must name it, and must NOT keep naming `ensure` once a record stands.
  describe("updateAttempt", () => {
    it("a parked record while not running: payload populated, hint names 'host update' and not 'host ensure'", async () => {
      mocks.readHostPidMetadataMock.mockResolvedValue(null);
      mocks.isProcessAliveMock.mockReturnValue(false);
      mocks.readUpdateAttemptRecordMock.mockResolvedValue(
        validRead({
          attemptId: "attempt-parked",
          targetVersion: "2.0.0",
          phase: "waiting-to-activate",
          execution: "parked",
          continuation: "activate",
        }),
      );

      const result = await hostStatusCommand(makeCtx(makeRuntime({})));

      expect(result.data).toMatchObject({
        running: false,
        updateAttempt: {
          attemptId: "attempt-parked",
          targetVersion: "2.0.0",
          phase: "waiting-to-activate",
          execution: "parked",
          continuation: "activate",
        },
      });
      expect(result.human).toContain("traycer host update");
      expect(result.human).not.toContain("traycer host ensure");
    });

    it("an active record (restarting/active) while not running: 'in progress' hint names 'host update'", async () => {
      mocks.readHostPidMetadataMock.mockResolvedValue(null);
      mocks.isProcessAliveMock.mockReturnValue(false);
      mocks.readUpdateAttemptRecordMock.mockResolvedValue(
        validRead({
          attemptId: "attempt-active",
          targetVersion: "2.0.0",
          phase: "restarting",
          execution: "active",
          continuation: "activate",
        }),
      );

      const result = await hostStatusCommand(makeCtx(makeRuntime({})));

      expect(result.data).toMatchObject({
        updateAttempt: { execution: "active" },
      });
      expect(result.human).toContain("in progress");
      expect(result.human).toContain("traycer host update");
    });

    it("a terminal record while not running: updateAttempt is null, old ensure hint stays", async () => {
      mocks.readHostPidMetadataMock.mockResolvedValue(null);
      mocks.isProcessAliveMock.mockReturnValue(false);
      mocks.readUpdateAttemptRecordMock.mockResolvedValue(
        validRead({ execution: "terminal", phase: "verifying" }),
      );

      const result = await hostStatusCommand(makeCtx(makeRuntime({})));

      expect(result.data).toMatchObject({ updateAttempt: null });
      expect(result.human).toContain(
        "Run 'traycer host ensure' to install, register, and start the host.",
      );
    });

    it("an unreadable/corrupt record while not running: updateAttempt is null and status never fails", async () => {
      mocks.readHostPidMetadataMock.mockResolvedValue(null);
      mocks.isProcessAliveMock.mockReturnValue(false);
      mocks.readUpdateAttemptRecordMock.mockResolvedValue({ kind: "corrupt" });

      const result = await hostStatusCommand(makeCtx(makeRuntime({})));

      expect(result.exitCode).toBe(0);
      expect(result.data).toMatchObject({ updateAttempt: null });
      expect(result.human).toContain(
        "Run 'traycer host ensure' to install, register, and start the host.",
      );
    });

    it("running host + parked record: no hint at all, but updateAttempt is still populated", async () => {
      mocks.readHostPidMetadataMock.mockResolvedValue(runningPidMetadata);
      mocks.isProcessAliveMock.mockReturnValue(true);
      mocks.readUpdateAttemptRecordMock.mockResolvedValue(
        validRead({
          attemptId: "attempt-parked-while-running",
          targetVersion: "2.0.0",
          phase: "waiting-to-activate",
          execution: "parked",
          continuation: "activate",
        }),
      );

      const result = await hostStatusCommand(makeCtx(makeRuntime({})));

      expect(result.data).toMatchObject({
        running: true,
        updateAttempt: { execution: "parked" },
      });
      expect(result.human).not.toContain("traycer host update");
      expect(result.human).not.toContain("traycer host ensure");
    });
  });
});

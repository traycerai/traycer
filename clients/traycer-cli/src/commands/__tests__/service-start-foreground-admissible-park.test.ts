import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { HostUpdateAttemptRecord } from "@traycer-clients/shared/host-update";

// A park the start's own admission ADMITS reaches the foreground guard.
// `host service start` contends under `supervisor-relaunch-maintenance`, whose
// `supervisorRelaunchDisposition` allows a `waiting-for-work` park outright -
// the routine outcome of `parkForWork` over a busy host. Such a start proceeds
// with no foreground run (test 7) and is refused `E_HOST_NOT_SERVICE_RUN` by
// the guard, not by admission, over one (test 8). The refused-by-admission
// half is `service-start-foreground.test.ts`, tests 5-6.
//
// Red until `service-start.ts` takes that admission (review round 1): under
// `service-maintenance` admission refuses the park `E_HOST_UPDATE_ATTEMPT_ACTIVE`
// first. Kept out of the green run for that reason.
//
// Fixture: that file's - hoisted `node:os`, real `store/paths` +
// `vi.resetModules()`, a `rmSync(hostHomeDir("production"))` sweep in
// `beforeEach`, the real contender, and real supervisor/attempt records.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const mocks = vi.hoisted(() => ({
  statusMock: vi.fn(),
  startMock: vi.fn(),
  startHostServiceWithAttemptMock: vi.fn(),
  findLiveIncumbentHostMock: vi.fn(),
}));

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: () => ({
      status: (...callArgs: Parameters<typeof mocks.statusMock>) =>
        mocks.statusMock(...callArgs),
      start: (...callArgs: Parameters<typeof mocks.startMock>) =>
        mocks.startMock(...callArgs),
      hostStartAdoptionLabel: async (label: { id: string }) => label.id,
    }),
    serviceLabelFor: (environment: "dev" | "production") => ({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment,
      devSlot: null,
    }),
  };
});

vi.mock("../../host/update-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/update-mutation")>();
  return {
    ...actual,
    startHostServiceWithAttempt: (
      ...callArgs: Parameters<typeof mocks.startHostServiceWithAttemptMock>
    ) => mocks.startHostServiceWithAttemptMock(...callArgs),
  };
});

vi.mock("../../host/incumbent-check", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/incumbent-check")>();
  return {
    ...actual,
    findLiveIncumbentHost: (environment: string | undefined) =>
      mocks.findLiveIncumbentHostMock(environment),
  };
});

vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return {
    ...actual,
    withCliLock: async <T>(
      _opts: { reason: string },
      fn: (handle: {
        path: string;
        metadata: Record<string, unknown>;
        release: () => Promise<void>;
      }) => Promise<T>,
    ): Promise<T> =>
      fn({ path: "/tmp/.lock", metadata: {}, release: async () => {} }),
  };
});

import { CLI_ERROR_CODES } from "../../runner/errors";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

const LIVE_INCUMBENT_HOST = {
  pid: 55_555,
  version: "1.9.0",
  websocketUrl: "ws://127.0.0.1:55555/rpc",
};

const STOPPED_STATUS = {
  state: "stopped" as const,
  version: null,
  listenUrl: null,
  pid: null,
};

/** A REAL live foreground run: this test process's own pid and identity. */
async function writeLiveForegroundRun(): Promise<void> {
  const { ownProcessStartIdentity } =
    await import("../../store/process-identity");
  const { writeSupervisorRecords } = await import("../../host/lifecycle-files");
  await writeSupervisorRecords("production", {
    record: {
      v: 1,
      pid: process.pid,
      cliVersion: "1.9.0",
      capabilities: ["lifecycle-policy-v1"],
      startedAt: "2026-09-01T00:00:00.000Z",
    },
    runState: {
      v: 1,
      supervisorPid: process.pid,
      supervisorStartIdentity: ownProcessStartIdentity(),
      admission: "foreground",
      origin: null,
      adopted: false,
      lastPresence: null,
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  });
}

/** The ordinary parked-update shape (`parkForWork` over a busy host), which
 * `supervisor-relaunch-maintenance` admits outright. */
function admissiblePark(): HostUpdateAttemptRecord {
  return {
    schemaVersion: 2,
    attemptId: "attempt-park",
    generation: 3,
    sequence: 7,
    trigger: "manual",
    targetVersion: "1.2.3",
    phase: "waiting-for-work",
    execution: "parked",
    continuation: "resume-apply",
    progress: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
  };
}

async function writeParkedAttempt(
  record: HostUpdateAttemptRecord,
): Promise<void> {
  const { hostHomeDir } = await import("../../store/paths");
  const { updateAttemptRecordPath } =
    await import("@traycer-clients/shared/host-update");
  const path = updateAttemptRecordPath(hostHomeDir("production"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record)}\n`);
}

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
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

beforeEach(async () => {
  workHome = mkdtempSync(
    join(tmpdir(), "traycer-service-start-fg-admissible-park-test-"),
  );
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
  const { hostHomeDir } = await import("../../store/paths");
  expect(hostHomeDir("production").startsWith(workHome)).toBe(true);
  rmSync(hostHomeDir("production"), { recursive: true, force: true });
  mocks.statusMock.mockReset();
  mocks.statusMock.mockResolvedValue(STOPPED_STATUS);
  mocks.startMock.mockReset();
  mocks.startMock.mockResolvedValue(undefined);
  mocks.startHostServiceWithAttemptMock.mockReset();
  mocks.startHostServiceWithAttemptMock.mockResolvedValue({ kind: "started" });
  mocks.findLiveIncumbentHostMock.mockReset();
  mocks.findLiveIncumbentHostMock.mockResolvedValue(LIVE_INCUMBENT_HOST);
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
});

describe("buildServiceStartCommand - a park the admission admits reaches the foreground guard", () => {
  // Test 7: an admissible park with no foreground run - the start proceeds.
  it("admissible park, no foreground run: the start proceeds", async () => {
    await writeParkedAttempt(admissiblePark());
    const { readLiveSupervisorRun } =
      await import("../../host/live-supervisor-run");
    expect(await readLiveSupervisorRun("production")).toBeNull();

    const { buildServiceStartCommand } = await import("../service-start");
    const result = await buildServiceStartCommand({
      lifecycleOrigin: "desktop",
    })(fakeCtx());

    expect(mocks.startHostServiceWithAttemptMock).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
  });

  // Test 8: the same park PLUS a live foreground run. Admission admits it, so
  // the foreground guard refuses - `E_HOST_NOT_SERVICE_RUN`, no actuator call.
  it("admissible park plus a live foreground run: the foreground guard refuses E_HOST_NOT_SERVICE_RUN", async () => {
    await writeParkedAttempt(admissiblePark());
    await writeLiveForegroundRun();

    const { buildServiceStartCommand } = await import("../service-start");
    const caught: unknown = await buildServiceStartCommand({
      lifecycleOrigin: "desktop",
    })(fakeCtx()).then(
      () => null,
      (err: unknown) => err,
    );

    expect(mocks.statusMock).not.toHaveBeenCalled();
    expect(mocks.startMock).not.toHaveBeenCalled();
    expect(mocks.startHostServiceWithAttemptMock).not.toHaveBeenCalled();
    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
      details: { supervisorPid: process.pid, hostPid: LIVE_INCUMBENT_HOST.pid },
    });
  });
});

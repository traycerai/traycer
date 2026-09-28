import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { HostUpdateAttemptRecord } from "@traycer-clients/shared/host-update";

// The same ruling as
// `service-install-foreground.test.ts`, applied to `traycer host service
// start` (`../service-start.ts`). `buildServiceStartCommand` reads status and
// requests a start over ANY live host under the target service label today,
// including one a person started with `traycer host start` in a terminal (a
// "foreground run" - `../../host/foreground-host-run.ts`). The ruling: BOTH
// `lifecycleOrigin` values must refuse `E_HOST_NOT_SERVICE_RUN` over a live
// foreground run, before the status read and before
// `startHostServiceWithAttempt` - unlike the takeover guard, there is no
// `--force` escape for either origin here.
//
// `buildServiceStartCommand` has no such guard today and does not import
// `foreground-host-run.ts` at all (verified by reading `../service-start.ts`
// in full) - so the status probe and `startHostServiceWithAttempt` (mocked
// below as a spy) run unconditionally. That is the mechanism this suite's
// two RED tests prove against.
//
// HOME isolation: the same hoisted `node:os` + real `store/paths` +
// `vi.resetModules()` fixture as `service-install-foreground.test.ts` and
// `host-restart-foreground.test.ts`, with a `rmSync(hostHomeDir("production"))`
// sweep in `beforeEach` (applied from the start this time) so no test can
// inherit another test's supervisor/attempt records under the resolved home.
//
// "Live foreground run": real records via the production `writeSupervisorRecords`
// helper (`../../host/lifecycle-files.ts`), naming THIS TEST PROCESS's own
// pid and real start identity, `admission: "foreground"`, so
// `readLiveSupervisorRun` (inside `findForegroundHostRun`, left UNMOCKED)
// runs its genuine OS liveness/identity probe against a process that is
// actually alive. `findLiveIncumbentHost` (a live *host*, not a live
// *supervisor*) is mocked to report a fake reachable host.
//
// Tests 5-6 (the order pin): an update attempt the start's own admission
// refuses is refused first, by admission. The record is an ACTIVE `applying`
// attempt, which every admission this command has taken refuses:
// `service-maintenance` refuses any nonterminal record (`dispositionFor`,
// `clients/shared/host-update/contender.ts`), and
// `supervisor-relaunch-maintenance` refuses an active record whose next act is
// not to start what it placed (`supervisorRelaunchOverActive`). A refused
// disposition surfaces as the `"nonterminal-attempt"` outcome, which
// `unwrapContenderOutcome` (`../host/update-contender.ts`) turns into
// `E_HOST_UPDATE_ATTEMPT_ACTIVE` before the `withCliUpdateContender` callback,
// and so the foreground guard, runs. Test 5 pins that refusal alone; test 6
// pins that it is still that refusal, never `E_HOST_NOT_SERVICE_RUN`, when a
// live foreground run is also present. A park the admission ADMITS reaches the
// guard instead: `service-start-foreground-admissible-park.test.ts`. Neither
// test mocks `@traycer-clients/shared/host-update` - the real admission runs.

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

/** A REAL live SERVICE-managed run: same process, `admission: "granted"`. */
async function writeServiceManagedRun(): Promise<void> {
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
      admission: "granted",
      origin: "terminal",
      adopted: false,
      lastPresence: null,
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  });
}

/**
 * An ACTIVE `applying` attempt: refused by `service-maintenance`, which
 * refuses every nonterminal record, and by `supervisor-relaunch-maintenance`,
 * which admits some parks but refuses `applying` in
 * `supervisorRelaunchOverActive` before any install read. Mirrors
 * `lifecycle-teardown-park.test.ts`'s `attemptRecord()` fixture.
 */
function activeAttemptBothAdmissionsRefuse(): HostUpdateAttemptRecord {
  return {
    schemaVersion: 2,
    attemptId: "attempt-active",
    generation: 3,
    sequence: 7,
    trigger: "manual",
    targetVersion: "1.2.3",
    phase: "applying",
    execution: "active",
    continuation: "resume-apply",
    progress: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
  };
}

async function writeAttemptRecord(
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
  workHome = mkdtempSync(join(tmpdir(), "traycer-service-start-fg-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
  const { hostHomeDir } = await import("../../store/paths");
  expect(hostHomeDir("production").startsWith(workHome)).toBe(true);
  // Every test starts clean: no supervisor/attempt record survives from a
  // prior test's fixture under this resolved home.
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

describe("buildServiceStartCommand - refusal over a foreground run", () => {
  // Test 1 (RED): `lifecycleOrigin: "desktop"` over a live foreground run
  // must refuse before the status read and before `startHostServiceWithAttempt`.
  // RED on current code: no guard exists, so `controller.status` IS called
  // (and, since the default stub reports "stopped", so is
  // `startHostServiceWithAttempt`) - the mechanism assertions fail first.
  it("desktop-origin start over a live foreground run refuses E_HOST_NOT_SERVICE_RUN before the status read", async () => {
    await writeLiveForegroundRun();

    const { buildServiceStartCommand } = await import("../service-start");
    const command = buildServiceStartCommand({ lifecycleOrigin: "desktop" });
    const caught: unknown = await command(fakeCtx()).then(
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
    const message = (caught as { message: string }).message;
    expect(message).toContain(
      `host service start: the running host was started in a terminal (supervisor pid ${String(process.pid)}) and is not run by the service; stop it there with Ctrl-C`,
    );
    expect(message).not.toContain("--force");
  });

  // Test 2 (RED): the ruling gives NO `--force` escape for either origin -
  // unlike takeover, `lifecycleOrigin: "terminal"` refuses identically over
  // the same live foreground run. RED on current code for the same reason as
  // test 1: no guard exists at all today, regardless of origin.
  it("terminal-origin start over the same live foreground run refuses identically - no origin-based escape", async () => {
    await writeLiveForegroundRun();

    const { buildServiceStartCommand } = await import("../service-start");
    const command = buildServiceStartCommand({ lifecycleOrigin: "terminal" });
    const caught: unknown = await command(fakeCtx()).then(
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
    const message = (caught as { message: string }).message;
    expect(message).toContain(
      `host service start: the running host was started in a terminal (supervisor pid ${String(process.pid)}) and is not run by the service; stop it there with Ctrl-C`,
    );
    expect(message).not.toContain("--force");
  });

  // Test 3 (control, GREEN): `lifecycleOrigin: "desktop"`, no foreground run
  // present at all. Positive premise proven first, then the start proceeds
  // exactly as today. Must PASS on current (unmodified) code and remain
  // passing after the fix.
  it("(control) desktop-origin start with no foreground run present still proceeds through the actuator", async () => {
    // No writeLiveForegroundRun() / writeServiceManagedRun() call: nothing on
    // disk under this resolved home at all.
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

  // Test 4 (control, GREEN): a live SERVICE-managed run (`admission:
  // "granted"`) under the same label, with a live host - the ordinary,
  // currently-working "start an already-registered service" case. The new
  // guard must be unaffected: no refusal fires, whatever head's actual
  // decision is for a live host of that shape (the shortcut here, since
  // `findLiveIncumbentHost` reports a reachable host and `status` reports
  // "stopped" by default is irrelevant to the STATUS decision itself - what
  // this control pins is only that `E_HOST_NOT_SERVICE_RUN` never fires).
  it("(control) a live SERVICE-managed run under the label is never refused by the new guard", async () => {
    await writeServiceManagedRun();

    const { buildServiceStartCommand } = await import("../service-start");
    const caught: unknown = await buildServiceStartCommand({
      lifecycleOrigin: "desktop",
    })(fakeCtx()).then(
      () => null,
      (err: unknown) => err,
    );

    if (caught !== null) {
      expect(caught).not.toMatchObject({
        code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
      });
    }
    // Whatever head does here (idempotent shortcut or a requested start), the
    // actuator path was reached rather than refused up front.
    expect(mocks.statusMock).toHaveBeenCalled();
  });

  // Test 5 (control): an active attempt the admission refuses, no foreground
  // run at all - `E_HOST_UPDATE_ATTEMPT_ACTIVE` before `withCliUpdateContender`'s
  // callback runs. Pinned alone before test 6 adds the foreground run. The
  // record is `applying`, not a park: `supervisor-relaunch-maintenance` admits
  // a `waiting-for-work` park, so a park pins only one admission's answer.
  it("(control) an active attempt both admissions refuse blocks with E_HOST_UPDATE_ATTEMPT_ACTIVE before the callback runs, with no foreground run present", async () => {
    await writeAttemptRecord(activeAttemptBothAdmissionsRefuse());
    const { readLiveSupervisorRun } =
      await import("../../host/live-supervisor-run");
    expect(await readLiveSupervisorRun("production")).toBeNull();

    const { buildServiceStartCommand } = await import("../service-start");
    const caught: unknown = await buildServiceStartCommand({
      lifecycleOrigin: "desktop",
    })(fakeCtx()).then(
      () => null,
      (err: unknown) => err,
    );

    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE,
    });
    expect(mocks.statusMock).not.toHaveBeenCalled();
    expect(mocks.startMock).not.toHaveBeenCalled();
    expect(mocks.startHostServiceWithAttemptMock).not.toHaveBeenCalled();
  });

  // Test 6 (the order pin, green under either admission): the SAME active
  // attempt PLUS a live foreground run. Admission refuses first
  // (`E_HOST_UPDATE_ATTEMPT_ACTIVE`); the callback holding the foreground guard
  // is never reached, so `E_HOST_NOT_SERVICE_RUN` never fires.
  it("(the order pin) an active attempt both admissions refuse, over a live foreground run, still refuses E_HOST_UPDATE_ATTEMPT_ACTIVE, never E_HOST_NOT_SERVICE_RUN", async () => {
    await writeAttemptRecord(activeAttemptBothAdmissionsRefuse());
    await writeLiveForegroundRun();

    const { buildServiceStartCommand } = await import("../service-start");
    const caught: unknown = await buildServiceStartCommand({
      lifecycleOrigin: "desktop",
    })(fakeCtx()).then(
      () => null,
      (err: unknown) => err,
    );

    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE,
    });
    expect(caught).not.toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
    });
    expect(mocks.statusMock).not.toHaveBeenCalled();
    expect(mocks.startMock).not.toHaveBeenCalled();
    expect(mocks.startHostServiceWithAttemptMock).not.toHaveBeenCalled();
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";

// `host restart` and `host free-port-and-restart`
// today proceed to stop/kill/relaunch a LIVE FOREGROUND run (a `traycer host
// start` in a terminal - see `host/foreground-host-run.ts`) exactly as if it
// were the service's own host. `host stop` already refuses this
// (`refuseIfForegroundHostSurvived` in `../host-stop.ts`, exercised by
// `host-stop-foreground.test.ts`, this file's fixture template) - restart and
// free-port-and-restart have no equivalent guard yet. This is the missing
// guard, not the async/sync-spawning concern the rest of this brief covers.
//
// `HostRestartArgs` (`../host-restart.ts`) does not have a `lifecycleOrigin`
// field on current, unmodified production bytes - verified by reading the
// file. These tests are written AGAINST THE NEW SHAPE, as the fix is
// expected to add it: `vitest` here runs through esbuild transforms only
// (`vitest.config.ts` has no `test.typecheck`), so passing an extra
// `lifecycleOrigin` field on an object literal is not a compile-time error at
// test-run time - it is simply an inert extra field on current code, since
// nothing reads it yet. The RED this file proves is therefore behavioral:
// current code has no rejection at all and proceeds to call the service
// controller, not a TypeScript excess-property error.
//
// Assertion shape (a later correction, round 3): every desktop-origin case
// asserts the FIXED (post-guard) expected mechanism values FIRST - the
// controller (and, for `--if-idle`, the busy probe) must never be touched -
// and only THEN asserts the refusal code. This is what keeps these tests
// conventional red-now/green-after-the-fix tests: on head the mechanism
// assertion is the one that fails (the controller WAS called), and once the
// guard lands, that same assertion passes and the refusal assertion (already
// written against the target behavior) passes too, with nothing left to flip.
//
// HOME isolation: a per-test `mkdtempSync` HOME plus a hoisted `vi.mock
// ("node:os")` override of `homedir()` (not a partial `store/paths` mock,
// which would leave sibling path helpers reading the real `~/.traycer`) -
// copied from `host-stop-foreground.test.ts`'s own fixture, not imported
// from it (that file is off-limits to edit and this is a fresh file).
// `store/paths` captures `homedir()` once at module load, so every module
// under test is re-imported fresh via `vi.resetModules()` after the
// redirect, exactly like `host-restart.test.ts`'s own established pattern
// for this command. `beforeEach` also asserts `hostHomeDir()` itself resolves
// under this test's own temp HOME, right after the reset - a positive proof
// the redirect took, not just an absence of leaked writes.
//
// "Live foreground run": real `supervisor.json` / `supervisor-run.json`
// records naming THIS TEST PROCESS's own pid and its own start identity, so
// `readLiveSupervisorRun` (inside `findForegroundHostRun`, left UNMOCKED)
// runs its genuine OS liveness/identity probe against a process that is
// actually alive. `findLiveIncumbentHost` (a live *host*, not a live
// *supervisor*) is mocked to report a fake reachable host, per
// `host-stop-foreground.test.ts`'s own note that this is an acceptable
// substitute for a genuine reachable host.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const mocks = vi.hoisted(() => ({
  controllerCalls: [] as string[],
  findLiveIncumbentHostMock: vi.fn(),
  publishedOrigins: [] as string[],
  busyCalls: [] as Array<string | undefined>,
}));

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: () => ({
      install: async () => undefined,
      uninstall: async () => undefined,
      status: async () => ({
        state: "stopped" as const,
        version: null,
        listenUrl: null,
        pid: null,
      }),
      stop: async () => {
        mocks.controllerCalls.push("stop");
      },
      start: async () => {
        mocks.controllerCalls.push("start");
      },
      restart: async () => {
        mocks.controllerCalls.push("restart");
      },
      stopForRestart: async (
        _label: import("../../service").ServiceLabel,
        _options: import("../../service").StopServiceOptions,
      ) => {
        mocks.controllerCalls.push("stopForRestart");
        return { forcedRecycle: false };
      },
      relaunchAfterRestart: async () => {
        mocks.controllerCalls.push("relaunchAfterRestart");
      },
      hostStartAdoptionLabel: async (label: { id: string }) => label.id,
    }),
  };
});

// Same reasoning as `host-restart.test.ts`: the real
// `publishHostStartAdoption` waits (up to 30s) for a service-manager child
// that never spawns under a stubbed controller. This suite never crosses the
// real service spawn edge (the stub above never calls `atServiceSpawnEdge`),
// so this mock is a safety net rather than load-bearing for any assertion
// here.
vi.mock("../../host/host-start-adoption", () => ({
  publishHostStartAdoption: async (
    _capability: unknown,
    _contenderOptions: unknown,
    _serviceLabel: string,
    origin: string,
  ) => {
    mocks.publishedOrigins.push(origin);
    return {
      waitForSpawn: async () => undefined,
      cancel: async () => undefined,
    };
  },
}));

vi.mock("../../host/busy-check", () => ({
  assertHostNotBusy: async (environment: string | undefined) => {
    mocks.busyCalls.push(environment);
  },
}));

vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return {
    ...actual,
    withCliLock: async <T>(
      _opts: { reason: string },
      fn: () => Promise<T>,
    ): Promise<T> => fn(),
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

import { CLI_ERROR_CODES } from "../../runner/errors";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

const LIVE_INCUMBENT_HOST = {
  pid: 55_555,
  version: "1.9.0",
  websocketUrl: "ws://127.0.0.1:55555/rpc",
};

function hostRoot(): string {
  return join(workHome, ".traycer", "host");
}

function writeSupervisorRecordFile(pid: number): void {
  mkdirSync(hostRoot(), { recursive: true });
  writeFileSync(
    join(hostRoot(), "supervisor.json"),
    JSON.stringify(
      {
        v: 1,
        pid,
        cliVersion: "1.9.0",
        capabilities: ["lifecycle-policy-v1"],
        startedAt: "2026-09-01T00:00:00.000Z",
      },
      null,
      2,
    ),
    "utf8",
  );
}

function writeSupervisorRunStateFile(input: {
  readonly supervisorPid: number;
  readonly supervisorStartIdentity: string | null;
}): void {
  mkdirSync(hostRoot(), { recursive: true });
  writeFileSync(
    join(hostRoot(), "supervisor-run.json"),
    JSON.stringify(
      {
        v: 1,
        supervisorPid: input.supervisorPid,
        supervisorStartIdentity: input.supervisorStartIdentity,
        admission: "foreground",
        origin: null,
        adopted: false,
        lastPresence: null,
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
      null,
      2,
    ),
    "utf8",
  );
}

/** A REAL live foreground run: this test process's own pid and identity. */
async function writeLiveForegroundRun(): Promise<void> {
  const { ownProcessStartIdentity } =
    await import("../../store/process-identity");
  writeSupervisorRecordFile(process.pid);
  writeSupervisorRunStateFile({
    supervisorPid: process.pid,
    supervisorStartIdentity: ownProcessStartIdentity(),
  });
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
  workHome = mkdtempSync(join(tmpdir(), "traycer-host-restart-fg-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
  const { hostHomeDir } = await import("../../store/paths");
  expect(hostHomeDir("production").startsWith(workHome)).toBe(true);
  mocks.controllerCalls = [];
  mocks.findLiveIncumbentHostMock.mockReset();
  mocks.findLiveIncumbentHostMock.mockResolvedValue(LIVE_INCUMBENT_HOST);
  mocks.publishedOrigins = [];
  mocks.busyCalls = [];
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

describe("host restart - foreground-run guard", () => {
  // A plain `host restart` carrying
  // `lifecycleOrigin: "desktop"` over a live foreground run must reject
  // E_HOST_NOT_SERVICE_RUN before touching the controller at all. RED on
  // current (unmodified) code: `HostRestartArgs` has no `lifecycleOrigin`
  // field, so the guard does not exist, and the command proceeds to
  // `stopForRestart` + `relaunchAfterRestart` instead of leaving
  // `controllerCalls` empty - that mechanism assertion is what fails first.
  it("rejects E_HOST_NOT_SERVICE_RUN over a live foreground run with lifecycleOrigin 'desktop', never touching the controller", async () => {
    await writeLiveForegroundRun();

    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({
      ifIdle: false,
      force: false,
      deferIfParked: false,
      lifecycleOrigin: "desktop",
    } as Parameters<typeof buildHostRestartCommand>[0]);
    const caught: unknown = await command(fakeCtx()).then(
      () => null,
      (err: unknown) => err,
    );

    expect(mocks.controllerCalls).toEqual([]);
    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
    });
  });

  // `--force` must NOT bypass the guard - unlike
  // `host stop --force` (which legitimately kills a terminal-owned host
  // directly), `host restart --force` only widens the busy gate on the
  // SERVICE's stop/relaunch cycle; it has no meaning against a host the
  // service never started. RED on current code: `--force` has no interaction
  // with any foreground check today (none exists), so the controller is
  // still called.
  it("--force does not bypass the guard over the same live foreground run", async () => {
    await writeLiveForegroundRun();

    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({
      ifIdle: false,
      force: true,
      deferIfParked: false,
      lifecycleOrigin: "desktop",
    } as Parameters<typeof buildHostRestartCommand>[0]);
    const caught: unknown = await command(fakeCtx()).then(
      () => null,
      (err: unknown) => err,
    );

    expect(mocks.controllerCalls).toEqual([]);
    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
    });
  });

  // `--if-idle` with
  // `lifecycleOrigin: "desktop"` over the same live foreground run. The
  // refusal must come BEFORE the busy probe ever runs - a foreground run is
  // not the service's host, so probing whether IT is busy is meaningless,
  // and the busy probe touches the host over its RPC endpoint, which is
  // exactly the kind of contact with a terminal-owned host this guard exists
  // to prevent. RED on current code: no guard exists, so `--if-idle` runs
  // its busy probe and then proceeds to the controller as usual.
  it("--if-idle refuses before the busy probe ever runs, over the same live foreground run", async () => {
    await writeLiveForegroundRun();

    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({
      ifIdle: true,
      force: false,
      deferIfParked: false,
      lifecycleOrigin: "desktop",
    } as Parameters<typeof buildHostRestartCommand>[0]);
    const caught: unknown = await command(fakeCtx()).then(
      () => null,
      (err: unknown) => err,
    );

    expect(mocks.busyCalls).toEqual([]);
    expect(mocks.controllerCalls).toEqual([]);
    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
    });
  });

  // With no `lifecycleOrigin` field at all (today's
  // only reachable shape - `terminal` is not yet a meaningful distinct code
  // path since the field doesn't exist on current `HostRestartArgs`), the
  // same live foreground run is untouched by any guard and the command
  // reaches the controller and restarts, exactly as it does today. This must
  // PASS on current code, proving the fixture itself (live foreground run +
  // mocked incumbent host) is not what makes the desktop-origin tests fail.
  it("(control) with lifecycleOrigin 'terminal', the same live foreground run still restarts via the controller today", async () => {
    await writeLiveForegroundRun();

    const { buildHostRestartCommand } = await import("../host-restart");
    const result = await buildHostRestartCommand({
      ifIdle: false,
      force: false,
      deferIfParked: false,
      lifecycleOrigin: "terminal",
    })(fakeCtx());

    expect(result.data).toMatchObject({ restarted: true });
    expect(mocks.controllerCalls).toEqual([
      "stopForRestart",
      "relaunchAfterRestart",
    ]);
  });

  // A later correction (round 4): a `--force` restart with lifecycleOrigin
  // 'terminal' is the legitimate use of force - a terminal-owned host is
  // NOT what force is meant to reach here (that is the whole point of
  // tests 1/2 above), but a `terminal`-origin restart over a run that is
  // in fact the SERVICE's own (this fixture) must still force-restart
  // normally, exactly like the plain terminal control above.
  it("(control) --force with lifecycleOrigin 'terminal' still reaches the controller normally", async () => {
    await writeLiveForegroundRun();

    const { buildHostRestartCommand } = await import("../host-restart");
    const result = await buildHostRestartCommand({
      ifIdle: false,
      force: true,
      deferIfParked: false,
      lifecycleOrigin: "terminal",
    })(fakeCtx());

    expect(result.data).toMatchObject({ restarted: true });
    expect(mocks.controllerCalls).toEqual([
      "stopForRestart",
      "relaunchAfterRestart",
    ]);
  });
});

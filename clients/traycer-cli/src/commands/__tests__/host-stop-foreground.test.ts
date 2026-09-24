import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";

// OBS-HOST-STOP-FOREGROUND: a plain or `--if-idle` `host stop` asks the
// SERVICE manager, and a host started by `traycer host start` in a terminal
// (a `foreground` supervisor run) is not the service's - the service stop
// reaches nothing and the command used to report success while that host ran
// on. `refuseIfForegroundHostSurvived` (`../host-stop.ts`) checks this AFTER
// the service stop, inside the same lock: it withdraws the stop intent the
// stop just announced (a foreground supervisor must not read it and refuse to
// relaunch its own crashed child), then rejects `E_HOST_NOT_SERVICE_RUN`.
// `--force` skips this refusal outright - that host is the terminal's, and
// force means "kill it directly", which reaches it just fine.
//
// The "live foreground run" fixture writes REAL `supervisor.json` /
// `supervisor-run.json` records naming this test PROCESS's own pid and its
// own start identity (`ownProcessStartIdentity()`), so `readLiveSupervisorRun`
// runs its genuine OS liveness/identity probe against a process that is
// actually alive - no mocking of process identity. `findLiveIncumbentHost`
// (a live *host*, not a live *supervisor*) is mocked, per the finding's own
// note that this is an acceptable substitute for a genuine reachable host.
//
// HOME is redirected to a fresh temp dir per test (the `os.homedir()` mock +
// env mutation + `vi.resetModules()` pattern from `host-stop-lock.test.ts` /
// `lifecycle-snapshot.test.ts`): `store/paths` captures `homedir()` at module
// load, and every module under test must be re-imported fresh, after the
// redirect, or its lifecycle records would land in this machine's REAL
// `~/.traycer/host` - exactly the incident `host-stop-lock.test.ts`'s header
// warns about.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const mocks = vi.hoisted(() => ({
  controllerCalls: [] as string[],
  findLiveIncumbentHostMock: vi.fn(),
  assertIdleMock: vi.fn(),
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
    }),
  };
});

vi.mock("../../host/busy-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../host/busy-check")>();
  return {
    ...actual,
    assertHostIdleForStop: (environment: string) =>
      mocks.assertIdleMock(environment),
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

import {
  ownProcessStartIdentity,
  isProcessAlive,
} from "../../store/process-identity";
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

function stopIntentPath(): string {
  return join(hostRoot(), "stop-intent.json");
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

interface RunStateInput {
  readonly supervisorPid: number;
  readonly supervisorStartIdentity: string | null;
  readonly admission: "granted" | "unattended" | "foreground";
}

function writeSupervisorRunStateFile(input: RunStateInput): void {
  mkdirSync(hostRoot(), { recursive: true });
  writeFileSync(
    join(hostRoot(), "supervisor-run.json"),
    JSON.stringify(
      {
        v: 1,
        supervisorPid: input.supervisorPid,
        supervisorStartIdentity: input.supervisorStartIdentity,
        admission: input.admission,
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
function writeLiveForegroundRun(): void {
  writeSupervisorRecordFile(process.pid);
  writeSupervisorRunStateFile({
    supervisorPid: process.pid,
    supervisorStartIdentity: ownProcessStartIdentity(),
    admission: "foreground",
  });
}

/**
 * A well-formed creation stamp of THIS platform that no process actually
 * has - the only way to model a recycled pid from inside one process. Copied
 * from `doctor/__tests__/update-marker-lock.test.ts`'s `foreignStamp()`.
 */
function foreignStartIdentity(): string {
  const own = ownProcessStartIdentity();
  if (own === null) {
    throw new Error(
      "test fixture: ownProcessStartIdentity() was null on this platform",
    );
  }
  return `${own.slice(0, own.indexOf(":"))}:not the real supervisor 1`;
}

/** A genuinely dead pid: spawn a child and wait for it to exit and reap. */
function findDeadPid(): number {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = spawnSync(process.execPath, ["-e", "0"]);
    if (result.pid !== undefined && !isProcessAlive(result.pid)) {
      return result.pid;
    }
  }
  throw new Error("test fixture: could not obtain a dead pid");
}

/** Simulates the stop intent `withStopIntent` announces before a real stop. */
function writeStopIntentFile(): void {
  mkdirSync(hostRoot(), { recursive: true });
  writeFileSync(
    stopIntentPath(),
    JSON.stringify({
      v: 1,
      requestedAt: new Date().toISOString(),
      requestedByPid: process.pid,
      reason: "stop",
    }),
    "utf8",
  );
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

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-host-stop-foreground-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
  mocks.controllerCalls = [];
  mocks.findLiveIncumbentHostMock.mockReset();
  mocks.findLiveIncumbentHostMock.mockResolvedValue(null);
  mocks.assertIdleMock.mockReset();
  mocks.assertIdleMock.mockResolvedValue(undefined);
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

describe("host stop - foreground-run refusal (OBS-HOST-STOP-FOREGROUND)", () => {
  it("a plain stop rejects E_HOST_NOT_SERVICE_RUN over a live foreground run, naming the supervisor and host pids", async () => {
    writeLiveForegroundRun();
    mocks.findLiveIncumbentHostMock.mockResolvedValue(LIVE_INCUMBENT_HOST);

    const { buildHostStopCommand } = await import("../host-stop");
    await expect(
      buildHostStopCommand({ force: false, ifIdle: false })(fakeCtx()),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
      exitCode: 1,
      message: `host stop: the running host was started in a terminal (supervisor pid ${String(process.pid)}) and is not run by the service; stop it there with Ctrl-C, or pass --force`,
      details: { supervisorPid: process.pid, hostPid: LIVE_INCUMBENT_HOST.pid },
    });
    // The service WAS asked to stop first - the refusal is not a short-circuit.
    expect(mocks.controllerCalls).toEqual(["stop"]);
  });

  it("--if-idle over the same live foreground run rejects E_HOST_NOT_SERVICE_RUN too", async () => {
    writeLiveForegroundRun();
    mocks.findLiveIncumbentHostMock.mockResolvedValue(LIVE_INCUMBENT_HOST);

    const { buildHostStopCommand } = await import("../host-stop");
    await expect(
      buildHostStopCommand({ force: false, ifIdle: true })(fakeCtx()),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
      details: { supervisorPid: process.pid, hostPid: LIVE_INCUMBENT_HOST.pid },
    });
    expect(mocks.assertIdleMock).toHaveBeenCalledWith("production");
    expect(mocks.controllerCalls).toEqual(["stop"]);
  });

  it("clears the stop intent the stop announced, once the foreground refusal fires", async () => {
    writeLiveForegroundRun();
    mocks.findLiveIncumbentHostMock.mockResolvedValue(LIVE_INCUMBENT_HOST);
    writeStopIntentFile();
    expect(existsSync(stopIntentPath())).toBe(true);

    const { buildHostStopCommand } = await import("../host-stop");
    await expect(
      buildHostStopCommand({ force: false, ifIdle: false })(fakeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN });

    expect(existsSync(stopIntentPath())).toBe(false);
  });

  it("--force is never refused, even over the same live foreground run", async () => {
    writeLiveForegroundRun();
    mocks.findLiveIncumbentHostMock.mockResolvedValue(LIVE_INCUMBENT_HOST);

    const { buildHostStopCommand } = await import("../host-stop");
    const result = await buildHostStopCommand({ force: true, ifIdle: false })(
      fakeCtx(),
    );
    expect(result.data).toMatchObject({ stopped: true, forced: true });
    expect(mocks.controllerCalls).toEqual(["stop"]);
    // The refusal is skipped outright for --force: the foreground check never
    // even runs, so the incumbent host is never consulted.
    expect(mocks.findLiveIncumbentHostMock).not.toHaveBeenCalled();
  });

  describe("controls: no refusal, and any stop intent is left exactly as the stop wrote it", () => {
    it("a live SERVICE run (admission granted) does not refuse", async () => {
      writeSupervisorRecordFile(process.pid);
      writeSupervisorRunStateFile({
        supervisorPid: process.pid,
        supervisorStartIdentity: ownProcessStartIdentity(),
        admission: "granted",
      });
      mocks.findLiveIncumbentHostMock.mockResolvedValue(LIVE_INCUMBENT_HOST);
      writeStopIntentFile();

      const { buildHostStopCommand } = await import("../host-stop");
      const result = await buildHostStopCommand({
        force: false,
        ifIdle: false,
      })(fakeCtx());

      expect(result.data).toMatchObject({ stopped: true, forced: false });
      expect(existsSync(stopIntentPath())).toBe(true);
    });

    it("a foreground record naming a dead supervisor pid does not refuse", async () => {
      const deadPid = findDeadPid();
      writeSupervisorRecordFile(deadPid);
      writeSupervisorRunStateFile({
        supervisorPid: deadPid,
        supervisorStartIdentity: null,
        admission: "foreground",
      });
      mocks.findLiveIncumbentHostMock.mockResolvedValue(LIVE_INCUMBENT_HOST);
      writeStopIntentFile();

      const { buildHostStopCommand } = await import("../host-stop");
      const result = await buildHostStopCommand({
        force: false,
        ifIdle: false,
      })(fakeCtx());

      expect(result.data).toMatchObject({ stopped: true, forced: false });
      expect(existsSync(stopIntentPath())).toBe(true);
    });

    it("a foreground record whose identity does not match the live process does not refuse", async () => {
      writeSupervisorRecordFile(process.pid);
      writeSupervisorRunStateFile({
        supervisorPid: process.pid,
        supervisorStartIdentity: foreignStartIdentity(),
        admission: "foreground",
      });
      mocks.findLiveIncumbentHostMock.mockResolvedValue(LIVE_INCUMBENT_HOST);
      writeStopIntentFile();

      const { buildHostStopCommand } = await import("../host-stop");
      const result = await buildHostStopCommand({
        force: false,
        ifIdle: false,
      })(fakeCtx());

      expect(result.data).toMatchObject({ stopped: true, forced: false });
      expect(existsSync(stopIntentPath())).toBe(true);
    });

    it("a live foreground supervisor with no live host does not refuse", async () => {
      writeLiveForegroundRun();
      mocks.findLiveIncumbentHostMock.mockResolvedValue(null);
      writeStopIntentFile();

      const { buildHostStopCommand } = await import("../host-stop");
      const result = await buildHostStopCommand({
        force: false,
        ifIdle: false,
      })(fakeCtx());

      expect(result.data).toMatchObject({ stopped: true, forced: false });
      expect(existsSync(stopIntentPath())).toBe(true);
    });

    it("no supervisor records at all does not refuse", async () => {
      mocks.findLiveIncumbentHostMock.mockResolvedValue(LIVE_INCUMBENT_HOST);
      writeStopIntentFile();

      const { buildHostStopCommand } = await import("../host-stop");
      const result = await buildHostStopCommand({
        force: false,
        ifIdle: false,
      })(fakeCtx());

      expect(result.data).toMatchObject({ stopped: true, forced: false });
      expect(existsSync(stopIntentPath())).toBe(true);
    });
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
// Type-only, erased before `vi.hoisted` runs - annotating the fixture with
// the PRODUCER's contract, matching `host-free-port-and-restart.test.ts`'s
// own pattern for this exact mock.
import type { KillConflictingPortOwnerResult } from "../../host/free-port-kill";

// `host free-port-and-restart`'s sibling guard to
// `host-restart-foreground.test.ts` - see that file's header for the full
// rationale (missing foreground-run guard, HOME isolation approach, and why
// an extra `lifecycleOrigin` field is a behavioral, not a compile-time, red
// here since `vitest.config.ts` never enables `test.typecheck`).
//
// `HostFreePortAndRestartArgs` (`../host-free-port-and-restart.ts`) does not
// have a `lifecycleOrigin` field on current, unmodified production bytes -
// verified by reading the file.
//
// The `--pid` kill path this command drives is `killConflictingPortOwner`
// (`../../host/free-port-kill.ts`), mocked below exactly as
// `host-free-port-and-restart.test.ts` already does, so the mechanism
// assertions below are real assertions against the actual production wiring
// rather than a stand-in.
//
// Assertion shape (a later correction, round 3): every desktop-origin case
// asserts the FIXED (post-guard) expected mechanism values FIRST - the kill
// path and the controller must never be touched - and only THEN asserts the
// refusal code. This is what keeps these tests conventional red-now/
// green-after-the-fix tests: on head the mechanism assertion is the one that
// fails (the kill/restart WAS reached), and once the guard lands, that same
// assertion passes and the refusal assertion (already written against the
// target behavior) passes too, with nothing left to flip.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const mocks = vi.hoisted(() => ({
  controllerCalls: [] as string[],
  killCalls: [] as Array<{ pid: number; port: number; commandName: string }>,
  findLiveIncumbentHostMock: vi.fn(),
  publishedOrigins: [] as string[],
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
      hostStartAdoptionLabel: async (label: { id: string }) => label.id,
    }),
  };
});

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

vi.mock("../../host/free-port-kill", () => ({
  killConflictingPortOwner: async (opts: {
    pid: number;
    port: number;
    commandName: string;
    verifyMutationCapability: () => Promise<void>;
  }) => {
    mocks.killCalls.push({
      pid: opts.pid,
      port: opts.port,
      commandName: opts.commandName,
    });
    await opts.verifyMutationCapability();
    return {
      killed: true,
      killError: null,
      release: "released",
      releaseDetail: "port has no listener",
      holderPid: null,
    } as KillConflictingPortOwnerResult;
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

// A clearly-fake pid outside any real process range - it must never actually
// be signalled, whichever way this test resolves.
const FAKE_PID = 999_999_999;

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
  workHome = mkdtempSync(
    join(tmpdir(), "traycer-host-free-port-and-restart-fg-test-"),
  );
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
  const { hostHomeDir } = await import("../../store/paths");
  expect(hostHomeDir("production").startsWith(workHome)).toBe(true);
  mocks.controllerCalls = [];
  mocks.killCalls = [];
  mocks.findLiveIncumbentHostMock.mockReset();
  mocks.findLiveIncumbentHostMock.mockResolvedValue(LIVE_INCUMBENT_HOST);
  mocks.publishedOrigins = [];
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

describe("host free-port-and-restart - foreground-run guard", () => {
  // `host free-port-and-restart` carrying
  // `lifecycleOrigin: "desktop"` over a live foreground run must reject
  // E_HOST_NOT_SERVICE_RUN, never signalling the (fake) pid and never
  // restarting.
  //
  // A VALID pid+port pair (`port: 45_678`) is used (rather than pairing the
  // fake pid with `port: null`) so the command's PRE-EXISTING
  // `--pid requires --port` argument-shape validation
  // (`(args.pid === null) !== (args.port === null)`) does not intercept
  // first - this exercises the guard's actual intended mechanism, the kill
  // path, rather than a different, already-existing validation error.
  it("rejects E_HOST_NOT_SERVICE_RUN over a live foreground run with lifecycleOrigin 'desktop' and a valid pid+port, never signalling the pid or restarting", async () => {
    await writeLiveForegroundRun();

    const { buildHostFreePortAndRestartCommand } =
      await import("../host-free-port-and-restart");
    const command = buildHostFreePortAndRestartCommand({
      pid: FAKE_PID,
      port: 45_678,
      deferIfParked: true,
      lifecycleOrigin: "desktop",
    } as Parameters<typeof buildHostFreePortAndRestartCommand>[0]);
    const caught: unknown = await command(fakeCtx()).then(
      () => null,
      (err: unknown) => err,
    );

    expect(mocks.killCalls).toEqual([]);
    expect(mocks.controllerCalls).toEqual([]);
    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
    });
  });

  // The PLAIN free-port-and-restart form (no
  // `--pid`/`--port` at all, so the argument-shape validation never fires
  // either way) with `lifecycleOrigin: "desktop"` over the same live
  // foreground run.
  it("rejects E_HOST_NOT_SERVICE_RUN over a live foreground run with lifecycleOrigin 'desktop' and no --pid/--port, never restarting", async () => {
    await writeLiveForegroundRun();

    const { buildHostFreePortAndRestartCommand } =
      await import("../host-free-port-and-restart");
    const command = buildHostFreePortAndRestartCommand({
      pid: null,
      port: null,
      deferIfParked: true,
      lifecycleOrigin: "desktop",
    } as Parameters<typeof buildHostFreePortAndRestartCommand>[0]);
    const caught: unknown = await command(fakeCtx()).then(
      () => null,
      (err: unknown) => err,
    );

    expect(mocks.killCalls).toEqual([]);
    expect(mocks.controllerCalls).toEqual([]);
    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
    });
  });

  // With no `lifecycleOrigin` field at all (the
  // only reachable shape on current `HostFreePortAndRestartArgs`), a bare
  // free-port-and-restart (no `--pid`/`--port`, so the argument-shape
  // validation above never fires) over the same live foreground run still
  // reaches the controller and restarts today. This must PASS on current
  // code, proving the live-foreground fixture itself is not what fails tests
  // that DO assert a rejection.
  it("(control) with lifecycleOrigin 'terminal' and no --pid/--port, the same live foreground run still restarts via the controller today", async () => {
    await writeLiveForegroundRun();

    const { buildHostFreePortAndRestartCommand } =
      await import("../host-free-port-and-restart");
    const result = await buildHostFreePortAndRestartCommand({
      pid: null,
      port: null,
      deferIfParked: true,
      lifecycleOrigin: "terminal",
    })(fakeCtx());

    expect(mocks.killCalls).toEqual([]);
    expect(mocks.controllerCalls).toEqual(["restart"]);
    expect(result.data).toMatchObject({ restartedLabel: "ai.traycer.host" });
  });
});

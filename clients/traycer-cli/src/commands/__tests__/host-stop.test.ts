import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandFn } from "../../runner/runner";
import type { HostStopArgs } from "../host-stop";

// `host stop`'s command-level wiring (Host Update Layer Redesign Tech
// Plan, "Lifecycle lock coverage"): the stop call runs inside one
// `cli-lock` acquisition.
//
// HOME is redirected to a fresh temp dir per test (the `os.homedir()` mock +
// env mutation + `vi.resetModules()` pattern of `host-stop-foreground.test.ts`
// and `host-stop-lock.test.ts`). A non-force stop reads the supervisor records
// for a foreground run and, finding one, deletes `stop-intent.json`:
// `store/paths` captures `homedir()` at module load, so without this every
// case here would read, and could delete, this machine's REAL `~/.traycer/host`.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const mocks = vi.hoisted(() => ({
  controllerCalls: [] as string[],
  lockCalls: [] as Array<{ reason: string }>,
  assertIdle: vi.fn(),
}));

vi.mock("../../host/busy-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../host/busy-check")>();
  return {
    ...actual,
    assertHostIdleForStop: (environment: string) => {
      mocks.controllerCalls.push("probe");
      return mocks.assertIdle(environment);
    },
  };
});

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

vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return {
    ...actual,
    withCliLock: async <T>(
      opts: { reason: string },
      fn: () => Promise<T>,
    ): Promise<T> => {
      mocks.lockCalls.push({ reason: opts.reason });
      return fn();
    },
  };
});

import { CLI_ERROR_CODES, cliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

beforeEach(async () => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-host-stop-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
  // Proves the redirect before any case can touch a host file.
  const { hostHomeDir } = await import("../../store/paths");
  expect(hostHomeDir("production").startsWith(workHome)).toBe(true);
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
  osHome.current = "";
  rmSync(workHome, { recursive: true, force: true });
});

// Imported fresh per test, after the redirect: a module loaded before it
// would have bound its paths to the real home.
async function buildHostStopCommand(args: HostStopArgs): Promise<CommandFn> {
  const { buildHostStopCommand: build } = await import("../host-stop");
  return build(args);
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

describe("buildHostStopCommand", () => {
  it("stops inside one cli-lock acquisition", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];

    const stop = await buildHostStopCommand({
      force: false,
      ifIdle: false,
      lifecycleOrigin: "terminal",
    });
    const result = await stop(fakeCtx());

    expect(mocks.lockCalls).toEqual([{ reason: "host-stop" }]);
    expect(mocks.controllerCalls).toEqual(["stop"]);
    expect(result.data).toMatchObject({ stopped: true });
  });

  it("--if-idle with --force is refused before the lock is taken", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    const stop = await buildHostStopCommand({
      force: true,
      ifIdle: true,
      lifecycleOrigin: "terminal",
    });
    await expect(stop(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
    });
    expect(mocks.lockCalls).toEqual([]);
    expect(mocks.controllerCalls).toEqual([]);
  });

  it("--if-idle on an idle host probes, then stops, inside the lock", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    mocks.assertIdle.mockReset();
    mocks.assertIdle.mockResolvedValue(undefined);
    const stop = await buildHostStopCommand({
      force: false,
      ifIdle: true,
      lifecycleOrigin: "terminal",
    });
    const result = await stop(fakeCtx());
    expect(mocks.lockCalls).toEqual([{ reason: "host-stop" }]);
    expect(mocks.controllerCalls).toEqual(["probe", "stop"]);
    expect(mocks.assertIdle).toHaveBeenCalledWith("production");
    expect(result.data).toMatchObject({ stopped: true });
  });

  it("--if-idle on a busy host rejects E_HOST_BUSY after taking the lock, and never stops", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    mocks.assertIdle.mockReset();
    mocks.assertIdle.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "busy",
        details: null,
        exitCode: 1,
      }),
    );
    const stop = await buildHostStopCommand({
      force: false,
      ifIdle: true,
      lifecycleOrigin: "terminal",
    });
    await expect(stop(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
    expect(mocks.lockCalls).toEqual([{ reason: "host-stop" }]);
    expect(mocks.controllerCalls).toEqual(["probe"]);
  });

  it("a plain stop never probes", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    const stop = await buildHostStopCommand({
      force: false,
      ifIdle: false,
      lifecycleOrigin: "terminal",
    });
    await stop(fakeCtx());
    expect(mocks.controllerCalls).toEqual(["stop"]);
  });
});

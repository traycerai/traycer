import { describe, expect, it, vi } from "vitest";

// `host stop`'s command-level wiring (Host Update Layer Redesign Tech
// Plan, "Lifecycle lock coverage"): the stop call runs inside one
// `cli-lock` acquisition.

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

import { buildHostStopCommand } from "../host-stop";
import { CLI_ERROR_CODES, cliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";

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

    const result = await buildHostStopCommand({ force: false, ifIdle: false })(
      fakeCtx(),
    );

    expect(mocks.lockCalls).toEqual([{ reason: "host-stop" }]);
    expect(mocks.controllerCalls).toEqual(["stop"]);
    expect(result.data).toMatchObject({ stopped: true });
  });

  it("--if-idle with --force is refused before the lock is taken", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    await expect(
      buildHostStopCommand({ force: true, ifIdle: true })(fakeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });
    expect(mocks.lockCalls).toEqual([]);
    expect(mocks.controllerCalls).toEqual([]);
  });

  it("--if-idle on an idle host probes, then stops, inside the lock", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    mocks.assertIdle.mockReset();
    mocks.assertIdle.mockResolvedValue(undefined);
    const result = await buildHostStopCommand({ force: false, ifIdle: true })(
      fakeCtx(),
    );
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
    await expect(
      buildHostStopCommand({ force: false, ifIdle: true })(fakeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });
    expect(mocks.lockCalls).toEqual([{ reason: "host-stop" }]);
    expect(mocks.controllerCalls).toEqual(["probe"]);
  });

  it("a plain stop never probes", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    await buildHostStopCommand({ force: false, ifIdle: false })(fakeCtx());
    expect(mocks.controllerCalls).toEqual(["stop"]);
  });
});

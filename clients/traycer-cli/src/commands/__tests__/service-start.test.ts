import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `traycer host service start` - the public background start, and the
// counterpart to `host stop`. See `../service-start.ts`'s module doc for why
// it exists as its own command rather than a mode of `host start`.

const mocks = vi.hoisted(() => ({
  controllerCalls: [] as string[],
  lockCalls: [] as Array<{ reason: string }>,
  statusResponses: [] as Array<{
    state: "running" | "stopped" | "not-installed" | "externally-managed";
    version: string | null;
    listenUrl: string | null;
    pid: number | null;
  }>,
}));

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    serviceLabelFor: () => ({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment: "production",
      devSlot: null,
    }),
    createServiceController: () => ({
      status: async () => {
        const next = mocks.statusResponses.shift();
        if (next === undefined) {
          throw new Error("test status queue exhausted");
        }
        return next;
      },
      start: async () => {
        mocks.controllerCalls.push("start");
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

import { serviceStartCommand } from "../service-start";
import type { CommandContext } from "../../runner/runner";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";

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

describe("serviceStartCommand", () => {
  beforeEach(() => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    mocks.statusResponses = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("refuses with E_SERVICE_CONTROL_FAILED and names 'traycer host service install' when nothing is registered, without calling controller.start", async () => {
    mocks.statusResponses = [
      { state: "not-installed", version: null, listenUrl: null, pid: null },
    ];

    let thrown: unknown = null;
    try {
      await serviceStartCommand(fakeCtx());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CliError);
    const err = thrown as CliError;
    expect(err.code).toBe(CLI_ERROR_CODES.SERVICE_CONTROL_FAILED);
    expect(err.message).toContain("traycer host service install");
    expect(mocks.controllerCalls).not.toContain("start");
  });

  it("starts and reports alreadyRunning: false plus the post-start pid when the service was stopped", async () => {
    mocks.statusResponses = [
      { state: "stopped", version: null, listenUrl: null, pid: null },
      {
        state: "running",
        version: "1.2.3",
        listenUrl: "ws://127.0.0.1:58036/rpc",
        pid: 4242,
      },
    ];

    const result = await serviceStartCommand(fakeCtx());

    expect(mocks.controllerCalls).toEqual(["start"]);
    expect(result.data).toMatchObject({
      priorState: "stopped",
      state: "running",
      pid: 4242,
      alreadyRunning: false,
    });
    expect(result.exitCode).toBe(0);
  });

  // Idempotent like `host stop`, and it gets there by SKIPPING the platform
  // start rather than trusting it to no-op. On Windows the Scheduled Task is
  // registered `MultipleInstancesPolicy=IgnoreNew`, so `schtasks /Run` against
  // a live task is suppressed - and `runTaskAndVerifyStart` only accepts
  // POST-BASELINE spawn evidence, so a suppressed run polls out its verify
  // timeout and throws E_SERVICE_CONTROL_FAILED. Calling `start` here would
  // have made "start an already-running host" a slow hard failure on Windows.
  it("reports alreadyRunning: true without ever calling controller.start when the service was already running", async () => {
    mocks.statusResponses = [
      {
        state: "running",
        version: "1.2.3",
        listenUrl: "ws://127.0.0.1:58036/rpc",
        pid: 4242,
      },
    ];

    const result = await serviceStartCommand(fakeCtx());

    expect(mocks.controllerCalls).toEqual([]);
    expect(result.data).toMatchObject({
      priorState: "running",
      state: "running",
      pid: 4242,
      alreadyRunning: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.human ?? "").toContain("already running");
  });

  it("runs the whole command inside one withCliLock acquisition with reason 'service-start'", async () => {
    mocks.statusResponses = [
      { state: "stopped", version: null, listenUrl: null, pid: null },
      { state: "running", version: "1.2.3", listenUrl: null, pid: 4242 },
    ];

    await serviceStartCommand(fakeCtx());

    expect(mocks.lockCalls).toEqual([{ reason: "service-start" }]);
  });
});

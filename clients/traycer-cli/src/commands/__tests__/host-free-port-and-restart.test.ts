import { describe, expect, it, vi } from "vitest";

// `host free-port-and-restart`'s command-level wiring (Host Update Layer
// Redesign Tech Plan, "Lifecycle lock coverage"): the kill (when a pid
// is given) and the restart both execute inside ONE `cli-lock`
// acquisition. The kill/probe logic itself lives in
// `host/free-port-kill.ts` and is exercised there; this file only
// proves the command's own wiring and ordering.

const mocks = vi.hoisted(() => ({
  controllerCalls: [] as string[],
  lockCalls: [] as Array<{ reason: string }>,
  killCalls: [] as Array<{ pid: number; port: number; commandName: string }>,
  killResult: { killed: true, killError: null } as {
    killed: boolean;
    killError: string | null;
  },
  killThrows: null as Error | null,
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

vi.mock("../../host/free-port-kill", () => ({
  killConflictingPortOwner: async (opts: {
    pid: number;
    port: number;
    commandName: string;
  }) => {
    mocks.killCalls.push(opts);
    if (mocks.killThrows !== null) throw mocks.killThrows;
    return mocks.killResult;
  },
}));

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

import { buildHostFreePortAndRestartCommand } from "../host-free-port-and-restart";
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

describe("buildHostFreePortAndRestartCommand", () => {
  it("with no pid, restarts inside one cli-lock acquisition without touching the kill helper", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    mocks.killCalls = [];

    const command = buildHostFreePortAndRestartCommand({
      pid: null,
      port: null,
    });
    const result = await command(fakeCtx());

    expect(mocks.lockCalls).toEqual([{ reason: "host-free-port-and-restart" }]);
    expect(mocks.killCalls).toEqual([]);
    expect(mocks.controllerCalls).toEqual(["restart"]);
    expect(result.data).toMatchObject({ pid: null, killed: false });
  });

  it("with a pid+port, kills then restarts inside the SAME cli-lock acquisition", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    mocks.killCalls = [];
    mocks.killResult = { killed: true, killError: null };

    const command = buildHostFreePortAndRestartCommand({
      pid: 4242,
      port: 51820,
    });
    const result = await command(fakeCtx());

    expect(mocks.lockCalls).toEqual([{ reason: "host-free-port-and-restart" }]);
    expect(mocks.killCalls).toEqual([
      { pid: 4242, port: 51820, commandName: "host free-port-and-restart" },
    ]);
    expect(mocks.controllerCalls).toEqual(["restart"]);
    expect(result.data).toMatchObject({ pid: 4242, killed: true });
  });

  it("rejects --pid without --port before ever acquiring the lock", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    mocks.killCalls = [];

    const command = buildHostFreePortAndRestartCommand({
      pid: 4242,
      port: null,
    });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_INVALID_ARGUMENT",
    });
    expect(mocks.lockCalls).toEqual([]);
    expect(mocks.controllerCalls).toEqual([]);
  });

  it("a kill validation failure aborts before restart is ever called", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    mocks.killCalls = [];
    mocks.killThrows = Object.assign(new Error("does not own port"), {
      code: "E_INVALID_ARGUMENT",
    });

    const command = buildHostFreePortAndRestartCommand({
      pid: 4242,
      port: 51820,
    });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_INVALID_ARGUMENT",
    });
    expect(mocks.controllerCalls).toEqual([]);
    mocks.killThrows = null;
  });

  it("a failed SIGTERM still proceeds to restart and surfaces killError", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    mocks.killCalls = [];
    mocks.killResult = { killed: false, killError: "EPERM" };

    const command = buildHostFreePortAndRestartCommand({
      pid: 4242,
      port: 51820,
    });
    const result = await command(fakeCtx());

    expect(mocks.controllerCalls).toEqual(["restart"]);
    expect(result.data).toMatchObject({ killed: false, killError: "EPERM" });
  });
});

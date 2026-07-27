import { describe, expect, it, vi } from "vitest";

// `host free-port`'s command-level wiring (Host Update Layer Redesign Tech
// Plan, "Lifecycle lock coverage"): the kill-only sibling of `host
// free-port-and-restart` - the kill runs inside one `cli-lock`
// acquisition and the command never touches the service controller (no
// restart). The kill/probe logic itself lives in
// `host/free-port-kill.ts` and is exercised there; this file only
// proves the command's own wiring.

const mocks = vi.hoisted(() => ({
  lockCalls: [] as Array<{ reason: string }>,
  killCalls: [] as Array<{ pid: number; port: number; commandName: string }>,
  killResult: { killed: true, killError: null } as {
    killed: boolean;
    killError: string | null;
  },
  killThrows: null as Error | null,
}));

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

import { buildHostFreePortCommand } from "../host-free-port";
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

describe("buildHostFreePortCommand", () => {
  it("kills inside one cli-lock acquisition and reports killed: true", async () => {
    mocks.lockCalls = [];
    mocks.killCalls = [];
    mocks.killResult = { killed: true, killError: null };

    const command = buildHostFreePortCommand({ pid: 4242, port: 51820 });
    const result = await command(fakeCtx());

    expect(mocks.lockCalls).toEqual([{ reason: "host-free-port" }]);
    expect(mocks.killCalls).toEqual([
      { pid: 4242, port: 51820, commandName: "host free-port" },
    ]);
    expect(result.data).toEqual({
      port: 51820,
      pid: 4242,
      killed: true,
      killError: null,
    });
  });

  it("surfaces a failed SIGTERM as killError without throwing", async () => {
    mocks.lockCalls = [];
    mocks.killCalls = [];
    mocks.killResult = { killed: false, killError: "EPERM" };

    const command = buildHostFreePortCommand({ pid: 4242, port: 51820 });
    const result = await command(fakeCtx());

    expect(result.data).toMatchObject({ killed: false, killError: "EPERM" });
  });

  it("propagates a validation failure from killConflictingPortOwner (e.g. wrong-owner) as a rejection", async () => {
    mocks.lockCalls = [];
    mocks.killCalls = [];
    mocks.killThrows = Object.assign(new Error("does not own port"), {
      code: "E_INVALID_ARGUMENT",
    });

    const command = buildHostFreePortCommand({ pid: 4242, port: 51820 });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_INVALID_ARGUMENT",
    });
    mocks.killThrows = null;
  });
});

import { describe, expect, it, vi } from "vitest";
// Type-only, so it is erased before `vi.hoisted` runs. Annotating the fixture
// with the PRODUCER's contract rather than a hand-copied structural twin is
// what makes this mock fail to compile - instead of silently going stale -
// when `KillConflictingPortOwnerResult` grows a field the command must handle.
import type { KillConflictingPortOwnerResult } from "../../host/free-port-kill";

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
  killResult: {
    killed: true,
    killError: null,
    release: "released",
    releaseDetail: "port 51820 has no listener (pid 4242 released it)",
    holderPid: null,
  } as KillConflictingPortOwnerResult,
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
  it("kills inside one cli-lock acquisition and reports a verified release", async () => {
    mocks.lockCalls = [];
    mocks.killCalls = [];
    mocks.killResult = {
      killed: true,
      killError: null,
      release: "released",
      releaseDetail: "pid 4242 exited after SIGTERM",
      holderPid: null,
    };

    const command = buildHostFreePortCommand({ pid: 4242, port: 51820 });
    const result = await command(fakeCtx());

    expect(mocks.lockCalls).toEqual([{ reason: "host-free-port" }]);
    expect(mocks.killCalls).toEqual([
      expect.objectContaining({
        pid: 4242,
        port: 51820,
        commandName: "host free-port",
        verifyMutationCapability: expect.any(Function),
      }),
    ]);
    expect(result.data).toEqual({
      port: 51820,
      pid: 4242,
      killed: true,
      killError: null,
      release: "released",
      releaseDetail: "pid 4242 exited after SIGTERM",
      holderPid: null,
    });
    expect(result.exitCode).toBe(0);
  });

  // Inverted from the pre-CLI-011 contract, kept in place rather than deleted
  // so the diff shows the flip: a failed SIGTERM used to surface as a
  // `killError` string inside an `exitCode: 0` envelope. It must now throw.
  it("surfaces a failed SIGTERM as a thrown E_HOST_PORT_KILL_FAILED, not a killError field", async () => {
    mocks.lockCalls = [];
    mocks.killCalls = [];
    mocks.killResult = {
      killed: false,
      killError: "EPERM",
      release: "still-held",
      releaseDetail: "SIGTERM was not delivered",
      holderPid: 4242,
    };

    const command = buildHostFreePortCommand({ pid: 4242, port: 51820 });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_HOST_PORT_KILL_FAILED",
    });
  });

  it("throws E_HOST_PORT_STILL_HELD when the target ignores SIGTERM and keeps the port", async () => {
    mocks.lockCalls = [];
    mocks.killCalls = [];
    mocks.killResult = {
      killed: true,
      killError: null,
      release: "still-held",
      releaseDetail:
        "pid 4242 is still alive and still owns port 51820 5000ms after SIGTERM",
      holderPid: 4242,
    };

    const command = buildHostFreePortCommand({ pid: 4242, port: 51820 });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_HOST_PORT_STILL_HELD",
    });
  });

  it("throws E_HOST_PORT_RELEASE_UNVERIFIED when the post-kill probe cannot confirm release", async () => {
    mocks.lockCalls = [];
    mocks.killCalls = [];
    mocks.killResult = {
      killed: true,
      killError: null,
      release: "unverified",
      releaseDetail:
        "could not determine whether pid 4242 still owns port 51820 (probe=unsupported)",
      holderPid: null,
    };

    const command = buildHostFreePortCommand({ pid: 4242, port: 51820 });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_HOST_PORT_RELEASE_UNVERIFIED",
    });
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

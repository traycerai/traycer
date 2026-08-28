import { describe, expect, it, vi } from "vitest";
// Type-only, so it is erased before `vi.hoisted` runs. Annotating the fixture
// with the PRODUCER's contract rather than a hand-copied structural twin is
// what makes this mock fail to compile - instead of silently going stale -
// when `KillConflictingPortOwnerResult` grows a field the command must handle.
import type { KillConflictingPortOwnerResult } from "../../host/free-port-kill";

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
  killResult: {
    killed: true,
    killError: null,
    release: "released",
    releaseDetail: "port 51820 has no listener (pid 4242 released it)",
    holderPid: null,
  } as KillConflictingPortOwnerResult,
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
    expect(result.data).toMatchObject({
      pid: null,
      killed: false,
      release: null,
    });
    expect(result.exitCode).toBe(0);
  });

  it("with a pid+port, kills then restarts inside the SAME cli-lock acquisition", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    mocks.killCalls = [];
    mocks.killResult = {
      killed: true,
      killError: null,
      release: "released",
      releaseDetail: "pid 4242 exited after SIGTERM",
      holderPid: null,
    };

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
    expect(result.data).toMatchObject({
      pid: 4242,
      killed: true,
      release: "released",
    });
    expect(result.exitCode).toBe(0);
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

  // Inverted from the pre-CLI-011 contract, kept in place rather than deleted
  // so the diff shows the flip: a failed SIGTERM used to proceed to restart
  // the host into a port a foreign process still held. It must now throw
  // BEFORE the restart is ever attempted - the single most important
  // assertion in this file is the restart mock's zero call count below.
  it("a failed SIGTERM throws E_HOST_PORT_KILL_FAILED and never calls restart", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    mocks.killCalls = [];
    mocks.killResult = {
      killed: false,
      killError: "EPERM",
      release: "still-held",
      releaseDetail: "SIGTERM was not delivered",
      holderPid: 4242,
    };

    const command = buildHostFreePortAndRestartCommand({
      pid: 4242,
      port: 51820,
    });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_HOST_PORT_KILL_FAILED",
    });
    expect(mocks.controllerCalls).toEqual([]);
  });

  it("release: still-held throws E_HOST_PORT_STILL_HELD and never calls restart", async () => {
    mocks.controllerCalls = [];
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

    const command = buildHostFreePortAndRestartCommand({
      pid: 4242,
      port: 51820,
    });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_HOST_PORT_STILL_HELD",
    });
    expect(mocks.controllerCalls).toEqual([]);
  });

  // Same `still-held` verdict, different situation, and the recovery advice
  // has to differ: the pid we signalled is gone, so "stop pid <original>"
  // names a process that no longer exists and cannot free the port. The
  // holder is almost always something being restarted by a supervisor.
  it("names the replacement holder - not the dead original - when a new pid took the port", async () => {
    mocks.controllerCalls = [];
    mocks.killResult = {
      killed: true,
      killError: null,
      release: "still-held",
      releaseDetail:
        "pid 4242 released port 51820, but pid 7777 is now listening on it",
      holderPid: 7777,
    };

    const command = buildHostFreePortAndRestartCommand({
      pid: 4242,
      port: 51820,
    });
    const rejection = await command(fakeCtx()).then(
      () => null,
      (err: unknown) => err,
    );

    expect(rejection).toMatchObject({ code: "E_HOST_PORT_STILL_HELD" });
    const message = (rejection as { message: string }).message;
    expect(message).toContain("7777");
    // The dead original must NOT be the thing the user is told to stop.
    expect(message).not.toMatch(/Stop pid 4242 yourself/);
    expect(message).toMatch(/supervis/i);
    expect(mocks.controllerCalls).toEqual([]);
  });

  // The ESRCH race AND a replacement listener at once: the signal failed
  // because the target had already exited, and verification then identified a
  // different holder. Shaping the error off `killError` first would name the
  // dead original and discard the only actionable fact we have.
  it("prefers the verified replacement holder over the signal error when both are present", async () => {
    mocks.controllerCalls = [];
    mocks.killResult = {
      killed: false,
      killError: "kill ESRCH",
      release: "still-held",
      releaseDetail:
        "pid 4242 released port 51820, but pid 7777 is now listening on it",
      holderPid: 7777,
    };

    const command = buildHostFreePortAndRestartCommand({
      pid: 4242,
      port: 51820,
    });
    const rejection = await command(fakeCtx()).then(
      () => null,
      (err: unknown) => err,
    );

    expect(rejection).toMatchObject({ code: "E_HOST_PORT_STILL_HELD" });
    const message = (rejection as { message: string }).message;
    expect(message).toContain("7777");
    expect(message).not.toMatch(/could not terminate pid 4242/);
    // The signal's own fate is still recorded, just not the headline.
    expect(rejection).toMatchObject({ details: { killError: "kill ESRCH" } });
    expect(mocks.controllerCalls).toEqual([]);
  });

  it("release: unverified throws E_HOST_PORT_RELEASE_UNVERIFIED and never calls restart", async () => {
    mocks.controllerCalls = [];
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

    const command = buildHostFreePortAndRestartCommand({
      pid: 4242,
      port: 51820,
    });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_HOST_PORT_RELEASE_UNVERIFIED",
    });
    expect(mocks.controllerCalls).toEqual([]);
  });
});

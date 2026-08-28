import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAttemptRecordForEnvironment } from "./attempt-record-test-support";
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
      hostStartAdoptionLabel: async (label: { id: string }) => label.id,
    }),
  };
});

// The real `publishHostStartAdoption` waits (up to 30s) for a service-
// manager child to ack a spawn that never happens under a stubbed
// controller. This suite pins `host free-port-and-restart`'s command-level
// wiring, not the adoption handshake (that's `host-start-adoption.
// test.ts`), so replace it with an immediately-satisfied lease.
vi.mock("../../host/host-start-adoption", () => ({
  publishHostStartAdoption: async () => ({
    waitForSpawn: async () => undefined,
    cancel: async () => undefined,
  }),
}));

vi.mock("../../host/free-port-kill", () => ({
  killConflictingPortOwner: async (opts: {
    pid: number;
    port: number;
    commandName: string;
    verifyMutationCapability: () => Promise<void>;
  }) => {
    // Recorded WITHOUT the capability callback so the `toEqual` assertions
    // below stay value-comparisons; the callback's wiring is exercised by
    // the revalidation tests, not by identity on this record.
    mocks.killCalls.push({
      pid: opts.pid,
      port: opts.port,
      commandName: opts.commandName,
    });
    await opts.verifyMutationCapability();
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

// `store/paths` binds its home root from `os.homedir()` at module load, and
// the shared contender layer's real, unmocked attempt lock/record live
// under it - without redirecting this, every test in this file would read
// and lock-contend the actual operator's `~/.traycer/host-home`, not a
// sandbox. Mirrors `host-restart.test.ts`'s identical fixture.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

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
  beforeEach(() => {
    workHome = mkdtempSync(
      join(tmpdir(), "traycer-host-free-port-and-restart-cmd-test-"),
    );
    osHome.current = workHome;
    process.env.HOME = workHome;
    process.env.USERPROFILE = workHome;
    // `store/paths` captures `homedir()` once at module load - drop the
    // module cache so each test (and its dynamic import below) sees its
    // own tmp HOME, matching `host-restart.test.ts`'s identical pattern.
    vi.resetModules();
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

  it("with no pid, restarts inside one cli-lock acquisition without touching the kill helper", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    mocks.killCalls = [];

    const { buildHostFreePortAndRestartCommand } =
      await import("../host-free-port-and-restart");
    const command = buildHostFreePortAndRestartCommand({
      pid: null,
      port: null,
      deferIfParked: false,
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

    const { buildHostFreePortAndRestartCommand } =
      await import("../host-free-port-and-restart");
    const command = buildHostFreePortAndRestartCommand({
      pid: 4242,
      port: 51820,
      deferIfParked: false,
    });
    const result = await command(fakeCtx());

    expect(mocks.lockCalls).toEqual([{ reason: "host-free-port-and-restart" }]);
    expect(mocks.killCalls).toEqual([
      {
        pid: 4242,
        port: 51820,
        commandName: "host free-port-and-restart",
      },
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

    const { buildHostFreePortAndRestartCommand } =
      await import("../host-free-port-and-restart");
    const command = buildHostFreePortAndRestartCommand({
      pid: 4242,
      port: null,
      deferIfParked: false,
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

    const { buildHostFreePortAndRestartCommand } =
      await import("../host-free-port-and-restart");
    const command = buildHostFreePortAndRestartCommand({
      pid: 4242,
      port: 51820,
      deferIfParked: false,
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

    const { buildHostFreePortAndRestartCommand } =
      await import("../host-free-port-and-restart");
    const command = buildHostFreePortAndRestartCommand({
      pid: 4242,
      port: 51820,
      deferIfParked: false,
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
      deferIfParked: false,
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
      deferIfParked: false,
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
      deferIfParked: false,
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
      deferIfParked: false,
    });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_HOST_PORT_RELEASE_UNVERIFIED",
    });
    expect(mocks.controllerCalls).toEqual([]);
  });

  // Same `--defer-if-parked` contract as `host restart` (round-2
  // revalidation redesign): this command reaches the identical `stop-only`
  // branch from the port-conflict repair, so it is the same
  // stop-without-relaunch hazard by another entry point. Driven by a real
  // attempt record on disk, read by the real, unmocked shared contender
  // layer - not a stubbed `recoveryAction`.
  describe("--defer-if-parked", () => {
    it("a stop-only record + --defer-if-parked refuses WITHOUT ever stopping the service", async () => {
      mocks.controllerCalls = [];
      mocks.lockCalls = [];
      mocks.killCalls = [];
      await writeAttemptRecordForEnvironment("production", {
        phase: "waiting-to-activate",
        execution: "parked",
        continuation: "activate",
      });

      const { buildHostFreePortAndRestartCommand } =
        await import("../host-free-port-and-restart");
      const command = buildHostFreePortAndRestartCommand({
        pid: null,
        port: null,
        deferIfParked: true,
      });
      const result = await command(fakeCtx());

      // The load-bearing negative: the service was never touched.
      expect(mocks.controllerCalls).toEqual([]);
      // Paired positive, so this test cannot pass merely because the
      // command failed early and never reached the branch under test.
      expect(result.data).toMatchObject({
        restartedLabel: null,
        deferredForParkedActivation: true,
      });
    });

    it("the same stop-only record WITHOUT --defer-if-parked keeps the old behavior: stops the service", async () => {
      mocks.controllerCalls = [];
      mocks.lockCalls = [];
      mocks.killCalls = [];
      await writeAttemptRecordForEnvironment("production", {
        phase: "waiting-to-activate",
        execution: "parked",
        continuation: "activate",
      });

      const { buildHostFreePortAndRestartCommand } =
        await import("../host-free-port-and-restart");
      const command = buildHostFreePortAndRestartCommand({
        pid: null,
        port: null,
        deferIfParked: false,
      });
      const result = await command(fakeCtx());

      expect(mocks.controllerCalls).toEqual(["stop"]);
      expect(result.data).toMatchObject({
        restartedLabel: null,
        deferredForParkedActivation: false,
      });
    });

    // Regression for the `killError` warning composing with whichever
    // action actually ran, instead of a hardcoded "restart requested"
    // claim: before this fix, a failed SIGTERM on a stop-only outcome
    // still told the caller a restart was requested even though the
    // service was only stopped.
    it("a stop-only record with a failed SIGTERM composes the warning with the action that actually ran (stop), not a hardcoded restart claim", async () => {
      mocks.controllerCalls = [];
      mocks.lockCalls = [];
      mocks.killCalls = [];
      // A failed SIGTERM whose port was verified free regardless: the only
      // failed-signal shape that still reaches the service action, now that
      // an unverified release throws before it (CLI-011). The composition
      // under test is the same - the kill sentence must attach to the action
      // that actually ran (stop), not to a hardcoded restart claim.
      mocks.killResult = {
        killed: false,
        killError: "EPERM",
        release: "released",
        releaseDetail: "port 51820 has no listener (freed before the signal)",
        holderPid: null,
      };
      await writeAttemptRecordForEnvironment("production", {
        phase: "waiting-to-activate",
        execution: "parked",
        continuation: "activate",
      });

      const { serviceLabelFor } = await import("../../service");
      const label = serviceLabelFor("production");
      const { buildHostFreePortAndRestartCommand } =
        await import("../host-free-port-and-restart");
      const command = buildHostFreePortAndRestartCommand({
        pid: 4242,
        port: 51820,
        deferIfParked: false,
      });
      const result = await command(fakeCtx());

      expect(mocks.controllerCalls).toEqual(["stop"]);
      expect(result.data).toMatchObject({ killed: false, killError: "EPERM" });
      expect(result.human).toBe(
        `pid 4242 could not be signalled (EPERM); port verified free anyway (port 51820 has no listener (freed before the signal)); stopped '${label.id}' without activating parked update bytes`,
      );
      mocks.killResult = {
        killed: true,
        killError: null,
        release: "released",
        releaseDetail: "port 51820 has no listener (pid 4242 released it)",
        holderPid: null,
      };
    });

    it("a restart-current record (restarting/activate) still restarts even with --defer-if-parked set", async () => {
      mocks.controllerCalls = [];
      mocks.lockCalls = [];
      mocks.killCalls = [];
      await writeAttemptRecordForEnvironment("production", {
        phase: "restarting",
        execution: "active",
        continuation: "activate",
      });

      const { buildHostFreePortAndRestartCommand } =
        await import("../host-free-port-and-restart");
      const command = buildHostFreePortAndRestartCommand({
        pid: null,
        port: null,
        deferIfParked: true,
      });
      const result = await command(fakeCtx());

      // The actual restart happened - not merely "did not defer".
      expect(mocks.controllerCalls).toEqual(["restart"]);
      expect(result.data).toMatchObject({
        restartedLabel: "ai.traycer.host",
        deferredForParkedActivation: false,
      });
    });
  });
});

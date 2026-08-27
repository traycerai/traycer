import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAttemptRecordForEnvironment } from "./attempt-record-test-support";

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
    expect(result.data).toMatchObject({ pid: null, killed: false });
  });

  it("with a pid+port, kills then restarts inside the SAME cli-lock acquisition", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    mocks.killCalls = [];
    mocks.killResult = { killed: true, killError: null };

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
        verifyMutationCapability: expect.any(Function),
      },
    ]);
    expect(mocks.controllerCalls).toEqual(["restart"]);
    expect(result.data).toMatchObject({ pid: 4242, killed: true });
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

  it("a failed SIGTERM still proceeds to restart and surfaces killError", async () => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    mocks.killCalls = [];
    mocks.killResult = { killed: false, killError: "EPERM" };

    const { buildHostFreePortAndRestartCommand } =
      await import("../host-free-port-and-restart");
    const command = buildHostFreePortAndRestartCommand({
      pid: 4242,
      port: 51820,
      deferIfParked: false,
    });
    const result = await command(fakeCtx());

    expect(mocks.controllerCalls).toEqual(["restart"]);
    expect(result.data).toMatchObject({ killed: false, killError: "EPERM" });
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
      mocks.killResult = { killed: false, killError: "EPERM" };
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
        `stopped '${label.id}' without activating parked update bytes; warning: failed to terminate pid 4242: EPERM`,
      );
      mocks.killResult = { killed: true, killError: null };
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

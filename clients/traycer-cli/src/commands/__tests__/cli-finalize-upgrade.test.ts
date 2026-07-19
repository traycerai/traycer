import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `cli finalize-upgrade`'s command-level wiring (Host Update Layer
// Redesign Tech Plan, "Windows CLI-finalize helper"): the swap +
// service-start run inside one `cli-lock` acquisition this leaf command
// takes itself (no caller wraps it - it's invoked directly by the
// detached finalize-helper script via the staged binary). On a lock
// timeout it writes NO marker, deferring to the existing
// `pendingUpgrade` for the next `host restart`.

const mocks = vi.hoisted(() => ({
  finalizeResult: { status: "no-pending" } as Record<string, unknown>,
  controllerCalls: [] as string[],
  serviceStartThrows: null as Error | null,
  lockCalls: [] as Array<{ reason: string }>,
  lockThrows: null as Error | null,
  // Cross-mock ordering timeline for the Finding 6 orchestration test
  // (ticket-2 review round 1) - a SHARED array all three boundary mocks
  // below push into, so a single assertion can pin their relative order
  // (lock span must fully enclose finalize+start) instead of only each
  // mock's own call count.
  callOrder: [] as string[],
}));

vi.mock("../cli-upgrade", () => ({
  finalizePendingCliUpgrade: async () => {
    // Stands in for the real fs-rename `finalizePendingCliUpgrade`
    // performs when it resolves "finalised" - this suite mocks the call
    // itself out (re-testing the real rename belongs to cli-upgrade.
    // test.ts), but still marks WHEN it ran relative to the lock/service
    // markers below.
    mocks.callOrder.push("finalize-call");
    return mocks.finalizeResult;
  },
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
        mocks.callOrder.push("service-start");
        if (mocks.serviceStartThrows !== null) throw mocks.serviceStartThrows;
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
      if (mocks.lockThrows !== null) throw mocks.lockThrows;
      mocks.callOrder.push("lock-enter");
      try {
        return await fn();
      } finally {
        mocks.callOrder.push("lock-exit");
      }
    },
  };
});

import type { CommandContext } from "../../runner/runner";

// `store/paths` binds its home root from `os.homedir()` at module load.
// Keep the environment mutation below, but redirect `homedir()` too.
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

describe("cliFinalizeUpgradeCommand / runFinalizeUpgradeSwap", () => {
  beforeEach(() => {
    workHome = mkdtempSync(
      join(tmpdir(), "traycer-cli-finalize-upgrade-test-"),
    );
    osHome.current = workHome;
    process.env.HOME = workHome;
    process.env.USERPROFILE = workHome;
    // `store/paths` captures `homedir()` once at module load - drop the
    // module cache so each test's dynamic import sees its own tmp HOME.
    vi.resetModules();
    mocks.finalizeResult = { status: "no-pending" };
    mocks.controllerCalls = [];
    mocks.serviceStartThrows = null;
    mocks.lockCalls = [];
    mocks.lockThrows = null;
    mocks.callOrder = [];
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

  function markerPath(): string {
    return join(workHome, ".traycer", "cli", "post-finalize.json");
  }

  it("on a finalised swap, starts the service and writes a 'swapped' marker", async () => {
    mocks.finalizeResult = {
      status: "finalised",
      previousVersion: "1.4.0",
      version: "1.5.0",
      binaryPath: "/opt/traycer/cli/traycer",
    };

    const { cliFinalizeUpgradeCommand } =
      await import("../cli-finalize-upgrade");
    const result = await cliFinalizeUpgradeCommand(fakeCtx());

    expect(mocks.lockCalls).toEqual([{ reason: "cli-finalize-upgrade" }]);
    expect(mocks.controllerCalls).toEqual(["start"]);
    expect(result.data).toEqual({
      status: "swapped",
      previousVersion: "1.4.0",
      version: "1.5.0",
      serviceStartError: null,
    });
    expect(existsSync(markerPath())).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath(), "utf8"));
    expect(marker).toMatchObject({
      status: "swapped",
      livePath: "/opt/traycer/cli/traycer",
      serviceStartError: null,
    });
  });

  // Finding 6 (ticket-2 review round 1): no test in this repo executes the
  // Windows finalize-helper's full real path (parent-exit wait -> staged-
  // executable invocation -> real staged->live rename -> service start) -
  // that's a genuine, currently-unclosed coverage gap, not a code bug the
  // review found. A real end-to-end run needs an actual Windows machine
  // (PowerShell + a live OS service); this repo's CI has no Windows test
  // job for traycer-cli (`.github/workflows/test.yml` runs only
  // ubuntu-latest + a macOS job scoped to desktop packaging - the sole
  // `windows-latest` runner anywhere in this monorepo's workflows belongs
  // to `release-desktop.yml`, which packages/signs the Electron installer,
  // not the CLI test suite). Adding a `skipIf(win32)`-inverted test here
  // would never actually run in this environment and would be fake
  // coverage, so this suite does NOT add one - per the fixup ticket's own
  // instruction, this is recorded as an honest residual instead:
  //
  //   RESIDUAL: the real Windows rename+start path
  //   (`installer/install.ts`-analogous binary replace via
  //   `tryReplaceLiveBinary`, then `ServiceController.start` on a live
  //   Scheduled Task) is NOT exercised by any automated test. Verify
  //   manually on Windows before a release that touches
  //   `upgrade/finalize-helper.ts`, `commands/cli-finalize-upgrade.ts`, or
  //   `commands/cli-upgrade.ts`'s `tryReplaceLiveBinary`: stage a CLI
  //   upgrade, let a real `host restart` schedule the PowerShell helper,
  //   confirm the parent CLI process exit is detected, the staged binary
  //   becomes live, and the OS service starts successfully.
  //
  // What IS achievable and added below: an orchestration test that proves
  // the platform-agnostic ordering contract `cli-finalize-upgrade.ts`
  // itself owns - the swap (`finalize-call`, standing in for the real
  // fs-rename) happens BEFORE the service start, and the `cli-lock` span
  // (`lock-enter`/`lock-exit`) fully ENCLOSES both, with no release/
  // reacquire gap in between. This runs on every platform this repo's CI
  // actually has (Linux/macOS) and would catch an orchestration or lock-
  // scope regression regardless of OS - it just can't stand in for a real
  // Windows PowerShell + Scheduled Task run.
  it("orchestration: cli-lock spans the whole rename-then-service-start sequence in order, never released in between", async () => {
    mocks.finalizeResult = {
      status: "finalised",
      previousVersion: "1.4.0",
      version: "1.5.0",
      binaryPath: "/opt/traycer/cli/traycer",
    };

    const { cliFinalizeUpgradeCommand } =
      await import("../cli-finalize-upgrade");
    await cliFinalizeUpgradeCommand(fakeCtx());

    expect(mocks.callOrder).toEqual([
      "lock-enter",
      "finalize-call",
      "service-start",
      "lock-exit",
    ]);
  });

  it("on a finalised swap where the service fails to start, records serviceStartError in both the outcome and the marker", async () => {
    mocks.finalizeResult = {
      status: "finalised",
      previousVersion: "1.4.0",
      version: "1.5.0",
      binaryPath: "/opt/traycer/cli/traycer",
    };
    mocks.serviceStartThrows = new Error("schtasks /Run failed");

    const { cliFinalizeUpgradeCommand } =
      await import("../cli-finalize-upgrade");
    const result = await cliFinalizeUpgradeCommand(fakeCtx());

    expect(result.data).toMatchObject({
      status: "swapped",
      serviceStartError: "schtasks /Run failed",
    });
    const marker = JSON.parse(readFileSync(markerPath(), "utf8"));
    expect(marker.serviceStartError).toBe("schtasks /Run failed");
  });

  it("on still-locked, writes a 'swap-failed' marker and never starts the service", async () => {
    mocks.finalizeResult = {
      status: "still-locked",
      stagedBinaryPath: "/opt/traycer/cli/traycer-1.5.0",
      livePath: "/opt/traycer/cli/traycer",
      errorMessage: "binary still held by another process",
    };

    const { cliFinalizeUpgradeCommand } =
      await import("../cli-finalize-upgrade");
    const result = await cliFinalizeUpgradeCommand(fakeCtx());

    expect(mocks.controllerCalls).toEqual([]);
    expect(result.data).toEqual({
      status: "swap-failed",
      errorMessage: "binary still held by another process",
    });
    const marker = JSON.parse(readFileSync(markerPath(), "utf8"));
    expect(marker).toMatchObject({
      status: "swap-failed",
      errorMessage: "binary still held by another process",
    });
  });

  it.each(["no-pending", "no-manifest", "staged-binary-missing"])(
    "on %s, writes no marker and never starts the service",
    async (status) => {
      mocks.finalizeResult =
        status === "staged-binary-missing"
          ? { status, stagedBinaryPath: "/opt/traycer/cli/traycer-1.5.0" }
          : { status };

      const { cliFinalizeUpgradeCommand } =
        await import("../cli-finalize-upgrade");
      const result = await cliFinalizeUpgradeCommand(fakeCtx());

      expect(mocks.controllerCalls).toEqual([]);
      expect(result.data).toEqual({ status: "no-pending" });
      expect(existsSync(markerPath())).toBe(false);
    },
  );

  it("on a cli-lock timeout, writes no marker, never runs the swap, and does not throw", async () => {
    // `cli-finalize-upgrade.ts` checks `err instanceof CliError` against
    // the CliError class from ITS OWN post-vi.resetModules() import
    // generation - a CliError built from a top-level (pre-reset) import
    // would be a distinct class and fail that check. Import errors.ts
    // dynamically, in the same generation as the command under test.
    const { CLI_ERROR_CODES: freshCodes, cliError: freshCliError } =
      await import("../../runner/errors");
    mocks.lockThrows = freshCliError({
      code: freshCodes.CLI_LOCK_BUSY,
      message: "cli-lock busy",
      details: null,
      exitCode: 75,
    });

    const { cliFinalizeUpgradeCommand } =
      await import("../cli-finalize-upgrade");
    const result = await cliFinalizeUpgradeCommand(fakeCtx());

    expect(result.data).toEqual({ status: "lock-timeout" });
    expect(mocks.controllerCalls).toEqual([]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("propagates a non-lock error from withCliLock instead of swallowing it", async () => {
    mocks.lockThrows = new Error("unexpected disk failure");

    const { cliFinalizeUpgradeCommand } =
      await import("../cli-finalize-upgrade");
    await expect(cliFinalizeUpgradeCommand(fakeCtx())).rejects.toThrow(
      "unexpected disk failure",
    );
  });
});

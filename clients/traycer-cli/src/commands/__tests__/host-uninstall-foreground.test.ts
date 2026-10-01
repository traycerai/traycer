import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { buildHostUninstallCommand as BuildHostUninstallCommandType } from "../host-uninstall";

// `traycer host uninstall --all` sibling to the other foreground-run
// guards in this family (`host-restart-foreground.test.ts`,
// `service-install-plain-foreground.test.ts`, etc). Ruling: under DESKTOP
// origin, `--all` over a live FOREGROUND run must refuse
// `E_HOST_NOT_SERVICE_RUN` FIRST under the command's contender lock - before
// any deregister (`controller.uninstall`), byte removal (`uninstallHost`),
// or the unconditional stop (`controller.stop`,
// `commands/host-uninstall.ts:231-245` in the pre-fix numbering). Terminal
// origin `--all` is UNCHANGED - it still stops that host. Bare
// `host uninstall` (no `--all`) is OUT OF SCOPE for this guard and stays
// unchanged either way.
//
// Design this suite targets (production not yet changed for THIS command -
// verified by reading `../host-uninstall.ts` in full: `HostUninstallArgs` is
// still `{ readonly all: boolean }`, no `lifecycleOrigin` field, and nothing
// in it calls `refuseDesktopDisruptionOfForegroundRun`):
// `HostUninstallArgs` gains `lifecycleOrigin`, and `buildHostUninstallCommand`
// calls `refuseDesktopDisruptionOfForegroundRun("host uninstall", environment,
// origin)` inside its contender callback when `args.all`, before touching the
// controller. `vitest` here runs through esbuild transforms only (no
// `test.typecheck`), so passing the new `lifecycleOrigin` field on an object
// literal against current bytes is not a compile-time error - it is an inert
// extra field current code never reads, which is exactly what makes this a
// behavioural RED rather than a type error.
//
// Note: `refuseDesktopDisruptionOfForegroundRun` and its remedy text already
// exist in `../../host/foreground-host-run.ts` (added by a sibling task in
// this same family for OTHER commands - `host stop`/`host restart`/
// `host service install`/etc), but `"host uninstall"` is not yet one of its
// `ForegroundRunRefusingVerb` members and `foregroundRunRemedy` has no
// `"then remove Traycer"` arm yet either - both are part of the production
// fix this suite is written against, not something already wired for this
// command.
//
// HOME isolation: the same hoisted `node:os` + real `store/paths` +
// `vi.resetModules()` fixture as this suite's other foreground files, with a
// `rmSync(hostHomeDir("production"))` sweep in `beforeEach` from the start.
//
// "Live foreground run": real records via the production
// `writeSupervisorRecords` helper (`../../host/lifecycle-files.ts`), naming
// THIS TEST PROCESS's own pid and real start identity, `admission:
// "foreground"`, so `readLiveSupervisorRun` (inside `findForegroundHostRun`,
// left UNMOCKED) runs its genuine OS liveness/identity probe against a
// process that is actually alive. `findLiveIncumbentHost` (a live *host*,
// not a live *supervisor*) is mocked to report a fake reachable host.
//
// PID.JSON: NOT written for these tests. Reading `../host-uninstall.ts` in
// full shows `actuators.stop(controller, label, { force: false })` is called
// UNCONDITIONALLY on the `--all` path, right after `actuators.uninstall` -
// it is never gated on `readPublishedHost`/`pid.json` at all (that read only
// feeds the POST-stop liveness probe, which is best-effort and never gates
// the stop call itself). Confirmed empirically below: test 2 (the
// terminal-origin control) reaches `controller.stop` with no `pid.json` on
// disk at all.
//
// `uninstallHostServiceWithAttempt`/`stopHostServiceWithAttempt`
// (`../../host/update-mutation.ts`) are left REAL - only
// `createServiceController` (`../../service`) and `uninstallHost`
// (`../../installer`) are mocked.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const mocks = vi.hoisted(() => ({
  uninstallMock: vi.fn(),
  stopMock: vi.fn(),
  statusMock: vi.fn(),
  uninstallHostMock: vi.fn(),
  findLiveIncumbentHostMock: vi.fn(),
}));

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: () => ({
      uninstall: (...callArgs: Parameters<typeof mocks.uninstallMock>) =>
        mocks.uninstallMock(...callArgs),
      stop: (...callArgs: Parameters<typeof mocks.stopMock>) =>
        mocks.stopMock(...callArgs),
      status: (...callArgs: Parameters<typeof mocks.statusMock>) =>
        mocks.statusMock(...callArgs),
    }),
    serviceLabelFor: (environment: "dev" | "production") => ({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment,
      devSlot: null,
    }),
  };
});

vi.mock("../../installer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../installer")>();
  return {
    ...actual,
    uninstallHost: (...callArgs: Parameters<typeof mocks.uninstallHostMock>) =>
      mocks.uninstallHostMock(...callArgs),
  };
});

vi.mock("../../host/incumbent-check", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/incumbent-check")>();
  return {
    ...actual,
    findLiveIncumbentHost: (environment: string | undefined) =>
      mocks.findLiveIncumbentHostMock(environment),
  };
});

vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return {
    ...actual,
    withCliLock: async <T>(
      _opts: { reason: string },
      fn: (handle: {
        path: string;
        metadata: Record<string, unknown>;
        release: () => Promise<void>;
      }) => Promise<T>,
    ): Promise<T> =>
      fn({ path: "/tmp/.lock", metadata: {}, release: async () => {} }),
  };
});

import { CLI_ERROR_CODES } from "../../runner/errors";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

const LIVE_INCUMBENT_HOST = {
  pid: 55_555,
  version: "1.9.0",
  websocketUrl: "ws://127.0.0.1:55555/rpc",
};

const UNINSTALL_HOST_RESULT = {
  removedRecord: null,
  removedInstallDir: true,
  removedStagedDir: true,
  purgedRuntime: false,
};

const NOT_INSTALLED_STATUS = {
  state: "not-installed" as const,
  version: null,
  listenUrl: null,
  pid: null,
};

/** `stop-intent.json` directly under the host home
 * (`protocol/src/config/host-stop-intent.ts`'s `HOST_STOP_INTENT_FILENAME`).
 * A refused request must never write it. */
function stopIntentFilePath(): string {
  return join(workHome, ".traycer", "host", "stop-intent.json");
}

/** A REAL live foreground run: this test process's own pid and identity. */
async function writeLiveForegroundRun(): Promise<void> {
  const { ownProcessStartIdentity } =
    await import("../../store/process-identity");
  const { writeSupervisorRecords } = await import("../../host/lifecycle-files");
  await writeSupervisorRecords("production", {
    record: {
      v: 1,
      pid: process.pid,
      cliVersion: "1.9.0",
      capabilities: ["lifecycle-policy-v1"],
      startedAt: "2026-09-01T00:00:00.000Z",
    },
    runState: {
      v: 1,
      supervisorPid: process.pid,
      supervisorStartIdentity: ownProcessStartIdentity(),
      admission: "foreground",
      origin: null,
      adopted: false,
      lastPresence: null,
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  });
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

beforeEach(async () => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-host-uninstall-fg-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
  const { hostHomeDir } = await import("../../store/paths");
  expect(hostHomeDir("production").startsWith(workHome)).toBe(true);
  rmSync(hostHomeDir("production"), { recursive: true, force: true });
  mocks.uninstallMock.mockReset();
  mocks.uninstallMock.mockResolvedValue(undefined);
  mocks.stopMock.mockReset();
  mocks.stopMock.mockResolvedValue(undefined);
  mocks.statusMock.mockReset();
  mocks.statusMock.mockResolvedValue(NOT_INSTALLED_STATUS);
  mocks.uninstallHostMock.mockReset();
  mocks.uninstallHostMock.mockResolvedValue(UNINSTALL_HOST_RESULT);
  mocks.findLiveIncumbentHostMock.mockReset();
  mocks.findLiveIncumbentHostMock.mockResolvedValue(LIVE_INCUMBENT_HOST);
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

describe("buildHostUninstallCommand --all - refusal over a foreground run (desktop origin only)", () => {
  // Test 1 (RED): desktop origin, `--all`, live foreground run - must refuse
  // before any write: no deregister, no byte removal, no stop, no
  // stop-intent file. RED on current code: `HostUninstallArgs` has no
  // `lifecycleOrigin` and nothing calls the guard, so the whole `--all`
  // sequence proceeds through the real facade unconditionally.
  it("desktop-origin --all over a live foreground run refuses E_HOST_NOT_SERVICE_RUN before any write", async () => {
    await writeLiveForegroundRun();

    const { buildHostUninstallCommand } = await import("../host-uninstall");
    const command = (
      buildHostUninstallCommand as typeof BuildHostUninstallCommandType
    )({
      all: true,
      lifecycleOrigin: "desktop",
    } as Parameters<typeof buildHostUninstallCommand>[0]);
    const caught: unknown = await command(fakeCtx()).then(
      () => null,
      (err: unknown) => err,
    );

    expect(mocks.uninstallMock).not.toHaveBeenCalled();
    expect(mocks.uninstallHostMock).not.toHaveBeenCalled();
    expect(mocks.stopMock).not.toHaveBeenCalled();
    expect(existsSync(stopIntentFilePath())).toBe(false);
    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
      details: { supervisorPid: process.pid, hostPid: LIVE_INCUMBENT_HOST.pid },
    });
    const message = (caught as { message: string }).message;
    expect(message).toContain(
      "host uninstall: the running host was started in a terminal",
    );
    expect(message).toContain("then remove Traycer");
    expect(message).not.toContain("--force");
  });

  // Test 2 (control, GREEN): terminal origin, `--all`, same live foreground
  // run - UNCHANGED behaviour: proceeds through deregister, stop AND byte
  // removal. No `pid.json` is written for this test - see the file header:
  // `controller.stop` is called unconditionally on the `--all` path, never
  // gated on a published-host read.
  it("(control) terminal-origin --all over the same live foreground run still proceeds through uninstall, stop, and uninstallHost", async () => {
    await writeLiveForegroundRun();

    const { buildHostUninstallCommand } = await import("../host-uninstall");
    const command = (
      buildHostUninstallCommand as typeof BuildHostUninstallCommandType
    )({
      all: true,
      lifecycleOrigin: "terminal",
    } as Parameters<typeof buildHostUninstallCommand>[0]);
    const result = await command(fakeCtx());

    expect(mocks.uninstallMock).toHaveBeenCalledTimes(1);
    expect(mocks.stopMock).toHaveBeenCalledTimes(1);
    expect(mocks.uninstallHostMock).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
  });

  // Test 3 (control, GREEN): desktop origin, `--all`, NO foreground run
  // present. Positive premise proven first, then the sequence proceeds
  // exactly as today.
  it("(control) desktop-origin --all with no foreground run present still proceeds through the actuators", async () => {
    const { readLiveSupervisorRun } =
      await import("../../host/live-supervisor-run");
    expect(await readLiveSupervisorRun("production")).toBeNull();

    const { buildHostUninstallCommand } = await import("../host-uninstall");
    const command = (
      buildHostUninstallCommand as typeof BuildHostUninstallCommandType
    )({
      all: true,
      lifecycleOrigin: "desktop",
    } as Parameters<typeof buildHostUninstallCommand>[0]);
    const result = await command(fakeCtx());

    expect(mocks.uninstallMock).toHaveBeenCalledTimes(1);
    expect(mocks.uninstallHostMock).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
  });

  // Test 4 (control, GREEN): desktop origin, BARE `host uninstall` (no
  // `--all`), live foreground run - out of scope for this guard, UNCHANGED:
  // `uninstallHost` runs, but neither `uninstall` nor `stop` is ever called
  // at all (the whole `--all` block is skipped), and nothing is refused.
  it("(control) desktop-origin bare uninstall (no --all) over a live foreground run is unaffected - out of scope for this guard", async () => {
    await writeLiveForegroundRun();

    const { buildHostUninstallCommand } = await import("../host-uninstall");
    const command = (
      buildHostUninstallCommand as typeof BuildHostUninstallCommandType
    )({
      all: false,
      lifecycleOrigin: "desktop",
    } as Parameters<typeof buildHostUninstallCommand>[0]);
    const result = await command(fakeCtx());

    expect(mocks.uninstallHostMock).toHaveBeenCalledTimes(1);
    expect(mocks.uninstallMock).not.toHaveBeenCalled();
    expect(mocks.stopMock).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });
});

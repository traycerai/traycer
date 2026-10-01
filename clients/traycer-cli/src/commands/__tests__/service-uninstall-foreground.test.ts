import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";

// This file covers only the command-level surface of uninstall: unlike
// `service-install`/`service-start`, a live foreground run over
// `traycer host service uninstall` (`../service-uninstall.ts`) is NOT a
// refusal. The new design (production not yet changed - these tests are
// written against that target shape, on unmodified `service-uninstall.ts`):
//
// - `UninstallServiceOptions` (`service/index.ts:67`) gains a required
//   `leaveForegroundRun: ForegroundHostRun | null`.
// - `service-uninstall.ts` reads `findForegroundHostRun(environment)` FIRST
//   inside its contender callback, passes it down as `leaveForegroundRun`,
//   and returns `data.leftRunning: "foreground" | null`. With a live run,
//   the human-readable line also says the foreground host "was left alone".
//
// On HEAD, `service-uninstall.ts` does none of this: it never reads
// `findForegroundHostRun`, and `uninstall` is called with `{ label }` alone
// (no `leaveForegroundRun` field at all) - so a live foreground run does not
// change behaviour today, it just proceeds exactly like the no-foreground-run
// case. `vitest` here runs through esbuild transforms only (no
// `test.typecheck`), so a test asserting the NEW field shape against current
// bytes is a behavioural RED (the spy's received args and the result's
// `leftRunning` field won't match), not a compile-time error.
//
// `uninstallHostServiceWithAttempt` (`../../host/update-mutation.ts`) is left
// REAL - there is no host-start adoption/spawn-edge concern on the uninstall
// path at all (it just calls `controller.uninstall` directly under
// `withServiceMutationAuthority`).
//
// HOME isolation: the same hoisted `node:os` + real `store/paths` +
// `vi.resetModules()` fixture as this suite's other foreground files, with
// the `rmSync(hostHomeDir("production"))` sweep in `beforeEach` applied from
// the start.
//
// "Live foreground run": real records via the production
// `writeSupervisorRecords` helper (`../../host/lifecycle-files.ts`), naming
// THIS TEST PROCESS's own pid and real start identity, `admission:
// "foreground"`, so `readLiveSupervisorRun` (inside `findForegroundHostRun`,
// left UNMOCKED) runs its genuine OS liveness/identity probe against a
// process that is actually alive. `findLiveIncumbentHost` (a live *host*,
// not a live *supervisor*) is mocked to report a fake reachable host.
//
// `../../host/foreground-host-run.ts` itself is never mocked - the new
// `leaveForegroundRun` plumbing this suite is proving RED will read it.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const mocks = vi.hoisted(() => ({
  uninstallMock: vi.fn(),
  findLiveIncumbentHostMock: vi.fn(),
}));

// `createServiceController` must be mocked: the real controller does
// filesystem I/O against the operator's actual `~/.traycer` home. `uninstall`
// is a call recorder whose received OPTIONS (including the new
// `leaveForegroundRun` field, once production reads it) are what these tests
// inspect. `serviceLabelFor` is mocked the same fixed way
// `service-start-foreground.test.ts` does it, for consistency across this
// suite's sibling files.
vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: () => ({
      uninstall: (...callArgs: Parameters<typeof mocks.uninstallMock>) =>
        mocks.uninstallMock(...callArgs),
    }),
    serviceLabelFor: (environment: "dev" | "production") => ({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment,
      devSlot: null,
    }),
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

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

const LIVE_INCUMBENT_HOST = {
  pid: 55_555,
  version: "1.9.0",
  websocketUrl: "ws://127.0.0.1:55555/rpc",
};

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

/** A REAL live SERVICE-managed run: same process, `admission: "granted"`. */
async function writeServiceManagedRun(): Promise<void> {
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
      admission: "granted",
      origin: "terminal",
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
  workHome = mkdtempSync(join(tmpdir(), "traycer-service-uninstall-fg-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
  const { hostHomeDir } = await import("../../store/paths");
  expect(hostHomeDir("production").startsWith(workHome)).toBe(true);
  rmSync(hostHomeDir("production"), { recursive: true, force: true });
  mocks.uninstallMock.mockReset();
  mocks.uninstallMock.mockResolvedValue(undefined);
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

describe("serviceUninstallCommand - leaving a foreground run alone (not a refusal)", () => {
  // Test 1 (RED): a live foreground run does NOT refuse - the uninstall
  // proceeds, but `leaveForegroundRun` must be threaded down to the
  // controller and reported back as `leftRunning: "foreground"`, with the
  // human line saying the foreground host was left alone. RED on current
  // code: `service-uninstall.ts` never reads `findForegroundHostRun`, so
  // `uninstall` is called with `{ label }` alone (no `leaveForegroundRun`
  // key at all) and the result has no `leftRunning` field.
  it("live foreground run over a plain uninstall proceeds and reports it was left alone", async () => {
    await writeLiveForegroundRun();

    const { serviceUninstallCommand } = await import("../service-uninstall");
    const result = await serviceUninstallCommand(fakeCtx());

    expect(result.exitCode).toBe(0);
    expect(mocks.uninstallMock).toHaveBeenCalledTimes(1);
    expect(mocks.uninstallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        leaveForegroundRun: {
          supervisorPid: process.pid,
          hostPid: LIVE_INCUMBENT_HOST.pid,
        },
      }),
    );
    expect(result.data).toMatchObject({ leftRunning: "foreground" });
    expect(result.human ?? "").toContain("it was left alone");
  });

  // Test 2 (control): no foreground run present at all. Positive premise
  // proven first, then `leaveForegroundRun: null` / `leftRunning: null`.
  it("(control) uninstall with no foreground run present passes leaveForegroundRun: null and reports leftRunning: null", async () => {
    const { readLiveSupervisorRun } =
      await import("../../host/live-supervisor-run");
    expect(await readLiveSupervisorRun("production")).toBeNull();

    const { serviceUninstallCommand } = await import("../service-uninstall");
    const result = await serviceUninstallCommand(fakeCtx());

    expect(mocks.uninstallMock).toHaveBeenCalledTimes(1);
    expect(mocks.uninstallMock).toHaveBeenCalledWith(
      expect.objectContaining({ leaveForegroundRun: null }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ leftRunning: null });
  });

  // Test 3 (control): a live SERVICE-managed run (`admission: "granted"`)
  // under the label - not a foreground run, so `leaveForegroundRun: null`
  // here too.
  it("(control) a live SERVICE-managed run under the label passes leaveForegroundRun: null", async () => {
    await writeServiceManagedRun();

    const { serviceUninstallCommand } = await import("../service-uninstall");
    const result = await serviceUninstallCommand(fakeCtx());

    expect(mocks.uninstallMock).toHaveBeenCalledTimes(1);
    expect(mocks.uninstallMock).toHaveBeenCalledWith(
      expect.objectContaining({ leaveForegroundRun: null }),
    );
    expect(result.data).toMatchObject({ leftRunning: null });
  });
});

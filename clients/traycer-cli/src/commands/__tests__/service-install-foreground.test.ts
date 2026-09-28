import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { ServiceInstallArgs } from "../service-install";

// The ruling is "the desktop leaves a host that a
// person started in a terminal untouched; the mode governs the service run
// only." `buildServiceInstallCommand`'s `--takeover` path moves host
// management from Traycer Desktop to the CLI-owned service - but on current
// (unmodified) code it does this over ANY live host under the target
// service label, including one a person started with `traycer host start`
// in a terminal (a "foreground run" - see `../../host/foreground-host-run.ts`).
// Under `lifecycleOrigin: "desktop"`, that must instead be refused with
// `E_HOST_NOT_SERVICE_RUN`, exactly as `host stop`/`host restart`/
// `host free-port-and-restart` already refuse it
// (`refuseForegroundHostRun`/`foregroundRunRefusal`).
//
// `buildServiceInstallCommand` has no such guard today, and does not import
// `foreground-host-run.ts` at all (verified by reading `../service-install.ts`
// in full) - so `takeoverDesktopRegistrationWithAttempt` and
// `installHostServiceWithAttempt` (both from `../../host/update-mutation`,
// mocked below as spies) are today called unconditionally whenever
// `args.takeover` is true. That is the mechanism this suite's desktop-origin
// test proves RED against, before asserting the refusal shape.
//
// HOME isolation: this file follows `host-restart-foreground.test.ts`'s own
// fixture (a hoisted `vi.mock("node:os")` override of `homedir()`, NOT a
// partial `store/paths` mock) rather than `service-install.test.ts`'s
// existing pattern. `service-install.test.ts` mocks `../../store/paths`
// directly, hand-rolling `hostHomeDir` as `join(osHome.current, "host",
// environment)` instead of exercising the real `store/paths` module - a
// weaker isolation than the mandated form, since it never proves the real
// `hostHomeDir` resolves under the redirected home. It is still HOME-safe
// (the hand-rolled path is still under the per-test temp dir), but it is a
// discrepancy worth flagging, not a pattern to copy here.
//
// `store/paths` computes `TRAYCER_HOME` from `homedir()` ONCE AT MODULE
// LOAD, so redirecting `node:os` after `store/paths` has already been
// imported once in this process would not retarget it. Every module under
// test is therefore re-imported fresh via `vi.resetModules()` after the
// redirect (same pattern `host-restart-foreground.test.ts` and
// `host-restart.test.ts` already use for this reason), and `beforeEach`
// asserts `hostHomeDir()` itself resolves under this test's own temp HOME
// right after the reset - a positive proof the redirect took.
//
// "Live foreground run": real `supervisor.json` / `supervisor-run.json`
// records naming THIS TEST PROCESS's own pid and its own start identity, so
// `readLiveSupervisorRun` (inside `findForegroundHostRun`, left UNMOCKED)
// runs its genuine OS liveness/identity probe against a process that is
// actually alive. `findLiveIncumbentHost` (a live *host*, not a live
// *supervisor*) is mocked to report a fake reachable host - the same
// substitute `host-restart-foreground.test.ts` uses.
//
// `../../host/foreground-host-run.ts` itself is never mocked - the refusal
// this suite is proving RED will live there.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const mocks = vi.hoisted(() => ({
  takeoverMock: vi.fn(),
  installMock: vi.fn(),
  findLiveIncumbentHostMock: vi.fn(),
}));

vi.mock("../../host/update-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/update-mutation")>();
  return {
    ...actual,
    takeoverDesktopRegistrationWithAttempt: (
      ...callArgs: Parameters<typeof mocks.takeoverMock>
    ) => mocks.takeoverMock(...callArgs),
    installHostServiceWithAttempt: (
      ...callArgs: Parameters<typeof mocks.installMock>
    ) => mocks.installMock(...callArgs),
  };
});

// `createServiceController`/`resolveServiceCliInvocation` etc. must be
// mocked: the real controller does filesystem I/O against the operator's
// actual `~/.traycer` home, and the real invocation resolver reads the CLI
// manifest off disk. The controller object itself is never exercised for
// real here - `takeoverDesktopRegistrationWithAttempt`/
// `installHostServiceWithAttempt` are mocked wholesale above - so its shape
// only needs to satisfy the call signature.
vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: () => ({
      install: async () => undefined,
      takeoverDesktopRegistration: async () => ({
        kind: "cli-host-stopped" as const,
        cooperativeStop: "stopped" as const,
      }),
      hostStartAdoptionLabel: async (label: { id: string }) => label.id,
    }),
    resolveServiceCliInvocation: async () => ({
      command: "/usr/local/bin/traycer",
      args: [] as string[],
    }),
    serviceLabelFor: (environment: "dev" | "production") => ({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment,
      devSlot: null,
    }),
    serviceManifestPath: () => "/tmp/ai.traycer.host.plist",
    windowsTaskName: () => "ai.traycer.host",
  };
});

vi.mock("../../host/install-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/install-auth")>();
  return {
    ...actual,
    runSignInPreflight: async () => ({
      state: "signed-in" as const,
      reason: null,
    }),
    maybeProvisionCredential: async () => null,
  };
});

vi.mock("../../host/attested-install-runtime", () => ({
  attestInstallRuntime: async () => ({
    installGeneration: null,
    runtimeVersion: null,
    runtimeWasNull: false,
  }),
}));

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

vi.mock("../../host/incumbent-check", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/incumbent-check")>();
  return {
    ...actual,
    findLiveIncumbentHost: (environment: string | undefined) =>
      mocks.findLiveIncumbentHostMock(environment),
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

function hostRoot(): string {
  return join(workHome, ".traycer", "host");
}

function writeSupervisorRecordFile(pid: number): void {
  mkdirSync(hostRoot(), { recursive: true });
  writeFileSync(
    join(hostRoot(), "supervisor.json"),
    JSON.stringify(
      {
        v: 1,
        pid,
        cliVersion: "1.9.0",
        capabilities: ["lifecycle-policy-v1"],
        startedAt: "2026-09-01T00:00:00.000Z",
      },
      null,
      2,
    ),
    "utf8",
  );
}

function writeSupervisorRunStateFile(input: {
  readonly supervisorPid: number;
  readonly supervisorStartIdentity: string | null;
}): void {
  mkdirSync(hostRoot(), { recursive: true });
  writeFileSync(
    join(hostRoot(), "supervisor-run.json"),
    JSON.stringify(
      {
        v: 1,
        supervisorPid: input.supervisorPid,
        supervisorStartIdentity: input.supervisorStartIdentity,
        admission: "foreground",
        origin: null,
        adopted: false,
        lastPresence: null,
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
      null,
      2,
    ),
    "utf8",
  );
}

/** A REAL live foreground run: this test process's own pid and identity. */
async function writeLiveForegroundRun(): Promise<void> {
  const { ownProcessStartIdentity } =
    await import("../../store/process-identity");
  writeSupervisorRecordFile(process.pid);
  writeSupervisorRunStateFile({
    supervisorPid: process.pid,
    supervisorStartIdentity: ownProcessStartIdentity(),
  });
}

/**
 * A live SERVICE-managed host under the CLI-owned label - no foreground run
 * at all. `readLiveSupervisorRun` must see nothing (no supervisor records on
 * disk), so `findForegroundHostRun` resolves `null` purely from the missing
 * supervisor pairing, exactly as it does in production when the service
 * itself is the one running the host.
 */
function writeNoForegroundRun(): void {
  // Deliberately writes nothing under hostRoot(): the absence of
  // supervisor.json/supervisor-run.json is itself the fixture.
}

function baseArgs(overrides: Partial<ServiceInstallArgs>): ServiceInstallArgs {
  return {
    enableLinger: true,
    allowSelfInvocation: false,
    takeover: false,
    attemptAdoption: null,
    lifecycleOrigin: "terminal",
    ...overrides,
  };
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
  workHome = mkdtempSync(join(tmpdir(), "traycer-service-install-fg-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
  const { hostHomeDir } = await import("../../store/paths");
  expect(hostHomeDir("production").startsWith(workHome)).toBe(true);
  // Every test starts clean: `workHome` is a fresh `mkdtempSync` directory
  // each time, but this sweep guards against any supervisor records
  // surviving from a prior test's fixture under this resolved home, so a
  // later "no foreground run" control can never accidentally inherit an
  // earlier test's live foreground run.
  rmSync(hostHomeDir("production"), { recursive: true, force: true });
  mocks.takeoverMock.mockReset();
  mocks.takeoverMock.mockResolvedValue({
    kind: "cli-host-stopped",
    cooperativeStop: "stopped",
  });
  mocks.installMock.mockReset();
  mocks.installMock.mockResolvedValue(undefined);
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

describe("buildServiceInstallCommand - takeover over a foreground run", () => {
  // Test 1 (RED): `--takeover` with `lifecycleOrigin: "desktop"` over a live
  // foreground run must refuse before touching either mutation actuator.
  // RED on current code: no guard exists, so both actuators ARE called and
  // the mechanism assertions below fail first.
  it("desktop-origin takeover over a live foreground run refuses E_HOST_NOT_SERVICE_RUN without calling either actuator", async () => {
    await writeLiveForegroundRun();

    const { buildServiceInstallCommand } = await import("../service-install");
    const command = buildServiceInstallCommand(
      baseArgs({ takeover: true, lifecycleOrigin: "desktop" }),
    );
    const caught: unknown = await command(fakeCtx()).then(
      () => null,
      (err: unknown) => err,
    );

    expect(mocks.takeoverMock).not.toHaveBeenCalled();
    expect(mocks.installMock).not.toHaveBeenCalled();
    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
      details: { supervisorPid: process.pid, hostPid: LIVE_INCUMBENT_HOST.pid },
    });
    expect((caught as { message: string }).message).toContain(
      `host service install: the running host was started in a terminal (supervisor pid ${String(process.pid)}) and is not run by the service; stop it there with Ctrl-C`,
    );
  });

  // Test 2 (control, GREEN): the same live foreground run, but
  // `lifecycleOrigin: "terminal"` - the ruling's guard is specific to the
  // desktop mode, so a terminal-origin takeover proceeds exactly as today.
  // Must PASS on current (unmodified) code and remain passing after the fix.
  it("(control) terminal-origin takeover over the same live foreground run still proceeds through both actuators", async () => {
    await writeLiveForegroundRun();

    const { buildServiceInstallCommand } = await import("../service-install");
    const command = buildServiceInstallCommand(
      baseArgs({ takeover: true, lifecycleOrigin: "terminal" }),
    );
    const result = await command(fakeCtx());

    expect(mocks.takeoverMock).toHaveBeenCalledTimes(1);
    expect(mocks.installMock).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      takeover: { kind: "cli-host-stopped", cooperativeStop: "stopped" },
    });
  });

  // Test 3 (control, GREEN): `lifecycleOrigin: "desktop"`, but the running
  // host under the CLI-owned label is NOT a foreground run - no supervisor
  // records at all, i.e. the normal "the service already runs a host under
  // this label, takeover reloads it" case. The new guard must be unaffected:
  // this is the ordinary, currently-working takeover path. Must PASS on
  // current (unmodified) code and remain passing after the fix.
  it("(control) desktop-origin takeover with no foreground run present still proceeds through both actuators", async () => {
    writeNoForegroundRun();

    // Positively prove the premise before running the real call: no live
    // supervisor run at all under this resolved home, so this control is
    // not accidentally passing because it silently inherited a foreground
    // run left behind by an earlier test (or any other leftover state).
    const { readLiveSupervisorRun } =
      await import("../../host/live-supervisor-run");
    expect(await readLiveSupervisorRun("production")).toBeNull();

    const { buildServiceInstallCommand } = await import("../service-install");
    const command = buildServiceInstallCommand(
      baseArgs({ takeover: true, lifecycleOrigin: "desktop" }),
    );
    const result = await command(fakeCtx());

    expect(mocks.takeoverMock).toHaveBeenCalledTimes(1);
    expect(mocks.installMock).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      takeover: { kind: "cli-host-stopped", cooperativeStop: "stopped" },
    });
  });
});

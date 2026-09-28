import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { ServiceInstallArgs } from "../service-install";

// Plain install, no `--takeover`: the same ruling family as
// `service-install-foreground.test.ts` and `service-start-foreground.test.ts`,
// applied to a PLAIN `traycer host service install` - no `--takeover` at all.
// A live foreground run in the target slot must refuse `E_HOST_NOT_SERVICE_RUN`
// for BOTH `lifecycleOrigin` values, before any write: no platform `install`
// call, no plist/unit/task, no host-start-adoption grant published. `--force`
// is never offered here either.
//
// Head behaviour instead: `controller.install` runs unconditionally
// (bootout/bootstrap, `enable --now`, `/Create`+`/Run` depending on
// platform). The new supervisor it launches declines to the live incumbent
// (the foreground run), and - on a REAL controller - the command fails only
// after the full host-start-adoption acknowledgement wait
// (`HOST_START_ADOPTION_ACK_WAIT_MS`, `service/spawn-edge-bounds.ts`).
//
// KEY DIFFERENCE from `service-install-foreground.test.ts` (the `--takeover`
// suite): that file mocks `installHostServiceWithAttempt` itself wholesale.
// THIS file does NOT - the real facade (`host/update-mutation.ts:116`) runs,
// through the real `runWithHostStartAdoption` (`update-mutation.ts:364`) and
// the real `runWithLeaseAtServiceSpawnEdge` (`service/spawn-edge.ts:159`).
// Only the service CONTROLLER is mocked (`createServiceController` from
// `../../service`), with `install` as a bare `vi.fn()` that never calls
// `atServiceSpawnEdge()` internally (only the real platform controllers in
// `service/platforms/*` do, immediately before their actual OS launch call -
// see `spawn-edge.ts`'s module doc). Since the spawn-edge hook is armed
// around `start()` (`spawnEdgeHook.run(hook, start)`,
// `runWithLeaseAtServiceSpawnEdge`) but only INVOKED if something inside
// `start()` calls `atServiceSpawnEdge()`, a mocked `install` that never does
// so means the hook never fires, `held.lease` stays `null`, and
// `held.lease?.waitForSpawn()` short-circuits to a resolved `undefined` -
// no grant is ever published (`publishHostStartAdoption` never runs) and
// nothing waits on an acknowledgement. NOTHING beyond the controller mock
// was stubbed to make this true - it falls directly out of
// `runWithLeaseAtServiceSpawnEdge`'s own control flow, confirmed empirically
// below (no test here takes anywhere near the ack-wait bound to complete).
//
// HOME isolation: the same hoisted `node:os` + real `store/paths` +
// `vi.resetModules()` fixture as `service-install-foreground.test.ts`, with
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
// `../../host/foreground-host-run.ts` itself is never mocked - the refusal
// this suite is proving RED will live there.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const mocks = vi.hoisted(() => ({
  installMock: vi.fn(),
  hostStartAdoptionLabelMock: vi.fn(),
  findLiveIncumbentHostMock: vi.fn(),
}));

// `createServiceController`/`resolveServiceCliInvocation` etc. must be
// mocked: the real controller does filesystem I/O against the operator's
// actual `~/.traycer` home. `install` and `hostStartAdoptionLabel` are call
// recorders - the real `installHostServiceWithAttempt` facade (unmocked,
// unlike the `--takeover` suite) drives them for real.
vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: () => ({
      install: (...callArgs: Parameters<typeof mocks.installMock>) =>
        mocks.installMock(...callArgs),
      hostStartAdoptionLabel: (
        ...callArgs: Parameters<typeof mocks.hostStartAdoptionLabelMock>
      ) => mocks.hostStartAdoptionLabelMock(...callArgs),
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

/** The one-shot adoption grant file `publishHostStartAdoption` writes -
 * `.host-start-adoption.json` under the host home (`host-start-adoption.ts`'s
 * `HOST_START_ADOPTION_FILENAME`). A refused request must never publish it. */
function hostStartAdoptionFilePath(): string {
  return join(workHome, ".traycer", "host", ".host-start-adoption.json");
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
  workHome = mkdtempSync(
    join(tmpdir(), "traycer-service-install-plain-fg-test-"),
  );
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
  const { hostHomeDir } = await import("../../store/paths");
  expect(hostHomeDir("production").startsWith(workHome)).toBe(true);
  rmSync(hostHomeDir("production"), { recursive: true, force: true });
  mocks.installMock.mockReset();
  mocks.installMock.mockResolvedValue(undefined);
  mocks.hostStartAdoptionLabelMock.mockReset();
  mocks.hostStartAdoptionLabelMock.mockImplementation(
    async (label: { id: string }) => label.id,
  );
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

describe("buildServiceInstallCommand - plain install (no --takeover) over a foreground run", () => {
  // Test 1 (RED): desktop origin, plain install, live foreground run - must
  // refuse before any write: no `hostStartAdoptionLabel` resolution, no
  // `install` call, no adoption grant file. RED on current code: no guard
  // exists, so `installHostServiceWithAttempt` proceeds through the real
  // facade, calling `hostStartAdoptionLabel` and `install` unconditionally.
  it("desktop-origin plain install over a live foreground run refuses E_HOST_NOT_SERVICE_RUN before any write", async () => {
    await writeLiveForegroundRun();

    const { buildServiceInstallCommand } = await import("../service-install");
    const command = buildServiceInstallCommand(
      baseArgs({ lifecycleOrigin: "desktop" }),
    );
    const caught: unknown = await command(fakeCtx()).then(
      () => null,
      (err: unknown) => err,
    );

    expect(mocks.hostStartAdoptionLabelMock).not.toHaveBeenCalled();
    expect(mocks.installMock).not.toHaveBeenCalled();
    expect(existsSync(hostStartAdoptionFilePath())).toBe(false);
    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
      details: { supervisorPid: process.pid, hostPid: LIVE_INCUMBENT_HOST.pid },
    });
    const message = (caught as { message: string }).message;
    expect(message).toContain(
      "host service install: the running host was started in a terminal",
    );
    expect(message).toContain("then register the service");
    expect(message).not.toContain("--force");
  }, 20_000);

  // Test 2 (RED): same, terminal origin - identical refusal, no origin-based
  // escape. RED on current code for the same reason as test 1.
  it("terminal-origin plain install over the same live foreground run refuses identically - no origin-based escape", async () => {
    await writeLiveForegroundRun();

    const { buildServiceInstallCommand } = await import("../service-install");
    const command = buildServiceInstallCommand(
      baseArgs({ lifecycleOrigin: "terminal" }),
    );
    const caught: unknown = await command(fakeCtx()).then(
      () => null,
      (err: unknown) => err,
    );

    expect(mocks.hostStartAdoptionLabelMock).not.toHaveBeenCalled();
    expect(mocks.installMock).not.toHaveBeenCalled();
    expect(existsSync(hostStartAdoptionFilePath())).toBe(false);
    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
      details: { supervisorPid: process.pid, hostPid: LIVE_INCUMBENT_HOST.pid },
    });
    const message = (caught as { message: string }).message;
    expect(message).toContain(
      "host service install: the running host was started in a terminal",
    );
    expect(message).toContain("then register the service");
    expect(message).not.toContain("--force");
  }, 20_000);

  // Test 3 (control, GREEN): no foreground run present at all. Positive
  // premise proven first, then the install proceeds exactly as today. Must
  // PASS on current (unmodified) code and remain passing after the fix.
  it("(control) plain install with no foreground run present still proceeds through the actuator", async () => {
    const { readLiveSupervisorRun } =
      await import("../../host/live-supervisor-run");
    expect(await readLiveSupervisorRun("production")).toBeNull();

    const { buildServiceInstallCommand } = await import("../service-install");
    const result = await buildServiceInstallCommand(
      baseArgs({ lifecycleOrigin: "desktop" }),
    )(fakeCtx());

    expect(mocks.installMock).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
  }, 20_000);

  // Test 4 (control, GREEN): a live SERVICE-managed run (`admission:
  // "granted"`) under the label - the ordinary, currently-working "install
  // reaches an already-service-run host" case. The new guard must be
  // unaffected: no refusal fires, and the actuator is reached.
  it("(control) a live SERVICE-managed run under the label is never refused by the new guard", async () => {
    await writeServiceManagedRun();

    const { buildServiceInstallCommand } = await import("../service-install");
    const caught: unknown = await buildServiceInstallCommand(
      baseArgs({ lifecycleOrigin: "desktop" }),
    )(fakeCtx()).then(
      () => null,
      (err: unknown) => err,
    );

    if (caught !== null) {
      expect(caught).not.toMatchObject({
        code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
      });
    }
    expect(mocks.installMock).toHaveBeenCalledTimes(1);
  }, 20_000);
});

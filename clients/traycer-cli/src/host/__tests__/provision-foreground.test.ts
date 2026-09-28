import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { noopLogger } from "../../logger";
import type { RuntimeContext } from "../../runner/runtime";

// THE RULING: "The desktop leaves a host that a person started in a terminal
// untouched; the mode governs the service run only." Under
// `lifecycleOrigin: "desktop"`, `provisionHost` (`../provision.ts`) must
// refuse with `E_HOST_NOT_SERVICE_RUN` when the slot's running host is a
// FOREGROUND run (a live supervisor admitted `foreground` plus a live
// `pid.json` host - `../foreground-host-run.ts`), the same refusal
// `host restart`/`host stop` already give (`host-stop-foreground.test.ts`,
// `host-restart-foreground.test.ts`). `provisionHost` has no such guard on
// current, unmodified bytes: it proceeds straight through the install
// branch. This suite is RED against that gap.
//
// HOME SAFETY: a hoisted `node:os` mock redirects `homedir()` to a real temp
// directory for the whole file (verified against `hostHomeDir` in
// `beforeAll`), so every module that resolves `~/.traycer` under the hood
// (`store/paths.ts`, and the real `withUpdateContender` this suite does not
// mock - see below) never touches this machine's actual host state.
//
// MECHANISM: `findForegroundHostRun` (`../foreground-host-run.ts`, left
// UNMOCKED here, same as its sibling command suites) combines a live
// supervisor record (`readLiveSupervisorRun`, also unmocked - it runs its
// genuine OS liveness/identity probe against THIS TEST PROCESS's own pid)
// with a live incumbent host (`findLiveIncumbentHost`, mocked - a real
// reachable host is not needed to prove the guard). Only
// `host/incumbent-check` is mocked; `host/foreground-host-run.ts` itself is
// never mocked, since the refusal the fix adds lives there or is driven by
// it.
//
// Every other side-effecting module `provisionHost` touches (installer,
// service, service install-lifecycle, cli-lock, busy-check, host-start
// adoption, the store-format floor) is mocked exactly as
// `provision.test.ts` mocks it, so the install branch these tests drive with
// `force: true` never performs a real install, service mutation, or lock
// wait. The one thing this suite deliberately leaves real is
// `@traycer-clients/shared/host-update`'s `withUpdateContender` (reached via
// `../update-contender.ts`, also unmocked) - it resolves `hostHomeDir`
// itself and may `mkdir` it, which is exactly why the `node:os` redirect
// above has to be in place before any of this runs.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(actual.tmpdir(), "traycer-provision-foreground-test-home-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

beforeAll(async () => {
  const { hostHomeDir } = await import("../../store/paths");
  expect(osHome.current).not.toBe("");
  expect(hostHomeDir("production").startsWith(osHome.current)).toBe(true);
});

afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

const mocks = vi.hoisted(() => ({
  stageHostInstallSourceMock: vi.fn(),
  commitHostInstallSourceMock: vi.fn(),
  discardStagedHostInstallSourceMock: vi.fn(),
  readHostInstallRecordMock: vi.fn(),
  createServiceControllerMock: vi.fn(),
  serviceLabelForMock: vi.fn(),
  createServiceInstallLifecycleMock: vi.fn(),
  createBytesOnlyInstallLifecycleMock: vi.fn(),
  assertHostNotBusyMock: vi.fn(),
  resolveServiceCliInvocationMock: vi.fn(),
  gateStoreFormatFloorMock: vi.fn(),
  findLiveIncumbentHostMock: vi.fn(),
}));

vi.mock("../../installer", () => ({
  NO_INSTALL_PHASE_HOOKS: {
    beforeSwapCommit: async () => {},
    afterSwap: async () => {},
  },
  stageHostInstallSource: (
    ...callArgs: Parameters<typeof mocks.stageHostInstallSourceMock>
  ) => mocks.stageHostInstallSourceMock(...callArgs),
  commitHostInstallSource: (
    ...callArgs: Parameters<typeof mocks.commitHostInstallSourceMock>
  ) => mocks.commitHostInstallSourceMock(...callArgs),
  discardStagedHostInstallSource: (
    ...callArgs: Parameters<typeof mocks.discardStagedHostInstallSourceMock>
  ) => mocks.discardStagedHostInstallSourceMock(...callArgs),
}));

// `commitHostInstallSourceWithAttempt` imports `commitHostInstallSource`
// straight from `../../installer/install`, bypassing the barrel above.
vi.mock("../../installer/install", () => ({
  commitHostInstallSource: (
    ...callArgs: Parameters<typeof mocks.commitHostInstallSourceMock>
  ) => mocks.commitHostInstallSourceMock(...callArgs),
}));

vi.mock("../../manifest/host-install", () => ({
  readHostInstallRecord: mocks.readHostInstallRecordMock,
}));

vi.mock("../store-format-floor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store-format-floor")>();
  return {
    ...actual,
    gateStoreFormatFloor: (
      ...callArgs: Parameters<typeof mocks.gateStoreFormatFloorMock>
    ) => mocks.gateStoreFormatFloorMock(...callArgs),
  };
});

vi.mock("../../service", () => ({
  createServiceController: mocks.createServiceControllerMock,
  serviceLabelFor: mocks.serviceLabelForMock,
}));

vi.mock("../../service/cli-binary", () => ({
  resolveServiceCliInvocation: mocks.resolveServiceCliInvocationMock,
}));

vi.mock("../../service/install-lifecycle", () => ({
  createServiceInstallLifecycle: mocks.createServiceInstallLifecycleMock,
  createBytesOnlyInstallLifecycle: mocks.createBytesOnlyInstallLifecycleMock,
}));

vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return {
    ...actual,
    withCliLock: async <T>(_opts: unknown, fn: () => Promise<T>): Promise<T> =>
      fn(),
  };
});

vi.mock("../busy-check", () => ({
  assertHostNotBusy: mocks.assertHostNotBusyMock,
}));

vi.mock("../host-start-adoption", () => ({
  publishHostStartAdoption: async () => ({
    waitForSpawn: async () => undefined,
    cancel: async () => undefined,
  }),
}));

// The one seam this suite adds beyond `provision.test.ts`'s own scaffold:
// `findLiveIncumbentHost` mocked, `host/foreground-host-run.ts` and
// `readLiveSupervisorRun` left real.
vi.mock("../incumbent-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../incumbent-check")>();
  return {
    ...actual,
    findLiveIncumbentHost: (environment: string | undefined) =>
      mocks.findLiveIncumbentHostMock(environment),
  };
});

const {
  stageHostInstallSourceMock,
  commitHostInstallSourceMock,
  discardStagedHostInstallSourceMock,
  readHostInstallRecordMock,
  createServiceControllerMock,
  serviceLabelForMock,
  createServiceInstallLifecycleMock,
  createBytesOnlyInstallLifecycleMock,
  assertHostNotBusyMock,
  resolveServiceCliInvocationMock,
  gateStoreFormatFloorMock,
  findLiveIncumbentHostMock,
} = mocks;

import { provisionHost, type ProvisionHostOptions } from "../provision";
import { CLI_ERROR_CODES } from "../../runner/errors";
import type { HostInstallRecord } from "../../manifest/host-install";
import type { StagedHostInstallSource } from "../../installer";
import { hostHomeDir } from "../../store/paths";
import { readLiveSupervisorRun } from "../live-supervisor-run";

const LIVE_INCUMBENT_HOST = {
  pid: 55_555,
  version: "1.9.0",
  websocketUrl: "ws://127.0.0.1:55555/rpc",
};

function hostRoot(): string {
  return join(osHome.current, ".traycer", "host");
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
 * Remove any supervisor records - "no foreground run present". Wipes the
 * whole per-environment host home (`hostHomeDir("production")`, the same
 * directory `readLiveSupervisorRun`/`findForegroundHostRun` resolve their
 * records from) rather than just the two known filenames, so a leftover
 * record from an earlier test in this file's shared temp HOME can never
 * survive into the next test.
 */
function clearSupervisorRecords(): void {
  rmSync(hostHomeDir("production"), { recursive: true, force: true });
}

function makeRuntime(): RuntimeContext {
  return {
    json: false,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: "production",
    logger: noopLogger,
  };
}

function sampleRecord(version: string): HostInstallRecord {
  return {
    installId: `install-${version}`,
    version,
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry", value: version },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: "/tmp/traycer-host",
    executableSha256: null,
  };
}

function sampleStaged(version: string): StagedHostInstallSource {
  return {
    stagingDir: "/tmp/staging-dir",
    archivePath: "/tmp/staging-dir/archive.tar.gz",
    archiveIsTemporary: true,
    executablePath: "/tmp/staging-dir/traycer-host",
    version,
    runtimeVersion: null,
    source: { kind: "registry", value: version },
    archiveSha256: "b".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
  };
}

function runningController() {
  return {
    status: async () => ({
      state: "running" as const,
      version: "host",
      listenUrl: "ws://127.0.0.1:7100/rpc",
      pid: 4242,
    }),
    install: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    hostStartAdoptionLabel: vi.fn(async (label: { id: string }) => label.id),
  };
}

function makeOpts(
  overrides: Partial<ProvisionHostOptions>,
): ProvisionHostOptions {
  return {
    runtime: makeRuntime(),
    resolveInstallSource: async () => ({
      kind: "registry",
      versionRequest: "2.0.0",
    }),
    satisfaction: { kind: "exact", version: "2.0.0" },
    recordVersionOverride: null,
    enableLinger: true,
    allowSelfInvocation: true,
    registerService: true,
    lockReason: "test-provision-foreground",
    onProgress: null,
    force: false,
    acceptStoreFormatLoss: false,
    yankLookup: { isVersionYanked: async () => false },
    holdExplicitDowngrade: false,
    adoption: undefined,
    lifecycleOrigin: "terminal",
    beforeMutate: null,
    supervisorRelaunchWait: null,
    ...overrides,
  };
}

const EXPECTED_MESSAGE_FRAGMENT =
  "host ensure: the running host was started in a terminal (supervisor pid ";

beforeEach(() => {
  clearSupervisorRecords();
  vi.clearAllMocks();
  serviceLabelForMock.mockReturnValue({
    id: "ai.traycer.host",
    environment: "production",
  });
  createServiceControllerMock.mockReturnValue(runningController());
  assertHostNotBusyMock.mockResolvedValue(undefined);
  discardStagedHostInstallSourceMock.mockResolvedValue(undefined);
  createServiceInstallLifecycleMock.mockReturnValue({
    state: {
      priorState: "not-installed",
      stoppedBeforeSwap: false,
      postSwapAction: "install",
      postSwapError: null,
      postSwapWarning: null,
    },
    lifecycle: {
      beforeSwap: async () => {},
      beforeSwapCommit: async () => {},
      afterSwap: async () => {},
      restartAfterAbortedSwap: async () => {},
      swapLockRecovery: null,
    },
  });
  createBytesOnlyInstallLifecycleMock.mockReturnValue({
    setMutationVerifier: () => {},
    beforeSwap: async () => {},
    beforeSwapCommit: async () => {},
    afterSwap: async () => {},
    restartAfterAbortedSwap: async () => {},
    swapLockRecovery: null,
  });
  resolveServiceCliInvocationMock.mockResolvedValue({
    command: "/usr/local/bin/traycer",
    args: [],
  });
  gateStoreFormatFloorMock.mockResolvedValue({
    clearedVersion: null,
    publishedStoreFormats: null,
    acceptStoreFormatLoss: false,
    site: "host ensure",
  });
  readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.0.0"));
  stageHostInstallSourceMock.mockResolvedValue(sampleStaged("2.0.0"));
  commitHostInstallSourceMock.mockResolvedValue({
    record: sampleRecord("2.0.0"),
    previous: sampleRecord("1.0.0"),
    installGeneration: "id:install-2.0.0",
  });
  findLiveIncumbentHostMock.mockReset();
  findLiveIncumbentHostMock.mockResolvedValue(LIVE_INCUMBENT_HOST);
});

describe("provisionHost - foreground-run guard", () => {
  // Test 1: desktop-origin refusal, mechanism-first. RED on current code -
  // `provisionHost` has no foreground-run check at all, so it proceeds
  // straight through `prepareInstallStage` (`stageHostInstallSource`) and the
  // busy guard (skipped here anyway because `force: true` also skips it -
  // see the comment on that assertion below) into a completed install.
  it("rejects E_HOST_NOT_SERVICE_RUN over a live foreground run with lifecycleOrigin 'desktop', never staging or committing", async () => {
    await writeLiveForegroundRun();

    const caught: unknown = await provisionHost(
      makeOpts({ lifecycleOrigin: "desktop", force: true }),
    ).then(
      () => null,
      (err: unknown) => err,
    );

    // The install branch's own work never ran - the tell that the refusal
    // fired before `prepareInstallStage`/`provisionUnderLock`, not after a
    // completed (and then discarded) install.
    expect(stageHostInstallSourceMock).not.toHaveBeenCalled();
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
    // `force: true` already skips the busy guard on its own (see
    // `provision.ts`'s `if (!opts.force) { ... assertHostNotBusy ... }`), so
    // this assertion holds independent of the fix; it is included because
    // the brief asks for it, and it stays true once the guard is added
    // earlier still.
    expect(assertHostNotBusyMock).not.toHaveBeenCalled();
    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
      details: {
        supervisorPid: process.pid,
        hostPid: LIVE_INCUMBENT_HOST.pid,
      },
    });
    expect((caught as { message: string }).message).toContain(
      `${EXPECTED_MESSAGE_FRAGMENT}${process.pid})`,
    );
    expect((caught as { message: string }).message).toContain(
      "and is not run by the service; stop it there with Ctrl-C",
    );
  });

  // Test 2 (control): the exact same live foreground run, but
  // `lifecycleOrigin: "terminal"` - proceeds to a completed install exactly
  // as it does today. Must PASS on current code AND after the fix, proving
  // the fixture (live foreground run + mocked incumbent host) is not itself
  // what makes test 1 fail.
  it("(control) lifecycleOrigin 'terminal' proceeds through the install branch over the same live foreground run", async () => {
    await writeLiveForegroundRun();

    const result = await provisionHost(
      makeOpts({ lifecycleOrigin: "terminal", force: true }),
    );

    expect(result.action).toBe("installed");
    expect(stageHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
  });

  // Test 3 (control): `lifecycleOrigin: "desktop"`, but NO foreground run
  // present - proceeds exactly as it does today, on current code and after
  // the fix.
  it("(control) lifecycleOrigin 'desktop' proceeds through the install branch when there is no foreground run", async () => {
    findLiveIncumbentHostMock.mockResolvedValue(null);

    // Positively prove the premise - no live supervisor record survives
    // `beforeEach`'s cleanup - before relying on it below. Without this, a
    // leftover `supervisor.json`/`supervisor-run.json` from an earlier test
    // could make this control pass (or, after the guard lands, fail) for the
    // wrong reason.
    expect(await readLiveSupervisorRun("production")).toBeNull();

    const result = await provisionHost(
      makeOpts({ lifecycleOrigin: "desktop", force: true }),
    );

    expect(result.action).toBe("installed");
    expect(stageHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
  });

  // Test 4 (control): `lifecycleOrigin: "desktop"`, `registerService: false`
  // (the bytes-only path the desktop itself uses, since it registers the
  // macOS login item via SMAppService) over a live foreground run -
  // unaffected by the guard: the CLI never touches the OS service on this
  // path, so there is no service run for the guard to protect.
  it("(control) registerService: false proceeds unaffected over a live foreground run with lifecycleOrigin 'desktop'", async () => {
    await writeLiveForegroundRun();

    const result = await provisionHost(
      makeOpts({
        lifecycleOrigin: "desktop",
        force: true,
        registerService: false,
      }),
    );

    expect(result.action).toBe("installed");
    expect(stageHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(createBytesOnlyInstallLifecycleMock).toHaveBeenCalledTimes(1);
    expect(createServiceInstallLifecycleMock).not.toHaveBeenCalled();
  });

  // Test 5 (control): `lifecycleOrigin: "desktop"`, a satisfied no-op
  // (nothing to install, no `--force`) over a live foreground run - the
  // lock-free fast path returns before `provisionHost` ever decides to touch
  // anything, so there is nothing for the guard to refuse.
  it("(control) a satisfied no-op never refuses, even with lifecycleOrigin 'desktop' over a live foreground run", async () => {
    await writeLiveForegroundRun();
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));

    const result = await provisionHost(
      makeOpts({
        lifecycleOrigin: "desktop",
        force: false,
        satisfaction: { kind: "exact", version: "2.0.0" },
      }),
    );

    expect(result.action).toBe("noop");
    expect(stageHostInstallSourceMock).not.toHaveBeenCalled();
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
  });

  // Test 6, THE LADDER: the same live foreground run refuses (step A, same
  // shape as test 1, lighter assertions since test 1 already proves the full
  // mechanism), and once that foreground run is gone (step B), the SAME
  // `provisionHost` call with the SAME `lifecycleOrigin: "desktop"` options
  // proceeds and actually commits an install. Both steps run against real
  // on-disk state (or its absence) in this one test - this is what makes the
  // ladder's overall RED-ness the same fact as test 1's: step A fails to
  // refuse on current code.
  it("refuses while the foreground run is live, then proceeds and installs once it is gone (same options, same call)", async () => {
    await writeLiveForegroundRun();

    // Step A: live foreground run -> refuses.
    const caughtA: unknown = await provisionHost(
      makeOpts({ lifecycleOrigin: "desktop", force: true }),
    ).then(
      () => null,
      (err: unknown) => err,
    );
    expect(caughtA).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
    });
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();

    // Step B: the foreground run is gone - remove the real supervisor
    // records step A wrote (so `readLiveSupervisorRun` itself reports no
    // live supervisor, not just a mocked-away incumbent host) AND
    // reconfigure `findLiveIncumbentHost` to report no live host, covering
    // both halves `findForegroundHostRun` combines. The SAME
    // lifecycleOrigin/force/satisfaction options that refused in step A now
    // reach the install branch and actually commit.
    clearSupervisorRecords();
    findLiveIncumbentHostMock.mockResolvedValue(null);

    const resultB = await provisionHost(
      makeOpts({ lifecycleOrigin: "desktop", force: true }),
    );

    expect(resultB.action).toBe("installed");
    expect(resultB.version).toBe("2.0.0");
    expect(commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(stageHostInstallSourceMock).toHaveBeenCalledTimes(1);
  });

  // Test 7: the SECOND refusal site. `provisionInSegment`'s guard (site (a))
  // only fires on a PREDICTED install - it runs before `prepareInstallStage`,
  // gated on the lock-free fast read. When the fast read predicts "no
  // install needed" (already installed at the target version, just not
  // registered+running), no staging happens and `provisionUnderLock`'s own
  // locked RE-READ is what can still discover stale bytes (a genuinely
  // concurrent actor, or - as staged here - the fast read simply not being
  // the full satisfaction story). `provisionUnderLock` must refuse there too,
  // before its busy guard, using the SAME live-foreground-run evidence -
  // site (a) alone would miss this path entirely, since `predictedInstall`
  // is false and site (a)'s check never runs.
  //
  // Sequenced via `readHostInstallRecordMock.mockResolvedValueOnce` twice:
  // call 1 feeds the lock-free fast `readProvisionState` (`provision.ts`
  // line ~314, before any lock), call 2 feeds the locked re-read inside
  // `provisionUnderLock` (`provision.ts` line ~646). The controller's
  // `status()` is held at "stopped" for both reads (registered, not
  // running) so `isSatisfied` is false at the fast read for a reason OTHER
  // than the version (drives `predictedInstall` to false via the
  // register/start path, not the install path), while the locked re-read's
  // STALE version ("1.0.0" against a "2.0.0" target) is what turns this into
  // an install after all.
  it("a desktop ensure refuses an install the locked re-read finds, even when the fast path predicted none", async () => {
    await writeLiveForegroundRun();
    createServiceControllerMock.mockReturnValue({
      status: async () => ({
        state: "stopped" as const,
        version: "host",
        listenUrl: null,
        pid: null,
      }),
      install: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      hostStartAdoptionLabel: vi.fn(async (label: { id: string }) => label.id),
    });
    // Call 1 (fast, lock-free): installed AT the target version - satisfied
    // version-wise, so `predictedInstall` is false (only the not-running
    // service state fails `isSatisfied` overall).
    readHostInstallRecordMock.mockResolvedValueOnce(sampleRecord("2.0.0"));
    // Call 2 (the locked re-read): stale bytes - the install branch is now
    // required, discovered only once the lock is held.
    readHostInstallRecordMock.mockResolvedValueOnce(sampleRecord("1.0.0"));

    const caught: unknown = await provisionHost(
      makeOpts({
        lifecycleOrigin: "desktop",
        force: false,
        registerService: true,
        satisfaction: { kind: "exact", version: "2.0.0" },
      }),
    ).then(
      () => null,
      (err: unknown) => err,
    );

    // Mechanism first: the locked re-read's own install-branch work never
    // ran - proof the refusal fired before the busy guard, not after it.
    expect(assertHostNotBusyMock).not.toHaveBeenCalled();
    expect(stageHostInstallSourceMock).not.toHaveBeenCalled();
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
      details: {
        supervisorPid: process.pid,
        hostPid: LIVE_INCUMBENT_HOST.pid,
      },
    });
  });
});

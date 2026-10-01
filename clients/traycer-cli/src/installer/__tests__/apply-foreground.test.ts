import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The `applyHost` leg: "The desktop leaves
// a host that a person started in a terminal untouched; the mode governs the
// service run only." `applyHost` (`../apply.ts`) has NO `lifecycleOrigin`
// field and NO foreground-run guard on current, unmodified bytes - confirmed
// by reading the whole file. Every desktop-origin test below is RED on head
// for that reason: nothing rejects, so the call proceeds straight through to
// the busy check and the service lifecycle exactly as a `terminal`-origin
// call would.
//
// Fixture technique copied from `../../commands/__tests__/host-restart-
// foreground.test.ts` (this file's exact template, per the brief): a REAL
// live foreground run is staged as real `supervisor.json` / `supervisor-
// run.json` records naming THIS TEST PROCESS's own pid and start identity,
// so `readLiveSupervisorRun` (reached through `findForegroundHostRun`,
// imported from `../../host/foreground-host-run` and left completely
// UNMOCKED) runs its genuine OS liveness/identity probe against a process
// that is actually alive. Only `findLiveIncumbentHost`
// (`../../host/incumbent-check`) is mocked, to report a fake reachable host
// standing in for the foreground run's own "host" half.
//
// HOME isolation, per the brief's mandatory template: `node:os`'s `homedir`
// is hoisted-mocked to a fresh `mkdtempSync` directory, and `store/paths` is
// left COMPLETELY UNMOCKED (unlike `apply.test.ts`'s own sandbox, which
// replaces `hostHomeDir` outright with a custom, non-`~/.traycer` layout).
// That is deliberate here: `findForegroundHostRun` reads `supervisor.json` /
// `supervisor-run.json` through the REAL `hostHomeDir(environment)`, so
// this suite's fixture must write those files under the REAL path shape
// (`<home>/.traycer/host/...`) for the unmocked reader to find them - a
// custom sandbox layout would make the supervisor files invisible to it.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(actual.tmpdir(), "traycer-apply-foreground-test-home-"),
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
  busyCalls: [] as Array<string | undefined>,
  lifecycleCalls: [] as Array<{ bootstrap: unknown; force: boolean }>,
  lifecyclePostSwapAction: "restart" as
    | "restart"
    | "start"
    | "install"
    | "none",
  findLiveIncumbentHostMock: vi.fn(),
  serviceManagerMayRespawnMock: vi.fn(),
}));

// `observeSwapQuiescence` (`installer/install.ts`'s own commit tail, NOT
// gated by the `service/install-lifecycle` mock below) asks
// `serviceManagerMayRespawn` for real when unmocked, which shells out to
// `launchctl print` / `systemctl --user is-active` - exactly the kind of
// real-machine contact this whole suite exists to avoid. `false` matches
// `apply.test.ts`'s own choice: an ordinary quiescent machine.
vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    serviceManagerMayRespawn: (
      ...callArgs: Parameters<typeof actual.serviceManagerMayRespawn>
    ) => mocks.serviceManagerMayRespawnMock(...callArgs),
  };
});
mocks.serviceManagerMayRespawnMock.mockResolvedValue(false);

vi.mock("../../host/busy-check", () => ({
  assertHostNotBusy: async (environment: string | undefined) => {
    mocks.busyCalls.push(environment);
  },
}));

vi.mock("../../service/install-lifecycle", () => ({
  createServiceInstallLifecycle: (options: {
    bootstrap: unknown;
    force: boolean;
    onWillStopHost: (() => void) | null;
    hooks: {
      beforeSwapCommit: () => Promise<void>;
      afterSwap: () => Promise<void>;
    };
  }) => {
    mocks.lifecycleCalls.push({
      bootstrap: options.bootstrap,
      force: options.force,
    });
    const state = {
      priorState: "running" as const,
      stoppedBeforeSwap: false,
      postSwapAction: "none" as "restart" | "start" | "install" | "none",
      postSwapError: null as string | null,
      postSwapWarning: null,
    };
    return {
      state,
      lifecycle: {
        setHostStartAdoptionPublisher: () => {},
        beforeSwap: async () => {
          state.stoppedBeforeSwap = true;
        },
        beforeSwapCommit: () => options.hooks.beforeSwapCommit(),
        afterSwap: async () => {
          await options.hooks.afterSwap();
          state.postSwapAction = mocks.lifecyclePostSwapAction;
          state.postSwapError = null;
        },
        swapLockRecovery: null,
      },
    };
  },
}));

// Per the brief: mock ONLY `findLiveIncumbentHost` here. `readLiveSupervisorRun`
// (this module re-exports nothing that touches it) stays completely real.
vi.mock("../../host/incumbent-check", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/incumbent-check")>();
  return {
    ...actual,
    findLiveIncumbentHost: (environment: string | undefined) =>
      mocks.findLiveIncumbentHostMock(environment),
  };
});

import { applyHost as applyHostRaw, type ApplyHostOptions } from "../apply";
import { findForegroundHostRun } from "../../host/foreground-host-run";
import {
  NO_INSTALL_PHASE_HOOKS,
  currentInstallArch,
  currentInstallPlatform,
} from "../install";
import { CLI_ERROR_CODES } from "../../runner/errors";
import { hostHomeDir, hostInstallDir, hostStagedDir } from "../../store/paths";
import {
  writeHostInstallRecord,
  readHostInstallRecord,
  type HostInstallRecord,
} from "../../manifest/host-install";
import {
  HOST_STAGED_RECORD_SCHEMA_VERSION,
  writeHostStagedRecordAt,
  type HostStagedRecord,
} from "../../manifest/host-staged";

const ENV = "production" as const;

const LIVE_INCUMBENT_HOST = {
  pid: 55_555,
  version: "1.9.0",
  websocketUrl: "ws://127.0.0.1:55555/rpc",
};

function installDirFor(): string {
  return hostInstallDir(ENV);
}
function stagedDirFor(): string {
  return hostStagedDir(ENV);
}

async function writeInstall(
  version: string,
  overrides: Partial<HostInstallRecord>,
): Promise<HostInstallRecord> {
  const installDir = installDirFor();
  mkdirSync(installDir, { recursive: true });
  const executablePath = join(installDir, "traycer-host");
  writeFileSync(executablePath, "binary");
  const record: HostInstallRecord = {
    installId: null,
    version,
    runtimeVersion: null,
    platform: currentInstallPlatform(),
    arch: currentInstallArch(),
    installedAt: new Date().toISOString(),
    source: { kind: "registry", value: version },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: new Date().toISOString(),
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath,
    executableSha256: null,
    ...overrides,
  };
  await writeHostInstallRecord(ENV, record);
  return record;
}

async function writeStaged(
  version: string,
  overrides: Partial<HostStagedRecord>,
): Promise<HostStagedRecord> {
  const stagedDir = stagedDirFor();
  mkdirSync(stagedDir, { recursive: true });
  const executableRelPath = "traycer-host";
  writeFileSync(join(stagedDir, executableRelPath), "binary");
  const record: HostStagedRecord = {
    schemaVersion: HOST_STAGED_RECORD_SCHEMA_VERSION,
    stageId: overrides.stageId ?? "test-stage-id",
    version,
    runtimeVersion: null,
    archiveSha256: "b".repeat(64),
    sizeBytes: 1,
    source: { kind: "registry", value: version },
    signatureKeyId: "test-key",
    signatureVerifiedAt: new Date().toISOString(),
    executablePath: executableRelPath,
    platform: currentInstallPlatform(),
    arch: currentInstallArch(),
    executableSha256: null,
    ...overrides,
  };
  await writeHostStagedRecordAt(stagedDir, record);
  return record;
}

/** A REAL live foreground run: this test process's own pid and identity. */
async function writeLiveForegroundRun(): Promise<void> {
  const { ownProcessStartIdentity } =
    await import("../../store/process-identity");
  const root = hostHomeDir(ENV);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "supervisor.json"),
    JSON.stringify(
      {
        v: 1,
        pid: process.pid,
        cliVersion: "1.9.0",
        capabilities: ["lifecycle-policy-v1"],
        startedAt: "2026-09-01T00:00:00.000Z",
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(root, "supervisor-run.json"),
    JSON.stringify(
      {
        v: 1,
        supervisorPid: process.pid,
        supervisorStartIdentity: ownProcessStartIdentity(),
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

const testMutationVerifier = async (): Promise<void> => undefined;
type ApplyOptions = ApplyHostOptions & { readonly lifecycleOrigin?: string };
type ApplyDefaultedOptions =
  | "verifyMutationCapability"
  | "expectedStagedVersion"
  | "onWillCommitStaged"
  | "onWillDisruptHost"
  | "hooks"
  | "acceptStoreFormatLoss";
function applyHost(
  options: Omit<ApplyOptions, ApplyDefaultedOptions> &
    Partial<Pick<ApplyOptions, ApplyDefaultedOptions>>,
): Promise<import("../apply").ApplyHostOutcome> {
  return applyHostRaw({
    ...options,
    verifyMutationCapability:
      options.verifyMutationCapability ?? testMutationVerifier,
    expectedStagedVersion: options.expectedStagedVersion ?? null,
    onWillCommitStaged: options.onWillCommitStaged ?? null,
    onWillDisruptHost: options.onWillDisruptHost ?? null,
    hooks: options.hooks ?? NO_INSTALL_PHASE_HOOKS,
    acceptStoreFormatLoss: options.acceptStoreFormatLoss ?? false,
  } as ApplyHostOptions);
}

beforeEach(() => {
  // Clean slate: the per-FILE hoisted temp HOME (`osHome.current`) is shared
  // across every test in this file, so a prior test's `supervisor.json` /
  // `supervisor-run.json` (or install/staged trees) would otherwise still be
  // sitting there when the next test runs - making a "no foreground run"
  // control accidentally pass (or, now that the guard exists, fail) for the
  // wrong reason: a leftover fixture, not this test's own setup.
  rmSync(hostHomeDir(ENV), { recursive: true, force: true });
  mocks.busyCalls = [];
  mocks.lifecycleCalls = [];
  mocks.lifecyclePostSwapAction = "restart";
  mocks.findLiveIncumbentHostMock.mockReset();
  mocks.findLiveIncumbentHostMock.mockResolvedValue(LIVE_INCUMBENT_HOST);
});

afterEach(() => {
  rmSync(hostHomeDir(ENV), { recursive: true, force: true });
});

describe("applyHost - foreground-run guard", () => {
  // Test 1: desktop-origin refusal. RED on head - `ApplyHostOptions` has no
  // `lifecycleOrigin` field and no guard reads a foreground run, so the call
  // proceeds straight to the busy check and the service lifecycle instead of
  // rejecting. Mechanism asserted FIRST (busy probe / lifecycle untouched),
  // then the rejection code + details + message, mirroring `host-restart-
  // foreground.test.ts`'s ordering.
  it("rejects E_HOST_NOT_SERVICE_RUN over a live foreground run with lifecycleOrigin 'desktop', never probing busy or touching the service lifecycle", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", {});
    await writeLiveForegroundRun();

    const caught: unknown = await applyHost({
      environment: ENV,
      force: false,
      noService: false,
      expectedStageFingerprint: null,
      onProgress: () => {},
      lifecycleOrigin: "desktop",
    } as Parameters<typeof applyHost>[0]).then(
      () => null,
      (err: unknown) => err,
    );

    expect(mocks.busyCalls).toEqual([]);
    expect(mocks.lifecycleCalls).toEqual([]);
    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
      details: { supervisorPid: process.pid, hostPid: LIVE_INCUMBENT_HOST.pid },
    });
    expect((caught as { message: string }).message).toContain(
      `host apply: the running host was started in a terminal (supervisor pid ${String(process.pid)}) and is not run by the service; stop it there with Ctrl-C`,
    );

    // Nothing was touched: the stage is intact and the install unchanged.
    expect(existsSync(stagedDirFor())).toBe(true);
    const stored = await readHostInstallRecord(ENV);
    expect(stored?.version).toBe("1.0.0");
  });

  // Control 2 (GREEN on head): `lifecycleOrigin: "terminal"` over the same
  // fixture proceeds exactly as today - a plain apply that reaches the busy
  // check and completes.
  it("(control) lifecycleOrigin 'terminal' still applies normally over the same live foreground run", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", {});
    await writeLiveForegroundRun();

    const result = await applyHost({
      environment: ENV,
      force: false,
      noService: false,
      expectedStageFingerprint: null,
      onProgress: () => {},
      lifecycleOrigin: "terminal",
    } as Parameters<typeof applyHost>[0]);

    expect(mocks.busyCalls).toEqual([ENV]);
    expect(result.outcome).toBe("applied");
    if (result.outcome === "applied") {
      expect(result.record.version).toBe("2.0.0");
    }
  });

  // Control 3 (GREEN on head): `lifecycleOrigin: "desktop"` with NO
  // foreground run present (no supervisor records at all) proceeds as today.
  it("(control) lifecycleOrigin 'desktop' with no foreground run present still applies normally", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", {});
    // No `writeLiveForegroundRun()` here: no supervisor.json / supervisor-
    // run.json at all. Positively prove the premise BEFORE the real call,
    // rather than trusting the absence of a `writeLiveForegroundRun()` call
    // plus the shared per-file temp HOME's cleanliness: the same real reader
    // `applyHost`'s guard uses (`findForegroundHostRun`, unmocked) must
    // itself see nothing here.
    expect(await findForegroundHostRun(ENV)).toBeNull();

    const result = await applyHost({
      environment: ENV,
      force: false,
      noService: false,
      expectedStageFingerprint: null,
      onProgress: () => {},
      lifecycleOrigin: "desktop",
    } as Parameters<typeof applyHost>[0]);

    expect(mocks.busyCalls).toEqual([ENV]);
    expect(result.outcome).toBe("applied");
  });

  // Control 4 (GREEN on head): the `--no-service` bytes-only path is
  // unaffected by the new guard even over a live foreground run - it must
  // remain reachable for the desktop's own packaged-macOS apply, which is
  // exactly the caller this ruling's guard must not break.
  it("(control) lifecycleOrigin 'desktop' with noService: true applies normally even over a live foreground run", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", {});
    await writeLiveForegroundRun();

    const result = await applyHost({
      environment: ENV,
      force: false,
      noService: true,
      expectedStageFingerprint: null,
      onProgress: () => {},
      lifecycleOrigin: "desktop",
    } as Parameters<typeof applyHost>[0]);

    expect(mocks.busyCalls).toEqual([]);
    expect(mocks.lifecycleCalls).toEqual([]);
    expect(result.outcome).toBe("applied");
    if (result.outcome === "applied") {
      expect(result.runningActivated).toBe(false);
      expect(result.serviceLifecycle).toBeNull();
    }
  });

  // Control 5 (GREEN on head): a genuine no-op apply (nothing staged) with
  // `lifecycleOrigin: "desktop"` over a live foreground run never refuses,
  // since nothing would happen anyway - the guard must not fire on a path
  // that touches nothing.
  it("(control) lifecycleOrigin 'desktop' with nothing staged (no-op) never refuses, even over a live foreground run", async () => {
    await writeInstall("1.0.0", {});
    // No `writeStaged` call: nothing staged.
    await writeLiveForegroundRun();

    const result = await applyHost({
      environment: ENV,
      force: false,
      noService: false,
      expectedStageFingerprint: null,
      onProgress: () => {},
      lifecycleOrigin: "desktop",
    } as Parameters<typeof applyHost>[0]);

    expect(mocks.busyCalls).toEqual([]);
    expect(mocks.lifecycleCalls).toEqual([]);
    expect(result).toEqual({ outcome: "no-op", installedVersion: "1.0.0" });
  });
});

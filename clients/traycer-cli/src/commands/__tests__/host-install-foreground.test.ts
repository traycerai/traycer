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
import type { CommandContext } from "../../runner/runner";

// `buildHostInstallCommand`'s own
// case: "The desktop leaves a host that a person started in a terminal
// untouched; the mode governs the service run only." `host restart` and
// `host stop` already refuse a live FOREGROUND run (a `traycer host start`
// run in a terminal - see `../../host/foreground-host-run.ts`) under
// `lifecycleOrigin: "desktop"`. `host install` has no such guard on current,
// unmodified production bytes: it proceeds straight to
// `commitHostInstallSourceWithAttempt` over a foreground run regardless of
// origin. This file is RED against that gap.
//
// Fixture template: `host-restart-foreground.test.ts` (own file, not
// imported - that file is off-limits to edit). Same technique: real
// `supervisor.json` / `supervisor-run.json` records naming THIS test
// process's own pid and start identity (`admission: "foreground"`), so
// `readLiveSupervisorRun` (inside `findForegroundHostRun`, left UNMOCKED)
// runs its genuine OS liveness/identity probe against a process that really
// is alive. `findLiveIncumbentHost` (a live *host*, not a live
// *supervisor*) is mocked to report a fake reachable host - the same
// acceptable substitute the restart-foreground fixture uses.
//
// Isolation pattern: modelled on the sibling suite for this same command,
// `host-install-lock.test.ts` (installer/service-lifecycle/busy-check mocks,
// `node:os.homedir()` override, `vi.resetModules()` after the redirect).
// `versionRequest: "latest"` picks the UNGATED store-format-floor branch
// (`gateInstallStoreFormatFloor`), so this suite never needs to stub the
// registry fetch the gated branch would otherwise reach.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(actual.tmpdir(), "traycer-host-install-foreground-test-home-"),
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
  stageCalls: [] as string[],
  commitCalls: [] as string[],
  discardCalls: [] as string[],
  busyCalls: [] as Array<string | undefined>,
  findLiveIncumbentHostMock: vi.fn(),
}));

let stagingCounter = 0;

vi.mock("../../installer", () => ({
  currentInstallPlatform: () => "darwin" as const,
  NO_INSTALL_PHASE_HOOKS: {
    beforeSwapCommit: async () => {},
    afterSwap: async () => {},
  },
  stageHostInstallSource: async () => {
    mocks.stageCalls.push("stage");
    stagingCounter += 1;
    const stagingDir = join(
      osHome.current,
      `staging-dir-${String(stagingCounter)}`,
    );
    const executablePath = join(stagingDir, "traycer-host");
    const archivePath = join(stagingDir, "archive.tar.gz");
    const executableBytes = "fixture host executable";
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(executablePath, executableBytes);
    writeFileSync(archivePath, "fixture archive");
    return {
      stagingDir,
      archivePath,
      archiveIsTemporary: true,
      executablePath,
      version: "2.0.0",
      runtimeVersion: null,
      source: { kind: "registry", value: "2.0.0" },
      archiveSha256: "b".repeat(64),
      signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
      signatureKeyId: "test-key",
      sizeBytes: Buffer.byteLength(executableBytes),
    };
  },
  discardStagedHostInstallSource: async () => {
    mocks.discardCalls.push("discard");
  },
}));

// The contender-aware facade (`host/update-mutation.ts`, unmocked) imports
// the commit edge from this concrete module - same boundary
// `host-install-lock.test.ts` fakes to keep valid staged bytes from ever
// reaching the real installer.
vi.mock("../../installer/install", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../installer/install")>();
  return {
    ...actual,
    commitHostInstallSource: async () => {
      mocks.commitCalls.push("commit");
      return {
        record: {
          installId: "install-2.0.0",
          version: "2.0.0",
          runtimeVersion: null,
          platform: "darwin" as const,
          arch: "arm64" as const,
          installedAt: "2026-01-01T00:00:00.000Z",
          source: { kind: "registry" as const, value: "2.0.0" },
          archiveSha256: "b".repeat(64),
          signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
          signatureKeyId: "test-key",
          sizeBytes: Buffer.byteLength("fixture host executable"),
          executablePath: "/tmp/traycer-host",
        },
        previous: null,
        installGeneration: "id:install-2.0.0",
      };
    },
  };
});

vi.mock("../../service/install-lifecycle", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../service/install-lifecycle")>();
  return {
    ...actual,
    createServiceInstallLifecycle: () => ({
      state: {
        priorState: "not-installed" as const,
        stoppedBeforeSwap: false,
        postSwapAction: "none" as const,
        postSwapError: null,
      },
      lifecycle: {
        beforeSwap: async () => {},
        beforeSwapCommit: async () => {},
        afterSwap: async () => {},
        swapLockRecovery: null,
      },
    }),
  };
});

vi.mock("../../host/busy-check", () => ({
  assertHostNotBusy: async (environment: string | undefined) => {
    mocks.busyCalls.push(environment);
  },
}));

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
import { readLiveSupervisorRun } from "../../host/live-supervisor-run";

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

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: true,
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

type HostInstallArgsShape = Parameters<
  typeof import("../host-install").buildHostInstallCommand
>[0];

function baseArgs(
  overrides: Partial<HostInstallArgsShape>,
): HostInstallArgsShape {
  return {
    versionRequest: "latest",
    fromPath: null,
    enableLinger: true,
    allowSelfInvocation: false,
    noServiceRegister: false,
    ifIdle: false,
    force: false,
    acceptStoreFormatLoss: false,
    attemptAdoption: null,
    lifecycleOrigin: "terminal",
    ...overrides,
  };
}

beforeEach(async () => {
  vi.resetModules();
  const { hostHomeDir } = await import("../../store/paths");
  expect(hostHomeDir("production").startsWith(osHome.current)).toBe(true);
  rmSync(hostHomeDir("production"), { recursive: true, force: true });
  mocks.stageCalls = [];
  mocks.commitCalls = [];
  mocks.discardCalls = [];
  mocks.busyCalls = [];
  mocks.findLiveIncumbentHostMock.mockReset();
  mocks.findLiveIncumbentHostMock.mockResolvedValue(LIVE_INCUMBENT_HOST);
});

describe("host install - foreground-run guard", () => {
  it("rejects E_HOST_NOT_SERVICE_RUN over a live foreground run with lifecycleOrigin 'desktop', never probing busy or committing, and scrubs the staged temp", async () => {
    await writeLiveForegroundRun();

    const { buildHostInstallCommand } = await import("../host-install");
    const command = buildHostInstallCommand(
      baseArgs({ lifecycleOrigin: "desktop", ifIdle: true }),
    );
    const caught: unknown = await command(fakeCtx()).then(
      () => null,
      (err: unknown) => err,
    );

    expect(mocks.busyCalls).toEqual([]);
    expect(mocks.commitCalls).toEqual([]);
    expect(mocks.discardCalls).toEqual(["discard"]);
    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
      details: { supervisorPid: process.pid, hostPid: LIVE_INCUMBENT_HOST.pid },
    });
    expect((caught as { message: string }).message).toContain(
      `host install: the running host was started in a terminal (supervisor pid ${String(process.pid)}) and is not run by the service; stop it there with Ctrl-C`,
    );
  });

  it("(control) lifecycleOrigin 'terminal' over the same live foreground run still proceeds to commit", async () => {
    await writeLiveForegroundRun();

    const { buildHostInstallCommand } = await import("../host-install");
    const command = buildHostInstallCommand(
      baseArgs({ lifecycleOrigin: "terminal" }),
    );
    const result = await command(fakeCtx());

    expect(mocks.commitCalls).toEqual(["commit"]);
    expect(result.data).toMatchObject({
      version: "2.0.0",
      installGeneration: "id:install-2.0.0",
    });
  });

  it("(control) lifecycleOrigin 'desktop' with NO foreground run present still proceeds to commit", async () => {
    // No supervisor.json / supervisor-run.json written at all - positively
    // confirmed clean (the `beforeEach` sweep above removed any leftover
    // records from an earlier test in this same per-file temp HOME) before
    // trusting this control's premise.
    expect(await readLiveSupervisorRun("production")).toBeNull();

    const { buildHostInstallCommand } = await import("../host-install");
    const command = buildHostInstallCommand(
      baseArgs({ lifecycleOrigin: "desktop" }),
    );
    const result = await command(fakeCtx());

    expect(mocks.commitCalls).toEqual(["commit"]);
    expect(result.data).toMatchObject({
      version: "2.0.0",
      installGeneration: "id:install-2.0.0",
    });
  });

  it("(control) lifecycleOrigin 'desktop' with noServiceRegister over the same live foreground run still proceeds (bytes-only path unaffected)", async () => {
    await writeLiveForegroundRun();

    const { buildHostInstallCommand } = await import("../host-install");
    const command = buildHostInstallCommand(
      baseArgs({ lifecycleOrigin: "desktop", noServiceRegister: true }),
    );
    const result = await command(fakeCtx());

    expect(mocks.commitCalls).toEqual(["commit"]);
    expect(result.data).toMatchObject({
      version: "2.0.0",
      installGeneration: "id:install-2.0.0",
    });
  });
});

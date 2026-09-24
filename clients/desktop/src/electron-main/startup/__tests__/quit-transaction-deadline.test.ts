import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "../../__tests__/sandbox-home";
import type { HostLifecycleView } from "../../../ipc-contracts/host-lifecycle-types";
import type { HostQuitDecisionResponse } from "../../../ipc-contracts/host-quit-types";
import type { StopHostOutcome } from "../../host/host-controller-types";

// The quit transaction's deadline rule, proved by MECHANISM against a REAL
// `HostController` (same mocking boundary as host-controller-lifecycle): a
// stop still queued on the mutation lane when the visible-stopping budget
// runs out is withdrawn and never spawned - counted on the DETACHED spawner,
// not inferred from an outcome. Real timers with a small `deadlineMs`.

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => join(process.env.HOME ?? "/tmp", "userData")),
    isPackaged: false,
    getAppPath: vi.fn(() => "/tmp"),
    getVersion: vi.fn(() => "9.9.9"),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../cli/traycer-cli", () => ({
  runBundledTraycerCliJson: vi.fn(async () => ({})),
  streamBundledTraycerCliJson: vi.fn(async () => ({ data: {} })),
  spawnDetachedBundledTraycerCliJson: vi.fn(async () => ({
    pid: 4242,
    stdoutPath: "/tmp/stop.ndjson",
    stderrPath: "/tmp/stop.log",
    completion: Promise.resolve({}),
  })),
  TraycerCliError: class extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock("../../cli/cli-discovery", () => ({
  resolveBundledCliPath: vi.fn(async () => null),
  readCliManifest: vi.fn(async () => null),
}));

vi.mock("../../app/host-login-item", () => ({
  hostManagesHostLoginItem: vi.fn(async () => false),
  registerHostLoginItem: vi.fn(async () => "enabled"),
  unregisterHostLoginItemGuarded: vi.fn(async () => true),
  retireCompetingCliRegistrationAtLaunchGuarded: vi.fn(
    async () => "not-applicable",
  ),
  hasUnappliedPendingLoginItemRevision: vi.fn(async () => false),
  readHostLoginItemStatus: vi.fn(() => "enabled"),
  readParkedRegistrationTakeover: vi.fn(async () => ({
    kind: "no-takeover",
    reason: "primary-manageable",
  })),
}));

vi.mock("../../host/host-readiness", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/host-readiness")>();
  return {
    ...actual,
    waitForHostReady: vi.fn(async () => ({
      ready: true,
      version: "1.0.0",
      pid: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    })),
  };
});

vi.mock("@traycer-clients/shared/host-client/host-activity-probe", () => ({
  probeHostActivityBusy: vi.fn(async () => false),
}));

vi.mock("../../app/update-preferences", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../app/update-preferences")>();
  return {
    ...actual,
    prereleaseUpdatesEnabled: vi.fn(() => false),
  };
});

import {
  spawnDetachedBundledTraycerCliJson,
  streamBundledTraycerCliJson,
} from "../../cli/traycer-cli";
import { HostController } from "../../host/host-controller";
import {
  DESKTOP_LOCK_POLL_INTERVAL_MS,
  DESKTOP_LOCK_WAIT_MS,
} from "../../host/host-controller";
import { getHostFsLayout } from "../../host/host-paths";
import { DEV_DESKTOP_SLOT_ENV } from "../../host/dev-desktop-slot";
import { __resetHostRemovalStateForTest } from "../../host/host-removal-state";
import { QuitTransactions } from "../quit-transaction";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_DEV_DESKTOP_SLOT = process.env[DEV_DESKTOP_SLOT_ENV];
const DEADLINE_MS = 200;
const VIEW: HostLifecycleView = {
  desired: { mode: "linked", rev: 1, updatedBy: "desktop", updatedAt: null },
  applied: { localHostCapability: "managed", supervisor: "not-running" },
  pending: "none",
};
let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-quit-deadline-"));
  sandboxHome(workHome);
  delete process.env[DEV_DESKTOP_SLOT_ENV];
  mkdirSync(join(workHome, ".traycer", "cli"), { recursive: true });
  __resetHostRemovalStateForTest();
  vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({ data: {} });
  vi.mocked(spawnDetachedBundledTraycerCliJson).mockResolvedValue({
    pid: 4242,
    stdoutPath: "/tmp/stop.ndjson",
    stderrPath: "/tmp/stop.log",
    completion: Promise.resolve({}),
  });
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  if (ORIGINAL_DEV_DESKTOP_SLOT === undefined) {
    delete process.env[DEV_DESKTOP_SLOT_ENV];
  } else {
    process.env[DEV_DESKTOP_SLOT_ENV] = ORIGINAL_DEV_DESKTOP_SLOT;
  }
  rmSync(workHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

function newController(): HostController {
  return new HostController({
    environment: "production",
    hostLifecycle: {
      notifyRespawning: vi.fn(),
      ensureWatcherInstalled: vi.fn(),
      reloadSnapshotFromDisk: vi.fn(async () => ({
        hostId: "host-1",
        websocketUrl: "ws://127.0.0.1:55555/rpc",
        version: "1.0.0",
        pid: process.pid,
        systemHostName: "test-host",
        displayName: "Test Host",
        availability: "available",
      })),
    },
    reachabilityProbe: async () => true,
    desktopLockWaitMs: DESKTOP_LOCK_WAIT_MS,
    desktopLockPollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
  });
}

function writeInstallRecord(): void {
  const layout = getHostFsLayout("production");
  mkdirSync(layout.installDir, { recursive: true });
  writeFileSync(
    layout.installRecordFile,
    JSON.stringify({
      installId: "install-1",
      version: "1.7.0",
      runtimeVersion: "1.7.0",
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: "a".repeat(64),
      platform: process.platform,
      arch: process.arch,
      source: { kind: "registry", value: "1.7.0" },
      signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
      signatureKeyId: "test-key",
      sizeBytes: 1,
      executablePath: join(layout.installDir, "traycer-host"),
    }),
  );
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function detachedStopCalls(): number {
  return vi.mocked(spawnDetachedBundledTraycerCliJson).mock.calls.length;
}

interface Quitter {
  readonly txs: QuitTransactions;
  readonly authorized: () => number;
  readonly outcomes: StopHostOutcome[];
}

function newQuitter(
  controller: HostController,
  mode: "linked" | "ask",
  answer: () => Promise<HostQuitDecisionResponse>,
): Quitter {
  const outcomes: StopHostOutcome[] = [];
  let authorized = 0;
  const txs = new QuitTransactions({
    isInstallingUpdate: () => false,
    lifecycle: {
      readQuitPolicy: async () => ({ mode, rev: 1 }),
      writeQuitVerdict: async () => "written",
      releaseQuitVerdict: async () => undefined,
      setMode: async () => ({ kind: "applied", view: VIEW }),
    },
    controller: {
      stopHost: async (request) => {
        const outcome = await controller.stopHost(request);
        outcomes.push(outcome);
        return outcome;
      },
      holdAutomaticIntents: () => controller.holdAutomaticIntents(),
      quiesce: () => {
        controller.quiesce();
      },
    },
    requestDecision: answer,
    withdrawDecision: () => undefined,
    askNatively: async () => ({ kind: "keep", remember: false }),
    publishState: () => undefined,
    unsyncedEditsGate: async () => "proceed",
    runUpdateInstallSequence: async () => undefined,
    authorizeQuitAfterFlush: () => {
      authorized += 1;
    },
    authorizeQuitNow: () => undefined,
    stayOpen: () => undefined,
    revealStopping: () => undefined,
    setStoppingIndicator: () => undefined,
    revealDelayMs: 1_000,
    deadlineMs: DEADLINE_MS,
  });
  return { txs, authorized: () => authorized, outcomes };
}

async function blockLaneWithInstall(
  controller: HostController,
): Promise<{ readonly release: () => Promise<void> }> {
  writeInstallRecord();
  const installGate = deferred<{ data: unknown }>();
  vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
    if (opts.args.includes("install")) return installGate.promise;
    return { data: {} };
  });
  const install = controller.installVersion("1.8.0", true);
  await vi.waitFor(() => {
    expect(
      vi
        .mocked(streamBundledTraycerCliJson)
        .mock.calls.some(([opts]) => opts.args.includes("install")),
    ).toBe(true);
  });
  return {
    release: async () => {
      installGate.resolve({
        data: { version: "1.8.0", installGeneration: null },
      });
      await install;
    },
  };
}

describe("quit deadline withdrawal (real HostController)", () => {
  it("a Linked stop still queued at the deadline: authorize fires, and the stop is NEVER spawned once the lane frees", async () => {
    const real = newController();
    const blocker = await blockLaneWithInstall(real);
    const quitter = newQuitter(real, "linked", () => {
      throw new Error("linked never prompts");
    });

    quitter.txs.onBeforeQuit();
    await sleep(DEADLINE_MS / 2);
    // Still inside the budget: queued behind the install, nothing authorized.
    expect(quitter.authorized()).toBe(0);
    expect(detachedStopCalls()).toBe(0);

    await sleep(DEADLINE_MS + 150);
    expect(quitter.authorized()).toBe(1);
    // The stop has not even settled: the quit did not wait for the lane.
    expect(quitter.outcomes).toEqual([]);
    expect(detachedStopCalls()).toBe(0);

    await blocker.release();
    await sleep(100);
    expect(quitter.outcomes).toEqual([{ kind: "withdrawn" }]);
    // The blocking intent finished; the withdrawn stop still never spawned.
    expect(detachedStopCalls()).toBe(0);
    expect(quitter.authorized()).toBe(1);
  });

  it("positive control: a stop admitted before the deadline is spawned exactly once (detached, if-idle)", async () => {
    const real = newController();
    const quitter = newQuitter(real, "linked", () => {
      throw new Error("linked never prompts");
    });
    quitter.txs.onBeforeQuit();
    await vi.waitFor(() => {
      expect(quitter.authorized()).toBe(1);
    });
    expect(detachedStopCalls()).toBe(1);
    expect(spawnDetachedBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["host", "stop", "--if-idle", "--lifecycle-origin", "desktop"],
      }),
    );
    expect(quitter.outcomes).toEqual([{ kind: "stopped", forced: false }]);
  });

  it("an admitted stop that outlives the deadline is spawned once, and the quit authorizes without awaiting it", async () => {
    const real = newController();
    const neverCompletes = new Promise<Record<string, never>>(() => undefined);
    vi.mocked(spawnDetachedBundledTraycerCliJson).mockResolvedValue({
      pid: 4242,
      stdoutPath: "/tmp/stop.ndjson",
      stderrPath: "/tmp/stop.log",
      completion: neverCompletes,
    });
    const quitter = newQuitter(real, "linked", () => {
      throw new Error("linked never prompts");
    });
    quitter.txs.onBeforeQuit();
    await sleep(DEADLINE_MS / 2);
    expect(quitter.authorized()).toBe(0);
    await sleep(DEADLINE_MS + 150);
    expect(quitter.authorized()).toBe(1);
    expect(detachedStopCalls()).toBe(1);
  });

  it("the budget only counts visible stopping: a modal wait longer than the deadline does not consume it", async () => {
    const real = newController();
    const answer = async (): Promise<HostQuitDecisionResponse> => {
      await sleep(DEADLINE_MS * 2);
      return {
        requestId: "req-1",
        decision: { kind: "stop", force: true, remember: false },
      };
    };
    const quitter = newQuitter(real, "ask", answer);
    quitter.txs.onBeforeQuit();
    await vi.waitFor(
      () => {
        expect(quitter.authorized()).toBe(1);
      },
      { timeout: 3_000 },
    );
    // Had the modal's wait eaten the budget, the stop would have been skipped
    // as "deadline" before any spawn.
    expect(detachedStopCalls()).toBe(1);
    expect(spawnDetachedBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["host", "stop", "--force", "--lifecycle-origin", "desktop"],
      }),
    );
    expect(quitter.outcomes).toEqual([{ kind: "stopped", forced: true }]);
  });
});

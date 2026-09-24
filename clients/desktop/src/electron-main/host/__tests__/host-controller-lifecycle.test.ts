import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "../../__tests__/sandbox-home";

// Host lifecycle modes (T05), desktop half: the controller's stop request, the
// automatic-intent suspension (`quiesce` / `holdAutomaticIntents`), the lane
// barrier (`deferMutationsUntil`), and where `--lifecycle-origin desktop`
// lands. Same mocking boundary as `host-controller.test.ts`: the CLI wrapper,
// the macOS login-item bindings and readiness polling are mocked; host state,
// paths and the desktop cli-lock are real against a temp `$HOME`.
//
// Every claim below is asserted over the SPAWNER's call list (the mocked
// `streamBundledTraycerCliJson` / `runBundledTraycerCliJson` /
// `spawnDetachedBundledTraycerCliJson`), never over an outcome alone: an
// outcome can read "deferred" for the wrong reason, a spawn count cannot.

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

vi.mock("../host-readiness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../host-readiness")>();
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
  runBundledTraycerCliJson,
  spawnDetachedBundledTraycerCliJson,
  streamBundledTraycerCliJson,
  TraycerCliError,
} from "../../cli/traycer-cli";
import { prereleaseUpdatesEnabled } from "../../app/update-preferences";
import {
  hasUnappliedPendingLoginItemRevision,
  hostManagesHostLoginItem,
  readHostLoginItemStatus,
  readParkedRegistrationTakeover,
  registerHostLoginItem,
  unregisterHostLoginItemGuarded,
} from "../../app/host-login-item";
import { resolveBundledCliPath } from "../../cli/cli-discovery";
import { waitForHostReady } from "../host-readiness";
import { probeHostActivityBusy } from "@traycer-clients/shared/host-client/host-activity-probe";
import {
  DESKTOP_LOCK_POLL_INTERVAL_MS,
  DESKTOP_LOCK_WAIT_MS,
  HostController,
  type HostControllerHostLifecycle,
} from "../host-controller";
import {
  AUTOMATIC_INTENTS_HELD_MESSAGE,
  AUTOMATIC_INTENTS_QUIESCED_MESSAGE,
  type LocalHostMutationIntent,
  type StopHostMode,
  type StopHostOutcome,
  type StopHostRequest,
  type StopHostSpawn,
} from "../host-controller-types";
import { getHostFsLayout } from "../host-paths";
import { DEV_DESKTOP_SLOT_ENV } from "../dev-desktop-slot";
import { __resetHostRemovalStateForTest } from "../host-removal-state";
import { withDesktopLifecycleOrigin } from "../lifecycle-origin-args";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_DEV_DESKTOP_SLOT = process.env[DEV_DESKTOP_SLOT_ENV];
let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-host-controller-lifecycle-"));
  sandboxHome(workHome);
  delete process.env[DEV_DESKTOP_SLOT_ENV];
  mkdirSync(join(workHome, ".traycer", "cli"), { recursive: true });
  __resetHostRemovalStateForTest();
  vi.mocked(hostManagesHostLoginItem).mockResolvedValue(false);
  vi.mocked(prereleaseUpdatesEnabled).mockReturnValue(false);
  vi.mocked(runBundledTraycerCliJson).mockResolvedValue({});
  vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({ data: {} });
  vi.mocked(spawnDetachedBundledTraycerCliJson).mockResolvedValue({
    pid: 4242,
    stdoutPath: "/tmp/stop.ndjson",
    stderrPath: "/tmp/stop.log",
    completion: Promise.resolve({}),
  });
  vi.mocked(waitForHostReady).mockResolvedValue({
    ready: true,
    version: "1.0.0",
    pid: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    reason: "ready",
  });
  vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(false);
  vi.mocked(readHostLoginItemStatus).mockReturnValue("enabled");
  vi.mocked(readParkedRegistrationTakeover).mockResolvedValue({
    kind: "no-takeover",
    reason: "primary-manageable",
  });
  vi.mocked(registerHostLoginItem).mockResolvedValue("enabled");
  vi.mocked(unregisterHostLoginItemGuarded).mockResolvedValue(true);
  vi.mocked(probeHostActivityBusy).mockResolvedValue(false);
  vi.mocked(resolveBundledCliPath).mockResolvedValue(null);
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
  if (ORIGINAL_DEV_DESKTOP_SLOT === undefined) {
    delete process.env[DEV_DESKTOP_SLOT_ENV];
  } else {
    process.env[DEV_DESKTOP_SLOT_ENV] = ORIGINAL_DEV_DESKTOP_SLOT;
  }
  rmSync(workHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ---- harness ---------------------------------------------------------------

function fakeHostLifecycle(): HostControllerHostLifecycle {
  return {
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
  };
}

function newController(
  reachabilityProbe: (websocketUrl: string) => Promise<boolean>,
): HostController {
  return new HostController({
    environment: "production",
    hostLifecycle: fakeHostLifecycle(),
    reachabilityProbe,
    desktopLockWaitMs: DESKTOP_LOCK_WAIT_MS,
    desktopLockPollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
  });
}

function newReachableController(): HostController {
  return newController(async () => true);
}

function writeInstallRecord(runtimeVersion: string | null): void {
  const layout = getHostFsLayout("production");
  mkdirSync(layout.installDir, { recursive: true });
  writeFileSync(
    layout.installRecordFile,
    JSON.stringify({
      installId: "install-1",
      version: "1.7.0",
      runtimeVersion,
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

function writeStagedRecord(): void {
  const layout = getHostFsLayout("production");
  mkdirSync(layout.stagedDir, { recursive: true });
  writeFileSync(
    layout.stagedRecordFile,
    JSON.stringify({
      stageId: "stage-1.8.0",
      version: "1.8.0",
      runtimeVersion: "1.8.0",
    }),
  );
}

function removeStagedRecord(): void {
  rmSync(getHostFsLayout("production").stagedRecordFile, { force: true });
}

function writePidMetadata(): void {
  const layout = getHostFsLayout("production");
  mkdirSync(layout.rootDir, { recursive: true });
  writeFileSync(
    layout.pidMetadataFile,
    JSON.stringify({
      hostId: "host-1",
      websocketUrl: "ws://127.0.0.1:55555/rpc",
      version: "1.7.0",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }),
  );
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (err: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
}

/** Every args list the streaming spawner received. */
function streamCalls(): readonly (readonly string[])[] {
  return vi
    .mocked(streamBundledTraycerCliJson)
    .mock.calls.map(([opts]) => [...opts.args]);
}

/** Every args list the plain-run spawner received. */
function runCalls(): readonly (readonly string[])[] {
  return vi
    .mocked(runBundledTraycerCliJson)
    .mock.calls.map(([args]) => [...args]);
}

function detachedCalls(): number {
  return vi.mocked(spawnDetachedBundledTraycerCliJson).mock.calls.length;
}

function totalSpawns(): number {
  return streamCalls().length + runCalls().length + detachedCalls();
}

function streamCallsWith(word: string): number {
  return streamCalls().filter((args) => args.includes(word)).length;
}

const BACKGROUND: LocalHostMutationIntent = { kind: "background" };

function userRepair(): LocalHostMutationIntent {
  return {
    kind: "user-repair",
    targetHostId: "host-1",
    guard: async () => ({ kind: "proceed" }),
  };
}

function stopRequest(
  mode: StopHostMode,
  spawn: StopHostSpawn,
  withdrawal: AbortSignal | null,
): StopHostRequest {
  return { mode, spawn, withdrawal };
}

function converge(controller: HostController, intent: LocalHostMutationIntent) {
  return controller.convergeReady(false, intent, "keep-installed");
}

const ENSURE_NOOP = {
  data: {
    running: true,
    runtimeVersion: "1.7.0",
    version: "1.7.0",
    action: "noop",
  },
};

// ---- stopHost --------------------------------------------------------------

describe("stopHost outcome mapping", () => {
  it("resolves stopped with the CLI's own `forced` when its result carries one", async () => {
    const controller = newReachableController();
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { forced: true },
    });
    await expect(
      controller.stopHost(stopRequest("if-idle", "attached", null)),
    ).resolves.toEqual({ kind: "stopped", forced: true });
    expect(streamCallsWith("stop")).toBe(1);

    // The CLI's answer wins over the request in the other direction as well.
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { forced: false },
    });
    await expect(
      controller.stopHost(stopRequest("force", "attached", null)),
    ).resolves.toEqual({ kind: "stopped", forced: false });
  });

  it("falls back to the requested mode for `forced` when the result carries none", async () => {
    const controller = newReachableController();
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({ data: {} });
    await expect(
      controller.stopHost(stopRequest("force", "attached", null)),
    ).resolves.toEqual({ kind: "stopped", forced: true });
    await expect(
      controller.stopHost(stopRequest("if-idle", "attached", null)),
    ).resolves.toEqual({ kind: "stopped", forced: false });
  });

  const errorCases: readonly {
    readonly code: string;
    readonly kind: "host-busy" | "lock-busy" | "update-active" | "failed";
  }[] = [
    { code: "E_HOST_BUSY", kind: "host-busy" },
    { code: "E_CLI_LOCK_BUSY", kind: "lock-busy" },
    { code: "E_HOST_UPDATE_ATTEMPT_ACTIVE", kind: "update-active" },
    { code: "E_SOMETHING_ELSE", kind: "failed" },
  ];
  for (const { code, kind } of errorCases) {
    it(`maps a ${code} CLI error to ${kind}`, async () => {
      const controller = newReachableController();
      vi.mocked(streamBundledTraycerCliJson).mockRejectedValue(
        new TraycerCliError(code, "cli said no"),
      );
      const outcome = await controller.stopHost(
        stopRequest("if-idle", "attached", null),
      );
      expect(outcome.kind).toBe(kind);
      // The CLI really was asked; the mapping is not a short-circuit.
      expect(streamCallsWith("stop")).toBe(1);
    });
  }

  it("maps a non-CLI error to failed", async () => {
    const controller = newReachableController();
    vi.mocked(streamBundledTraycerCliJson).mockRejectedValue(
      new Error("spawn exploded"),
    );
    const outcome = await controller.stopHost(
      stopRequest("force", "attached", null),
    );
    expect(outcome.kind).toBe("failed");
  });
});

describe("stopHost withdrawal", () => {
  it("resolves withdrawn with zero spawns when the signal is already aborted", async () => {
    const controller = newReachableController();
    const abort = new AbortController();
    abort.abort();
    await expect(
      controller.stopHost(stopRequest("if-idle", "attached", abort.signal)),
    ).resolves.toEqual({ kind: "withdrawn" });
    await expect(
      controller.stopHost(stopRequest("force", "detached", abort.signal)),
    ).resolves.toEqual({ kind: "withdrawn" });
    expect(totalSpawns()).toBe(0);
  });

  it("positive control: a signal that is not aborted spawns the stop", async () => {
    const controller = newReachableController();
    const abort = new AbortController();
    await expect(
      controller.stopHost(stopRequest("if-idle", "attached", abort.signal)),
    ).resolves.toEqual({ kind: "stopped", forced: false });
    expect(streamCallsWith("stop")).toBe(1);
  });

  async function stopQueuedBehindSlowInstall(
    abortWhileQueued: boolean,
  ): Promise<{
    readonly outcome: StopHostOutcome;
  }> {
    const controller = newReachableController();
    writeInstallRecord("1.7.0");
    const installGate = deferred<{ data: unknown }>();
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("install")) return installGate.promise;
      return { data: {} };
    });
    const install = controller.installVersion("1.8.0", true);
    await vi.waitFor(() => {
      expect(streamCallsWith("install")).toBe(1);
    });

    const abort = new AbortController();
    const stop = controller.stopHost(
      stopRequest("if-idle", "attached", abort.signal),
    );
    await settle();
    // Queued, not spawned: the lane is still held by the install.
    expect(streamCallsWith("stop")).toBe(0);

    if (abortWhileQueued) abort.abort();
    installGate.resolve({
      data: { version: "1.8.0", installGeneration: null },
    });
    await install;
    return { outcome: await stop };
  }

  it("aborted while queued behind a slow mutation: withdrawn, and no stop is ever spawned", async () => {
    const { outcome } = await stopQueuedBehindSlowInstall(true);
    expect(outcome).toEqual({ kind: "withdrawn" });
    expect(streamCallsWith("stop")).toBe(0);
    expect(detachedCalls()).toBe(0);
  });

  it("positive control: the same queued stop, not aborted, spawns once the lane frees", async () => {
    const { outcome } = await stopQueuedBehindSlowInstall(false);
    expect(outcome.kind).toBe("stopped");
    expect(streamCallsWith("stop")).toBe(1);
  });
});

describe("stopHost spawn form", () => {
  it("attached: streams exactly `host stop --if-idle --lifecycle-origin desktop`", async () => {
    const controller = newReachableController();
    await controller.stopHost(stopRequest("if-idle", "attached", null));
    expect(streamCalls().filter((args) => args.includes("stop"))).toEqual([
      ["host", "stop", "--if-idle", "--lifecycle-origin", "desktop"],
    ]);
    expect(detachedCalls()).toBe(0);
  });

  it("attached force: streams exactly `host stop --force --lifecycle-origin desktop`", async () => {
    const controller = newReachableController();
    await controller.stopHost(stopRequest("force", "attached", null));
    expect(streamCalls().filter((args) => args.includes("stop"))).toEqual([
      ["host", "stop", "--force", "--lifecycle-origin", "desktop"],
    ]);
    expect(detachedCalls()).toBe(0);
  });

  it("detached: spawns through the detached spawner into <host root>/desktop-cli, never the stream spawner", async () => {
    const controller = newReachableController();
    const outcome = await controller.stopHost(
      stopRequest("if-idle", "detached", null),
    );
    expect(outcome).toEqual({ kind: "stopped", forced: false });

    expect(detachedCalls()).toBe(1);
    expect(spawnDetachedBundledTraycerCliJson).toHaveBeenCalledWith({
      args: ["host", "stop", "--if-idle", "--lifecycle-origin", "desktop"],
      outputDir: join(getHostFsLayout("production").rootDir, "desktop-cli"),
      outputStem: "stop",
    });
    expect(streamCallsWith("stop")).toBe(0);
    expect(runCalls().filter((args) => args.includes("stop"))).toEqual([]);
  });

  it("detached force carries --force, and a rejected completion maps like an attached failure", async () => {
    const controller = newReachableController();
    vi.mocked(spawnDetachedBundledTraycerCliJson).mockImplementation(
      async () => ({
        pid: 4242,
        stdoutPath: "/tmp/stop.ndjson",
        stderrPath: "/tmp/stop.log",
        completion: Promise.reject(new TraycerCliError("E_HOST_BUSY", "busy")),
      }),
    );
    const outcome = await controller.stopHost(
      stopRequest("force", "detached", null),
    );
    expect(outcome.kind).toBe("host-busy");
    expect(spawnDetachedBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["host", "stop", "--force", "--lifecycle-origin", "desktop"],
      }),
    );
    expect(streamCallsWith("stop")).toBe(0);
  });
});

// ---- automatic-intent suspension ---------------------------------------------

describe("quiesce", () => {
  it("defers a background converge with zero spawns, while a user-repair converge still spawns", async () => {
    const controller = newReachableController();
    writeInstallRecord("1.7.0");
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue(ENSURE_NOOP);
    controller.quiesce();
    expect(controller.automaticIntentsSuspended).toBe(true);

    const background = await converge(controller, BACKGROUND);
    expect(background.kind).toBe("deferred");
    expect(totalSpawns()).toBe(0);

    // Positive control: the same quiesced controller, an explicit repair.
    await converge(controller, userRepair());
    expect(streamCallsWith("ensure")).toBe(1);
  });

  it("positive control: an unsuspended controller's background converge spawns ensure", async () => {
    const controller = newReachableController();
    writeInstallRecord("1.7.0");
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue(ENSURE_NOOP);
    expect(controller.automaticIntentsSuspended).toBe(false);
    await converge(controller, BACKGROUND);
    expect(streamCallsWith("ensure")).toBe(1);
  });

  it("suppresses recoverIfDown with zero spawns", async () => {
    // Reachability false and no pid.json: the host reads as down, which is
    // exactly the state recoverIfDown restarts from.
    const controller = newController(async () => false);
    writeInstallRecord("1.7.0");
    controller.quiesce();
    await expect(controller.recoverIfDown()).resolves.toEqual({
      kind: "suppressed",
    });
    expect(totalSpawns()).toBe(0);
  });

  it("positive control: recoverIfDown on an unsuspended controller restarts a down host", async () => {
    const controller = newController(async () => false);
    writeInstallRecord("1.7.0");
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { activated: true },
    });
    await controller.recoverIfDown();
    expect(streamCallsWith("restart")).toBe(1);
  });

  it('defers applyStaged("launch") with zero spawns, while applyStaged("manual") is not suspended', async () => {
    const controller = newReachableController();
    writeInstallRecord("1.7.0");
    writeStagedRecord();
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        outcome: "applied",
        record: { version: "1.8.0" },
        runningActivated: true,
        installGeneration: null,
      },
    });
    controller.quiesce();

    const launch = await controller.applyStaged("launch", false);
    expect(launch.kind).toBe("deferred");
    expect(totalSpawns()).toBe(0);

    // Positive control: an explicit "Update now" on the same quiesced controller.
    const manual = await controller.applyStaged("manual", false);
    expect(manual.kind).toBe("ok");
    expect(streamCallsWith("apply")).toBe(1);
  });

  it("defers the implicit activateInstalled(false, false) with zero spawns, while the explicit form is not suspended", async () => {
    const controller = newReachableController();
    writeInstallRecord("1.7.0");
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { activated: true },
    });
    controller.quiesce();

    const implicit = await controller.activateInstalled(false, false);
    expect(implicit.kind).toBe("deferred");
    expect(totalSpawns()).toBe(0);

    await controller.activateInstalled(false, true);
    expect(streamCallsWith("restart")).toBe(1);
  });

  async function backgroundConvergeQueuedBehindInstall(
    quiesceWhileQueued: boolean,
  ): Promise<{ readonly kind: string }> {
    const controller = newReachableController();
    writeInstallRecord("1.7.0");
    const installGate = deferred<{ data: unknown }>();
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("install")) return installGate.promise;
      return ENSURE_NOOP;
    });
    const install = controller.installVersion("1.8.0", true);
    await vi.waitFor(() => {
      expect(streamCallsWith("install")).toBe(1);
    });

    // Submitted BEFORE any suspension, so it passes the submission check and
    // waits its turn on the lane.
    const queued = converge(controller, BACKGROUND);
    await settle();
    expect(streamCallsWith("ensure")).toBe(0);

    if (quiesceWhileQueued) controller.quiesce();
    installGate.resolve({
      data: { version: "1.8.0", installGeneration: null },
    });
    await install;
    return queued;
  }

  it("re-checks at the lane head: a converge queued before quiesce is deferred and spawns no ensure", async () => {
    const outcome = await backgroundConvergeQueuedBehindInstall(true);
    expect(outcome.kind).toBe("deferred");
    expect(streamCallsWith("ensure")).toBe(0);
  });

  it("positive control: the same queued converge, never quiesced, spawns ensure", async () => {
    await backgroundConvergeQueuedBehindInstall(false);
    expect(streamCallsWith("ensure")).toBe(1);
  });
});

describe("holdAutomaticIntents", () => {
  it("suspends until released, then a background converge spawns again", async () => {
    const controller = newReachableController();
    writeInstallRecord("1.7.0");
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue(ENSURE_NOOP);

    expect(controller.automaticIntentsSuspended).toBe(false);
    const hold = controller.holdAutomaticIntents();
    expect(controller.automaticIntentsSuspended).toBe(true);

    const suspended = await converge(controller, BACKGROUND);
    expect(suspended.kind).toBe("deferred");
    expect(streamCallsWith("ensure")).toBe(0);

    hold.release();
    expect(controller.automaticIntentsSuspended).toBe(false);
    await converge(controller, BACKGROUND);
    expect(streamCallsWith("ensure")).toBe(1);
  });

  it("a double release is a no-op: it must not release a second, still-open hold", async () => {
    const controller = newReachableController();
    writeInstallRecord("1.7.0");
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue(ENSURE_NOOP);

    const first = controller.holdAutomaticIntents();
    const second = controller.holdAutomaticIntents();
    first.release();
    first.release();
    expect(controller.automaticIntentsSuspended).toBe(true);
    const stillSuspended = await converge(controller, BACKGROUND);
    expect(stillSuspended.kind).toBe("deferred");
    expect(streamCallsWith("ensure")).toBe(0);

    second.release();
    expect(controller.automaticIntentsSuspended).toBe(false);
    await converge(controller, BACKGROUND);
    expect(streamCallsWith("ensure")).toBe(1);
  });

  it("two holds need both released", async () => {
    const controller = newReachableController();
    const first = controller.holdAutomaticIntents();
    const second = controller.holdAutomaticIntents();
    second.release();
    expect(controller.automaticIntentsSuspended).toBe(true);
    first.release();
    expect(controller.automaticIntentsSuspended).toBe(false);
  });

  it("releasing every hold does not undo a quiesce", () => {
    const controller = newReachableController();
    const hold = controller.holdAutomaticIntents();
    controller.quiesce();
    hold.release();
    expect(controller.automaticIntentsSuspended).toBe(true);
  });
});

describe("suspended background converge names its cause", () => {
  async function deferredMessage(
    prepare: (controller: HostController) => void,
  ): Promise<string> {
    const controller = newReachableController();
    writeInstallRecord("1.7.0");
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue(ENSURE_NOOP);
    prepare(controller);
    const outcome = await converge(controller, BACKGROUND);
    expect(totalSpawns()).toBe(0);
    if (outcome.kind !== "deferred") {
      throw new Error(`expected deferred, got ${outcome.kind}`);
    }
    return outcome.message;
  }

  it("quiesce() → the QUIESCED message", async () => {
    const message = await deferredMessage((controller) => {
      controller.quiesce();
    });
    expect(message).toBe(AUTOMATIC_INTENTS_QUIESCED_MESSAGE);
  });

  it("a hold alone → the HELD message", async () => {
    const message = await deferredMessage((controller) => {
      controller.holdAutomaticIntents();
    });
    expect(message).toBe(AUTOMATIC_INTENTS_HELD_MESSAGE);
  });

  it("quiesce() while a hold is open → the QUIESCED message", async () => {
    const message = await deferredMessage((controller) => {
      controller.holdAutomaticIntents();
      controller.quiesce();
    });
    expect(message).toBe(AUTOMATIC_INTENTS_QUIESCED_MESSAGE);
  });

  it("the two messages are distinct (the boot ladder branches on them)", () => {
    expect(AUTOMATIC_INTENTS_QUIESCED_MESSAGE).not.toBe(
      AUTOMATIC_INTENTS_HELD_MESSAGE,
    );
  });
});

// ---- deferMutationsUntil -----------------------------------------------------

describe("deferMutationsUntil", () => {
  it("holds a converge off the CLI until the barrier resolves", async () => {
    const controller = newReachableController();
    writeInstallRecord("1.7.0");
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue(ENSURE_NOOP);
    const barrier = deferred<void>();
    controller.deferMutationsUntil(barrier.promise);

    const pending = converge(controller, BACKGROUND);
    await settle();
    expect(streamCallsWith("ensure")).toBe(0);

    barrier.resolve();
    await pending;
    expect(streamCallsWith("ensure")).toBe(1);
  });

  it("a rejected barrier releases the lane too", async () => {
    const controller = newReachableController();
    writeInstallRecord("1.7.0");
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue(ENSURE_NOOP);
    const barrier = deferred<void>();
    controller.deferMutationsUntil(barrier.promise);

    const pending = converge(controller, BACKGROUND);
    await settle();
    expect(streamCallsWith("ensure")).toBe(0);

    barrier.reject(new Error("presence record write failed"));
    await pending;
    expect(streamCallsWith("ensure")).toBe(1);
  });

  it("positive control: without a barrier the same converge spawns immediately", async () => {
    const controller = newReachableController();
    writeInstallRecord("1.7.0");
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue(ENSURE_NOOP);
    await converge(controller, BACKGROUND);
    expect(streamCallsWith("ensure")).toBe(1);
  });
});

// ---- --lifecycle-origin desktop ------------------------------------------------

// Written out here rather than imported: the production list is the thing under
// test, so the expectation must not be derived from it.
const START_CAPABLE_COMMANDS: readonly (readonly string[])[] = [
  ["host", "ensure"],
  ["host", "install"],
  ["host", "apply"],
  ["host", "service", "install"],
  ["host", "service", "start"],
  ["host", "restart"],
  ["host", "free-port-and-restart"],
  ["host", "stop"],
];

const NON_START_COMMANDS: readonly (readonly string[])[] = [
  ["host", "download", "1.8.0"],
  ["host", "download", "--automatic"],
  ["host", "uninstall"],
  ["host", "uninstall", "--all"],
  ["host", "service", "uninstall"],
  ["host", "service", "status"],
  ["host", "update-verify", "--attempt-id", "attempt-1"],
  ["host", "stamp-runtime", "--observed-pid", "1"],
  ["host", "purge-stage", "--expected-stage-fingerprint", "fp"],
  ["host", "available", "--json"],
  ["host", "doctor"],
  ["host", "status"],
  ["config", "shell", "set"],
];

function isStartCapable(args: readonly string[]): boolean {
  return START_CAPABLE_COMMANDS.some((command) =>
    command.every((word, index) => args[index] === word),
  );
}

function commandKey(args: readonly string[]): string {
  return args.slice(0, args[1] === "service" ? 3 : 2).join(" ");
}

function hasOrigin(args: readonly string[]): boolean {
  return args.includes("--lifecycle-origin");
}

describe("withDesktopLifecycleOrigin", () => {
  for (const command of START_CAPABLE_COMMANDS) {
    it(`appends the origin to \`${command.join(" ")}\``, () => {
      const args = [...command, "--if-idle"];
      expect(withDesktopLifecycleOrigin(args)).toEqual([
        ...args,
        "--lifecycle-origin",
        "desktop",
      ]);
    });
  }

  for (const args of NON_START_COMMANDS) {
    it(`leaves \`${args.join(" ")}\` untouched`, () => {
      expect(withDesktopLifecycleOrigin(args)).toBe(args);
    });
  }

  it("does not add a second origin to args that already carry one", () => {
    const args = ["host", "stop", "--lifecycle-origin", "desktop"];
    expect(withDesktopLifecycleOrigin(args)).toBe(args);
  });
});

describe("--lifecycle-origin desktop over the controller's real spawns", () => {
  it("is on exactly the start-capable commands the controller spawns, and on no other", async () => {
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      const args = opts.args;
      if (args.includes("ensure")) return ENSURE_NOOP;
      if (args.includes("apply")) {
        return {
          data: {
            outcome: "applied",
            record: { version: "1.8.0" },
            runningActivated: true,
            installGeneration: null,
          },
        };
      }
      if (args.includes("install") && args.includes("--release")) {
        return { data: { version: "1.8.0", installGeneration: null } };
      }
      if (args.includes("free-port-and-restart")) {
        return {
          data: {
            installGeneration: "free-port-command-generation",
            runtimeVersion: null,
            runtimeWasNull: true,
          },
        };
      }
      if (args.includes("uninstall") && !args.includes("service")) {
        return { data: { removedInstallDir: true, serviceUninstalled: true } };
      }
      return { data: { activated: true } };
    });
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("stamp-runtime")) return { outcome: "stamped" };
      return {};
    });

    const controller = newReachableController();

    writeInstallRecord("1.7.0");
    await converge(controller, BACKGROUND);
    await controller.installVersion("1.8.0", false);
    await controller.installVersion("1.8.0", true);
    await controller.registerService(BACKGROUND);
    await controller.respawn(BACKGROUND);
    await controller.deregisterService();
    await controller.uninstallHost(false);
    await controller.uninstallHost(true);
    await controller.stopHost(stopRequest("if-idle", "attached", null));
    await controller.stopHost(stopRequest("force", "attached", null));
    await controller.stopHost(stopRequest("if-idle", "detached", null));

    writeStagedRecord();
    await controller.applyStaged("manual", false);
    removeStagedRecord();

    // Last: a null-runtime install with a live pid.json is the shape that also
    // drives `host stamp-runtime` through the plain-run spawner.
    const downController = newController(async () => false);
    writeInstallRecord(null);
    writePidMetadata();
    await downController.freePortAndRestart(null, null, BACKGROUND);

    const spawned: (readonly string[])[] = [
      ...streamCalls(),
      ...runCalls(),
      ...vi
        .mocked(spawnDetachedBundledTraycerCliJson)
        .mock.calls.map(([opts]) => [...opts.args]),
    ];
    expect(spawned.length).toBeGreaterThan(0);

    for (const args of spawned) {
      if (isStartCapable(args)) {
        // Exactly once, and as the trailing pair.
        expect(args.filter((arg) => arg === "--lifecycle-origin")).toHaveLength(
          1,
        );
        expect(args.slice(-2)).toEqual(["--lifecycle-origin", "desktop"]);
      } else {
        expect(hasOrigin(args)).toBe(false);
      }
    }

    // The census is only as good as what it reached: every start-capable
    // command the controller can spawn must actually have been observed
    // carrying the flag (the eighth, `host service start`, is a CLI-side
    // command the controller does not spawn; the table above pins it), and
    // the non-start commands it can reach must have been observed without it.
    const observed = new Set(spawned.map(commandKey));
    for (const key of [
      "host ensure",
      "host install",
      "host apply",
      "host service install",
      "host restart",
      "host free-port-and-restart",
      "host stop",
    ]) {
      expect(observed.has(key)).toBe(true);
      const carriers = spawned.filter((args) => commandKey(args) === key);
      expect(carriers.every((args) => hasOrigin(args))).toBe(true);
    }
    for (const key of [
      "host service uninstall",
      "host uninstall",
      "host stamp-runtime",
    ]) {
      expect(observed.has(key)).toBe(true);
      const carriers = spawned.filter((args) => commandKey(args) === key);
      expect(carriers.some((args) => hasOrigin(args))).toBe(false);
    }
  });
});

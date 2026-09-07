import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "../../__tests__/sandbox-home";


vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => join(process.env.HOME ?? "/tmp", "userData")),
    isPackaged: false,
    getAppPath: vi.fn(() => "/tmp"),
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

const desktopExecutorCohortMock = vi.hoisted(() => ({
  decide: vi.fn(),
  restoreShippedCohort: (): void => {},
}));
vi.mock("../update-executor-cohort", async () => {
  const actual = await vi.importActual<
    typeof import("../update-executor-cohort")
  >("../update-executor-cohort");
  desktopExecutorCohortMock.restoreShippedCohort = (): void => {
    desktopExecutorCohortMock.decide.mockImplementation(
      actual.decideDesktopUpdateExecutorCohort,
    );
  };
  desktopExecutorCohortMock.restoreShippedCohort();
  return {
    ...actual,
    decideDesktopUpdateExecutorCohort: desktopExecutorCohortMock.decide,
  };
});

const writeAdoptionProofMock = vi.hoisted(() => ({
  write: vi.fn(),
  restoreShipped: (): void => {},
}));

// F3 terminal-with-diagnostics contract (round 5, item #1): the tombstone must be withdrawn BEFORE the record's own `failed` commit lands, not merely gone by the time a test reads.
const terminalOrderEvents = vi.hoisted(() => ({
  events: [] as string[],
  reset: (): void => {},
}));
terminalOrderEvents.reset = (): void => {
  terminalOrderEvents.events.length = 0;
};

vi.mock("@traycer-clients/shared/host-update", async () => {
  const actual = await vi.importActual<
    typeof import("@traycer-clients/shared/host-update")
  >("@traycer-clients/shared/host-update");
  writeAdoptionProofMock.restoreShipped = (): void => {
    writeAdoptionProofMock.write.mockImplementation(actual.writeAdoptionProof);
  };
  writeAdoptionProofMock.restoreShipped();
  return {
    ...actual,
    writeAdoptionProof: writeAdoptionProofMock.write,
    commitAttemptMutationWithCapability: async (
      capability: Parameters<
        typeof actual.commitAttemptMutationWithCapability
      >[0],
      hostHomeDir: string,
      intent: Parameters<typeof actual.commitAttemptMutationWithCapability>[2],
    ) => {
      if (intent.kind === "advance" && intent.advance.phase === "failed") {
        terminalOrderEvents.events.push("terminalize-commit");
      }
      return actual.commitAttemptMutationWithCapability(
        capability,
        hostHomeDir,
        intent,
      );
    },
  };
});

vi.mock("../update-mutation", async () => {
  const actual =
    await vi.importActual<typeof import("../update-mutation")>(
      "../update-mutation",
    );
  return {
    ...actual,
    clearRestartTombstoneWithAttempt: async (
      capability: Parameters<typeof actual.clearRestartTombstoneWithAttempt>[0],
      layout: Parameters<typeof actual.clearRestartTombstoneWithAttempt>[1],
    ) => {
      terminalOrderEvents.events.push("clear-tombstone");
      return actual.clearRestartTombstoneWithAttempt(capability, layout);
    },
  };
});

import {
  runBundledTraycerCliJson,
  streamBundledTraycerCliJson,
  TraycerCliError,
  type NdjsonEvent,
} from "../../cli/traycer-cli";
import { prereleaseUpdatesEnabled } from "../../app/update-preferences";
import {
  hasUnappliedPendingLoginItemRevision,
  hostManagesHostLoginItem,
  readHostLoginItemStatus,
  registerHostLoginItem,
  unregisterHostLoginItemGuarded,
} from "../../app/host-login-item";
import { resolveBundledCliPath } from "../../cli/cli-discovery";
import { waitForHostReady } from "../host-readiness";
import { probeHostActivityBusy } from "@traycer-clients/shared/host-client/host-activity-probe";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import {
  DESKTOP_LOCK_POLL_INTERVAL_MS,
  DESKTOP_LOCK_WAIT_MS,
  HostController,
  type HostControllerHostLifecycle,
} from "../host-controller";
import {
  HOST_REMOVED_BY_USER_MESSAGE,
  type LifecycleAdmissionBlock,
  type MutationLaneStatus,
  type MutationProgress,
  type ReprovisionGuardVerdict,
} from "../host-controller-types";
import { getHostFsLayout, cliLockPath } from "../host-paths";
import { DEV_DESKTOP_SLOT_ENV } from "../dev-desktop-slot";
import { acquireDesktopCliLock } from "../desktop-cli-lock";
import {
  __resetHostRemovalStateForTest,
  isHostRemovedByUser,
  markHostRemovedByUser,
} from "../host-removal-state";
import {
  __setAsyncProcessLivenessReaderForTest,
  __setAsyncProcessStartIdentityReaderForTest,
} from "../process-identity";
import { updateAttemptRecordPath } from "@traycer/protocol/config/host-update-attempt-paths";
import { hostStopIntentPath } from "@traycer/protocol/config/host-stop-intent";
import type {
  HostUpdateAttemptExecution,
  HostUpdateAttemptPhase,
} from "@traycer/protocol/config/host-update-attempt";
import {
  acquireUpdateAttemptLock,
  commitAttemptMutationWithCapability,
  readUpdateAttemptRecord,
  withUpdateContender,
  writeAdoptionProof,
  type HostUpdateAttemptIdentity,
} from "@traycer-clients/shared/host-update";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_DEV_DESKTOP_SLOT = process.env[DEV_DESKTOP_SLOT_ENV];
let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-host-controller-"));
  sandboxHome(workHome);
  delete process.env[DEV_DESKTOP_SLOT_ENV];
  // `withDesktopCliLock`'s `open(path, "wx", ...)` needs the lock file's
  // parent directory to already exist (production always has it - the CLI
  // slot setup creates it early); a fresh temp HOME does not.
  mkdirSync(join(workHome, ".traycer", "cli"), { recursive: true });
  // `host-removal-state.ts`'s in-memory cache + memoized store handle are
  // module-level and would otherwise leak the previous test's sentinel
  // value across this test's fresh temp userData dir.
  __resetHostRemovalStateForTest();
  vi.mocked(hostManagesHostLoginItem).mockResolvedValue(false);
  vi.mocked(prereleaseUpdatesEnabled).mockReturnValue(false);
  vi.mocked(runBundledTraycerCliJson).mockResolvedValue({});
  vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({ data: {} });
  vi.mocked(waitForHostReady).mockResolvedValue({
    ready: true,
    version: "1.0.0",
    pid: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    reason: "ready",
  });
  vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(false);
  vi.mocked(readHostLoginItemStatus).mockReturnValue("enabled");
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
  // AFTER `clearAllMocks`, which does not restore implementations. Without
  // this, one `eligibleDesktopCohort()` leaks into every subsequent test.
  desktopExecutorCohortMock.restoreShippedCohort();
  writeAdoptionProofMock.restoreShipped();
  terminalOrderEvents.reset();
});

function fakeHostLifecycle(): HostControllerHostLifecycle & {
  readonly notifyRespawningCalls: number[];
} {
  const calls: number[] = [];
  return {
    get notifyRespawningCalls() {
      return calls;
    },
    notifyRespawning: () => {
      calls.push(1);
    },
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

function newController(environment: "production" | "dev"): HostController {
  return newControllerWithReachability(environment, async () => true);
}

function newControllerWithReachability(
  environment: "production" | "dev",
  reachabilityProbe: (websocketUrl: string) => Promise<boolean>,
): HostController {
  return newControllerWithLockTiming(
    environment,
    reachabilityProbe,
    DESKTOP_LOCK_WAIT_MS,
    DESKTOP_LOCK_POLL_INTERVAL_MS,
  );
}

function newControllerWithLifecycle(
  lifecycle: HostControllerHostLifecycle,
  reachabilityProbe: (websocketUrl: string) => Promise<boolean>,
): HostController {
  return new HostController({
    environment: "production",
    hostLifecycle: lifecycle,
    reachabilityProbe,
    desktopLockWaitMs: DESKTOP_LOCK_WAIT_MS,
    desktopLockPollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
  });
}

function newControllerWithLockTiming(
  environment: "production" | "dev",
  reachabilityProbe: (websocketUrl: string) => Promise<boolean>,
  desktopLockWaitMs: number,
  desktopLockPollIntervalMs: number,
): HostController {
  return new HostController({
    environment,
    hostLifecycle: fakeHostLifecycle(),
    reachabilityProbe,
    desktopLockWaitMs,
    desktopLockPollIntervalMs,
  });
}

interface InstallRecordFields {
  readonly installId?: string | null;
  readonly version: string;
  readonly runtimeVersion?: string | null;
  readonly installedAt?: string;
  readonly archiveSha256?: string | null;
}

function writeInstallRecord(
  environment: "production" | "dev",
  fields: InstallRecordFields,
): void {
  const layout = getHostFsLayout(environment);
  mkdirSync(layout.installDir, { recursive: true });
  writeFileSync(
    layout.installRecordFile,
    JSON.stringify({
      installId: fields.installId ?? "install-1",
      version: fields.version,
      runtimeVersion: fields.runtimeVersion ?? null,
      installedAt: fields.installedAt ?? "2026-01-01T00:00:00.000Z",
      archiveSha256: fields.archiveSha256 ?? "a".repeat(64),
      platform: process.platform,
      arch: process.arch,
      source: { kind: "registry", value: fields.version },
      signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
      signatureKeyId: "test-key",
      sizeBytes: 1,
      executablePath: join(layout.installDir, "traycer-host"),
    }),
  );
}

function readInstallRecordVersion(
  environment: "production" | "dev",
): string | undefined {
  const layout = getHostFsLayout(environment);
  if (!existsSync(layout.installRecordFile)) return undefined;
  const raw = JSON.parse(readFileSync(layout.installRecordFile, "utf8")) as {
    readonly version?: string;
  };
  return raw.version;
}

function writeStagedRecord(
  environment: "production" | "dev",
  version: string,
  runtimeVersion: string | null,
): void {
  const layout = getHostFsLayout(environment);
  mkdirSync(layout.stagedDir, { recursive: true });
  writeFileSync(
    layout.stagedRecordFile,
    JSON.stringify({
      stageId: `stage-${version}`,
      version,
      runtimeVersion,
    }),
  );
}

function writePidMetadata(
  environment: "production" | "dev",
  fields: {
    readonly version: string;
    readonly pid: number;
    readonly websocketUrl?: string;
    readonly startedAt?: string;
    // Omitted reproduces a pid.json written before the field existed, which
    // must read as "cannot compare identity" rather than as a mismatch.
    readonly processStartIdentity?: string;
  },
): void {
  const layout = getHostFsLayout(environment);
  mkdirSync(layout.rootDir, { recursive: true });
  writeFileSync(
    layout.pidMetadataFile,
    JSON.stringify({
      hostId: "host-1",
      websocketUrl: fields.websocketUrl ?? "ws://127.0.0.1:55555/rpc",
      version: fields.version,
      pid: fields.pid,
      startedAt: fields.startedAt ?? new Date().toISOString(),
      ...(fields.processStartIdentity === undefined
        ? {}
        : { processStartIdentity: fields.processStartIdentity }),
    }),
  );
}

function removePidMetadata(environment: "production" | "dev"): void {
  const layout = getHostFsLayout(environment);
  try {
    rmSync(layout.pidMetadataFile, { force: true });
  } catch {
    // absent is the point
  }
}

/** Deferred control over a mocked async call - resolve/reject on demand. */
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// Mirrors the REAL `traycer host available --json` wire shape (pinned by the contract test in `traycer-cli/src/commands/__tests__/host-available.test.ts`): `{ manifest: { latest.
function availableSnapshotFixture(
  latest: string,
  availableVersions: readonly string[],
): unknown {
  return {
    manifest: {
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      latest,
      versions: availableVersions.map((version) => ({
        version,
        releasedAt: "2026-01-01T00:00:00.000Z",
        releaseNotesUrl: `https://github.com/traycerai/traycer/releases/tag/host-v${version}`,
        yanked: false,
        deprecationReason: null,
        requiredCliVersion: null,
        platforms: {
          "darwin-arm64": {
            available: true,
            unavailableReason: null,
            url: `https://example.com/host-${version}.tar.gz`,
            sizeBytes: 1,
            sha256: "a".repeat(64),
            signatureUrl: `https://example.com/host-${version}.tar.gz.minisig`,
            signatureAlgorithm: "minisign",
            publicKeyId: "test-key",
          },
        },
      })),
    },
    manifestUrl: "https://example.com/versions.json",
    platformKey: "darwin-arm64",
    includePreReleases: false,
  };
}

describe("headline: convergeReady during an in-flight mutation resolves, never rejects", () => {
  it("convergeReady queued behind an in-flight applyStaged waits for it, then resolves ok - not a rejection", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", null);
    writePidMetadata("production", { version: "1.8.0", pid: process.pid });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.8.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    const applyGate = deferred<{ data: unknown }>();
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("apply")) return applyGate.promise;
      if (opts.args.includes("ensure")) {
        return {
          data: {
            running: true,
            runtimeVersion: "1.8.0",
            version: "1.8.0",
            action: "started",
          },
        };
      }
      return { data: {} };
    });

    const applyPromise = controller.applyStaged("manual", false);
    await flushMicrotasks();

    let convergeSettled = false;
    const convergePromise = controller
      .convergeReady(false, { kind: "background" })
      .then((outcome) => {
        convergeSettled = true;
        return outcome;
      });
    await flushMicrotasks();

    // Both calls are still pending - `convergeReady` is queued, not rejected.
    expect(convergeSettled).toBe(false);

    applyGate.resolve({
      data: {
        outcome: "applied",
        record: { version: "1.8.0" },
        runningActivated: true,
        installGeneration: null,
      },
    });

    const applyOutcome = await applyPromise;
    expect(applyOutcome.kind).toBe("ok");

    const convergeOutcome = await convergePromise;
    expect(convergeOutcome).toEqual({
      kind: "ok",
      value: { running: true, version: "1.8.0" },
    });
  });

  it("two concurrent applyStaged submissions both resolve - no 'Another host operation' rejection", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", null);
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        outcome: "applied",
        record: { version: "1.8.0" },
        runningActivated: true,
        installGeneration: null,
      },
    });

    const [first, second] = await Promise.all([
      controller.applyStaged("manual", false),
      controller.applyStaged("manual", false),
    ]);
    expect(first.kind).toBe("ok");
    expect(second.kind).toBe("ok");
  });

  it('the literal string "Another host operation" does not appear anywhere in host-controller.ts', async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      join(__dirname, "..", "host-controller.ts"),
      "utf8",
    );
    expect(source).not.toContain("Another host operation");
  });
});

describe("mutation lane: wait-never-reject", () => {
  it("a failed job does not starve the next queued job", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(streamBundledTraycerCliJson).mockRejectedValueOnce(
      new Error("boom"),
    );
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValueOnce({
      data: { activated: true },
    });

    const first = await controller.respawn({ kind: "background" });
    expect(first.kind).toBe("failed");

    const second = await controller.respawn({ kind: "background" });
    expect(second.kind).toBe("ok");
  });

  it("submissions run in FIFO order, never overlapping (retargets the deleted host-registration-cycle-coordination.test.ts mutual-exclusion coverage)", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");

    let concurrentHolders = 0;
    let maxConcurrentHolders = 0;
    const order: string[] = [];
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      concurrentHolders += 1;
      maxConcurrentHolders = Math.max(maxConcurrentHolders, concurrentHolders);
      order.push(opts.args.join(" "));
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrentHolders -= 1;
      return { data: { activated: true } };
    });

    await Promise.all([
      controller.respawn({ kind: "background" }),
      controller.applyStaged("manual", false),
      controller.respawn({ kind: "background" }),
    ]);

    expect(maxConcurrentHolders).toBe(1);
    // Fixup C2: the title's own "FIFO order" claim was never checked - only mutual exclusion was.
    expect(order).toEqual([
      "host restart --force --defer-if-parked",
      "host download --automatic",
      "host apply --expected-stage-fingerprint stage-1.8.0",
    ]);
  });

  it("pushes the real apply lane's start, progress, and immediate settlement", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.8.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });
    const statuses: Array<MutationLaneStatus | null> = [];
    const progresses: MutationProgress[] = [];
    const unsubscribeStatus = controller.onMutationStatus((status) => {
      statuses.push(status);
    });
    const unsubscribeProgress = controller.onMutationProgress((progress) => {
      progresses.push(progress);
    });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) return { data: {} };
      opts.onEvent({
        type: "progress",
        stage: "apply",
        percent: 50,
        bytes: 50,
        totalBytes: 100,
        message: "applying",
        workUnits: null,
      });
      return {
        data: {
          outcome: "applied",
          record: { version: "1.8.0", runtimeVersion: "1.8.0" },
          runningActivated: true,
          installGeneration: null,
        },
      };
    });

    const outcome = await controller.applyStaged("manual", false);
    unsubscribeProgress();
    unsubscribeStatus();

    expect(outcome.kind).toBe("ok");
    expect(statuses).toEqual([
      expect.objectContaining({ kind: "apply", progress: null }),
      expect.objectContaining({
        kind: "apply",
        progress: expect.objectContaining({ stage: "apply", percent: 50 }),
      }),
      null,
    ]);
    expect(progresses).toEqual([
      expect.objectContaining({ stage: "apply", percent: 50 }),
    ]);
  });
});

// Mi-1 - a bare progress heartbeat must hold the last concrete numbers instead of blanking the progress bar to null.
describe("update-flow findings: Mo-A approval preflight, Mi-1 heartbeat carry-forward", () => {
  it("Mo-A: a running host + requires-approval fails fast with the approval message and never boots the healthy host out", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    vi.mocked(readHostLoginItemStatus).mockReturnValue("requires-approval");
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });

    const outcome = await controller.activateInstalled(true);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toContain("disabled by macOS");
    }
    // The preflight fires before `registerHostLoginItem`'s leading bootout, so
    // the healthy host is left running rather than killed by a cycle that
    // could never re-enable it.
    expect(registerHostLoginItem).not.toHaveBeenCalled();
  });

  it("Mi-1: a bare progress heartbeat holds the last concrete percent/bytes instead of blanking the bar", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.8.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });
    const progresses: MutationProgress[] = [];
    const unsubscribeProgress = controller.onMutationProgress((p) => {
      progresses.push(p);
    });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) return { data: {} };
      opts.onEvent({
        type: "progress",
        stage: "apply",
        percent: 50,
        bytes: 50,
        totalBytes: 100,
        message: "applying",
        workUnits: null,
      });
      // A watchdog heartbeat: liveness only, every numeric field null.
      opts.onEvent({
        type: "progress",
        stage: "apply",
        percent: null,
        bytes: null,
        totalBytes: null,
        message: null,
        workUnits: null,
      });
      return {
        data: {
          outcome: "applied",
          record: { version: "1.8.0", runtimeVersion: "1.8.0" },
          runningActivated: true,
          installGeneration: null,
        },
      };
    });

    const outcome = await controller.applyStaged("manual", false);
    unsubscribeProgress();

    expect(outcome.kind).toBe("ok");
    // The heartbeat carried the prior 50%/50/100 forward rather than nulling it.
    expect(progresses).toEqual([
      expect.objectContaining({
        stage: "apply",
        percent: 50,
        bytes: 50,
        totalBytes: 100,
      }),
      expect.objectContaining({
        stage: "apply",
        percent: 50,
        bytes: 50,
        totalBytes: 100,
      }),
    ]);
  });

  it("a registry liveness tick keeps the running stage, but a real stage transition still lands", async () => {
    // The tick's message must still come through.
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.8.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });
    const progresses: MutationProgress[] = [];
    const unsubscribeProgress = controller.onMutationProgress((p) => {
      progresses.push(p);
    });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) return { data: {} };
      opts.onEvent({
        type: "progress",
        stage: "download",
        percent: 45,
        bytes: 45,
        totalBytes: 100,
        message: "downloading host 1.8.0",
        workUnits: null,
      });
      opts.onEvent({
        type: "progress",
        stage: "registry-archive-backoff",
        percent: null,
        bytes: null,
        totalBytes: null,
        message: "retrying host archive shortly",
        workUnits: null,
      });
      opts.onEvent({
        type: "progress",
        stage: "extract",
        percent: null,
        bytes: null,
        totalBytes: null,
        message: "extracting host 1.8.0",
        workUnits: null,
      });
      return {
        data: {
          outcome: "applied",
          record: { version: "1.8.0", runtimeVersion: "1.8.0" },
          runningActivated: true,
          installGeneration: null,
        },
      };
    });

    const outcome = await controller.applyStaged("manual", false);
    unsubscribeProgress();

    expect(outcome.kind).toBe("ok");
    expect(progresses).toEqual([
      expect.objectContaining({ stage: "download", percent: 45 }),
      // The tick carries EVERYTHING forward, stage included. This is the arm
      // that protects what Mi-1 exists for, and the one a careless scoping of
      // the carry-forward breaks.
      expect.objectContaining({
        stage: "download",
        percent: 45,
        bytes: 45,
        totalBytes: 100,
        message: "retrying host archive shortly",
        workUnits: null,
      }),
      expect.objectContaining({
        stage: "extract",
        percent: null,
        bytes: null,
        totalBytes: null,
      }),
    ]);
  });

  it("a genuine stage transition blanks the bar instead of inheriting a COMPLETED download's numbers", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.8.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });
    const progresses: MutationProgress[] = [];
    const unsubscribeProgress = controller.onMutationProgress((p) => {
      progresses.push(p);
    });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) return { data: {} };
      // A download that RAN TO COMPLETION - the case that produced the full bar.
      opts.onEvent({
        type: "progress",
        stage: "download",
        percent: 100,
        bytes: 838_860_800,
        totalBytes: 838_860_800,
        message: "downloading host 1.8.0",
        workUnits: null,
      });
      opts.onEvent({
        type: "progress",
        stage: "extract",
        percent: null,
        bytes: null,
        totalBytes: null,
        message: "extracting host 1.8.0",
        workUnits: null,
      });
      return {
        data: {
          outcome: "applied",
          record: { version: "1.8.0", runtimeVersion: "1.8.0" },
          runningActivated: true,
          installGeneration: null,
        },
      };
    });

    const outcome = await controller.applyStaged("manual", false);
    unsubscribeProgress();

    expect(outcome.kind).toBe("ok");
    // Positive first: the download's own numbers DID land, so the absences below
    // are not satisfied by a lane that never reported anything.
    expect(progresses[0]).toEqual(
      expect.objectContaining({
        stage: "download",
        percent: 100,
        bytes: 838_860_800,
        totalBytes: 838_860_800,
      }),
    );
    expect(progresses[1]).toEqual(
      expect.objectContaining({
        stage: "extract",
        percent: null,
        bytes: null,
        totalBytes: null,
        message: "extracting host 1.8.0",
        workUnits: null,
      }),
    );
  });
});

describe("coalescing: duplicate in-flight submissions join rather than re-execute", () => {
  it("P10/V6: identical apply intents coalesce across their preflight and in-lane eligibility verification", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");

    const downloadGate = deferred<void>();
    let availableCalls = 0;
    let downloadCalls = 0;
    let applyCalls = 0;
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        availableCalls += 1;
        return availableSnapshotFixture("1.8.0", ["1.8.0"]);
      }
      return {};
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) {
        downloadCalls += 1;
        await downloadGate.promise;
        return { data: {} };
      }
      if (opts.args.includes("apply")) {
        applyCalls += 1;
        return {
          data: {
            outcome: "applied",
            record: { version: "1.8.0" },
            runningActivated: true,
            installGeneration: null,
          },
        };
      }
      return { data: {} };
    });

    const first = controller.applyStaged("manual", false);
    const second = controller.applyStaged("manual", false);
    expect(first).toBe(second);
    await vi.waitFor(() => {
      expect(downloadCalls).toBe(1);
    });

    downloadGate.resolve(undefined);
    await Promise.all([first, second]);

    expect(availableCalls).toBe(1);
    // Coalescing retains one off-lane eligibility pass and one download;
    // no mutation-lane registry probe is permitted.
    expect(downloadCalls).toBe(1);
    expect(applyCalls).toBe(1);
  });

  it("P10: identical activation intents coalesce before their registry preflight", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });

    let availableCalls = 0;
    let restartCalls = 0;
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        availableCalls += 1;
        return availableSnapshotFixture("1.7.0", ["1.7.0"]);
      }
      return {};
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("restart")) {
        restartCalls += 1;
        return { data: { activated: true } };
      }
      return { data: {} };
    });

    const first = controller.activateInstalled(false);
    const second = controller.activateInstalled(false);
    expect(first).toBe(second);
    await Promise.all([first, second]);

    expect(availableCalls).toBe(1);
    expect(restartCalls).toBe(1);
  });

  it("P10: concurrent stageLatest calls share the production reconcile and download", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });

    const downloadGate = deferred<void>();
    let availableCalls = 0;
    let downloadCalls = 0;
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        availableCalls += 1;
        return availableSnapshotFixture("1.8.0", ["1.8.0"]);
      }
      return {};
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) {
        downloadCalls += 1;
        await downloadGate.promise;
      }
      return { data: {} };
    });

    const first = controller.stageLatest();
    const second = controller.stageLatest();
    expect(first).toBe(second);
    await vi.waitFor(() => {
      expect(downloadCalls).toBe(1);
    });

    downloadGate.resolve(undefined);
    await Promise.all([first, second]);

    expect(availableCalls).toBe(1);
    expect(downloadCalls).toBe(1);
  });

  it("two simultaneous respawn() calls execute the restart once; both callers resolve with the same outcome", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    let restartCalls = 0;
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async () => {
      restartCalls += 1;
      return { data: { activated: true } };
    });

    const [first, second] = await Promise.all([
      controller.respawn({ kind: "background" }),
      controller.respawn({ kind: "background" }),
    ]);

    expect(restartCalls).toBe(1);
    expect(first).toEqual({ kind: "ok", value: { activated: true } });
    expect(second).toEqual({ kind: "ok", value: { activated: true } });
  });

  it("two simultaneous installVersion calls with the same pin AND force join into one install", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    let installCalls = 0;
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async () => {
      installCalls += 1;
      return { data: { version: "1.8.0", installGeneration: null } };
    });

    const [first, second] = await Promise.all([
      controller.installVersion("1.8.0", false),
      controller.installVersion("1.8.0", false),
    ]);

    expect(installCalls).toBe(1);
    expect(first.kind).toBe("ok");
    expect(second.kind).toBe("ok");
  });

  it("two simultaneous installVersion calls with a DIFFERENT force do not coalesce - both execute", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    let installCalls = 0;
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async () => {
      installCalls += 1;
      return { data: { version: "1.8.0", installGeneration: null } };
    });

    await Promise.all([
      controller.installVersion("1.8.0", false),
      controller.installVersion("1.8.0", true),
    ]);

    expect(installCalls).toBe(2);
  });

  it("a second respawn() submitted AFTER the first has fully settled runs fresh, not joined to the stale settled promise", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    let restartCalls = 0;
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async () => {
      restartCalls += 1;
      return { data: { activated: true } };
    });

    await controller.respawn({ kind: "background" });
    await controller.respawn({ kind: "background" });

    expect(restartCalls).toBe(2);
  });
});

describe("two lanes: mutation vs download independence", () => {
  it("stageLatest defers starting a new download while a mutation is active, then re-kicks once it settles", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });

    const mutationGate = deferred<{ data: unknown }>();
    const downloadCalls: string[][] = [];
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("restart")) return mutationGate.promise;
      if (opts.args.includes("download")) {
        downloadCalls.push([...opts.args]);
        return { data: {} };
      }
      return { data: {} };
    });
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        return availableSnapshotFixture("1.8.0", ["1.8.0"]);
      }
      return {};
    });

    const respawnPromise = controller.respawn({ kind: "background" });
    await flushMicrotasks();

    const stageLatestPromise = controller.stageLatest();
    await flushMicrotasks();
    // Mutation lane still owns the host - no download call was made yet.
    expect(downloadCalls).toHaveLength(0);

    mutationGate.resolve({ data: { activated: true } });
    await respawnPromise;
    await stageLatestPromise;
    await vi.waitFor(() => {
      if (downloadCalls.length === 0)
        throw new Error("download not kicked yet");
    });

    expect(downloadCalls.length).toBeGreaterThan(0);
  });

  it("re-checks mutation state after the registry probe, not just at entry - a mutation starting mid-probe still defers the download", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", null);

    const probeGate = deferred<void>();
    const restartGate = deferred<{ data: unknown }>();
    const downloadCalls: string[][] = [];
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        await probeGate.promise;
        return availableSnapshotFixture("1.8.0", ["1.8.0"]);
      }
      return {};
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) {
        downloadCalls.push([...opts.args]);
        return { data: {} };
      }
      if (opts.args.includes("restart")) return restartGate.promise;
      return { data: {} };
    });

    // stageLatest's synchronous entry check passes (nothing is active yet)
    // and it blocks mid-probe.
    const stagePromise = controller.stageLatest();
    await flushMicrotasks();

    // A mutation starts WHILE the probe above is still pending, and stays
    // active (gated on restartGate).
    const respawnPromise = controller.respawn({ kind: "background" });
    await flushMicrotasks();

    probeGate.resolve(undefined);
    await stagePromise;

    // The re-check must have caught the now-active mutation and deferred -
    // no download call despite the probe having resolved eligible.
    expect(downloadCalls).toHaveLength(0);

    restartGate.resolve({ data: { activated: true } });
    await respawnPromise;
    await vi.waitFor(() => {
      if (downloadCalls.length === 0)
        throw new Error("download not kicked yet");
    });
    expect(downloadCalls.length).toBeGreaterThan(0);
  });

  // Fixup A6: `applyStaged`'s preflight reconcile (registry probe + possible download) must run BEFORE the exclusive mutation lane is entered, so a WAN download never holds every.
  it("applyStaged's preflight download reconcile does not hold the exclusive mutation lane - a concurrent convergeReady is not blocked on it", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", null);

    const downloadGate = deferred<unknown>();
    // The property under test is "convergeReady is not blocked while apply sits in its preflight download", so apply must provably be sitting there before convergeReady starts.
    // `flushMicrotasks()` cannot establish that: it is three promise turns, while `applyStaged` first crosses real fs reads.
    const downloadStarted = deferred<void>();
    let ensureCalled = false;
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        return availableSnapshotFixture("1.8.0", ["1.8.0"]);
      }
      return {};
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) {
        downloadStarted.resolve(undefined);
        await downloadGate.promise;
        return { data: {} };
      }
      if (opts.args.includes("ensure")) {
        ensureCalled = true;
        return {
          data: {
            running: true,
            runtimeVersion: "1.7.0",
            version: "1.7.0",
            action: "noop",
          },
        };
      }
      return { data: {} };
    });

    const applyPromise = controller.applyStaged("manual", false);
    await downloadStarted.promise;

    const convergePromise = controller.convergeReady(false, {
      kind: "background",
    });
    // If the exclusive lane were held across the download, this would never resolve until `downloadGate` is released.
    await vi.waitFor(() => {
      if (!ensureCalled) throw new Error("ensure not reached yet");
    });
    expect(ensureCalled).toBe(true);

    downloadGate.resolve(undefined);
    await applyPromise;
    await convergePromise;
  });

  it("activateInstalled's preflight download reconcile (ready-update-supersedes-debt path) does not hold the exclusive mutation lane", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", null);

    const downloadGate = deferred<unknown>();
    // See the sibling applyStaged test: the preflight download must provably
    // have been entered before convergeReady starts, or this proves nothing.
    const downloadStarted = deferred<void>();
    let ensureCalled = false;
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        return availableSnapshotFixture("1.8.0", ["1.8.0"]);
      }
      return {};
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) {
        downloadStarted.resolve(undefined);
        await downloadGate.promise;
        return { data: {} };
      }
      if (opts.args.includes("ensure")) {
        ensureCalled = true;
        return {
          data: {
            running: true,
            runtimeVersion: "1.7.0",
            version: "1.7.0",
            action: "noop",
          },
        };
      }
      return { data: {} };
    });

    const activatePromise = controller.activateInstalled(false);
    await downloadStarted.promise;

    const convergePromise = controller.convergeReady(false, {
      kind: "background",
    });
    await vi.waitFor(() => {
      if (!ensureCalled) throw new Error("ensure not reached yet");
    });
    expect(ensureCalled).toBe(true);

    downloadGate.resolve(undefined);
    await activatePromise;
    await convergePromise;
  });
});

describe("download lane: terminal lastError is observable via canonical status (fixup C5)", () => {
  it("keeps lastError readable from getStatus() after a failed download, until the next attempt starts fresh", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        return availableSnapshotFixture("1.8.0", ["1.8.0"]);
      }
      return {};
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) {
        throw new Error("network unreachable");
      }
      return { data: {} };
    });

    await controller.stageLatest();

    const status = await controller.getStatus();
    expect(status.download).toEqual({
      version: "1.8.0",
      progress: null,
      lastError: "network unreachable",
    });

    // A clean settle (this attempt succeeds) clears the lane rather than
    // leaving a stale error behind.
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) {
        return { data: {} };
      }
      return { data: {} };
    });
    await controller.stageLatest();
    expect((await controller.getStatus()).download).toBeNull();
  });
});

describe("desktop-held cli-lock: two-process test", () => {
  // Fixup C1: the worker used to only hold/release the lock and exercise register.
  // This test asserts both lock participation (the real CLI has not changed disk state while the worker lock is held) and the desktop post-acquisition reread after the terminal.
  it("V1: a packaged-macOS registerService call yields to a real terminal host uninstall, then detects its post-lock supersession", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    // The controller, the worker, and the source CLI must all carry this exact value: if any side drops slot resolution, they contend on different .lock files and desktop registers.
    process.env[DEV_DESKTOP_SLOT_ENV] = "round4-v1-lock";
    const controller = newControllerWithLockTiming(
      "dev",
      async () => true,
      DESKTOP_LOCK_WAIT_MS,
      1_000,
    );
    const installRecordFile = getHostFsLayout("dev").installRecordFile;
    writeInstallRecord("dev", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });

    const lockPath = cliLockPath("dev");
    mkdirSync(join(workHome, ".traycer", "cli", "dev-runs", "round4-v1-lock"), {
      recursive: true,
    });
    const barrierDir = join(workHome, "barrier");
    mkdirSync(barrierDir, { recursive: true });

    const workerScript = join(
      __dirname,
      "fixtures",
      "desktop-cli-lock-worker.ts",
    );
    const worker = spawn("bun", ["run", workerScript], {
      env: {
        ...process.env,
        WORKER_LOCK_PATH: lockPath,
        WORKER_BARRIER_DIR: barrierDir,
        WORKER_CLI_ENTRY: join(
          process.cwd(),
          "..",
          "traycer-cli",
          "src",
          "index.ts",
        ),
        WORKER_ENVIRONMENT: "dev",
        WORKER_DEV_DESKTOP_SLOT: process.env[DEV_DESKTOP_SLOT_ENV],
        WORKER_CLI_LOCK_ACQUIRED_MARKER: join(barrierDir, "cli-lock-acquired"),
      },
    });
    const workerExit = new Promise<number | null>((resolve) => {
      worker.once("exit", (code) => resolve(code));
    });

    const waitForFile = async (path: string): Promise<void> => {
      const { stat } = await import("node:fs/promises");
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const exists = await stat(path)
          .then(() => true)
          .catch(() => false);
        if (exists) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`timed out waiting for ${path}`);
    };

    await waitForFile(join(barrierDir, "held"));
    // The worker holds the shared lock before it starts the terminal CLI.
    expect(existsSync(installRecordFile)).toBe(true);
    writeFileSync(join(barrierDir, "mutate"), "");

    await waitForFile(join(barrierDir, "cli-lock-acquired"));
    const registerPromise = controller.registerService({ kind: "background" });
    await waitForFile(join(barrierDir, "cli-exit"));
    const cliExit = JSON.parse(
      readFileSync(join(barrierDir, "cli-exit"), "utf8"),
    ) as { exitCode: number | null; stdout: string; stderr: string };
    if (cliExit.exitCode !== 0) {
      throw new Error(
        `terminal host uninstall failed (${cliExit.exitCode}): ${cliExit.stdout}${cliExit.stderr}`,
      );
    }
    await waitForFile(join(barrierDir, "mutated"));
    expect(existsSync(installRecordFile)).toBe(false);
    const outcome = await registerPromise;
    expect(outcome).toEqual({ kind: "failed", message: "No host installed." });
    expect(registerHostLoginItem).not.toHaveBeenCalled();

    expect(await workerExit).toBe(0);
  }, 30_000);
});

// Nesting a CLI-locked section inside a desktop-locked one deadlocks the subprocess against its own caller until the desktop's own subprocess timeout swallows the error.
describe("desktop-held lock vs CLI subprocess: sequenced, not nested (fixup A7)", () => {
  it("stamp-runtime's CLI subprocess call happens after the desktop lock has released, not while still held", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });

    const lockPath = cliLockPath("production");
    // This test's invariant is ORDERING (the stamp-runtime call happens after the desktop lock releases), not the total call count.
    const acquireAttempts: Array<"acquired" | "busy"> = [];
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (!args.includes("stamp-runtime")) {
        return { outcome: "unrelated" };
      }
      const outcome = await acquireDesktopCliLock({
        lockPath,
        reason: "stamp-runtime-probe",
        waitMs: 0,
        pollIntervalMs: 25,
      });
      acquireAttempts.push(outcome.kind === "acquired" ? "acquired" : "busy");
      if (outcome.kind === "acquired") {
        await outcome.handle.release();
      }
      return { outcome: "stamped" };
    });

    const outcome = await controller.activateInstalled(true);

    expect(outcome.kind).toBe("ok");
    const stampCalls = vi
      .mocked(runBundledTraycerCliJson)
      .mock.calls.filter(([args]) => args.includes("stamp-runtime"));
    expect(stampCalls).toHaveLength(1);
    expect(acquireAttempts).toEqual(["acquired"]);
  });
});

describe("desktop-held lock: exhausted-wait terminal contract is deferred (fixup A9)", () => {
  it("resolves 'deferred' once the injected lock wait is genuinely exhausted against a held lock, without hanging or throwing", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newControllerWithLockTiming(
      "production",
      async () => true,
      150,
      25,
    );
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });

    const lockPath = cliLockPath("production");
    const held = await acquireDesktopCliLock({
      lockPath,
      reason: "test-held-elsewhere",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    if (held.kind !== "acquired") {
      throw new Error("failed to seed a held lock for this test");
    }

    const outcome = await controller.activateInstalled(true);

    expect(outcome.kind).toBe("deferred");
    await held.handle.release();
  });
});

// That gate's automatic converge is retired (D14/C5).
// A held lock means nothing ran and nothing was learned about the host; the surviving manual surfaces (Settings converge, doctor) throw the outcome message whatever its kind.
describe("lock-contention terminal contract: convergeReady defers like every other mutation (supersedes fixup B3)", () => {
  it("convergeReady on packaged macOS resolves deferred when the desktop lock is held during the activation cycle", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newControllerWithLockTiming(
      "production",
      async () => true,
      150,
      25,
    );
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { action: "noop", version: "1.7.0", runtimeVersion: "1.7.0" },
    });

    const lockPath = cliLockPath("production");
    const held = await acquireDesktopCliLock({
      lockPath,
      reason: "test-held-elsewhere",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    if (held.kind !== "acquired") {
      throw new Error("failed to seed a held lock for this test");
    }

    // force: true - skips the "noop && !force" early return (same as B6's
    // force test above) so this genuinely reaches the locked activation
    // cycle's desktop-lock acquisition instead of short-circuiting first.
    const outcome = await controller.convergeReady(true, {
      kind: "background",
    });

    expect(outcome.kind).toBe("deferred");
    await held.handle.release();
  });
});

describe("canonical status: activation-state derivation", () => {
  it("unavailable when there is no reachable running host", async () => {
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    removePidMetadata("production");
    const status = await newController("production").getStatus();
    expect(status.activation).toBe("unavailable");
    expect(status.reachable).toBe(false);
  });

  // Fixup A3: a well-formed but stale pid.json (endpoint probe fails) must
  // not report `reachable`/`activated` - `getStatus` shares the same
  // `readRunningRuntimeVersion` reader `recoverIfDown` uses.
  it("unavailable when pid.json parses and the pid is alive but the endpoint probe reports unreachable", async () => {
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    const status = await newControllerWithReachability(
      "production",
      async () => false,
    ).getStatus();
    expect(status.activation).toBe("unavailable");
    expect(status.reachable).toBe(false);
    expect(status.runningRuntimeVersion).toBeNull();
  });

  it("A1: rejects a wrong-shape pid endpoint before the status probe can bless it", async () => {
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", {
      version: "1.7.0",
      pid: process.pid,
      websocketUrl: "ws://127.0.0.1:55555/not-rpc",
    });
    const probe = vi.fn(async () => true);

    const status = await newControllerWithReachability(
      "production",
      probe,
    ).getStatus();

    expect(status.reachable).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("P7/V5: rejects a recycled PID whose kernel creation stamp positively differs", async () => {
    // Both operands present and same-platform, so the comparison can reach a
    // POSITIVE "different" - the only verdict entitled to reject a live pid.
    // The stub keeps the platform tag deterministic across runners.
    const restore = __setAsyncProcessStartIdentityReaderForTest(
      async () => "linux:boot-a 1",
    );
    try {
      writeInstallRecord("production", {
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      });
      writePidMetadata("production", {
        version: "1.7.0",
        pid: process.pid,
        processStartIdentity: "linux:boot-a 2",
      });

      const status = await newControllerWithReachability(
        "production",
        async () => true,
      ).getStatus();

      expect(status.reachable).toBe(false);
      expect(status.activation).toBe("unavailable");
    } finally {
      __setAsyncProcessStartIdentityReaderForTest(restore);
    }
  });

  // F3: endpoint reachability is the positive liveness proof. A failed
  // process-start probe cannot turn that proof into a false "down" result;
  // identity only rejects a positively established recycled PID.
  it("F3: keeps a handshake-reachable host online when its OS identity probe is indeterminate", async () => {
    const restore = __setAsyncProcessStartIdentityReaderForTest(
      async () => null,
    );
    try {
      writeInstallRecord("production", {
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      });
      // A recorded identity IS present, so the row exercises a failed PROBE
      // rather than the easier missing-record path.
      writePidMetadata("production", {
        version: "1.7.0",
        pid: process.pid,
        processStartIdentity: "linux:boot-a 1",
      });

      const status = await newControllerWithReachability(
        "production",
        async () => true,
      ).getStatus();

      expect(status.reachable).toBe(true);
      expect(status.activation).toBe("activated");
    } finally {
      __setAsyncProcessStartIdentityReaderForTest(restore);
    }
  });

  it("F4: awaits the async identity probe instead of synchronously shelling out from getStatus", async () => {
    const livenessGate = deferred<"alive" | "dead" | "indeterminate">();
    const livenessReader = vi.fn(async () => livenessGate.promise);
    const startReader = vi.fn(async () => "linux:boot-a 1");
    const restoreLiveness =
      __setAsyncProcessLivenessReaderForTest(livenessReader);
    const restoreStart =
      __setAsyncProcessStartIdentityReaderForTest(startReader);
    try {
      writeInstallRecord("production", {
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      });
      writePidMetadata("production", {
        version: "1.7.0",
        pid: process.pid,
        processStartIdentity: "linux:boot-a 1",
      });
      const statusPromise = newControllerWithReachability(
        "production",
        async () => true,
      ).getStatus();
      await vi.waitFor(() => {
        expect(livenessReader).toHaveBeenCalledOnce();
      });
      // `getStatus()` has reached the production identity path but cannot
      // finish until its off-thread probe returns. A synchronous replacement
      // bypasses this reader entirely and fails this boundary assertion.
      expect(startReader).not.toHaveBeenCalled();

      livenessGate.resolve("alive");
      await expect(statusPromise).resolves.toMatchObject({ reachable: true });
      expect(startReader).toHaveBeenCalledOnce();
    } finally {
      __setAsyncProcessStartIdentityReaderForTest(restoreStart);
      __setAsyncProcessLivenessReaderForTest(restoreLiveness);
    }
  });

  it("reports a handshake-reachable stale record unavailable when the PID is confirmed dead", async () => {
    const restoreLiveness = __setAsyncProcessLivenessReaderForTest(
      async () => "dead",
    );
    try {
      writeInstallRecord("production", {
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      });
      writePidMetadata("production", {
        version: "1.7.0",
        pid: 999_999,
      });

      const status = await newControllerWithReachability(
        "production",
        async () => true,
      ).getStatus();

      expect(status.reachable).toBe(false);
      expect(status.activation).toBe("unavailable");
    } finally {
      __setAsyncProcessLivenessReaderForTest(restoreLiveness);
    }
  });

  it("A1: rejects a handshake-reachable legacy pid record when liveness proves its PID dead", async () => {
    const restoreLiveness = __setAsyncProcessLivenessReaderForTest(
      async () => "dead",
    );
    try {
      writeInstallRecord("production", {
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      });
      const layout = getHostFsLayout("production");
      mkdirSync(layout.rootDir, { recursive: true });
      writeFileSync(
        layout.pidMetadataFile,
        JSON.stringify({
          hostId: "host-1",
          websocketUrl: "ws://127.0.0.1:55555/rpc",
          version: "1.7.0",
          pid: 999_999,
        }),
      );

      const status = await newControllerWithReachability(
        "production",
        async () => true,
      ).getStatus();

      expect(status.reachable).toBe(false);
      expect(status.runningRuntimeVersion).toBeNull();
    } finally {
      __setAsyncProcessLivenessReaderForTest(restoreLiveness);
    }
  });

  it("A1: rejects a handshake-reachable malformed-publication record when liveness proves its PID dead", async () => {
    const restoreLiveness = __setAsyncProcessLivenessReaderForTest(
      async () => "dead",
    );
    try {
      writeInstallRecord("production", {
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      });
      writePidMetadata("production", {
        version: "1.7.0",
        pid: 999_999,
        startedAt: "not-a-timestamp",
      });

      const status = await newControllerWithReachability(
        "production",
        async () => true,
      ).getStatus();

      expect(status.reachable).toBe(false);
      expect(status.runningRuntimeVersion).toBeNull();
    } finally {
      __setAsyncProcessLivenessReaderForTest(restoreLiveness);
    }
  });

  it("activationUnknown when the install record's runtimeVersion is null but the host is reachable", async () => {
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    const status = await newController("production").getStatus();
    expect(status.activation).toBe("activationUnknown");
  });

  it("pendingActivation when the running runtime stamp differs from the installed one", async () => {
    writeInstallRecord("production", {
      version: "1.8.0",
      runtimeVersion: "1.8.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    const status = await newController("production").getStatus();
    expect(status.activation).toBe("pendingActivation");
  });

  it("activated when the running runtime stamp equals the installed one", async () => {
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    const status = await newController("production").getStatus();
    expect(status.activation).toBe("activated");
  });

  it("a legacy null-runtime install record converges within one activation cycle across two simulated app launches", async () => {
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
      installId: "install-legacy",
    });
    removePidMetadata("production");
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("restart")) {
        return {
          data: {
            installGeneration: "legacy-command-generation",
            runtimeVersion: null,
            runtimeWasNull: true,
          },
        };
      }
      return { data: {} };
    });
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("stamp-runtime")) return { outcome: "stamped" };
      return {};
    });

    const launch1 = newController("production");
    // A real activation needs a running host identity for stamp-runtime's
    // observed pid/startedAt/version - publish it as the CLI-owned restart
    // "would" once the host is actually up.
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    const activated = await launch1.activateInstalled(false);
    expect(activated.kind).toBe("ok");
    expect(runBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.arrayContaining(["stamp-runtime"]),
    );

    // Simulate the CLI having durably written the stamp to install.json (a
    // real `host stamp-runtime` call does this; the mock above doesn't
    // touch disk, so the test asserts the convergence contract explicitly).
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
      installId: "install-legacy",
    });

    // Launch 2: a fresh controller instance (nothing in-memory carries
    // over) reads the now-converged on-disk state directly - `activated`,
    // no restart needed.
    const launch2 = newController("production");
    const status2 = await launch2.getStatus();
    expect(status2.activation).toBe("activated");
  });
});

describe("canonical status: localAttempt retention (Ticket 07 §5.2.7)", () => {
  function writeTerminalAttemptRecord(overrides: {
    readonly updatedAt: string;
  }): void {
    const layout = getHostFsLayout("production");
    mkdirSync(layout.rootDir, { recursive: true });
    writeFileSync(
      updateAttemptRecordPath(layout.rootDir),
      JSON.stringify({
        schemaVersion: 2,
        attemptId: "local-attempt-1",
        generation: 1,
        sequence: 1,
        trigger: "manual",
        targetVersion: "2.0.0",
        phase: "failed",
        execution: "terminal",
        continuation: null,
        progress: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: overrides.updatedAt,
        completedAt: null,
        error: null,
      }),
    );
  }

  it("suppresses a terminal `failed` record older than the 7-day retention bound", async () => {
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    removePidMetadata("production");
    const eightDaysAgo = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    writeTerminalAttemptRecord({ updatedAt: eightDaysAgo });

    const status = await newController("production").getStatus();

    expect(status.localAttempt).toBeNull();
  });

  it("still surfaces a terminal `failed` record stamped recently", async () => {
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    removePidMetadata("production");
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeTerminalAttemptRecord({ updatedAt: oneHourAgo });

    const status = await newController("production").getStatus();

    expect(status.localAttempt).toEqual({
      attemptId: "local-attempt-1",
      generation: 1,
      sequence: 1,
      targetVersion: "2.0.0",
      phase: "failed",
      continuation: null,
      updatedAt: oneHourAgo,
    });
  });
});

describe("yank/apply ordering", () => {
  it("passes the download-lane stage fingerprint to the real apply command", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) return { data: {} };
      return {
        data: {
          outcome: "applied",
          record: { version: "1.8.0", runtimeVersion: "1.8.0" },
          runningActivated: true,
          installGeneration: null,
        },
      };
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.8.0",
      pid: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    expect((await controller.applyStaged("manual", false)).kind).toBe("ok");
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining([
          "host",
          "apply",
          "--expected-stage-fingerprint",
          "stage-1.8.0",
        ]),
      }),
    );
  });

  it("migrates a legacy unpinned stage through automatic redownload, then applies its fresh fingerprint", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    const layout = getHostFsLayout("production");
    mkdirSync(layout.stagedDir, { recursive: true });
    writeFileSync(
      layout.stagedRecordFile,
      JSON.stringify({
        stageId: null,
        version: "1.8.0",
        runtimeVersion: "1.8.0",
      }),
    );
    let downloadCalls = 0;
    let applyCalls = 0;
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) {
        downloadCalls += 1;
        writeStagedRecord("production", "1.8.0", "1.8.0");
        return { data: {} };
      }
      if (opts.args.includes("apply")) {
        applyCalls += 1;
        expect(opts.args).toEqual(
          expect.arrayContaining([
            "--expected-stage-fingerprint",
            "stage-1.8.0",
          ]),
        );
        return {
          data: {
            outcome: "applied",
            record: { version: "1.8.0", runtimeVersion: "1.8.0" },
            runningActivated: true,
            installGeneration: null,
          },
        };
      }
      return { data: {} };
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.8.0",
      pid: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    await expect(
      controller.applyStaged("manual", false),
    ).resolves.toMatchObject({
      kind: "ok",
      value: { appliedVersion: "1.8.0", runningActivated: true },
    });
    expect(downloadCalls).toBe(1);
    expect(applyCalls).toBe(1);
  });

  it("re-eligibility retries a stage-fingerprint mismatch once and never reports the first stage applied", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    const layout = getHostFsLayout("production");
    const applyFingerprints: string[] = [];
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) return { data: {} };
      if (opts.args.includes("apply")) {
        const fingerprintIndex = opts.args.indexOf(
          "--expected-stage-fingerprint",
        );
        const fingerprint = opts.args[fingerprintIndex + 1];
        if (fingerprint === undefined) throw new Error("missing fingerprint");
        applyFingerprints.push(fingerprint);
        if (applyFingerprints.length === 1) {
          writeFileSync(
            layout.stagedRecordFile,
            JSON.stringify({
              stageId: "stage-replaced",
              version: "1.8.0",
              runtimeVersion: "1.8.0",
            }),
          );
          return { data: { outcome: "stage-fingerprint-mismatch" } };
        }
        return {
          data: {
            outcome: "applied",
            record: { version: "1.8.0", runtimeVersion: "1.8.0" },
            runningActivated: true,
            installGeneration: null,
          },
        };
      }
      return { data: {} };
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.8.0",
      pid: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    expect((await controller.applyStaged("manual", false)).kind).toBe("ok");
    expect(applyFingerprints).toEqual(["stage-1.8.0", "stage-replaced"]);
  });

  it("caps re-eligibility at two apply attempts when every staged handoff is replaced", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    const layout = getHostFsLayout("production");
    const applyFingerprints: string[] = [];
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (!opts.args.includes("apply")) return { data: {} };
      const fingerprintIndex = opts.args.indexOf(
        "--expected-stage-fingerprint",
      );
      const fingerprint = opts.args[fingerprintIndex + 1];
      if (fingerprint === undefined) throw new Error("missing fingerprint");
      applyFingerprints.push(fingerprint);
      writeFileSync(
        layout.stagedRecordFile,
        JSON.stringify({
          stageId: `stage-replaced-${applyFingerprints.length}`,
          version: "1.8.0",
          runtimeVersion: "1.8.0",
        }),
      );
      return { data: { outcome: "stage-fingerprint-mismatch" } };
    });

    await expect(controller.applyStaged("manual", false)).resolves.toEqual({
      kind: "deferred",
      message:
        "The staged host changed while the update was being applied. Retry to apply the current stage.",
    });
    expect(applyFingerprints).toEqual(["stage-1.8.0", "stage-replaced-1"]);
  });

  it("F6: activateInstalled re-eligibility retries a stage-fingerprint mismatch exactly once", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    const layout = getHostFsLayout("production");
    const applyFingerprints: string[] = [];
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (!opts.args.includes("apply")) return { data: {} };
      const fingerprintIndex = opts.args.indexOf(
        "--expected-stage-fingerprint",
      );
      const fingerprint = opts.args[fingerprintIndex + 1];
      if (fingerprint === undefined) throw new Error("missing fingerprint");
      applyFingerprints.push(fingerprint);
      if (applyFingerprints.length === 1) {
        writeFileSync(
          layout.stagedRecordFile,
          JSON.stringify({
            stageId: "stage-replaced",
            version: "1.8.0",
            runtimeVersion: "1.8.0",
          }),
        );
        return { data: { outcome: "stage-fingerprint-mismatch" } };
      }
      return {
        data: {
          outcome: "applied",
          record: { version: "1.8.0", runtimeVersion: "1.8.0" },
          runningActivated: true,
          installGeneration: null,
        },
      };
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.8.0",
      pid: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    expect((await controller.activateInstalled(false)).kind).toBe("ok");
    expect(applyFingerprints).toEqual(["stage-1.8.0", "stage-replaced"]);
  });

  it("uses the prerelease registry view when the stage is an RC", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0-rc.1", "1.8.0-rc.1");
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0-rc.1", ["1.8.0-rc.1"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({ data: {} });

    await controller.stageLatest();

    expect(runBundledTraycerCliJson).toHaveBeenCalledWith([
      "host",
      "available",
      "--json",
      "--include-pre-releases",
    ]);
  });

  it("resolve-then-pins the newest RC when release-candidate updates are opted in", async () => {
    vi.mocked(prereleaseUpdatesEnabled).mockReturnValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.8.0",
      runtimeVersion: "1.8.0",
    });
    // Stable `latest` stays 1.8.0 (== installed, so `--automatic` sees "no
    // update"); an RC 1.9.0-rc.1 is newer and must be pinned exactly.
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0", "1.9.0-rc.1"]),
    );
    const downloads: string[] = [];
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) downloads.push(opts.args.join(" "));
      return { data: {} };
    });

    await controller.stageLatest();

    // Opt-in widens the probe to pre-releases even with no RC already staged.
    expect(runBundledTraycerCliJson).toHaveBeenCalledWith([
      "host",
      "available",
      "--json",
      "--include-pre-releases",
    ]);
    // The exact RC is pinned - never `--automatic`, which follows the stable
    // `latest` pointer that RC releases never move.
    expect(downloads).toEqual(["host download 1.9.0-rc.1"]);
  });

  it("never stages an RC at or below the installed host (downgrade guard)", async () => {
    vi.mocked(prereleaseUpdatesEnabled).mockReturnValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "2.0.0",
      runtimeVersion: "2.0.0",
    });
    // The newest available RC (1.9.0-rc.1) is OLDER than the installed 2.0.0.
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0", "1.9.0-rc.1"]),
    );
    const downloads: string[] = [];
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) downloads.push(opts.args.join(" "));
      return { data: {} };
    });

    await controller.stageLatest();

    expect(downloads).toEqual([]);
  });
  it("keeps revalidating a staged non-canonical prerelease after an opt-out", async () => {
    vi.mocked(prereleaseUpdatesEnabled).mockReturnValue(false);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0-beta.1", "1.8.0-beta.1");
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.7.0", ["1.7.0", "1.8.0-beta.1"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({ data: {} });

    await controller.stageLatest();

    expect(runBundledTraycerCliJson).toHaveBeenCalledWith([
      "host",
      "available",
      "--json",
      "--include-pre-releases",
    ]);
  });

  it("follows its own RC line with no saved preference", async () => {
    vi.mocked(prereleaseUpdatesEnabled).mockReturnValue(false);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "2.0.0-rc.1",
      runtimeVersion: "2.0.0-rc.1",
    });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.9.0", ["1.9.0", "2.0.0-rc.2", "2.1.0-rc.1"]),
    );
    const downloads: string[] = [];
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) downloads.push(opts.args.join(" "));
      return { data: {} };
    });

    await controller.stageLatest();

    expect(runBundledTraycerCliJson).toHaveBeenCalledWith([
      "host",
      "available",
      "--json",
      "--include-pre-releases",
    ]);
    expect(downloads).toEqual(["host download 2.0.0-rc.2"]);
  });

  it("pins the matching stable even while the registry `latest` still lags", async () => {
    // The case `--automatic` cannot reach: `2.0.0` is published but `latest` still points at `1.9.0`, which is a DOWNGRADE for a 2.0.0-line RC.
    vi.mocked(prereleaseUpdatesEnabled).mockReturnValue(false);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "2.0.0-rc.1",
      runtimeVersion: "2.0.0-rc.1",
    });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.9.0", ["1.9.0", "2.0.0-rc.2", "2.0.0"]),
    );
    const downloads: string[] = [];
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) downloads.push(opts.args.join(" "));
      return { data: {} };
    });

    await controller.stageLatest();

    expect(downloads).toEqual(["host download 2.0.0"]);
  });

  it("leaves an unpinned legacy stage alone while following, without attempting a purge", async () => {
    // A legacy (fingerprint-less) stage plus a line with nothing to replace it: the repair must not run `--automatic` (that would stage another line's build), and the reconcile must.
    vi.mocked(prereleaseUpdatesEnabled).mockReturnValue(false);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "2.0.0-rc.1",
      runtimeVersion: "2.0.0-rc.1",
    });
    const layout = getHostFsLayout("production");
    mkdirSync(layout.stagedDir, { recursive: true });
    writeFileSync(
      layout.stagedRecordFile,
      JSON.stringify({
        stageId: null,
        version: "2.0.0-rc.1",
        runtimeVersion: "2.0.0-rc.1",
      }),
    );
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("2.1.0", ["2.0.0-rc.1", "2.1.0"]),
    );
    const cliCommands: string[] = [];
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      cliCommands.push(opts.args.join(" "));
      return { data: {} };
    });

    await controller.stageLatest();

    // No download, no purge-stage - the bytes are left exactly as they were.
    expect(cliCommands).toEqual([]);
    expect(
      vi
        .mocked(runBundledTraycerCliJson)
        .mock.calls.filter((call) => call[0].includes("purge-stage")),
    ).toHaveLength(0);
    expect(readFileSync(layout.stagedRecordFile, "utf8")).toContain(
      "2.0.0-rc.1",
    );
    expect((await controller.getStatus()).updateReady).toBe(false);
  });

  it("still repairs an unpinned legacy stage from its own line when one exists", async () => {
    // The control: the same legacy state, but the line has published its
    // stable. The repair runs, pinned to that exact version rather than to
    // `--automatic`.
    vi.mocked(prereleaseUpdatesEnabled).mockReturnValue(false);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "2.0.0-rc.1",
      runtimeVersion: "2.0.0-rc.1",
    });
    const layout = getHostFsLayout("production");
    mkdirSync(layout.stagedDir, { recursive: true });
    writeFileSync(
      layout.stagedRecordFile,
      JSON.stringify({
        stageId: null,
        version: "2.0.0-rc.1",
        runtimeVersion: "2.0.0-rc.1",
      }),
    );
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.9.0", ["1.9.0", "2.0.0-rc.1", "2.0.0"]),
    );
    const downloads: string[] = [];
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) {
        downloads.push(opts.args.join(" "));
        writeStagedRecord("production", "2.0.0", "2.0.0");
      }
      return { data: {} };
    });

    await controller.stageLatest();

    expect(downloads).toEqual(["host download 2.0.0"]);
  });
  it("drives updateReady from the verified stage alone, with no second registry probe", async () => {
    // Proving that here means: one `host available` call for the whole reconcile, and a canonical status that reports the pinned stage as ready straight afterwards.
    vi.mocked(prereleaseUpdatesEnabled).mockReturnValue(false);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "2.0.0-rc.1",
      runtimeVersion: "2.0.0-rc.1",
    });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.9.0", ["1.9.0", "2.0.0-rc.2", "2.0.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) {
        writeStagedRecord("production", "2.0.0", "2.0.0");
      }
      return { data: {} };
    });

    await controller.stageLatest();
    const status = await controller.getStatus();

    expect(status).toMatchObject({
      installedVersion: "2.0.0-rc.1",
      stagedVersion: "2.0.0",
      updateReady: true,
    });
    // `latestVersion` keeps reporting the manifest pointer verbatim - this
    // flow pins around a lagging `latest`, it never redefines it.
    expect(status.latestVersion).toBe("1.9.0");
    expect(
      vi
        .mocked(runBundledTraycerCliJson)
        .mock.calls.filter((call) => call[0].includes("available")),
    ).toHaveLength(1);
  });

  it("purges only the yanked stage fingerprint on the download lane, never a replacement promoted during the registry probe", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    const layout = getHostFsLayout("production");
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        return availableSnapshotFixture("1.7.0", ["1.7.0"]);
      }
      if (args.includes("purge-stage")) {
        writeStagedRecord("production", "1.9.0", "1.9.0");
        return {
          outcome: "stage-fingerprint-mismatch",
          purged: false,
        };
      }
      return {};
    });

    await controller.stageLatest();

    expect(runBundledTraycerCliJson).toHaveBeenCalledWith([
      "host",
      "purge-stage",
      "--expected-stage-fingerprint",
      "stage-1.8.0",
    ]);
    expect(
      JSON.parse(readFileSync(layout.stagedRecordFile, "utf8")),
    ).toMatchObject({
      version: "1.9.0",
      stageId: "stage-1.9.0",
    });
  });

  it("applyStaged awaits the download lane before AND after reconciling eligibility (ordering edge)", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", null);

    const order: string[] = [];
    const downloadGate = deferred<unknown>();
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        order.push("available-probe");
        return availableSnapshotFixture("1.8.0", ["1.8.0"]);
      }
      return {};
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) {
        order.push("download-start");
        await downloadGate.promise;
        order.push("download-settled");
        return { data: {} };
      }
      if (opts.args.includes("apply")) {
        order.push("apply");
        return {
          data: {
            outcome: "applied",
            record: { version: "1.8.0" },
            runningActivated: true,
            installGeneration: null,
          },
        };
      }
      return { data: {} };
    });

    // Kick a background download lane (mirrors a registry-refresh tick that
    // found `staged.json` already present, the yank-heal reconcile arm).
    const stagePromise = controller.stageLatest();
    await flushMicrotasks();

    const applyPromise = controller.applyStaged("manual", false);
    await flushMicrotasks();
    // The apply must not have reached the CLI yet - it's awaiting the
    // in-flight download/reconcile first.
    expect(order).not.toContain("apply");

    downloadGate.resolve(undefined);
    await stagePromise;
    await applyPromise;

    expect(order.indexOf("download-start")).toBeLessThan(
      order.indexOf("apply"),
    );
    expect(order.indexOf("download-settled")).toBeLessThan(
      order.indexOf("apply"),
    );
  });

  it("P2/V8/V9: apply joins an in-flight yank reconcile, uses automatic staging, and re-reads the stage before consuming it", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    const layout = getHostFsLayout("production");
    const reconcileGate = deferred<void>();
    let applyCalls = 0;
    let availableCalls = 0;
    let firstReconcileReleased = false;
    let downloadCalls = 0;

    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        availableCalls += 1;
        if (availableCalls === 1) {
          await reconcileGate.promise;
          firstReconcileReleased = true;
        }
        return availableSnapshotFixture("1.7.0", ["1.7.0"]);
      }
      if (args.includes("purge-stage")) {
        rmSync(layout.stagedDir, { recursive: true, force: true });
        return { outcome: "purged", purged: true };
      }
      return {};
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) {
        downloadCalls += 1;
        if (firstReconcileReleased) {
          rmSync(layout.stagedRecordFile, { force: true });
        }
        return { data: {} };
      }
      if (opts.args.includes("apply")) {
        applyCalls += 1;
        return {
          data: {
            outcome: "applied",
            record: { version: "1.8.0" },
            runningActivated: true,
            installGeneration: null,
          },
        };
      }
      return { data: {} };
    });

    const inFlightReconcile = controller.stageLatest();
    await vi.waitFor(() => {
      expect(availableCalls).toBe(1);
    });
    const apply = controller.applyStaged("manual", false);
    // The yanked stage is still present while the asynchronous eligibility
    // probe is blocked. Apply must not consume that stale snapshot.
    expect(applyCalls).toBe(0);
    reconcileGate.resolve(undefined);
    const outcome = await apply;
    await inFlightReconcile;

    expect(outcome.kind).toBe("ok");
    expect(applyCalls).toBe(0);
    expect(downloadCalls).toBe(0);
  });

  it("F1: a queued apply rechecks staged eligibility under its own mutation without starting a second download", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    const layout = getHostFsLayout("production");
    const restartGate = deferred<void>();
    let availableCalls = 0;
    let downloadCalls = 0;
    let applyCalls = 0;

    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("purge-stage")) {
        rmSync(layout.stagedDir, { recursive: true, force: true });
        return { outcome: "purged", purged: true };
      }
      if (!args.includes("available")) return {};
      availableCalls += 1;
      return availableSnapshotFixture(
        availableCalls === 1 ? "1.8.0" : "1.7.0",
        availableCalls === 1 ? ["1.8.0"] : ["1.7.0"],
      );
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("restart")) {
        await restartGate.promise;
        return { data: { activated: true } };
      }
      if (opts.args.includes("download")) {
        downloadCalls += 1;
        return { data: {} };
      }
      if (opts.args.includes("apply")) {
        applyCalls += 1;
        return {
          data: {
            outcome: "applied",
            record: { version: "1.8.0", runtimeVersion: "1.8.0" },
            runningActivated: true,
            installGeneration: null,
          },
        };
      }
      return { data: {} };
    });

    const restart = controller.respawn({ kind: "background" });
    await vi.waitFor(() => {
      expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ["host", "restart", "--force", "--defer-if-parked"],
        }),
      );
    });
    const pendingReconcile = controller.stageLatest();
    const apply = controller.applyStaged("manual", false);

    restartGate.resolve(undefined);
    await Promise.all([restart, pendingReconcile, apply]);

    expect(availableCalls).toBe(1);
    // Eligibility is owned by the download lane; apply receives only the
    // fingerprint and never performs an in-lane registry read.
    expect(downloadCalls).toBe(1);
    expect(applyCalls).toBe(1);
  });

  it("activateInstalled re-derives updateReady after the reconcile yanks the staged version - falls through to activation, never apply", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    writeStagedRecord("production", "1.8.0", null);
    const layout = getHostFsLayout("production");
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });

    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        return availableSnapshotFixture("1.7.0", ["1.7.0"]);
      }
      if (args.includes("purge-stage")) {
        rmSync(layout.stagedDir, { recursive: true, force: true });
        return { outcome: "purged", purged: true };
      }
      return { outcome: "stamped" };
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) {
        // The yank-heal reconcile discovers the staged version was pulled
        // from the registry and discards the stage - mirrors what the real
        // CLI does on disk (out of scope here to drive for real).
        rmSync(layout.stagedRecordFile, { force: true });
        return { data: {} };
      }
      if (opts.args.includes("apply")) {
        throw new Error("must not apply a yanked stage");
      }
      if (opts.args.includes("restart")) {
        return { data: { activated: true } };
      }
      return { data: {} };
    });

    const outcome = await controller.activateInstalled(false);

    expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(["restart", "--if-idle"]),
      }),
    );
    expect(streamBundledTraycerCliJson).not.toHaveBeenCalledWith(
      expect.objectContaining({ args: expect.arrayContaining(["apply"]) }),
    );
  });
});

describe("platform matrix", () => {
  it("installVersion on a CLI-owned platform passes --if-idle unless force", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { version: "1.8.0", installGeneration: null },
    });

    await controller.installVersion("1.8.0", false);
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["host", "install", "--release", "1.8.0", "--if-idle"],
      }),
    );

    await controller.installVersion("1.8.0", true);
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["host", "install", "--release", "1.8.0"],
      }),
    );
  });

  it("installVersion on packaged macOS installs bytes with --no-service-register, then runs the locked activation cycle", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { version: "1.8.0", installGeneration: null },
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    const outcome = await controller.installVersion("1.8.0", false);

    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          "host",
          "install",
          "--release",
          "1.8.0",
          "--no-service-register",
        ],
      }),
    );
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("ok");
  });

  it("threads force through to the post-commit activation cycle, activating past a busy host", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", {
      version: "1.7.0",
      pid: process.pid,
      websocketUrl: "ws://127.0.0.1:55555/rpc",
    });
    vi.mocked(probeHostActivityBusy).mockResolvedValue(true);
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { version: "1.8.0", installGeneration: null },
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    const outcome = await controller.installVersion("1.8.0", true);

    expect(outcome.kind).toBe("ok");
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
  });

  it("substitutes the approval message on a readiness timeout when the user toggled login-item approval off mid-wait", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { version: "1.8.0", installGeneration: null },
    });
    vi.mocked(registerHostLoginItem).mockResolvedValue("enabled");
    vi.mocked(waitForHostReady).mockResolvedValueOnce({
      ready: false,
      version: null,
      pid: null,
      startedAt: null,
      reason: "pid metadata never appeared",
    });
    // A blanket "requires-approval" here made the cycle's EARLY approval terminal fire before register and before the wait, so the queued not-ready readiness above was never consumed.
    vi.mocked(readHostLoginItemStatus).mockImplementation(() =>
      vi.mocked(waitForHostReady).mock.calls.length > 0
        ? "requires-approval"
        : "enabled",
    );

    const outcome = await controller.installVersion("1.8.0", false);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toContain("disabled by macOS");
    }
  });

  describe("activateAroundParkedRegistration - the parked SMAppService register fallback", () => {
    it("restarts the running host through the CLI (--if-idle) and confirms readiness AFTER that spawn, never before it", async () => {
      vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
      const controller = newController("production");
      writeInstallRecord("production", {
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      });
      writePidMetadata("production", { version: "1.7.0", pid: process.pid });
      vi.mocked(registerHostLoginItem).mockResolvedValue("parked");
      vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({ data: {} });
      vi.mocked(waitForHostReady).mockResolvedValue({
        ready: true,
        version: "1.7.0",
        pid: process.pid,
        startedAt: "2026-01-01T00:00:00.000Z",
        reason: "ready",
      });

      const outcome = await controller.installVersion("1.8.0", false);

      expect(outcome.kind).toBe("ok");
      const restartCallIndex = vi
        .mocked(streamBundledTraycerCliJson)
        .mock.calls.findIndex(
          ([opts]) =>
            Array.isArray(opts.args) &&
            opts.args[0] === "host" &&
            opts.args[1] === "restart",
        );
      expect(restartCallIndex).toBeGreaterThanOrEqual(0);
      expect(
        vi.mocked(streamBundledTraycerCliJson).mock.calls[restartCallIndex][0]
          .args,
      ).toEqual(["host", "restart", "--if-idle", "--defer-if-parked"]);

      // Call-order proof: `waitForHostReady` must run strictly AFTER the
      // restart spawn, never before it - `completeServiceStart` (which calls
      // `waitForHostReady`) only runs once the restart has been dispatched.
      const restartOrder = vi.mocked(streamBundledTraycerCliJson).mock
        .invocationCallOrder[restartCallIndex];
      const readyOrder =
        vi.mocked(waitForHostReady).mock.invocationCallOrder[0];
      expect(readyOrder).toBeGreaterThan(restartOrder);
    });

    it("with no running host and a login item that is not enabled, fails immediately naming the parked registration and never spawns a restart", async () => {
      vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
      const controller = newController("production");
      writeInstallRecord("production", {
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      });
      // No `writePidMetadata` call: no running host, so `prePid` resolves
      // `null` and there is nothing to restart onto.
      vi.mocked(registerHostLoginItem).mockResolvedValue("parked");
      vi.mocked(readHostLoginItemStatus).mockReturnValue("not-found");
      vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({ data: {} });

      const outcome = await controller.installVersion("1.8.0", false);

      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.message).toContain("no host is running to restart");
      }
      const restartCallIndex = vi
        .mocked(streamBundledTraycerCliJson)
        .mock.calls.findIndex(
          ([opts]) => Array.isArray(opts.args) && opts.args[1] === "restart",
        );
      expect(restartCallIndex).toBe(-1);
      expect(waitForHostReady).not.toHaveBeenCalled();
    });

    it("with no running host but an ENABLED login item, kickstarts it through the CLI restart and reports activated", async () => {
      vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
      const controller = newController("production");
      writeInstallRecord("production", {
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      });
      // No `writePidMetadata` call: no running host, so `prePid` resolves
      // `null` - but the login item still reads `enabled`.
      vi.mocked(registerHostLoginItem).mockResolvedValue("parked");
      vi.mocked(readHostLoginItemStatus).mockReturnValue("enabled");
      vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
        data: { restarted: true },
      });
      vi.mocked(waitForHostReady).mockResolvedValue({
        ready: true,
        version: "1.7.0",
        pid: process.pid,
        startedAt: "2026-01-01T00:00:00.000Z",
        reason: "ready",
      });

      const outcome = await controller.installVersion("1.8.0", false);

      expect(outcome.kind).toBe("ok");
      if (outcome.kind === "ok") {
        expect(outcome.value.runningActivated).toBe(true);
      }
      const restartCallIndex = vi
        .mocked(streamBundledTraycerCliJson)
        .mock.calls.findIndex(
          ([opts]) => Array.isArray(opts.args) && opts.args[1] === "restart",
        );
      expect(restartCallIndex).toBeGreaterThanOrEqual(0);
      expect(
        vi.mocked(streamBundledTraycerCliJson).mock.calls[restartCallIndex][0]
          .args,
      ).toEqual(["host", "restart", "--if-idle", "--defer-if-parked"]);
      expect(waitForHostReady).toHaveBeenCalled();
    });

    it("with no running host but an ENABLED login item, force:true restarts with --force instead of --if-idle", async () => {
      vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
      const controller = newController("production");
      writeInstallRecord("production", {
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      });
      // No `writePidMetadata` call: no running host, so `prePid` resolves
      // `null` - but the login item still reads `enabled`.
      vi.mocked(registerHostLoginItem).mockResolvedValue("parked");
      vi.mocked(readHostLoginItemStatus).mockReturnValue("enabled");
      vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
        data: { restarted: true },
      });
      vi.mocked(waitForHostReady).mockResolvedValue({
        ready: true,
        version: "1.7.0",
        pid: process.pid,
        startedAt: "2026-01-01T00:00:00.000Z",
        reason: "ready",
      });

      const outcome = await controller.installVersion("1.8.0", true);

      expect(outcome.kind).toBe("ok");
      const restartCallIndex = vi
        .mocked(streamBundledTraycerCliJson)
        .mock.calls.findIndex(
          ([opts]) => Array.isArray(opts.args) && opts.args[1] === "restart",
        );
      expect(restartCallIndex).toBeGreaterThanOrEqual(0);
      expect(
        vi.mocked(streamBundledTraycerCliJson).mock.calls[restartCallIndex][0]
          .args,
      ).toEqual(["host", "restart", "--force", "--defer-if-parked"]);
    });

    it("with no running host and a login item that requires approval, fails with the System Settings approval guidance instead of pointing at host doctor", async () => {
      vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
      const controller = newController("production");
      writeInstallRecord("production", {
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      });
      // No `writePidMetadata` call: no running host, so `prePid` resolves
      // `null` and there is nothing to restart onto.
      vi.mocked(registerHostLoginItem).mockResolvedValue("parked");
      vi.mocked(readHostLoginItemStatus).mockReturnValue("requires-approval");
      vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({ data: {} });

      const outcome = await controller.installVersion("1.8.0", false);

      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.message).toBe(
          "Traycer's background host is registered but disabled by macOS. " +
            "Open System Settings → General → Login Items & Extensions and turn on " +
            'Traycer under "Allow in the Background", then click Retry.',
        );
        expect(outcome.message).not.toContain("host doctor");
      }
      const restartCallIndex = vi
        .mocked(streamBundledTraycerCliJson)
        .mock.calls.findIndex(
          ([opts]) => Array.isArray(opts.args) && opts.args[1] === "restart",
        );
      expect(restartCallIndex).toBe(-1);
      expect(waitForHostReady).not.toHaveBeenCalled();
    });

    it("force:true restarts with the CLI's --force (skips the cooperative shutdown claim a busy host would deny), never merely without --if-idle", async () => {
      vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
      const controller = newController("production");
      writeInstallRecord("production", {
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      });
      writePidMetadata("production", { version: "1.7.0", pid: process.pid });
      vi.mocked(registerHostLoginItem).mockResolvedValue("parked");
      vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({ data: {} });
      vi.mocked(waitForHostReady).mockResolvedValue({
        ready: true,
        version: "1.7.0",
        pid: process.pid,
        startedAt: "2026-01-01T00:00:00.000Z",
        reason: "ready",
      });

      const outcome = await controller.installVersion("1.8.0", true);

      expect(outcome.kind).toBe("ok");
      const restartCallIndex = vi
        .mocked(streamBundledTraycerCliJson)
        .mock.calls.findIndex(
          ([opts]) => Array.isArray(opts.args) && opts.args[1] === "restart",
        );
      expect(restartCallIndex).toBeGreaterThanOrEqual(0);
      expect(
        vi.mocked(streamBundledTraycerCliJson).mock.calls[restartCallIndex][0]
          .args,
      ).toEqual(["host", "restart", "--force", "--defer-if-parked"]);
    });

    it("the CLI defers for a concurrently parked activation: reports deferred and never waits for readiness of a host it did not relaunch", async () => {
      vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
      const controller = newController("production");
      writeInstallRecord("production", {
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      });
      writePidMetadata("production", { version: "1.7.0", pid: process.pid });
      vi.mocked(registerHostLoginItem).mockResolvedValue("parked");
      vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) =>
        Array.isArray(opts.args) && opts.args[1] === "restart"
          ? {
              data: {
                restarted: false,
                deferredForParkedActivation: true,
              },
            }
          : { data: {} },
      );

      const outcome = await controller.installVersion("1.8.0", false);

      expect(outcome.kind).toBe("deferred");
      expect(waitForHostReady).not.toHaveBeenCalled();
    });

    it("registerService: a park over an ENABLED login item restarts the running host and reports registered", async () => {
      vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
      const controller = newController("production");
      writeInstallRecord("production", {
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      });
      writePidMetadata("production", { version: "1.7.0", pid: process.pid });
      vi.mocked(registerHostLoginItem).mockResolvedValue("parked");
      vi.mocked(readHostLoginItemStatus).mockReturnValue("enabled");
      vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({ data: {} });
      vi.mocked(waitForHostReady).mockResolvedValue({
        ready: true,
        version: "1.7.0",
        pid: process.pid,
        startedAt: "2026-01-01T00:00:00.000Z",
        reason: "ready",
      });

      const outcome = await controller.registerService({ kind: "background" });

      expect(outcome).toEqual({ kind: "ok", value: { registered: true } });
      expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ["host", "restart", "--if-idle", "--defer-if-parked"],
        }),
      );
    });

    it("registerService: a park over a REQUIRES-APPROVAL login item fails with the approval message and restarts nothing", async () => {
      vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
      const controller = newController("production");
      writeInstallRecord("production", {
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      });
      writePidMetadata("production", { version: "1.7.0", pid: process.pid });
      vi.mocked(registerHostLoginItem).mockResolvedValue("parked");
      vi.mocked(readHostLoginItemStatus).mockReturnValue("requires-approval");
      vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({ data: {} });

      const outcome = await controller.registerService({ kind: "background" });

      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.message).toMatch(/System Settings|approv/i);
      }
      expect(streamBundledTraycerCliJson).not.toHaveBeenCalled();
      expect(waitForHostReady).not.toHaveBeenCalled();
    });

    it("registerService: a park over a NOT-FOUND login item fails naming the status and restarts nothing", async () => {
      vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
      const controller = newController("production");
      writeInstallRecord("production", {
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      });
      writePidMetadata("production", { version: "1.7.0", pid: process.pid });
      vi.mocked(registerHostLoginItem).mockResolvedValue("parked");
      vi.mocked(readHostLoginItemStatus).mockReturnValue("not-found");
      vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({ data: {} });

      const outcome = await controller.registerService({ kind: "background" });

      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.message).toContain("status=not-found");
      }
      expect(streamBundledTraycerCliJson).not.toHaveBeenCalled();
    });
  });

  it("activates when ensure reports a non-noop action even though a stale old process is still reachable", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    // Bytes for 1.8.0 were just installed (unactivated), but the OLD 1.7.0
    // process is still genuinely alive and reachable - this is exactly the
    // state that used to mask the just-installed bytes from activation.
    writeInstallRecord("production", {
      version: "1.8.0",
      runtimeVersion: null,
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { action: "installed", version: "1.8.0", runtimeVersion: null },
    });

    await controller.convergeReady(false, { kind: "background" });

    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
  });

  // Fixup B6: an explicit `force: true` used to be silently dropped the
  // moment any host (stale or not) happened to already be reachable.
  it("activates when force is set even though ensure reports noop and the host is already reachable", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { action: "noop", version: "1.7.0", runtimeVersion: "1.7.0" },
    });

    await controller.convergeReady(true, { kind: "background" });

    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
  });

  it("registerService uses the CLI on non-macOS and the login-item helper on packaged macOS", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(false);
    const cliController = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    await cliController.registerService({ kind: "background" });
    expect(runBundledTraycerCliJson).not.toHaveBeenCalled();
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(["host", "service", "install"]),
      }),
    );
    expect(waitForHostReady).toHaveBeenCalledTimes(1);
    expect(registerHostLoginItem).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("enabled");
    const macController = newController("production");
    await macController.registerService({ kind: "background" });
    expect(runBundledTraycerCliJson).not.toHaveBeenCalled();
    expect(streamBundledTraycerCliJson).not.toHaveBeenCalled();
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
    expect(waitForHostReady).toHaveBeenCalledTimes(1);
  });

  it("deregisterService streams `host service uninstall` on non-macOS rather than running it under the flat JSON timeout", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(false);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });

    const outcome = await controller.deregisterService();

    expect(outcome).toEqual({ kind: "ok", value: { registered: false } });
    expect(runBundledTraycerCliJson).not.toHaveBeenCalled();
    expect(streamBundledTraycerCliJson).toHaveBeenCalledTimes(1);
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["host", "service", "uninstall"] }),
    );

    // Ablation: route the call back through `this.runBundled` → this test
    // reddens on both mock assertions.
  });


  it("a user-repair converge clears the removal sentinel at the head of the lane", async () => {
    // The bug this closes: `convergeReady` short-circuits to
    // ok/{running:false} while the sentinel is set, so "Install host" on a
    // removed host reported "Fix applied" having installed nothing.
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(false);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    await markHostRemovedByUser();
    expect(await isHostRemovedByUser()).toBe(true);

    const outcome = await controller.convergeReady(false, {
      kind: "user-repair",
      targetHostId: "local-host",
      guard: () => Promise.resolve({ kind: "proceed" }),
    });

    // Not merely "the sentinel is gone afterwards"  -  the converge must have
    // actually RUN. A short-circuit would also leave kind "ok".
    expect(await isHostRemovedByUser()).toBe(false);
    expect(streamBundledTraycerCliJson).toHaveBeenCalled();
    expect(outcome.kind).toBe("ok");
  });
  it("a user-repair whose guard abandons mutates nothing", async () => {
    // The host was replaced while the repair waited in the lane. Nothing may
    // run  -  and critically the sentinel must NOT be cleared, since clearing
    // it is itself a write against whichever host is now current.
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    await markHostRemovedByUser();

    const outcome = await controller.convergeReady(false, {
      kind: "user-repair",
      targetHostId: "local-host",
      guard: () =>
        Promise.resolve({ kind: "abandon", message: "host changed" }),
    });

    expect(outcome).toEqual({ kind: "abandoned", message: "host changed" });
    expect(streamBundledTraycerCliJson).not.toHaveBeenCalled();
    expect(await isHostRemovedByUser()).toBe(true);
  });

  it("the guard is asked at the head of the lane, not when the repair is submitted", async () => {
    // The whole point of moving the check into the controller. The repair is
    // submitted while an install holds the lane; the guard must not run until
    // that install has finished and this job reaches the head.
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    const installGate = deferred<void>();
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async () => {
      await installGate.promise;
      return { data: { action: "noop", version: "1.7.0" } };
    });
    const occupy = controller.convergeReady(false, { kind: "background" });

    let guardAsked = false;
    const repair = controller.registerService({
      kind: "user-repair",
      targetHostId: "local-host",
      guard: () => {
        guardAsked = true;
        return Promise.resolve({ kind: "proceed" });
      },
    });

    await vi.waitFor(() => {
      expect(streamBundledTraycerCliJson).toHaveBeenCalled();
    });
    expect(guardAsked).toBe(false);

    installGate.resolve();
    await occupy;
    await repair;
    expect(guardAsked).toBe(true);
  });

  it("a user-repair does not coalesce onto a background job of the same shape", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    await markHostRemovedByUser();

    const background = controller.convergeReady(false, { kind: "background" });
    let guardAsked = false;
    const repair = controller.convergeReady(false, {
      kind: "user-repair",
      targetHostId: "local-host",
      guard: () => {
        guardAsked = true;
        return Promise.resolve({ kind: "proceed" });
      },
    });

    expect(await background).toEqual({
      kind: "ok",
      value: { running: false, version: null },
    });
    await repair;
    // Had they coalesced, the repair would have resolved the background
    // job's short-circuit and never asked.
    expect(guardAsked).toBe(true);
    expect(await isHostRemovedByUser()).toBe(false);
  });

  it("two coalesced user-repairs for the same host both receive the guard's refusal", async () => {
    // The refusal must ride the SHARED settled outcome - as the `abandoned` arm.
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    const guardGate = deferred<ReprovisionGuardVerdict>();
    const first = controller.convergeReady(false, {
      kind: "user-repair",
      targetHostId: "local-host",
      guard: () => guardGate.promise,
    });
    let secondGuardAsked = false;
    const second = controller.convergeReady(false, {
      kind: "user-repair",
      targetHostId: "local-host",
      guard: () => {
        secondGuardAsked = true;
        return Promise.resolve({ kind: "proceed" });
      },
    });

    guardGate.resolve({ kind: "abandon", message: "host changed" });
    await expect(first).resolves.toEqual({
      kind: "abandoned",
      message: "host changed",
    });
    await expect(second).resolves.toEqual({
      kind: "abandoned",
      message: "host changed",
    });
    // Proves the two really were ONE job  -  the joiner's own guard never ran.
    expect(secondGuardAsked).toBe(false);
    expect(streamBundledTraycerCliJson).not.toHaveBeenCalled();
  });

  it("a queued user-repair restart asks its guard at the head of the lane and abandons after a host swap", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    const installGate = deferred<void>();
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async () => {
      await installGate.promise;
      return { data: { action: "noop", version: "1.7.0" } };
    });
    const occupy = controller.convergeReady(false, { kind: "background" });

    let guardAsked = false;
    const restart = controller.respawn({
      kind: "user-repair",
      targetHostId: "local-host",
      guard: () => {
        guardAsked = true;
        return Promise.resolve({ kind: "abandon", message: "host changed" });
      },
    });

    await vi.waitFor(() => {
      expect(streamBundledTraycerCliJson).toHaveBeenCalled();
    });
    expect(guardAsked).toBe(false);

    installGate.resolve();
    await occupy;
    await expect(restart).resolves.toEqual({
      kind: "abandoned",
      message: "host changed",
    });
    expect(guardAsked).toBe(true);
    // The restart itself never ran  -  the only CLI traffic was the converge
    // that occupied the lane.
    const restartCalls = vi
      .mocked(streamBundledTraycerCliJson)
      .mock.calls.filter((call) => call[0].args.includes("restart"));
    expect(restartCalls).toEqual([]);
  });

  it("a respawn admitted after another respawn already restarted answers restarted without a second cycle", async () => {
    // Without it the second forced cycle fires immediately after the first and kills the sessions that just reconnected to the fresh host.
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    const restartGate = deferred<void>();
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async () => {
      await restartGate.promise;
      return { data: { activated: true } };
    });
    const watched = controller.respawn({
      kind: "user-repair",
      targetHostId: "local-host",
      guard: () => Promise.resolve({ kind: "proceed" }),
    });
    const background = controller.respawn({ kind: "background" });

    restartGate.resolve();
    await expect(watched).resolves.toEqual({
      kind: "ok",
      value: { activated: true },
    });
    await expect(background).resolves.toEqual({
      kind: "ok",
      value: { activated: true },
    });
    // ONE actual restart: the second job reported the first's completed
    // cycle as its own fulfilment instead of running another.
    expect(streamBundledTraycerCliJson).toHaveBeenCalledTimes(1);
  });

  it("a FAILED respawn does not satisfy its queued twin — the twin still runs as the retry", async () => {
    // Only a COMPLETED restart bumps the generation. A busy/failed cycle
    // never touched the host, so the queued twin must run rather than
    // report a restart that never happened.
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(streamBundledTraycerCliJson)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ data: { activated: true } });
    const first = controller.respawn({
      kind: "user-repair",
      targetHostId: "local-host",
      guard: () => Promise.resolve({ kind: "proceed" }),
    });
    const second = controller.respawn({ kind: "background" });

    await expect(first).resolves.toEqual({
      kind: "failed",
      message: expect.stringContaining("boom"),
    });
    await expect(second).resolves.toEqual({
      kind: "ok",
      value: { activated: true },
    });
    expect(streamBundledTraycerCliJson).toHaveBeenCalledTimes(2);
  });

  it("F8b: CLI registerService treats a readiness timeout as non-converged and never reports registration success", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: false,
      version: null,
      pid: null,
      startedAt: null,
      reason: "timeout",
    });

    const outcome = await controller.registerService({ kind: "background" });

    expect(outcome.kind).toBe("failed");
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(["host", "service", "install"]),
      }),
    );
  });

  it("F8b: CLI registerService stamps a committed null-runtime record only after readiness", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        installGeneration: "service-install-command-generation",
        runtimeVersion: null,
        runtimeWasNull: true,
      },
    });
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("stamp-runtime")) return { outcome: "stamped" };
      return {};
    });

    const outcome = await controller.registerService({ kind: "background" });

    expect(outcome.kind).toBe("ok");
    expect(waitForHostReady).toHaveBeenCalledTimes(1);
    expect(runBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.arrayContaining(["host", "stamp-runtime"]),
    );
  });

  it("F8b: packaged-macOS registerService routes requires-approval to Doctor instead of reporting success", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("requires-approval");
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });

    const outcome = await controller.registerService({ kind: "background" });

    expect(outcome).toMatchObject({
      kind: "failed",
      message: expect.stringContaining("System Settings"),
    });
    expect(waitForHostReady).not.toHaveBeenCalled();
  });

  it("F8b: packaged-macOS registerService stamps a committed null-runtime record after readiness", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("enabled");
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("stamp-runtime")) return { outcome: "stamped" };
      return {};
    });

    const outcome = await controller.registerService({ kind: "background" });

    expect(outcome.kind).toBe("ok");
    expect(waitForHostReady).toHaveBeenCalledTimes(1);
    expect(runBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.arrayContaining(["host", "stamp-runtime"]),
    );
  });

  it("registerService on packaged macOS fails without registering when the install is absent after lock acquisition", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    // Deliberately no `writeInstallRecord` - simulates a concurrent
    // terminal uninstall winning the lock first.

    const outcome = await controller.registerService({ kind: "background" });

    expect(outcome).toEqual({ kind: "failed", message: "No host installed." });
    expect(registerHostLoginItem).not.toHaveBeenCalled();
  });

  it("dev environment threads --allow-self-invocation into the CLI-owned service install", async () => {
    const controller = newController("dev");
    writeInstallRecord("dev", { version: "1.7.0", runtimeVersion: "1.7.0" });
    await controller.registerService({ kind: "background" });
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["host", "service", "install", "--allow-self-invocation"],
      }),
    );
  });

  it("removeTraycer ordering: sentinel is persisted before the login-item unregister and the CLI uninstall run", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });

    const sentinelWasSetWhenUnregisterRan: boolean[] = [];
    const sentinelWasSetWhenUninstallRan: boolean[] = [];
    vi.mocked(unregisterHostLoginItemGuarded).mockImplementation(
      async (revalidateBeforeBootout) => {
        sentinelWasSetWhenUnregisterRan.push(await isHostRemovedByUser());
        await revalidateBeforeBootout();
        return true;
      },
    );
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("uninstall")) {
        sentinelWasSetWhenUninstallRan.push(await isHostRemovedByUser());
      }
      return { data: { removedInstallDir: true, serviceUninstalled: true } };
    });

    expect(await isHostRemovedByUser()).toBe(false);
    const outcome = await controller.removeTraycer();

    expect(outcome.kind).toBe("ok");
    expect(sentinelWasSetWhenUnregisterRan).toEqual([true]);
    expect(sentinelWasSetWhenUninstallRan).toEqual([true]);
    expect(await isHostRemovedByUser()).toBe(true);
    // Route pin: the removal streams `host uninstall --all` (the Windows
    // kill loop can outlive the run path's flat timeout) and never runs it.
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["host", "uninstall", "--all"] }),
    );
    expect(runBundledTraycerCliJson).not.toHaveBeenCalledWith(
      expect.arrayContaining(["uninstall"]),
    );
  });

  // P3: the signal must reach the real download child, and removal must wait for that child to close before it begins the uninstall.
  it("P3: removeTraycer aborts an in-flight download and waits for its child to settle before uninstalling", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    const downloadGate = deferred<unknown>();
    let observedAbort = false;
    let uninstallCalls = 0;
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        return availableSnapshotFixture("1.8.0", ["1.8.0"]);
      }
      return {};
    });
    // Without this handshake the test has no in-flight child to abort: `flushMicrotasks()` is three promise turns, while `stageLatest` first crosses real fs reads (isHostRemovedByUser.
    // Raising that deadline would only wait longer on a precondition that never became true.
    const downloadStarted = deferred<void>();
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) {
        const aborted = new Promise<void>((resolve) => {
          if (opts.signal === null) {
            downloadStarted.resolve(undefined);
            return;
          }
          if (opts.signal.aborted) {
            observedAbort = true;
            downloadStarted.resolve(undefined);
            resolve();
            return;
          }
          opts.signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true },
          );
          // Resolved only after the listener is attached, so an abort that
          // arrives next tick is guaranteed to be observed.
          downloadStarted.resolve(undefined);
        });
        await aborted;
        await downloadGate.promise;
        return { data: {} };
      }
      if (opts.args.includes("uninstall")) {
        // `host uninstall --all` is streamed too (the Windows kill loop can
        // outlive the run path's flat timeout), so the removal's uninstall
        // is counted here, on the same mock the download lane uses.
        uninstallCalls += 1;
        return { data: { removedInstallDir: true, serviceUninstalled: true } };
      }
      return { data: {} };
    });

    const stagePromise = controller.stageLatest();
    await downloadStarted.promise;

    const removal = controller.removeTraycer();
    await vi.waitFor(() => {
      expect(observedAbort).toBe(true);
    });
    // Abort was observed, but the mocked child has not closed. The real
    // uninstall must remain blocked until that close-equivalent settles.
    expect(uninstallCalls).toBe(0);

    downloadGate.resolve(undefined);
    await removal;
    await stagePromise;
    expect(uninstallCalls).toBe(1);
    expect(await isHostRemovedByUser()).toBe(true);

    const runCallsBefore = vi.mocked(runBundledTraycerCliJson).mock.calls
      .length;
    await controller.stageLatest();
    expect(vi.mocked(runBundledTraycerCliJson).mock.calls.length).toBe(
      runCallsBefore,
    );
  });

  it("uninstallHost never touches the removed-by-user sentinel", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { removedInstallDir: true, serviceUninstalled: true },
    });

    await controller.uninstallHost(true);
    expect(await isHostRemovedByUser()).toBe(false);
    // Route pin: `uninstallHost` streams `host uninstall --all` for the same
    // reason `deregisterService` and `removeTraycer` do.
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["host", "uninstall", "--all"] }),
    );
    expect(runBundledTraycerCliJson).not.toHaveBeenCalledWith(
      expect.arrayContaining(["uninstall"]),
    );
  });
});

describe("applyStagedCliOwned stamping decision (fixup B9)", () => {
  it("F8a: reports a durable failure when apply reports a post-swap service-start error", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", null);
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        outcome: "applied",
        record: { version: "1.8.0", runtimeVersion: null },
        runningActivated: false,
        installGeneration: "apply-command-generation",
        postSwapError: "service manager rejected the launch",
      },
    });

    const outcome = await controller.applyStaged("manual", false);

    expect(outcome).toMatchObject({
      kind: "installed-not-converged",
      message: expect.stringContaining("Doctor"),
    });
    expect(waitForHostReady).not.toHaveBeenCalled();
  });

  it("P8: reports a failed apply when a null-runtime activation never becomes ready", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", null);
    writePidMetadata("production", { version: "1.8.0", pid: process.pid });
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("stamp-runtime")) return { outcome: "stamped" };
      return availableSnapshotFixture("1.8.0", ["1.8.0"]);
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) return { data: {} };
      if (opts.args.includes("apply")) {
        return {
          data: {
            outcome: "applied",
            record: { version: "1.8.0", runtimeVersion: null },
            runningActivated: true,
            installGeneration: "gen-1.8.0",
          },
        };
      }
      return { data: {} };
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: false,
      version: null,
      pid: null,
      startedAt: null,
      reason: "timeout",
    });

    const outcome = await controller.applyStaged("manual", false);

    expect(outcome).toMatchObject({
      kind: "installed-not-converged",
      message: expect.stringContaining("doctor"),
    });
  });

  it("F8: reports a failed apply when an already-stamped pending activation never becomes ready", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) return { data: {} };
      return {
        data: {
          outcome: "applied",
          record: { version: "1.8.0", runtimeVersion: "1.8.0" },
          runningActivated: true,
          installGeneration: "already-stamped-generation",
        },
      };
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: false,
      version: null,
      pid: null,
      startedAt: null,
      reason: "endpoint never bound",
    });

    const outcome = await controller.applyStaged("manual", false);

    expect(outcome).toMatchObject({
      kind: "installed-not-converged",
      message: expect.stringContaining("doctor"),
    });
    expect(runBundledTraycerCliJson).not.toHaveBeenCalledWith(
      expect.arrayContaining(["host", "stamp-runtime"]),
    );
  });

  it("P9: reports superseded stamping as non-converged after re-deriving the newer generation", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", null);
    writePidMetadata("production", { version: "1.8.0", pid: process.pid });
    let stampCalls = 0;
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) return { data: {} };
      if (opts.args.includes("apply")) {
        return {
          data: {
            outcome: "applied",
            record: { version: "1.8.0", runtimeVersion: null },
            runningActivated: true,
            installGeneration: "gen-1.8.0",
          },
        };
      }
      return { data: {} };
    });
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("stamp-runtime")) {
        stampCalls += 1;
        writeInstallRecord("production", {
          version: "1.9.0",
          runtimeVersion: null,
        });
        return { outcome: "superseded", reason: "generation-mismatch" };
      }
      return availableSnapshotFixture("1.8.0", ["1.8.0"]);
    });

    const outcome = await controller.applyStaged("manual", false);

    expect(outcome).toMatchObject({
      kind: "installed-not-converged",
      message: expect.stringContaining("activationUnknown"),
    });
    if (outcome.kind === "installed-not-converged") {
      expect(outcome.message).not.toContain(
        "activation could not be confirmed:",
      );
    }
    expect(stampCalls).toBe(1);
  });

  it("F2: explicit install of an already-stamped record waits for readiness but skips the CAS", async () => {
    const controller = newController("production");
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        version: "1.8.0",
        runtimeVersion: "1.8.0",
        installGeneration: "already-stamped-generation",
        serviceLifecycle: {
          postSwapAction: "restart",
          postSwapError: null,
        },
      },
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.8.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    const outcome = await controller.installVersion("1.8.0", false);

    expect(outcome.kind).toBe("ok");
    expect(waitForHostReady).toHaveBeenCalledTimes(1);
    expect(runBundledTraycerCliJson).not.toHaveBeenCalledWith(
      expect.arrayContaining(["host", "stamp-runtime"]),
    );
  });

  it("V4: stamps an applied null-runtime generation using the apply command's attested generation", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", null);
    writePidMetadata("production", { version: "1.8.0", pid: process.pid });
    const stampCalls: (readonly string[])[] = [];
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("stamp-runtime")) {
        stampCalls.push(args);
        return { outcome: "stamped" };
      }
      return availableSnapshotFixture("1.8.0", ["1.8.0"]);
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) return { data: {} };
      return {
        data: {
          outcome: "applied",
          record: { version: "1.8.0", runtimeVersion: null },
          runningActivated: true,
          installGeneration: "apply-command-generation",
        },
      };
    });

    const outcome = await controller.applyStaged("manual", false);

    expect(outcome.kind).toBe("ok");
    expect(stampCalls).toHaveLength(1);
    const generationIndex = stampCalls[0]?.indexOf(
      "--expected-install-generation",
    );
    if (generationIndex === undefined || generationIndex < 0) {
      throw new Error("stamp-runtime did not receive an expected generation");
    }
    expect(stampCalls[0]?.[generationIndex + 1]).toBe(
      "apply-command-generation",
    );
  });

  it("does not stamp when the newly-applied record already carries its own runtime stamp", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    // The suite default publishes 1.0.0, which makes `confirmActivationReadiness` throw and lands this on installed-not-converged before the stamp decision is even observable.
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.8.0",
      pid: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        outcome: "applied",
        record: { version: "1.8.0", runtimeVersion: "1.8.0" },
        runningActivated: true,
        installGeneration: "gen-1.8.0",
      },
    });

    const outcome = await controller.applyStaged("manual", false);

    expect(outcome.kind).toBe("ok");
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({ args: expect.arrayContaining(["apply"]) }),
    );
    expect(runBundledTraycerCliJson).not.toHaveBeenCalledWith(
      expect.arrayContaining(["host", "stamp-runtime"]),
    );
  });

  it("reports installed-not-converged when apply commits bytes without starting the service", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) return { data: {} };
      return {
        data: {
          outcome: "applied",
          record: { version: "1.8.0", runtimeVersion: "1.8.0" },
          runningActivated: false,
          installGeneration: "apply-command-generation",
        },
      };
    });

    const outcome = await controller.applyStaged("manual", false);

    expect(outcome).toMatchObject({ kind: "installed-not-converged" });
    expect(waitForHostReady).not.toHaveBeenCalled();
  });

  it("does not skip a still-current pid unless apply actually stopped that old service", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) return { data: {} };
      return {
        data: {
          outcome: "applied",
          record: { version: "1.8.0", runtimeVersion: "1.8.0" },
          runningActivated: true,
          installGeneration: "apply-command-generation",
          serviceLifecycle: { stoppedBeforeSwap: false },
        },
      };
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.8.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    expect((await controller.applyStaged("manual", false)).kind).toBe("ok");
    expect(waitForHostReady).toHaveBeenLastCalledWith(
      expect.any(Number),
      expect.any(String),
      expect.any(Number),
      null,
    );
  });

  it("requires a replacement pid when apply stopped the prior service", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) return { data: {} };
      return {
        data: {
          outcome: "applied",
          record: { version: "1.8.0", runtimeVersion: "1.8.0" },
          runningActivated: true,
          installGeneration: "apply-command-generation",
          serviceLifecycle: { stoppedBeforeSwap: true },
        },
      };
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.8.0",
      pid: process.pid + 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    expect((await controller.applyStaged("manual", false)).kind).toBe("ok");
    expect(waitForHostReady).toHaveBeenLastCalledWith(
      expect.any(Number),
      expect.any(String),
      expect.any(Number),
      process.pid,
    );
  });
});

describe("packaged-macOS null-runtime readiness budget", () => {
  it("P12: performs one readiness wait before stamping and reporting activation", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("stamp-runtime")) return { outcome: "stamped" };
      return availableSnapshotFixture("1.7.0", ["1.7.0"]);
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    const outcome = await controller.activateInstalled(false);

    expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
    expect(waitForHostReady).toHaveBeenCalledTimes(1);
  });
});

describe("convergeReadyCliOwned postSwapError + readiness (fixup B7)", () => {
  it("does not converge when ensure reports a post-swap start failure", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        action: "installed",
        installed: true,
        registered: true,
        running: false,
        version: "1.8.0",
        runtimeVersion: "1.8.0",
        installGeneration: "gen-1.8.0",
        postSwapError: "launchctl bootstrap failed: 5: Input/output error",
      },
    });

    const outcome = await controller.convergeReady(false, {
      kind: "background",
    });

    expect(outcome.kind).toBe("failed");
  });

  it("does not converge when an already-stamped service-starting branch never becomes reachable", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        action: "started",
        installed: true,
        registered: true,
        running: true,
        version: "1.7.0",
        runtimeVersion: "1.7.0",
        installGeneration: null,
        postSwapError: null,
      },
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: false,
      version: null,
      pid: null,
      startedAt: null,
      reason: "timeout",
    });

    const outcome = await controller.convergeReady(false, {
      kind: "background",
    });

    expect(outcome.kind).toBe("failed");
  });
});

describe("convergeReady E_HOST_BUSY classification (fixup B8)", () => {
  it("classifies a CLI-owned ensure's E_HOST_BUSY as busy/retry-with-force, not a fatal failure", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(streamBundledTraycerCliJson).mockRejectedValueOnce(
      new TraycerCliError("E_HOST_BUSY", "host busy"),
    );

    const outcome = await controller.convergeReady(false, {
      kind: "background",
    });

    expect(outcome).toEqual({
      kind: "busy",
      continuation: "retry-with-force",
      message: expect.stringContaining("work in progress"),
    });
  });
});

// `convergeReadyCliOwned` must pass `--from <archive>` explicitly when running on win32 with a bundled archive present beside the CLI binary.
describe("Windows bundled-host --from fallback", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
  const originalArchDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "arch",
  );

  afterEach(() => {
    if (originalPlatformDescriptor !== undefined) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    if (originalArchDescriptor !== undefined) {
      Object.defineProperty(process, "arch", originalArchDescriptor);
    }
  });

  function setPlatform(value: string): void {
    Object.defineProperty(process, "platform", { configurable: true, value });
  }

  function setArch(value: string): void {
    Object.defineProperty(process, "arch", { configurable: true, value });
  }

  it("passes --from the bundled host archive on win32 when it exists beside the CLI binary", async () => {
    setPlatform("win32");
    setArch("x64");
    const cliDir = join(workHome, "cli");
    mkdirSync(cliDir, { recursive: true });
    const bundledCli = join(cliDir, "traycer.exe");
    writeFileSync(bundledCli, "");
    const archive = join(cliDir, "host-runtime-win32-x64.tar.gz");
    writeFileSync(archive, "");
    vi.mocked(resolveBundledCliPath).mockResolvedValue(bundledCli);

    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { running: true, version: "1.7.0", action: "noop" },
    });

    await controller.convergeReady(false, { kind: "background" });

    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["host", "ensure", "--from", archive],
      }),
    );
  });

  it("resolves win32-arm64 to the x64 host archive (no native win-arm64 host)", async () => {
    setPlatform("win32");
    setArch("arm64");
    const cliDir = join(workHome, "cli");
    mkdirSync(cliDir, { recursive: true });
    const bundledCli = join(cliDir, "traycer.exe");
    writeFileSync(bundledCli, "");
    const archive = join(cliDir, "host-runtime-win32-x64.tar.gz");
    writeFileSync(archive, "");
    vi.mocked(resolveBundledCliPath).mockResolvedValue(bundledCli);

    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { running: true, version: "1.7.0", action: "noop" },
    });

    await controller.convergeReady(false, { kind: "background" });

    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["host", "ensure", "--from", archive],
      }),
    );
  });

  it("omits --from on win32 when no bundled archive is present (dev/CLI-only install)", async () => {
    setPlatform("win32");
    setArch("x64");
    vi.mocked(resolveBundledCliPath).mockResolvedValue(null);

    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { running: true, version: "1.7.0", action: "noop" },
    });

    await controller.convergeReady(false, { kind: "background" });

    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["host", "ensure"] }),
    );
  });
  it("omits --from on macOS/Linux even when a bundled CLI path resolves (POSIX symlink self-resolution)", async () => {
    setPlatform("darwin");
    const cliDir = join(workHome, "cli");
    mkdirSync(cliDir, { recursive: true });
    const bundledCli = join(cliDir, "traycer");
    writeFileSync(bundledCli, "");
    vi.mocked(resolveBundledCliPath).mockResolvedValue(bundledCli);

    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { running: true, version: "1.7.0", action: "noop" },
    });

    await controller.convergeReady(false, { kind: "background" });

    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["host", "ensure"] }),
    );
  });
});

describe("applyPendingLoginItemRevisionIfIdle", () => {
  it("returns null when there is no pending revision marker", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(false);
    expect(
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane"),
    ).toBeNull();
    expect(registerHostLoginItem).not.toHaveBeenCalled();
  });

  it("returns null (silent skip) when the host is busy", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writePidMetadata("production", {
      version: "1.7.0",
      pid: process.pid,
      websocketUrl: "ws://127.0.0.1:55555/rpc",
    });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(probeHostActivityBusy).mockResolvedValue(true);
    expect(
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane"),
    ).toBeNull();
    expect(registerHostLoginItem).not.toHaveBeenCalled();
  });

  it("pre-flights requires-approval, quarantines, and fails without ever bootout-ing the running host", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(readHostLoginItemStatus).mockReturnValue("requires-approval");

    const outcome =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    expect(outcome).toBeNull();
    expect(registerHostLoginItem).not.toHaveBeenCalled();
    expect(controller.isPendingRevisionRefreshQuarantined()).toBe(true);

    // Quarantined for the rest of the session - a second tick skips even
    // the pre-flight re-read.
    vi.mocked(readHostLoginItemStatus).mockClear();
    expect(
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane"),
    ).toBeNull();
    expect(readHostLoginItemStatus).not.toHaveBeenCalled();
  });

  it("registerHostLoginItem returning requires-approval post-cycle fails and quarantines the refresh", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("requires-approval");

    const outcome =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");

    expect(outcome).toEqual({
      kind: "failed",
      message: expect.stringContaining("disabled by macOS"),
    });
    expect(controller.isPendingRevisionRefreshQuarantined()).toBe(true);
    expect(waitForHostReady).not.toHaveBeenCalled();
  });

  // Contrasts with the requires-approval post-cycle case above: "parked" is a healthy converge (the host this call already confirmed reachable is untouched, nothing needs restarting).
  it("registerHostLoginItem returning parked post-cycle returns null (healthy converge), quarantines the refresh for the session, and a second attempt never re-runs the cycle", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const reachabilityProbe = vi.fn(async () => true);
    const controller = newControllerWithReachability(
      "production",
      reachabilityProbe,
    );
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("parked");

    const outcome =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");

    expect(outcome).toBeNull();
    expect(controller.isPendingRevisionRefreshQuarantined()).toBe(true);
    expect(waitForHostReady).not.toHaveBeenCalled();
    expect(streamBundledTraycerCliJson).not.toHaveBeenCalled();
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);

    // Quarantined for the rest of the session - a second attempt (e.g. the monitor's next tick) never re-runs the disruptive cycle, including the reachability probe: the quarantine.
    const reachabilityCallsBeforeSecondAttempt =
      reachabilityProbe.mock.calls.length;
    const second =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    expect(second).toBeNull();
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
    expect(reachabilityProbe.mock.calls.length).toBe(
      reachabilityCallsBeforeSecondAttempt,
    );
  });

  it("registerHostLoginItem returning a non-enabled, non-approval status recovers via the CLI takeover fallback, quarantines, and a second attempt never re-runs the cycle", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("not-registered");
    // The recovered host must publish the runtime the committed install
    // expects - the beforeEach default (1.0.0) would rightly be rejected.
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    const outcome =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");

    expect(outcome).toEqual({
      kind: "ok",
      value: { running: true, version: "1.7.0" },
    });
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["host", "service", "install", "--takeover"],
      }),
    );
    expect(controller.isPendingRevisionRefreshQuarantined()).toBe(true);
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);

    // A later attempt (e.g. the monitor's next 30s tick) must not run the disruptive cycle again for the same terminal outcome.
    const second =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    expect(second).toBeNull();
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
  });

  it("a failing CLI fallback after a failed refresh cycle surfaces BOTH failures with the manual escape hatch", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("not-found");
    vi.mocked(streamBundledTraycerCliJson).mockRejectedValue(
      new Error("takeover exploded"),
    );

    const outcome =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");

    // The raw `Error` path classifies to `failed` before enrichment; the
    // helper must preserve that kind, not just append text to it.
    expect(outcome?.kind).toBe("failed");
    if (outcome !== null && outcome.kind === "failed") {
      expect(outcome.message).toContain("status=not-found");
      expect(outcome.message).toContain("takeover exploded");
      expect(outcome.message).toContain("traycer host service uninstall");
      expect(outcome.message).toContain("traycer host doctor");
    }
    expect(controller.isPendingRevisionRefreshQuarantined()).toBe(true);
  });

  it("a readiness timeout after a successful register fails WITHOUT quarantining - a later attempt can still retry", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("enabled");
    vi.mocked(waitForHostReady).mockResolvedValueOnce({
      ready: false,
      version: null,
      pid: null,
      startedAt: null,
      reason: "pid metadata never appeared",
    });

    const outcome =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");

    expect(outcome).toEqual({
      kind: "failed",
      message: expect.stringContaining("did not become reachable in time"),
    });
    expect(controller.isPendingRevisionRefreshQuarantined()).toBe(false);

    vi.mocked(waitForHostReady).mockResolvedValueOnce({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });
    const second =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    expect(second?.kind).toBe("ok");
    expect(registerHostLoginItem).toHaveBeenCalledTimes(2);
  });

  // Fixup C3: "deferred-busy + desktop-lock retryability".
  // Both must be silent (no quarantine) and retryable once the transient condition clears.
  it("desktop-lock contention returns null (silent, no quarantine); a later attempt succeeds once the lock frees", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newControllerWithLockTiming(
      "production",
      async () => true,
      50,
      10,
    );
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("enabled");
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    const lockPath = cliLockPath("production");
    const held = await acquireDesktopCliLock({
      lockPath,
      reason: "test-held-elsewhere",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    if (held.kind !== "acquired") {
      throw new Error("failed to seed a held lock for this test");
    }

    const outcome =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    expect(outcome).toBeNull();
    expect(controller.isPendingRevisionRefreshQuarantined()).toBe(false);
    expect(registerHostLoginItem).not.toHaveBeenCalled();

    await held.handle.release();
    const second =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    expect(second?.kind).toBe("ok");
  });
  it("idle + pending revision: runs the locked register cycle and returns ok with the refreshed identity", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("enabled");
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    const outcome =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    expect(outcome).toEqual({
      kind: "ok",
      value: { running: true, version: "1.7.0" },
    });
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
  });

  it("removed-by-user mid-refresh short-circuits to an ok/not-running result without quarantining", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("removed-by-user");

    const outcome =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    expect(outcome).toEqual({
      kind: "ok",
      value: { running: false, version: null },
    });
    expect(controller.isPendingRevisionRefreshQuarantined()).toBe(false);
  });

  it("stamps the generation captured before the cycle started, not a superseding record that lands mid-cycle", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    writeInstallRecord("production", {
      installId: "install-A",
      version: "1.7.0",
      runtimeVersion: null,
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: "a".repeat(64),
    });
    const expectedGenerationA = encodeInstallGeneration({
      installId: "install-A",
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: "a".repeat(64),
      version: "1.7.0",
    });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockImplementation(async () => {
      writeInstallRecord("production", {
        installId: "install-B",
        version: "1.8.0",
        runtimeVersion: null,
        installedAt: "2026-02-01T00:00:00.000Z",
        archiveSha256: "b".repeat(64),
      });
      return "enabled";
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });
    const stampCalls: (readonly string[])[] = [];
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("stamp-runtime")) {
        stampCalls.push(args);
        return { outcome: "stamped" };
      }
      return {};
    });

    const outcome =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    expect(outcome?.kind).toBe("ok");

    expect(stampCalls).toHaveLength(1);
    const generationIndex = stampCalls[0]?.indexOf(
      "--expected-install-generation",
    );
    expect(generationIndex).toBeGreaterThanOrEqual(0);
    expect(stampCalls[0]?.[(generationIndex as number) + 1]).toBe(
      expectedGenerationA,
    );
  });

  it("awaitMutationLaneIdle waits for a standalone (non-FIFO) revision-refresh cycle", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    const registerGate = deferred<"enabled">();
    let registerCalled = false;
    vi.mocked(registerHostLoginItem).mockImplementation(async () => {
      registerCalled = true;
      return registerGate.promise;
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        action: "noop",
        running: true,
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      },
    });

    const refreshPromise =
      controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    await vi.waitFor(() => {
      if (!registerCalled) throw new Error("register not reached yet");
    });

    // Mid-cycle, never having gone through `enqueueMutation` - the drain
    // must still see it as busy rather than idle.
    expect(await controller.awaitMutationLaneIdle(20)).toBe(false);

    registerGate.resolve("enabled");
    await refreshPromise;

    expect(await controller.awaitMutationLaneIdle(20)).toBe(true);
  });

  it("P4: quit drain sees the pending-revision intent during its reachability precheck", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const reachabilityGate = deferred<boolean>();
    const controller = newControllerWithReachability(
      "production",
      async () => reachabilityGate.promise,
    );
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });

    const refresh =
      controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    await flushMicrotasks();

    expect(await controller.awaitMutationLaneIdle(20)).toBe(false);

    reachabilityGate.resolve(false);
    await refresh;
    expect(await controller.awaitMutationLaneIdle(20)).toBe(true);
  });

  // The in-flight coalescing gate now makes the second caller join the first's result instead of starting its own cycle.
  it("two concurrent callers coalesce onto a single disruptive cycle - registerHostLoginItem runs once, both resolve", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("enabled");
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    const [first, second] = await Promise.all([
      controller.applyPendingLoginItemRevisionIfIdle("outside-lane"),
      controller.applyPendingLoginItemRevisionIfIdle("outside-lane"),
    ]);

    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
    const expected = {
      kind: "ok",
      value: { running: true, version: "1.7.0" },
    };
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);

    // The slot clears once settled - a later, independent call can still
    // run its own cycle rather than being stuck joined forever.
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    const third =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    expect(third).toEqual(expected);
    expect(registerHostLoginItem).toHaveBeenCalledTimes(2);
  });

  it("V3: the monitor caller and convergeReady's reentrant packaged-mac caller share the same failed revision cycle", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newControllerWithReachability(
      "production",
      async () => true,
    );
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    const registerGate = deferred<"requires-approval">();
    let registerCalled = false;
    vi.mocked(registerHostLoginItem).mockImplementation(async () => {
      registerCalled = true;
      return registerGate.promise;
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        action: "noop",
        running: true,
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      },
    });

    // This is the production pair: the monitor's public standalone caller
    // starts the cycle, then convergeReadyPackagedMac reaches its reentrant
    // public caller while that cycle is still in flight.
    const refresh = vi.spyOn(controller, "applyPendingLoginItemRevisionIfIdle");
    const monitorTick =
      controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    await vi.waitFor(() => {
      if (!registerCalled) throw new Error("revision cycle did not start");
    });
    const convergence = controller.convergeReady(false, { kind: "background" });
    await vi.waitFor(() => {
      // Wait for the real production join edge: the reentrant caller has invoked the public coalescing method, which synchronously observes the in-flight slot before its first await.
      expect(refresh).toHaveBeenCalledTimes(2);
    });

    registerGate.resolve("requires-approval");
    const [monitorOutcome, convergenceOutcome] = await Promise.all([
      monitorTick,
      convergence,
    ]);

    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
    expect(monitorOutcome).toEqual({
      kind: "failed",
      message: expect.stringContaining("disabled by macOS"),
    });
    expect(convergenceOutcome).toEqual({
      kind: "failed",
      message: expect.stringContaining("disabled by macOS"),
    });
  });

  it("skips the bootout and returns null when the pending-revision marker resolves before lock acquisition", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    let hasPendingCallCount = 0;
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockImplementation(
      async () => {
        hasPendingCallCount += 1;
        // First call: the pre-lock check (still pending). Second call: the
        // defense-in-depth reread inside the locked closure (resolved).
        return hasPendingCallCount === 1;
      },
    );

    const outcome =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");

    expect(outcome).toBeNull();
    expect(registerHostLoginItem).not.toHaveBeenCalled();
    expect(hasPendingCallCount).toBe(2);
  });
});

describe("respawn (fixup B14)", () => {
  it("defers rather than restarting when the host was removed by the user", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    await markHostRemovedByUser();

    const outcome = await controller.respawn({ kind: "background" });

    expect(outcome).toEqual({
      kind: "deferred",
      message: "Host was removed by the user.",
    });
    expect(streamBundledTraycerCliJson).not.toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(["restart"]),
      }),
    );
  });

  it("heals the renderer snapshot when a CLI-owned restart never actually ran (lock busy)", async () => {
    const lifecycle = fakeHostLifecycle();
    const controller = new HostController({
      environment: "production",
      hostLifecycle: lifecycle,
      reachabilityProbe: async () => true,
      desktopLockWaitMs: DESKTOP_LOCK_WAIT_MS,
      desktopLockPollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
    });
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(streamBundledTraycerCliJson).mockRejectedValueOnce(
      new TraycerCliError("E_CLI_LOCK_BUSY", "cli lock busy"),
    );

    const outcome = await controller.respawn({ kind: "background" });

    expect(outcome.kind).toBe("deferred");
    expect(lifecycle.reloadSnapshotFromDisk).toHaveBeenCalled();
    expect(lifecycle.notifyRespawningCalls).toHaveLength(1);
  });
});

describe("hostLifecycle wiring on success (fixup C2)", () => {
  it("convergeReady (CLI-owned) reinstalls the watcher and reloads the snapshot", async () => {
    const lifecycle = fakeHostLifecycle();
    const controller = new HostController({
      environment: "production",
      hostLifecycle: lifecycle,
      reachabilityProbe: async () => true,
      desktopLockWaitMs: DESKTOP_LOCK_WAIT_MS,
      desktopLockPollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
    });
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { action: "noop", version: "1.7.0", runtimeVersion: "1.7.0" },
    });

    const outcome = await controller.convergeReady(false, {
      kind: "background",
    });

    expect(outcome.kind).toBe("ok");
    expect(lifecycle.ensureWatcherInstalled).toHaveBeenCalled();
    expect(lifecycle.reloadSnapshotFromDisk).toHaveBeenCalled();
  });

  it("the packaged-macOS locked activation cycle reinstalls the watcher and reloads the snapshot", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const lifecycle = fakeHostLifecycle();
    const controller = new HostController({
      environment: "production",
      hostLifecycle: lifecycle,
      reachabilityProbe: async () => true,
      desktopLockWaitMs: DESKTOP_LOCK_WAIT_MS,
      desktopLockPollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
    });
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { version: "1.8.0", installGeneration: null },
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    const outcome = await controller.installVersion("1.8.0", false);

    expect(outcome.kind).toBe("ok");
    expect(lifecycle.ensureWatcherInstalled).toHaveBeenCalled();
    expect(lifecycle.reloadSnapshotFromDisk).toHaveBeenCalled();
  });

  it("Class B: a null post-cycle reload prevents the packaged-mac activation cycle from reporting activated", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const lifecycle = fakeHostLifecycle();
    vi.mocked(lifecycle.reloadSnapshotFromDisk).mockResolvedValue(null);
    const controller = new HostController({
      environment: "production",
      hostLifecycle: lifecycle,
      reachabilityProbe: async () => true,
      desktopLockWaitMs: DESKTOP_LOCK_WAIT_MS,
      desktopLockPollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
    });
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { version: "1.8.0", installGeneration: null },
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    await expect(
      controller.installVersion("1.8.0", false),
    ).resolves.toMatchObject({
      kind: "failed",
      message: expect.stringContaining("became unavailable"),
    });
  });

  it("lifecycleAdmissionBlock is login-item-refresh only after prechecks pass, then null once the cycle settles", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    const registerGate = deferred<"enabled">();
    let registerCalled = false;
    vi.mocked(registerHostLoginItem).mockImplementation(async () => {
      registerCalled = true;
      return registerGate.promise;
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        action: "noop",
        running: true,
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      },
    });

    const refreshPromise =
      controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    await vi.waitFor(() => {
      if (!registerCalled) throw new Error("register not reached yet");
    });
    expect(controller.lifecycleAdmissionBlock).toEqual({
      kind: "login-item-refresh",
    } satisfies LifecycleAdmissionBlock);

    registerGate.resolve("enabled");
    await refreshPromise;
    expect(controller.lifecycleAdmissionBlock).toBeNull();
  });

  it("lifecycleAdmissionBlock stays null while uncoalesced prechecks are pending", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const reachabilityGate = deferred<boolean>();
    const controller = newControllerWithReachability(
      "production",
      async () => reachabilityGate.promise,
    );
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);

    const refresh =
      controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    await flushMicrotasks();
    expect(controller.lifecycleAdmissionBlock).toBeNull();

    reachabilityGate.resolve(false);
    await refresh;
    expect(controller.lifecycleAdmissionBlock).toBeNull();
  });

  it("a tick that bails on no marker never raises lifecycleAdmissionBlock", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(false);
    expect(controller.lifecycleAdmissionBlock).toBeNull();
    expect(
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane"),
    ).toBeNull();
    expect(controller.lifecycleAdmissionBlock).toBeNull();
    expect(registerHostLoginItem).not.toHaveBeenCalled();
  });

  it("an outside-lane tick defers when the mutation lane owns an intent, without raising login-item-refresh", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    const installGate = deferred<{ data: unknown }>();
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("install")) return installGate.promise;
      return { data: {} };
    });

    const installPromise = controller.installVersion("1.8.0", false);
    await vi.waitFor(() => {
      const block = controller.lifecycleAdmissionBlock;
      if (block === null || block.kind !== "mutation") {
        throw new Error("expected the mutation lane to be occupied");
      }
    });

    const outcome =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    expect(outcome).toBeNull();
    expect(registerHostLoginItem).not.toHaveBeenCalled();
    expect(controller.lifecycleAdmissionBlock).toMatchObject({
      kind: "mutation",
    });

    installGate.resolve({
      data: { version: "1.8.0", installGeneration: null },
    });
    await installPromise;
  });

  it("a within-lane-job caller still runs the cycle while the mutation lane is occupied", async () => {
    // convergeReady reaches the cycle from inside its own lane job; a
    // blanket lane check would refuse the caller of the job itself.
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("enabled");
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });
    const installGate = deferred<{ data: unknown }>();
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("install")) return installGate.promise;
      return { data: {} };
    });

    const installPromise = controller.installVersion("1.8.0", false);
    await vi.waitFor(() => {
      const block = controller.lifecycleAdmissionBlock;
      if (block === null || block.kind !== "mutation") {
        throw new Error("expected the mutation lane to be occupied");
      }
    });

    const outcome =
      await controller.applyPendingLoginItemRevisionIfIdle("within-lane-job");
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      kind: "ok",
      value: { running: true, version: "1.7.0" },
    });

    installGate.resolve({
      data: { version: "1.8.0", installGeneration: null },
    });
    await installPromise;
  });

  it("convergeReady's noop path still applies a pending revision via within-lane-job", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("enabled");
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        action: "noop",
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      },
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    const outcome = await controller.convergeReady(false, {
      kind: "background",
    });
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      kind: "ok",
      value: { running: true, version: "1.7.0" },
    });
  });

  async function occupyInstallAndParkOutsideRevision(input: {
    readonly joiner: "outside-lane" | "within-lane-job";
  }) {
    const probeResult: { current: Promise<boolean> } = {
      current: Promise.resolve(true),
    };
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newControllerWithReachability(
      "production",
      async () => probeResult.current,
    );
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("enabled");
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });
    const installGate = deferred<{ data: unknown }>();
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("install")) return installGate.promise;
      return { data: {} };
    });

    const installPromise = controller.installVersion("1.8.0", false);
    await vi.waitFor(() => {
      const block = controller.lifecycleAdmissionBlock;
      if (block === null || block.kind !== "mutation") {
        throw new Error("expected the mutation lane to be occupied");
      }
    });

    const reachabilityGate = deferred<boolean>();
    probeResult.current = reachabilityGate.promise;
    const outside =
      controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    await flushMicrotasks();
    expect(registerHostLoginItem).not.toHaveBeenCalled();

    const joined = controller.applyPendingLoginItemRevisionIfIdle(input.joiner);
    reachabilityGate.resolve(true);
    return {
      outside,
      joined,
      installPromise,
      installGate,
      registerCalls: () => vi.mocked(registerHostLoginItem).mock.calls.length,
    };
  }

  it("a within-lane joiner upgrades an in-flight outside tick still in prechecks so the cycle runs", async () => {
    // Discriminator: before the coalescing upgrade, the parked outside tick kept its own `outside-lane` policy, saw the mutation lane the JOINER occupies, and returned null.
    const parked = await occupyInstallAndParkOutsideRevision({
      joiner: "within-lane-job",
    });
    const expected = {
      kind: "ok" as const,
      value: { running: true, version: "1.7.0" },
    };
    expect(await parked.joined).toEqual(expected);
    expect(await parked.outside).toEqual(expected);
    expect(parked.registerCalls()).toBe(1);

    parked.installGate.resolve({
      data: { version: "1.8.0", installGeneration: null },
    });
    await parked.installPromise;
  });

  it("an outside-lane joiner of a parked outside tick still defers while the mutation lane is occupied", async () => {
    // Pin against applying the upgrade unconditionally: an outside joiner
    // must not widen what the cycle may do. Same interleaving as the
    // within-lane upgrade pin; only the joiner's owner policy changes.
    const parked = await occupyInstallAndParkOutsideRevision({
      joiner: "outside-lane",
    });
    expect(await parked.joined).toBeNull();
    expect(await parked.outside).toBeNull();
    expect(parked.registerCalls()).toBe(0);

    parked.installGate.resolve({
      data: { version: "1.8.0", installGeneration: null },
    });
    await parked.installPromise;
  });
});

describe("Class B no-op liveness", () => {
  it("does not report an empty apply queue as running when no host endpoint is reachable", async () => {
    const controller = newControllerWithReachability(
      "production",
      async () => false,
    );
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.7.0", ["1.7.0"]),
    );

    await expect(
      controller.applyStaged("manual", false),
    ).resolves.toMatchObject({
      kind: "installed-not-converged",
    });
  });

  it("does not trust a CLI no-op apply to imply activation without a live endpoint", async () => {
    const controller = newControllerWithReachability(
      "production",
      async () => false,
    );
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { outcome: "no-op", installedVersion: "1.7.0" },
    });

    await expect(
      controller.applyStaged("manual", false),
    ).resolves.toMatchObject({
      kind: "installed-not-converged",
    });
  });

  it("does not trust a packaged-mac no-op apply to imply activation without a live endpoint", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newControllerWithReachability(
      "production",
      async () => false,
    );
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { outcome: "no-op", installedVersion: "1.7.0" },
    });

    await expect(
      controller.applyStaged("manual", false),
    ).resolves.toMatchObject({
      kind: "installed-not-converged",
    });
  });
});

// Keep the assertion at each public entry point: reintroducing the vestigial caller reload makes exactly that caller's test fail instead of relying on the helper in isolation.
describe("Class B CLI-owned caller publication", () => {
  function configureRestartAndStamp(): void {
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        installGeneration: "restart-command-generation",
        runtimeVersion: null,
        runtimeWasNull: true,
      },
    });
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        return availableSnapshotFixture("1.7.0", ["1.7.0"]);
      }
      return { outcome: "stamped" };
    });
  }

  it("activateInstalledCliOwned performs only completeServiceStart's publication reload", async () => {
    const lifecycle = fakeHostLifecycle();
    const controller = newControllerWithLifecycle(lifecycle, async () => true);
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    configureRestartAndStamp();

    await expect(controller.activateInstalled(false)).resolves.toMatchObject({
      kind: "ok",
      value: { activated: true },
    });
    expect(lifecycle.reloadSnapshotFromDisk).toHaveBeenCalledTimes(1);
  });
});

// Returning `null` means "fall through to today's byte-identical `host restart --force`"; only a completed continuation or a live-executor busy refusal diverge from that.
describe("F3: routeForceRestartContinuation via respawn", () => {
  const RESTART_FORCE_ARGV = [
    "host",
    "restart",
    "--force",
    "--defer-if-parked",
  ];

  function attemptRecordFields(overrides: {
    readonly phase: HostUpdateAttemptPhase;
    readonly execution: HostUpdateAttemptExecution;
    readonly continuation: "resume-apply" | "activate" | null;
    readonly attemptId?: string;
    readonly generation?: number;
    readonly sequence?: number;
    readonly targetVersion?: string;
  }): Record<string, unknown> {
    return {
      schemaVersion: 2,
      attemptId: overrides.attemptId ?? "f3-attempt-1",
      generation: overrides.generation ?? 1,
      sequence: overrides.sequence ?? 1,
      trigger: "manual",
      targetVersion: overrides.targetVersion ?? "2.0.0",
      phase: overrides.phase,
      execution: overrides.execution,
      continuation: overrides.continuation,
      progress: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
      error: null,
    };
  }

  function writeAttemptRecord(fields: Record<string, unknown>): void {
    const layout = getHostFsLayout("production");
    mkdirSync(layout.rootDir, { recursive: true });
    writeFileSync(
      updateAttemptRecordPath(layout.rootDir),
      JSON.stringify(fields),
    );
  }

  // `readHostServiceOwner` is REAL (not mocked) - it projects from
  // `substrate.json`/`transition.json` on disk. `{v:1, active:"smappservice"}`
  // is the shape `substrate-backfill-contender.test.ts` already relies on.
  function writeOwnedSmAppServiceSubstrate(): void {
    const layout = getHostFsLayout("production");
    mkdirSync(layout.rootDir, { recursive: true });
    writeFileSync(
      layout.substrateFile,
      JSON.stringify({
        v: 1,
        active: "smappservice",
        since: "2026-01-01T00:00:00.000Z",
        reason: "f3-test",
        attestation: null,
      }),
    );
  }

  async function seedParkedActivationAttempt(
    targetVersion: string,
  ): Promise<void> {
    const layout = getHostFsLayout("production");
    const outer = await withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "f3-test-seed-parked-attempt",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) => {
        const created = await commitAttemptMutationWithCapability(
          capability,
          layout.rootDir,
          {
            kind: "create",
            request: {
              targetVersion,
              trigger: "manual",
              action: "start",
              expected: null,
              newAttemptId: "f3-attempt-1",
              initialPhase: "applying",
              nowIso: "2025-12-31T00:00:00.000Z",
            },
          },
        );
        if (created.kind !== "committed") {
          throw new Error(`seed create failed: ${JSON.stringify(created)}`);
        }
        const parked = await commitAttemptMutationWithCapability(
          capability,
          layout.rootDir,
          {
            kind: "advance",
            held: created.identity,
            advance: {
              phase: "waiting-to-activate",
              continuation: "activate",
              progress: null,
              error: null,
              nowIso: "2025-12-31T00:01:00.000Z",
            },
          },
        );
        if (parked.kind !== "committed") {
          throw new Error(`seed park failed: ${JSON.stringify(parked)}`);
        }
      },
    );
    if (outer.kind !== "ran") {
      throw new Error(`seed segment failed: ${outer.kind}`);
    }
  }

  /** The phase on disk right now, or the read's failure kind. */
  async function currentAttemptPhase(): Promise<string> {
    const read = await readUpdateAttemptRecord(
      getHostFsLayout("production").rootDir,
    );
    return read.kind === "valid" ? read.value.phase : read.kind;
  }

  async function seedPreparingActivateViaResume(
    targetVersion: string,
  ): Promise<void> {
    const layout = getHostFsLayout("production");
    const outer = await withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "f2-seed-preparing-activate",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) => {
        const created = await commitAttemptMutationWithCapability(
          capability,
          layout.rootDir,
          {
            kind: "create",
            request: {
              targetVersion,
              trigger: "manual",
              action: "start",
              expected: null,
              newAttemptId: "f2-attempt-1",
              initialPhase: "applying",
              nowIso: "2025-12-31T00:00:00.000Z",
            },
          },
        );
        if (created.kind !== "committed") {
          throw new Error(`seed create failed: ${JSON.stringify(created)}`);
        }
        const parked = await commitAttemptMutationWithCapability(
          capability,
          layout.rootDir,
          {
            kind: "advance",
            held: created.identity,
            advance: {
              phase: "waiting-to-activate",
              continuation: "activate",
              progress: null,
              error: null,
              nowIso: "2025-12-31T00:01:00.000Z",
            },
          },
        );
        if (parked.kind !== "committed") {
          throw new Error(`seed park failed: ${JSON.stringify(parked)}`);
        }
        // The genuine claim. `expected` binds it to the parked identity, which
        // is what makes `decideAttemptClaim` resolve `resume` rather than
        // `create` - the same resolution the real activation segment gets.
        const resumed = await commitAttemptMutationWithCapability(
          capability,
          layout.rootDir,
          {
            kind: "resume",
            request: {
              targetVersion,
              trigger: "manual",
              action: "activate",
              expected: parked.identity,
              // Only consulted if the decision were `create`; an
              // identity-bound request cannot reach that arm.
              newAttemptId: "f2-attempt-unused",
              initialPhase: "applying",
              nowIso: "2025-12-31T00:02:00.000Z",
            },
          },
        );
        if (resumed.kind !== "committed") {
          throw new Error(`seed resume failed: ${JSON.stringify(resumed)}`);
        }
      },
    );
    if (outer.kind !== "ran") {
      throw new Error(`seed segment failed: ${outer.kind}`);
    }
    const seeded = await readUpdateAttemptRecord(layout.rootDir);
    if (
      seeded.kind !== "valid" ||
      seeded.value.phase !== "preparing" ||
      seeded.value.continuation !== "activate"
    ) {
      throw new Error(
        `seed did not land on preparing/activate: ${JSON.stringify(seeded)}`,
      );
    }
  }

  /** Do what the real CLI recovery claimant does to an orphaned `preparing/activate`: re-park it at `waiting-to-activate` and report the identity it parked. */
  async function reparkPreparingActivateAsRecoveryWould(): Promise<HostUpdateAttemptIdentity> {
    const layout = getHostFsLayout("production");
    let parked: HostUpdateAttemptIdentity | null = null;
    const outer = await withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "f2-test-recovery-claimant",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) => {
        const current = await readUpdateAttemptRecord(layout.rootDir);
        if (current.kind !== "valid") {
          throw new Error(`recovery mock read failed: ${current.kind}`);
        }
        const advanced = await commitAttemptMutationWithCapability(
          capability,
          layout.rootDir,
          {
            kind: "advance",
            held: {
              attemptId: current.value.attemptId,
              generation: current.value.generation,
              sequence: current.value.sequence,
            },
            advance: {
              phase: "waiting-to-activate",
              continuation: "activate",
              progress: null,
              error: null,
              nowIso: "2025-12-31T00:03:00.000Z",
            },
          },
        );
        if (advanced.kind !== "committed") {
          throw new Error(`recovery mock park failed: ${advanced.kind}`);
        }
        parked = advanced.identity;
      },
    );
    if (outer.kind !== "ran" || parked === null) {
      throw new Error(`recovery mock segment failed: ${outer.kind}`);
    }
    return parked;
  }

  async function seedActiveAttemptWithoutActivationContinuation(
    targetVersion: string,
  ): Promise<void> {
    const layout = getHostFsLayout("production");
    const outer = await withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "f2-seed-no-continuation",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) => {
        const created = await commitAttemptMutationWithCapability(
          capability,
          layout.rootDir,
          {
            kind: "create",
            request: {
              targetVersion,
              trigger: "manual",
              action: "start",
              expected: null,
              newAttemptId: "f2-control-1",
              initialPhase: "applying",
              nowIso: "2025-12-31T00:00:00.000Z",
            },
          },
        );
        if (created.kind !== "committed") {
          throw new Error(`control seed failed: ${JSON.stringify(created)}`);
        }
      },
    );
    if (outer.kind !== "ran") {
      throw new Error(`control seed segment failed: ${outer.kind}`);
    }
    const seeded = await readUpdateAttemptRecord(layout.rootDir);
    if (
      seeded.kind !== "valid" ||
      seeded.value.phase !== "applying" ||
      seeded.value.continuation !== null
    ) {
      throw new Error(
        `control seed did not land on applying/null: ${JSON.stringify(seeded)}`,
      );
    }
  }

  /** Under the F1 fix that decodes to `indeterminate`, so a continuation could never report success - the tests were only green while Desktop ignored the verdict entirely. */
  function stageCliWithVerification(report: Record<string, unknown>): void {
    stageCliWithVerificationAndRestart(report, {
      restarted: true,
      version: "2.0.0",
    });
  }

  /** Any test whose subject IS that interaction must state both halves, so that changing the command's answer changes the test's result. */
  function stageCliWithVerificationAndRestart(
    report: Record<string, unknown>,
    restartResponse: Record<string, unknown>,
  ): void {
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(
      async (options) =>
        options.args.includes("update-verify")
          ? { data: report }
          : { data: restartResponse },
    );
  }

  function eligibleDesktopCohort(): void {
    desktopExecutorCohortMock.decide.mockReturnValue({
      kind: "eligible",
      substrate: "smappservice",
    });
  }

  function stagePackagedMacRestartWorld(
    lockTiming:
      | { readonly waitMs: number; readonly pollIntervalMs: number }
      | undefined,
  ): HostController {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller =
      lockTiming === undefined
        ? newController("production")
        : newControllerWithLockTiming(
            "production",
            async () => true,
            lockTiming.waitMs,
            lockTiming.pollIntervalMs,
          );
    writeInstallRecord("production", {
      version: "2.0.0",
      runtimeVersion: "2.0.0",
    });
    writePidMetadata("production", { version: "2.0.0", pid: process.pid });
    return controller;
  }

  /** The park is durable; the host process is not, so a crash, a `host stop`, or a reboot AFTER parking reaches host-down while parked. */
  function stagePackagedMacRestartWorldHostDown(): HostController {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newControllerWithReachability(
      "production",
      async () => false,
    );
    writeInstallRecord("production", {
      version: "2.0.0",
      runtimeVersion: "2.0.0",
    });
    // Deliberately no `writePidMetadata`: no running host to name.
    return controller;
  }

  describe("byte-identical fall-through (no continuation applies)", () => {
    it("no attempt record at all", async () => {
      const controller = stagePackagedMacRestartWorld(undefined);
      vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
        data: { restarted: true, version: "2.0.0" },
      });

      const outcome = await controller.respawn({ kind: "background" });

      expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
      expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
        expect.objectContaining({ args: RESTART_FORCE_ARGV }),
      );
    });

    it("an unreadable (corrupt JSON) attempt record must NOT block Restart", async () => {
      const controller = stagePackagedMacRestartWorld(undefined);
      const layout = getHostFsLayout("production");
      mkdirSync(layout.rootDir, { recursive: true });
      writeFileSync(updateAttemptRecordPath(layout.rootDir), "not json");
      vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
        data: { restarted: true, version: "2.0.0" },
      });

      const outcome = await controller.respawn({ kind: "background" });

      expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
      expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
        expect.objectContaining({ args: RESTART_FORCE_ARGV }),
      );
    });

    // Skipped as root: root ignores file mode bits, so the read would
    // succeed and this would assert the wrong branch (see the identical
    // convention in `host-login-item.test.ts`).
    it.skipIf(process.getuid?.() === 0)(
      "an unreadable (permission-denied) attempt record must NOT block Restart",
      async () => {
        const controller = stagePackagedMacRestartWorld(undefined);
        const layout = getHostFsLayout("production");
        mkdirSync(layout.rootDir, { recursive: true });
        const recordPath = updateAttemptRecordPath(layout.rootDir);
        writeFileSync(
          recordPath,
          JSON.stringify(
            attemptRecordFields({
              phase: "verifying",
              execution: "active",
              continuation: null,
            }),
          ),
        );
        chmodSync(recordPath, 0o000);
        vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
          data: { restarted: true, version: "2.0.0" },
        });
        try {
          const outcome = await controller.respawn({ kind: "background" });
          expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
        } finally {
          chmodSync(recordPath, 0o600);
        }
        expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
          expect.objectContaining({ args: RESTART_FORCE_ARGV }),
        );
      },
    );

    it("`waiting-for-work` (bytes not placed - a plain restart is already correct)", async () => {
      const controller = stagePackagedMacRestartWorld(undefined);
      writeAttemptRecord(
        attemptRecordFields({
          phase: "waiting-for-work",
          execution: "parked",
          continuation: "resume-apply",
        }),
      );
      vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
        data: { restarted: true, version: "2.0.0" },
      });

      const outcome = await controller.respawn({ kind: "background" });

      expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
      expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
        expect.objectContaining({ args: RESTART_FORCE_ARGV }),
      );
    });

    it.each(["complete", "failed", "superseded"] as const)(
      "terminal phase %s - nothing left to continue",
      async (phase) => {
        const controller = stagePackagedMacRestartWorld(undefined);
        writeAttemptRecord(
          attemptRecordFields({
            phase,
            execution: "terminal",
            continuation: null,
          }),
        );
        vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
          data: { restarted: true, version: "2.0.0" },
        });

        const outcome = await controller.respawn({ kind: "background" });

        expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
        expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
          expect.objectContaining({ args: RESTART_FORCE_ARGV }),
        );
      },
    );
  });

  describe("continuation arm (cohort mocked eligible - the seam this surface is exposed to)", () => {
    // Under that fixture the outcome is identical whether the cohort mock is real, eligible, or broken outright, because the gate is never consulted.
    it("SEAM PROOF: under the REAL shipped shadow-disabled cohort, a record with NO adopted activation continuation still falls through to the plain restart", async () => {
      // Forced eligible lets this record past the gate into `claim()`, which refuses an active (non-parked) record with no activation continuation as `requires-recovery`.
      // Under the real disabled gate, the segment is rejected before `claim()` runs, so that claimant is never dispatched at all.
      const controller = stagePackagedMacRestartWorld(undefined);
      writeOwnedSmAppServiceSubstrate();
      await seedActiveAttemptWithoutActivationContinuation("2.0.0");
      vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
        data: { restarted: true, version: "2.0.0" },
      });

      const outcome = await controller.respawn({ kind: "background" });

      expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
      expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
        expect.objectContaining({ args: RESTART_FORCE_ARGV }),
      );
      // The real shipped (shadow-disabled) gate never reaches `claim()` at all, so that call must never happen here.
      expect(streamBundledTraycerCliJson).not.toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(["update-verify"]),
        }),
      );
    });

    // The 6-step stranding they exist for, every step individually correct: 1. an attempt is PARKED with bytes placed and the target host NOT running.
    it("a cohort DISABLED mid-attempt does not strand an adopted activation - the parked record still advances", async () => {
      const controller = stagePackagedMacRestartWorld(undefined);
      writeOwnedSmAppServiceSubstrate();
      await seedParkedActivationAttempt("2.0.0");
      stageCliWithVerificationAndRestart(
        { outcome: "resumed", continuation: "activate" },
        // What the CLI really answers for a placed-byte `preparing/activate` once `--defer-if-parked` is honoured: it refuses WITHOUT stopping.
        { restarted: false, deferredForParkedActivation: true },
      );
      expect(await currentAttemptPhase()).toBe("waiting-to-activate");

      await controller.respawn({ kind: "background" });

      expect(await currentAttemptPhase()).not.toBe("waiting-to-activate");
    });
    // The other side of the sentence. Without this, "skip the gate whenever a
    // record exists" - or deleting the gate outright - would satisfy the test
    // above while silently admitting work the cohort is supposed to stop.
    it("with NO adopted activation continuation, the disabled cohort still refuses - the record does not advance", async () => {
      const controller = stagePackagedMacRestartWorld(undefined);
      writeOwnedSmAppServiceSubstrate();
      await seedActiveAttemptWithoutActivationContinuation("2.0.0");
      stageCliWithVerificationAndRestart(
        { outcome: "resumed", continuation: "activate" },
        { restarted: false, deferredForParkedActivation: true },
      );

      await controller.respawn({ kind: "background" });

      expect(await currentAttemptPhase()).toBe("applying");
    });

    // The gap: an ORPHANED `preparing/activate` is non-parked and non-terminal with the lock free, which `decideAttemptClaim` refuses as `requires-recovery` BY DESIGN.
    // The CLI is mocked here, so the mock must do what the real claimant does: actually re-park the record AND report the identity it parked.
    it("an ORPHANED preparing/activate is recovered and resumed rather than stranded", async () => {
      const controller = stagePackagedMacRestartWorld(undefined);
      writeOwnedSmAppServiceSubstrate();
      await seedPreparingActivateViaResume("2.0.0");
      const before = await readUpdateAttemptRecord(
        getHostFsLayout("production").rootDir,
      );
      if (before.kind !== "valid") throw new Error("seed did not land");

      vi.mocked(streamBundledTraycerCliJson).mockImplementation(
        async (options) => {
          if (options.args.includes("update-verify")) {
            const parked = await reparkPreparingActivateAsRecoveryWould();
            return {
              data: {
                outcome: "resumed",
                continuation: "activate",
                attemptId: parked.attemptId,
                generation: parked.generation,
                sequence: parked.sequence,
              },
            };
          }
          return {
            data: { restarted: false, deferredForParkedActivation: true },
          };
        },
      );

      await controller.respawn({ kind: "background" });

      // What cannot happen if the attempt was abandoned is its identity advancing.
      const after = await readUpdateAttemptRecord(
        getHostFsLayout("production").rootDir,
      );
      expect(after.kind).toBe("valid");
      if (after.kind !== "valid") return;
      expect(
        after.value.generation > before.value.generation ||
          after.value.sequence > before.value.sequence,
      ).toBe(true);
      // And the verification claimant was actually dispatched - without this,
      // an unrelated advance would satisfy the assertion above.
      expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(["update-verify"]),
        }),
      );
    });

    // The CONTROL the ruling requires: indeterminate evidence must leave the record UNCHANGED and must not read as success.
    it("recovery that reports indeterminate leaves the record untouched and does not report success", async () => {
      const controller = stagePackagedMacRestartWorld(undefined);
      writeOwnedSmAppServiceSubstrate();
      await seedPreparingActivateViaResume("2.0.0");
      const before = await readUpdateAttemptRecord(
        getHostFsLayout("production").rootDir,
      );
      if (before.kind !== "valid") throw new Error("seed did not land");
      stageCliWithVerificationAndRestart(
        { outcome: "indeterminate", reason: "recovery-evidence-flapped" },
        { restarted: false, deferredForParkedActivation: true },
      );

      const outcome = await controller.respawn({ kind: "background" });

      const after = await readUpdateAttemptRecord(
        getHostFsLayout("production").rootDir,
      );
      expect(after.kind).toBe("valid");
      if (after.kind !== "valid") return;
      expect(after.value.generation).toBe(before.value.generation);
      expect(after.value.sequence).toBe(before.value.sequence);
      expect(outcome).not.toEqual({ kind: "ok", value: { activated: true } });
    });

    // So the nested acquisition contended against its own parent, resolved `busy`/`source:"attempt"`, terminalized the record `failed`/`activation-not-performed`, and never attempted.
    // In production the F3 continuation arm could therefore NEVER complete an activation.
    it("a legal `waiting-to-activate` continuation completes and returns ok/activated WITHOUT ever calling `host restart --force`", async () => {
      eligibleDesktopCohort();
      // The verify child must answer with a real verdict; the F1 fix now
      // reads it, so an unstaged/foreign payload decodes to `indeterminate`.
      stageCliWithVerification({ outcome: "complete" });
      const controller = stagePackagedMacRestartWorld(undefined);
      writeOwnedSmAppServiceSubstrate();
      await seedParkedActivationAttempt("2.0.0");

      const outcome = await controller.respawn({ kind: "background" });

      expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
      // The whole point: the continuation satisfied the restart request by
      // itself. The plain CLI recovery path never ran.
      expect(streamBundledTraycerCliJson).not.toHaveBeenCalledWith(
        expect.objectContaining({ args: RESTART_FORCE_ARGV }),
      );
      // It DID dispatch the post-restart verification claim.
      expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(["host", "update-verify"]),
        }),
      );
      // The record actually advanced past its park - proves this was a
      // real claim/commit, not a stubbed-out shortcut.
      const committed = await readUpdateAttemptRecord(
        getHostFsLayout("production").rootDir,
      );
      expect(committed.kind).toBe("valid");
      if (committed.kind === "valid") {
        expect(committed.value.phase).not.toBe("waiting-to-activate");
      }
    });

    // NOTE on what this test actually proves right now: the assertion below (never re-parked as `waiting-to-activate`) is true and meaningful, but with the self-deadlock defect pinned.

    // `recoveryActionFor` calls `restarting/activate` and `verifying/activate` `restart-current`.
    // That leaves Desktop exactly two obligations, and this block asserts both: ALWAYS pass `--defer-if-parked`, and never flatten the command's deferral into an `ok`.
    it.each([
      ["failed", { outcome: "failed", reason: "runtime-mismatch" }],
      ["resumed", { outcome: "resumed", continuation: "activate" }],
      ["indeterminate", { outcome: "indeterminate", reason: "unreadable" }],
      ["unrecognized", { outcome: "some-future-arm" }],
      ["foreign payload", { restarted: true, version: "2.0.0" }],
    ])(
      "a %s verdict falls through carrying --defer-if-parked, and the command's refusal is reported as deferred - never as ok",
      async (_label, report) => {
        eligibleDesktopCohort();
        stageCliWithVerificationAndRestart(report, {
          // What the command returns when it classified `stop-only` under its
          // own lock and refused WITHOUT stopping the service. The host is
          // still in whatever state it was in.
          restarted: false,
          deferredForParkedActivation: true,
        });
        const controller = stagePackagedMacRestartWorld(undefined);
        writeOwnedSmAppServiceSubstrate();
        await seedParkedActivationAttempt("2.0.0");

        const outcome = await controller.respawn({ kind: "background" });

        // Verification WAS dispatched - this is about consuming its answer.
        expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
          expect.objectContaining({
            args: expect.arrayContaining(["update-verify"]),
          }),
        );
        // The generic restart WAS invoked, with the exact argv including `--defer-if-parked`.
        expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
          expect.objectContaining({ args: RESTART_FORCE_ARGV }),
        );
        // Full shape, not `outcome.kind`. `{kind:"ok", value:{activated:false}}`
        // is the STRANDED shape - it reads as "the restart ran and achieved
        // nothing" - and asserting only the kind cannot tell the two apart.
        expect(outcome).toEqual({
          kind: "deferred",
          message: expect.any(String),
        });
      },
    );

    // Finding 2's half, and the reason the Desktop-side policy copy had to go: a record the CANONICAL classification calls `restart-current` must actually be restarted.
    // The round-1 code deferred on every continuation phase, so `restarting/activate` and `verifying/activate` - both explicitly recoverable - could never be relaunched from this route.
    it("a non-complete verdict over a RECOVERABLE record restarts, and the relaunch is reported as an activation", async () => {
      eligibleDesktopCohort();
      stageCliWithVerificationAndRestart(
        { outcome: "indeterminate", reason: "unreadable" },
        // The command found `restart-current` under its lock and relaunched.
        { restarted: true, version: "2.0.0" },
      );
      const controller = stagePackagedMacRestartWorld(undefined);
      writeOwnedSmAppServiceSubstrate();
      await seedParkedActivationAttempt("2.0.0");

      const outcome = await controller.respawn({ kind: "background" });

      expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
        expect.objectContaining({ args: RESTART_FORCE_ARGV }),
      );
      expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
    });

    it("a terminalized continuation restarts and reports the relaunch", async () => {
      eligibleDesktopCohort();
      const controller = stagePackagedMacRestartWorld(undefined);
      writeOwnedSmAppServiceSubstrate();
      await seedParkedActivationAttempt("2.0.0");
      vi.mocked(streamBundledTraycerCliJson).mockImplementation(
        async (options) => {
          if (options.args.includes("update-verify")) {
            rmSync(
              updateAttemptRecordPath(getHostFsLayout("production").rootDir),
              { force: true },
            );
            return { data: { outcome: "failed", reason: "terminalized" } };
          }
          return { data: { restarted: true, version: "2.0.0" } };
        },
      );

      const outcome = await controller.respawn({ kind: "background" });

      expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
        expect.objectContaining({ args: RESTART_FORCE_ARGV }),
      );
      expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
    });
    it("requirement #4: `overrideDrain: true` and `action: activate` - never `force`. Proven by a BUSY drain that does not park", async () => {
      eligibleDesktopCohort();
      // The verify child must answer with a real verdict; the F1 fix now
      // reads it, so an unstaged/foreign payload decodes to `indeterminate`.
      stageCliWithVerification({ outcome: "complete" });
      const controller = stagePackagedMacRestartWorld(undefined);
      writeOwnedSmAppServiceSubstrate();
      await seedParkedActivationAttempt("2.0.0");
      vi.mocked(probeHostActivityBusy).mockResolvedValue(true);

      const outcome = await controller.respawn({ kind: "background" });

      expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
      // `{ok, activated:true}` alone proves NOTHING here - it is also exactly
      // what a fall-through to the plain restart returns. This assertion is
      // what makes the test discriminate: the continuation ran instead.
      expect(streamBundledTraycerCliJson).not.toHaveBeenCalledWith(
        expect.objectContaining({ args: RESTART_FORCE_ARGV }),
      );
      const committed = await readUpdateAttemptRecord(
        getHostFsLayout("production").rootDir,
      );
      expect(committed.kind).toBe("valid");
      if (committed.kind === "valid") {
        // NOT re-parked. A busy drain under `overrideDrain: true` proceeds
        // straight through instead of writing `waiting-to-activate` again.
        expect(committed.value.phase).not.toBe("waiting-to-activate");
        expect(committed.value.phase).not.toBe("failed");
      }
    });
  });

  describe("live-executor deferral is the ONLY refusal that does not fall through", () => {
    it("a `busy` contender outcome returns `deferred`, NOT a fall-through restart", async () => {
      eligibleDesktopCohort();
      // Small injected wait/poll (fixup A9's pattern) so the real contended
      // lock resolves `busy` within milliseconds instead of exhausting the
      // production 30s wait.
      const controller = stagePackagedMacRestartWorld({
        waitMs: 150,
        pollIntervalMs: 25,
      });
      writeOwnedSmAppServiceSubstrate();
      await seedParkedActivationAttempt("2.0.0");
      // `withDesktopAttemptExecutor`/`withDesktopUpdateExecutionSegment` (the outer wrapper F3's segment goes through) contends ONLY on the outer update-attempt lock via.
      // Acquire it for real and never release it for the duration of this test, so the segment observes a genuinely contended lock rather than a simulated refusal.
      const held = await acquireUpdateAttemptLock({
        hostHomeDir: getHostFsLayout("production").rootDir,
        reason: "f3-test-live-holder",
        waitMs: 0,
        pollIntervalMs: 10,
      });
      expect(held.kind).toBe("acquired");

      try {
        const outcome = await controller.respawn({ kind: "background" });
        expect(outcome.kind).toBe("deferred");
      } finally {
        if (held.kind === "acquired") await held.handle.release();
      }
      // The refusal did NOT fall through to a plain restart - stopping a
      // live executor's host mid-flight is the one thing worse than not
      // restarting at all.
      expect(streamBundledTraycerCliJson).not.toHaveBeenCalledWith(
        expect.objectContaining({ args: RESTART_FORCE_ARGV }),
      );
    });

    it("a rejection (real shipped cohort-disabled) falls through to the plain restart", async () => {
      const controller = stagePackagedMacRestartWorld(undefined);
      writeOwnedSmAppServiceSubstrate();
      await seedParkedActivationAttempt("2.0.0");
      vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
        data: { restarted: true, version: "2.0.0" },
      });

      const outcome = await controller.respawn({ kind: "background" });

      expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
      expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
        expect.objectContaining({ args: RESTART_FORCE_ARGV }),
      );
    });

    it("a rejection past the cohort gate (active phase, no live holder - requires-recovery) also falls through", async () => {
      eligibleDesktopCohort();
      const controller = stagePackagedMacRestartWorld(undefined);
      writeOwnedSmAppServiceSubstrate();
      // An ACTIVE (non-parked) phase with no live lock holder: the record claims a segment is executing, but nothing here actually holds `update-attempt.lock`.
      // `decideAttemptClaim` refuses this as `requires-recovery` - reconciling it is the CLI executor's job, never Desktop's - which is a `rejected` outcome, not `busy`.
      writeAttemptRecord(
        attemptRecordFields({
          phase: "applying",
          execution: "active",
          continuation: null,
        }),
      );
      vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
        data: { restarted: true, version: "2.0.0" },
      });

      const outcome = await controller.respawn({ kind: "background" });

      expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
      expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
        expect.objectContaining({ args: RESTART_FORCE_ARGV }),
      );
    });
  });

  // A mixed-version CLI that only knows `cli-lock` must still be excluded from mutating the install tree underneath this segment.
  describe("F2: the continuation actually takes the inner cli-lock", () => {
    // The wired property, proven positively: with the inner cli-lock genuinely held externally, registration never runs at all.
    it("a genuinely busy cli-lock blocks registration from ever running", async () => {
      eligibleDesktopCohort();
      const controller = stagePackagedMacRestartWorld({
        waitMs: 150,
        pollIntervalMs: 25,
      });
      writeOwnedSmAppServiceSubstrate();
      await seedParkedActivationAttempt("2.0.0");
      const held = await acquireDesktopCliLock({
        lockPath: cliLockPath("production"),
        reason: "f2-test-live-holder",
        waitMs: 0,
        pollIntervalMs: 10,
      });
      expect(held.kind).toBe("acquired");

      try {
        await controller.respawn({ kind: "background" });
      } finally {
        if (held.kind === "acquired") await held.handle.release();
      }
      expect(registerHostLoginItem).not.toHaveBeenCalled();

      // Reverted before committing anything; `host-controller.ts` was never touched.
    });

    it("a genuinely busy cli-lock defers the continuation rather than failing or falling through", async () => {
      eligibleDesktopCohort();
      const controller = stagePackagedMacRestartWorld({
        waitMs: 150,
        pollIntervalMs: 25,
      });
      writeOwnedSmAppServiceSubstrate();
      await seedParkedActivationAttempt("2.0.0");
      const held = await acquireDesktopCliLock({
        lockPath: cliLockPath("production"),
        reason: "f2-test-live-holder",
        waitMs: 0,
        pollIntervalMs: 10,
      });
      expect(held.kind).toBe("acquired");

      try {
        const outcome = await controller.respawn({ kind: "background" });
        expect(outcome).toEqual({
          kind: "deferred",
          message: "Another Traycer process is managing the host.",
        });
      } finally {
        if (held.kind === "acquired") await held.handle.release();
      }
      // Not a failure, and not a fall-through - a busy inner lock is
      // ordinary contention with a real mixed-version CLI, not evidence the
      // restart itself should proceed unlocked.
      expect(streamBundledTraycerCliJson).not.toHaveBeenCalledWith(
        expect.objectContaining({ args: RESTART_FORCE_ARGV }),
      );
    });
  });

  // F3 (round 5 review): `withMintedAdoption` had ZERO production callers before this ticket.
  // This must be provable from the spawned argv, not from an internal call to `withMintedAdoption` - the argv IS the wire contract the child actually receives.
  describe("F3: the takeover child actually receives a minted nonce", () => {
    const UUID_PATTERN =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    function takeoverCallArgv(): readonly string[] | undefined {
      return vi
        .mocked(streamBundledTraycerCliJson)
        .mock.calls.map(([options]) => options.args)
        .find((args) => args.includes("--takeover"));
    }

    it("a takeover-recoverable registration failure shells --takeover with --attempt-adoption <nonce>", async () => {
      eligibleDesktopCohort();
      stageCliWithVerification({ outcome: "complete" });
      const controller = stagePackagedMacRestartWorld(undefined);
      writeOwnedSmAppServiceSubstrate();
      await seedParkedActivationAttempt("2.0.0");
      // One of the three `isCliTakeoverRecoverableStatus` values - drives
      // `runMacActivationStepWithCapability` to `phase: "register-failed"`,
      // which is the only path that reaches `withMintedAdoption`.
      vi.mocked(registerHostLoginItem).mockResolvedValueOnce("not-registered");

      const outcome = await controller.respawn({ kind: "background" });

      expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
      const argv = takeoverCallArgv();
      expect(argv).toBeDefined();
      const flagIndex = argv?.indexOf("--attempt-adoption") ?? -1;
      expect(flagIndex).toBeGreaterThanOrEqual(0);
      expect(argv?.[flagIndex + 1]).toMatch(UUID_PATTERN);

      // Ablated (verification-only, never committed): temporarily mocked `../update-mutation`'s `withMintedAdoption` to bypass minting.
      // Reverted before committing anything; `host-controller.ts` was never touched.
    });

    describe("terminal-with-diagnostics contract for a post-tombstone mint/spawn failure", () => {
      async function assertAttemptLockReleased(): Promise<void> {
        const held = await acquireUpdateAttemptLock({
          hostHomeDir: getHostFsLayout("production").rootDir,
          reason: "f3-post-terminalize-retry-probe",
          waitMs: 0,
          pollIntervalMs: 10,
        });
        expect(held.kind).toBe("acquired");
        if (held.kind === "acquired") await held.handle.release();
      }

      async function respawnWithMintFailure(): Promise<void> {
        eligibleDesktopCohort();
        const controller = stagePackagedMacRestartWorld(undefined);
        writeOwnedSmAppServiceSubstrate();
        await seedParkedActivationAttempt("2.0.0");
        vi.mocked(registerHostLoginItem).mockResolvedValueOnce(
          "not-registered",
        );
        writeAdoptionProofMock.write.mockRejectedValueOnce(
          new Error("simulated proof write failure"),
        );
        vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
          data: { restarted: true, version: "2.0.0" },
        });

        const outcome = await controller.respawn({ kind: "background" });

        // #4: the route does NOT report `deferred` - it falls through to
        // the byte-identical plain restart (the honest close for a segment
        // that already promised one).
        expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
        expect(outcome.kind).not.toBe("deferred");
        expect(takeoverCallArgv()).toBeUndefined();
        expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
          expect.objectContaining({ args: RESTART_FORCE_ARGV }),
        );
      }

      it("a mint failure terminalizes correctly - tombstone withdrawn, lock released, bytes untouched, route does not report deferred", async () => {
        await respawnWithMintFailure();

        const committed = await readUpdateAttemptRecord(
          getHostFsLayout("production").rootDir,
        );
        expect(committed.kind).toBe("valid");
        if (committed.kind !== "valid") return;
        // #1: the tombstone is gone by final state...
        expect(
          existsSync(hostStopIntentPath(getHostFsLayout("production").rootDir)),
        ).toBe(false);
        expect(committed.value.phase).toBe("failed");
        // ...AND withdrawn BEFORE the record's `failed` commit specifically - not merely gone by the time this test happens to look.
        // Both orderings produce the identical final state above, which is why that assertion alone cannot tell them apart; this one can.
        expect(terminalOrderEvents.events).toEqual([
          "clear-tombstone",
          "terminalize-commit",
        ]);
        // #5: bytes stayed put - no partial activation reachable from this
        // arm. The cheap proxy available at this layer: the staged install
        // record is untouched by the failed mint/takeover attempt.
        const installVersion = readInstallRecordVersion("production");
        expect(installVersion).toBe("2.0.0");

        // #2: the attempt lock is genuinely released - not merely that the
        // record reached a terminal phase.
        await assertAttemptLockReleased();
      });
      it("a spawn (takeover CLI) failure terminalizes with the FULL correct contract, diagnostics included", async () => {
        eligibleDesktopCohort();
        const controller = stagePackagedMacRestartWorld(undefined);
        writeOwnedSmAppServiceSubstrate();
        await seedParkedActivationAttempt("2.0.0");
        vi.mocked(registerHostLoginItem).mockResolvedValueOnce("not-found");
        vi.mocked(streamBundledTraycerCliJson).mockImplementation(
          async (options) => {
            if (options.args.includes("--takeover")) {
              throw new Error("takeover exploded");
            }
            return { data: { restarted: true, version: "2.0.0" } };
          },
        );

        const outcome = await controller.respawn({ kind: "background" });

        // #4: not `deferred` here either.
        expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
        expect(outcome.kind).not.toBe("deferred");
        expect(takeoverCallArgv()).toBeDefined();
        expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
          expect.objectContaining({ args: RESTART_FORCE_ARGV }),
        );

        const committed = await readUpdateAttemptRecord(
          getHostFsLayout("production").rootDir,
        );
        expect(committed.kind).toBe("valid");
        if (committed.kind !== "valid") return;
        // #1: tombstone withdrawn - by final state, and BEFORE the
        // terminalizing commit specifically (see the mint-failure test's
        // comment for why the ordering assertion is the one that matters).
        expect(
          existsSync(hostStopIntentPath(getHostFsLayout("production").rootDir)),
        ).toBe(false);
        expect(committed.value.phase).toBe("failed");
        expect(terminalOrderEvents.events).toEqual([
          "clear-tombstone",
          "terminalize-commit",
        ]);
        // #5: bytes stayed put.
        const installVersion = readInstallRecordVersion("production");
        expect(installVersion).toBe("2.0.0");
        // #2: attempt lock genuinely released.
        await assertAttemptLockReleased();
        expect(committed.value.error?.message).toContain("not-found");
      });

      // Ablated (verification-only, never committed): temporarily swapped `update-executor.ts`'s terminal-close to call `terminalize` BEFORE `clearTombstone` (previously: withdraw first.
      // Reverted before committing anything; production files were never left modified.
    });

    it("regression guard: legacy (non-continuation) takeover recovery still passes NO adoption args", async () => {
      vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
      const controller = newController("production");
      writeInstallRecord("production", {
        version: "1.7.0",
        runtimeVersion: "1.7.0",
      });
      writePidMetadata("production", { version: "1.7.0", pid: process.pid });
      vi.mocked(waitForHostReady).mockResolvedValue({
        ready: true,
        version: "1.7.0",
        pid: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        reason: "ready",
      });
      vi.mocked(registerHostLoginItem).mockResolvedValue("not-found");
      vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
        data: { restarted: true, version: "1.7.0" },
      });

      const outcome = await controller.activateInstalled(true);

      expect(outcome.kind).toBe("ok");
      const argv = takeoverCallArgv();
      expect(argv).toBeDefined();
      expect(argv).not.toContain("--attempt-adoption");
      // The mint mock was never even reached on this path.
      expect(writeAdoptionProofMock.write).not.toHaveBeenCalled();
    });
  });
});

// Packaged macOS recovery must use the same attempt-aware CLI restart lane as the CLI-owned path.
// In particular, a parked activation continuation is a safe-stop (`restarted: false`), not permission for Desktop to activate the bytes currently on disk through SMAppService.
describe("packaged-mac recovery delegates safe-stop to the CLI", () => {
  it("respawn uses host restart --force and does not activate a direct safe-stop result", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const lifecycle = fakeHostLifecycle();
    const controller = newControllerWithLifecycle(lifecycle, async () => true);
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { restarted: false },
    });

    await expect(controller.respawn({ kind: "background" })).resolves.toEqual({
      kind: "ok",
      value: { activated: false },
    });
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["host", "restart", "--force", "--defer-if-parked"],
      }),
    );
    expect(waitForHostReady).not.toHaveBeenCalled();
    expect(registerHostLoginItem).not.toHaveBeenCalled();
    expect(runBundledTraycerCliJson).not.toHaveBeenCalled();
    expect(lifecycle.reloadSnapshotFromDisk).toHaveBeenCalledTimes(1);
  });

  it("recoverIfDown uses host restart and accepts a nested safe-stop envelope", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const lifecycle = fakeHostLifecycle();
    const controller = newControllerWithLifecycle(lifecycle, async () => false);
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { data: { restarted: false } },
    });

    await expect(controller.recoverIfDown()).resolves.toEqual({
      kind: "ok",
      value: { activated: false },
    });
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["host", "restart", "--defer-if-parked"],
      }),
    );
    expect(waitForHostReady).not.toHaveBeenCalled();
    expect(registerHostLoginItem).not.toHaveBeenCalled();
    expect(runBundledTraycerCliJson).not.toHaveBeenCalled();
    expect(lifecycle.reloadSnapshotFromDisk).toHaveBeenCalledTimes(1);
  });

  it("freePortAndRestart uses host free-port-and-restart and handles a direct safe-stop", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const lifecycle = fakeHostLifecycle();
    const controller = newControllerWithLifecycle(lifecycle, async () => true);
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { restartedLabel: null },
    });

    await expect(
      controller.freePortAndRestart(1234, 5678, { kind: "background" }),
    ).resolves.toEqual({ kind: "ok", value: { activated: false } });
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          "host",
          "free-port-and-restart",
          "--defer-if-parked",
          "--pid",
          "1234",
          "--port",
          "5678",
        ],
      }),
    );
    expect(waitForHostReady).not.toHaveBeenCalled();
    expect(registerHostLoginItem).not.toHaveBeenCalled();
    expect(runBundledTraycerCliJson).not.toHaveBeenCalled();
    expect(lifecycle.reloadSnapshotFromDisk).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "respawn",
      ["host", "restart", "--force", "--defer-if-parked"],
      async (c: HostController) => c.respawn({ kind: "background" }),
      true,
    ],
    [
      "recoverIfDown",
      ["host", "restart", "--defer-if-parked"],
      async (c: HostController) => c.recoverIfDown(),
      false,
    ],
    [
      "freePortAndRestart",
      [
        "host",
        "free-port-and-restart",
        "--defer-if-parked",
        "--pid",
        "1234",
        "--port",
        "5678",
      ],
      async (c: HostController) =>
        c.freePortAndRestart(1234, 5678, { kind: "background" }),
      true,
    ],
  ])(
    "%s passes --defer-if-parked and reports the command's refusal as deferred, not as a no-op ok",
    async (_label, expectedArgs, invoke, hostReachable) => {
      vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
      const lifecycle = fakeHostLifecycle();
      const controller = newControllerWithLifecycle(
        lifecycle,
        async () => hostReachable,
      );
      vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
        data: { restarted: false, deferredForParkedActivation: true },
      });

      const outcome = await invoke(controller);

      expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
        expect.objectContaining({ args: expectedArgs }),
      );
      // Full shape. `kind` alone would pass for the stranded `ok` too, which
      // is the exact substitution this test exists to catch.
      expect(outcome).toEqual({
        kind: "deferred",
        message: expect.any(String),
      });
      // Nothing was activated and nothing was registered - a refusal touched
      // the machine as little as it claims to.
      expect(waitForHostReady).not.toHaveBeenCalled();
      expect(registerHostLoginItem).not.toHaveBeenCalled();
    },
  );

  // The negative control for the pair above: WITHOUT the deferral flag in the response, the same `restarted:false` must still read as the safe-stop it has always been.
  it("a safe-stop WITHOUT the deferral flag is still reported as ok/activated:false", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const lifecycle = fakeHostLifecycle();
    const controller = newControllerWithLifecycle(lifecycle, async () => true);
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { restarted: false, deferredForParkedActivation: false },
    });

    await expect(controller.respawn({ kind: "background" })).resolves.toEqual({
      kind: "ok",
      value: { activated: false },
    });
  });
});

describe("recoverIfDown", () => {
  it("suppresses when a mutation already owns the host, checked before submission", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    const gate = deferred<{ data: unknown }>();
    vi.mocked(streamBundledTraycerCliJson).mockReturnValueOnce(gate.promise);

    const respawnPromise = controller.respawn({ kind: "background" });
    await flushMicrotasks();

    const recovered = await controller.recoverIfDown();
    expect(recovered).toEqual({ kind: "suppressed" });

    gate.resolve({ data: { activated: true } });
    await respawnPromise;
  });

  it("returns ok without restarting when the head-of-lane re-check finds the host already reachable", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });

    const outcome = await controller.recoverIfDown();
    expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
    expect(streamBundledTraycerCliJson).not.toHaveBeenCalled();
  });

  // The pid here IS genuinely alive (`process.pid`) - only the endpoint probe reports unreachable - so a correct implementation must still restart.
  it("actually restarts when pid.json parses and the pid is alive but the endpoint probe reports unreachable", async () => {
    const controller = newControllerWithReachability(
      "production",
      async () => false,
    );
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        installGeneration: "recover-command-generation",
        runtimeVersion: null,
        runtimeWasNull: true,
      },
    });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue({
      outcome: "stamped",
    });

    const outcome = await controller.recoverIfDown();
    expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["host", "restart", "--defer-if-parked"],
      }),
    );
  });

  it("deferred when the host was removed by the user", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    removePidMetadata("production");
    await controller.removeTraycer().catch(() => undefined);

    const outcome = await controller.recoverIfDown();
    expect(outcome).toEqual({
      kind: "deferred",
      message: "Host was removed by the user.",
    });
  });

  it("maps E_CLI_LOCK_BUSY on a CLI-owned restart to a deferred outcome (recoverIfDown is a manual-invoke-shaped intent, not convergeReady)", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    removePidMetadata("production");
    vi.mocked(streamBundledTraycerCliJson).mockRejectedValue(
      new TraycerCliError("E_CLI_LOCK_BUSY", "lock busy"),
    );

    const outcome = await controller.recoverIfDown();
    expect(outcome).toEqual({
      kind: "deferred",
      message: "Another Traycer process is managing the host.",
    });
  });

  // `recoverIfDown`/`respawn` always run the unconditional `host restart` (never `--if-idle`), which never busy-checks CLI-side.
  it("an unclassified CLI failure on a CLI-owned restart maps to failed, not busy", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    removePidMetadata("production");
    vi.mocked(streamBundledTraycerCliJson).mockRejectedValue(
      new Error("connection refused"),
    );

    const outcome = await controller.recoverIfDown();
    expect(outcome).toEqual({ kind: "failed", message: "connection refused" });
  });

  // Fixup B10: `recoverIfDown` drives its own restart, so it must stamp immediately after its own readiness observation using the attested pre-cycle generation.
  it("stamps immediately after its own restart when the pre-cycle record is null-runtime", async () => {
    const controller = newControllerWithReachability(
      "production",
      async () => false,
    );
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        installGeneration: "free-port-command-generation",
        runtimeVersion: null,
        runtimeWasNull: true,
      },
    });

    await controller.recoverIfDown();

    expect(runBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.arrayContaining(["host", "stamp-runtime"]),
    );
  });
});

describe("freePortAndRestart (CLI-owned)", () => {
  it("stamps immediately after its own restart when the pre-cycle record is null-runtime", async () => {
    const controller = newControllerWithReachability(
      "production",
      async () => false,
    );
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        installGeneration: "free-port-command-generation",
        runtimeVersion: null,
        runtimeWasNull: true,
      },
    });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue({
      outcome: "stamped",
    });

    const outcome = await controller.freePortAndRestart(null, null, {
      kind: "background",
    });

    expect(outcome.kind).toBe("ok");
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["host", "free-port-and-restart", "--defer-if-parked"],
      }),
    );
    expect(runBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.arrayContaining(["host", "stamp-runtime"]),
    );
  });
});

// The command returns the record it observed while holding cli-lock; each caller must feed THAT generation to the CAS, never derive one from its pre-lock Desktop disk read.
describe("CLI-owned service start attestation (closing A2)", () => {
  const commandGeneration = "committed-under-cli-lock";

  function configureStampAndServiceAttestation(): void {
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("stamp-runtime")) return { outcome: "stamped" };
      if (args.includes("available")) {
        return availableSnapshotFixture("1.7.0", ["1.7.0"]);
      }
      return {
        installGeneration: commandGeneration,
        runtimeVersion: null,
        runtimeWasNull: true,
      };
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        installGeneration: commandGeneration,
        runtimeVersion: null,
        runtimeWasNull: true,
      },
    });
  }

  function expectCommandGenerationWasStamped(): void {
    expect(runBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.arrayContaining([
        "host",
        "stamp-runtime",
        "--expected-install-generation",
        commandGeneration,
        "--observed-pid",
        "1",
        "--observed-started-at",
        "2026-01-01T00:00:00.000Z",
      ]),
    );
  }

  it("activateInstalled stamps the restart command's attested generation", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    configureStampAndServiceAttestation();

    expect((await controller.activateInstalled(false)).kind).toBe("ok");
    expectCommandGenerationWasStamped();
  });

  it("registerService stamps the service-install command's attested generation", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    configureStampAndServiceAttestation();

    expect(
      (await controller.registerService({ kind: "background" })).kind,
    ).toBe("ok");
    expectCommandGenerationWasStamped();
  });

  it("F3: registerService accepts the existing PID when service install does not cycle it", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue({
      installGeneration: "already-stamped-generation",
      runtimeVersion: "1.7.0",
      runtimeWasNull: false,
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    expect(
      (await controller.registerService({ kind: "background" })).kind,
    ).toBe("ok");
    expect(waitForHostReady).toHaveBeenCalledWith(
      expect.any(Number),
      getHostFsLayout("production").pidMetadataFile,
      expect.any(Number),
      null,
    );
  });

  it("does not report success when a command-attested stamped install publishes a different runtime", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        installGeneration: "already-stamped-generation",
        runtimeVersion: "1.7.0",
        runtimeWasNull: false,
      },
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.8.0",
      pid: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    const outcome = await controller.registerService({ kind: "background" });

    expect(outcome).toMatchObject({
      kind: "failed",
      message: expect.stringContaining("committed installation expects 1.7.0"),
    });
  });

  it("F1: treats a lifecycle reload that demotes post-start readiness as a failed registration", async () => {
    const lifecycle = fakeHostLifecycle();
    vi.mocked(lifecycle.reloadSnapshotFromDisk).mockResolvedValue(null);
    const controller = new HostController({
      environment: "production",
      hostLifecycle: lifecycle,
      reachabilityProbe: async () => true,
      desktopLockWaitMs: DESKTOP_LOCK_WAIT_MS,
      desktopLockPollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
    });
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue({
      installGeneration: "already-stamped-generation",
      runtimeVersion: "1.7.0",
      runtimeWasNull: false,
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    const outcome = await controller.registerService({ kind: "background" });

    expect(outcome).toMatchObject({
      kind: "failed",
      message: expect.stringContaining("became unavailable"),
    });
    // The direct post-readiness publication demotes, then the failure path
    // makes its required best-effort reload too. Neither may report `ok`.
    expect(lifecycle.reloadSnapshotFromDisk).toHaveBeenCalledTimes(2);
  });

  it("reloads the lifecycle snapshot after a command-started service fails readiness", async () => {
    const lifecycle = fakeHostLifecycle();
    const controller = new HostController({
      environment: "production",
      hostLifecycle: lifecycle,
      reachabilityProbe: async () => false,
      desktopLockWaitMs: DESKTOP_LOCK_WAIT_MS,
      desktopLockPollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
    });
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue({
      installGeneration: "already-stamped-generation",
      runtimeVersion: "1.7.0",
      runtimeWasNull: false,
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: false,
      version: null,
      pid: null,
      startedAt: null,
      reason: "timeout",
    });

    const outcome = await controller.registerService({ kind: "background" });

    expect(outcome.kind).toBe("failed");
    expect(lifecycle.reloadSnapshotFromDisk).toHaveBeenCalledTimes(1);
  });

  it("F7: reloads lifecycle state after each disruptive CLI command throws", async () => {
    const convergeLifecycle = fakeHostLifecycle();
    const convergeController = new HostController({
      environment: "production",
      hostLifecycle: convergeLifecycle,
      reachabilityProbe: async () => true,
      desktopLockWaitMs: DESKTOP_LOCK_WAIT_MS,
      desktopLockPollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
    });
    vi.mocked(streamBundledTraycerCliJson).mockRejectedValueOnce(
      new Error("ensure failed after side effects"),
    );

    expect(
      (await convergeController.convergeReady(false, { kind: "background" }))
        .kind,
    ).toBe("failed");
    expect(convergeLifecycle.reloadSnapshotFromDisk).toHaveBeenCalledTimes(1);

    const applyLifecycle = fakeHostLifecycle();
    const applyController = new HostController({
      environment: "production",
      hostLifecycle: applyLifecycle,
      reachabilityProbe: async () => true,
      desktopLockWaitMs: DESKTOP_LOCK_WAIT_MS,
      desktopLockPollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
    });
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.8.0", ["1.8.0"]),
    );
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("apply")) {
        throw new Error("apply failed after side effects");
      }
      return { data: {} };
    });

    expect((await applyController.applyStaged("manual", false)).kind).toBe(
      "failed",
    );
    expect(applyLifecycle.reloadSnapshotFromDisk).toHaveBeenCalledTimes(1);

    const installLifecycle = fakeHostLifecycle();
    const installController = new HostController({
      environment: "production",
      hostLifecycle: installLifecycle,
      reachabilityProbe: async () => true,
      desktopLockWaitMs: DESKTOP_LOCK_WAIT_MS,
      desktopLockPollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("install")) {
        throw new Error("install failed after side effects");
      }
      return { data: {} };
    });

    expect((await installController.installVersion("1.8.0", false)).kind).toBe(
      "failed",
    );
    expect(installLifecycle.reloadSnapshotFromDisk).toHaveBeenCalledTimes(1);
  });
});

describe("installVersion busy/force continuation (CLI-owned)", () => {
  it("a busy pin (E_HOST_BUSY, pre-stop) resolves busy/retry-with-force; Force re-submits and succeeds", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });

    vi.mocked(streamBundledTraycerCliJson).mockRejectedValueOnce(
      new TraycerCliError("E_HOST_BUSY", "host busy"),
    );
    const busyOutcome = await controller.installVersion("1.8.0", false);
    expect(busyOutcome).toEqual({
      kind: "busy",
      continuation: "retry-with-force",
      message: expect.stringContaining("work in progress"),
    });
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["host", "install", "--release", "1.8.0", "--if-idle"],
      }),
    );

    vi.mocked(streamBundledTraycerCliJson).mockResolvedValueOnce({
      data: { version: "1.8.0", installGeneration: null },
    });
    const forcedOutcome = await controller.installVersion("1.8.0", true);
    expect(forcedOutcome.kind).toBe("ok");
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["host", "install", "--release", "1.8.0"],
      }),
    );
  });

  it("Defer abandons the pin - no durable pending-pin state on the controller", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    vi.mocked(streamBundledTraycerCliJson).mockRejectedValueOnce(
      new TraycerCliError("E_HOST_BUSY", "host busy"),
    );
    await controller.installVersion("1.8.0", false);

    // A later, unrelated intent is unaffected - there is no leftover
    // "pending pin" the controller silently retries or blocks behind.
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValueOnce({
      data: { activated: true },
    });
    const respawnOutcome = await controller.respawn({ kind: "background" });
    expect(respawnOutcome.kind).toBe("ok");

    // Fixup C2: the title's own claim - "no durable pending-pin state" - was never actually exercised against the SAME pin; an unrelated intent succeeding doesn't prove that.
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValueOnce({
      data: { version: "1.8.0", installGeneration: null },
    });
    const retryOutcome = await controller.installVersion("1.8.0", false);
    expect(retryOutcome.kind).toBe("ok");
    expect(streamBundledTraycerCliJson).toHaveBeenCalledTimes(3);
  });
});

// `requires-approval` never auto-retries: only the user can act there.
describe("packaged-mac activation: bounded auto-retry on readiness timeout", () => {
  const NOT_READY = {
    ready: false,
    version: null,
    pid: null,
    startedAt: null,
    reason: "pid metadata never appeared",
  } as const;

  function stagePackagedMacWorld(): HostController {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    return controller;
  }

  it("re-runs the full cycle once (register included) and succeeds when the host comes up on attempt two", async () => {
    const controller = stagePackagedMacWorld();
    vi.mocked(waitForHostReady)
      .mockResolvedValueOnce(NOT_READY)
      .mockResolvedValue({
        ready: true,
        version: "1.7.0",
        pid: process.pid,
        startedAt: "2026-01-01T00:00:00.000Z",
        reason: "ready",
      });

    const outcome = await controller.activateInstalled(true);

    expect(outcome.kind).toBe("ok");
    // The retry is a FULL cycle - a second register, not a second wait on
    // the failed cycle's corpse.
    expect(waitForHostReady).toHaveBeenCalledTimes(2);
    expect(registerHostLoginItem).toHaveBeenCalledTimes(2);
  });

  it("stays bounded: a second timeout surfaces the gate card carrying the readiness reason", async () => {
    const controller = stagePackagedMacWorld();
    vi.mocked(waitForHostReady).mockResolvedValue(NOT_READY);

    const outcome = await controller.activateInstalled(true);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toContain("pid metadata never appeared");
    }
    expect(waitForHostReady).toHaveBeenCalledTimes(2);
  });

  /** Accepting that would report an activation that never happened, which is worse than the wasted cycle because it is silent. */
  it("accepts a host that came up late instead of cycling it again", async () => {
    const controller = stagePackagedMacWorld();
    // The host binds just AFTER the deadline: the wait reports not-ready, and by the time the retry decision is taken pid.json names a new process.
    vi.mocked(waitForHostReady).mockImplementation(async () => {
      writePidMetadata("production", { version: "1.7.0", pid: process.ppid });
      return NOT_READY;
    });

    const outcome = await controller.activateInstalled(true);

    expect(outcome.kind).toBe("ok");
    // The point of the guard: no second bootout, no second wait.
    expect(waitForHostReady).toHaveBeenCalledTimes(1);
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
  });

  it("does NOT accept the outgoing host as proof the cycle succeeded", async () => {
    const controller = stagePackagedMacWorld();
    vi.mocked(waitForHostReady).mockResolvedValue(NOT_READY);
    // pid.json still names the pid that was serving BEFORE the cycle - the
    // host being evicted, still answering because teardown has not finished.
    // Reachable, and worth nothing as evidence.

    const outcome = await controller.activateInstalled(true);

    expect(outcome.kind).toBe("failed");
    expect(waitForHostReady).toHaveBeenCalledTimes(2);
  });

  it("never auto-retries when the login item requires approval - only the user can act there", async () => {
    const controller = stagePackagedMacWorld();
    vi.mocked(waitForHostReady).mockResolvedValue(NOT_READY);
    // Flips only after the wait ran: a blanket "requires-approval" would
    // hit the cycle's EARLY approval terminal before register/wait and
    // this test would pin the wrong branch (see the mid-wait toggle test).
    vi.mocked(readHostLoginItemStatus).mockImplementation(() =>
      vi.mocked(waitForHostReady).mock.calls.length > 0
        ? "requires-approval"
        : "enabled",
    );

    const outcome = await controller.respawn({ kind: "background" });

    expect(outcome.kind).toBe("failed");
    expect(waitForHostReady).toHaveBeenCalledTimes(1);
  });
});

// Field RCA 2026-07-28 (`make install-desktop-production`, ad-hoc build): SMAppService answered `not-found` for a byte-correct in-bundle plist for the remainder of the app process's.
// These rows pin the escalation: a register failure hands off to the CLI-owned raw LaunchAgent (`host service install --takeover`), which does not go through SMAppService/BTM at all.
describe("packaged-mac register failure: CLI-owned LaunchAgent takeover fallback", () => {
  const TAKEOVER_ARGV = ["host", "service", "install", "--takeover"];

  function stagePackagedMacWorld(): HostController {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    // The fallback's readiness check keeps the normal version-equality guard: the recovered host must publish the runtime the committed installation expects (the beforeEach default.
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });
    return controller;
  }

  it("activation cycle: register not-found recovers via the CLI takeover without a second SMAppService attempt", async () => {
    const controller = stagePackagedMacWorld();
    vi.mocked(registerHostLoginItem).mockResolvedValue("not-found");

    const outcome = await controller.activateInstalled(true);

    expect(outcome.kind).toBe("ok");
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({ args: TAKEOVER_ARGV }),
    );
    // The futile-retry pin: `not-found` is sticky for this SMAppService
    // session, so neither the S8 wrapper nor the fallback may re-run the
    // register cycle.
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
    // SMAppService is unusable this session - the pending-revision monitor
    // must not boot the fallback host back out for a plist revision it
    // cannot land.
    expect(controller.isPendingRevisionRefreshQuarantined()).toBe(true);
  });

  it("activation cycle: a failing takeover surfaces one terminal message naming the status and the manual escape hatch", async () => {
    const controller = stagePackagedMacWorld();
    vi.mocked(registerHostLoginItem).mockResolvedValue("not-found");
    vi.mocked(streamBundledTraycerCliJson).mockRejectedValue(
      new Error("takeover exploded"),
    );

    const outcome = await controller.activateInstalled(true);

    // The raw `Error` path classifies to `failed` before enrichment; the
    // helper must preserve that kind, not just append text to it.
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toContain("status=not-found");
      expect(outcome.message).toContain("takeover exploded");
      expect(outcome.message).toContain("traycer host service uninstall");
      expect(outcome.message).toContain("traycer host doctor");
    }
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
  });

  // The denial must resolve `deferred` so restart surfaces present it as information.
  it("activation cycle: a takeover denied by a busy host resolves busy - retry-later information, not a reportable failure", async () => {
    const controller = stagePackagedMacWorld();
    vi.mocked(registerHostLoginItem).mockResolvedValue("not-found");
    vi.mocked(streamBundledTraycerCliJson).mockRejectedValue(
      new TraycerCliError(
        "E_HOST_BUSY",
        "service install --takeover: the running host has work in progress and denied the shutdown claim; retry once the work completes.",
      ),
    );

    const outcome = await controller.activateInstalled(true);

    // The durable property this test protects survives that split: whichever label it carries, a live host with work in progress is retry-later information, never a reportable failure.
    expect(outcome.kind).not.toBe("failed");
    expect(outcome.kind).toBe("busy");
    if (outcome.kind === "busy") {
      expect(outcome.message).toContain("work in progress");
    }
    // The denial still quarantines this SMAppService session: the register
    // cycle is just as doomed as any other takeover-recoverable failure.
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
    expect(controller.isPendingRevisionRefreshQuarantined()).toBe(true);
  });

  it("activation cycle: a takeover that registered but never produced a ready host is a failure, not a silent success", async () => {
    const controller = stagePackagedMacWorld();
    vi.mocked(registerHostLoginItem).mockResolvedValue("not-registered");
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: false,
      version: null,
      pid: null,
      startedAt: null,
      reason: "pid metadata never appeared",
    });

    const outcome = await controller.activateInstalled(true);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toContain("status=not-registered");
      expect(outcome.message).toContain("pid metadata never appeared");
    }
  });
  it("requires-approval NEVER escalates to the takeover (activateInstalled leg) - the toggle is the user's alone", async () => {
    const controller = stagePackagedMacWorld();
    vi.mocked(registerHostLoginItem).mockResolvedValue("requires-approval");
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: false,
      version: null,
      pid: null,
      startedAt: null,
      reason: "pid metadata never appeared",
    });
    vi.mocked(readHostLoginItemStatus).mockImplementation(() =>
      vi.mocked(waitForHostReady).mock.calls.length > 0
        ? "requires-approval"
        : "enabled",
    );

    const activateOutcome = await controller.activateInstalled(true);

    expect(activateOutcome.kind).toBe("failed");
    // Guards against a vacuous pass: the pre-bootout `requires-approval` preflight must not have short-circuited before the cycle actually reached registration.
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
    expect(runBundledTraycerCliJson).not.toHaveBeenCalledWith(TAKEOVER_ARGV);
  });
  it("removed-by-user NEVER escalates to the takeover - reinstalling the service would defy the removal", async () => {
    const controller = stagePackagedMacWorld();
    // The register cycle's own in-lock re-check found the removal sentinel
    // (persisted mid-cycle by an in-app uninstall) - the fallback would
    // resurrect the exact registration the user just removed.
    vi.mocked(registerHostLoginItem).mockResolvedValue("removed-by-user");

    const outcome = await controller.activateInstalled(true);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toBe(HOST_REMOVED_BY_USER_MESSAGE);
    }
    expect(runBundledTraycerCliJson).not.toHaveBeenCalledWith(TAKEOVER_ARGV);
  });
});

// Two things must hold: (1) a `streamBundled` call made while NO mutation is active (e.g. the `applyPendingLoginItemRevisionIfIdle` takeover recovery path, which deliberately runs.
describe("streamBundled progress ownership: mutationEpoch (fixup E)", () => {
  it("a streamBundled call spawned OUTSIDE the mutation lane never publishes progress into an unrelated mutation that starts while it is still running", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("not-registered");
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    const takeoverGate = deferred<{ data: unknown }>();
    const restartGate = deferred<{ data: unknown }>();
    const takeoverEvents: { onEvent: ((event: NdjsonEvent) => void) | null } = {
      onEvent: null,
    };

    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("--takeover")) {
        takeoverEvents.onEvent = opts.onEvent;
        return takeoverGate.promise;
      }
      if (opts.args.includes("restart")) {
        return restartGate.promise;
      }
      return { data: {} };
    });

    const progresses: MutationProgress[] = [];
    const unsubscribe = controller.onMutationProgress((p) => {
      progresses.push(p);
    });

    const refreshPromise =
      controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    await vi.waitFor(() => {
      if (takeoverEvents.onEvent === null) {
        throw new Error("takeover streamBundled call not reached yet");
      }
    });

    // A completely unrelated mutation starts while the out-of-lane takeover
    // call above is still in flight - `respawn`'s own restart call is gated
    // too, so its mutation stays active for the assertion below.
    const respawnPromise = controller.respawn({ kind: "background" });
    await flushMicrotasks();

    if (takeoverEvents.onEvent === null) {
      throw new Error("takeoverEvents.onEvent was never captured");
    }
    takeoverEvents.onEvent({
      type: "progress",
      stage: "register",
      percent: 50,
      bytes: null,
      totalBytes: null,
      message: "registering host-credential",
      workUnits: null,
    });
    await flushMicrotasks();

    // The active mutation is `respawn`'s, not the out-of-lane takeover's -
    // the progress event must not have landed anywhere.
    expect(progresses).toHaveLength(0);

    restartGate.resolve({ data: { activated: true } });
    await respawnPromise;
    takeoverGate.resolve({ data: {} });
    await refreshPromise;
    unsubscribe();
  });

  it("a normal in-lane streamBundled call still publishes its progress events", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });

    const progresses: MutationProgress[] = [];
    const unsubscribe = controller.onMutationProgress((p) => {
      progresses.push(p);
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      opts.onEvent({
        type: "progress",
        stage: "restart",
        percent: 10,
        bytes: null,
        totalBytes: null,
        message: "restarting",
        workUnits: null,
      });
      return { data: { activated: true } };
    });

    const outcome = await controller.respawn({ kind: "background" });
    unsubscribe();

    expect(outcome.kind).toBe("ok");
    expect(progresses).toEqual([
      expect.objectContaining({ stage: "restart", percent: 10 }),
    ]);
  });
});

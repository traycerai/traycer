import { spawn } from "node:child_process";
import {
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

// Host Update Layer Redesign Tech Plan - Ticket: "Desktop main: HostController
// two-lane scheduler + policy cutover". This is the ticket's own verification
// suite: the mutation lane's wait-never-reject contract (the "screenshot
// race" guardrail - `convergeReady` during an in-flight apply/update resolves
// instead of throwing, and "Another host operation" no longer exists
// anywhere in this call graph), the desktop-held `cli-lock` sections around
// SMAppService work (proven with a genuine two-process test), identity/debt
// derivation and convergence, the yank/apply reconcile-ordering edge, the
// macOS vs CLI-owned platform matrix, `removeTraycer`'s ordering, and
// `applyPendingLoginItemRevisionIfIdle` (the production-incident-driven
// pending-LaunchAgent-revision refresh, retargeted here after
// `host-ensure-ipc.ts`'s deletion folded its coverage in).
//
// Mocking boundary: the CLI subprocess wrapper (`../../cli/traycer-cli`),
// the macOS SMAppService bindings (`../../app/host-login-item`), and
// `waitForHostReady`'s own polling (`../host-readiness` - its polling
// mechanics are a pre-existing primitive, not part of this ticket) are
// mocked. `./host-state`, `./host-paths`, `./host-removal-state`, and
// `./desktop-cli-lock` are REAL - installed/staged/pid records are read from
// and written to a real temp `$HOME/.traycer` tree per test, so state
// derivation and the desktop lock are genuinely exercised, not simulated.

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
  unregisterHostLoginItem: vi.fn(async () => undefined),
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
  unregisterHostLoginItem,
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
  type MutationLaneStatus,
  type MutationProgress,
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
  vi.mocked(unregisterHostLoginItem).mockResolvedValue(undefined);
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

// Fixup A3: `readRunningRuntimeVersion` now requires a real endpoint-
// reachability probe. Defaulting it to always-reachable here preserves
// every existing fixture-driven test's behavior (they write a pid.json with
// a genuinely-alive `pid: process.pid` and rely on that alone meaning
// "running") without needing a real TCP listener bound to the fixture's
// `websocketUrl`; the small number of A3-specific tests that need to prove
// the "process alive, endpoint dead" gap use
// `newControllerWithReachability` directly with a probe that resolves false.
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

// Fixup A9: the desktop-held cli-lock's wait/poll is now an injectable
// `HostControllerOptions` field (production: `DESKTOP_LOCK_WAIT_MS`/
// `DESKTOP_LOCK_POLL_INTERVAL_MS`, matching the CLI's own 30s `waitMs` -
// fixup A8) rather than a hardcoded module constant every call site read
// directly. Every existing test funnels through `newControllerWithReachability`
// above, which passes the real production timing unchanged - the
// "desktop-held cli-lock: two-process test" still exercises a genuine
// multi-second poll against a real worker process. Only the
// exhausted-lock-wait contract test below needs the wait to actually
// elapse inside a unit test, so it calls this lower-level helper directly
// with a small override instead.
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

// Mirrors the REAL `traycer host available --json` wire shape (pinned by
// the contract test in `traycer-cli/src/commands/__tests__/host-available.test.ts`):
// `{ manifest: { latest, versions[].platforms[platformKey] }, manifestUrl,
// platformKey }`, NOT a flat `{latest, versions[].platformAsset}` shape
// (fixup A1 - every fixture using the old flat shape validated the parsing
// bug rather than catching it).
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

// ---------------------------------------------------------------------------
// Headline guardrail: "the screenshot race becomes a test" - `convergeReady`
// submitted while a mutation is in flight resolves once its turn comes,
// instead of being rejected the way the deleted `trackHostOperation`
// single-flight guard used to reject a second concurrent call synchronously.
// ---------------------------------------------------------------------------
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
    const convergePromise = controller.convergeReady(false).then((outcome) => {
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

// ---------------------------------------------------------------------------
// Mutation lane: wait-never-reject, FIFO ordering, no starvation.
// ---------------------------------------------------------------------------
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

    const first = await controller.respawn();
    expect(first.kind).toBe("failed");

    const second = await controller.respawn();
    expect(second.kind).toBe("ok");
  });

  it("submissions run in FIFO order, never overlapping (retargets the deleted host-registration-cycle-coordination.test.ts mutual-exclusion coverage)", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    // Fixup C2: `applyStaged` short-circuits to a synthetic "ok" without
    // ever invoking the CLI when there's no staged version - a staged
    // record is required for `applyStagedCliOwned` (and therefore this
    // test's `order` tracking) to run at all.
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
      controller.respawn(),
      controller.applyStaged("manual", false),
      controller.respawn(),
    ]);

    expect(maxConcurrentHolders).toBe(1);
    // Fixup C2: the title's own "FIFO order" claim was never checked - only
    // mutual exclusion was. The second `respawn()` coalesces with the first
    // (same key, still in flight). `applyStaged`'s production preflight
    // revalidates the extant stage before consuming it, but that in-lane
    // pass is manifest-only. The one automatic download stays on the
    // independent lane before apply owns the mutation lane.
    expect(order).toEqual([
      "host restart --force",
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

// ---------------------------------------------------------------------------
// v1.1.7 update-flow review findings re-derived onto the HostController:
//   Mo-A - a live host + `requires-approval` must not be booted out for a
//          futile register cycle (only the user can approve the login item).
//   Mi-1 - a bare progress heartbeat must hold the last concrete numbers
//          instead of blanking the progress bar to null.
// ---------------------------------------------------------------------------
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

    const outcome = await controller.respawn();

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
    // `registry-*` ticks are emitted from inside whatever stage is already
    // running, so letting one overwrite `stage` flipped the renderer's
    // heading away from "Downloading Traycer Host…" and back on every
    // retry - constant flicker on the throttled links the retry budget
    // exists for. The tick's message must still come through.
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
      // ...and a GENUINE transition carries nothing. This assertion used to read
      // `percent: 45`, pinning the leak as though it were intended - incidentally,
      // since this test's subject is the `stage` guard and not the numbers. It was
      // the only thing in the suite that noticed they leaked, and it agreed with
      // them.
      expect.objectContaining({
        stage: "extract",
        percent: null,
        bytes: null,
        totalBytes: null,
      }),
    ]);
  });

  it("a genuine stage transition blanks the bar instead of inheriting a COMPLETED download's numbers", async () => {
    // THE SHIPPED DEFECT, in the shape a user meets it. On every registry
    // install: download climbs to 100% with bytes == totalBytes, extract
    // announces with all three null, the stage transitions correctly - and every
    // number is inherited. So the card sat at a FULL progress bar reading
    // "800 MB of 800 MB", under "Setting up Traycer Host…", for the whole
    // multi-minute extract.
    //
    // A full bar reads as FINISHED, not as working, which makes it the worst of
    // the three fields. Blanking is not a regression: the new stage has no
    // measured position yet, and an honest empty beats an inherited lie.
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

// ---------------------------------------------------------------------------
// Fixup A5: keyed coalescing (Tech Plan D3 "explicit coalescing keys, per-
// intent results") - a duplicate submission still in flight for the same
// intent + distinguishing params JOINS the existing job instead of
// re-executing it. Distinct from mere serialization: these tests assert the
// CLI was invoked exactly once for two concurrent identical calls, not just
// that both eventually resolve.
// ---------------------------------------------------------------------------
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
      controller.respawn(),
      controller.respawn(),
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

    await controller.respawn();
    await controller.respawn();

    expect(restartCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Two independent lanes: a download never starts while a mutation owns the
// host, and re-kicks once the mutation completes.
// ---------------------------------------------------------------------------
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

    const respawnPromise = controller.respawn();
    await flushMicrotasks();

    const stageLatestPromise = controller.stageLatest();
    await flushMicrotasks();
    // Mutation lane still owns the host - no download call was made yet.
    expect(downloadCalls).toHaveLength(0);

    mutationGate.resolve({ data: { activated: true } });
    await respawnPromise;
    await stageLatestPromise;
    // `enqueueMutation`'s finally re-kicks the pending stageLatest - real fs
    // reads (isHostRemovedByUser, install/staged records) are in the path
    // before the download call, so poll rather than assume a fixed number
    // of microtask ticks is enough.
    await vi.waitFor(() => {
      if (downloadCalls.length === 0)
        throw new Error("download not kicked yet");
    });

    expect(downloadCalls.length).toBeGreaterThan(0);
  });

  // Fixup A6: `stageLatest`'s synchronous `mutationStatus !== null` guard
  // only covers callers that start AFTER a mutation is already active. This
  // proves the OTHER direction - a mutation starting WHILE the registry
  // probe (an async gap) is still in flight must still be caught, by a
  // re-check made atomically with the decision to start the download.
  it("re-checks mutation state after the registry probe, not just at entry - a mutation starting mid-probe still defers the download", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", null);

    const probeGate = deferred<void>();
    // Separately gated from the probe - respawn's OWN CLI call must stay
    // pending for the length of this test, or its `finally` would clear
    // `mutationStatus` back to null before the assertion below runs and the
    // test would pass for the wrong reason (respawn already having
    // finished) rather than genuinely exercising the re-check.
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
    const respawnPromise = controller.respawn();
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

  // Fixup A6: `applyStaged`'s preflight reconcile (registry probe + possible
  // download) must run BEFORE the exclusive mutation lane is entered, so a
  // WAN download never holds every other mutation hostage - the exact
  // gate-pressure bug this ticket exists to eliminate.
  it("applyStaged's preflight download reconcile does not hold the exclusive mutation lane - a concurrent convergeReady is not blocked on it", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", null);

    const downloadGate = deferred<unknown>();
    // Signals that the preflight download has actually been ENTERED. The
    // property under test is "convergeReady is not blocked while apply sits
    // in its preflight download", so apply must provably be sitting there
    // before convergeReady starts. `flushMicrotasks()` cannot establish that:
    // it is three promise turns, while `applyStaged` first crosses real fs
    // reads. Losing that race makes this test either time out or - worse -
    // pass without ever exercising the concurrency it claims to prove.
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

    const convergePromise = controller.convergeReady(false);
    // The download is still gated (unresolved) while convergeReady reaches
    // its own CLI call - real fs reads (readRunningHostIdentity et al.) are
    // in the path first, so poll rather than assume a fixed number of
    // microtask ticks is enough. If the exclusive lane were held across the
    // download, this would never resolve until `downloadGate` is released.
    await vi.waitFor(() => {
      if (!ensureCalled) throw new Error("ensure not reached yet");
    });
    expect(ensureCalled).toBe(true);

    downloadGate.resolve(undefined);
    await applyPromise;
    await convergePromise;
  });

  // Fixup A6 (third citation): `activateInstalled`'s "a ready update
  // supersedes activation debt" branch used to run its own reconcile via
  // `applyStagedInline` from WITHIN the lane (it couldn't re-enter
  // `enqueueMutation`, so it inlined the same reconcile-then-download
  // logic in place) - same gate-pressure bug as `applyStaged`'s own entry
  // point. The reconcile now runs once, before `activateInstalled` enters
  // the lane at all.
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

    const convergePromise = controller.convergeReady(false);
    await vi.waitFor(() => {
      if (!ensureCalled) throw new Error("ensure not reached yet");
    });
    expect(ensureCalled).toBe(true);

    downloadGate.resolve(undefined);
    await activatePromise;
    await convergePromise;
  });
});

// ---------------------------------------------------------------------------
// Fixup C5: the download lane's `finally` used to unconditionally null
// `downloadStatus` right after the `catch` block above wrote `lastError`
// into it - the terminal error was written and erased in the same tick, so
// `getStatus().download` could never observe a failed download (ticket 4
// needs this to render download-lane failures).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Desktop-held cli-lock sections (Tech Plan "cli-lock" rule 3): the SAME
// file-lock protocol the CLI itself uses, so a real cross-process CLI
// mutation and a desktop-driven SMAppService cycle exclude each other.
// ---------------------------------------------------------------------------
describe("desktop-held cli-lock: two-process test", () => {
  // Fixup C1: the worker used to only hold/release the lock and exercise
  // register - disk state never changed, so this couldn't catch any of the
  // races it exists to cover (nested stamp reacquisition (A7), missing
  // post-acquisition state reread (B12), supersession (A4)). The worker now
  // starts a real terminal `traycer host uninstall` process while it holds
  // that lock. This test asserts both lock participation (the real CLI has
  // not changed disk state while the worker lock is held) and the desktop
  // post-acquisition reread after the terminal mutation wins the lock.
  it("V1: a packaged-macOS registerService call yields to a real terminal host uninstall, then detects its post-lock supersession", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    // Use a real multi-run slot, not dev's legacy path. The controller, the
    // worker, and the source CLI must all carry this exact value: if any
    // side drops slot resolution, they contend on different .lock files and
    // desktop registers before the terminal uninstall wins.
    process.env[DEV_DESKTOP_SLOT_ENV] = "round4-v1-lock";
    // The checked-in real CLI source is a dev build, so exercise the dev
    // slot: that makes the terminal command and desktop controller address
    // the identical live lock and install record without a test-only CLI.
    // The terminal CLI is queued first. Give this desktop contender a
    // deliberately slower polling cadence so the test deterministically
    // exercises the CLI winning the next lock turn, rather than relying on
    // two 100ms timers happening to fire in the desired order.
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

    // This marker is written by the REAL CLI's `withCliLock` callback,
    // immediately after it acquires the shared lock and before host-uninstall
    // enters its critical section. Waiting for it before submitting Desktop
    // avoids a scheduler race where a cold `bun run` has not reached its
    // first lock attempt before Desktop's own retry timer wakes.
    await waitForFile(join(barrierDir, "cli-lock-acquired"));
    const registerPromise = controller.registerService();
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
    // Proves the post-acquisition reread (fixup B12): if desktop had acted
    // on the pre-wait snapshot it could only have read before this point
    // (when the install still existed) instead of re-reading after
    // acquiring the lock, this would be `{kind: "ok"}` and
    // `registerHostLoginItem` would have been called against an install
    // that no longer exists.
    expect(outcome).toEqual({ kind: "failed", message: "No host installed." });
    expect(registerHostLoginItem).not.toHaveBeenCalled();

    expect(await workerExit).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Fixup A7: the packaged-macOS null-runtime activation cycle used to call
// `stampIfNullRuntime` (which spawns `host stamp-runtime` - a CLI subprocess
// that reacquires this SAME desktop-held lock file) from INSIDE the
// `withDesktopCliLock` closure. Nesting a CLI-locked section inside a
// desktop-locked one deadlocks the subprocess against its own caller until
// the desktop's own subprocess timeout swallows the error - activation then
// reports success while the stamp silently never lands. `runBundledTraycerCliJson`
// is mocked here to make a REAL acquisition attempt against the SAME lock
// file `runLockedMacActivationCycle` uses (`./desktop-cli-lock` is real, not
// mocked, per this suite's mocking boundary) - proving genuine contention
// (or its absence) rather than merely asserting call order.
// ---------------------------------------------------------------------------
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
    const acquireAttempts: Array<"acquired" | "busy"> = [];
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async () => {
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

    const outcome = await controller.respawn();

    expect(outcome.kind).toBe("ok");
    expect(runBundledTraycerCliJson).toHaveBeenCalledTimes(1);
    expect(acquireAttempts).toEqual(["acquired"]);
  });
});

// ---------------------------------------------------------------------------
// Fixup A9: the desktop-held cli-lock's wait/poll used to be a hardcoded
// module constant (`DESKTOP_LOCK_WAIT_MS = 30_000`) baked into every
// `withDesktopCliLock` call site, so the "lock wait exhausted -> `deferred`"
// terminal contract (the same contract fixup A8 depends on: a lock-taking
// CLI subprocess must be allowed to run at least as long as the CLI's own
// 30s lock wait) could only be proven with a real 30-second wait - not
// practical for a unit suite, per the review's "code-level reasoning was
// insufficient, and findings A6/A8 show why." `HostControllerOptions` now
// takes the wait/poll as an explicit, required, per-instance field, so a
// test can inject a small override and force a genuine exhaustion within
// milliseconds instead of asserting on code shape.
// ---------------------------------------------------------------------------
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

    const outcome = await controller.respawn();

    expect(outcome.kind).toBe("deferred");
    await held.handle.release();
  });
});

// ---------------------------------------------------------------------------
// Lock-contention terminal contract: ONE class, `deferred`, for every
// mutation - convergeReady included. This SUPERSEDES fixup B3, which split
// convergeReady off to "failed" + a Retry-worded message for the renderer's
// live "connecting to host" gate. That gate's automatic converge is retired
// (D14/C5); convergeReady's launch-time caller is now the selection
// authority's ensure - a background actor - and the engine turns a `failed`
// completion into a 30s dead-lease cooldown, i.e. the "No host is
// available" modal over a healthy machine whose lock the desktop's own
// launch reconcile happened to hold. A held lock means nothing ran and
// nothing was learned about the host; the surviving manual surfaces
// (Settings converge, doctor) throw the outcome message whatever its kind.
// What this pin still protects from B3's era: contention during the
// packaged-mac ACTIVATION CYCLE (after the ensure CLI call) resolves
// cleanly - no hang, no throw.
// ---------------------------------------------------------------------------
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
    const outcome = await controller.convergeReady(true);

    expect(outcome.kind).toBe("deferred");
    await held.handle.release();
  });
});

// ---------------------------------------------------------------------------
// Canonical status: activation-state derivation + convergence across a
// simulated app restart (a fresh HostController reading the same on-disk
// state - exactly what production sees on a real relaunch, since nothing
// HostController tracks that matters here is held in memory).
// ---------------------------------------------------------------------------
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
    // Launch 1: an install record predating runtime stamping (runtimeVersion
    // null) with no host running - `activateInstalled` cycles it and, since
    // the record itself has a null stamp, stamps immediately from its own
    // readiness observation (installGeneration attested from disk, per the
    // Tech Plan's stamp-runtime CAS).
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

// ---------------------------------------------------------------------------
// Yank/apply ordering edge: `applyStaged` awaits any in-flight-or-due
// eligibility reconcile for the staged version before re-reading
// `updateReady`, so a yanked stage is never applied post-refresh.
// ---------------------------------------------------------------------------
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

  it("keeps the stable --automatic path when release-candidate updates are off", async () => {
    vi.mocked(prereleaseUpdatesEnabled).mockReturnValue(false);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.8.0",
      runtimeVersion: "1.8.0",
    });
    // A genuine stable update - the untouched `--automatic` path handles it.
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.9.0", ["1.9.0"]),
    );
    const downloads: string[] = [];
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) downloads.push(opts.args.join(" "));
      return { data: {} };
    });

    await controller.stageLatest();

    // No opt-in and no RC staged => the probe stays stable-only...
    expect(runBundledTraycerCliJson).toHaveBeenCalledWith([
      "host",
      "available",
      "--json",
    ]);
    // ...and the download follows the stable `latest` via `--automatic`.
    expect(downloads).toEqual(["host download --automatic"]);
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
      // The reconciliation which was pending behind the older restart saw
      // the stage as eligible. By the time apply owns the lane, registry
      // curation has yanked it; only the fresh in-lane pass can observe
      // that state before `host apply` consumes the bytes.
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

    const restart = controller.respawn();
    await vi.waitFor(() => {
      // `--force` distinguishes respawn (the explicit force path - the
      // Settings Force-restart offer, tray restart) from the cooperative
      // `["host", "restart"]` that `activateInstalledCliOwned`/`recoverIfDown`
      // send: respawn must skip the shutdown claim the busy host would deny.
      expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
        expect.objectContaining({ args: ["host", "restart", "--force"] }),
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

  // Fixup B13: `activateInstalled`'s "a ready update supersedes activation
  // debt" branch must re-derive `updateReady` AFTER its preflight reconcile
  // settles, not decide it from the pre-reconcile disk state. Simulates the
  // yank-heal arm discovering the staged version was pulled from the
  // registry (`host download --automatic` discards `staged.json`) - the
  // pre-existing activation debt (installed but null-runtime) must still
  // get its own real activation cycle, never an `applied`/`activated:true`
  // outcome papered over the discarded stage.
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

// ---------------------------------------------------------------------------
// Platform matrix: packaged-macOS (SMAppService/login-item) vs CLI-owned.
// ---------------------------------------------------------------------------
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

  // Fixup B11: `installVersion(pin, force)` used to hardcode `force: false`
  // into the packaged-mac post-commit activation cycle, so Settings'
  // "Force" busy-continuation resubmit on a pin still refused to activate
  // past a busy host - it committed bytes then reported `busy` again,
  // making Force a no-op on this one platform/intent combination.
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

  // Fixup C6: `runLockedMacActivationCycle`'s readiness-timeout diagnosis
  // used to classify the failure using `registerResult` - captured BEFORE
  // `waitForHostReady` even started - so a user disabling the login item in
  // System Settings mid-wait still surfaced the generic Doctor-text timeout
  // message instead of the actionable approval one. The pre-wait register
  // call here returns "enabled" (not requires-approval); only the POST-wait
  // reread reports requires-approval, proving the diagnosis uses a fresh
  // read rather than the stale pre-wait result. Restores the deleted
  // `respawnHost` test's exact pin.
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
    // "enabled" until the readiness wait has actually run, then
    // "requires-approval" - the mid-wait toggle this test exists to pin. A
    // blanket "requires-approval" here made the cycle's EARLY approval
    // terminal fire before register and before the wait, so the queued
    // not-ready readiness above was never consumed (and leaked into the
    // next test's Once queue) while the assertion passed against the wrong
    // branch.
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

  // Fixup B6: `convergeReadyPackagedMac`'s "already reachable, skip
  // activation" fast-path used to key off reachability ALONE - a live OLD
  // process still answering pings made "reachable" true regardless of what
  // `ensure` just reported, so freshly-installed bytes never got activated.
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

    await controller.convergeReady(false);

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

    await controller.convergeReady(true);

    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
  });

  it("registerService uses the CLI on non-macOS and the login-item helper on packaged macOS", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(false);
    const cliController = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    await cliController.registerService();
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
    await macController.registerService();
    expect(runBundledTraycerCliJson).not.toHaveBeenCalled();
    expect(streamBundledTraycerCliJson).not.toHaveBeenCalled();
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
    expect(waitForHostReady).toHaveBeenCalledTimes(1);
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

    const outcome = await controller.registerService();

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

    const outcome = await controller.registerService();

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

    const outcome = await controller.registerService();

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

    const outcome = await controller.registerService();

    expect(outcome.kind).toBe("ok");
    expect(waitForHostReady).toHaveBeenCalledTimes(1);
    expect(runBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.arrayContaining(["host", "stamp-runtime"]),
    );
  });

  // Fixup B12 (lock rule 3): re-read install state after acquisition - a
  // terminal `host uninstall --all` may have won the lock, removed the
  // install, and released it while this call waited its turn. Registering
  // SMAppService against an absent install used to report success for a
  // host that no longer exists.
  it("registerService on packaged macOS fails without registering when the install is absent after lock acquisition", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    // Deliberately no `writeInstallRecord` - simulates a concurrent
    // terminal uninstall winning the lock first.

    const outcome = await controller.registerService();

    expect(outcome).toEqual({ kind: "failed", message: "No host installed." });
    expect(registerHostLoginItem).not.toHaveBeenCalled();
  });

  it("dev environment threads --allow-self-invocation into the CLI-owned service install", async () => {
    const controller = newController("dev");
    writeInstallRecord("dev", { version: "1.7.0", runtimeVersion: "1.7.0" });
    await controller.registerService();
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
    vi.mocked(unregisterHostLoginItem).mockImplementation(async () => {
      sentinelWasSetWhenUnregisterRan.push(await isHostRemovedByUser());
    });
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("uninstall")) {
        sentinelWasSetWhenUninstallRan.push(await isHostRemovedByUser());
      }
      return { removedInstallDir: true, serviceUninstalled: true };
    });

    expect(await isHostRemovedByUser()).toBe(false);
    const outcome = await controller.removeTraycer();

    expect(outcome.kind).toBe("ok");
    expect(sentinelWasSetWhenUnregisterRan).toEqual([true]);
    expect(sentinelWasSetWhenUninstallRan).toEqual([true]);
    expect(await isHostRemovedByUser()).toBe(true);
  });

  // P3: the signal must reach the real download child, and removal must wait
  // for that child to close before it begins the uninstall. A signal-only
  // check is insufficient: it would still allow a late promote to race the
  // removal path.
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
      if (args.includes("uninstall")) {
        uninstallCalls += 1;
      }
      return { removedInstallDir: true, serviceUninstalled: true };
    });
    // Signals that the download is genuinely in flight WITH its abort
    // listener attached. Without this handshake the test has no in-flight
    // child to abort: `flushMicrotasks()` is three promise turns, while
    // `stageLatest` first crosses real fs reads (isHostRemovedByUser, the
    // staged-record read) before the download child and its AbortController
    // exist. Removal could therefore win outright, leaving `observedAbort`
    // false forever - which is a 1 s `vi.waitFor` timeout, not a bug in the
    // behaviour under test. Raising that deadline would only wait longer on
    // a precondition that never became true.
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

    // A subsequent registry-refresh tick's `stageLatest` is a hard no-op
    // once removed - this is the actual "no resurrection" guarantee (the
    // in-flight download's bytes landing late doesn't get picked up by
    // anything, because every entry point re-checks `isHostRemovedByUser`).
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
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue({
      removedInstallDir: true,
      serviceUninstalled: true,
    });

    await controller.uninstallHost(true);
    expect(await isHostRemovedByUser()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixup B9: `applyStagedCliOwned` must decide whether to stamp off the
// NEWLY COMMITTED record's own runtime stamp (`result.runtimeVersion`),
// never the record apply just replaced. Applying a null-runtime archive
// over an already-stamped install still needs immediate CAS stamping - the
// old code read `preRecord.runtimeVersion` (the record being REPLACED) and
// skipped it whenever that happened to already be non-null, leaving
// avoidable durable activation debt.
// ---------------------------------------------------------------------------
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

  it("V4: stamps an ensured null-runtime generation using ensure's attested generation", async () => {
    const controller = newController("production");
    writePidMetadata("production", { version: "1.8.0", pid: process.pid });
    const stampCalls: (readonly string[])[] = [];
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("stamp-runtime")) {
        stampCalls.push(args);
        return { outcome: "stamped" };
      }
      return {};
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        action: "started",
        installed: true,
        registered: true,
        running: true,
        version: "1.8.0",
        runtimeVersion: null,
        installGeneration: "ensure-command-generation",
        postSwapError: null,
      },
    });

    const outcome = await controller.convergeReady(false);

    expect(outcome.kind).toBe("ok");
    expect(stampCalls).toHaveLength(1);
    const generationIndex = stampCalls[0]?.indexOf(
      "--expected-install-generation",
    );
    if (generationIndex === undefined || generationIndex < 0) {
      throw new Error("stamp-runtime did not receive an expected generation");
    }
    expect(stampCalls[0]?.[generationIndex + 1]).toBe(
      "ensure-command-generation",
    );
  });

  it("V4: stamps an installed null-runtime generation using install's attested generation", async () => {
    const controller = newController("production");
    writePidMetadata("production", { version: "1.8.0", pid: process.pid });
    const stampCalls: (readonly string[])[] = [];
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("stamp-runtime")) {
        stampCalls.push(args);
        return { outcome: "stamped" };
      }
      return {};
    });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        version: "1.8.0",
        runtimeVersion: null,
        installGeneration: "install-command-generation",
        serviceLifecycle: {
          postSwapAction: "restart",
          postSwapError: null,
        },
      },
    });

    const outcome = await controller.installVersion("1.8.0", false);

    expect(outcome.kind).toBe("ok");
    expect(stampCalls).toHaveLength(1);
    const generationIndex = stampCalls[0]?.indexOf(
      "--expected-install-generation",
    );
    if (generationIndex === undefined || generationIndex < 0) {
      throw new Error("stamp-runtime did not receive an expected generation");
    }
    expect(stampCalls[0]?.[generationIndex + 1]).toBe(
      "install-command-generation",
    );
  });

  it("stamps when the newly-applied record is null-runtime, even though the record it replaced was already stamped", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writeStagedRecord("production", "1.8.0", null);
    writePidMetadata("production", { version: "1.8.0", pid: process.pid });
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        outcome: "applied",
        record: { version: "1.8.0", runtimeVersion: null },
        runningActivated: true,
        installGeneration: "gen-1.8.0",
      },
    });

    await controller.applyStaged("manual", false);

    expect(runBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.arrayContaining(["host", "stamp-runtime"]),
    );
  });

  it("does not stamp when the newly-applied record already carries its own runtime stamp", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    writeStagedRecord("production", "1.8.0", "1.8.0");
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: {
        outcome: "applied",
        record: { version: "1.8.0", runtimeVersion: "1.8.0" },
        runningActivated: true,
        installGeneration: "gen-1.8.0",
      },
    });

    await controller.applyStaged("manual", false);

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

// ---------------------------------------------------------------------------
// P12: packaged-macOS activation with a null-runtime record must share its
// one readiness observation with stamp-runtime instead of spending one full
// timeout budget in each step.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Fixup B7: `convergeReadyCliOwned` used to ignore `postSwapError` entirely
// and only wait for readiness on the null-runtime CAS path - a non-throwing
// post-swap start failure returned `ok`/`running:false`, which the IPC layer
// misprojects as `{action:"removed"}` (see `traycerHostEnsure`'s comment:
// `running:false` is otherwise only reachable via the removed-by-user
// short-circuit); an already-stamped service-starting branch reported `ok`
// before the endpoint had actually bound.
// ---------------------------------------------------------------------------
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

    const outcome = await controller.convergeReady(false);

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

    const outcome = await controller.convergeReady(false);

    expect(outcome.kind).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Fixup B8: `classifyEnsureLikeError`'s `HOST_BUSY_CODE` branch used to
// classify `isConvergeReady=true` callers (the only production callers -
// both `convergeReadyCliOwned` and `convergeReadyPackagedMac` pass `true`)
// as a fatal `failed` gate result, so a reconnect/compat `convergeReady`
// while a healthy host had active work showed a fatal error instead of the
// pre-refactor busy-keep outcome (`host-busy`/`running: true`). The
// IPC-layer channel test only ever manufactured a fake `{kind:"busy"}`
// `MutationOutcome` directly on a stub `HostController` - it never actually
// drove a real `E_HOST_BUSY` through this classification. This is that
// missing production-path coverage.
// ---------------------------------------------------------------------------
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

    const outcome = await controller.convergeReady(false);

    expect(outcome).toEqual({
      kind: "busy",
      continuation: "retry-with-force",
      message: expect.stringContaining("work in progress"),
    });
  });
});

// ---------------------------------------------------------------------------
// Windows bundled-host `--from` fallback (fixup A2): on Windows the per-user
// slot CLI is a COPY outside the app bundle (symlinks need elevated
// privilege there), so the CLI's own sibling-archive resolution can't see
// the bundled host archive and would fall back to the registry - which
// publishes no win32 asset for dogfood/unsigned builds. `convergeReadyCliOwned`
// must pass `--from <archive>` explicitly when running on win32 with a
// bundled archive present beside the CLI binary.
// ---------------------------------------------------------------------------
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

    await controller.convergeReady(false);

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

    await controller.convergeReady(false);

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

    await controller.convergeReady(false);

    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["host", "ensure"] }),
    );
  });

  it("V7: omits --from when a valid bundled CLI has no sibling archive", async () => {
    setPlatform("win32");
    setArch("x64");
    const cliDir = join(workHome, "cli");
    mkdirSync(cliDir, { recursive: true });
    const bundledCli = join(cliDir, "traycer.exe");
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

    await controller.convergeReady(false);

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

    await controller.convergeReady(false);

    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["host", "ensure"] }),
    );
  });
});

// ---------------------------------------------------------------------------
// applyPendingLoginItemRevisionIfIdle - the production-incident-driven
// pending-LaunchAgent-revision refresh, retargeted here after the deletion
// of `host-ensure-ipc.ts`'s `ensureHost` fast path (the same login-item
// register/quarantine choreography, now a controller method instead of an
// IPC handler).
//
// Fixup C3: the comment this replaces claimed the deleted
// `pending-login-item-revision-monitor.test.ts`'s "mutual exclusion with a
// concurrent renderer-triggered ensure" coverage was folded in here - it was
// not. Every collaborator below (`hasUnappliedPendingLoginItemRevision`,
// `registerHostLoginItem`, `readHostLoginItemStatus`, `waitForHostReady`) is
// mocked, and every test drives exactly one caller. The old suite proved
// TWO concurrent callers (the monitor's tick + a renderer-triggered
// `convergeReady`) coalesce onto a single underlying cycle via
// `runEnsureHost`'s own in-flight promise cache. `applyPendingLoginItemRevisionIfIdle`
// has no equivalent coalescing - each caller independently passes the
// pre-lock checks and then serializes on the desktop lock, so two
// concurrent callers run the disruptive SMAppService cycle TWICE, not once
// (confirmed empirically, not from documentation). Flagged to the epic
// parent rather than silently fixed or silently dropped - this is a
// production gap, not a portable test case.
// ---------------------------------------------------------------------------
describe("applyPendingLoginItemRevisionIfIdle", () => {
  it("returns null when the host is not reachable", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    removePidMetadata("production");
    expect(await controller.applyPendingLoginItemRevisionIfIdle()).toBeNull();
    expect(hasUnappliedPendingLoginItemRevision).not.toHaveBeenCalled();
  });

  it("returns null when there is no pending revision marker", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(false);
    expect(await controller.applyPendingLoginItemRevisionIfIdle()).toBeNull();
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
    expect(await controller.applyPendingLoginItemRevisionIfIdle()).toBeNull();
    expect(registerHostLoginItem).not.toHaveBeenCalled();
  });

  it("pre-flights requires-approval, quarantines, and fails without ever bootout-ing the running host", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(readHostLoginItemStatus).mockReturnValue("requires-approval");

    const outcome = await controller.applyPendingLoginItemRevisionIfIdle();
    expect(outcome).toBeNull();
    expect(registerHostLoginItem).not.toHaveBeenCalled();
    expect(controller.isPendingRevisionRefreshQuarantined()).toBe(true);

    // Quarantined for the rest of the session - a second tick skips even
    // the pre-flight re-read.
    vi.mocked(readHostLoginItemStatus).mockClear();
    expect(await controller.applyPendingLoginItemRevisionIfIdle()).toBeNull();
    expect(readHostLoginItemStatus).not.toHaveBeenCalled();
  });

  // Fixup C3: ported from the deleted `host-ensure-ipc.test.ts` ("throws
  // the approval-required error when the idle refresh cycle ends
  // requires-approval") - distinct from the pre-flight case above: here
  // the login item read as fine BEFORE the cycle, but the register call
  // ITSELF comes back requires-approval (the user revoked approval during
  // the disruptive bootout/reregister window).
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

    const outcome = await controller.applyPendingLoginItemRevisionIfIdle();

    expect(outcome).toEqual({
      kind: "failed",
      message: expect.stringContaining("disabled by macOS"),
    });
    expect(controller.isPendingRevisionRefreshQuarantined()).toBe(true);
    expect(waitForHostReady).not.toHaveBeenCalled();
  });

  // Field RCA 2026-07-28: this cycle's leading bootout had just torn down a
  // verified-idle host when SMAppService answered `not-found` for every
  // subsequent call in the session - the old terminal failure stranded the
  // machine with nothing running AND nothing registered. The refresh must
  // restore service via the CLI-owned LaunchAgent (which bypasses
  // SMAppService/BTM), keep the quarantine so this session never re-runs
  // the doomed cycle, and leave the marker for the next launch's fresh
  // SMAppService session.
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

    const outcome = await controller.applyPendingLoginItemRevisionIfIdle();

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

    // The register cycle's leading step is a bootout - that failed attempt
    // already killed the running host once. A later attempt (e.g. the
    // monitor's next 30s tick) must not run the disruptive cycle again for
    // the same terminal outcome.
    const second = await controller.applyPendingLoginItemRevisionIfIdle();
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

    const outcome = await controller.applyPendingLoginItemRevisionIfIdle();

    expect(outcome).toEqual({
      kind: "failed",
      message: expect.stringContaining("status=not-found"),
    });
    if (outcome !== null && outcome.kind === "failed") {
      expect(outcome.message).toContain("takeover exploded");
      expect(outcome.message).toContain("service uninstall");
    }
    expect(controller.isPendingRevisionRefreshQuarantined()).toBe(true);
  });

  // Fixup C3: ported from the deleted `host-ensure-ipc.test.ts` ("throws
  // the reachability-timeout error when waitForHostReady times out after
  // an idle refresh"). Contrasts with the case above: a readiness timeout
  // does NOT quarantine - it's a transient condition (the host may still
  // come up), unlike a register status that can only change if the user
  // acts.
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

    const outcome = await controller.applyPendingLoginItemRevisionIfIdle();

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
    const second = await controller.applyPendingLoginItemRevisionIfIdle();
    expect(second?.kind).toBe("ok");
    expect(registerHostLoginItem).toHaveBeenCalledTimes(2);
  });

  // Fixup C3: "deferred-busy + desktop-lock retryability" - two distinct
  // non-terminal busy outcomes, neither of which the old suite pinned:
  // contention on the desktop-held lock itself (a different controller-
  // driven SMAppService section is mid-cycle), and `registerHostLoginItem`'s
  // own revalidation guard reporting the host went busy while queued on the
  // shared registration lock. Both must be silent (no quarantine) and
  // retryable once the transient condition clears.
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

    const outcome = await controller.applyPendingLoginItemRevisionIfIdle();
    expect(outcome).toBeNull();
    expect(controller.isPendingRevisionRefreshQuarantined()).toBe(false);
    expect(registerHostLoginItem).not.toHaveBeenCalled();

    await held.handle.release();
    const second = await controller.applyPendingLoginItemRevisionIfIdle();
    expect(second?.kind).toBe("ok");
  });

  it("registerHostLoginItem's revalidation guard reporting deferred-busy returns null (silent, no quarantine); a later attempt can still succeed", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValueOnce("deferred-busy");
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    const outcome = await controller.applyPendingLoginItemRevisionIfIdle();
    expect(outcome).toBeNull();
    expect(controller.isPendingRevisionRefreshQuarantined()).toBe(false);

    vi.mocked(registerHostLoginItem).mockResolvedValueOnce("enabled");
    const second = await controller.applyPendingLoginItemRevisionIfIdle();
    expect(second).toEqual({
      kind: "ok",
      value: { running: true, version: "1.7.0" },
    });
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

    const outcome = await controller.applyPendingLoginItemRevisionIfIdle();
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

    const outcome = await controller.applyPendingLoginItemRevisionIfIdle();
    expect(outcome).toEqual({
      kind: "ok",
      value: { running: false, version: null },
    });
    expect(controller.isPendingRevisionRefreshQuarantined()).toBe(false);
  });

  // Fixup A4: a terminal bytes-only install (B) landing on disk WHILE this
  // cycle is mid-`registerHostLoginItem` must not have its generation
  // captured and stamped with A's (this cycle's) identity - the record read
  // + generation computation must be pinned to A, captured before the
  // disruptive cycle starts, never re-read from disk after it settles.
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
    // Simulate a terminal bytes-only install (B) completing WHILE this
    // cycle is mid-registerHostLoginItem (called from inside the desktop
    // lock) - the on-disk install record changes out from under this cycle
    // before it returns.
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

    const outcome = await controller.applyPendingLoginItemRevisionIfIdle();
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

  it("convergeReady on packaged macOS opportunistically applies a pending revision when already reachable", async () => {
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

    const outcome = await controller.convergeReady(false);
    expect(outcome).toEqual({
      kind: "ok",
      value: { running: true, version: "1.7.0" },
    });
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
  });

  // Fixup B12 (lock rule 3): same exposure as `registerService` - re-read
  // install state after lock acquisition rather than trusting the pre-lock
  // reachability/busy probes, which can go stale against a concurrent
  // terminal uninstall.
  it("skips the bootout and returns null when the install is absent after lock acquisition", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    // Deliberately no `writeInstallRecord` - the pid.json alone is enough
    // to pass the pre-lock reachability check; the install record vanishing
    // out from under it (a concurrent terminal uninstall) is exactly the
    // race this fixup closes.
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);

    const outcome = await controller.applyPendingLoginItemRevisionIfIdle();

    expect(outcome).toBeNull();
    expect(registerHostLoginItem).not.toHaveBeenCalled();
  });

  // Fixup B15: this cycle used to be entirely invisible to
  // `awaitMutationLaneIdle` (the quit-time drain) when triggered standalone
  // (the pending-login-item-revision monitor's poll loop calls this
  // directly, never through `enqueueMutation`) - a quit during the cycle
  // could tear down Electron mid-SMAppService-swap.
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

    const refreshPromise = controller.applyPendingLoginItemRevisionIfIdle();
    // Real fs reads precede the disruptive step (readRunningRuntimeVersion,
    // probeHostBusyVerdict, the lock acquisition, readRunningHostIdentity,
    // readDesktopHostInstallRecord) - poll rather than a fixed microtask
    // flush so this doesn't race those.
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

    const refresh = controller.applyPendingLoginItemRevisionIfIdle();
    await flushMicrotasks();

    expect(await controller.awaitMutationLaneIdle(20)).toBe(false);

    reachabilityGate.resolve(false);
    await refresh;
    expect(await controller.awaitMutationLaneIdle(20)).toBe(true);
  });

  // Fixup D1: two concurrent callers (the monitor's standalone tick and a
  // reentrant call from `convergeReadyPackagedMac`) used to each pass every
  // pre-check independently and run their own disruptive SMAppService
  // bootout+reregister - confirmed empirically in Batch C via this exact
  // scenario (`registerHostLoginItem` called twice). The in-flight
  // coalescing gate now makes the second caller join the first's result
  // instead of starting its own cycle.
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
      controller.applyPendingLoginItemRevisionIfIdle(),
      controller.applyPendingLoginItemRevisionIfIdle(),
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
    const third = await controller.applyPendingLoginItemRevisionIfIdle();
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
    const monitorTick = controller.applyPendingLoginItemRevisionIfIdle();
    await vi.waitFor(() => {
      if (!registerCalled) throw new Error("revision cycle did not start");
    });
    const convergence = controller.convergeReady(false);
    await vi.waitFor(() => {
      // A reachability probe is only an earlier asynchronous prerequisite.
      // Wait for the real production join edge: the reentrant caller has
      // invoked the public coalescing method, which synchronously observes
      // the in-flight slot before its first await. Releasing the register
      // gate earlier could turn this into two serial cycles instead.
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

  // Fixup D1 defense-in-depth: the locked closure now re-checks the pending-
  // revision marker itself after acquisition, not just the install record
  // (B12). This proves that reread independent of the coalescing gate above -
  // by the time the lock is acquired, the marker is gone even though the
  // pre-lock check (mocked here, so it can't see the file the marker itself
  // would live at) still reported it as pending.
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

    const outcome = await controller.applyPendingLoginItemRevisionIfIdle();

    expect(outcome).toBeNull();
    expect(registerHostLoginItem).not.toHaveBeenCalled();
    expect(hasPendingCallCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Fixup B14: `respawn()` used to ignore the removed-by-user sentinel (a
// terminal `Remove Traycer` that persisted the sentinel but then
// failed/was interrupted mid-uninstall can leave bytes behind - Restart
// must not resurrect them), and `notifyRespawning()` cleared the
// renderer-facing snapshot BEFORE the disruptive cycle's own lock-
// acquisition/busy gates resolved - a lock-busy/failed attempt never
// actually touched the host, so without healing, a healthy host stayed
// surfaced as gone with no future pid-file edge to correct it.
// ---------------------------------------------------------------------------
describe("respawn (fixup B14)", () => {
  it("defers rather than restarting when the host was removed by the user", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    await markHostRemovedByUser();

    const outcome = await controller.respawn();

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

    const outcome = await controller.respawn();

    expect(outcome.kind).toBe("deferred");
    expect(lifecycle.reloadSnapshotFromDisk).toHaveBeenCalled();
    // Fixup C2: `notifyRespawningCalls` was instrumented specifically to
    // observe this - `notifyRespawning()` clearing the renderer snapshot
    // BEFORE the busy gate resolves is the exact behavior this test's own
    // header comment describes - but nothing ever read it.
    expect(lifecycle.notifyRespawningCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fixup C2: `newControllerWithLockTiming` builds its `HostController` with a
// `fakeHostLifecycle()` constructed inline and immediately discarded - every
// test that goes through `newController`/`newControllerWithReachability` has
// no way to observe `ensureWatcherInstalled`/`reloadSnapshotFromDisk`, so the
// suite passed with those calls removed entirely. B14 (above) already proves
// the lane is wired for the busy/"heals without restarting" path; these
// prove it for a genuine success on each of the two platform families -
// CLI-owned (`convergeReadyCliOwned`) and packaged-macOS
// (`runLockedMacActivationCycle`, the single cycle shared by every
// packaged-mac mutation per fixup B3) - using the same direct-construction
// pattern as B14 to keep a live reference to the fake.
// ---------------------------------------------------------------------------
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

    const outcome = await controller.convergeReady(false);

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

  it("Class B: a null post-ensure reload prevents CLI convergence from reporting running", async () => {
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
      data: { action: "noop", version: "1.7.0", runtimeVersion: "1.7.0" },
    });

    await expect(controller.convergeReady(false)).resolves.toMatchObject({
      kind: "failed",
      message: expect.stringContaining("became unavailable"),
    });
  });

  it("Class B: packaged-mac convergence refuses its post-activation branch when the live runtime disappears", async () => {
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
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { action: "installed", version: "1.7.0", runtimeVersion: "1.7.0" },
    });
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    await expect(controller.convergeReady(false)).resolves.toMatchObject({
      kind: "failed",
      message: expect.stringContaining("became unavailable"),
    });
  });

  it("Class B: a pending LaunchAgent revision does not report running when its publication reload demotes", async () => {
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
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasUnappliedPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    });

    await expect(
      controller.applyPendingLoginItemRevisionIfIdle(),
    ).resolves.toMatchObject({
      kind: "failed",
      message: expect.stringContaining("became unavailable"),
    });
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

// `completeServiceStart` owns the one post-start publication reload. These
// four CLI-owned callers used to repeat that reload and ignore its nullable
// result, creating a second, unguarded success path. Keep the assertion at
// each public entry point: reintroducing the vestigial caller reload makes
// exactly that caller's test fail instead of relying on the helper in
// isolation.
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

  it("respawn performs only completeServiceStart's publication reload", async () => {
    const lifecycle = fakeHostLifecycle();
    const controller = newControllerWithLifecycle(lifecycle, async () => true);
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    configureRestartAndStamp();

    await expect(controller.respawn()).resolves.toMatchObject({
      kind: "ok",
      value: { activated: true },
    });
    expect(lifecycle.reloadSnapshotFromDisk).toHaveBeenCalledTimes(1);
  });

  it("recoverIfDown performs only completeServiceStart's publication reload", async () => {
    const lifecycle = fakeHostLifecycle();
    const controller = newControllerWithLifecycle(lifecycle, async () => false);
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    configureRestartAndStamp();

    await expect(controller.recoverIfDown()).resolves.toMatchObject({
      kind: "ok",
      value: { activated: true },
    });
    expect(lifecycle.reloadSnapshotFromDisk).toHaveBeenCalledTimes(1);
  });

  it("freePortAndRestart performs only completeServiceStart's publication reload", async () => {
    const lifecycle = fakeHostLifecycle();
    const controller = newControllerWithLifecycle(lifecycle, async () => true);
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    configureRestartAndStamp();

    await expect(
      controller.freePortAndRestart(null, null),
    ).resolves.toMatchObject({
      kind: "ok",
      value: { activated: true },
    });
    expect(lifecycle.reloadSnapshotFromDisk).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// recoverIfDown: head-of-lane suppression (no double-restart), and the busy/
// deferred/failed lock-contention outcome classes.
// ---------------------------------------------------------------------------
describe("recoverIfDown", () => {
  it("suppresses when a mutation already owns the host, checked before submission", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    const gate = deferred<{ data: unknown }>();
    vi.mocked(streamBundledTraycerCliJson).mockReturnValueOnce(gate.promise);

    const respawnPromise = controller.respawn();
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

  // Fixup A3: `readRunningRuntimeVersion` used to be a structural pid.json
  // parse only - a stale-but-well-formed file (the process behind it wedged
  // or its endpoint stopped answering, without pid.json itself being
  // rewritten) read as "running" and `recoverIfDown` silently skipped the
  // restart, reporting success while the host stayed dead. The pid here IS
  // genuinely alive (`process.pid`) - only the endpoint probe reports
  // unreachable - so a correct implementation must still restart.
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
      expect.objectContaining({ args: ["host", "restart"] }),
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

  // `recoverIfDown`/`respawn` always run the unconditional `host restart`
  // (never `--if-idle`), which never busy-checks CLI-side - so `E_HOST_BUSY`
  // genuinely cannot come back from that call, and there is no dedicated
  // classification for it here (any other CLI error just maps to `failed`).
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

  // Fixup B10: `recoverIfDown` drives its own restart, so it must stamp
  // immediately after its own readiness observation using the attested
  // pre-cycle generation - it used to restart and report `activated: true`
  // unconditionally, leaving a null-runtime record's debt unresolved even
  // though this very cycle just re-started the host.
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

// ---------------------------------------------------------------------------
// Fixup B10: `freePortAndRestart`'s CLI-owned branch has the identical gap
// as `recoverIfDown` above - it drives its own restart and must stamp
// immediately after its own readiness observation.
// ---------------------------------------------------------------------------
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

    const outcome = await controller.freePortAndRestart(null, null);

    expect(outcome.kind).toBe("ok");
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["host", "free-port-and-restart"] }),
    );
    expect(runBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.arrayContaining(["host", "stamp-runtime"]),
    );
  });
});

// ---------------------------------------------------------------------------
// Closing A2: these are the five Desktop production edges that start or
// cycle a CLI-owned service. The command returns the record it observed
// while holding cli-lock; each caller must feed THAT generation to the CAS,
// never derive one from its pre-lock Desktop disk read.
// ---------------------------------------------------------------------------
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

    expect((await controller.registerService()).kind).toBe("ok");
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

    expect((await controller.registerService()).kind).toBe("ok");
    expect(waitForHostReady).toHaveBeenCalledWith(
      expect.any(Number),
      getHostFsLayout("production").pidMetadataFile,
      expect.any(Number),
      null,
    );
  });

  it("respawn stamps the restart command's attested generation", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    configureStampAndServiceAttestation();

    expect((await controller.respawn()).kind).toBe("ok");
    expectCommandGenerationWasStamped();
  });

  it("recoverIfDown stamps the restart command's attested generation", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    configureStampAndServiceAttestation();

    expect((await controller.recoverIfDown()).kind).toBe("ok");
    expectCommandGenerationWasStamped();
  });

  it("freePortAndRestart stamps its command's attested generation", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    configureStampAndServiceAttestation();

    expect((await controller.freePortAndRestart(null, null)).kind).toBe("ok");
    expectCommandGenerationWasStamped();
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

    const outcome = await controller.registerService();

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

    const outcome = await controller.registerService();

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

    const outcome = await controller.registerService();

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

    expect((await convergeController.convergeReady(false)).kind).toBe("failed");
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

// ---------------------------------------------------------------------------
// Pins (CLI-owned platforms): the ticket's own worked example - a busy pin
// pre-stop maps to `continuation: "retry-with-force"`, and Force re-submits
// `installVersion{force}` and succeeds.
// ---------------------------------------------------------------------------
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
    const respawnOutcome = await controller.respawn();
    expect(respawnOutcome.kind).toBe("ok");

    // Fixup C2: the title's own claim - "no durable pending-pin state" -
    // was never actually exercised against the SAME pin; an unrelated
    // intent succeeding doesn't prove that. Re-submit the identical pin and
    // confirm it genuinely re-executes against the CLI rather than
    // resolving from (or being blocked by) stale coalescing state left over
    // from the earlier busy attempt.
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValueOnce({
      data: { version: "1.8.0", installGeneration: null },
    });
    const retryOutcome = await controller.installVersion("1.8.0", false);
    expect(retryOutcome.kind).toBe("ok");
    expect(streamBundledTraycerCliJson).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Bounded auto-retry: a readiness timeout after a COMPLETED register cycle
// re-runs the full activation cycle exactly once before surfacing the gate
// card. The register cycle is itself the repair (bootout + re-register), so
// this is the machine clicking its own Retry button - bounded at one so a
// genuinely broken host still surfaces a card instead of churning
// disruptive SMAppService cycles forever. `requires-approval` never
// auto-retries: only the user can act there.
// ---------------------------------------------------------------------------
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

    const outcome = await controller.respawn();

    expect(outcome.kind).toBe("ok");
    // The retry is a FULL cycle - a second register, not a second wait on
    // the failed cycle's corpse.
    expect(waitForHostReady).toHaveBeenCalledTimes(2);
    expect(registerHostLoginItem).toHaveBeenCalledTimes(2);
  });

  it("stays bounded: a second timeout surfaces the gate card carrying the readiness reason", async () => {
    const controller = stagePackagedMacWorld();
    vi.mocked(waitForHostReady).mockResolvedValue(NOT_READY);

    const outcome = await controller.respawn();

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toContain("pid metadata never appeared");
    }
    expect(waitForHostReady).toHaveBeenCalledTimes(2);
  });

  /*
   * The deadline is not proof of failure. A host that binds its endpoint just
   * after `HOST_READY_TIMEOUT_MS` expires is up and serving, and the retry
   * leads with `registerHostLoginItem`'s bootout - so retrying regardless
   * KILLS the recovery this code was waiting for and holds the caller's
   * mutation lane for another full timeout before anything surfaces.
   *
   * The evidence has to be a DIFFERENT process, though: this cycle just
   * booted a host out, and one that outlived its own eviction is reachable
   * too. Accepting that would report an activation that never happened, which
   * is worse than the wasted cycle because it is silent. Both rows below
   * exist because a guard that only checked reachability would pass the first
   * and fail the second.
   */
  it("accepts a host that came up late instead of cycling it again", async () => {
    const controller = stagePackagedMacWorld();
    // The host binds just AFTER the deadline: the wait reports not-ready, and
    // by the time the retry decision is taken pid.json names a new process.
    // Written as a side effect of the wait because the ordering is the whole
    // point - staging the new pid up front would make it the cycle's `prePid`
    // and the guard would (correctly) reject it.
    //
    // `process.ppid` is a different, genuinely live pid;
    // `isPublishedHostEndpointReachable` probes real liveness, so a synthetic
    // number would read as dead and the row would prove nothing.
    vi.mocked(waitForHostReady).mockImplementation(async () => {
      writePidMetadata("production", { version: "1.7.0", pid: process.ppid });
      return NOT_READY;
    });

    const outcome = await controller.respawn();

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

    const outcome = await controller.respawn();

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

    const outcome = await controller.respawn();

    expect(outcome.kind).toBe("failed");
    expect(waitForHostReady).toHaveBeenCalledTimes(1);
  });
});

// Field RCA 2026-07-28 (`make install-desktop-production`, ad-hoc build):
// SMAppService answered `not-found` for a byte-correct in-bundle plist for
// the remainder of the app process's life, AFTER the register cycle's own
// bootout had already torn down the loaded agent. Every same-session retry
// (S8 auto-retry, the monitor, the gate card's Retry button) re-ran the
// same doomed SMAppService call, so the user was locked out with no
// recovery affordance. These rows pin the escalation: a register failure
// hands off to the CLI-owned raw LaunchAgent (`host service install
// --takeover`), which does not go through SMAppService/BTM at all.
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
    // The fallback's readiness check keeps the normal version-equality
    // guard: the recovered host must publish the runtime the committed
    // installation expects (the beforeEach default reports 1.0.0, which
    // this world would rightly reject).
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

    const outcome = await controller.respawn();

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

    const outcome = await controller.respawn();

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toContain("status=not-found");
      expect(outcome.message).toContain("takeover exploded");
      expect(outcome.message).toContain("service uninstall");
    }
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
  });

  // Field RCA 2026-07-28: the very restart that exercised this fallback in
  // the field hit a live host that denied the takeover's shutdown claim
  // (E_HOST_BUSY) - a self-recovering state (the retry 14s later
  // succeeded), yet it surfaced as a `failed` outcome and therefore a
  // reportable "Couldn't restart host" error toast. The denial must
  // resolve `deferred` so restart surfaces present it as information.
  it("activation cycle: a takeover denied by a busy host is deferred - retry-later information, not a reportable failure", async () => {
    const controller = stagePackagedMacWorld();
    vi.mocked(registerHostLoginItem).mockResolvedValue("not-found");
    vi.mocked(streamBundledTraycerCliJson).mockRejectedValue(
      new TraycerCliError(
        "E_HOST_BUSY",
        "service install --takeover: the running host has work in progress and denied the shutdown claim; retry once the work completes.",
      ),
    );

    const outcome = await controller.respawn();

    expect(outcome.kind).toBe("deferred");
    if (outcome.kind === "deferred") {
      // User-facing retry copy - not the CLI's takeover jargon, and none
      // of the failure message's escape-hatch instructions.
      expect(outcome.message).toContain("work in progress");
      expect(outcome.message).toContain("Try again");
      expect(outcome.message).not.toContain("service uninstall");
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

    const outcome = await controller.respawn();

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toContain("status=not-registered");
      expect(outcome.message).toContain("pid metadata never appeared");
    }
  });

  it("registerService: register not-found recovers via the CLI takeover and reports registered", async () => {
    const controller = stagePackagedMacWorld();
    vi.mocked(registerHostLoginItem).mockResolvedValue("not-found");

    const outcome = await controller.registerService();

    expect(outcome).toEqual({ kind: "ok", value: { registered: true } });
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({ args: TAKEOVER_ARGV }),
    );
  });

  it("requires-approval NEVER escalates to the takeover - the toggle is the user's alone", async () => {
    const controller = stagePackagedMacWorld();
    vi.mocked(registerHostLoginItem).mockResolvedValue("requires-approval");
    // `requires-approval` still means the plist is registered, so the cycle
    // waits for readiness; only when the host does NOT come up does the
    // approval failure surface. A ready host here would be a legitimate
    // success and prove nothing about the escalation gate.
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

    const respawnOutcome = await controller.respawn();
    const registerOutcome = await controller.registerService();

    expect(respawnOutcome.kind).toBe("failed");
    expect(registerOutcome.kind).toBe("failed");
    // Guards against a vacuous pass: the pre-bootout `requires-approval`
    // preflight must not have short-circuited before either cycle actually
    // reached registration - otherwise "failed" and no takeover would hold
    // trivially without exercising the escalation gate at all.
    expect(registerHostLoginItem).toHaveBeenCalledTimes(2);
    expect(runBundledTraycerCliJson).not.toHaveBeenCalledWith(TAKEOVER_ARGV);
  });

  it("removed-by-user NEVER escalates to the takeover - reinstalling the service would defy the removal", async () => {
    const controller = stagePackagedMacWorld();
    // The register cycle's own in-lock re-check found the removal sentinel
    // (persisted mid-cycle by an in-app uninstall) - the fallback would
    // resurrect the exact registration the user just removed.
    vi.mocked(registerHostLoginItem).mockResolvedValue("removed-by-user");

    const outcome = await controller.respawn();

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toBe(HOST_REMOVED_BY_USER_MESSAGE);
    }
    expect(runBundledTraycerCliJson).not.toHaveBeenCalledWith(TAKEOVER_ARGV);
  });
});

// Fixup E: `mutationEpoch` ownership. `streamBundled` captures
// `(mutationEpoch, mutationStatus !== null)` at spawn time, and only
// publishes a progress event through `setMutationProgress` when BOTH the
// spawning call was inside the mutation lane AND the epoch is still the one
// captured at spawn. `enqueueMutation` bumps the epoch at mutation start and
// end. Two things must hold:
//   (1) a `streamBundled` call made while NO mutation is active (e.g. the
//       `applyPendingLoginItemRevisionIfIdle` takeover recovery path, which
//       deliberately runs outside `enqueueMutation`) must never alter an
//       unrelated mutation's published progress, even if that mutation
//       starts and is still active when the out-of-lane call's progress
//       events arrive.
//   (2) a normal in-lane call still publishes its progress exactly as
//       before.
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
    // A plain `let` reassigned only inside the mock's closure loses its
    // narrowed (non-null) type at every read in this outer scope - TS's
    // control-flow analysis does not trace assignments made from inside a
    // nested function expression. Holding it as an object property sidesteps
    // that: property narrowing is re-evaluated from each guard, not frozen
    // to the variable's initializer.
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

    // `applyPendingLoginItemRevisionIfIdle` runs OUTSIDE `enqueueMutation` -
    // no mutation is active when its takeover call spawns, so `streamBundled`
    // captures `spawnedInLane = false`.
    const refreshPromise = controller.applyPendingLoginItemRevisionIfIdle();
    await vi.waitFor(() => {
      if (takeoverEvents.onEvent === null) {
        throw new Error("takeover streamBundled call not reached yet");
      }
    });

    // A completely unrelated mutation starts while the out-of-lane takeover
    // call above is still in flight - `respawn`'s own restart call is gated
    // too, so its mutation stays active for the assertion below.
    const respawnPromise = controller.respawn();
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

    const outcome = await controller.respawn();
    unsubscribe();

    expect(outcome.kind).toBe("ok");
    expect(progresses).toEqual([
      expect.objectContaining({ stage: "restart", percent: 10 }),
    ]);
  });
});

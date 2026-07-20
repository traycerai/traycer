import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  hasPendingLoginItemRevision: vi.fn(async () => false),
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
      reason: "ready",
    })),
  };
});

vi.mock("@traycer-clients/shared/host-client/host-activity-probe", () => ({
  probeHostActivityBusy: vi.fn(async () => false),
}));

import {
  runBundledTraycerCliJson,
  streamBundledTraycerCliJson,
  TraycerCliError,
} from "../../cli/traycer-cli";
import {
  hasPendingLoginItemRevision,
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
import { getHostFsLayout, cliLockPath } from "../host-paths";
import { acquireDesktopCliLock } from "../desktop-cli-lock";
import {
  __resetHostRemovalStateForTest,
  isHostRemovedByUser,
  markHostRemovedByUser,
} from "../host-removal-state";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-host-controller-"));
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  // `withDesktopCliLock`'s `open(path, "wx", ...)` needs the lock file's
  // parent directory to already exist (production always has it - the CLI
  // slot setup creates it early); a fresh temp HOME does not.
  mkdirSync(join(workHome, ".traycer", "cli"), { recursive: true });
  // `host-removal-state.ts`'s in-memory cache + memoized store handle are
  // module-level and would otherwise leak the previous test's sentinel
  // value across this test's fresh temp userData dir.
  __resetHostRemovalStateForTest();
  vi.mocked(hostManagesHostLoginItem).mockResolvedValue(false);
  vi.mocked(runBundledTraycerCliJson).mockResolvedValue({});
  vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({ data: {} });
  vi.mocked(waitForHostReady).mockResolvedValue({
    ready: true,
    version: "1.0.0",
    pid: 1,
    reason: "ready",
  });
  vi.mocked(hasPendingLoginItemRevision).mockResolvedValue(false);
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
    reloadSnapshotFromDisk: vi.fn(async () => null),
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
    JSON.stringify({ version, runtimeVersion }),
  );
}

function writePidMetadata(
  environment: "production" | "dev",
  fields: {
    readonly version: string;
    readonly pid: number;
    readonly websocketUrl?: string;
    readonly startedAt?: string;
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
      startedAt: fields.startedAt ?? "2026-01-01T00:00:00.000Z",
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

    await controller.stageLatest();
    // Mutation lane still owns the host - no download call was made yet.
    expect(downloadCalls).toHaveLength(0);

    mutationGate.resolve({ data: { activated: true } });
    await respawnPromise;
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
    let ensureCalled = false;
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        return availableSnapshotFixture("1.8.0", ["1.8.0"]);
      }
      return {};
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) {
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
    await flushMicrotasks();

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
    let ensureCalled = false;
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        return availableSnapshotFixture("1.8.0", ["1.8.0"]);
      }
      return {};
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) {
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
    await flushMicrotasks();

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
// Desktop-held cli-lock sections (Tech Plan "cli-lock" rule 3): the SAME
// file-lock protocol the CLI itself uses, so a real cross-process CLI
// mutation and a desktop-driven SMAppService cycle exclude each other.
// ---------------------------------------------------------------------------
describe("desktop-held cli-lock: two-process test", () => {
  it("a packaged-macOS registerService call blocks on a lock genuinely held by a separate OS process, then proceeds once it releases", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });

    const lockPath = cliLockPath("production");
    mkdirSync(join(workHome, ".traycer", "cli"), { recursive: true });
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

    let registerSettled = false;
    const registerPromise = controller.registerService().then((outcome) => {
      registerSettled = true;
      return outcome;
    });
    // Give the controller's own lock-acquisition poll a few cycles to run
    // against the worker's still-held lock.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(registerSettled).toBe(false);

    writeFileSync(join(barrierDir, "release"), "");
    const outcome = await registerPromise;
    expect(outcome.kind).toBe("ok");
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);

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
      return {};
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
// Fixup B3: lock-contention terminal contract has 3 outcome classes, not the
// single "deferred" `runLockedMacActivationCycle` used to hardcode
// regardless of caller - manual intents (`respawn`, above) resolve
// "deferred"; `convergeReady` must resolve "failed" + a Retry-worded message
// (the renderer's gate UI), because it is reached from the live "connecting
// to host" gate, not a background/manual surface that can just wait quietly.
// The bug: `convergeReadyPackagedMac`'s OWN activation cycle (reached after
// its `ensure` CLI call, not the ensure call itself) fed the shared
// `runLockedMacActivationCycle` helper the same hardcoded `false` every
// other caller used, so lock contention hit during THIS phase surfaced the
// manual "deferred" message on the gate instead of "failed" + Retry.
// ---------------------------------------------------------------------------
describe("lock-contention terminal contract: convergeReady classifies busy as failed+Retry (fixup B3)", () => {
  it("convergeReady on packaged macOS resolves failed+Retry (not deferred) when the desktop lock is held during the activation cycle", async () => {
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

    expect(outcome).toMatchObject({
      kind: "failed",
      message: expect.stringContaining("Retry"),
    });
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
      if (opts.args.includes("restart")) return { data: { activated: true } };
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

    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        return availableSnapshotFixture("1.8.0", ["1.8.0"]);
      }
      return {};
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

    const outcome = await controller.installVersion("1.8.0", true);

    expect(outcome.kind).toBe("ok");
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
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
    expect(streamBundledTraycerCliJson).not.toHaveBeenCalled();
    expect(runBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.arrayContaining(["host", "service", "install"]),
    );
    expect(registerHostLoginItem).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("enabled");
    const macController = newController("production");
    await macController.registerService();
    expect(runBundledTraycerCliJson).not.toHaveBeenCalled();
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
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
    expect(runBundledTraycerCliJson).toHaveBeenCalledWith([
      "host",
      "service",
      "install",
      "--allow-self-invocation",
    ]);
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

  it("removeTraycer aborts an in-flight download's AbortController (no resurrection: the download lane's own removed-by-user gate then blocks any further staging)", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    const downloadGate = deferred<unknown>();
    let observedAbortedBeforeSettle = false;
    vi.mocked(runBundledTraycerCliJson).mockImplementation(async (args) => {
      if (args.includes("available")) {
        return availableSnapshotFixture("1.8.0", ["1.8.0"]);
      }
      return { removedInstallDir: true, serviceUninstalled: true };
    });
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) {
        await downloadGate.promise;
        return { data: {} };
      }
      return { data: {} };
    });

    const stagePromise = controller.stageLatest();
    await flushMicrotasks();

    await controller.removeTraycer();
    // The removal itself completed without waiting for the download.
    expect(await isHostRemovedByUser()).toBe(true);

    downloadGate.resolve(undefined);
    await stagePromise;

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
    void observedAbortedBeforeSettle;
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
// pending-LaunchAgent-revision refresh. Retargeted here after
// `host-ensure-ipc.ts`'s deletion folded its "mutual exclusion with a
// concurrent renderer-triggered ensure" coverage in (Ticket instruction:
// "keep the integration-style coverage, retargeted at the controller").
// ---------------------------------------------------------------------------
describe("applyPendingLoginItemRevisionIfIdle", () => {
  it("returns null when the host is not reachable", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    removePidMetadata("production");
    expect(await controller.applyPendingLoginItemRevisionIfIdle()).toBeNull();
    expect(hasPendingLoginItemRevision).not.toHaveBeenCalled();
  });

  it("returns null when there is no pending revision marker", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasPendingLoginItemRevision).mockResolvedValue(false);
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
    vi.mocked(hasPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(probeHostActivityBusy).mockResolvedValue(true);
    expect(await controller.applyPendingLoginItemRevisionIfIdle()).toBeNull();
    expect(registerHostLoginItem).not.toHaveBeenCalled();
  });

  it("pre-flights requires-approval, quarantines, and fails without ever bootout-ing the running host", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasPendingLoginItemRevision).mockResolvedValue(true);
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

  it("idle + pending revision: runs the locked register cycle and returns ok with the refreshed identity", async () => {
    vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    writePidMetadata("production", { version: "1.7.0", pid: process.pid });
    vi.mocked(hasPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("enabled");
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
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
    vi.mocked(hasPendingLoginItemRevision).mockResolvedValue(true);
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
    vi.mocked(hasPendingLoginItemRevision).mockResolvedValue(true);
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
    vi.mocked(hasPendingLoginItemRevision).mockResolvedValue(true);
    vi.mocked(registerHostLoginItem).mockResolvedValue("enabled");
    vi.mocked(waitForHostReady).mockResolvedValue({
      ready: true,
      version: "1.7.0",
      pid: process.pid,
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
    vi.mocked(hasPendingLoginItemRevision).mockResolvedValue(true);

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
    vi.mocked(hasPendingLoginItemRevision).mockResolvedValue(true);
    const registerGate = deferred<"enabled">();
    let registerCalled = false;
    vi.mocked(registerHostLoginItem).mockImplementation(async () => {
      registerCalled = true;
      return registerGate.promise;
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
      data: { activated: true },
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
      data: { activated: true },
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
      data: { activated: true },
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
  });
});

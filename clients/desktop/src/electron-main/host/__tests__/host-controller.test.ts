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

// Mirrors exactly what production imports from this module across
// `host-controller.ts` (`hasUnappliedPendingLoginItemRevision`,
// `hostManagesHostLoginItem`, `readHostLoginItemStatus`) and, indirectly,
// `update-mutation.ts` (`registerHostLoginItem`,
// `retireCompetingCliRegistrationAtLaunchGuarded`,
// `unregisterHostLoginItemGuarded`) - the wrapped final actuators
// `host-controller.ts` now calls through instead of the raw functions
// directly. A mock missing one of these is not "smaller coverage", it is a
// `TypeError` the moment the real code path is reached (see the
// `removeTraycer` incident this replaced).
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

// F3 (routeForceRestartContinuation): the desktop executor cohort ships
// static shadow-disabled, exactly like the CLI's own cohort - mirrors the
// same `vi.importActual` + `mockImplementation` pattern
// `update-executor.test.ts` already uses for `runDesktopActivationSegment`
// (the function this cohort gate actually protects; F3 reaches it through
// `routeForceRestartContinuation`). Defaults to the REAL shipped
// shadow-disabled implementation - forced eligible only inside the specific
// F3 tests that need to reach the continuation arm.
const desktopExecutorCohortMock = vi.hoisted(() => ({
  decide: vi.fn(),
  /**
   * Reinstates the REAL shipped cohort policy as this mock's default.
   *
   * Load-bearing, and it cost a false green to learn why: the factory below
   * installs the real implementation exactly once, but `eligibleDesktopCohort()`
   * overrides it with `mockReturnValue`, and `vi.clearAllMocks()` clears call
   * history WITHOUT restoring implementations. So one test opting into an
   * eligible cohort silently made EVERY later test in this file run under an
   * eligible cohort - including the ones whose whole point is to assert the
   * shipped shadow-disabled default.
   *
   * That leak was invisible while the continuation self-deadlocked, because a
   * deadlocked continuation fell through to the same plain restart the
   * fall-through tests expected. Fixing the deadlock is what exposed it.
   */
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

// F3 (round 5 review, F3 finding): `withMintedAdoption` mints its proof
// through `writeAdoptionProof` - the ONE seam narrow enough to simulate a
// real minting failure (a proof write rejected, e.g. disk pressure) without
// touching `host-controller.ts` or faking the capability-liveness machinery
// itself. Defaults to the REAL shared implementation - every other test in
// this file that reaches `withMintedAdoption` (or the round-5 F10 adoption
// transport suite's own concerns) is unaffected; only the one test that
// explicitly overrides it exercises a simulated failure.
const writeAdoptionProofMock = vi.hoisted(() => ({
  write: vi.fn(),
  restoreShipped: (): void => {},
}));

// F3 terminal-with-diagnostics contract (round 5, item #1): the tombstone
// must be withdrawn BEFORE the record's own `failed` commit lands, not
// merely gone by the time a test reads final state (both orderings produce
// the identical FINAL state, which is exactly why a naive "tombstone is
// absent after respawn() resolves" assertion cannot distinguish them - it
// would stay green even if the order were reversed). This records the real
// call order of the two underlying actuators so the order itself, not just
// the end state, is asserted and ablatable.
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
      controller.respawn({ kind: "background" }),
      controller.applyStaged("manual", false),
      controller.respawn({ kind: "background" }),
    ]);

    expect(maxConcurrentHolders).toBe(1);
    // Fixup C2: the title's own "FIFO order" claim was never checked - only
    // mutual exclusion was. The second `respawn()` coalesces with the first
    // (same key, still in flight). `applyStaged`'s production preflight
    // revalidates the extant stage before consuming it, but that in-lane
    // pass is manifest-only. The one automatic download stays on the
    // independent lane before apply owns the mutation lane.
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

    const respawnPromise = controller.respawn({ kind: "background" });
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

    const convergePromise = controller.convergeReady(false, {
      kind: "background",
    });
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
    // `activateInstalled` also runs `stageLatest`'s registry `available`
    // check through this same CLI subprocess wrapper, so the wrapper is
    // called more than once now. This test's invariant is ORDERING (the
    // stamp-runtime call happens after the desktop lock releases), not the
    // total call count - so only the stamp-runtime-shaped call probes the
    // lock; every other call is a harmless passthrough.
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

    const outcome = await controller.activateInstalled(true);

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
    const outcome = await controller.convergeReady(true, {
      kind: "background",
    });

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

// Ticket 07 §5.2.7 / retention (`isTerminalRetentionExpired`): `getStatus()`'s
// `localAttempt` is the host-DOWN window's only observation, so an aged-out
// terminal record must not resurface a week-old failure as the freshest
// available fact. Direct JSON writes, mirroring `attemptRecordFields` /
// `writeAttemptRecord` in the "F3: routeForceRestartContinuation via respawn"
// describe block below - a terminal record's shape, not the legal
// claim/commit path, is what `readLocalAttemptFacts` reads.
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

  it("keeps revalidating a staged non-canonical prerelease after an opt-out", async () => {
    // The listing question is "would this row be hidden by the default view",
    // which covers every prerelease shape - NOT "is this a canonical RC",
    // which is the narrower question implicit following asks. Narrowing this
    // one would drop the staged row from the listing, read it as yanked, and
    // purge a verified artifact.
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
    // Implicit following: derived from the installed version, nothing
    // persisted. The listing has to be widened for the line's own RCs to be
    // visible at all, and `2.1.0-rc.1` - newer, but another line - is not a
    // candidate at any distance.
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
    // The case `--automatic` cannot reach: `2.0.0` is published but `latest`
    // still points at `1.9.0`, which is a DOWNGRADE for a 2.0.0-line RC.
    // Resolve-then-pin is what makes the line's stable reachable, and taking it
    // is also what ends implicit participation.
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

  it("stages nothing when only another RC line has moved", async () => {
    vi.mocked(prereleaseUpdatesEnabled).mockReturnValue(false);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "2.0.0-rc.1",
      runtimeVersion: "2.0.0-rc.1",
    });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("1.9.0", ["1.9.0", "2.1.0-rc.1"]),
    );
    const downloads: string[] = [];
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) downloads.push(opts.args.join(" "));
      return { data: {} };
    });

    await controller.stageLatest();

    expect(downloads).toEqual([]);
  });

  it("does not escape an abandoned line through the --automatic stable path", async () => {
    // The `2.0.0` line is abandoned and the work shipped as stable `2.1.0`,
    // which `latest` now names. `--automatic` would take it - a jump to a line
    // nobody put this host on - so the automatic path is closed while
    // following. No candidate on the line means no download at all.
    vi.mocked(prereleaseUpdatesEnabled).mockReturnValue(false);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "2.0.0-rc.1",
      runtimeVersion: "2.0.0-rc.1",
    });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("2.1.0", ["1.9.0", "2.1.0"]),
    );
    const downloads: string[] = [];
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) downloads.push(opts.args.join(" "));
      return { data: {} };
    });

    await controller.stageLatest();

    expect(downloads).toEqual([]);
    // `latest` is still reported verbatim - the pointer keeps its meaning, the
    // follower just may not act on it.
    expect((await controller.getStatus()).latestVersion).toBe("2.1.0");
  });

  it("does not refresh an off-line staged build through --automatic while following", async () => {
    // A stage left behind by an earlier explicit opt-in. Its row is still in
    // the widened listing, so it stays eligible to apply - but it must not
    // cause a `--automatic` download that would stage another line's stable.
    vi.mocked(prereleaseUpdatesEnabled).mockReturnValue(false);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "2.0.0-rc.1",
      runtimeVersion: "2.0.0-rc.1",
    });
    writeStagedRecord("production", "2.1.0-rc.1", "2.1.0-rc.1");
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("2.1.0", ["1.9.0", "2.1.0", "2.1.0-rc.1"]),
    );
    const downloads: string[] = [];
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) downloads.push(opts.args.join(" "));
      return { data: {} };
    });

    await controller.stageLatest();

    expect(downloads).toEqual([]);
  });

  it("leaves an unpinned legacy stage alone while following, without attempting a purge", async () => {
    // A legacy (fingerprint-less) stage plus a line with nothing to replace it:
    // the repair must not run `--automatic` (that would stage another line's
    // build), and the reconcile must stop there rather than fall into the purge
    // branch - which needs a fingerprint this stage has never had, and would
    // warn about "registry invalidation" that did not happen, on every pass.
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

  it("keeps taking a newer stable through --automatic on a stable host", async () => {
    // The control for the two above: closing the automatic path is scoped to
    // implicit following. A stable install with no opt-in is unaffected.
    vi.mocked(prereleaseUpdatesEnabled).mockReturnValue(false);
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "2.0.0",
      runtimeVersion: "2.0.0",
    });
    vi.mocked(runBundledTraycerCliJson).mockResolvedValue(
      availableSnapshotFixture("2.1.0", ["2.0.0", "2.1.0"]),
    );
    const downloads: string[] = [];
    vi.mocked(streamBundledTraycerCliJson).mockImplementation(async (opts) => {
      if (opts.args.includes("download")) downloads.push(opts.args.join(" "));
      return { data: {} };
    });

    await controller.stageLatest();

    expect(downloads).toEqual(["host download --automatic"]);
  });

  it("drives updateReady from the verified stage alone, with no second registry probe", async () => {
    // The landing banner reads `HostControllerStatus.updateReady` and nothing
    // else - no React-side release lookup. Proving that here means: one
    // `host available` call for the whole reconcile, and a canonical status
    // that reports the pinned stage as ready straight afterwards.
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

    const restart = controller.respawn({ kind: "background" });
    await vi.waitFor(() => {
      // `--force` distinguishes respawn (the explicit force path - the
      // Settings Force-restart offer, tray restart) from the cooperative
      // `["host", "restart"]` that `activateInstalledCliOwned`/`recoverIfDown`
      // send: respawn must skip the shutdown claim the busy host would deny.
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

  // ---- user-repair reprovision intent -------------------------------------
  //
  // These pin the half of a Doctor lifecycle repair that the IPC handler
  // deliberately does NOT do. Both repair routes hand the controller a
  // `user-repair` intent instead of clearing the sentinel and checking
  // identity themselves — the queued one because its wait is unbounded, the
  // watched one because an await between its lane test and its submit would
  // reopen the window the test exists to close.

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

    // Not merely "the sentinel is gone afterwards" — the converge must have
    // actually RUN. A short-circuit would also leave kind "ok".
    expect(await isHostRemovedByUser()).toBe(false);
    expect(streamBundledTraycerCliJson).toHaveBeenCalled();
    expect(outcome.kind).toBe("ok");
  });

  it("a BACKGROUND converge still obeys the removal sentinel", async () => {
    // The other half of the same contract, and the reason the intent exists
    // rather than an unconditional clear: the reconciler and launch
    // convergence must leave a removed host removed.
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    await markHostRemovedByUser();

    const outcome = await controller.convergeReady(false, {
      kind: "background",
    });

    expect(await isHostRemovedByUser()).toBe(true);
    expect(streamBundledTraycerCliJson).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      kind: "ok",
      value: { running: false, version: null },
    });
  });

  it("a user-repair whose guard abandons mutates nothing", async () => {
    // The host was replaced while the repair waited in the lane. Nothing may
    // run — and critically the sentinel must NOT be cleared, since clearing
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

    // `abandoned`, not `failed`: the refusal classification travels in the
    // settled outcome so every coalesced waiter reads the same verdict, and
    // so the Doctor console can render it as "declined" instead of counting
    // it toward its recurrence lock.
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
    // Coalescing is keyed on the intent for this reason: a repair that joined
    // a background converge would inherit its policy and silently skip both
    // the guard and the sentinel clear — the same shape as the pending-login-
    // item bug where the joiner's policy was discarded.
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
    // Two windows submit the identical repair for the same host; the second
    // JOINS the first's in-flight job, so only the first intent's guard ever
    // runs. The refusal must ride the SHARED settled outcome — as the
    // `abandoned` arm — because any state parked with one caller is dead for
    // the other, which would then misread the result as a genuine failure
    // and count it toward the Doctor console's recurrence lock.
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
    // Proves the two really were ONE job — the joiner's own guard never ran.
    expect(secondGuardAsked).toBe(false);
    expect(streamBundledTraycerCliJson).not.toHaveBeenCalled();
  });

  it("a queued user-repair restart asks its guard at the head of the lane and abandons after a host swap", async () => {
    // A restart queues exactly like the reprovisions, so the identity
    // question must be answered when the restart is about to FIRE, not when
    // it was submitted: the host it named can be replaced while it waits
    // behind an install, and a forced restart against the replacement kills
    // sessions nobody asked about.
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
    // The restart itself never ran — the only CLI traffic was the converge
    // that occupied the lane.
    const restartCalls = vi
      .mocked(streamBundledTraycerCliJson)
      .mock.calls.filter((call) => call[0].args.includes("restart"));
    expect(restartCalls).toEqual([]);
  });

  it("a user-repair respawn does not coalesce onto a background respawn", async () => {
    // Same rule as the converge twin: joining the background job would hand
    // the repair that job's guard-free policy. Keyed apart, the user repair
    // runs as its own lane job and its guard is actually consulted.
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
    const background = controller.respawn({ kind: "background" });
    let guardAsked = false;
    const repair = controller.respawn({
      kind: "user-repair",
      targetHostId: "local-host",
      guard: () => {
        guardAsked = true;
        return Promise.resolve({ kind: "abandon", message: "host changed" });
      },
    });

    restartGate.resolve();
    await expect(background).resolves.toEqual({
      kind: "ok",
      value: { activated: true },
    });
    // Had they coalesced, the repair would have resolved the background
    // restart's outcome and never asked.
    await expect(repair).resolves.toEqual({
      kind: "abandoned",
      message: "host changed",
    });
    expect(guardAsked).toBe(true);
  });

  it("a user-repair respawn keeps the removed-by-user deferral and clears nothing", async () => {
    // A restart is NOT a reprovision. Even asked for by a person, it defers
    // on the removal sentinel — only Install host / Register service mean
    // "give me the host back", so only they clear it.
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: "1.7.0",
    });
    await markHostRemovedByUser();

    const outcome = await controller.respawn({
      kind: "user-repair",
      targetHostId: "local-host",
      guard: () => Promise.resolve({ kind: "proceed" }),
    });

    expect(outcome).toEqual({
      kind: "deferred",
      message: HOST_REMOVED_BY_USER_MESSAGE,
    });
    expect(await isHostRemovedByUser()).toBe(true);
    expect(streamBundledTraycerCliJson).not.toHaveBeenCalled();
  });

  it("a respawn admitted after another respawn already restarted answers restarted without a second cycle", async () => {
    // The coalesce key is intent-discriminated, so a watched user repair and
    // a menu/tray background restart for the same slot are DIFFERENT lane
    // jobs — the seam `respawnGeneration` closes. Without it the second
    // forced cycle fires immediately after the first and kills the sessions
    // that just reconnected to the fresh host.
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

    const outcome = await controller.convergeReady(false, {
      kind: "background",
    });

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
    expect(
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane"),
    ).toBeNull();
    expect(hasUnappliedPendingLoginItemRevision).not.toHaveBeenCalled();
  });

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

    const outcome =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");

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

    // The register cycle's leading step is a bootout - that failed attempt
    // already killed the running host once. A later attempt (e.g. the
    // monitor's next 30s tick) must not run the disruptive cycle again for
    // the same terminal outcome.
    const second =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    expect(second).toBeNull();
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
  });

  // Fixed by the T2/T3 author's call-site-enrichment ruling: the classifier
  // may normalize the failure category, but caller-only discriminating
  // evidence must be appended at the presentation boundary - here that's
  // `withTakeoverDiagnostics`, composing the observed SMAppService status and
  // the manual escape hatch onto whatever `classifyMutationSubprocessError`
  // returns, without altering `kind`/`continuation`. Same fix as the
  // identically-shaped test in the `packaged-mac register failure` describe
  // block below - not a second, independent case.
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

    const outcome =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
    expect(outcome).toBeNull();
    expect(controller.isPendingRevisionRefreshQuarantined()).toBe(false);

    vi.mocked(registerHostLoginItem).mockResolvedValueOnce("enabled");
    const second =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
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

    const outcome = await controller.convergeReady(false, {
      kind: "background",
    });
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

    const outcome =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");

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

    const refreshPromise =
      controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
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

    const refresh =
      controller.applyPendingLoginItemRevisionIfIdle("outside-lane");
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

    const outcome =
      await controller.applyPendingLoginItemRevisionIfIdle("outside-lane");

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

    await expect(
      controller.convergeReady(false, { kind: "background" }),
    ).resolves.toMatchObject({
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

    await expect(
      controller.convergeReady(false, { kind: "background" }),
    ).resolves.toMatchObject({
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
      controller.applyPendingLoginItemRevisionIfIdle("outside-lane"),
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
    // Discriminator: without reverse admission the monitor would commit a
    // bootout behind an already-accepted install. The check and the
    // commitment flag share one synchronous stretch, so the block stays
    // `{kind:"mutation"}` rather than flipping to login-item-refresh.
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
    // Probe starts resolved so install can occupy the lane; flipped to a
    // pending promise before the outside tick so that tick parks in
    // `readRunningRuntimeVersion` (the first uncoalesced await) with the
    // D1 slot already populated.
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
    // Discriminator: before the coalescing upgrade, the parked outside tick
    // kept its own `outside-lane` policy, saw the mutation lane the JOINER
    // occupies, and returned null — a cycle refusing because of the caller
    // waiting on it. Red against f705b8eb^ (join returned the in-flight
    // promise as-is).
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

    await expect(
      controller.respawn({ kind: "background" }),
    ).resolves.toMatchObject({
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
      controller.freePortAndRestart(null, null, { kind: "background" }),
    ).resolves.toMatchObject({
      kind: "ok",
      value: { activated: true },
    });
    expect(lifecycle.reloadSnapshotFromDisk).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// F3: `routeForceRestartContinuation()`, reached only through `respawn()` -
// never by calling the private method directly. Returning `null` means "fall
// through to today's byte-identical `host restart --force`"; only a
// completed continuation or a live-executor busy refusal diverge from that.
//
// Mocking boundary for this block specifically: `../update-executor-cohort`
// is forced eligible only where noted (default: real shipped shadow-disabled,
// exactly the production posture). Attempt records are written directly to
// `updateAttemptRecordPath` rather than driven through the transition core -
// `update-executor.test.ts` already exhaustively covers `decideAttemptClaim`
// itself; this suite is testing the ROUTING layer above it.
// ---------------------------------------------------------------------------
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

  // Direct JSON writes suffice for the fall-through cases below (they never
  // reach the commit pipeline), but a record the continuation arm must
  // legally RESUME needs to go through the real claim/commit path -
  // mirrors `update-executor.test.ts`'s `seedParkedAttempt` exactly, against
  // this suite's own real temp layout instead of a bespoke one.
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

  /**
   * Seed a park at `preparing/activate` the way the executor actually reaches
   * it: by a GENUINE resume claim, never by writing the record shape.
   *
   * This is not fixture pedantry, and it is the reason this helper exists
   * instead of one more `advance`. The phase graph rejects a direct
   * `waiting-to-activate -> preparing` advance as `intent-not-legal`, so a
   * fixture that "advances" into `preparing` would be pinning a state the
   * system cannot produce - the invalid-fixture class this epic has already
   * paid for once, when a permissive decoder let `phase: "started"` stand in
   * for coverage.
   *
   * The legal route is the one `runDesktopActivationSegment` itself takes: an
   * identity-bound claim carrying `action: "activate"` resolves to `resume`,
   * and a resume lands in `preparing` carrying `activate`. Driving the same
   * `{kind:"resume"}` intent through `commitAttemptMutationWithCapability`
   * makes the CORE recompute the record from the intent, so this fixture
   * inherits the graph's legality rules rather than sidestepping them.
   *
   * Self-verifying on purpose: if a future graph change stops a resume landing
   * on `preparing/activate`, this throws at seed time instead of quietly
   * handing the tests below a state they were not written for.
   */
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

  /**
   * Do what the real CLI recovery claimant does to an orphaned
   * `preparing/activate`: re-park it at `waiting-to-activate` and report the
   * identity it parked.
   *
   * The re-park is the already-legal `reparkedActivation` edge, so this drives
   * the same transition production takes rather than writing a record shape.
   */
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

  /**
   * An ACTIVE attempt that is NOT an adopted activation continuation: a fresh
   * `create` lands in `applying` carrying `continuation: null`.
   *
   * This is the control's fixture. It reaches the cohort gate through the same
   * route as the trace test - `applying` is in
   * `FORCE_RESTART_CONTINUATION_PHASES`, so the pre-filter admits it - but
   * carries no `activate` continuation, so the gate is consulted and refuses.
   */
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

  /**
   * Stage the bundled CLI ARG-AWARE.
   *
   * `mockResolvedValue` answers EVERY spawn with one shape, which meant the
   * `host update-verify` child got the restart payload
   * (`{restarted, version}`). Under the F1 fix that decodes to
   * `indeterminate`, so a continuation could never report success - the tests
   * were only green while Desktop ignored the verdict entirely.
   */
  function stageCliWithVerification(report: Record<string, unknown>): void {
    stageCliWithVerificationAndRestart(report, {
      restarted: true,
      version: "2.0.0",
    });
  }

  /**
   * Stage the verify verdict AND the generic restart's answer independently.
   *
   * The single-response form above answers `{restarted:true}` for the restart
   * no matter what, which is the overloaded-stub class: it makes every arm
   * look successful regardless of what the real two-command interaction would
   * do. Any test whose subject IS that interaction must state both halves, so
   * that changing the command's answer changes the test's result.
   */
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

  /**
   * Same world, but with NO running host: the reachability probe answers
   * false and no live pid metadata is written.
   *
   * This dimension is load-bearing and was the axis of a disagreement worth
   * recording. At `waiting-to-activate` with the host UP, a refusal strands
   * nothing - the old host keeps serving, which is precisely the state the
   * plan's "Desktop absent after Mac byte placement" park is designed to
   * leave behind. The park is durable; the host process is not, so a crash,
   * a `host stop`, or a reboot AFTER parking reaches host-down while parked.
   * That is where a refusal stops being harmless.
   */
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
    // Formerly seeded `seedParkedActivationAttempt` (an ADOPTED activation
    // continuation) and framed as a cohort seam proof. Ticket 07 plan §7
    // Finding 2 changed what that fixture means: `runDesktopActivationSegment`
    // now SKIPS the cohort gate entirely whenever the durable record already
    // names an adopted `activate` continuation (see
    // `hasAdoptedActivationContinuation` in `update-executor.ts`). Under that
    // fixture the outcome is identical whether the cohort mock is real,
    // eligible, or broken outright, because the gate is never consulted - so
    // it stopped proving anything about the cohort while still passing.
    //
    // `seedActiveAttemptWithoutActivationContinuation` (`applying`,
    // `continuation: null`) is NOT an adopted continuation, so the gate IS
    // consulted for it - this is the fixture that can still tell "real
    // disabled cohort" apart from "forced eligible". It reaches
    // `FORCE_RESTART_CONTINUATION_PHASES` the same way the old fixture did,
    // so the pre-filter still admits it.
    it("SEAM PROOF: under the REAL shipped shadow-disabled cohort, a record with NO adopted activation continuation still falls through to the plain restart", async () => {
      // No `eligibleDesktopCohort()` call here - this uses whatever
      // `../update-executor-cohort` actually resolves to.
      //
      // If a future change silently stopped this test's mock from
      // intercepting, this test would still pass: production's real gate is
      // also shadow-disabled, so "the mock is real and disabled" and "the
      // mock is broken" both reject here before `claim()` ever runs, and both
      // fall through to the same plain restart.
      //
      // What DOES distinguish "real disabled" from "forced eligible" is the
      // CALL SEQUENCE, not the terminal outcome. Forced eligible lets this
      // record past the gate into `claim()`, which refuses an active
      // (non-parked) record with no activation continuation as
      // `requires-recovery` - and `requires-recovery` dispatches the CLI's
      // `update-verify` recovery claimant before ever falling through to the
      // plain restart. Under the real disabled gate, the segment is rejected
      // before `claim()` runs, so that claimant is never dispatched at all.
      // Both paths still converge on `{activated:true}` (the mocked restart
      // answers success either way), so the discriminating assertion below is
      // on whether `update-verify` was called - not on the outcome shape.
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
      // The seam: forcing the cohort eligible would route this same fixture
      // through `requires-recovery` and dispatch `update-verify` first (see
      // the block comment above). The real shipped (shadow-disabled) gate
      // never reaches `claim()` at all, so that call must never happen here.
      expect(streamBundledTraycerCliJson).not.toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(["update-verify"]),
        }),
      );
    });

    // ---- Ticket 07 plan §7 Finding 2 --------------------------------------
    //
    // "The switch stops admitting NEW attempts; it does not abandon an ADOPTED
    // one." These two tests pin that sentence from both sides, and they are a
    // pair on purpose: either one alone is satisfiable by a gate that is
    // simply always-on or always-off.
    //
    // The 6-step stranding they exist for, every step individually correct:
    //
    //   1. an attempt is PARKED with bytes placed and the target host NOT
    //      running - `waiting-to-activate`, which `recoveryActionFor`
    //      classifies `stop-only` exactly as it does `preparing/activate`;
    //   2. the Desktop cohort is disabled (kill switch, or a rollback);
    //   3. Force restart routes to `runDesktopActivationSegment`, which under
    //      the unscoped gate returned `{kind:"rejected", reason:"cohort-disabled"}`;
    //   4. `rejected` matches none of the route's arms, so it fell through;
    //   5. the generic restart carries `--defer-if-parked`, and the CLI
    //      correctly classifies `preparing/activate` as `stop-only` and
    //      REFUSES without stopping;
    //   6. the host was already down, so nothing brought it back. Stranded.
    //
    // Neither test calls `eligibleDesktopCohort()`. The REAL shipped
    // shadow-disabled gate is the premise, restored per-test by
    // `restoreShippedCohort()` in the shared hook.
    it("a cohort DISABLED mid-attempt does not strand an adopted activation - the parked record still advances", async () => {
      const controller = stagePackagedMacRestartWorld(undefined);
      writeOwnedSmAppServiceSubstrate();
      await seedParkedActivationAttempt("2.0.0");
      stageCliWithVerificationAndRestart(
        { outcome: "resumed", continuation: "activate" },
        // What the CLI really answers for a placed-byte `preparing/activate`
        // once `--defer-if-parked` is honoured: it refuses WITHOUT stopping.
        // With the host already down, this is precisely the arm that used to
        // leave the machine with nothing able to bring it back.
        { restarted: false, deferredForParkedActivation: true },
      );
      expect(await currentAttemptPhase()).toBe("waiting-to-activate");

      await controller.respawn({ kind: "background" });

      // The INVARIANT, not the mechanism: the adopted attempt was carried
      // forward rather than refused. Asserting "the cohort gate was skipped"
      // would pin the fix's shape and survive a later change that skipped the
      // gate and then failed to act anyway.
      //
      // Deliberately `not.toBe("preparing")` rather than naming a successor.
      // Whether the segment reaches `restarting` or re-parks at
      // `waiting-to-activate` depends on the drain, and both are the attempt
      // being carried forward. Pinning one of them would make this test fail
      // on a legitimate drain change while proving nothing extra.
      expect(await currentAttemptPhase()).not.toBe("waiting-to-activate");
    });

    // The same invariant with the dimension that makes refusal HARMFUL: no
    // running host. This is the faithful form of the 6-step trace - the test
    // above pins "an adopted continuation is not refused" in general, this one
    // pins it in the state where being refused strands the machine.
    it("HOST DOWN: a cohort DISABLED mid-attempt still advances the adopted activation rather than leaving the machine with nothing running", async () => {
      const controller = stagePackagedMacRestartWorldHostDown();
      writeOwnedSmAppServiceSubstrate();
      await seedParkedActivationAttempt("2.0.0");
      stageCliWithVerificationAndRestart(
        { outcome: "resumed", continuation: "activate" },
        // The CLI's honest answer for a placed-byte park once
        // `--defer-if-parked` is honoured: refuse WITHOUT stopping. With no
        // host running, this is the arm that leaves nothing able to recover.
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
      // `applying` + `continuation: null`. Reaches the gate through the SAME
      // route (`applying` is in `FORCE_RESTART_CONTINUATION_PHASES`), so this
      // control differs from the trace test in exactly one fact: whether the
      // record names an activation continuation.
      await seedActiveAttemptWithoutActivationContinuation("2.0.0");
      stageCliWithVerificationAndRestart(
        { outcome: "resumed", continuation: "activate" },
        { restarted: false, deferredForParkedActivation: true },
      );

      await controller.respawn({ kind: "background" });

      expect(await currentAttemptPhase()).toBe("applying");
    });

    // INVERTED — this was an `it.fails` KNOWN-GAP pin, and the orphan-recovery
    // ruling closed the gap. The pin's whole purpose was to force revisiting
    // when that happened; it is now a real assertion.
    //
    // The gap: an ORPHANED `preparing/activate` is non-parked and non-terminal
    // with the lock free, which `decideAttemptClaim` refuses as
    // `requires-recovery` BY DESIGN - "the pure core refuses rather than
    // guessing a continuation from the phase alone". No cohort scoping could
    // reach it; it was a second, independent cause of the same stranding.
    //
    // The close: Desktop dispatches the CLI recovery claimant, which resumes
    // the orphan and then re-parks it (`preparing/activate ->
    // waiting-to-activate`) before releasing, so an ordinary claim can resume
    // it with no Desktop-minted evidence.
    //
    // The CLI is mocked here, so the mock must do what the real claimant does:
    // actually re-park the record AND report the identity it parked. A mock
    // that only returned the report would prove the decode and nothing about
    // the sequence.
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

      // The INVARIANT: the adopted attempt was carried forward. Asserting a
      // specific phase would be wrong - a resume lands back in `preparing`, so
      // the segment's own progress is not a phase inequality. What cannot
      // happen if the attempt was abandoned is its identity advancing.
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

    // The CONTROL the ruling requires: indeterminate evidence must leave the
    // record UNCHANGED and must not read as success. A recovery route that
    // "resumed" on any answer would satisfy the test above while destroying
    // the one property that makes recovery safe to attempt at all.
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

    // REGRESSION PIN for a real production defect, found by this suite and
    // since FIXED. Keeping the history because the mechanism is subtle and the
    // fix is easy to undo by accident.
    //
    // The defect: `routeForceRestartContinuation`'s `activate` callback ignored
    // the `capability` it was handed and called `runLockedMacActivationCycle`,
    // which reaches the update-attempt lock through
    // `withDesktopUpdateContender` — a wrapper that ACQUIRES that lock fresh
    // around its whole callback. But the outer segment already held that same
    // lock for the entire claim-through-activate span via
    // `withDesktopAttemptExecutor`. So the nested acquisition contended against
    // its own parent, resolved `busy`/`source:"attempt"`, terminalized the
    // record `failed`/`activation-not-performed`, and never attempted
    // SMAppService registration at all. In production the F3 continuation arm
    // could therefore NEVER complete an activation — it self-deadlocked every
    // time and reported it as ordinary lock contention, which is exactly why it
    // survived review.
    //
    // The fix: `runMacActivationStepWithCapability` runs the identical actuator
    // while CONSUMING the capability the segment already holds, so the lock is
    // taken once. Not adoption — adoption carries a proof to a separate
    // process, and there is no second process here.
    //
    // If this test ever fails with a lock-busy/deferred outcome again, the
    // `activate` callback has been rewired back through the contender.
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

    // NOTE on what this test actually proves right now: the assertion below
    // (never re-parked as `waiting-to-activate`) is true and meaningful, but
    // with the self-deadlock defect pinned above still live, this record
    // currently reaches "not waiting-to-activate" by terminalizing to `failed`
    // rather than by a genuine `{kind:"verified"}` completion that passed
    // through the busy drain under `overrideDrain: true`. Green here is not by
    // itself proof the overrideDrain wiring holds — once the self-deadlock is
    // fixed, re-verify this test lands on `phase: "restarting"`/`verified`
    // rather than `failed`.

    // F1 acceptance, REDESIGNED by round-2 findings 1 and 2.
    //
    // Round 1 gated the fall-through on a Desktop-side read of the attempt
    // record. Round 2 falsified that on two independent counts:
    //
    //  - It was a SNAPSHOT, not a condition on the restart. A contender can
    //    park `preparing/activate` between Desktop's read and the command
    //    taking the contender lock, so a "safe to restart" verdict could be
    //    stale before it was acted on - and the command would then stop the
    //    service without relaunching. The check re-created the stranding it
    //    was added to prevent.
    //  - It was a SECOND COPY of the policy, and it DISAGREED with the
    //    canonical one. `recoveryActionFor` calls `restarting/activate` and
    //    `verifying/activate` `restart-current`; the Desktop copy treated
    //    every continuation phase as undeferrable, so an `indeterminate`
    //    verdict over one of those records deferred forever and Force restart
    //    could never bring a downed host back.
    //
    // The decision now lives in the command, under the same lock that guards
    // the action it authorizes. That leaves Desktop exactly two obligations,
    // and this block asserts both: ALWAYS pass `--defer-if-parked`, and never
    // flatten the command's deferral into an `ok`.
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
        // The generic restart WAS invoked, with the exact argv including
        // `--defer-if-parked`. `RESTART_FORCE_ARGV` is the full array, so a
        // dropped flag fails here by name - and a dropped flag is precisely
        // what would let the command safe-stop the host behind Desktop's back.
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

    // Finding 2's half, and the reason the Desktop-side policy copy had to go:
    // a record the CANONICAL classification calls `restart-current` must
    // actually be restarted. The round-1 code deferred on every continuation
    // phase, so `restarting/activate` and `verifying/activate` - both
    // explicitly recoverable - could never be relaunched from this route.
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
      // The FULL shape. The version this replaces asserted `outcome.kind` and
      // nothing else, and `restarted:false` also produces `kind:"ok"` - so
      // the reviewer flipped its fixture from `true` to `false` and it still
      // passed. `activated` is the fact under test, so `activated` is asserted.
      expect(outcome).toEqual({ kind: "ok", value: { activated: true } });
    });

    // The genuine post-verification path: verification owns the terminal
    // states, so by the time it answers, the continuation is gone. Clearing
    // the record INSIDE the verify call - rather than before `respawn` - is
    // what makes this the real sequence rather than a pre-staged world.
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
      // A genuinely busy drain read. `runDesktopActivationSegment`'s ONLY
      // park branch is `verdict === "busy" && !overrideDrain` - with
      // `overrideDrain: true` hardcoded at this call site, that branch is
      // structurally unreachable from F3. If `action` had instead smuggled
      // in `force` semantics, or `overrideDrain` were `false`, this busy
      // drain would re-park the record as `waiting-to-activate` and this
      // test would fail on the phase assertion below.
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
        // And NOT terminalized. Until the self-deadlock was fixed (§6.22) the
        // segment always landed `failed`/`activation-not-performed`, which
        // satisfies the `waiting-to-activate` assertion above just as well as
        // success does - so that assertion could not tell a working
        // `overrideDrain` from a broken activation. This one can.
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
      // `withDesktopAttemptExecutor`/`withDesktopUpdateExecutionSegment` (the
      // outer wrapper F3's segment goes through) contends ONLY on the outer
      // update-attempt lock via `withUpdateContender` — it takes the cli-lock
      // solely through the short inner `withDesktopAttemptMutation` windows,
      // never around the whole segment (`update-contender.ts` lines ~168-198).
      // Holding `cliLockPath` here would not contend with the segment
      // acquisition at all; `acquireUpdateAttemptLock` is the real outer lock,
      // confirmed against `update-contender-segment.test.ts`'s own reference
      // test ("maps a real outer-attempt holder to a busy/attempt outcome").
      // Acquire it for real and never release it for the duration of this
      // test, so the segment observes a genuinely contended lock rather than a
      // simulated refusal.
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
      // Deliberately NOT calling `eligibleDesktopCohort()` - this is the
      // production default. `runDesktopActivationSegment` rejects
      // `cohort-disabled` before reading anything else, which is a
      // `rejected` outcome distinct from the `busy` refusal above - and
      // must fall through exactly like every other non-busy refusal.
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
      // An ACTIVE (non-parked) phase with no live lock holder: the record
      // claims a segment is executing, but nothing here actually holds
      // `update-attempt.lock`. `decideAttemptClaim` refuses this as
      // `requires-recovery` - reconciling it is the CLI executor's job,
      // never Desktop's - which is a `rejected` outcome, not `busy`.
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

  // F2 (round 5 review): `withDesktopAttemptMutation` had ZERO production
  // callers before this ticket - the continuation's `activate` step now
  // wraps its registration actuator in it, taking the INNER `cli-lock`
  // (distinct from the outer `update-attempt.lock` the "live-executor
  // deferral" block above proves) for exactly that actuator. A mixed-version
  // CLI that only knows `cli-lock` must still be excluded from mutating the
  // install tree underneath this segment.
  describe("F2: the continuation actually takes the inner cli-lock", () => {
    // The wired property, proven positively: with the inner cli-lock
    // genuinely held externally, registration never runs at all. This is
    // what "the continuation actually takes the inner cli-lock" means -
    // `withDesktopAttemptMutation` observes the real contention and refuses
    // to let `runMacActivationStepWithCapability` (and therefore
    // `registerHostLoginItem`) run underneath it.
    it("a genuinely busy cli-lock blocks registration from ever running", async () => {
      eligibleDesktopCohort();
      const controller = stagePackagedMacRestartWorld({
        waitMs: 150,
        pollIntervalMs: 25,
      });
      writeOwnedSmAppServiceSubstrate();
      await seedParkedActivationAttempt("2.0.0");
      // `cliLockPath("production")` is the SAME file
      // `withDesktopAttemptMutation` contends on inside `activate` (this is
      // `this.lockPath`, threaded through as `options.lockPath` -
      // `update-contender.ts`'s `withDesktopAttemptMutation` ->
      // `withDesktopCliLock({lockPath: options.lockPath, ...})`). Distinct
      // from `acquireUpdateAttemptLock` above, which is the OUTER lock.
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

      // Ablated: temporarily mocked `../update-contender`'s
      // `withDesktopAttemptMutation` to `(capability, _options, run) =>
      // run(capability as never)` - a total bypass of the inner lock, i.e.
      // exactly what "the wrapper was removed from `activate`" looks like
      // from `activate`'s own perspective. Re-ran this exact test: it went
      // red - `registerHostLoginItem` WAS called despite the external hold
      // (`expect(registerHostLoginItem).not.toHaveBeenCalled()` failed).
      // Reverted before committing anything; `host-controller.ts` was
      // never touched.
    });

    // KNOWN GAP — pinned, not routed around. The lock IS genuinely taken
    // (proven above), but its busy outcome does not currently surface as
    // `{kind:"deferred"}` through `respawn()` - it falls through to the
    // plain `host restart --force`, identically to a genuine activation
    // failure. This is NOT about `withDesktopAttemptMutation` being unwired
    // (the test above rules that out); it is a gap one layer up.
    //
    // Mechanism, traced end to end: `activate`'s catch maps a busy inner
    // lock to `{kind:"deferred", message: LOCK_BUSY_MESSAGE}` correctly
    // (`host-controller.ts`). But by the time `activate()` runs,
    // `runClaimedActivation` (`update-executor.ts:299-328`) has ALREADY
    // advanced the record to `restarting` and published the tombstone (the
    // write-ahead ordering is deliberate: "the tombstone is flushed BEFORE
    // the bootout, no gate between them"). `runClaimedActivation` line 329
    // then checks only `activation.kind !== "activated"` - it does not
    // distinguish `deferred` from `failed` - and unconditionally
    // `terminalize`s the record to `phase:"failed"`,
    // `error:{code:"activation-not-performed", message: LOCK_BUSY_MESSAGE}`.
    // `routeForceRestartContinuation`'s mapping only special-cases
    // `segment.kind === "verified"` and `segment.kind === "refused" &&
    // outcome.kind === "busy"` (the OUTER attempt-lock busy case, proven in
    // the "live-executor deferral" block above) - a `segment.kind ===
    // "failed"` result, regardless of its `reason`/`cause`, falls through to
    // `return null` (the plain restart).
    //
    // So structurally, once the tombstone is on disk, EVERY non-"activated"
    // `activate()` result is terminal by the phase graph's own design (no
    // edge from `restarting` back to a park) - which means "defer instead of
    // falling through" for a busy inner lock may not be achievable without
    // either detecting the inner-lock contention BEFORE the tombstone write
    // (a real ordering change), or teaching `routeForceRestartContinuation`
    // to recognize this specific terminal reason/cause pair as
    // deferred-shaped despite the record already being terminal. Flagging
    // rather than guessing which one you want.
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

  // F3 (round 5 review): `withMintedAdoption` had ZERO production callers
  // before this ticket - the continuation's takeover-recovery arm now wraps
  // `host service install --takeover` in it so the spawned CLI child
  // validates the parent's held lock instead of contending against it (the
  // self-deadlock class F3's earlier finding pinned). This must be provable
  // from the spawned argv, not from an internal call to `withMintedAdoption`
  // - the argv IS the wire contract the child actually receives.
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

      // Ablated (verification-only, never committed): temporarily mocked
      // `../update-mutation`'s `withMintedAdoption` to bypass minting -
      // `(_capability, _layout, run) => run([])`, the exact shape "the
      // wrapper was removed" produces (empty adoption args, same as the
      // legacy callers below). Re-ran this exact test: it went red - the
      // spawned argv no longer contained `--attempt-adoption` at all
      // (`flagIndex` was `-1`). Reverted before committing anything;
      // `host-controller.ts` was never touched.
    });

    // Ruling (round 5, F3): terminal-with-diagnostics is correct for a
    // post-tombstone mint/spawn failure - the phase graph offers no path
    // back to a park once `restarting` + tombstone are on disk, and a route
    // that reported `deferred` while the record said `failed` would make
    // truth live in a string match on a message constant. This block proves
    // the full terminal CONTRACT instead: the tombstone is withdrawn, the
    // attempt lock is genuinely released, the record carries real
    // diagnostics, the route does NOT report `deferred`, and no partial
    // activation is reachable.
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
        // ...AND withdrawn BEFORE the record's `failed` commit specifically -
        // not merely gone by the time this test happens to look. Both
        // orderings produce the identical final state above, which is why
        // that assertion alone cannot tell them apart; this one can.
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

      // KNOWN BUG — pinned, not routed around. The record's diagnostic
      // should carry the REAL mint error ("simulated proof write failure"),
      // but `registerActuator`'s `recoverOutsideLock` catch discards it -
      // logging it via `log.warn` only - and returns the generic
      // `{kind:"deferred", message: LOCK_BUSY_MESSAGE}` ("Another Traycer
      // process is managing the host.") instead. That hardcoded message then
      // becomes `terminalize`'s `cause`, so the record on disk claims lock
      // contention for what was actually a local proof-write failure -
      // actively misleading for the user-facing arm that reads this
      // diagnostic. Contrast with the spawn-failure sibling test below,
      // where `describeTakeoverRefusal` DOES carry the real refusal text -
      // this is specific to the mint-failure catch in `host-controller.ts`,
      // not takeover recovery in general.
      it("a mint failure's diagnostic carries the REAL error, not a generic lock-busy message", async () => {
        await respawnWithMintFailure();

        const committed = await readUpdateAttemptRecord(
          getHostFsLayout("production").rootDir,
        );
        expect(committed.kind).toBe("valid");
        if (committed.kind !== "valid") return;
        // `toContain`, not `toBe`: production prefixes the operation that
        // failed ("adoption proof could not be minted: ..."), which the bare
        // error text does not say. Still fails loudly if the real cause is
        // discarded - the bug was substituting LOCK_BUSY_MESSAGE wholesale,
        // and this assertion catches exactly that (ablated).
        expect(committed.value.error?.message).toContain(
          "simulated proof write failure",
        );
        // ...and the generic lock message must NOT be what got recorded.
        expect(committed.value.error?.message).not.toContain(
          "Another Traycer process is managing the host",
        );
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
        // #3: diagnostics carry the REAL spawn error here - this path goes
        // through `classifyMutationSubprocessError` +
        // `withTakeoverDiagnostics`, which DOES preserve the discriminating
        // status and the underlying error, unlike the mint-failure catch
        // above.
        expect(committed.value.error?.message).toContain("not-found");
      });

      // Ablated (verification-only, never committed): temporarily swapped
      // `update-executor.ts`'s terminal-close to call `terminalize` BEFORE
      // `clearTombstone` (previously: withdraw first, terminalize second).
      // Re-ran BOTH tests above: the FIRST attempt at this ablation used only
      // the final-state assertion (`existsSync(tombstone) === false`) and
      // stayed GREEN under the reversed order - both orderings leave the
      // tombstone absent by the time `respawn()` resolves, so that assertion
      // could not tell them apart. That was itself a "green that could not
      // fail" near-miss on my part; caught it by asking what the assertion
      // would see if the order flipped, not just whether it currently
      // passes. Added `terminalOrderEvents` to record the real call order
      // via `commitAttemptMutationWithCapability`/
      // `clearRestartTombstoneWithAttempt`; re-ran the ablation again with
      // the order assertion in place - both tests went red
      // (`["terminalize-commit", "clear-tombstone"]` instead of the expected
      // `["clear-tombstone", "terminalize-commit"]`). Reverted before
      // committing anything; production files were never left modified.
    });

    it("regression guard: legacy (non-continuation) takeover recovery still passes NO adoption args", async () => {
      // `activateInstalled` runs the SAME `recoverRegistrationViaCliTakeover`
      // actuator, but OUTSIDE any F3 executor segment - after
      // `withDesktopUpdateContender` has already released, so the spawned
      // child contends for the attempt lock normally and wins it. Minting a
      // proof here would be authorizing a child against a lock its parent no
      // longer holds - the asymmetry the coordinator flagged as something a
      // future edit could flatten by accident.
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

// Packaged macOS recovery must use the same attempt-aware CLI restart lane as
// the CLI-owned path. In particular, a parked activation continuation is a
// safe-stop (`restarted: false`), not permission for Desktop to activate the
// bytes currently on disk through SMAppService. The stream wrapper returns the
// command result in `data`; retain coverage for both its direct command shape
// and the nested `data` envelope seen when the runner forwards that envelope.
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

  // ---- The refusal shape, at every entry point that can produce it --------
  //
  // Round-2 finding 1 was that a stop-without-relaunch reaches the user as
  // `{kind:"ok", value:{activated:false}}` - "your restart ran and did
  // nothing", while the host is actually down. The redesign makes the command
  // refuse instead of stopping, and these pin the two halves that make that
  // reach the user correctly:
  //
  //   1. every Desktop entry point passes `--defer-if-parked`, so the command
  //      is never free to safe-stop on Desktop's behalf; and
  //   2. the refusal maps to `deferred`, never to `ok`.
  //
  // One per entry point deliberately, not one shared helper test: the flag is
  // added at three separate call sites and a single test would leave two of
  // them free to regress silently.
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

  // The negative control for the pair above: WITHOUT the deferral flag in the
  // response, the same `restarted:false` must still read as the safe-stop it
  // has always been. Without this, mapping every `restarted:false` to
  // `deferred` would satisfy all three tests above and silently reclassify a
  // real stop as "nothing happened".
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

  it("respawn stamps the restart command's attested generation", async () => {
    const controller = newController("production");
    writeInstallRecord("production", {
      version: "1.7.0",
      runtimeVersion: null,
    });
    configureStampAndServiceAttestation();

    expect((await controller.respawn({ kind: "background" })).kind).toBe("ok");
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

    expect(
      (await controller.freePortAndRestart(null, null, { kind: "background" }))
        .kind,
    ).toBe("ok");
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
    const respawnOutcome = await controller.respawn({ kind: "background" });
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

  // SUSPECTED PRODUCTION BUG (reported, not fixed here - see the ticket
  // hand-off; same root cause as the identically-shaped failure in
  // `applyPendingLoginItemRevisionIfIdle`'s "surfaces BOTH failures" test).
  // `recoverRegistrationViaCliTakeover`'s catch for a raw `streamBundled`
  // throw (`host-controller.ts:1401-1415`) classifies the error through
  // `classifyMutationSubprocessError`, then `withTakeoverDiagnostics` appends
  // the caller-only evidence (observed status, escape hatch) the classifier
  // is contractually forbidden to carry - fixed per the T2/T3 author's
  // call-site-enrichment ruling (see the Field RCA comment above this
  // describe block: "the user was locked out with no recovery affordance").
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

  // Field RCA 2026-07-28: the very restart that exercised this fallback in
  // the field hit a live host that denied the takeover's shutdown claim
  // (E_HOST_BUSY) - a self-recovering state (the retry 14s later
  // succeeded), yet it surfaced as a `failed` outcome and therefore a
  // reportable "Couldn't restart host" error toast. The denial must
  // resolve `deferred` so restart surfaces present it as information.
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

    // Fixup B8 (already shipped) classifies workload-busy as `busy` with
    // retry guidance, distinct from `deferred` (lock contention). The
    // durable property this test protects survives that split: whichever
    // label it carries, a live host with work in progress is retry-later
    // information, never a reportable failure.
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

  it("registerService: register not-found recovers via the CLI takeover and reports registered", async () => {
    const controller = stagePackagedMacWorld();
    vi.mocked(registerHostLoginItem).mockResolvedValue("not-found");

    const outcome = await controller.registerService({ kind: "background" });

    expect(outcome).toEqual({ kind: "ok", value: { registered: true } });
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({ args: TAKEOVER_ARGV }),
    );
  });

  // Split into its two legs (entry-point drift only touches the first): this
  // used to drive both `respawn` and `registerService` through the SAME
  // packaged-mac activation cycle. `respawn` no longer reaches it at all
  // (rerouted to the CLI recovery facade, `host restart --force`,
  // unconditionally) - there is no `requires-approval` escalation-gate
  // behavior left on that path to pin. The activation-cycle leg moves to
  // `activateInstalled`, one of its four live entry points; the
  // `registerService` leg is untouched below, byte-identical, since that
  // path never went through `respawn` and did not move.
  it("requires-approval NEVER escalates to the takeover (activateInstalled leg) - the toggle is the user's alone", async () => {
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

    const activateOutcome = await controller.activateInstalled(true);

    expect(activateOutcome.kind).toBe("failed");
    // Guards against a vacuous pass: the pre-bootout `requires-approval`
    // preflight must not have short-circuited before the cycle actually
    // reached registration - otherwise "failed" and no takeover would hold
    // trivially without exercising the escalation gate at all.
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
    expect(runBundledTraycerCliJson).not.toHaveBeenCalledWith(TAKEOVER_ARGV);
  });

  it("requires-approval NEVER escalates to the takeover (registerService leg) - the toggle is the user's alone", async () => {
    const controller = stagePackagedMacWorld();
    vi.mocked(registerHostLoginItem).mockResolvedValue("requires-approval");

    const registerOutcome = await controller.registerService({
      kind: "background",
    });

    expect(registerOutcome.kind).toBe("failed");
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
    // captures `spawnedInLane = false`. That is exactly what the `caller`
    // argument now names, so this call passes `"outside-lane"`: it is subject
    // to reverse admission and defers to a mutation that takes the lane.
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

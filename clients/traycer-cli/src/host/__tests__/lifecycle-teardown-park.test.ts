import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostUpdateAttemptClaimBaseline,
  HostUpdateAttemptRecord,
} from "@traycer-clients/shared/host-update";
import type { ILogger, LogFields } from "../../logger";
import type { HostInstallRecord } from "../../manifest/host-install";
import type { LifecycleTeardown, OwnedHostChild } from "../lifecycle-teardown";
import type { HostPidMetadata } from "../pid-metadata";

// A parked update must not defer the supervisor's own teardown, and the park
// must still be there for the NEXT supervisor start to resume. Both halves are
// asserted on the MECHANISM - which admission each side took - through the real
// lock, the real record and the real defaults, not only on the end state.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

interface AdmissionRecord {
  readonly admissions: string[];
  relaunchEntered: number;
}

function freshAdmissionRecord(): AdmissionRecord {
  return { admissions: [], relaunchEntered: 0 };
}

// Each test records into its own record, through this scope. A test that
// times out keeps running after its `afterEach` and the next test's
// `beforeEach`, so a shared array reset in either hook still collects its
// late admissions; scoped, they land in the timed-out test's own record.
// Not `vi.hoisted()`: a hoisted factory runs before the `node:async_hooks`
// import binding exists. The mock below only reads it once a test calls it.
const admissionScope = new AsyncLocalStorage<AdmissionRecord>();

vi.mock("@traycer-clients/shared/host-update", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@traycer-clients/shared/host-update")
    >();
  return {
    ...actual,
    withUpdateContender: (
      options: Parameters<typeof actual.withUpdateContender>[0],
      run: Parameters<typeof actual.withUpdateContender>[1],
    ) => {
      const store = admissionScope.getStore();
      if (store === undefined) {
        throw new Error(
          "withUpdateContender admission recorded outside a test's AsyncLocalStorage scope - wrap the test body in `admissionScope.run(...)`",
        );
      }
      store.admissions.push(options.admission);
      return actual.withUpdateContender(options, run);
    },
    withSupervisorRelaunchContender: (
      options: Parameters<typeof actual.withSupervisorRelaunchContender>[0],
      run: Parameters<typeof actual.withSupervisorRelaunchContender>[1],
    ) => {
      const store = admissionScope.getStore();
      if (store === undefined) {
        throw new Error(
          "withSupervisorRelaunchContender admission recorded outside a test's AsyncLocalStorage scope - wrap the test body in `admissionScope.run(...)`",
        );
      }
      store.relaunchEntered += 1;
      store.admissions.push("supervisor-relaunch-maintenance");
      return actual.withSupervisorRelaunchContender(options, run);
    },
    withLifecycleTeardownContender: (
      options: Parameters<typeof actual.withLifecycleTeardownContender>[0],
      run: Parameters<typeof actual.withLifecycleTeardownContender>[1],
    ) => {
      const store = admissionScope.getStore();
      if (store === undefined) {
        throw new Error(
          "withLifecycleTeardownContender admission recorded outside a test's AsyncLocalStorage scope - wrap the test body in `admissionScope.run(...)`",
        );
      }
      store.admissions.push("lifecycle-teardown-maintenance");
      return actual.withLifecycleTeardownContender(options, run);
    },
  };
});

// (Settled by written verification; no production code applies - this is
// a property of THIS test file's shared mutable fixtures, not of anything
// under test): a test that times out is declared failed by vitest, but its
// `it(...)` callback is an ordinary un-cancellable `Promise` - nothing aborts
// it, so any of its still-pending `await`s can resume AFTER the runner has
// already moved on to the next test.
//
// `osHome` (hoisted above) and `workHome`/`ORIGINAL_HOME` below are shared,
// mutable module state, not per-test snapshots. `beforeEach` here
// unconditionally reassigns `workHome` and `osHome.current` to a FRESH
// mkdtemp dir before every test, including the one immediately following a
// timeout. Because the `node:os` mock's `homedir: () => osHome.current`
// (above) reads that cell LIVE on every call rather than a value captured at
// mock-registration time, any code in an orphaned continuation that later
// calls `homedir()` again - directly, or through `hostHomeDir` in
// `store/paths.ts`, which every path helper in this suite (`writeAttempt`,
// `buildTeardown`'s `commands/host-start` import, `writeRealPidMetadata`)
// resolves through - lands under the NEXT test's temp home, not its own. A
// stray write from a hung previous test (an attempt record, a pid.json) can
// therefore appear in a directory the next test believes it created fresh.
//
// The ONE thing that stays correctly isolated across this is admission
// bookkeeping: `admissionScope` (an `AsyncLocalStorage`, above) is captured
// per `admissionScope.run(ownRecord, ...)` call and Node's ALS context
// propagates with the continuation regardless of which test is "current", so
// an orphaned body's `withUpdateContender`/`withSupervisorRelaunchContender`
// calls still land in ITS OWN `ownRecord`, never the next test's. Hence the
// existing framing: AsyncLocalStorage isolates the admissions, not the
// filesystem - there is no equivalent scoping for `osHome.current`/
// `workHome`, and none is added here since fixing a test file's own hook
// design is not a production concern.
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

beforeEach(async () => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-teardown-park-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
  const { hostHomeDir } = await import("../../store/paths");
  expect(hostHomeDir("production").startsWith(workHome)).toBe(true);
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  rmSync(workHome, { recursive: true, force: true });
});

const ENVIRONMENT = "production";

interface LogLine {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

function recordingLogger(lines: LogLine[]): ILogger {
  return {
    debug: (message, fields) => lines.push({ level: "debug", message, fields }),
    info: (message, fields) => lines.push({ level: "info", message, fields }),
    warn: (message, fields) => lines.push({ level: "warn", message, fields }),
    error: (message, fields) => lines.push({ level: "error", message, fields }),
  };
}

function attemptRecord(
  overrides: Partial<HostUpdateAttemptRecord>,
): HostUpdateAttemptRecord {
  return {
    schemaVersion: 2,
    attemptId: "attempt-park",
    generation: 3,
    sequence: 7,
    trigger: "manual",
    targetVersion: "1.2.3",
    phase: "waiting-for-work",
    execution: "parked",
    continuation: "resume-apply",
    progress: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
    ...overrides,
  };
}

function installRecord(executablePath: string): HostInstallRecord {
  return {
    installId: null,
    version: "1.2.3",
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-05-15T00:00:00.000Z",
    source: { kind: "registry", value: "1.2.3" },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-05-15T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1234,
    executablePath,
    executableSha256: null,
  };
}

interface FakeChild extends OwnedHostChild {
  readonly signals: string[];
}

function childEndingOnSigterm(): FakeChild {
  let ended = false;
  const signals: string[] = [];
  return {
    pid: 123_456,
    signals,
    ended: () => ended,
    waitForEnd: async () => ended,
    signal: (signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") ended = true;
    },
  };
}

function stubSpawnedChild(): ChildProcess {
  const emitter: unknown = new EventEmitter();
  // The one bridge from a stand-in emitter to `ChildProcess`; the admission
  // only returns what `run` returned and never touches it.
  return emitter as ChildProcess;
}

interface RealChild extends OwnedHostChild {
  /** `signal()` calls this test received - must stay empty when a published
   * `pid.json` routes the stop through the pid-addressed facade instead. */
  readonly signals: string[];
}

/** A REAL OS process (`sleep`), so the pid-addressed facade in
 * `update-mutation.ts` can act on it for real: no fake to intercept
 * `forceStopPublishedHost`/`verifyPublishedInstance`/
 * `removePidMetadataIfUnchanged`. */
async function spawnRealHostChild(): Promise<{
  readonly child: RealChild;
  readonly cleanup: () => void;
}> {
  const proc = spawn("sleep", ["30"]);
  const pid = await new Promise<number>((resolve, reject) => {
    proc.once("spawn", () => {
      if (proc.pid === undefined) {
        reject(new Error("spawned sleep process has no pid"));
        return;
      }
      resolve(proc.pid);
    });
    proc.once("error", reject);
  });
  let ended = false;
  proc.once("exit", () => {
    ended = true;
  });
  const signals: string[] = [];
  const child: RealChild = {
    pid,
    signals,
    ended: () => ended,
    waitForEnd: (timeoutMs) => {
      if (ended) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(ended), timeoutMs);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    },
    signal: (signal) => {
      signals.push(signal);
    },
  };
  return { child, cleanup: () => proc.kill("SIGKILL") };
}

/** An `OwnedHostChild` that reports itself as already ended, for the
 * `confirmAndPurge`-only door: `attempt()` skips the whole stop sequence
 * whenever `child.ended()` is true, so `signal()` must never be called. */
function alreadyEndedChild(pid: number): RealChild {
  const signals: string[] = [];
  return {
    pid,
    signals,
    ended: () => true,
    waitForEnd: async () => true,
    signal: (signal) => {
      signals.push(signal);
    },
  };
}

/** Spawns a real `sleep 30` and resolves once it reports its real pid. */
async function spawnRealSleeper(): Promise<{
  readonly proc: ChildProcess;
  readonly pid: number;
}> {
  const proc = spawn("sleep", ["30"]);
  const pid = await new Promise<number>((resolve, reject) => {
    proc.once("spawn", () => {
      if (proc.pid === undefined) {
        reject(new Error("spawned sleep process has no pid"));
        return;
      }
      resolve(proc.pid);
    });
    proc.once("error", reject);
  });
  return { proc, pid };
}

function waitForRealExit(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    proc.once("exit", () => resolve());
  });
}

async function writeRealPidMetadata(pid: number): Promise<string> {
  const { hostPidMetadataPath } = await import("../../store/paths");
  const { readProcessStartIdentity } =
    await import("../../store/process-identity");
  const identity = readProcessStartIdentity(pid);
  if (identity === null)
    throw new Error("cannot read spawned child's start identity");
  const path = hostPidMetadataPath(ENVIRONMENT);
  mkdirSync(dirname(path), { recursive: true });
  const metadata: HostPidMetadata = {
    pid,
    hostId: "test-host",
    version: "1.2.3",
    websocketUrl: "ws://127.0.0.1:1/rpc",
    startedAt: new Date().toISOString(),
    processStartIdentity: identity,
    processStartIdentityRead: "present",
    layer0: null,
    layer0Slot: null,
  };
  writeFileSync(path, JSON.stringify(metadata));
  return path;
}

async function writeAttempt(record: HostUpdateAttemptRecord): Promise<string> {
  const { hostHomeDir } = await import("../../store/paths");
  const { updateAttemptRecordPath } =
    await import("@traycer-clients/shared/host-update");
  const path = updateAttemptRecordPath(hostHomeDir(ENVIRONMENT));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record)}\n`);
  return path;
}

async function buildTeardown(
  child: OwnedHostChild,
  lines: LogLine[],
  commit: () => void,
): Promise<LifecycleTeardown> {
  const { defaultRunHostStartDeps } = await import("../../commands/host-start");
  const { createLifecycleTeardown } = await import("../lifecycle-teardown");
  return createLifecycleTeardown({
    environment: ENVIRONMENT,
    logger: recordingLogger(lines),
    platform: {
      ...defaultRunHostStartDeps.lifecycle.teardown,
      platform: "linux",
    },
    ownChild: () => child,
    commit,
  });
}

describe("a parked update does not defer the lifecycle teardown, and is resumed by the next start", () => {
  it.each([
    ["waiting-for-work", null],
    ["waiting-to-activate", "install-matched"],
  ] as const)(
    "%s: the teardown takes lifecycle-teardown-maintenance and the next start takes the relaunch admission",
    async (phase, install) => {
      const ownRecord = freshAdmissionRecord();
      await admissionScope.run(ownRecord, async () => {
        let claim: HostUpdateAttemptClaimBaseline | undefined;
        if (install !== null) {
          const { writeHostInstallRecord } =
            await import("../../manifest/host-install");
          const { encodeInstallGeneration } =
            await import("@traycer-clients/shared/host-version/install-generation");
          const record = installRecord("/opt/traycer/host/traycer-host");
          await writeHostInstallRecord(ENVIRONMENT, record);
          claim = {
            installedVersion: "1.2.3",
            installGeneration: encodeInstallGeneration(record),
            stageFingerprint: null,
            allowDowngrade: false,
            acceptStoreFormatLoss: false,
          };
        }
        const parked =
          phase === "waiting-for-work"
            ? attemptRecord({})
            : attemptRecord({
                phase: "waiting-to-activate",
                continuation: "activate",
                claim,
              });
        const path = await writeAttempt(parked);
        const before = readFileSync(path, "utf8");

        // ---- Step 1: the teardown over the park ----
        const lines: LogLine[] = [];
        const commits: number[] = [];
        const child = childEndingOnSigterm();
        const teardown = await buildTeardown(child, lines, () => {
          commits.push(commits.length);
        });
        const result = await teardown.attempt(
          async () => true,
          () => false,
        );

        expect(result).toEqual({ kind: "complete" });
        expect(ownRecord.admissions).toEqual([
          "lifecycle-teardown-maintenance",
        ]);
        expect(commits).toHaveLength(1);
        expect(child.signals).toEqual(["SIGTERM"]);
        expect(readFileSync(path, "utf8")).toBe(before);
        const commitLine = lines.find(
          (line) =>
            line.level === "info" &&
            line.message.startsWith("Host supervisor stopping its host"),
        );
        expect(commitLine).toBeDefined();
        expect(Object.keys(commitLine?.fields ?? {}).sort()).toEqual([
          "admission",
          "reason",
        ]);
        expect(commitLine?.fields).toEqual({
          reason: "lifecycle-presence-stop",
          admission: "lifecycle-teardown-maintenance",
        });

        // ---- Step 2: the next `host start` resumes the park ----
        ownRecord.admissions.length = 0;
        const { defaultRunHostStartDeps } =
          await import("../../commands/host-start");
        const spawned: number[] = [];
        const beside: HostUpdateAttemptRecord[] = [];
        const outcome = await defaultRunHostStartDeps.admitHostStartSpawn(
          { environment: ENVIRONMENT, cwd: null },
          async () => {
            spawned.push(spawned.length);
            return stubSpawnedChild();
          },
          (record) => {
            beside.push(record);
          },
          { consumed: { kind: "absent" }, onGranted: () => undefined },
        );

        expect(ownRecord.relaunchEntered).toBe(1);
        expect(ownRecord.admissions).toEqual([
          "supervisor-relaunch-maintenance",
        ]);
        expect(outcome.kind).toBe("ran");
        expect(spawned).toHaveLength(1);
        expect(beside).toHaveLength(1);
        expect(beside[0]).toEqual(parked);
        // The supervisor never writes the record: same attempt, generation and
        // sequence, and the same bytes.
        expect(readFileSync(path, "utf8")).toBe(before);
      });
    },
    // The cold `vi.resetModules()` plus the dynamic `commands/host-start`
    // import took 11.8 s on a 2-vCPU Windows VM, past the 5 s default.
    30_000,
  );

  // A published `pid.json` naming the test's own real child process, so
  // the teardown's REAL facade bindings (`update-mutation.ts`) run against a
  // real OS process: `forceStopPublishedHost` (which internally verifies via
  // `getPublishedProcessIdentityVerdict`, the same function
  // `verifyPublishedInstance` wraps) and `removePidMetadataIfUnchanged`.
  // `killHostTree` is Windows-only, so this is skipped there - no `sleep` and
  // no equivalent fixture process.
  it.skipIf(process.platform === "win32")(
    "a published pid.json is stopped and purged through the published-host force path",
    async () => {
      const ownRecord = freshAdmissionRecord();
      await admissionScope.run(ownRecord, async () => {
        const parked = attemptRecord({});
        const attemptPath = await writeAttempt(parked);
        const attemptBefore = readFileSync(attemptPath, "utf8");

        const { child, cleanup } = await spawnRealHostChild();
        try {
          const pidPath = await writeRealPidMetadata(child.pid);

          const lines: LogLine[] = [];
          const commits: number[] = [];
          const teardown = await buildTeardown(child, lines, () => {
            commits.push(commits.length);
          });
          const result = await teardown.attempt(
            async () => true,
            () => false,
          );

          expect(result).toEqual({ kind: "complete" });
          expect(commits).toHaveLength(1);
          // Never routed through the child's own handle: a published record
          // takes the pid-addressed force path instead.
          expect(child.signals).toEqual([]);
          expect(await child.waitForEnd(1_000)).toBe(true);

          const { readHostPidMetadata } = await import("../pid-metadata");
          expect(await readHostPidMetadata(ENVIRONMENT)).toBeNull();
          expect(() => readFileSync(pidPath, "utf8")).toThrow();

          // The parked update record is untouched: the teardown never
          // deferred to it.
          expect(readFileSync(attemptPath, "utf8")).toBe(attemptBefore);
        } finally {
          cleanup();
        }
      });
    },
    30_000,
  );

  // The OTHER door into `confirmAndPurge` - an already-ENDED own
  // child, so `attempt()` skips the whole stop sequence and goes straight to
  // the real `verifyPublishedInstance`/`removePidMetadataIfUnchanged` facade
  // calls (`update-mutation.ts:485-488`), which the published-host test above never
  // reaches (the force helper purges the record itself before `confirmAndPurge`
  // runs). The identity is read from the REAL process while it is still
  // alive, then it is SIGKILLed and its real exit awaited, so
  // `verifyPublishedInstance` sees a genuinely dead pid, not a mocked one.
  it.skipIf(process.platform === "win32")(
    "a published pid.json naming the ended child is verified dead and purged through the facade",
    async () => {
      const ownRecord = freshAdmissionRecord();
      await admissionScope.run(ownRecord, async () => {
        const { proc, pid } = await spawnRealSleeper();
        const pidPath = await writeRealPidMetadata(pid);

        const exited = waitForRealExit(proc);
        proc.kill("SIGKILL");
        await exited;

        const child = alreadyEndedChild(pid);
        const lines: LogLine[] = [];
        const commits: number[] = [];
        const teardown = await buildTeardown(child, lines, () => {
          commits.push(commits.length);
        });
        const result = await teardown.attempt(
          async () => true,
          () => false,
        );

        expect(result).toEqual({ kind: "complete" });
        expect(commits).toHaveLength(1);
        // The stop sequence never ran: `child.ended()` is true from the
        // start, so nothing ever signals this handle.
        expect(child.signals).toEqual([]);

        const { readHostPidMetadata } = await import("../pid-metadata");
        expect(await readHostPidMetadata(ENVIRONMENT)).toBeNull();
        expect(() => readFileSync(pidPath, "utf8")).toThrow();
      });
    },
    30_000,
  );

  // A published pid.json naming a LIVE FOREIGN process (not this
  // test's own ended child) must be verified `current` and left completely
  // alone - real `verifyPublishedInstance`, real bytes, real still-alive
  // process, none of them a guess.
  it.skipIf(process.platform === "win32")(
    "a published pid.json naming a live foreign host is verified current and left byte-identical",
    async () => {
      const ownRecord = freshAdmissionRecord();
      await admissionScope.run(ownRecord, async () => {
        const { proc, pid } = await spawnRealSleeper();
        try {
          const pidPath = await writeRealPidMetadata(pid);
          const before = readFileSync(pidPath, "utf8");

          // Our OWN child is a different, already-ended process - never the
          // foreign one pid.json names.
          const child = alreadyEndedChild(pid + 1);
          const lines: LogLine[] = [];
          const commits: number[] = [];
          const teardown = await buildTeardown(child, lines, () => {
            commits.push(commits.length);
          });
          const result = await teardown.attempt(
            async () => true,
            () => false,
          );

          expect(result).toEqual({ kind: "complete" });
          expect(commits).toHaveLength(1);
          expect(child.signals).toEqual([]);
          expect(readFileSync(pidPath, "utf8")).toBe(before);
          // The foreign process is still alive - signal 0 throws only when
          // the pid does not exist.
          expect(() => process.kill(pid, 0)).not.toThrow();
        } finally {
          proc.kill("SIGKILL");
        }
      });
    },
    30_000,
  );

  it("an applying record refuses the teardown: retry, no commit, no signal, record untouched", async () => {
    const ownRecord = freshAdmissionRecord();
    await admissionScope.run(ownRecord, async () => {
      const applying = attemptRecord({
        phase: "applying",
        execution: "active",
        continuation: null,
      });
      const path = await writeAttempt(applying);
      const before = readFileSync(path, "utf8");
      const lines: LogLine[] = [];
      const commits: number[] = [];
      const child = childEndingOnSigterm();
      const teardown = await buildTeardown(child, lines, () => {
        commits.push(commits.length);
      });

      const result = await teardown.attempt(
        async () => true,
        () => false,
      );

      expect(result).toEqual({
        kind: "retry",
        reason: "update-attempt-active",
      });
      expect(ownRecord.admissions).toEqual(["lifecycle-teardown-maintenance"]);
      expect(commits).toHaveLength(0);
      expect(teardown.committed()).toBe(false);
      expect(child.signals).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe(before);
    });
  }, 30_000); // cold measurement applies here and the default 5s timeout is too tight. // `vi.resetModules()`, like the parked-update row above; the same 11.8s // `buildTeardown` cold-imports `commands/host-start` after
});

// `lifecycle-teardown.test.ts`'s fake `withLock` never models a release,
// so whether the REAL lock actually releases on the `retry` and `throw` paths
// is unproven by that suite. Settled here against the real facade
// (`defaultRunHostStartDeps.lifecycle.teardown`, the same object
// `buildTeardown` uses), through the exact contender call the facade takes
// (`withCliUpdateContender`'s admission).
//
// On reentrancy: the update-ATTEMPT lock (`acquireUpdateAttemptLock`,
// `clients/shared/host-update/lock.ts:135-142`) IS held-in-process reentrant
// for this pid - a second same-process acquire while the first is still held
// returns `"held-in-process"` WITHOUT ever running its callback
// (`withUpdateContenderInternal`, `clients/shared/host-update/contender.ts:
// 1027-1028`: `if (acquisition.kind === "held-in-process") return acquisition;`).
// That is a same-process test's escape hatch for THIS lock, not a hole in
// one: a leaked release leaves the map entry standing, so the second call
// would short-circuit to `held-in-process` and never execute its callback -
// observably different from a genuine release, which lets the second call's
// callback actually run. The inner CLI lock (`withCliLock`, real
// O_EXCL-file-backed, `store/cli-lock.ts`) has no such reentrancy at all: a
// second same-process acquire while it is still held sees a live holder (this
// same pid, positively alive) and is refused as busy, not silently granted.
// So a same-process re-acquire is sound proof for both layers this facade
// composes: either a real leak surfaces as `held-in-process` or a thrown
// `CLI_LOCK_BUSY`, or a genuine release lets the second attempt's callback
// run for real. No child-process probe is needed.
describe("the CLI update lock is genuinely released on the retry and throw paths", () => {
  it("a fresh acquisition after a retry-returning attempt runs its callback for real", async () => {
    const ownRecord = freshAdmissionRecord();
    await admissionScope.run(ownRecord, async () => {
      const { defaultRunHostStartDeps } =
        await import("../../commands/host-start");
      const platform = defaultRunHostStartDeps.lifecycle.teardown;

      const first = await platform.withLock(ENVIRONMENT, async () => ({
        kind: "retry",
        reason: "tu1-probe",
      }));
      expect(first).toEqual({ kind: "retry", reason: "tu1-probe" });

      let ranSecond = false;
      const second = await platform.withLock(ENVIRONMENT, async () => {
        ranSecond = true;
        return { kind: "complete" };
      });
      expect(ranSecond).toBe(true);
      expect(second).toEqual({ kind: "complete" });
      expect(ownRecord.admissions).toEqual([
        "lifecycle-teardown-maintenance",
        "lifecycle-teardown-maintenance",
      ]);
    });
  });

  it("a fresh acquisition after a throw inside the lock runs its callback for real", async () => {
    const ownRecord = freshAdmissionRecord();
    await admissionScope.run(ownRecord, async () => {
      const { defaultRunHostStartDeps } =
        await import("../../commands/host-start");
      const platform = defaultRunHostStartDeps.lifecycle.teardown;

      await expect(
        platform.withLock(ENVIRONMENT, async () => {
          throw new Error("tu1-probe-throw");
        }),
      ).rejects.toThrow("tu1-probe-throw");

      let ranSecond = false;
      const second = await platform.withLock(ENVIRONMENT, async () => {
        ranSecond = true;
        return { kind: "complete" };
      });
      expect(ranSecond).toBe(true);
      expect(second).toEqual({ kind: "complete" });
      expect(ownRecord.admissions).toEqual([
        "lifecycle-teardown-maintenance",
        "lifecycle-teardown-maintenance",
      ]);
    });
  });
});

import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
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
  };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-teardown-park-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
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
  });
});

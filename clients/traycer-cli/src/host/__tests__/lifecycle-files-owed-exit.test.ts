import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `store/paths` binds its home root from `os.homedir()` at module load. Keep
// the environment mutation below, but redirect `homedir()` too - the same
// pattern `lifecycle-files.test.ts` (this directory) uses.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-lifecycle-owed-exit-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
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
  vi.restoreAllMocks();
  vi.doUnmock("../../store/process-identity");
});

const ENVIRONMENT = "production";
const PREDECESSOR_PID = 424_242;

interface ProbeCall {
  readonly pid: number;
  readonly startedAtMs: number | null;
  readonly startIdentity: string | null;
}

/** A well-formed token: the schema drops a malformed one to `null`. */
async function validIdentity(): Promise<string> {
  const { readProcessStartIdentity } =
    await import("../../store/process-identity");
  const identity = await readProcessStartIdentity(process.pid);
  if (identity === null) throw new Error("cannot read own start identity");
  return identity;
}

function mockProbeAsGone(calls: ProbeCall[]): void {
  vi.doMock("../../store/process-identity", async (importOriginal) => {
    const actual =
      await importOriginal<typeof import("../../store/process-identity")>();
    return {
      ...actual,
      // "provably gone": `dead`, one of the two verdicts
      // `readInheritableRunOwnership` treats as a real predecessor.
      verifyProcessIdentityAsync: async (target: ProbeCall) => {
        calls.push(target);
        return "dead";
      },
    };
  });
}

/**
 * Writes `supervisor-run.json` exactly as `writeSupervisorRecords` would for
 * a kept run state (the shape an owed-exit, `keep-run-state` removal leaves
 * behind) - WITHOUT the `owesSuccessor` mark unless `mark` adds it, as raw
 * JSON, for the green control case.
 */
async function writeKeptRunState(mark: boolean): Promise<void> {
  const {
    writeSupervisorRecords,
    removeSupervisorRecords,
    supervisorRunStatePath,
  } = await import("../lifecycle-files");
  await writeSupervisorRecords(ENVIRONMENT, {
    record: {
      v: 1,
      pid: PREDECESSOR_PID,
      cliVersion: "0.0.0-test",
      capabilities: ["lifecycle-policy-v1"],
      startedAt: "2026-09-24T00:00:00.000Z",
    },
    runState: {
      v: 1,
      supervisorPid: PREDECESSOR_PID,
      supervisorStartIdentity: await validIdentity(),
      admission: "unattended",
      origin: null,
      adopted: true,
      lastPresence: null,
      updatedAt: "2026-09-24T00:00:00.000Z",
    },
  });
  if (mark) {
    const { readFile, writeFile } = await import("node:fs/promises");
    const path = supervisorRunStatePath(ENVIRONMENT);
    const parsed: Record<string, unknown> = JSON.parse(
      await readFile(path, "utf8"),
    );
    parsed.owesSuccessor = true;
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`);
  }
  // `supervisor.json` goes, as every `keep-run-state` removal leaves it - so
  // the mark is the ONLY thing separating the two rows below. With it still
  // on disk, the unmarked row would be refused by the `supervisor.json`
  // condition instead and prove nothing about the mark.
  await removeSupervisorRecords(ENVIRONMENT, PREDECESSOR_PID, "keep-run-state");
}

describe("readInheritableRunOwnership cannot tell an owed exit from a SIGKILL", () => {
  it("inherits from an UNMARKED kept run state - a SIGKILL left the same file behind and must not be inherited", async () => {
    const calls: ProbeCall[] = [];
    mockProbeAsGone(calls);
    await writeKeptRunState(false);
    const { readInheritableRunOwnership } = await import("../lifecycle-files");

    const inherited = await readInheritableRunOwnership(ENVIRONMENT);

    // A predecessor that was SIGKILLed leaves the exact same kept file as one
    // that exited 77/76 owing a successor - `adopted: true`, a valid start
    // identity that would otherwise probe `dead`. The fix gates on the
    // `owesSuccessor` mark before it ever reaches the identity probe: an
    // unmarked file fails to parse as an owed run state, so
    // `readInheritableRunOwnership` returns `null` without probing at all.
    expect(inherited).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("inherits from a MARKED kept run state whose predecessor provably probes gone", async () => {
    const calls: ProbeCall[] = [];
    mockProbeAsGone(calls);
    await writeKeptRunState(true);
    const { readInheritableRunOwnership } = await import("../lifecycle-files");

    const inherited = await readInheritableRunOwnership(ENVIRONMENT);

    // With the `owesSuccessor` mark present, the file parses as owed and the
    // predecessor's start identity probes `dead` (a verdict inheritance
    // treats as provably gone), so ownership carries over exactly as before.
    expect(inherited).toEqual({ adopted: true, lastPresence: null });
    expect(calls).toHaveLength(1);
  });
});

describe("an owed exit's removeRecords binding marks the run state it keeps", () => {
  it("marks supervisor-run.json owesSuccessor: true via the real removeRecords binding, and removes supervisor.json", async () => {
    const {
      writeSupervisorRecords,
      readSupervisorRecord,
      supervisorRunStatePath,
    } = await import("../lifecycle-files");
    const { defaultRunHostStartDeps } =
      await import("../../commands/host-start");
    await writeSupervisorRecords(ENVIRONMENT, {
      record: {
        v: 1,
        pid: process.pid,
        cliVersion: "0.0.0-test",
        capabilities: ["lifecycle-policy-v1"],
        startedAt: "2026-09-24T00:00:00.000Z",
      },
      runState: {
        v: 1,
        supervisorPid: process.pid,
        supervisorStartIdentity: await validIdentity(),
        admission: "unattended",
        origin: null,
        adopted: true,
        lastPresence: null,
        updatedAt: "2026-09-24T00:00:00.000Z",
      },
    });

    // The actual choke point: `defaultRunHostStartDeps.lifecycle
    // .removeRecords` is what host-start.ts calls on every supervisor exit.
    // For a `keep-run-state` removal that binding marks the kept file
    // (`markSupervisorRunOwed`) BEFORE calling `removeSupervisorRecords` -
    // drive that production sequence directly rather than reimplementing it
    // by hand, so deleting the mark call from the binding is what this test
    // must catch.
    await defaultRunHostStartDeps.lifecycle.removeRecords(
      ENVIRONMENT,
      process.pid,
      "keep-run-state",
    );

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(supervisorRunStatePath(ENVIRONMENT), "utf8");
    const parsed: Record<string, unknown> = JSON.parse(raw);

    // The kept file carries `owesSuccessor: true` from the binding's mark,
    // so a genuine 77/76 exit can be told apart from a SIGKILL that merely
    // left the same file on disk - and `supervisor.json` is gone, exactly as
    // every `keep-run-state` removal leaves it.
    expect(parsed.owesSuccessor).toBe(true);
    expect((await readSupervisorRecord(ENVIRONMENT)).kind).toBe("absent");
  });
});

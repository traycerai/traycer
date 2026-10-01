import { describe, expect, it, vi } from "vitest";
import { serviceLabelFor, windowsTaskName } from "../../label";
import { ProcessRunError } from "../../process-runner";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import {
  gateWindowsTaskVerb,
  isServiceTaskNotOwnedError,
  SERVICE_REGISTRATION_KEPT_CHANGING_MESSAGE,
  type PermittedWindowsTask,
  type ScheduledTaskXmlQuery,
  type WindowsTaskOwnershipDeps,
  type WindowsTaskVerbRunner,
} from "../windows-task-gate";

// R3 §B: the `create` executor's TOCTOU fix - read -> stage -> confirm-read ->
// verb. `gateWindowsTaskVerb`'s own read decides `permitted`/`not-owned` as
// before; the NEW work is entirely inside `create.exec(run, stage, options)`,
// which re-reads ownership immediately before every mutating write and
// refuses to overwrite a task that changed hands while the XML was being
// staged to disk.
//
// RED-FIRST against the pre-R3 snapshot: `create`'s pre-R3 signature is
// `(run, xmlPath: string, options) => Promise<RunResult>` - no stage
// callback, no confirm-read, and the write always carries `/F`. Every test
// here calls the NEW three-argument shape; against the snapshot that either
// mis-threads the stage function into the schtasks argv (so the assertions
// on argv/return-shape fail) or simply never performs the confirm-read
// behaviour these tests require.

const label = serviceLabelFor("production");
const TASK = windowsTaskName(label);
const CALLER_SID = "S-1-5-21-1111-2222-3333-1001";
const OTHER_SID = "S-1-5-21-1111-2222-3333-1002";

function taskXml(sid: string, tag: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <!--${tag}-->
  <Principals><Principal id="A"><UserId>${sid}</UserId></Principal></Principals>
  <Actions Context="A"><Exec><Command>x</Command></Exec></Actions>
</Task>`;
}

const CALLER_TASK = (tag: string): ScheduledTaskXmlQuery => ({
  kind: "xml",
  xml: taskXml(CALLER_SID, tag),
});
const OTHER_TASK: ScheduledTaskXmlQuery = {
  kind: "xml",
  xml: taskXml(OTHER_SID, ""),
};
const ABSENT: ScheduledTaskXmlQuery = { kind: "absent" };
const UNREADABLE: ScheduledTaskXmlQuery = {
  kind: "failed",
  reason: "access denied",
};

/** A queue of `queryTaskXml` answers, consumed one per call (last repeats). */
function queueDeps(queries: readonly ScheduledTaskXmlQuery[]): {
  readonly deps: WindowsTaskOwnershipDeps;
  readonly queryCount: () => number;
} {
  let i = 0;
  return {
    deps: {
      queryTaskXml: async () => {
        const q = queries[Math.min(i, queries.length - 1)];
        i += 1;
        return q;
      },
      callerSid: () => CALLER_SID,
      resolveAccountSid: async () => null,
    },
    queryCount: () => i,
  };
}

function stageMock(): {
  readonly stage: (task: PermittedWindowsTask) => Promise<string>;
  readonly calls: PermittedWindowsTask[];
} {
  const calls: PermittedWindowsTask[] = [];
  const stage = vi.fn(async (task: PermittedWindowsTask): Promise<string> => {
    calls.push(task);
    return `/tmp/stage-${calls.length}.xml`;
  });
  return { stage, calls };
}

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: unknown;
}

type CreateIfAbsentOutcome = () => Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}>;

const CREATE_IF_ABSENT_EXITS_0: CreateIfAbsentOutcome = async () => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
});
// R3 note 1: `tolerateNonZeroExit` stays the CALLER's value, which is
// `false` (`RUN_OPTIONS` below). A real `runCommand` REJECTS with a
// `ProcessRunError` on a non-zero exit under that option, rather than
// resolving with the exit code - so the fake here must reject too.
const createIfAbsentExits1 =
  (stderr: string): CreateIfAbsentOutcome =>
  async () => {
    throw new ProcessRunError(
      "schtasks exited 1",
      "schtasks",
      ["/Create"],
      1,
      "",
      stderr,
    );
  };
const createIfAbsentRejects: CreateIfAbsentOutcome = async () => {
  throw new Error("simulated schtasks timeout");
};

/**
 * A fake runner that distinguishes the create-if-absent write (`/Create`
 * with no `/F`) from every other schtasks/powershell call, and answers each
 * successive create-if-absent call from `outcomes` (last repeats).
 */
function fakeRunner(outcomes: readonly CreateIfAbsentOutcome[]): {
  readonly run: WindowsTaskVerbRunner;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let createIfAbsentCalls = 0;
  const run: WindowsTaskVerbRunner = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    if (
      command === "schtasks" &&
      args[0] === "/Create" &&
      !args.includes("/F")
    ) {
      const outcome =
        outcomes[Math.min(createIfAbsentCalls, outcomes.length - 1)];
      createIfAbsentCalls += 1;
      return outcome();
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { run, calls };
}

function createCalls(calls: readonly RecordedCall[]): readonly RecordedCall[] {
  return calls.filter(
    (c) => c.command === "schtasks" && c.args[0] === "/Create",
  );
}
function withF(calls: readonly RecordedCall[]): readonly RecordedCall[] {
  return createCalls(calls).filter((c) => c.args.includes("/F"));
}
function withoutF(calls: readonly RecordedCall[]): readonly RecordedCall[] {
  return createCalls(calls).filter((c) => !c.args.includes("/F"));
}

const RUN_OPTIONS = {
  env: undefined,
  cwd: undefined,
  timeoutMs: 1_000,
  // R3 note 1: the real caller's value - a non-zero exit REJECTS.
  tolerateNonZeroExit: false,
};

/** `gateWindowsTaskVerb(label, "create", deps)`, asserting it is `permitted`. */
async function createGate(deps: WindowsTaskOwnershipDeps) {
  const gate = await gateWindowsTaskVerb(label, "create", deps);
  if (gate.kind !== "permitted") {
    throw new Error(`expected permitted, got ${gate.kind}`);
  }
  return gate;
}

describe("windows-task-gate: create is read -> stage -> confirm-read -> verb (R3 TOCTOU)", () => {
  it("test 23: absent branch argv - the only mutating call has no /F and endStdin: true", async () => {
    const { deps, queryCount } = queueDeps([ABSENT, ABSENT]);
    const gate = await createGate(deps);
    const { stage } = stageMock();
    const { run, calls } = fakeRunner([CREATE_IF_ABSENT_EXITS_0]);

    const result = await gate.exec(run, stage, RUN_OPTIONS);

    expect(result).toEqual({ kind: "absent" });
    expect(createCalls(calls)).toHaveLength(1);
    expect(withF(calls)).toHaveLength(0);
    const create = createCalls(calls)[0];
    expect(create?.args).toEqual([
      "/Create",
      "/TN",
      TASK,
      "/XML",
      "/tmp/stage-1.xml",
    ]);
    expect(create?.options).toMatchObject({ endStdin: true });
    expect(queryCount()).toBe(2);
  });

  it("test 24a: another account's task confirmed after an absent first read - no /Create at all", async () => {
    const { deps } = queueDeps([ABSENT, OTHER_TASK]);
    const gate = await createGate(deps);
    const { stage } = stageMock();
    const { run, calls } = fakeRunner([CREATE_IF_ABSENT_EXITS_0]);

    await expect(gate.exec(run, stage, RUN_OPTIONS)).rejects.toSatisfy(
      (err: unknown) => isServiceTaskNotOwnedError(err),
    );
    expect(createCalls(calls)).toHaveLength(0);
  });

  it("test 24b: create-if-absent fails, and the re-read finds another account's task", async () => {
    const { deps, queryCount } = queueDeps([ABSENT, ABSENT, OTHER_TASK]);
    const gate = await createGate(deps);
    const { stage } = stageMock();
    const { run, calls } = fakeRunner([createIfAbsentExits1("")]);

    await expect(gate.exec(run, stage, RUN_OPTIONS)).rejects.toSatisfy(
      (err: unknown) => isServiceTaskNotOwnedError(err),
    );
    expect(createCalls(calls)).toHaveLength(1);
    expect(withF(calls)).toHaveLength(0);
    expect(queryCount()).toBe(3);
  });

  it("test 24c: create-if-absent REJECTS (a timeout), and the re-read finds another account's task", async () => {
    const { deps } = queueDeps([ABSENT, ABSENT, OTHER_TASK]);
    const gate = await createGate(deps);
    const { stage } = stageMock();
    const { run, calls } = fakeRunner([createIfAbsentRejects]);

    await expect(gate.exec(run, stage, RUN_OPTIONS)).rejects.toSatisfy(
      (err: unknown) => isServiceTaskNotOwnedError(err),
    );
    expect(createCalls(calls)).toHaveLength(1);
  });

  it("test 25: ownership changes between staging and the verb (caller -> another user) - 0 /Create, staged once", async () => {
    const { deps } = queueDeps([CALLER_TASK("v1"), OTHER_TASK]);
    const gate = await createGate(deps);
    const { stage, calls: stageCalls } = stageMock();
    const { run, calls } = fakeRunner([CREATE_IF_ABSENT_EXITS_0]);

    await expect(gate.exec(run, stage, RUN_OPTIONS)).rejects.toSatisfy(
      (err: unknown) => isServiceTaskNotOwnedError(err),
    );
    expect(createCalls(calls)).toHaveLength(0);
    expect(stageCalls).toHaveLength(1);
    expect(stageCalls[0]).toEqual({
      kind: "caller",
      xml: taskXml(CALLER_SID, "v1"),
    });
  });

  it("test 26: same-user concurrent create - a failed no-/F create is followed by a re-stage and /Create /F", async () => {
    const { deps, queryCount } = queueDeps([
      ABSENT, // gate's own read
      ABSENT, // first confirm-read: matches staged absent -> create-if-absent
      CALLER_TASK("reread"), // re-read after the failed create: caller's own
      CALLER_TASK("reread"), // confirm-read after staging the reread: matches
    ]);
    const gate = await createGate(deps);
    const { stage, calls: stageCalls } = stageMock();
    const { run, calls } = fakeRunner([createIfAbsentExits1("")]);

    const result = await gate.exec(run, stage, RUN_OPTIONS);

    expect(stageCalls).toHaveLength(2);
    expect(stageCalls[1]).toEqual({
      kind: "caller",
      xml: taskXml(CALLER_SID, "reread"),
    });
    expect(withoutF(calls)).toHaveLength(1);
    expect(withF(calls)).toHaveLength(1);
    expect(withF(calls)[0]?.args).toEqual([
      "/Create",
      "/TN",
      TASK,
      "/XML",
      "/tmp/stage-2.xml",
      "/F",
    ]);
    expect(result).toEqual({
      kind: "caller",
      xml: taskXml(CALLER_SID, "reread"),
    });
    expect(queryCount()).toBe(4);
  });

  describe("test 27: classification never reads stdout/stderr text - only the re-read decides", () => {
    it("English 'already exists' stderr + a re-read that is STILL absent: the create's own failure, not a retry", async () => {
      const { deps, queryCount } = queueDeps([ABSENT, ABSENT, ABSENT]);
      const gate = await createGate(deps);
      const { stage } = stageMock();
      const { run, calls } = fakeRunner([
        createIfAbsentExits1("ERROR: The specified task name already exists."),
      ]);

      await expect(gate.exec(run, stage, RUN_OPTIONS)).rejects.toSatisfy(
        (err: unknown) => !isServiceTaskNotOwnedError(err),
      );
      expect(createCalls(calls)).toHaveLength(1);
      expect(withF(calls)).toHaveLength(0);
      expect(queryCount()).toBe(3);
    });

    it("localized/garbage stderr + a re-read that is the caller's own task: the owned path, not a failure", async () => {
      const { deps } = queueDeps([ABSENT, ABSENT, CALLER_TASK("rr")]);
      const gate = await createGate(deps);
      const { stage } = stageMock();
      const { run, calls } = fakeRunner([
        createIfAbsentExits1("エラー: 不明な入力です。"),
      ]);

      const result = await gate.exec(run, stage, RUN_OPTIONS);
      expect(withF(calls)).toHaveLength(1);
      expect(result).toEqual({
        kind: "caller",
        xml: taskXml(CALLER_SID, "rr"),
      });
    });

    it("an unreadable re-read: E_SERVICE_TASK_NOT_OWNED (unconfirmed), never a retry", async () => {
      const { deps } = queueDeps([ABSENT, ABSENT, UNREADABLE]);
      const gate = await createGate(deps);
      const { stage } = stageMock();
      const { run, calls } = fakeRunner([createIfAbsentExits1("anything")]);

      await expect(gate.exec(run, stage, RUN_OPTIONS)).rejects.toSatisfy(
        (err: unknown) => isServiceTaskNotOwnedError(err),
      );
      expect(createCalls(calls)).toHaveLength(1);
    });
  });

  it("test 28: bounded at 3 staging passes - a task that changes every read throws with 0 /Create", async () => {
    const { deps } = queueDeps([
      CALLER_TASK("v1"),
      CALLER_TASK("v2"),
      CALLER_TASK("v3"),
      CALLER_TASK("v4"),
    ]);
    const gate = await createGate(deps);
    const { stage, calls: stageCalls } = stageMock();
    const { run, calls } = fakeRunner([CREATE_IF_ABSENT_EXITS_0]);

    // R4 §42: the 3-stagings refusal is now the SAME error the step budget
    // throws, on `details.reason === "stagings"` rather than a message of
    // its own.
    await expect(gate.exec(run, stage, RUN_OPTIONS)).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: SERVICE_REGISTRATION_KEPT_CHANGING_MESSAGE,
      details: { reason: "stagings", stagings: 3 },
    });
    expect(stageCalls).toHaveLength(3);
    expect(createCalls(calls)).toHaveLength(0);
  });

  describe("test 29: one queryTaskXml read per staging pass, plus the gate's own", () => {
    it("plain owned path (nothing changes): exactly 2 reads (gate + confirm)", async () => {
      const { deps, queryCount } = queueDeps([
        CALLER_TASK("same"),
        CALLER_TASK("same"),
      ]);
      const gate = await createGate(deps);
      const { stage } = stageMock();
      const { run } = fakeRunner([CREATE_IF_ABSENT_EXITS_0]);

      await gate.exec(run, stage, RUN_OPTIONS);
      expect(queryCount()).toBe(2);
    });

    it("absent path, create-if-absent succeeds first try: exactly 2 reads (gate + confirm)", async () => {
      const { deps, queryCount } = queueDeps([ABSENT, ABSENT]);
      const gate = await createGate(deps);
      const { stage } = stageMock();
      const { run } = fakeRunner([CREATE_IF_ABSENT_EXITS_0]);

      await gate.exec(run, stage, RUN_OPTIONS);
      expect(queryCount()).toBe(2);
    });
  });
});

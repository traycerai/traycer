import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serviceLabelFor } from "../../label";
import { ProcessRunError } from "../../process-runner";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import {
  WINDOWS_TASK_CREATE_BUDGET_MS,
  WINDOWS_TASK_OWNERSHIP_READ_BOUND_MS,
} from "../../spawn-edge-bounds";
import {
  gateWindowsTaskVerb,
  SERVICE_REGISTRATION_KEPT_CHANGING_MESSAGE,
  type PermittedWindowsTask,
  type ScheduledTaskXmlQuery,
  type WindowsTaskOwnershipDeps,
  type WindowsTaskVerbRunner,
} from "../windows-task-gate";

// R4 §42: `create.exec` runs under a step budget, `B =
// WINDOWS_TASK_CREATE_BUDGET_MS` (55_000ms), measured on `performance.now()`
// from the moment `exec` is entered (the gate's OWN read, in front of
// `exec`, is off this clock). A step starts only if
// `elapsed + its ceiling <= B`: every confirm-read has ceiling
// `WINDOWS_TASK_OWNERSHIP_READ_BOUND_MS` (25_000ms); `/Create` has ceiling
// `options.timeoutMs`. A step that does not fit throws a `CliError`
// (`E_SERVICE_INSTALL_FAILED`, `SERVICE_REGISTRATION_KEPT_CHANGING_MESSAGE`,
// `details.reason === "budget"`) instead of being attempted.
//
// RED-FIRST against the pre-R4 worktree: `create.exec` has no budget at all
// today, so every case below either creates when it should refuse, or throws
// nothing at all - and the two new spawn-edge-bounds constants import as
// `undefined`, which alone fails every ceiling-arithmetic assertion.

const label = serviceLabelFor("production");
const CALLER_SID = "S-1-5-21-4444-5555-6666-1001";

function taskXml(tag: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <!--${tag}-->
  <Principals><Principal id="A"><UserId>${CALLER_SID}</UserId></Principal></Principals>
  <Actions Context="A"><Exec><Command>x</Command></Exec></Actions>
</Task>`;
}

const ABSENT: ScheduledTaskXmlQuery = { kind: "absent" };
const caller = (tag: string): ScheduledTaskXmlQuery => ({
  kind: "xml",
  xml: taskXml(tag),
});

let clockMs = 0;

beforeEach(() => {
  clockMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clockMs);
});
afterEach(() => {
  vi.restoreAllMocks();
});

interface TimedQuery {
  readonly query: ScheduledTaskXmlQuery;
  /** How long this read takes, added to the clock when it is consumed. */
  readonly delayMs: number;
}

/**
 * A queue of `queryTaskXml` answers. The FIRST entry is the gate's own read,
 * consumed BEFORE `exec` is entered, so its `delayMs` is never applied to the
 * budget clock. Every later entry is a confirm-read inside `exec`, and its
 * `delayMs` is added to the clock when it is consumed (the last entry
 * repeats).
 */
function timedQueueDeps(entries: readonly TimedQuery[]): {
  readonly deps: WindowsTaskOwnershipDeps;
  readonly queryCount: () => number;
} {
  let i = 0;
  return {
    deps: {
      queryTaskXml: async () => {
        const entry = entries[Math.min(i, entries.length - 1)];
        if (i >= 1) clockMs += entry.delayMs;
        i += 1;
        return entry.query;
      },
      callerSid: () => CALLER_SID,
      resolveAccountSid: async () => null,
    },
    queryCount: () => i,
  };
}

function stageMock(delaysMs: readonly number[]): {
  readonly stage: (task: PermittedWindowsTask) => Promise<string>;
  readonly calls: PermittedWindowsTask[];
} {
  const calls: PermittedWindowsTask[] = [];
  const stage = async (task: PermittedWindowsTask): Promise<string> => {
    const delay = delaysMs[Math.min(calls.length, delaysMs.length - 1)] ?? 0;
    clockMs += delay;
    calls.push(task);
    return `/tmp/stage-${calls.length}.xml`;
  };
  return { stage, calls };
}

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

type CreateIfAbsentOutcome = () => Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}>;

const createIfAbsentExits0 =
  (delayMs: number): CreateIfAbsentOutcome =>
  async () => {
    clockMs += delayMs;
    return { stdout: "", stderr: "", exitCode: 0 };
  };
const createIfAbsentRejects =
  (delayMs: number): CreateIfAbsentOutcome =>
  async () => {
    clockMs += delayMs;
    throw new ProcessRunError(
      "schtasks exited 1",
      "schtasks",
      ["/Create"],
      1,
      "",
      "",
    );
  };

function fakeRunner(outcomes: readonly CreateIfAbsentOutcome[]): {
  readonly run: WindowsTaskVerbRunner;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let createIfAbsentCalls = 0;
  const run: WindowsTaskVerbRunner = async (command, args, options) => {
    calls.push({ command, args: [...args] });
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

const RUN_OPTIONS = {
  env: undefined,
  cwd: undefined,
  timeoutMs: 30_000,
  tolerateNonZeroExit: false,
};

async function createGate(deps: WindowsTaskOwnershipDeps) {
  const gate = await gateWindowsTaskVerb(label, "create", deps);
  if (gate.kind !== "permitted") {
    throw new Error(`expected permitted, got ${gate.kind}`);
  }
  return gate;
}

function expectBudgetError(
  caught: unknown,
  reason: "budget" | "stagings",
): void {
  expect(caught).toMatchObject({
    code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
    message: SERVICE_REGISTRATION_KEPT_CHANGING_MESSAGE,
    details: { reason },
  });
}

describe("windows-task-gate: create runs under a step budget (R4)", () => {
  it("the budget and the confirm-read ceiling are the pinned values", () => {
    expect(WINDOWS_TASK_CREATE_BUDGET_MS).toBe(55_000);
    expect(WINDOWS_TASK_OWNERSHIP_READ_BOUND_MS).toBe(25_000);
  });

  it("42a: a confirm-read that takes 26s leaves no room for /Create (would end at 56s)", async () => {
    const { deps, queryCount } = timedQueueDeps([
      { query: caller("v1"), delayMs: 0 }, // gate's own read
      { query: caller("v1"), delayMs: 26_000 }, // confirm-read: matches, but slow
    ]);
    const gate = await createGate(deps);
    const { stage } = stageMock([]);
    const { run, calls } = fakeRunner([createIfAbsentExits0(0)]);

    const caught = await gate.exec(run, stage, RUN_OPTIONS).then(
      () => null,
      (err: unknown) => err,
    );

    expectBudgetError(caught, "budget");
    expect(createCalls(calls)).toHaveLength(0);
    expect(queryCount()).toBe(2);
  });

  it("42b: a change at 20s, then a 10s confirm-read (30s elapsed) leaves no room for /Create", async () => {
    const { deps, queryCount } = timedQueueDeps([
      { query: caller("v1"), delayMs: 0 }, // gate's own read
      { query: caller("v2"), delayMs: 20_000 }, // confirm-read: changed
      { query: caller("v2"), delayMs: 10_000 }, // confirm-read after restage: matches
    ]);
    const gate = await createGate(deps);
    const { stage } = stageMock([]);
    const { run, calls } = fakeRunner([createIfAbsentExits0(0)]);

    const caught = await gate.exec(run, stage, RUN_OPTIONS).then(
      () => null,
      (err: unknown) => err,
    );

    expectBudgetError(caught, "budget");
    expect(createCalls(calls)).toHaveLength(0);
    expect(queryCount()).toBe(3);
  });

  it("42c: staging alone advances the clock to 31s - the confirm-read itself does not fit", async () => {
    const { deps, queryCount } = timedQueueDeps([
      { query: caller("v1"), delayMs: 0 }, // gate's own read
      { query: caller("v1"), delayMs: 0 }, // never consumed
    ]);
    const gate = await createGate(deps);
    const { stage } = stageMock([31_000]);
    const { run, calls } = fakeRunner([createIfAbsentExits0(0)]);

    const caught = await gate.exec(run, stage, RUN_OPTIONS).then(
      () => null,
      (err: unknown) => err,
    );

    expectBudgetError(caught, "budget");
    expect(createCalls(calls)).toHaveLength(0);
    // Only the gate's own read: the confirm-read never fit, so it was never
    // issued.
    expect(queryCount()).toBe(1);
  });

  it("42d: an absent-branch create that rejects after 30s leaves no room for the re-read (would end at 56s)", async () => {
    const { deps, queryCount } = timedQueueDeps([
      { query: ABSENT, delayMs: 0 }, // gate's own read
      { query: ABSENT, delayMs: 1_000 }, // confirm-read: matches absent
      { query: caller("reread"), delayMs: 0 }, // never consumed
    ]);
    const gate = await createGate(deps);
    const { stage } = stageMock([]);
    const { run, calls } = fakeRunner([createIfAbsentRejects(30_000)]);

    const caught = await gate.exec(run, stage, RUN_OPTIONS).then(
      () => null,
      (err: unknown) => err,
    );

    expectBudgetError(caught, "budget");
    expect(createCalls(calls)).toHaveLength(1);
    // Gate's own read + the one confirm-read; the re-read never fit.
    expect(queryCount()).toBe(2);
  });

  describe("42e: in budget", () => {
    it("one fast pass: exactly one /Create, argv unchanged, resolves", async () => {
      const { deps } = timedQueueDeps([
        { query: caller("same"), delayMs: 0 },
        { query: caller("same"), delayMs: 0 },
      ]);
      const gate = await createGate(deps);
      const { stage } = stageMock([]);
      const { run, calls } = fakeRunner([createIfAbsentExits0(0)]);

      const result = await gate.exec(run, stage, RUN_OPTIONS);

      expect(result).toEqual({ kind: "caller", xml: taskXml("same") });
      expect(createCalls(calls)).toHaveLength(1);
      expect(createCalls(calls)[0]?.args).toContain("/F");
    });

    it("two changes then a stable read, each 1s: one /Create, resolves", async () => {
      const { deps, queryCount } = timedQueueDeps([
        { query: caller("v1"), delayMs: 0 },
        { query: caller("v2"), delayMs: 1_000 },
        { query: caller("v3"), delayMs: 1_000 },
        { query: caller("v3"), delayMs: 1_000 },
      ]);
      const gate = await createGate(deps);
      const { stage } = stageMock([]);
      const { run, calls } = fakeRunner([createIfAbsentExits0(0)]);

      const result = await gate.exec(run, stage, RUN_OPTIONS);

      expect(result).toEqual({ kind: "caller", xml: taskXml("v3") });
      expect(createCalls(calls)).toHaveLength(1);
      expect(queryCount()).toBe(4);
    });

    it("a confirm-read that ends at exactly 25s still creates (create ends at 55 = B, inclusive)", async () => {
      const { deps } = timedQueueDeps([
        { query: caller("v1"), delayMs: 0 },
        { query: caller("v1"), delayMs: WINDOWS_TASK_OWNERSHIP_READ_BOUND_MS },
      ]);
      const gate = await createGate(deps);
      const { stage } = stageMock([]);
      const { run, calls } = fakeRunner([createIfAbsentExits0(0)]);

      const result = await gate.exec(run, stage, RUN_OPTIONS);

      expect(result).toEqual({ kind: "caller", xml: taskXml("v1") });
      expect(createCalls(calls)).toHaveLength(1);
    });
  });

  it("42f: the budget error names no SID and no fixture account name", async () => {
    const { deps } = timedQueueDeps([
      { query: caller("v1"), delayMs: 0 },
      { query: caller("v1"), delayMs: 26_000 },
    ]);
    const gate = await createGate(deps);
    const { stage } = stageMock([]);
    const { run } = fakeRunner([createIfAbsentExits0(0)]);

    const caught = await gate.exec(run, stage, RUN_OPTIONS).then(
      () => null,
      (err: unknown) => err,
    );

    const serialized = JSON.stringify(caught);
    expect(/S-1-\d/.test(serialized)).toBe(false);
    expect(serialized).not.toContain(CALLER_SID);
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_ERROR_CODES, CliError } from "../../../runner/errors";
import { serviceLabelFor, windowsTaskName } from "../../label";
import {
  gateWindowsTaskRun,
  gateWindowsTaskVerb,
  isSidShaped,
  parseTaskPrincipalUserId,
  readWindowsTaskOwnership,
  SERVICE_TASK_NOT_OWNED_MESSAGE,
  serviceTaskNotOwnedError,
  type ScheduledTaskXmlQuery,
  type WindowsTaskOwnershipDeps,
  type WindowsTaskVerbRunner,
} from "../windows-task-gate";

// Every line the gate logs, by level, so a test can prove no account
// identifier leaves it above DEBUG.
const logged = vi.hoisted(() => ({
  lines: [] as { level: string; message: string; fields: string }[],
}));
vi.mock("../../../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../logger")>();
  const record =
    (level: string) =>
    (message: string, fields: unknown): void => {
      logged.lines.push({ level, message, fields: JSON.stringify(fields) });
    };
  return {
    ...actual,
    createCliLogger: () => ({
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    }),
  };
});

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}
const W1_DOMAIN = fixture("w1-cli-v1.1.4-task-domain.xml");
const W1_BARE = fixture("w1-cli-v1.1.4-task-bare.xml");

const CALLER_SID = "S-1-5-21-1111-2222-3333-1001";
const OTHER_SID = "S-1-5-21-1111-2222-3333-1002";
const TASK = "\\Traycer\\Host";

function taskXml(principals: string, actionsContext: string | null): string {
  const context = actionsContext === null ? "" : ` Context="${actionsContext}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals>${principals}</Principals>
  <Actions${context}><Exec><Command>x</Command></Exec></Actions>
</Task>`;
}

function principal(id: string, userId: string | null): string {
  const user = userId === null ? "" : `<UserId>${userId}</UserId>`;
  return `<Principal id="${id}">${user}<LogonType>InteractiveToken</LogonType></Principal>`;
}

interface Harness {
  readonly deps: WindowsTaskOwnershipDeps;
  readonly queries: string[];
  readonly resolved: string[];
  readonly hiddenAsked: string[];
}

function harness(options: {
  readonly query: ScheduledTaskXmlQuery;
  readonly callerSid: string | null;
  readonly resolve: (account: string) => string | null;
  readonly hidden: boolean;
}): Harness {
  const queries: string[] = [];
  const resolved: string[] = [];
  const hiddenAsked: string[] = [];
  return {
    queries,
    resolved,
    hiddenAsked,
    deps: {
      queryTaskXml: async (taskName) => {
        queries.push(taskName);
        return options.query;
      },
      callerSid: () => options.callerSid,
      resolveAccountSid: async (account) => {
        resolved.push(account);
        return options.resolve(account);
      },
      taskHiddenFromCaller: async (taskName) => {
        hiddenAsked.push(taskName);
        return options.hidden;
      },
    },
  };
}

beforeEach(() => {
  logged.lines.length = 0;
});

describe("parseTaskPrincipalUserId on the W1 fixtures (a cli-v1.1.4 task names its principal by account name)", () => {
  it("returns the domain-qualified name of the domain fixture", () => {
    expect(parseTaskPrincipalUserId(W1_DOMAIN)).toBe("CONTOSO\\alice");
  });

  it("returns the bare name of the bare fixture", () => {
    expect(parseTaskPrincipalUserId(W1_BARE)).toBe("alice");
  });

  it("returns a SID principal as written, and unescapes XML entities in a name", () => {
    expect(
      parseTaskPrincipalUserId(
        taskXml(principal("Author", CALLER_SID), "Author"),
      ),
    ).toBe(CALLER_SID);
    expect(
      parseTaskPrincipalUserId(
        taskXml(principal("Author", "DOM&amp;CO\\a"), "Author"),
      ),
    ).toBe("DOM&CO\\a");
  });

  it("picks the principal the Actions Context names among several", () => {
    const xml = taskXml(
      principal("Other", OTHER_SID) + principal("Author", CALLER_SID),
      "Author",
    );
    expect(parseTaskPrincipalUserId(xml)).toBe(CALLER_SID);
  });

  it("with no Context takes the only principal, and none of several", () => {
    expect(
      parseTaskPrincipalUserId(taskXml(principal("A", CALLER_SID), null)),
    ).toBe(CALLER_SID);
    expect(
      parseTaskPrincipalUserId(
        taskXml(principal("A", CALLER_SID) + principal("B", OTHER_SID), null),
      ),
    ).toBeNull();
  });

  it("returns null for no Principals block, a Context naming nothing, a principal without a UserId, or an empty UserId", () => {
    expect(parseTaskPrincipalUserId("<Task></Task>")).toBeNull();
    expect(
      parseTaskPrincipalUserId(taskXml(principal("A", CALLER_SID), "Nope")),
    ).toBeNull();
    expect(
      parseTaskPrincipalUserId(taskXml(principal("A", null), "A")),
    ).toBeNull();
    expect(
      parseTaskPrincipalUserId(taskXml(principal("A", "  "), "A")),
    ).toBeNull();
  });

  it("isSidShaped accepts S-1-… and nothing that is a name", () => {
    expect(isSidShaped(CALLER_SID)).toBe(true);
    expect(isSidShaped("s-1-5-18")).toBe(true);
    expect(isSidShaped("CONTOSO\\alice")).toBe(false);
    expect(isSidShaped("S-1-")).toBe(false);
  });
});

describe("readWindowsTaskOwnership", () => {
  it("the domain W1 name resolving to the caller's SID is the caller's, and hands back the XML it read", async () => {
    const h = harness({
      query: { kind: "xml", xml: W1_DOMAIN },
      callerSid: CALLER_SID,
      resolve: (account) => (account === "CONTOSO\\alice" ? CALLER_SID : null),
      hidden: false,
    });
    expect(await readWindowsTaskOwnership(TASK, h.deps)).toEqual({
      kind: "caller",
      xml: W1_DOMAIN,
    });
    expect(h.resolved).toEqual(["CONTOSO\\alice"]);
  });

  it("a name resolving to another SID is other-owner", async () => {
    const h = harness({
      query: { kind: "xml", xml: W1_DOMAIN },
      callerSid: CALLER_SID,
      resolve: () => OTHER_SID,
      hidden: false,
    });
    expect(await readWindowsTaskOwnership(TASK, h.deps)).toMatchObject({
      kind: "not-owned",
      reason: "other-owner",
    });
  });

  it("a name that resolves to nothing is unconfirmed (fail closed)", async () => {
    const h = harness({
      query: { kind: "xml", xml: W1_DOMAIN },
      callerSid: CALLER_SID,
      resolve: () => null,
      hidden: false,
    });
    expect(await readWindowsTaskOwnership(TASK, h.deps)).toMatchObject({
      kind: "not-owned",
      reason: "unconfirmed",
    });
  });

  it("the bare W1 name and a `.\\alice` name go through the resolver as written", async () => {
    const bare = harness({
      query: { kind: "xml", xml: W1_BARE },
      callerSid: CALLER_SID,
      resolve: () => CALLER_SID,
      hidden: false,
    });
    expect((await readWindowsTaskOwnership(TASK, bare.deps)).kind).toBe(
      "caller",
    );
    expect(bare.resolved).toEqual(["alice"]);
    const dotted = harness({
      query: {
        kind: "xml",
        xml: taskXml(principal("Author", ".\\alice"), "Author"),
      },
      callerSid: CALLER_SID,
      resolve: () => CALLER_SID,
      hidden: false,
    });
    expect((await readWindowsTaskOwnership(TASK, dotted.deps)).kind).toBe(
      "caller",
    );
    expect(dotted.resolved).toEqual([".\\alice"]);
  });

  it("a SID principal is compared case-insensitively and never resolved", async () => {
    const xml = taskXml(
      principal("Author", CALLER_SID.toLowerCase()),
      "Author",
    );
    const h = harness({
      query: { kind: "xml", xml },
      callerSid: CALLER_SID,
      resolve: () => {
        throw new Error("a SID principal is never looked up");
      },
      hidden: false,
    });
    expect((await readWindowsTaskOwnership(TASK, h.deps)).kind).toBe("caller");
    expect(h.resolved).toEqual([]);
    const other = harness({
      query: {
        kind: "xml",
        xml: taskXml(principal("Author", OTHER_SID), "Author"),
      },
      callerSid: CALLER_SID,
      resolve: () => null,
      hidden: false,
    });
    expect(await readWindowsTaskOwnership(TASK, other.deps)).toMatchObject({
      kind: "not-owned",
      reason: "other-owner",
    });
  });

  it("a failed query, no principal, unparseable XML and an unknown caller SID are each unconfirmed", async () => {
    const cases: readonly {
      query: ScheduledTaskXmlQuery;
      callerSid: string | null;
    }[] = [
      {
        query: { kind: "failed", reason: "access denied" },
        callerSid: CALLER_SID,
      },
      {
        query: { kind: "xml", xml: taskXml(principal("A", null), "A") },
        callerSid: CALLER_SID,
      },
      { query: { kind: "xml", xml: "not xml at all" }, callerSid: CALLER_SID },
      { query: { kind: "xml", xml: W1_DOMAIN }, callerSid: null },
    ];
    for (const c of cases) {
      const h = harness({
        query: c.query,
        callerSid: c.callerSid,
        resolve: () => CALLER_SID,
        hidden: false,
      });
      expect(await readWindowsTaskOwnership(TASK, h.deps)).toMatchObject({
        kind: "not-owned",
        reason: "unconfirmed",
      });
    }
  });

  it("an absent task is absent, without resolving anything", async () => {
    const h = harness({
      query: { kind: "absent" },
      callerSid: CALLER_SID,
      resolve: () => CALLER_SID,
      hidden: false,
    });
    expect(await readWindowsTaskOwnership(TASK, h.deps)).toEqual({
      kind: "absent",
    });
    expect(h.resolved).toEqual([]);
  });

  it("a task the query finds absent or fails on, but that is hidden from the caller, is another account's", async () => {
    const queries: readonly ScheduledTaskXmlQuery[] = [
      { kind: "absent" },
      { kind: "failed", reason: "the system cannot find the path specified" },
    ];
    for (const query of queries) {
      const h = harness({
        query,
        callerSid: CALLER_SID,
        resolve: () => CALLER_SID,
        hidden: true,
      });
      expect(await readWindowsTaskOwnership(TASK, h.deps)).toMatchObject({
        kind: "not-owned",
        reason: "other-owner",
      });
      expect(h.hiddenAsked).toEqual([TASK]);
    }
  });

  it("an absent task that is not hidden stays absent, and a failed query stays unconfirmed", async () => {
    const absent = harness({
      query: { kind: "absent" },
      callerSid: CALLER_SID,
      resolve: () => CALLER_SID,
      hidden: false,
    });
    expect(await readWindowsTaskOwnership(TASK, absent.deps)).toEqual({
      kind: "absent",
    });
    const failed = harness({
      query: { kind: "failed", reason: "access denied" },
      callerSid: CALLER_SID,
      resolve: () => CALLER_SID,
      hidden: false,
    });
    expect(await readWindowsTaskOwnership(TASK, failed.deps)).toMatchObject({
      kind: "not-owned",
      reason: "unconfirmed",
    });
  });

  it("a task whose XML was read is never probed for being hidden", async () => {
    const h = harness({
      query: { kind: "xml", xml: taskXml(principal("A", CALLER_SID), "A") },
      callerSid: CALLER_SID,
      resolve: () => CALLER_SID,
      hidden: true,
    });
    expect((await readWindowsTaskOwnership(TASK, h.deps)).kind).toBe("caller");
    expect(h.hiddenAsked).toEqual([]);
  });

  it("reads the task's principal again for every call: one /Query /XML per read, none cached", async () => {
    const h = harness({
      query: { kind: "xml", xml: taskXml(principal("A", CALLER_SID), "A") },
      callerSid: CALLER_SID,
      resolve: () => CALLER_SID,
      hidden: false,
    });
    await readWindowsTaskOwnership(TASK, h.deps);
    await readWindowsTaskOwnership(TASK, h.deps);
    await readWindowsTaskOwnership(TASK, h.deps);
    expect(h.queries).toEqual([TASK, TASK, TASK]);
  });
});

describe("gateWindowsTaskVerb and the refusal", () => {
  const label = serviceLabelFor("production");

  it("hands back an executor for an absent or the caller's task, and the refusal for another user's", async () => {
    const absent = await gateWindowsTaskVerb(
      label,
      "end",
      harness({
        query: { kind: "absent" },
        callerSid: CALLER_SID,
        resolve: () => null,
        hidden: false,
      }).deps,
    );
    expect(absent.kind).toBe("permitted");
    const own = await gateWindowsTaskVerb(
      label,
      "end",
      harness({
        query: { kind: "xml", xml: taskXml(principal("A", CALLER_SID), "A") },
        callerSid: CALLER_SID,
        resolve: () => null,
        hidden: false,
      }).deps,
    );
    expect(own.kind).toBe("permitted");
    const foreign = await gateWindowsTaskVerb(
      label,
      "create",
      harness({
        query: { kind: "xml", xml: taskXml(principal("A", OTHER_SID), "A") },
        callerSid: CALLER_SID,
        resolve: () => null,
        hidden: false,
      }).deps,
    );
    expect(foreign.kind).toBe("not-owned");
  });

  it("a permitted verb issues exactly the schtasks argv, through the runner it is given", async () => {
    const gate = await gateWindowsTaskVerb(
      label,
      "end",
      harness({
        query: { kind: "absent" },
        callerSid: CALLER_SID,
        resolve: () => null,
        hidden: false,
      }).deps,
    );
    if (gate.kind !== "permitted") throw new Error("unreachable");
    const runner = vi.fn<WindowsTaskVerbRunner>(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    await gate.exec(runner, {
      env: undefined,
      cwd: undefined,
      timeoutMs: 1,
      tolerateNonZeroExit: true,
    });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0]).toBe("schtasks");
    expect(runner.mock.calls[0]?.[1]).toEqual([
      "/End",
      "/TN",
      windowsTaskName(label),
    ]);
  });

  it("the refusal is E_SERVICE_TASK_NOT_OWNED, says another Windows user, and its details are {task, verb, reason} only", async () => {
    const error = serviceTaskNotOwnedError(label, "run", "other-owner");
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe(CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED);
    expect(error.code).toBe("E_SERVICE_TASK_NOT_OWNED");
    expect(error.message).toBe(SERVICE_TASK_NOT_OWNED_MESSAGE);
    expect(error.message).toContain("owned by another Windows user");
    expect(error.details).toEqual({
      task: windowsTaskName(label),
      verb: "run",
      reason: "other-owner",
    });
  });

  // T08 ruling 13: "owned by another Windows user" is a claim about the
  // task's owner, and a read that confirmed nothing has no owner to claim.
  // Same code, same behaviour (fail closed, nothing written); the copy, the
  // INFO line and `details.reason` say which it was.
  it("an unconfirmed refusal keeps the code but never says another Windows user: it says ownership could not be confirmed", async () => {
    const error = serviceTaskNotOwnedError(label, "run", "unconfirmed");
    expect(error.code).toBe("E_SERVICE_TASK_NOT_OWNED");
    expect(error.message).toBe(
      "Traycer couldn't confirm that the Traycer Host task on this PC belongs to your Windows account, so it left the task alone. Try again, or run `traycer host doctor`.",
    );
    expect(error.message).not.toContain("another Windows user");
    expect(error.details).toEqual({
      task: windowsTaskName(label),
      verb: "run",
      reason: "unconfirmed",
    });
  });

  it("through the gate: a task that cannot be read is refused with the unconfirmed copy, and no INFO line says it is owned by another user", async () => {
    const gate = await gateWindowsTaskVerb(
      label,
      "create",
      harness({
        query: { kind: "failed", reason: "access denied" },
        callerSid: CALLER_SID,
        resolve: () => CALLER_SID,
        hidden: false,
      }).deps,
    );
    if (gate.kind !== "not-owned") throw new Error("unreachable");
    expect(gate.reason).toBe("unconfirmed");
    expect(gate.error.message).not.toContain("another Windows user");
    expect(gate.error.message).toContain("couldn't confirm");
    expect(gate.error.details).toMatchObject({ reason: "unconfirmed" });
    const infos = logged.lines.filter((line) => line.level === "info");
    expect(infos).toHaveLength(1);
    expect(infos[0]?.message).not.toContain("owned by another user");
    expect(infos[0]?.message).toContain("could not be confirmed");
  });

  it("through the gate: another account's task keeps the other-owner copy and INFO line", async () => {
    const gate = await gateWindowsTaskVerb(
      label,
      "create",
      harness({
        query: {
          kind: "xml",
          xml: taskXml(principal("Author", OTHER_SID), "Author"),
        },
        callerSid: CALLER_SID,
        resolve: () => null,
        hidden: false,
      }).deps,
    );
    if (gate.kind !== "not-owned") throw new Error("unreachable");
    expect(gate.error.message).toBe(SERVICE_TASK_NOT_OWNED_MESSAGE);
    expect(gate.error.details).toMatchObject({ reason: "other-owner" });
    const infos = logged.lines.filter((line) => line.level === "info");
    expect(infos[0]?.message).toContain("owned by another user");
  });

  it("names no account anywhere: not in the refusal, and no log line above DEBUG carries the principal or either SID", async () => {
    const gate = await gateWindowsTaskVerb(
      label,
      "delete",
      harness({
        query: { kind: "xml", xml: W1_DOMAIN },
        callerSid: CALLER_SID,
        resolve: () => OTHER_SID,
        hidden: false,
      }).deps,
    );
    if (gate.kind !== "not-owned") throw new Error("unreachable");
    const everything = JSON.stringify({
      message: gate.error.message,
      details: gate.error.details,
      lines: logged.lines.filter((line) => line.level !== "debug"),
    });
    for (const secret of [CALLER_SID, OTHER_SID, "alice", "CONTOSO"]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toMatch(/S-1-\d/);
    // The refusal is logged once at INFO, and the reason for it only at DEBUG.
    expect(logged.lines.filter((line) => line.level === "info")).toHaveLength(
      1,
    );
    expect(
      logged.lines.filter(
        (line) => line.level === "warn" || line.level === "error",
      ),
    ).toEqual([]);
  });

  // The INFO line carries WHICH read branch decided the verdict, so a field
  // report says from cli.log alone whether the definition read failed,
  // answered without a principal, or resolved to someone else. One of a fixed
  // set of words - no free text - which is what keeps it INFO-safe.
  it("the INFO line names the read branch that decided the verdict, by probe", async () => {
    const cases: readonly {
      readonly query: ScheduledTaskXmlQuery;
      readonly callerSid: string | null;
      readonly resolve: (account: string) => string | null;
      readonly probe: string;
      readonly reason: string;
    }[] = [
      {
        query: { kind: "failed", reason: "exit 4, 0x80070005" },
        callerSid: CALLER_SID,
        resolve: () => null,
        probe: "definition-read-failed",
        reason: "unconfirmed",
      },
      {
        query: { kind: "xml", xml: taskXml(principal("A", null), "A") },
        callerSid: CALLER_SID,
        resolve: () => null,
        probe: "no-principal",
        reason: "unconfirmed",
      },
      {
        query: { kind: "xml", xml: taskXml(principal("A", CALLER_SID), "A") },
        callerSid: null,
        resolve: () => null,
        probe: "caller-sid-unreadable",
        reason: "unconfirmed",
      },
      {
        query: { kind: "xml", xml: W1_BARE },
        callerSid: CALLER_SID,
        resolve: () => null,
        probe: "principal-name-unresolved",
        reason: "unconfirmed",
      },
      {
        query: { kind: "xml", xml: taskXml(principal("A", OTHER_SID), "A") },
        callerSid: CALLER_SID,
        resolve: () => null,
        probe: "principal-other-sid",
        reason: "other-owner",
      },
      {
        query: { kind: "xml", xml: W1_BARE },
        callerSid: CALLER_SID,
        resolve: () => OTHER_SID,
        probe: "principal-name-other-account",
        reason: "other-owner",
      },
    ];
    for (const c of cases) {
      logged.lines.length = 0;
      const gate = await gateWindowsTaskVerb(
        label,
        "create",
        harness({
          query: c.query,
          callerSid: c.callerSid,
          resolve: c.resolve,
          hidden: false,
        }).deps,
      );
      expect({ probe: c.probe, kind: gate.kind }).toEqual({
        probe: c.probe,
        kind: "not-owned",
      });
      const infos = logged.lines.filter((line) => line.level === "info");
      expect(infos).toHaveLength(1);
      expect(JSON.parse(infos[0]?.fields ?? "null")).toEqual({
        task: windowsTaskName(label),
        verb: "create",
        reason: c.reason,
        probe: c.probe,
      });
    }
  });

  it("a hidden task's probe says so, and it is another account's", async () => {
    const gate = await gateWindowsTaskVerb(
      label,
      "delete",
      harness({
        query: { kind: "failed", reason: "access denied" },
        callerSid: CALLER_SID,
        resolve: () => null,
        hidden: true,
      }).deps,
    );
    if (gate.kind !== "not-owned") throw new Error("unreachable");
    expect(gate.reason).toBe("other-owner");
    const infos = logged.lines.filter((line) => line.level === "info");
    expect(JSON.parse(infos[0]?.fields ?? "null")).toMatchObject({
      probe: "hidden-from-caller",
    });
  });
});

// `/Run` changes no definition and creates and destroys nothing, so it is the
// one verb whose refusal policy on a task that could not be ATTRIBUTED
// differs: it is issued, and Task Scheduler's own permissions on the task
// decide it. A task resolved to another account is still refused.
describe("gateWindowsTaskRun: the write-free verb's own door", () => {
  const label = serviceLabelFor("production");

  const runOptions = {
    env: undefined,
    cwd: undefined,
    timeoutMs: 1,
    tolerateNonZeroExit: false,
  };

  it("the caller's own task is permitted, carrying the XML the verdict was read from", async () => {
    const xml = taskXml(principal("A", CALLER_SID), "A");
    const gate = await gateWindowsTaskRun(
      label,
      harness({
        query: { kind: "xml", xml },
        callerSid: CALLER_SID,
        resolve: () => null,
        hidden: false,
      }).deps,
    );
    if (gate.kind !== "permitted") throw new Error("unreachable");
    expect(gate.task).toEqual({ kind: "caller", xml });
    expect(logged.lines).toEqual([]);
  });

  it("a task whose owner could not be confirmed issues the /Run, and says so once at INFO with its probe", async () => {
    const gate = await gateWindowsTaskRun(
      label,
      harness({
        query: { kind: "failed", reason: "exit 4, 0x80070005" },
        callerSid: CALLER_SID,
        resolve: () => null,
        hidden: false,
      }).deps,
    );
    if (gate.kind !== "permitted") throw new Error("unreachable");
    // A definition that could not be read at all leaves `<Enabled>` genuinely
    // unanswered, and the verdict says so rather than carry someone else's.
    expect(gate.task).toEqual({ kind: "unattributed", xml: null });
    const run = vi.fn<WindowsTaskVerbRunner>(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    await gate.exec(run, runOptions);
    expect(run.mock.calls[0]?.[0]).toBe("schtasks");
    expect(run.mock.calls[0]?.[1]).toEqual([
      "/Run",
      "/TN",
      windowsTaskName(label),
    ]);
    const infos = logged.lines.filter((line) => line.level === "info");
    expect(infos).toHaveLength(1);
    expect(infos[0]?.message).toContain("starting it anyway");
    expect(infos[0]?.message).not.toContain("another Windows user");
    expect(JSON.parse(infos[0]?.fields ?? "null")).toEqual({
      task: windowsTaskName(label),
      verb: "run",
      reason: "unconfirmed",
      probe: "definition-read-failed",
    });
  });

  // Ownership being undecided is a different question from the definition
  // being unreadable: three of the four unconfirmed verdicts are read OFF the
  // XML, so the verdict carries it and `<Enabled>` is still answerable from
  // the read that already happened.
  it("a task whose owner could not be confirmed FROM its XML carries that XML", async () => {
    const xml = taskXml(principal("A", CALLER_SID), "A");
    const gate = await gateWindowsTaskRun(
      label,
      harness({
        query: { kind: "xml", xml },
        callerSid: null,
        resolve: () => null,
        hidden: false,
      }).deps,
    );
    if (gate.kind !== "permitted") throw new Error("unreachable");
    expect(gate.task).toEqual({ kind: "unattributed", xml });
  });

  // The REFUSE path's own field classification: `/Run` refuses only when the
  // read ATTRIBUTED the task to another account (`other-owner`), and the
  // sibling PERMIT-path test above pins the INFO line's fields for the
  // unconfirmed probes - nothing did the same here. Table-driven over the
  // probes that produce `other-owner`, so a new one is covered automatically.
  it('the REFUSE path\'s INFO line is {task, verb: "run", reason: "other-owner", probe}, by probe, naming no account', async () => {
    const cases: readonly {
      readonly query: ScheduledTaskXmlQuery;
      readonly callerSid: string | null;
      readonly resolve: (account: string) => string | null;
      readonly hidden: boolean;
      readonly probe: string;
    }[] = [
      {
        // Task Scheduler lets a task's own principal read it, so a task
        // hidden from this account has a principal and it is not this
        // caller - refused as `other-owner`, not `unconfirmed`.
        query: { kind: "absent" },
        callerSid: CALLER_SID,
        resolve: () => null,
        hidden: true,
        probe: "hidden-from-caller",
      },
      {
        query: { kind: "xml", xml: taskXml(principal("A", OTHER_SID), "A") },
        callerSid: CALLER_SID,
        resolve: () => null,
        hidden: false,
        probe: "principal-other-sid",
      },
      {
        query: { kind: "xml", xml: W1_BARE },
        callerSid: CALLER_SID,
        resolve: () => OTHER_SID,
        hidden: false,
        probe: "principal-name-other-account",
      },
    ];
    for (const c of cases) {
      logged.lines.length = 0;
      const gate = await gateWindowsTaskRun(
        label,
        harness({
          query: c.query,
          callerSid: c.callerSid,
          resolve: c.resolve,
          hidden: c.hidden,
        }).deps,
      );
      expect({ probe: c.probe, kind: gate.kind }).toEqual({
        probe: c.probe,
        kind: "not-owned",
      });
      if (gate.kind !== "not-owned") throw new Error("unreachable");
      expect(gate.error.message).toBe(SERVICE_TASK_NOT_OWNED_MESSAGE);
      expect(gate.error.details).toEqual({
        task: windowsTaskName(label),
        verb: "run",
        reason: "other-owner",
      });
      const infos = logged.lines.filter((line) => line.level === "info");
      expect(infos).toHaveLength(1);
      expect(JSON.parse(infos[0]?.fields ?? "null")).toEqual({
        task: windowsTaskName(label),
        verb: "run",
        reason: "other-owner",
        probe: c.probe,
      });
      const everything = JSON.stringify(
        logged.lines.filter((line) => line.level !== "debug"),
      );
      expect(everything).not.toMatch(/S-1-\d/);
      expect(
        logged.lines.filter(
          (line) => line.level === "warn" || line.level === "error",
        ),
      ).toEqual([]);
    }
  });

  it("an absent task is permitted: the /Run it issues is the scheduler's own answer about it", async () => {
    const gate = await gateWindowsTaskRun(
      label,
      harness({
        query: { kind: "absent" },
        callerSid: CALLER_SID,
        resolve: () => null,
        hidden: false,
      }).deps,
    );
    if (gate.kind !== "permitted") throw new Error("unreachable");
    expect(gate.task).toEqual({ kind: "absent" });
  });
});

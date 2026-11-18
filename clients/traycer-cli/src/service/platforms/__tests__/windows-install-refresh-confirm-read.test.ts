import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createWindowsController,
  refreshWindowsServiceDefinition,
  setWindowsDefinitionDepsForTests,
  setWindowsStartEvidenceDepsForTests,
  setWindowsTaskInstallDepsForTests,
  setWindowsTaskUserSidReaderForTests,
  type ProcessRunner,
  type ScheduledTaskXmlQuery,
} from "../windows";
import type { SpawnEvidenceBaseline } from "../../../host/spawn-evidence";
import { isServiceTaskNotOwnedError } from "../windows-task-gate";
import {
  runWithLeaseAtServiceSpawnEdge,
  type ServiceSpawnEdgeLease,
} from "../../spawn-edge";
import { serviceLabelFor } from "../../label";
import { withServiceInstallReport } from "../../registration-repair";

// R3 §D: `installService`/`refreshWindowsServiceDefinition` now stage the
// task XML through `create.exec`'s new (read -> stage -> confirm-read ->
// verb) TOCTOU loop rather than a single read used for the whole plan. These
// tests drive the REAL controller/refresh through a fake `queryTaskXml` that
// can answer differently between the gate's own read and later confirm-reads
// - the exact race the TOCTOU fix closes - and assert on the observable
// schtasks argv and the RETURNED (confirm) task, not on internal call
// counts the brief does not pin at this layer.
//
// RED-FIRST against the pre-R3 snapshot: `installService` and
// `refreshWindowsServiceDefinition` both plan and decide entirely from their
// ONE gate read there, and `create.exec` takes an `xmlPath: string`
// (not a stage callback), so none of these tests' assertions - a second
// `stageTaskDefinition` call, a returned confirm task, a decision keyed off
// the RETURNED task rather than the first read - can be satisfied.

const TEST_HOME = mkdtempSync(
  join(tmpdir(), "traycer-windows-toctou-install-"),
);
vi.mock("../../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../store/paths")>();
  return {
    ...actual,
    cliInstallHomeDir: (environment: string) => join(TEST_HOME, environment),
  };
});
vi.mock("../../../host/pid-metadata", () => ({
  readHostPidMetadata: async () => null,
  removeHostPidMetadata: async () => undefined,
  readHostPidMetadataEvidence: async () => ({ kind: "absent" as const }),
}));

afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

const CALLER_SID = "S-1-5-21-1000-2000-3000-1001";
const OTHER_SID = "S-1-5-21-1000-2000-3000-1002";

function taskXml(sid: string, enabled: boolean | null): string {
  const settings =
    enabled === null ? "" : `<Enabled>${enabled ? "true" : "false"}</Enabled>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals><Principal id="Author"><UserId>${sid}</UserId></Principal></Principals>
  <Settings>${settings}<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings>
  <Actions Context="Author"><Exec><Command>C:\\traycer.exe</Command><Arguments>host start</Arguments></Exec></Actions>
</Task>`;
}

// For refresh (test 34): the task's `<Exec>` already runs THIS command with
// THIS argument line (direct-action, launcher-less), and `predictCli`/
// `resolveCli` below resolve to the SAME command - so the plan's only
// staleness is the CONVERSION to the wscript-launcher form
// (`plan.invocationUnchanged === true`), which never touches the
// CLI-invocation-record transaction. This mirrors
// `windows-definition-refresh.test.ts`'s own W1 fixture exactly, so these
// tests exercise the confirm-read alone, not an unrelated record-txn path.
const REFRESH_CLI_COMMAND = "C:\\Program Files\\Traycer\\traycer.exe";
const REFRESH_ARGUMENTS_LINE = '"host" "start"';
function refreshFixtureXml(sid: string, enabled: boolean): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals><Principal id="Author"><UserId>${sid}</UserId></Principal></Principals>
  <Settings><Enabled>${enabled ? "true" : "false"}</Enabled></Settings>
  <Actions Context="Author"><Exec><Command>${REFRESH_CLI_COMMAND}</Command><Arguments>${REFRESH_ARGUMENTS_LINE}</Arguments></Exec></Actions>
</Task>`;
}

const ABSENT: ScheduledTaskXmlQuery = { kind: "absent" };
const OTHER_TASK: ScheduledTaskXmlQuery = {
  kind: "xml",
  xml: taskXml(OTHER_SID, true),
};

/** A queue of `queryTaskXml` answers, consumed one per call (last repeats). */
function queuedQuery(queries: readonly ScheduledTaskXmlQuery[]): {
  queryTaskXml: () => Promise<ScheduledTaskXmlQuery>;
  count: () => number;
} {
  let i = 0;
  return {
    queryTaskXml: async () => {
      const q = queries[Math.min(i, queries.length - 1)];
      i += 1;
      return q;
    },
    count: () => i,
  };
}

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}
function recordingRunner(): { run: ProcessRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const run: ProcessRunner = async (command, args) => {
    calls.push({ command, args: [...args] });
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
function runCalls(calls: readonly RecordedCall[]): readonly RecordedCall[] {
  return calls.filter((c) => c.command === "schtasks" && c.args[0] === "/Run");
}

function emptySpawnBaseline(): SpawnEvidenceBaseline {
  return {
    log: {
      path: "/tmp/host.log",
      exists: false,
      size: 0,
      dev: null,
      ino: null,
      mtimeMs: null,
    },
    pidMetadata: {
      path: "/tmp/pid.json",
      exists: false,
      mtimeMs: null,
      pid: null,
    },
  };
}

beforeEach(() => {
  setWindowsTaskInstallDepsForTests(null);
  // /Run verification never has spawn evidence to find here - none of these
  // tests care about start success, only about the schtasks argv the
  // confirm-read drives - so the evidence wait is instant rather than the
  // real polling window.
  setWindowsStartEvidenceDepsForTests({
    captureBaseline: async () => emptySpawnBaseline(),
    createEvidenceReader: () => ({ collect: async () => null }),
    sleep: async () => undefined,
    verifyTimeoutMs: 20,
    verifyPollMs: 5,
  });
});
afterEach(() => {
  setWindowsDefinitionDepsForTests(null);
  setWindowsTaskInstallDepsForTests(null);
  setWindowsTaskUserSidReaderForTests(null);
  setWindowsStartEvidenceDepsForTests(null);
});

describe("test 31: a disable injected mid-staging is carried, not the stale first read", () => {
  it("re-stages with settingsEnabled:false, /Create /F exactly once, 0 /Run, and the install report says keptDisabled", async () => {
    setWindowsTaskUserSidReaderForTests(() => CALLER_SID);
    const { queryTaskXml } = queuedQuery([
      { kind: "xml", xml: taskXml(CALLER_SID, true) }, // gate's own read: enabled
      { kind: "xml", xml: taskXml(CALLER_SID, false) }, // confirm-read: now disabled
    ]);
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => {
        throw new Error("not used");
      },
      resolveCli: async () => {
        throw new Error("not used");
      },
    });
    const stageCalls: boolean[] = [];
    setWindowsTaskInstallDepsForTests({
      stageTaskDefinition: async (_options, _userId, settingsEnabled) => {
        stageCalls.push(settingsEnabled);
        return {
          tmpDir: "/tmp/stage-dir",
          xmlPath: `/tmp/stage-${stageCalls.length}.xml`,
        };
      },
      removeStagedTaskDefinition: async () => undefined,
    });
    const { run, calls } = recordingRunner();
    const controller = createWindowsController(run, { now: () => 0 });

    const report = await withServiceInstallReport(() =>
      controller.install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      }),
    );

    expect(stageCalls).toEqual([true, false]);
    expect(withF(calls)).toHaveLength(1);
    expect(runCalls(calls)).toHaveLength(0);
    expect(report.keptDisabled).toBe(true);
  });

  it("wrapped in the real spawn-edge lease: the install edge publishes once, and no /Run means waitForSpawn is never called (the lease is cancelled)", async () => {
    setWindowsTaskUserSidReaderForTests(() => CALLER_SID);
    const { queryTaskXml } = queuedQuery([
      { kind: "xml", xml: taskXml(CALLER_SID, true) },
      { kind: "xml", xml: taskXml(CALLER_SID, false) },
    ]);
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => {
        throw new Error("not used");
      },
      resolveCli: async () => {
        throw new Error("not used");
      },
    });
    let stageCount = 0;
    setWindowsTaskInstallDepsForTests({
      stageTaskDefinition: async () => {
        stageCount += 1;
        return {
          tmpDir: "/tmp/stage-dir",
          xmlPath: `/tmp/stage-${stageCount}.xml`,
        };
      },
      removeStagedTaskDefinition: async () => undefined,
    });
    const { run } = recordingRunner();
    const controller = createWindowsController(run, { now: () => 0 });
    const waitForSpawnMock = vi.fn(async () => undefined);
    const cancelMock = vi.fn(async () => undefined);
    let published = false;
    const publish = async (): Promise<ServiceSpawnEdgeLease> => {
      published = true;
      return { waitForSpawn: waitForSpawnMock, cancel: cancelMock };
    };

    await runWithLeaseAtServiceSpawnEdge(publish, () =>
      controller.install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      }),
    );

    expect(published).toBe(true);
    expect(waitForSpawnMock).not.toHaveBeenCalled();
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });
});

describe("test 32: an enable injected mid-staging (the reverse) reaches /Run", () => {
  it("re-stages with settingsEnabled:true; /Create /F then /Run; the lease publishes once, before /Run", async () => {
    setWindowsTaskUserSidReaderForTests(() => CALLER_SID);
    const { queryTaskXml } = queuedQuery([
      { kind: "xml", xml: taskXml(CALLER_SID, false) }, // gate's own read: disabled
      { kind: "xml", xml: taskXml(CALLER_SID, true) }, // confirm-read: now enabled
    ]);
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => {
        throw new Error("not used");
      },
      resolveCli: async () => {
        throw new Error("not used");
      },
    });
    const stageCalls: boolean[] = [];
    setWindowsTaskInstallDepsForTests({
      stageTaskDefinition: async (_options, _userId, settingsEnabled) => {
        stageCalls.push(settingsEnabled);
        return {
          tmpDir: "/tmp/stage-dir",
          xmlPath: `/tmp/stage-${stageCalls.length}.xml`,
        };
      },
      removeStagedTaskDefinition: async () => undefined,
    });
    const { run, calls } = recordingRunner();
    const controller = createWindowsController(run, { now: () => 0 });
    let publishCalls = 0;
    const publishOrder: string[] = [];
    const publish = async (): Promise<null> => {
      publishCalls += 1;
      publishOrder.push("publish");
      return null;
    };
    // This is the one test in this file that reaches a real `/Run`: give it
    // spawn evidence so `runTaskAndVerifyStart` resolves instead of timing
    // out against the file-level "no evidence" default.
    setWindowsStartEvidenceDepsForTests({
      captureBaseline: async () => emptySpawnBaseline(),
      createEvidenceReader: () => ({
        collect: async () => ({
          kind: "starting-marker",
          reason: "post-baseline starting marker",
          marker: null,
          pid: null,
        }),
      }),
      sleep: async () => undefined,
      verifyTimeoutMs: 5_000,
      verifyPollMs: 1,
    });

    await runWithLeaseAtServiceSpawnEdge(publish, () =>
      controller.install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      }),
    );

    expect(stageCalls).toEqual([false, true]);
    expect(withF(calls)).toHaveLength(1);
    expect(runCalls(calls)).toHaveLength(1);
    // /Create /F happens before /Run.
    const createIndex = calls.findIndex((c) => c.args[0] === "/Create");
    const runIndex = calls.findIndex((c) => c.args[0] === "/Run");
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBeGreaterThan(createIndex);
    expect(publishCalls).toBe(1);
  });
});

describe("test 33: a task that becomes another account's between staging and the verb", () => {
  it("throws E_SERVICE_TASK_NOT_OWNED as itself, 0 /Create, and cleans up the staged temp dir(s)", async () => {
    setWindowsTaskUserSidReaderForTests(() => CALLER_SID);
    const { queryTaskXml } = queuedQuery([
      { kind: "xml", xml: taskXml(CALLER_SID, true) }, // gate's own read: caller's
      OTHER_TASK, // confirm-read: another account's
    ]);
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => {
        throw new Error("not used");
      },
      resolveCli: async () => {
        throw new Error("not used");
      },
    });
    const removedDirs: string[] = [];
    let stageCount = 0;
    setWindowsTaskInstallDepsForTests({
      stageTaskDefinition: async () => {
        stageCount += 1;
        return {
          tmpDir: `/tmp/stage-dir-${stageCount}`,
          xmlPath: `/tmp/stage-${stageCount}.xml`,
        };
      },
      removeStagedTaskDefinition: async (tmpDir) => {
        removedDirs.push(tmpDir);
      },
    });
    const { run, calls } = recordingRunner();
    const controller = createWindowsController(run, { now: () => 0 });

    const caught: unknown = await controller
      .install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(isServiceTaskNotOwnedError(caught)).toBe(true);
    expect(createCalls(calls)).toHaveLength(0);
    expect(removedDirs.length).toBeGreaterThanOrEqual(1);
  });
});

describe("test 34: refresh's confirm-read", () => {
  const label = serviceLabelFor("staging-refresh");

  beforeEach(() => {
    setWindowsTaskUserSidReaderForTests(() => CALLER_SID);
  });

  it("34a: the confirm-read is another account's task - E_SERVICE_TASK_NOT_OWNED, 0 /Create", async () => {
    // The CLI resolves to the SAME command the fixture's `<Exec>` already
    // runs (`refreshFixtureXml` + `REFRESH_CLI_COMMAND`, as 34b/34c use):
    // `plan.invocationUnchanged` stays true, so the write goes straight to
    // `create.exec` instead of through the CLI-invocation-record
    // transaction, which needs an absolute-path command this suite's
    // `C:\...` fixtures are not on a posix test runner. Only the direct-
    // action -> wscript-launcher conversion makes the plan stale, exercising
    // the ownership confirm-read alone.
    const { queryTaskXml } = queuedQuery([
      { kind: "xml", xml: refreshFixtureXml(CALLER_SID, true) },
      OTHER_TASK,
    ]);
    const resolvedCli = { command: REFRESH_CLI_COMMAND, args: [] };
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => resolvedCli,
      resolveCli: async () => resolvedCli,
    });
    const { run, calls } = recordingRunner();

    const caught: unknown = await refreshWindowsServiceDefinition(
      label,
      run,
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(isServiceTaskNotOwnedError(caught)).toBe(true);
    expect(createCalls(calls)).toHaveLength(0);
  });

  it("34b: the confirm-read carries <Enabled>false</Enabled> where the first read was enabled - the written XML carries it", async () => {
    const { queryTaskXml } = queuedQuery([
      { kind: "xml", xml: refreshFixtureXml(CALLER_SID, true) },
      { kind: "xml", xml: refreshFixtureXml(CALLER_SID, false) },
    ]);
    const resolvedCli = { command: REFRESH_CLI_COMMAND, args: [] };
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => resolvedCli,
      resolveCli: async () => resolvedCli,
    });
    let capturedXml: string | null = null;
    const run: ProcessRunner = async (command, args) => {
      const xmlIndex = args.indexOf("/XML");
      if (command === "schtasks" && xmlIndex !== -1) {
        const { readFile } = await import("node:fs/promises");
        const bytes = await readFile(args[xmlIndex + 1] as string);
        capturedXml = bytes.toString("utf16le").replace(/^﻿/, "");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    await refreshWindowsServiceDefinition(label, run);

    expect(capturedXml).not.toBeNull();
    expect(capturedXml ?? "").toContain("<Enabled>false</Enabled>");
  });

  it("34c: the confirm-read is absent - a refresh failure, not a create-if-absent, 0 /Create", async () => {
    const { queryTaskXml } = queuedQuery([
      { kind: "xml", xml: refreshFixtureXml(CALLER_SID, true) },
      ABSENT,
    ]);
    const resolvedCli = { command: REFRESH_CLI_COMMAND, args: [] };
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => resolvedCli,
      resolveCli: async () => resolvedCli,
    });
    const { run, calls } = recordingRunner();

    const caught: unknown = await refreshWindowsServiceDefinition(
      label,
      run,
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(caught).not.toBeNull();
    expect(isServiceTaskNotOwnedError(caught)).toBe(false);
    expect(createCalls(calls)).toHaveLength(0);
  });
});

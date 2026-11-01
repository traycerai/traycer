import { mkdtempSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
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

// The 1.5.2-rc.1 Windows regression, as the field log recorded it: `traycer
// host update` over an EXISTING registration whose `\Traycer\Host` task is
// this account's. Every read before the claim answered with the task's XML, so
// the pre-swap park let the update run and the swap committed; every read
// after it timed out, so the post-swap actuator's ownership gate answered
// `unconfirmed`. The install then refused its own `/Run` as well as its
// `/Create`, reported the registration as applied with a warning, and the
// update's 18s verify leg failed with "the service start failed" for a start
// nobody had requested. The host came up a minute later only because the
// desktop's converge fired the task.
//
// The two decisions are split now: the definition refresh still writes
// nothing, and the write-free `/Run` is issued, because it changes no
// definition and Task Scheduler's own permissions on the task are an
// independent authority for it. Each case here is paired with the control that
// must still differ - a task resolved to ANOTHER account - so the fix cannot
// be mistaken for "stop checking ownership".

const TEST_CLI_INSTALL_HOME_ROOT = mkdtempSync(
  join(tmpdir(), "traycer-windows-unattributed-start-"),
);
vi.mock("../../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../store/paths")>();
  return {
    ...actual,
    cliInstallHomeDir: (environment: string) =>
      join(TEST_CLI_INSTALL_HOME_ROOT, environment),
  };
});
vi.mock("../../../host/pid-metadata", () => ({
  readHostPidMetadata: async () => null,
  removeHostPidMetadata: async () => undefined,
  readHostPidMetadataEvidence: async () => ({ kind: "absent" as const }),
  publishedHostProcessGone: () => false,
}));

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

import {
  createWindowsController,
  readWindowsServiceTaskOwnership,
  setWindowsAccountSidResolverForTests,
  setWindowsDefinitionDepsForTests,
  setWindowsStartEvidenceDepsForTests,
  setWindowsTaskHiddenProbeForTests,
  setWindowsTaskInstallDepsForTests,
  setWindowsTaskUserSidReaderForTests,
  type ProcessRunner,
  type ScheduledTaskXmlQuery,
} from "../windows";
import { serviceLabelFor, windowsTaskName } from "../../label";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import type { SpawnEvidenceBaseline } from "../../../host/spawn-evidence";
import { runWithLeaseAtServiceSpawnEdge } from "../../spawn-edge";
import { ProcessRunError } from "../../process-runner";

afterAll(async () => {
  await rm(TEST_CLI_INSTALL_HOME_ROOT, { recursive: true, force: true });
});

const CALLER_SID = "S-1-5-21-1111-2222-3333-1001";
const OTHER_SID = "S-1-5-21-1111-2222-3333-1002";
const label = serviceLabelFor("staging");
const taskName = windowsTaskName(label);
const installOptions = {
  label,
  cli: { command: "C:\\traycer.exe", args: [] },
  enableLinger: false,
};

/**
 * A task registered by this build, running as `userId`, with the TASK-level
 * `<Settings><Enabled>` Task Scheduler's "Disable" writes.
 */
function taskXml(userId: string, enabled: "true" | "false"): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals>
    <Principal id="Author"><UserId>${userId}</UserId><LogonType>InteractiveToken</LogonType></Principal>
  </Principals>
  <Settings><Enabled>${enabled}</Enabled><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings>
  <Actions Context="Author"><Exec><Command>C:\\x\\wscript.exe</Command></Exec></Actions>
</Task>`;
}

// What the field log's timeout looks like to the gate: the PowerShell+COM
// definition read did not finish inside `WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS`.
const READ_TIMED_OUT: ScheduledTaskXmlQuery = {
  kind: "failed",
  reason: "the task definition read could not run (timed out after 10000ms)",
};

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

/** What the task reads as, right now; every ownership read goes through it. */
let registered: ScheduledTaskXmlQuery = { kind: "absent" };
let staged = 0;

function recordingRunner(options: { readonly runFails: boolean }): {
  readonly runner: ProcessRunner;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: ProcessRunner = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (options.runFails && command === "schtasks" && args[0] === "/Run") {
      throw new ProcessRunError(
        "schtasks failed",
        "schtasks",
        [...args],
        1,
        "",
        "ERROR: Access is denied.",
      );
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { runner, calls };
}

const verbCalls = (calls: readonly RecordedCall[], verb: string) =>
  calls.filter((call) => call.command === "schtasks" && call.args[0] === verb);

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

/** The host answers the post-`/Run` verification on the first poll. */
function hostComesUp(): void {
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
}

/** Nothing ever appears: the verify leg runs out, as the field case's did. */
function hostStaysDown(): void {
  setWindowsStartEvidenceDepsForTests({
    captureBaseline: async () => emptySpawnBaseline(),
    createEvidenceReader: () => ({ collect: async () => null }),
    sleep: async () => undefined,
    verifyTimeoutMs: 10,
    verifyPollMs: 1,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function launcherPath(): string {
  return join(
    TEST_CLI_INSTALL_HOME_ROOT,
    label.environment,
    "host-start-hidden.vbs",
  );
}

beforeEach(() => {
  logged.lines.length = 0;
  staged = 0;
  // The pre-claim reads of the field run: the task is there and it is this
  // account's, which is why the update was not parked before its claim.
  registered = { kind: "xml", xml: taskXml(CALLER_SID, "true") };
  hostComesUp();
  setWindowsTaskUserSidReaderForTests(() => CALLER_SID);
  setWindowsAccountSidResolverForTests(async () => null);
  setWindowsTaskHiddenProbeForTests(async () => false);
  setWindowsDefinitionDepsForTests({
    queryTaskXml: async () => registered,
    predictCli: async () => {
      throw new Error("predictCli is not part of these tests");
    },
    resolveCli: async () => {
      throw new Error("resolveCli is not part of these tests");
    },
  });
  setWindowsTaskInstallDepsForTests({
    stageTaskDefinition: async () => {
      staged += 1;
      return { tmpDir: "/tmp/never", xmlPath: "/tmp/never/task.xml" };
    },
    removeStagedTaskDefinition: async () => undefined,
  });
});

afterEach(async () => {
  // Whatever the test did, no line above DEBUG named an account.
  const everything = JSON.stringify(
    logged.lines.filter((line) => line.level !== "debug"),
  );
  for (const secret of [CALLER_SID, OTHER_SID]) {
    expect(everything).not.toContain(secret);
  }
  expect(everything).not.toMatch(/S-1-\d/);
  setWindowsTaskUserSidReaderForTests(null);
  setWindowsAccountSidResolverForTests(null);
  setWindowsTaskHiddenProbeForTests(null);
  setWindowsDefinitionDepsForTests(null);
  setWindowsStartEvidenceDepsForTests(null);
  setWindowsTaskInstallDepsForTests(null);
  await rm(launcherPath(), { force: true });
});

/** The pre-claim read of the field run, then the swap's own reads failing. */
async function readBeforeTheClaimThenBreakTheRead(
  after: ScheduledTaskXmlQuery,
): Promise<void> {
  const preClaim = await readWindowsServiceTaskOwnership(label);
  expect(preClaim.kind).toBe("caller");
  registered = after;
}

// That the install issues the `/Run` and stages nothing is pinned once, in
// `windows-task-ownership.test.ts`'s verb-by-verb map ("install over a task it
// could not attribute"). What only this suite can show is what the install
// then REPORTS, since every such report is read by a caller that decides how
// long to wait for a host and what to blame.
describe("the post-swap actuator over a registration whose ownership read stopped answering", () => {
  it("control: the same flip to another account's SID still issues no /Run and keeps the refusal", async () => {
    await readBeforeTheClaimThenBreakTheRead({
      kind: "xml",
      xml: taskXml(OTHER_SID, "true"),
    });
    const publish = vi.fn(async (): Promise<null> => null);
    const { runner, calls } = recordingRunner({ runFails: false });

    await expect(
      runWithLeaseAtServiceSpawnEdge(publish, () =>
        createWindowsController(runner, { now: () => 0 }).install(
          installOptions,
        ),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
      details: { task: taskName, verb: "create", reason: "other-owner" },
    });
    expect(calls).toEqual([]);
    expect(staged).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  // The refusal that is real now reaches the caller as one: the scheduler
  // answered, so the install fails with the verb's own result instead of
  // succeeding with a warning about a read. `host apply` records that as a
  // `postSwapError`, which carries the service repair as its remedy, where the
  // warning it replaces carried none.
  it("a /Run the scheduler refuses fails the install from the verb's own result", async () => {
    await readBeforeTheClaimThenBreakTheRead(READ_TIMED_OUT);
    const { runner, calls } = recordingRunner({ runFails: true });

    await expect(
      runWithLeaseAtServiceSpawnEdge(
        async (): Promise<null> => null,
        () =>
          createWindowsController(runner, { now: () => 0 }).install(
            installOptions,
          ),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: expect.stringContaining(`schtasks /Run failed for ${taskName}`),
      // The task exists and may already be starting, so a lease-holding
      // caller honours its grant before surfacing this.
      details: { registrationCommitted: true },
    });
    expect(verbCalls(calls, "/Run")).toHaveLength(1);
    expect(verbCalls(calls, "/Create")).toHaveLength(0);
  });

  // `registrationDisabled` is what stops the caller waiting out its whole
  // adoption window, and then escalating to a re-registration, for a task
  // whose `/Run` its own `<Enabled>` already explains. Ownership being
  // undecided is NOT the same question: three of the four unconfirmed
  // verdicts are read off XML the gate holds, so the answer is there - and
  // claiming `false` for the fourth would have the caller skip the read that
  // would have found it.
  for (const c of [
    {
      name: "a principal this account could not be compared with, task disabled",
      // `caller-sid-unreadable`: the XML read fine, the SID read did not.
      after: { kind: "xml", xml: taskXml(CALLER_SID, "false") } as const,
      sid: null,
      disabled: true,
      committed: false,
    },
    {
      name: "a principal this account could not be compared with, task enabled",
      after: { kind: "xml", xml: taskXml(CALLER_SID, "true") } as const,
      sid: null,
      disabled: false,
      committed: true,
    },
    {
      name: "a definition that could not be read at all",
      // `definition-read-failed`: no XML, so no answer to give.
      after: READ_TIMED_OUT,
      sid: CALLER_SID,
      disabled: null,
      committed: true,
    },
  ]) {
    it(`a refused /Run over ${c.name} reports registrationDisabled ${String(c.disabled)}`, async () => {
      await readBeforeTheClaimThenBreakTheRead(c.after);
      setWindowsTaskUserSidReaderForTests(() => c.sid);
      const { runner, calls } = recordingRunner({ runFails: true });

      await expect(
        runWithLeaseAtServiceSpawnEdge(
          async (): Promise<null> => null,
          () =>
            createWindowsController(runner, { now: () => 0 }).install(
              installOptions,
            ),
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        details: {
          registrationDisabled: c.disabled,
          registrationCommitted: c.committed,
        },
      });
      expect(verbCalls(calls, "/Run")).toHaveLength(1);
      expect(verbCalls(calls, "/Create")).toHaveLength(0);
    });
  }

  it("a /Run the scheduler accepts but no host answers fails on the missing evidence, not on the read", async () => {
    await readBeforeTheClaimThenBreakTheRead(READ_TIMED_OUT);
    hostStaysDown();
    const { runner, calls } = recordingRunner({ runFails: false });

    await expect(
      runWithLeaseAtServiceSpawnEdge(
        async (): Promise<null> => null,
        () =>
          createWindowsController(runner, { now: () => 0 }).install(
            installOptions,
          ),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: expect.stringContaining("no host spawn evidence appeared"),
    });
    expect(verbCalls(calls, "/Run")).toHaveLength(1);
  });

  // What a field report can now be classified from: both decisions are at
  // INFO, each naming WHICH read branch produced the verdict - the definition
  // was left alone, and the task was started anyway. The field log carried
  // only the first of these, and no branch at all.
  it("logs both decisions and the read branch behind them, at INFO, naming no account", async () => {
    await readBeforeTheClaimThenBreakTheRead(READ_TIMED_OUT);
    const { runner } = recordingRunner({ runFails: false });

    await runWithLeaseAtServiceSpawnEdge(
      async (): Promise<null> => null,
      () =>
        createWindowsController(runner, { now: () => 0 }).install(
          installOptions,
        ),
    );

    const infos = logged.lines.filter((line) => line.level === "info");
    expect(
      infos.map((line) => ({
        changed: !line.message.includes("not changing it"),
        fields: JSON.parse(line.fields),
      })),
    ).toEqual([
      {
        changed: false,
        fields: {
          task: taskName,
          verb: "create",
          reason: "unconfirmed",
          probe: "definition-read-failed",
        },
      },
      {
        changed: true,
        fields: {
          task: taskName,
          verb: "run",
          reason: "unconfirmed",
          probe: "definition-read-failed",
        },
      },
    ]);
    expect(infos[1]?.message).toContain("starting it anyway");
  });
});

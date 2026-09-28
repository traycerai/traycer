import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Redirect HOME and the CLI install home into private temp roots before any
// module resolves them: these tests write and remove a real launcher file.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(actual.tmpdir(), "traycer-windows-ownership-home-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

const TEST_CLI_INSTALL_HOME_ROOT = mkdtempSync(
  join(tmpdir(), "traycer-windows-ownership-cli-home-"),
);
vi.mock("../../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../store/paths")>();
  return {
    ...actual,
    cliInstallHomeDir: (environment: string) =>
      join(TEST_CLI_INSTALL_HOME_ROOT, environment),
  };
});

afterAll(async () => {
  await rm(TEST_CLI_INSTALL_HOME_ROOT, { recursive: true, force: true });
  await rm(osHome.current, { recursive: true, force: true });
});

const mocks = vi.hoisted(() => ({
  readHostPidMetadata: vi.fn(),
  removeHostPidMetadata: vi.fn(),
  readHostPidMetadataEvidence: vi.fn(),
  publishedHostProcessGone: vi.fn(),
  requestCooperativeShutdownReporting: vi.fn(),
}));
vi.mock("../../../host/pid-metadata", () => ({
  readHostPidMetadata: mocks.readHostPidMetadata,
  removeHostPidMetadata: mocks.removeHostPidMetadata,
  readHostPidMetadataEvidence: mocks.readHostPidMetadataEvidence,
  publishedHostProcessGone: mocks.publishedHostProcessGone,
}));
vi.mock("../desktop-agent-shutdown", () => ({
  requestCooperativeShutdownReporting:
    mocks.requestCooperativeShutdownReporting,
}));

// `statusService` probes registration with the real `runCommand`; answer it.
const queryRegistration = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../process-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../process-runner")>();
  return {
    ...actual,
    runCommand: async () => {
      queryRegistration.calls += 1;
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
});

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
  buildScheduledTaskXml,
  createWindowsController,
  refreshWindowsServiceDefinition,
  setWindowsAccountSidResolverForTests,
  setWindowsDefinitionDepsForTests,
  setWindowsStartEvidenceDepsForTests,
  setWindowsTaskInstallDepsForTests,
  setWindowsTaskUserSidReaderForTests,
  windowsTaskXmlEnabledState,
  type ProcessRunner,
  type ScheduledTaskXmlQuery,
  type WindowsControllerDeps,
  type WindowsTaskInstallDeps,
} from "../windows";
import { serviceLabelFor, windowsTaskName } from "../../label";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import type { RunResult } from "../../process-runner";
import type { SpawnEvidenceBaseline } from "../../../host/spawn-evidence";
import { runWithLeaseAtServiceSpawnEdge } from "../../spawn-edge";
import { runAsExplicitRegistrationRepair } from "../../registration-repair";

const CALLER_SID = "S-1-5-21-1111-2222-3333-1001";
const OTHER_SID = "S-1-5-21-1111-2222-3333-1002";
const ACCOUNT_NAMES = ["alice", "CONTOSO"];
const noTimingDeps: WindowsControllerDeps = { now: () => 0 };
const label = serviceLabelFor("staging");
const taskName = windowsTaskName(label);

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

const success = (stdout: string): RunResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
});

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

/** A task registered by this build: SID principal, task-level Enabled. */
function taskXml(userId: string, enabled: string | null): string {
  const enabledLine = enabled === null ? "" : `<Enabled>${enabled}</Enabled>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals>
    <Principal id="Author"><UserId>${userId}</UserId><LogonType>InteractiveToken</LogonType></Principal>
  </Principals>
  <Settings>${enabledLine}<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings>
  <Actions Context="Author"><Exec><Command>C:\\x\\wscript.exe</Command></Exec></Actions>
</Task>`;
}

// What the task is, right now; the whole ownership decision reads it.
let registered: ScheduledTaskXmlQuery = { kind: "absent" };
let queryCount = 0;

/** The three states in which the task is NOT the caller's. */
const NOT_OWNED_CASES: readonly {
  readonly name: string;
  readonly query: ScheduledTaskXmlQuery;
}[] = [
  {
    name: "another user's",
    query: { kind: "xml", xml: taskXml(OTHER_SID, "true") },
  },
  {
    name: "unconfirmed (query failed)",
    query: { kind: "failed", reason: "access denied" },
  },
];

function stageEvidenceForImmediateStart(): void {
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

// One slot process the sweep must kill, and a table the kill removes it from.
function slotTableJson(pids: readonly number[]): string {
  return JSON.stringify(
    pids.map((pid) => ({
      ProcessId: pid,
      ParentProcessId: 1,
      ClaimedParentProcessId: 1,
      Created: 0,
      Slot: true,
    })),
  );
}

function recordingRunner(slotPids: readonly number[]): {
  readonly runner: ProcessRunner;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let live = slotPids;
  const runner: ProcessRunner = async (command, args) => {
    calls.push({ command, args: [...args] });
    const script = args.find((arg) => arg.includes("GetProcessById")) ?? "";
    if (
      command === "powershell.exe" &&
      args.some((arg) => arg.includes("Get-CimInstance Win32_Process"))
    ) {
      return success(slotTableJson(live));
    }
    if (command === "powershell.exe" && script.includes("$process.Kill()")) {
      const killed = new Set(
        [...script.matchAll(/ProcessId = (\d+);/g)].map((m) => Number(m[1])),
      );
      live = live.filter((pid) => !killed.has(pid));
    }
    return success("");
  };
  return { runner, calls };
}

const verbCalls = (calls: readonly RecordedCall[], verb: string) =>
  calls.filter((call) => call.command === "schtasks" && call.args[0] === verb);

const killCalls = (calls: readonly RecordedCall[]) =>
  calls.filter(
    (call) =>
      call.command === "powershell.exe" &&
      call.args.some((arg) => arg.includes("$process.Kill()")),
  );

const folderDeleteCalls = (calls: readonly RecordedCall[]) =>
  calls.filter((call) => call.args.some((arg) => arg.includes("DeleteFolder")));

const MUTATING = ["/End", "/Run", "/Create", "/Delete"] as const;

/** Every mutating schtasks verb the run issued, and no other. */
function mutatingVerbs(calls: readonly RecordedCall[]): string[] {
  return calls
    .filter(
      (call) =>
        call.command === "schtasks" &&
        MUTATING.some((verb) => verb === call.args[0]),
    )
    .map((call) => call.args[0] ?? "");
}

function launcherPath(): string {
  return join(
    TEST_CLI_INSTALL_HOME_ROOT,
    label.environment,
    "host-start-hidden.vbs",
  );
}

async function writeLauncher(): Promise<void> {
  await mkdir(dirname(launcherPath()), { recursive: true });
  await writeFile(launcherPath(), "leftover-launcher", "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  logged.lines.length = 0;
  queryCount = 0;
  queryRegistration.calls = 0;
  registered = { kind: "absent" };
  mocks.readHostPidMetadata.mockReset();
  mocks.readHostPidMetadata.mockResolvedValue(null);
  mocks.removeHostPidMetadata.mockReset();
  mocks.removeHostPidMetadata.mockResolvedValue(undefined);
  mocks.readHostPidMetadataEvidence.mockReset();
  mocks.readHostPidMetadataEvidence.mockResolvedValue({ kind: "absent" });
  mocks.publishedHostProcessGone.mockReset();
  mocks.publishedHostProcessGone.mockReturnValue(false);
  mocks.requestCooperativeShutdownReporting.mockReset();
  mocks.requestCooperativeShutdownReporting.mockResolvedValue({
    kind: "no-host",
  });
  setWindowsTaskUserSidReaderForTests(() => CALLER_SID);
  setWindowsAccountSidResolverForTests(async () => null);
  setWindowsDefinitionDepsForTests({
    queryTaskXml: async () => {
      queryCount += 1;
      return registered;
    },
    predictCli: async () => {
      throw new Error("predictCli is not part of these tests");
    },
    resolveCli: async () => {
      throw new Error("resolveCli is not part of these tests");
    },
  });
});

afterEach(() => {
  // Nothing above DEBUG names an account or a SID, whatever the test did.
  const everything = JSON.stringify(
    logged.lines.filter((line) => line.level !== "debug"),
  );
  for (const secret of [CALLER_SID, OTHER_SID, ...ACCOUNT_NAMES]) {
    expect(everything).not.toContain(secret);
  }
  setWindowsTaskUserSidReaderForTests(null);
  setWindowsAccountSidResolverForTests(null);
  setWindowsDefinitionDepsForTests(null);
  setWindowsStartEvidenceDepsForTests(null);
  setWindowsTaskInstallDepsForTests(null);
});

describe("a task that is not the caller's: stop, restart's stop half and quit never /End it, and the caller's own sweep still runs", () => {
  it("control: the caller's own task is /End-ed, once, after exactly one ownership read", async () => {
    registered = { kind: "xml", xml: taskXml(CALLER_SID, "true") };
    const { runner, calls } = recordingRunner([401]);
    await createWindowsController(runner, noTimingDeps).stop(label, {
      force: true,
      onHostAddressed: undefined,
    });
    expect(verbCalls(calls, "/End")).toHaveLength(1);
    expect(killCalls(calls)).toHaveLength(1);
    expect(queryCount).toBe(1);
  });

  for (const c of NOT_OWNED_CASES) {
    it(`stop over a task that is ${c.name}: 0 /End, the sweep kills the caller's own slot, no error`, async () => {
      registered = c.query;
      const { runner, calls } = recordingRunner([401]);
      await createWindowsController(runner, noTimingDeps).stop(label, {
        force: true,
        onHostAddressed: undefined,
      });
      expect(verbCalls(calls, "/End")).toHaveLength(0);
      expect(mutatingVerbs(calls)).toEqual([]);
      expect(killCalls(calls)).toHaveLength(1);
      expect(mocks.removeHostPidMetadata).toHaveBeenCalledTimes(1);
    });

    it(`stopForRestart (quit) over a task that is ${c.name}: 0 /End, the sweep still ran`, async () => {
      registered = c.query;
      const { runner, calls } = recordingRunner([401]);
      await createWindowsController(runner, noTimingDeps).stopForRestart(
        label,
        { force: true },
      );
      expect(verbCalls(calls, "/End")).toHaveLength(0);
      expect(killCalls(calls)).toHaveLength(1);
    });
  }
});

describe("a task that is not the caller's: start and restart never /Run or /End it", () => {
  for (const c of NOT_OWNED_CASES) {
    it(`start over a task that is ${c.name}: E_SERVICE_TASK_NOT_OWNED, 0 /Run, no spawn edge, no evidence baseline`, async () => {
      registered = c.query;
      const baseline = vi.fn(async () => emptySpawnBaseline());
      setWindowsStartEvidenceDepsForTests({
        captureBaseline: baseline,
        createEvidenceReader: () => ({ collect: async () => null }),
        sleep: async () => undefined,
        verifyTimeoutMs: 10,
        verifyPollMs: 1,
      });
      const publish = vi.fn(async (): Promise<null> => null);
      const { runner, calls } = recordingRunner([]);
      await expect(
        runWithLeaseAtServiceSpawnEdge(publish, () =>
          createWindowsController(runner, noTimingDeps).start(label),
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
        details: { task: taskName, verb: "run" },
      });
      expect(calls).toEqual([]);
      expect(baseline).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    });

    it(`restart over a task that is ${c.name}: refuses before its stop half - 0 /End, 0 /Run, 0 process calls of any kind`, async () => {
      registered = c.query;
      stageEvidenceForImmediateStart();
      const { runner, calls } = recordingRunner([401]);
      await expect(
        createWindowsController(runner, noTimingDeps).restart(label),
      ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED });
      expect(calls).toEqual([]);
      expect(mocks.requestCooperativeShutdownReporting).not.toHaveBeenCalled();
    });
  }

  it("control: start over the caller's own task issues one /Run after one ownership read", async () => {
    registered = { kind: "xml", xml: taskXml(CALLER_SID, "true") };
    stageEvidenceForImmediateStart();
    const { runner, calls } = recordingRunner([]);
    await createWindowsController(runner, noTimingDeps).start(label);
    expect(verbCalls(calls, "/Run")).toHaveLength(1);
    expect(queryCount).toBe(1);
  });
});

describe("a task that is not the caller's: refresh never redefines it", () => {
  for (const c of NOT_OWNED_CASES) {
    it(`refresh over a task that is ${c.name}: throws E_SERVICE_TASK_NOT_OWNED, 0 /Create, the launcher is not rewritten`, async () => {
      registered = c.query;
      await writeLauncher();
      const { runner, calls } = recordingRunner([]);
      await expect(
        refreshWindowsServiceDefinition(label, runner),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
        details: { verb: "create" },
      });
      expect(calls).toEqual([]);
      expect(await readFile(launcherPath(), "utf8")).toBe("leftover-launcher");
      await rm(launcherPath(), { force: true });
    });
  }
});

describe("a task that is not the caller's: install never registers, runs or starts anything", () => {
  const options = {
    label,
    cli: { command: "C:\\traycer.exe", args: [] },
    enableLinger: false,
  };

  for (const c of NOT_OWNED_CASES) {
    it(`install over a task that is ${c.name}: refuses first - 0 /Create, 0 /Run, no grant, nothing staged, no launcher`, async () => {
      registered = c.query;
      const stage = vi.fn(async () => ({
        tmpDir: "/tmp/never",
        xmlPath: "/tmp/never/task.xml",
      }));
      setWindowsTaskInstallDepsForTests({
        stageTaskDefinition: stage,
        removeStagedTaskDefinition: async () => undefined,
      });
      const publish = vi.fn(async (): Promise<null> => null);
      const { runner, calls } = recordingRunner([]);
      await expect(
        runWithLeaseAtServiceSpawnEdge(publish, () =>
          createWindowsController(runner, noTimingDeps).install(options),
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
        details: { task: taskName, verb: "create" },
      });
      expect(calls).toEqual([]);
      expect(stage).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(await exists(launcherPath())).toBe(false);
    });
  }
});

describe("a task that is not the caller's: uninstall leaves it in place and finishes the caller's own teardown", () => {
  const uninstallOptions = { label, leaveForegroundRun: null };

  it("control: the caller's own task is ended and deleted, and the emptied folder swept", async () => {
    registered = { kind: "xml", xml: taskXml(CALLER_SID, "true") };
    await writeLauncher();
    const { runner, calls } = recordingRunner([401]);
    await createWindowsController(runner, noTimingDeps).uninstall(
      uninstallOptions,
    );
    expect(mutatingVerbs(calls)).toEqual(["/End", "/Delete"]);
    expect(folderDeleteCalls(calls)).toHaveLength(1);
    // One ownership read per mutating verb, folder delete included.
    expect(queryCount).toBe(3);
  });

  for (const c of NOT_OWNED_CASES) {
    it(`uninstall over a task that is ${c.name}: 0 /End, 0 /Delete, 0 folder delete - and the sweep ran, the launcher and pid.json are gone`, async () => {
      registered = c.query;
      await writeLauncher();
      const { runner, calls } = recordingRunner([401]);
      await createWindowsController(runner, noTimingDeps).uninstall(
        uninstallOptions,
      );
      expect(mutatingVerbs(calls)).toEqual([]);
      expect(folderDeleteCalls(calls)).toHaveLength(0);
      expect(killCalls(calls)).toHaveLength(1);
      expect(await exists(launcherPath())).toBe(false);
      expect(mocks.removeHostPidMetadata).toHaveBeenCalledTimes(1);
      // Three gated verbs, three reads: never a cached answer.
      expect(queryCount).toBe(3);
    });
  }
});

describe("status reads another user's task as no registration of this account's", () => {
  it("other-owner: not-installed, and the pid.json of a live host is not read as this task's", async () => {
    registered = { kind: "xml", xml: taskXml(OTHER_SID, "true") };
    mocks.readHostPidMetadata.mockResolvedValue({
      pid: 4242,
      version: "1.2.3",
      websocketUrl: "ws://127.0.0.1:1",
    });
    const status = await createWindowsController(null, noTimingDeps).status(
      label,
    );
    expect(status).toEqual({
      state: "not-installed",
      version: null,
      listenUrl: null,
      pid: null,
    });
  });

  it("unconfirmed keeps the pre-existing answer: a registered task with no live host is stopped", async () => {
    registered = { kind: "failed", reason: "access denied" };
    const status = await createWindowsController(null, noTimingDeps).status(
      label,
    );
    expect(status.state).toBe("stopped");
  });

  it("unconfirmed keeps the pre-existing answer: a live host is running", async () => {
    registered = { kind: "failed", reason: "access denied" };
    mocks.readHostPidMetadata.mockResolvedValue({
      pid: 4242,
      version: "1.2.3",
      websocketUrl: "ws://127.0.0.1:1",
    });
    const status = await createWindowsController(null, noTimingDeps).status(
      label,
    );
    expect(status).toMatchObject({ state: "running", pid: 4242 });
  });

  it("the caller's own task is stopped, not not-installed", async () => {
    registered = { kind: "xml", xml: taskXml(CALLER_SID, "true") };
    const status = await createWindowsController(null, noTimingDeps).status(
      label,
    );
    expect(status.state).toBe("stopped");
  });
});

// The disabled carry-over: the install writes what the task's owner set.
describe("install over the caller's own disabled task carries the switch over", () => {
  const options = {
    label,
    cli: { command: "C:\\traycer.exe", args: [] },
    enableLinger: false,
  };

  // Stages the real builder's XML and hands `/Create` a file to read, exactly
  // as the default staging does, minus the launcher write.
  function stagingThatRecords(): {
    readonly deps: WindowsTaskInstallDeps;
    readonly settingsEnabledSeen: boolean[];
  } {
    const settingsEnabledSeen: boolean[] = [];
    return {
      settingsEnabledSeen,
      deps: {
        stageTaskDefinition: async (staged, userId, settingsEnabled) => {
          settingsEnabledSeen.push(settingsEnabled);
          const tmp = mkdtempSync(join(tmpdir(), "traycer-ownership-stage-"));
          const xmlPath = join(tmp, "task.xml");
          await writeFile(
            xmlPath,
            Buffer.from(
              `﻿${buildScheduledTaskXml(
                { label: staged.label, cli: staged.cli },
                userId,
                settingsEnabled,
              )}`,
              "utf16le",
            ),
          );
          return { tmpDir: tmp, xmlPath };
        },
        removeStagedTaskDefinition: async (tmpDir) => {
          await rm(tmpDir, { recursive: true, force: true });
        },
      },
    };
  }

  function createXmlCapturingRunner(): {
    readonly runner: ProcessRunner;
    readonly calls: RecordedCall[];
    readonly createdXml: string[];
  } {
    const calls: RecordedCall[] = [];
    const createdXml: string[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args: [...args] });
      const xmlIndex = args.indexOf("/XML");
      if (args[0] === "/Create" && xmlIndex !== -1) {
        const bytes = await readFile(args[xmlIndex + 1] ?? "");
        createdXml.push(bytes.toString("utf16le").replace(/^\ufeff/, ""));
      }
      return success("");
    };
    return { runner, calls, createdXml };
  }

  it("no repair scope: the /Create XML keeps Settings Enabled false, 0 /Run, the spawn edge is not reached", async () => {
    registered = { kind: "xml", xml: taskXml(CALLER_SID, "false") };
    const staging = stagingThatRecords();
    setWindowsTaskInstallDepsForTests(staging.deps);
    const publish = vi.fn(async (): Promise<null> => null);
    const { runner, calls, createdXml } = createXmlCapturingRunner();
    await runWithLeaseAtServiceSpawnEdge(publish, () =>
      createWindowsController(runner, noTimingDeps).install(options),
    );
    expect(staging.settingsEnabledSeen).toEqual([false]);
    expect(createdXml).toHaveLength(1);
    expect(createdXml[0]).toMatch(
      /<Settings>[\s\S]*<Enabled>false<\/Enabled>[\s\S]*<\/Settings>/,
    );
    expect(windowsTaskXmlEnabledState(createdXml[0] ?? "").kind).toBe(
      "disabled",
    );
    expect(mutatingVerbs(calls)).toEqual(["/Create"]);
    expect(publish).not.toHaveBeenCalled();
    // R3: the gate's read plus one confirm-read for the /Create.
    expect(queryCount).toBe(2);
  });

  it("inside runAsExplicitRegistrationRepair: writes true, starts the task once, and reaches the spawn edge", async () => {
    registered = { kind: "xml", xml: taskXml(CALLER_SID, "false") };
    stageEvidenceForImmediateStart();
    const staging = stagingThatRecords();
    setWindowsTaskInstallDepsForTests(staging.deps);
    const publish = vi.fn(async (): Promise<null> => null);
    const { runner, calls, createdXml } = createXmlCapturingRunner();
    await runWithLeaseAtServiceSpawnEdge(publish, () =>
      runAsExplicitRegistrationRepair(() =>
        createWindowsController(runner, noTimingDeps).install(options),
      ),
    );
    expect(staging.settingsEnabledSeen).toEqual([true]);
    expect(windowsTaskXmlEnabledState(createdXml[0] ?? "").kind).toBe(
      "enabled",
    );
    expect(mutatingVerbs(calls)).toEqual(["/Create", "/Run"]);
    expect(publish).toHaveBeenCalledTimes(1);
    // R3: gate + confirm-read for /Create (2), plus the ownership read in
    // front of /Run (1).
    expect(queryCount).toBe(3);
  });

  it("a fresh registration (no task yet) registers enabled and starts it", async () => {
    registered = { kind: "absent" };
    stageEvidenceForImmediateStart();
    const staging = stagingThatRecords();
    setWindowsTaskInstallDepsForTests(staging.deps);
    const { runner, calls } = createXmlCapturingRunner();
    await createWindowsController(runner, noTimingDeps).install(options);
    expect(staging.settingsEnabledSeen).toEqual([true]);
    expect(mutatingVerbs(calls)).toEqual(["/Create", "/Run"]);
  });

  it("a task whose Enabled cannot be read (after ownership passed) is not one the user is known to have disabled: registers enabled", async () => {
    registered = { kind: "xml", xml: taskXml(CALLER_SID, "maybe") };
    stageEvidenceForImmediateStart();
    const staging = stagingThatRecords();
    setWindowsTaskInstallDepsForTests(staging.deps);
    const { runner, calls } = createXmlCapturingRunner();
    await createWindowsController(runner, noTimingDeps).install(options);
    expect(staging.settingsEnabledSeen).toEqual([true]);
    expect(mutatingVerbs(calls)).toEqual(["/Create", "/Run"]);
  });

  it("an enabled task of the caller's is re-registered enabled", async () => {
    registered = { kind: "xml", xml: taskXml(CALLER_SID, "true") };
    stageEvidenceForImmediateStart();
    const staging = stagingThatRecords();
    setWindowsTaskInstallDepsForTests(staging.deps);
    const { runner } = createXmlCapturingRunner();
    await createWindowsController(runner, noTimingDeps).install(options);
    expect(staging.settingsEnabledSeen).toEqual([true]);
  });
});

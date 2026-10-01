import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
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
  setWindowsDefinitionDepsForTests,
  setWindowsStartEvidenceDepsForTests,
  setWindowsTaskInstallDepsForTests,
  setWindowsTaskUserSidReaderForTests,
  type ProcessRunner,
  type ScheduledTaskXmlQuery,
} from "../windows";
import type { SpawnEvidenceBaseline } from "../../../host/spawn-evidence";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import { SERVICE_REGISTRATION_KEPT_CHANGING_MESSAGE } from "../windows-task-gate";
import {
  runWithLeaseAtServiceSpawnEdge,
  type ServiceSpawnEdgeLease,
} from "../../spawn-edge";
import { serviceLabelFor } from "../../label";

// R4 §43: the same step budget (§42), now proven through the REAL
// `installService`, under `runWithLeaseAtServiceSpawnEdge` with a fake lease.
// A budget failure must cancel the lease and never touch the task (0
// /Create, /Run, /Delete); an in-budget pass launches exactly as it does
// today.
//
// RED-FIRST against the pre-R4 worktree: there is no budget at all yet, so
// the "slow confirm-read" case creates and runs instead of refusing, and the
// imported budget constant/message are `undefined`.

const TEST_HOME = mkdtempSync(
  join(tmpdir(), "traycer-windows-install-budget-"),
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

const CALLER_SID = "S-1-5-21-7000-8000-9000-1001";

function taskXml(tag: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <!--${tag}-->
  <Principals><Principal id="Author"><UserId>${CALLER_SID}</UserId></Principal></Principals>
  <Settings><Enabled>true</Enabled></Settings>
  <Actions Context="Author"><Exec><Command>C:\\traycer.exe</Command><Arguments>host start</Arguments></Exec></Actions>
</Task>`;
}

let clockMs = 0;

function timedQuery(
  entries: readonly { query: ScheduledTaskXmlQuery; delayMs: number }[],
): {
  queryTaskXml: () => Promise<ScheduledTaskXmlQuery>;
} {
  let i = 0;
  return {
    queryTaskXml: async () => {
      const entry = entries[Math.min(i, entries.length - 1)];
      if (i >= 1) clockMs += entry.delayMs;
      i += 1;
      return entry.query;
    },
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
function runCalls(calls: readonly RecordedCall[]): readonly RecordedCall[] {
  return calls.filter((c) => c.command === "schtasks" && c.args[0] === "/Run");
}
function deleteCalls(calls: readonly RecordedCall[]): readonly RecordedCall[] {
  return calls.filter(
    (c) => c.command === "schtasks" && c.args[0] === "/Delete",
  );
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

function fakeLease(): {
  readonly publish: () => Promise<ServiceSpawnEdgeLease>;
  readonly waitForSpawnCalls: () => number;
  readonly cancelCalls: () => number;
} {
  let waitForSpawnCalls = 0;
  let cancelCalls = 0;
  const publish = async (): Promise<ServiceSpawnEdgeLease> => ({
    waitForSpawn: async () => {
      waitForSpawnCalls += 1;
    },
    cancel: async () => {
      cancelCalls += 1;
    },
  });
  return {
    publish,
    waitForSpawnCalls: () => waitForSpawnCalls,
    cancelCalls: () => cancelCalls,
  };
}

beforeEach(() => {
  clockMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clockMs);
  setWindowsTaskUserSidReaderForTests(() => CALLER_SID);
  setWindowsStartEvidenceDepsForTests({
    captureBaseline: async () => emptySpawnBaseline(),
    createEvidenceReader: () => ({
      collect: async () => ({
        kind: "starting-marker" as const,
        reason: "post-baseline starting marker",
        marker: null,
        pid: null,
      }),
    }),
    sleep: async () => undefined,
    verifyTimeoutMs: 5_000,
    verifyPollMs: 1,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  setWindowsDefinitionDepsForTests(null);
  setWindowsTaskInstallDepsForTests(null);
  setWindowsTaskUserSidReaderForTests(null);
  setWindowsStartEvidenceDepsForTests(null);
});

describe("installService: the create budget, driven through the real spawn-edge lease (R4)", () => {
  it("43a: a slow confirm-read that crosses B refuses before any task write, and cancels the lease once", async () => {
    const { queryTaskXml } = timedQuery([
      { query: { kind: "absent" }, delayMs: 0 }, // gate's own read
      { query: { kind: "absent" }, delayMs: 26_000 }, // confirm-read: slow
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
          tmpDir: "/tmp/budget-stage-dir",
          xmlPath: `/tmp/budget-stage-${stageCount}.xml`,
        };
      },
      removeStagedTaskDefinition: async () => undefined,
    });
    const { run, calls } = recordingRunner();
    const controller = createWindowsController(run, { now: () => 0 });
    const lease = fakeLease();

    const caught = await runWithLeaseAtServiceSpawnEdge(lease.publish, () =>
      controller.install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      }),
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: SERVICE_REGISTRATION_KEPT_CHANGING_MESSAGE,
    });
    expect(createCalls(calls)).toHaveLength(0);
    expect(runCalls(calls)).toHaveLength(0);
    expect(deleteCalls(calls)).toHaveLength(0);
    expect(lease.cancelCalls()).toBe(1);
    expect(lease.waitForSpawnCalls()).toBe(0);
  });

  it("43b: an in-budget pass (one change then a fast confirm) launches: one /Create, one /Run, waitForSpawn entered, cancel once", async () => {
    const { queryTaskXml } = timedQuery([
      { query: { kind: "xml", xml: taskXml("v1") }, delayMs: 0 }, // gate's own read
      { query: { kind: "xml", xml: taskXml("v2") }, delayMs: 0 }, // confirm-read: changed
      { query: { kind: "xml", xml: taskXml("v2") }, delayMs: 0 }, // confirm-read after restage: matches
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
          tmpDir: "/tmp/budget-stage-dir",
          xmlPath: `/tmp/budget-stage-${stageCount}.xml`,
        };
      },
      removeStagedTaskDefinition: async () => undefined,
    });
    const { run, calls } = recordingRunner();
    const controller = createWindowsController(run, { now: () => 0 });
    const lease = fakeLease();

    await runWithLeaseAtServiceSpawnEdge(lease.publish, () =>
      controller.install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      }),
    );

    expect(createCalls(calls)).toHaveLength(1);
    expect(runCalls(calls)).toHaveLength(1);
    expect(lease.waitForSpawnCalls()).toBe(1);
    expect(lease.cancelCalls()).toBe(1);
  });

  it("43c: the launcher is restored on the budget failure, the same as on any other create failure", async () => {
    const label = serviceLabelFor("staging");
    const launcherPath = join(TEST_HOME, "staging", "host-start-hidden.vbs");
    await mkdir(dirname(launcherPath), { recursive: true });
    await writeFile(launcherPath, "leftover-launcher", "utf8");
    const oldBytes = await readFile(launcherPath);

    const { queryTaskXml } = timedQuery([
      { query: { kind: "xml", xml: taskXml("v1") }, delayMs: 0 }, // gate's own read
      { query: { kind: "xml", xml: taskXml("v1") }, delayMs: 26_000 }, // confirm-read: slow
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
    // Real staging deps: this case checks the real launcher write/restore,
    // so it does NOT fake `stageTaskDefinition` (unlike 43a/43b).
    setWindowsTaskInstallDepsForTests(null);
    const { run, calls } = recordingRunner();
    const controller = createWindowsController(run, { now: () => 0 });
    const lease = fakeLease();

    const caught = await runWithLeaseAtServiceSpawnEdge(lease.publish, () =>
      controller.install({
        label,
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      }),
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
    });
    expect(createCalls(calls)).toHaveLength(0);
    const restoredBytes = await readFile(launcherPath);
    expect(restoredBytes.equals(oldBytes)).toBe(true);
    await rm(launcherPath, { force: true });
  });
});

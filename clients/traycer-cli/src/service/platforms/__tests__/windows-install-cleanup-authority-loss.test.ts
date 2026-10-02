import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWindowsController,
  setWindowsDefinitionDepsForTests,
  setWindowsStartEvidenceDepsForTests,
  setWindowsTaskInstallDepsForTests,
  setWindowsTaskUserSidReaderForTests,
  type ProcessRunner,
  type ScheduledTaskXmlQuery,
} from "../windows";
import { ServiceMutationAuthorityError } from "../../mutation-authority";
import {
  runWithLeaseAtServiceSpawnEdge,
  type ServiceSpawnEdgeLease,
} from "../../spawn-edge";
import { serviceLabelFor } from "../../label";
import { vi } from "vitest";

// R5 §48: a write that carries the task DISABLED (the confirm-read found it
// disabled mid-staging - test 31's own scenario) still has no child coming,
// whether the staging cleanup that follows `/Create` succeeds or loses
// mutation authority. Today, a lost authority in that cleanup is thrown
// BEFORE the `keepsDisabled(written)` check that would otherwise withdraw the
// spawn edge (`windows.ts` lines ~397-410 run ahead of line ~462), so the
// lease-holding caller still enters `waitForSpawn` for an authority error
// that will never see a child.
//
// RED today: `waitForSpawn` is entered once.

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

const TEST_HOME = mkdtempSync(
  join(tmpdir(), "traycer-windows-cleanup-authority-loss-"),
);
afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

const CALLER_SID = "S-1-5-21-1000-2000-3000-1001";

function taskXml(enabled: boolean): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals><Principal id="Author"><UserId>${CALLER_SID}</UserId></Principal></Principals>
  <Settings><Enabled>${enabled ? "true" : "false"}</Enabled><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings>
  <Actions Context="Author"><Exec><Command>C:\\traycer.exe</Command><Arguments>host start</Arguments></Exec></Actions>
</Task>`;
}

function queuedQuery(queries: readonly ScheduledTaskXmlQuery[]): {
  queryTaskXml: () => Promise<ScheduledTaskXmlQuery>;
} {
  let i = 0;
  return {
    queryTaskXml: async () => {
      const q = queries[Math.min(i, queries.length - 1)];
      i += 1;
      return q;
    },
  };
}

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}
function createCalls(calls: readonly RecordedCall[]): readonly RecordedCall[] {
  return calls.filter(
    (c) => c.command === "schtasks" && c.args[0] === "/Create",
  );
}
function runCalls(calls: readonly RecordedCall[]): readonly RecordedCall[] {
  return calls.filter((c) => c.command === "schtasks" && c.args[0] === "/Run");
}

function emptySpawnBaseline(): import("../../../host/spawn-evidence").SpawnEvidenceBaseline {
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
  setWindowsTaskUserSidReaderForTests(() => CALLER_SID);
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

describe("installService: the staging cleanup's own authority loss, on a write that carries the task disabled (R5 §48)", () => {
  it("48: 1 /Create carrying Enabled=false, 0 /Run, waitForSpawn NOT entered, cancel once, the rejection is the ServiceMutationAuthorityError", async () => {
    const { queryTaskXml } = queuedQuery([
      { kind: "xml", xml: taskXml(true) }, // gate's own read: enabled - the caller's
      { kind: "xml", xml: taskXml(false) }, // confirm-read: disabled mid-staging
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
    const authorityLoss = new ServiceMutationAuthorityError(
      new Error("lease lost"),
    );
    setWindowsTaskInstallDepsForTests({
      stageTaskDefinition: async () => ({
        tmpDir: "/tmp/cleanup-authority-stage-dir",
        xmlPath: "/tmp/cleanup-authority-stage.xml",
      }),
      removeStagedTaskDefinition: async () => {
        throw authorityLoss;
      },
    });
    const calls: RecordedCall[] = [];
    const run: ProcessRunner = async (command, args) => {
      calls.push({ command, args: [...args] });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
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

    expect(caught).toBeInstanceOf(ServiceMutationAuthorityError);
    // The task is the caller's own (disabled or not), so the write is the
    // owned `/Create /F`, carrying the definition staged from the disabled
    // confirm-read.
    const create = createCalls(calls);
    expect(create).toHaveLength(1);
    expect(create[0]?.args).toContain("/F");
    expect(runCalls(calls)).toHaveLength(0);
    expect(lease.waitForSpawnCalls()).toBe(0);
    expect(lease.cancelCalls()).toBe(1);
  });
});

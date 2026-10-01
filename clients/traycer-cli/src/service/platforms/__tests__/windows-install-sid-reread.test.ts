import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
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
  setWindowsAccountSidResolverForTests,
  setWindowsDefinitionDepsForTests,
  setWindowsStartEvidenceDepsForTests,
  setWindowsTaskInstallDepsForTests,
  setWindowsTaskUserSidReaderForTests,
  type ProcessRunner,
  type ScheduledTaskXmlQuery,
} from "../windows";
import { ProcessRunError } from "../../process-runner";
import type { SpawnEvidenceBaseline } from "../../../host/spawn-evidence";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import {
  runWithLeaseAtServiceSpawnEdge,
  type ServiceSpawnEdgeLease,
} from "../../spawn-edge";
import { serviceLabelFor } from "../../label";

// R5 §47: a read AFTER the install edge must never ask `whoami` again - the
// SID this account runs as cannot change mid-install, and re-asking it (or
// the account-name resolver it feeds) runs the read past the create budget on
// a machine where `whoami`/the resolver are slow.
//
// RED today: `resolveTaskUserId()` (before the edge, for the create XML's
// `<UserId>`) and `readWindowsTaskOwnership`'s own `deps.callerSid()` (at
// every ownership read that finds a task with a principal) are two
// independent call sites into the SAME reader, with nothing caching the
// answer BETWEEN them for one `installService` call. A reader that fails
// once and then succeeds is asked twice; a slow reader or a slow
// name-resolution is paid twice.

const TEST_HOME = mkdtempSync(join(tmpdir(), "traycer-windows-sid-reread-"));
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

let clockMs = 0;

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
  readonly cancelCalls: () => number;
} {
  let cancelCalls = 0;
  const publish = async (): Promise<ServiceSpawnEdgeLease> => ({
    waitForSpawn: async () => undefined,
    cancel: async () => {
      cancelCalls += 1;
    },
  });
  return { publish, cancelCalls: () => cancelCalls };
}

beforeEach(() => {
  clockMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clockMs);
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
  setWindowsTaskInstallDepsForTests({
    stageTaskDefinition: async () => ({
      tmpDir: "/tmp/sid-reread-stage-dir",
      xmlPath: "/tmp/sid-reread-stage.xml",
    }),
    removeStagedTaskDefinition: async () => undefined,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  setWindowsDefinitionDepsForTests(null);
  setWindowsTaskInstallDepsForTests(null);
  setWindowsTaskUserSidReaderForTests(null);
  setWindowsAccountSidResolverForTests(null);
  setWindowsStartEvidenceDepsForTests(null);
});

describe("installService: the SID reader is asked once per install, not once per read (R5 §47)", () => {
  it("47: fails-first-succeeds-later reader is asked exactly once; the create-if-absent race is refused as unconfirmed, 0 successful /Create", async () => {
    // The pre-edge SID read fails once, so the XML `<UserId>` falls back to
    // the environment name - which must resolve, or `installService` throws
    // before it ever reaches the gate this test is about.
    const originalUsername = process.env.USERNAME;
    process.env.USERNAME = "test-user";
    try {
      await runSid47Case();
    } finally {
      if (originalUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = originalUsername;
    }
  });

  async function runSid47Case(): Promise<void> {
    let sidCalls = 0;
    setWindowsTaskUserSidReaderForTests((): string | null => {
      sidCalls += 1;
      if (sidCalls === 1) return null; // the pre-edge XML-userId resolution fails
      clockMs += 10_000; // any later call succeeds, at a 10s cost
      return "S-1-5-21-7000-8000-9000-1001";
    });
    let resolverCalls = 0;
    setWindowsAccountSidResolverForTests(async (): Promise<string | null> => {
      resolverCalls += 1;
      clockMs += 14_000;
      return null; // the name this "other party" registered resolves to nothing
    });

    let queryCalls = 0;
    const queryTaskXml = async (): Promise<ScheduledTaskXmlQuery> => {
      queryCalls += 1;
      if (queryCalls <= 2) return { kind: "absent" }; // gate's read, then the confirm-read before /Create
      // The re-read after the raced /Create: another party's task, principal
      // is a NAME (not a SID), so ownership needs the account resolver.
      return {
        kind: "xml",
        xml:
          '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">' +
          '<Principals><Principal id="Author"><UserId>OTHERDOMAIN\\otheruser</UserId></Principal></Principals>' +
          "<Settings><Enabled>true</Enabled></Settings></Task>",
      };
    };
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => {
        throw new Error("not used");
      },
      resolveCli: async () => {
        throw new Error("not used");
      },
    });

    let createAttempts = 0;
    const run: ProcessRunner = async (command, args) => {
      if (command === "schtasks" && args[0] === "/Create") {
        createAttempts += 1;
        if (!args.includes("/F")) {
          // create-if-absent: another party won the race.
          throw new ProcessRunError(
            "schtasks failed",
            "schtasks",
            [...args],
            1,
            "",
            "ERROR: The specified task name already exists.",
          );
        }
      }
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

    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
    });
    // 0 successful /Create - the one attempt that ran (create-if-absent) failed.
    expect(createAttempts).toBe(1);
    // R5 §47: caller's SID does not change mid-install - a read after the
    // edge must reuse the answer resolved before it, not ask again.
    expect(sidCalls).toBe(1);
    expect(resolverCalls).toBeLessThanOrEqual(1);
  }

  it("47 green-path control (ablation via a non-memoising reader): a task present from the start, SID principal, still asks once per install after the fix - today it is one call per ownership read (>= 3)", async () => {
    const CALLER_SID = "S-1-5-21-7000-8000-9000-1001";
    let sidCalls = 0;
    // Deliberately never memoises - the point is to see whether anything
    // ABOVE the reader caches its answer within one install, not whether the
    // reader itself does (production's default reader does memoise, which
    // would mask this finding entirely).
    setWindowsTaskUserSidReaderForTests((): string | null => {
      sidCalls += 1;
      return CALLER_SID;
    });
    const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals><Principal id="Author"><UserId>${CALLER_SID}</UserId></Principal></Principals>
  <Settings><Enabled>true</Enabled></Settings>
  <Actions Context="Author"><Exec><Command>C:\\traycer.exe</Command><Arguments>host start</Arguments></Exec></Actions>
</Task>`;
    setWindowsDefinitionDepsForTests({
      queryTaskXml: async () => ({ kind: "xml", xml: taskXml }),
      predictCli: async () => {
        throw new Error("not used");
      },
      resolveCli: async () => {
        throw new Error("not used");
      },
    });
    const run: ProcessRunner = async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const controller = createWindowsController(run, { now: () => 0 });
    const lease = fakeLease();

    await runWithLeaseAtServiceSpawnEdge(lease.publish, () =>
      controller.install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      }),
    );

    // installService reads the SID once at entry; that single answer feeds
    // the gate, every confirm-read, the /Run gate and the `<UserId>` it
    // stages with.
    expect(sidCalls).toBe(1);
  });

  it("47 production-shaped: task present with a SID principal, reader answers every call - still exactly 1 call, and none after the edge", async () => {
    const CALLER_SID = "S-1-5-21-7000-8000-9000-1001";
    let sidCalls = 0;
    setWindowsTaskUserSidReaderForTests((): string | null => {
      sidCalls += 1;
      return CALLER_SID;
    });
    const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals><Principal id="Author"><UserId>${CALLER_SID}</UserId></Principal></Principals>
  <Settings><Enabled>true</Enabled></Settings>
  <Actions Context="Author"><Exec><Command>C:\\traycer.exe</Command><Arguments>host start</Arguments></Exec></Actions>
</Task>`;
    setWindowsDefinitionDepsForTests({
      queryTaskXml: async () => ({ kind: "xml", xml: taskXml }),
      predictCli: async () => {
        throw new Error("not used");
      },
      resolveCli: async () => {
        throw new Error("not used");
      },
    });
    // The spawn-evidence collector runs only after /Run - the read that
    // would be the SID reader's LAST legitimate chance to run again if
    // anything asked after the install edge. Snapshotting here isolates
    // that "after the edge" window from the pre-edge XML/gate/confirm
    // reads the main assertion already covers in total.
    let sidCallsAtEvidenceCheck: number | null = null;
    setWindowsStartEvidenceDepsForTests({
      captureBaseline: async () => ({
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
      }),
      createEvidenceReader: () => ({
        collect: async () => {
          sidCallsAtEvidenceCheck = sidCalls;
          return {
            kind: "starting-marker" as const,
            reason: "post-baseline starting marker",
            marker: null,
            pid: null,
          };
        },
      }),
      sleep: async () => undefined,
      verifyTimeoutMs: 5_000,
      verifyPollMs: 1,
    });
    const run: ProcessRunner = async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const controller = createWindowsController(run, { now: () => 0 });
    const lease = fakeLease();

    await runWithLeaseAtServiceSpawnEdge(lease.publish, () =>
      controller.install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      }),
    );

    expect(sidCalls).toBe(1);
    // The /Run gate's own ownership read happens BEFORE the evidence check;
    // if it asked the reader again, this snapshot would already show 2.
    expect(sidCallsAtEvidenceCheck).toBe(1);
  });
});

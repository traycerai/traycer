import { rm } from "node:fs/promises";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

// HOME isolation: hoisted `vi.mock("node:os")` mkdtemps `homedir()` before any
// import runs - the same pattern windows-task-enabled-state.test.ts uses.
// `start()`'s own path never touches the filesystem here (every production
// seam it reaches - start-evidence, the task-enabled query - is stubbed
// below); the isolation is kept anyway, since a partial `store/paths` mock
// alone is not enough.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = mkdtempSync(
      join(actual.tmpdir(), "traycer-windows-disabled-run-lease-os-home-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

afterAll(async () => {
  if (osHome.current !== "") {
    await rm(osHome.current, { recursive: true, force: true });
  }
});

// Whole-module mock, the same shape windows-install-edge-to-return.test.ts
// uses: a bare `start()` never reads pid metadata on its own path, but the
// module is kept out of the way rather than left to resolve against a real
// `~/.traycer`.
vi.mock("../../../host/pid-metadata", () => ({
  readHostPidMetadata: async () => null,
  removeHostPidMetadata: async () => undefined,
  readHostPidMetadataEvidence: async () => ({ kind: "absent" as const }),
}));

import {
  createWindowsController,
  setWindowsDefinitionDepsForTests,
  setWindowsStartEvidenceDepsForTests,
  setWindowsTaskUserSidReaderForTests,
  type ProcessRunner,
  type WindowsControllerDeps,
} from "../windows";
import { serviceLabelFor } from "../../label";
import { ProcessRunError } from "../../process-runner";
import {
  isUnacknowledgedSpawn,
  runWithLeaseAtServiceSpawnEdge,
  SpawnAcknowledgementTimeoutError,
  type ServiceSpawnEdgeLease,
} from "../../spawn-edge";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import type { SpawnEvidenceBaseline } from "../../../host/spawn-evidence";

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

// Same task-level `<Settings><Enabled>` fixture as windows.test.ts's own
// `definitionTaskXml` - copied locally rather than imported, matching that
// file's (and windows-task-enabled-state.test.ts's) isolation discipline.
function definitionTaskXml(settingsEnabled: string | null): string {
  const settingsEnabledLine =
    settingsEnabled === null
      ? ""
      : `<Enabled>${settingsEnabled}</Enabled>\n    `;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-21-1000-2000-3000-1001</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    ${settingsEnabledLine}<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>C:\\traycer\\cli.exe</Command>
      <Arguments>host start</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

// A `/Run` that always fails with a plain (non-authority) schtasks error -
// the only call `runTaskAndVerifyStart` issues on a bare `start()`, since a
// plain start reaches no `/Create`.
function refusingRunRunner(): ProcessRunner {
  return async (command, args) => {
    if (command === "schtasks" && args[0] === "/Run") {
      throw new ProcessRunError(
        "schtasks /Run exited with code 1: The attempted operation is not supported for the specified type of task.",
        command,
        args,
        1,
        "",
        "ERROR: The attempted operation is not supported for the specified type of task.",
      );
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

const noTimingDeps: WindowsControllerDeps = { now: () => 0 };

// A lease whose `waitForSpawn` behaves like the real ack wait when no
// supervisor ever came: it times out. Shared by both rows below - the only
// difference between them is whether `runWithLeaseAtServiceSpawnEdge` ever
// calls it at all, which turns on `didServiceRegistrationCommit`.
function makeLeaseThatTimesOutAck(): ServiceSpawnEdgeLease & {
  readonly waitForSpawnMock: Mock<() => Promise<void>>;
  readonly cancelMock: Mock<() => Promise<void>>;
} {
  const waitForSpawnMock = vi.fn(async () => {
    throw new SpawnAcknowledgementTimeoutError();
  });
  const cancelMock = vi.fn(async () => undefined);
  return {
    waitForSpawn: waitForSpawnMock,
    cancel: cancelMock,
    waitForSpawnMock,
    cancelMock,
  };
}

describe("Windows disabled-task /Run through the real spawn-edge lease", () => {
  beforeEach(() => {
    // The ownership gate reads the task in front of `/Run`: it is this
    // account's, whose SID is the fixture principal's.
    setWindowsTaskUserSidReaderForTests(() => "S-1-5-21-1000-2000-3000-1001");
    setWindowsStartEvidenceDepsForTests({
      captureBaseline: async () => emptySpawnBaseline(),
      createEvidenceReader: () => ({ collect: async () => null }),
      sleep: async () => undefined,
      verifyTimeoutMs: 40,
      verifyPollMs: 10,
    });
  });

  afterEach(() => {
    setWindowsStartEvidenceDepsForTests(null);
    setWindowsDefinitionDepsForTests(null);
    setWindowsTaskUserSidReaderForTests(null);
  });

  // End to end: a disabled task's `/Run` failure does not read as a committed
  // registration, so the REAL `runWithLeaseAtServiceSpawnEdge` never waits
  // out the published lease's spawn-ack window for a task that could never
  // have run - it cancels the lease instead. Waited out, the ack timeout
  // would also mark the error an unacknowledged spawn, which
  // `startRetryingUnacknowledged` answers with a second start and a second
  // full wait (about 100 s on a real host before the refusal surfaced).
  it("a disabled task's /Run failure: waitForSpawn is never called, the lease is cancelled, and the error is not an unacknowledged spawn", async () => {
    setWindowsDefinitionDepsForTests({
      queryTaskXml: async () => ({
        kind: "xml",
        xml: definitionTaskXml("false"),
      }),
      predictCli: async () => {
        throw new Error("predictCli must not be called from /Run verification");
      },
      resolveCli: async () => {
        throw new Error("resolveCli must not be called from /Run verification");
      },
    });
    const lease = makeLeaseThatTimesOutAck();
    const publish = vi.fn(async (): Promise<ServiceSpawnEdgeLease> => lease);
    const controller = createWindowsController(
      refusingRunRunner(),
      noTimingDeps,
    );
    const start = (): Promise<void> =>
      controller.start(serviceLabelFor("staging"));

    const caught: unknown = await runWithLeaseAtServiceSpawnEdge(
      publish,
      start,
    ).catch((error: unknown) => error);

    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: expect.stringContaining("schtasks /Run failed for"),
    });
    expect(lease.waitForSpawnMock).toHaveBeenCalledTimes(0);
    expect(lease.cancelMock).toHaveBeenCalledTimes(1);
    expect(isUnacknowledgedSpawn(caught)).toBe(false);
  });

  // Control: an ENABLED task's `/Run` failure stays the ordinary
  // post-registration case - the lease's `waitForSpawn` runs, its ack timeout
  // is recorded as an unacknowledged spawn, and the Windows error still
  // propagates.
  it("control: an enabled task's /Run failure: waitForSpawn runs once, its ack timeout is recorded, and the error still propagates", async () => {
    setWindowsDefinitionDepsForTests({
      queryTaskXml: async () => ({
        kind: "xml",
        xml: definitionTaskXml(null),
      }),
      predictCli: async () => {
        throw new Error("predictCli must not be called from /Run verification");
      },
      resolveCli: async () => {
        throw new Error("resolveCli must not be called from /Run verification");
      },
    });
    const lease = makeLeaseThatTimesOutAck();
    const publish = vi.fn(async (): Promise<ServiceSpawnEdgeLease> => lease);
    const controller = createWindowsController(
      refusingRunRunner(),
      noTimingDeps,
    );
    const start = (): Promise<void> =>
      controller.start(serviceLabelFor("staging"));

    const caught: unknown = await runWithLeaseAtServiceSpawnEdge(
      publish,
      start,
    ).catch((error: unknown) => error);

    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: expect.stringContaining("schtasks /Run failed for"),
    });
    expect(lease.waitForSpawnMock).toHaveBeenCalledTimes(1);
    expect(isUnacknowledgedSpawn(caught)).toBe(true);
  });
});

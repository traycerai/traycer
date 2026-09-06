import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildScheduledTaskXml,
  buildWindowsSlotProcessDetailScanScript,
  buildWindowsSlotProcessTableScanScript,
  computeWindowsHostKillSet,
  createWindowsController,
  describeSlotLockHolders,
  killLingeringSlotProcesses,
  orderWindowsKillsDescendantsFirst,
  parseSchtasksLastRunResult,
  parseWindowsProcessDetailJson,
  parseWindowsProcessTableJson,
  setWindowsStartEvidenceDepsForTests,
  setWindowsTaskInstallDepsForTests,
  type ProcessRunner,
  type WindowsControllerDeps,
  type WindowsKillMemory,
  type WindowsKillVictim,
  type WindowsProcessTableRow,
  type WindowsStartEvidenceDeps,
  type WindowsTaskInstallDeps,
} from "../windows";
import { serviceLabelFor } from "../../label";
import { WINDOWS_KILL_CONVERGENCE_ROUNDS } from "@traycer/protocol/host/lifecycle-constants";
import { ProcessRunError, type RunResult } from "../../process-runner";
import type { SpawnEvidenceBaseline } from "../../../host/spawn-evidence";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import { didServiceRegistrationCommit } from "../../cli-invocation-record";
import {
  isServiceMutationAuthorityError,
  ServiceMutationAuthorityError,
} from "../../mutation-authority";

const mocks = vi.hoisted(() => ({
  readHostPidMetadata: vi.fn(),
  removeHostPidMetadata: vi.fn(),
}));

vi.mock("../../../host/pid-metadata", () => ({
  readHostPidMetadata: mocks.readHostPidMetadata,
  removeHostPidMetadata: mocks.removeHostPidMetadata,
}));

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

function success(stdout: string): RunResult {
  return { stdout, stderr: "", exitCode: 0 };
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

// Most call sites below never exercise `stop`/`uninstall`/`restart` at all
// (an install/start test never touches `killHostProcessTree`), and the ones
// that do mostly use ordinary slot rows with no victim carry-over in play, so
// the clock value itself is immaterial to them. A `now` of 0 is unsafe for a
// fixture with a LIVE carry-over though: it would make every remembered
// victim's window `[created, 0]`, which no positive `created` can ever fall
// inside - see the tests that build their own `WindowsControllerDeps` with a
// real clock value instead.
const noTimingDeps: WindowsControllerDeps = { now: () => 0 };

function stagedTaskInstallDeps(): WindowsTaskInstallDeps {
  return {
    stageTaskDefinition: async () => ({
      tmpDir: "/tmp/traycer-task-test",
      xmlPath: "/tmp/traycer-task-test/task.xml",
    }),
    removeStagedTaskDefinition: async () => undefined,
  };
}

// Most fixtures in this file only care about processId/parentProcessId/slot -
// the victim carry-over fields (claimedParentProcessId, created) are only
// meaningful to the tests that exercise that carry-over directly. This lets a
// fixture specify just the three original fields and default the other two
// (claimedParentProcessId = parentProcessId, created = 0) rather than forcing
// every row literal in the file to spell out fields it does not test.
// `created: 0` is what makes the default safe: `isChildOfVictim` refuses an
// unknown age on either end, so a defaulted row can never be spuriously
// seeded as a victim's descendant regardless of what its claimed parent is.
type TableRowInput = Pick<
  WindowsProcessTableRow,
  "processId" | "parentProcessId" | "slot"
> &
  Partial<Pick<WindowsProcessTableRow, "claimedParentProcessId" | "created">>;

function fullRow(row: TableRowInput): WindowsProcessTableRow {
  return {
    processId: row.processId,
    parentProcessId: row.parentProcessId,
    claimedParentProcessId: row.claimedParentProcessId ?? row.parentProcessId,
    created: row.created ?? 0,
    slot: row.slot,
  };
}

function rowsOf(rows: readonly TableRowInput[]): WindowsProcessTableRow[] {
  return rows.map(fullRow);
}

// An empty carry-over memory: the state of round 0, and what every pin that
// exercises a single snapshot on its own needs.
const nothingRemembered: WindowsKillMemory = {
  victims: new Map(),
  suspects: new Map(),
  protectedAncestors: new Map(),
};

// A memory that remembers kills but nothing undecided - the shape the window
// pins below reason about, where an earlier round killed a parent and this
// round has to decide what may be attributed to it.
function victimMemory(
  victims: ReadonlyMap<number, readonly WindowsKillVictim[]>,
): WindowsKillMemory {
  return { victims, suspects: new Map(), protectedAncestors: new Map() };
}

// A memory that remembers something undecided but no kill - the shape the
// suspect-inheritance pins reason about, where an earlier round could place a
// pid neither in the slot nor out of it.
function suspectMemory(
  suspects: ReadonlyMap<number, readonly number[]>,
): WindowsKillMemory {
  return { victims: new Map(), suspects, protectedAncestors: new Map() };
}

// Rows as the table scan's JSON, in the shape `parseWindowsProcessTableJson`
// expects. Shared by every fixture below that needs to hand a fake table back
// through `run("powershell.exe", ...)`.
function tableJson(rows: readonly TableRowInput[]): string {
  return JSON.stringify(
    rowsOf(rows).map((row) => ({
      ProcessId: row.processId,
      ParentProcessId: row.parentProcessId,
      ClaimedParentProcessId: row.claimedParentProcessId,
      Created: row.created,
      Slot: row.slot,
    })),
  );
}

// A fake scan-then-kill runner that CONVERGES the way the real scan does. A
// real scan verifies by exe path/command line, not by remembering what an
// earlier round saw, so a process this round's `taskkill` actually reached is
// simply ABSENT from the next snapshot - it isn't "seen and skipped", it's
// gone. `killHostProcessTree`'s bounded convergence loop (Codex round 2 on
// #1755: the old single-pass scan left anything spawned after the snapshot
// untouched) rescans after every kill, so a fixture that keeps returning one
// constant table makes every pid look like a survivor and gets re-killed
// `WINDOWS_KILL_CONVERGENCE_ROUNDS` times instead of once. This tracks which
// pids a `taskkill` call has fired for and drops those rows from every later
// snapshot, so a fixture built for the old one-pass code keeps its original
// meaning under the new loop.
function convergingTableRunner(rows: readonly TableRowInput[]): {
  readonly runner: ProcessRunner;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let live = rows;
  const runner: ProcessRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === "powershell.exe") return success(tableJson(live));
    if (command === "taskkill") {
      const killedPid = Number(args[2]);
      live = live.filter((row) => row.processId !== killedPid);
    }
    return success("");
  };
  return { runner, calls };
}

describe("Windows service stale host cleanup", () => {
  beforeEach(() => {
    mocks.readHostPidMetadata.mockReset();
    mocks.readHostPidMetadata.mockResolvedValue(null);
    mocks.removeHostPidMetadata.mockReset();
    mocks.removeHostPidMetadata.mockResolvedValue(undefined);
    setWindowsStartEvidenceDepsForTests(null);
    setWindowsTaskInstallDepsForTests(null);
  });

  afterEach(() => {
    setWindowsStartEvidenceDepsForTests(null);
    setWindowsTaskInstallDepsForTests(null);
  });

  it("parses PowerShell process table JSON", () => {
    expect(
      parseWindowsProcessTableJson(
        '[{"ProcessId":100,"ParentProcessId":1,"ClaimedParentProcessId":1,"Created":1000,"Slot":true},' +
          '{"ProcessId":200,"ParentProcessId":100,"ClaimedParentProcessId":100,"Created":2000,"Slot":false}]',
      ),
    ).toEqual([
      {
        processId: 100,
        parentProcessId: 1,
        claimedParentProcessId: 1,
        created: 1000,
        slot: true,
      },
      {
        processId: 200,
        parentProcessId: 100,
        claimedParentProcessId: 100,
        created: 2000,
        slot: false,
      },
    ]);
    // Windows PowerShell 5.1 emits a bare object for a single row.
    expect(
      parseWindowsProcessTableJson(
        '{"ProcessId":100,"ParentProcessId":1,"ClaimedParentProcessId":1,"Created":1000,"Slot":true}',
      ),
    ).toEqual([
      {
        processId: 100,
        parentProcessId: 1,
        claimedParentProcessId: 1,
        created: 1000,
        slot: true,
      },
    ]);
    // A row whose ProcessId equals this test process's own pid parses fine -
    // the table scan is deliberately unfiltered.
    expect(
      parseWindowsProcessTableJson(
        `{"ProcessId":${process.pid},"ParentProcessId":1,"ClaimedParentProcessId":1,"Created":1000,"Slot":false}`,
      ),
    ).toEqual([
      {
        processId: process.pid,
        parentProcessId: 1,
        claimedParentProcessId: 1,
        created: 1000,
        slot: false,
      },
    ]);
    // The System Idle Process is pid 0 with parent 0, and `Get-CimInstance
    // Win32_Process` always returns it. Rejecting it failed the WHOLE parse on
    // every real machine, silently demoting every stop to the pid.json
    // fallback. A parent of 0 ("no verified parent") is equally ordinary, and
    // so is a `Created` of 0 ("no creation time Windows could report").
    expect(
      parseWindowsProcessTableJson(
        '[{"ProcessId":0,"ParentProcessId":0,"ClaimedParentProcessId":0,"Created":0,"Slot":false},' +
          '{"ProcessId":100,"ParentProcessId":0,"ClaimedParentProcessId":0,"Created":0,"Slot":true}]',
      ),
    ).toEqual([
      {
        processId: 0,
        parentProcessId: 0,
        claimedParentProcessId: 0,
        created: 0,
        slot: false,
      },
      {
        processId: 100,
        parentProcessId: 0,
        claimedParentProcessId: 0,
        created: 0,
        slot: true,
      },
    ]);
    // Negative ids are still malformed, `ClaimedParentProcessId` and
    // `Created` included - they are held to the same non-negative-integer
    // shape as every other id/timestamp field.
    expect(
      parseWindowsProcessTableJson(
        '[{"ProcessId":-1,"ParentProcessId":0,"ClaimedParentProcessId":0,"Created":0,"Slot":false}]',
      ),
    ).toBeNull();
    expect(
      parseWindowsProcessTableJson(
        '[{"ProcessId":100,"ParentProcessId":-1,"ClaimedParentProcessId":0,"Created":0,"Slot":false}]',
      ),
    ).toBeNull();
    expect(
      parseWindowsProcessTableJson(
        '[{"ProcessId":100,"ParentProcessId":1,"ClaimedParentProcessId":-1,"Created":0,"Slot":false}]',
      ),
    ).toBeNull();
    expect(
      parseWindowsProcessTableJson(
        '[{"ProcessId":100,"ParentProcessId":1,"ClaimedParentProcessId":1,"Created":-1,"Slot":false}]',
      ),
    ).toBeNull();
    expect(parseWindowsProcessTableJson("[]")).toEqual([]);
    // Empty output means the scan never ran - `null`, not `[]`: a real
    // Win32_Process scan is never empty.
    expect(parseWindowsProcessTableJson("")).toBeNull();
    expect(parseWindowsProcessTableJson("not-json")).toBeNull();
    // Any malformed row fails the WHOLE parse (all-or-nothing).
    expect(
      parseWindowsProcessTableJson(
        '[{"ProcessId":"100","ParentProcessId":1,"ClaimedParentProcessId":1,"Created":0,"Slot":true}]',
      ),
    ).toBeNull();
    expect(
      parseWindowsProcessTableJson('[{"ProcessId":100,"Slot":true}]'),
    ).toBeNull();
    expect(
      parseWindowsProcessTableJson(
        '[{"ProcessId":100,"ParentProcessId":1,"ClaimedParentProcessId":1,"Created":0,"Slot":"true"}]',
      ),
    ).toBeNull();
    // Missing the new fields entirely is also malformed - a scan script that
    // regresses to emitting the old three-field row must not silently parse.
    expect(
      parseWindowsProcessTableJson(
        '[{"ProcessId":100,"ParentProcessId":1,"Slot":true}]',
      ),
    ).toBeNull();
    // Missing just ONE of the two new fields is equally malformed - the
    // all-or-nothing parse does not partially trust a row.
    expect(
      parseWindowsProcessTableJson(
        '[{"ProcessId":100,"ParentProcessId":1,"ClaimedParentProcessId":1,"Slot":true}]',
      ),
    ).toBeNull();
    expect(
      parseWindowsProcessTableJson(
        '[{"ProcessId":100,"ParentProcessId":1,"Created":1000,"Slot":true}]',
      ),
    ).toBeNull();
    expect(parseWindowsProcessTableJson('[100, "not-a-row"]')).toBeNull();
    // Two rows sharing a pid is not a table this code can reason over: the
    // parent map, the child map and the age lookup would each silently keep
    // a different one of the duplicates depending on iteration order, and
    // the kill set would depend on which. `Get-CimInstance` cannot produce
    // this, so a response that does is malformed - refused whole, like
    // every other shape violation above.
    expect(
      parseWindowsProcessTableJson(
        '[{"ProcessId":100,"ParentProcessId":1,"ClaimedParentProcessId":1,"Created":1000,"Slot":true},' +
          '{"ProcessId":100,"ParentProcessId":2,"ClaimedParentProcessId":2,"Created":2000,"Slot":false}]',
      ),
    ).toBeNull();

    // Ablation: in `parseProcessTableJson`, change `return null;` on a
    // malformed row to `continue;` (skipping just that row instead of
    // failing the whole parse) → the malformed-row assertions above fail:
    // a partial table would come back instead of `null`.
    // Ablation (§ablation table): drop the duplicate-pid rejection
    // (`if (seenProcessIds.has(processId)) return null;`) → the
    // duplicate-pid assertion above reddens: two rows sharing pid 100 parse
    // successfully instead of failing the whole table.
  });

  it("builds a table scan with the slot's install\\ prefix, ParentProcessId, and Slot fields, and no $excluded/$PID", () => {
    const script = buildWindowsSlotProcessTableScanScript(
      "C:\\Users\\Traycer Dev\\.traycer\\host\\staging",
    );
    expect(script).toContain("ParentProcessId = $parentId");
    expect(script).toContain("Slot = $hostMatch");
    expect(script).toContain(".traycer\\host\\staging\\install\\");
    expect(script).not.toContain("$excluded");
    expect(script).not.toContain("$PID");

    // Ablation: in `buildSlotProcessTableScanScript`, reintroduce
    // `$excluded = @(<pid>, $PID)` into the script → this test fails (the
    // `not.toContain("$PID")` assertion flips).
  });

  it("validates each parent edge against CreationDate from the same snapshot", () => {
    // Windows keeps the creator's id in `ParentProcessId` after the parent
    // exits, and may hand that id to an unrelated process. An edge is only
    // believed when the claimed parent is still in this snapshot and is not
    // YOUNGER than its claimed child; everything else is emitted as parent 0,
    // which the algebra reads as "no verified parent".
    //
    // This is a script-text pin. The PowerShell half is only really proved by
    // the live Windows run in the plan's release checklist - what the TS side
    // can prove is what the algebra does once a stale id has arrived as 0,
    // which the fixtures below cover.
    const script = buildWindowsSlotProcessTableScanScript(
      "C:\\Users\\Traycer Dev\\.traycer\\host",
    );
    // One read, materialised, so the ages compared come from the same
    // snapshot as the matches.
    expect(script).toContain("$table = @(Get-CimInstance Win32_Process)");
    expect(script).toContain(
      "if ($null -eq $row.CreationDate) { $created[[int]$row.ProcessId] = $null }",
    );
    expect(script).toContain(
      "else { $created[[int]$row.ProcessId] = $row.CreationDate.ToUniversalTime() }",
    );
    expect(script).toContain(
      "if ($parentId -le 0 -or -not $created.ContainsKey($parentId)) {",
    );
    expect(script).toContain("} elseif ($parentCreated -gt $childCreated) {");
    // A missing CreationDate on either end (pid 0 and System have none) is
    // uncertainty, so it fails closed to 0 like any other unverifiable edge.
    expect(script).toContain(
      "if ($null -eq $parentCreated -or $null -eq $childCreated) {",
    );
    // The two fields the victim carry-over needs: the RAW claimed parent
    // (unvalidated, unlike `ParentProcessId` above) and the row's own age.
    expect(script).toContain(
      "ClaimedParentProcessId = [int]$_.ParentProcessId",
    );
    expect(script).toContain("Created = $createdMicros");
    // `Created`'s own guard: 0 when Windows reports no creation time at all
    // (pid 0 and System have none), never a stale or default timestamp.
    expect(script).toContain("$createdMicros = 0");
    expect(script).toContain(
      "if ($null -ne $_.CreationDate) { $childCreated = $_.CreationDate.ToUniversalTime() }",
    );
    // P1-c: both operands of the edge validation are normalised to UTC.
    // `CreationDate` arrives as a local DateTime, and local time is not
    // monotonic across a DST fall-back - dropping `ToUniversalTime()` on
    // either side lets a process started in the second pass of the
    // repeated hour compare as OLDER than one from the first, and the scan
    // would VALIDATE that edge instead of refusing it. Nothing else pins
    // this: it is only visible in the exact text used to build `$created`
    // and `$childCreated`.
    expect(script).toContain(
      "$created[[int]$row.ProcessId] = $row.CreationDate.ToUniversalTime()",
    );
    expect(script).toContain(
      "$childCreated = $_.CreationDate.ToUniversalTime()",
    );
    // P1-b: microseconds, not milliseconds - `Ticks / 10` converts the
    // TimeSpan's 100ns units, floored to stay an integer.
    expect(script).toContain(
      "$createdMicros = [long][math]::Floor(($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').Ticks / 10)",
    );

    // Ablation: in `buildSlotProcessTableScanScript`, drop
    // `...PARENT_EDGE_VALIDATION_SCRIPT_LINES` and emit
    // `ParentProcessId = [int]$_.ParentProcessId` again → this test fails, and
    // a recycled creator id becomes a believed ancestry edge.
    // Ablation (§ablation table): drop `.ToUniversalTime()` from either
    // operand of the edge validation → the UTC-normalisation assertions
    // above fail; a DST fall-back can then validate a stranger's edge.
  });

  it("does not use broad production roots as process-match prefixes", () => {
    const script = buildWindowsSlotProcessTableScanScript(
      "C:\\Users\\Traycer Dev\\.traycer\\host",
    );
    expect(script).toContain(
      "c:\\users\\traycer dev\\.traycer\\host\\install\\",
    );
    expect(script).not.toContain("'c:\\users\\traycer dev\\.traycer\\host'");
  });

  it("builds a detail scan sharing the shared slot-match block with the table scan, projecting name and executable path", () => {
    const detail = buildWindowsSlotProcessDetailScanScript({
      hostHome: "C:\\Users\\Traycer Dev\\.traycer\\host",
      currentPid: 1234,
    });
    expect(detail).toContain("$excluded = @(1234, $PID)");
    expect(detail).toContain(
      "c:\\users\\traycer dev\\.traycer\\host\\install\\",
    );
    expect(detail).toContain("Select-Object ProcessId, Name, ExecutablePath");
    // The anti-drift invariant that survives the scan split: both scripts
    // must contain the identical shared slot-match block, verbatim.
    const tableScan = buildWindowsSlotProcessTableScanScript(
      "C:\\Users\\Traycer Dev\\.traycer\\host",
    );
    const sharedBlock = [
      "    $exe = ([string]$_.ExecutablePath).ToLowerInvariant().Replace('/', '\\')",
      "    $cmd = ([string]$_.CommandLine).ToLowerInvariant().Replace('/', '\\')",
      '    $text = $exe + "`n" + $cmd',
      "    $hostMatch = $false",
      "    foreach ($path in $hostPaths) {",
      "      if ($text.Contains($path)) { $hostMatch = $true; break }",
      "    }",
    ].join("\n");
    expect(detail).toContain(sharedBlock);
    expect(tableScan).toContain(sharedBlock);
  });

  it("parses PowerShell process detail JSON in both array and single-object shape", () => {
    expect(
      parseWindowsProcessDetailJson(
        '[{"ProcessId":401,"Name":"claude.exe","ExecutablePath":"C:\\\\clients\\\\claude.exe"},{"ProcessId":402,"Name":"","ExecutablePath":null}]',
      ),
    ).toEqual([
      {
        pid: 401,
        name: "claude.exe",
        executablePath: "C:\\clients\\claude.exe",
      },
      { pid: 402, name: null, executablePath: null },
    ]);
    // Windows PowerShell 5.1 emits a bare object for a single match even
    // under `@(...)`.
    expect(
      parseWindowsProcessDetailJson(
        '{"ProcessId":401,"Name":"node.exe","ExecutablePath":"C:\\\\node.exe"}',
      ),
    ).toEqual([{ pid: 401, name: "node.exe", executablePath: "C:\\node.exe" }]);
    expect(parseWindowsProcessDetailJson("")).toEqual([]);
    expect(parseWindowsProcessDetailJson("not-json")).toEqual([]);
    expect(parseWindowsProcessDetailJson('{"Name":"no-pid.exe"}')).toEqual([]);
  });

  it("describes slot lock holders via the detail scan", async () => {
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      return success(
        '[{"ProcessId":88,"Name":"orphan.exe","ExecutablePath":"C:\\\\orphan.exe"}]',
      );
    };

    const holders = await describeSlotLockHolders(
      serviceLabelFor("staging"),
      runner,
    );

    expect(holders).toEqual([
      { pid: 88, name: "orphan.exe", executablePath: "C:\\orphan.exe" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("powershell.exe");
    expect(calls[0]?.args.at(-1)).toContain(
      "Select-Object ProcessId, Name, ExecutablePath",
    );
  });

  it("reports no lock holders when the detail scan cannot run", async () => {
    const runner: ProcessRunner = async () => {
      throw new Error("spawn failed");
    };

    await expect(
      describeSlotLockHolders(serviceLabelFor("staging"), runner),
    ).resolves.toEqual([]);
  });

  // The production `killHostProcessTree` always passes `process.pid` (this
  // test process's own pid) as the CLI identity, so every fake table below
  // treats `process.pid` as an ordinary, unrelated process with no parent in
  // the table - it must never appear in a kill set built from these tables.

  it("re-kills scan-verified processes through killLingeringSlotProcesses", async () => {
    const { runner, calls } = convergingTableRunner([
      { processId: 401, parentProcessId: 1, slot: true },
    ]);

    await killLingeringSlotProcesses(
      serviceLabelFor("staging"),
      runner,
      noTimingDeps,
    );

    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args),
    ).toEqual([["/F", "/PID", "401"]]);
    expect(calls.every((call) => !call.args.includes("/T"))).toBe(true);
  });

  it("kills slot-scanned processes when pid metadata is missing", async () => {
    const { runner, calls } = convergingTableRunner([
      { processId: 401, parentProcessId: 1, slot: true },
      { processId: 402, parentProcessId: 1, slot: true },
    ]);
    const controller = createWindowsController(runner, noTimingDeps);

    await controller.stop(serviceLabelFor("staging"), { force: false });

    expect(calls[0]).toMatchObject({
      command: "schtasks",
      args: ["/End", "/TN", "\\Traycer\\Host-Staging"],
    });
    expect(calls.some((call) => call.command === "powershell.exe")).toBe(true);
    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args),
    ).toEqual([
      ["/F", "/PID", "401"],
      ["/F", "/PID", "402"],
    ]);
  });

  it("kills exactly the scan-verified pids when the scan covers the recorded pid", async () => {
    mocks.readHostPidMetadata.mockResolvedValue({
      pid: 401,
      hostId: "host-test",
      version: "1.0.0",
      websocketUrl: "ws://127.0.0.1:54321/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const { runner, calls } = convergingTableRunner([
      { processId: 401, parentProcessId: 1, slot: true },
      { processId: 402, parentProcessId: 1, slot: true },
    ]);
    const controller = createWindowsController(runner, noTimingDeps);

    await controller.stop(serviceLabelFor("staging"), { force: false });

    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args[2]),
    ).toEqual(["401", "402"]);
  });

  it("does not kill the recorded pid when the scan verifies it no longer matches the host", async () => {
    // pid.json says 401, but the verified slot scan only shows 402 as a slot
    // match - the OS recycled 401 for an unrelated (non-slot) process, which
    // must survive.
    mocks.readHostPidMetadata.mockResolvedValue({
      pid: 401,
      hostId: "host-test",
      version: "1.0.0",
      websocketUrl: "ws://127.0.0.1:54321/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const { runner, calls } = convergingTableRunner([
      { processId: 401, parentProcessId: 1, slot: false },
      { processId: 402, parentProcessId: 1, slot: true },
    ]);
    const controller = createWindowsController(runner, noTimingDeps);

    await controller.stop(serviceLabelFor("staging"), { force: false });

    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args[2]),
    ).toEqual(["402"]);
  });

  it("purges pid metadata on uninstall like it does on stop", async () => {
    const runner: ProcessRunner = async (command) =>
      command === "powershell.exe" ? success("[]") : success("");
    const controller = createWindowsController(runner, noTimingDeps);

    await controller.uninstall({ label: serviceLabelFor("staging") });

    expect(mocks.removeHostPidMetadata).toHaveBeenCalledWith("staging");
  });

  it("purges pid metadata on stop so a deliberate stop never reads as a crash", async () => {
    const runner: ProcessRunner = async (command) =>
      command === "powershell.exe" ? success("[]") : success("");
    const controller = createWindowsController(runner, noTimingDeps);

    await controller.stop(serviceLabelFor("staging"), { force: false });

    expect(mocks.removeHostPidMetadata).toHaveBeenCalledWith("staging");
  });

  // The other side of the same rule as the test above: a stop that could not
  // be VERIFIED must not purge pid.json either. Codex's finding in full was
  // "`stopService` then deletes pid.json and `host stop` says success while
  // descendants live" - a refused stop reporting the host gone would be that
  // exact bug wearing a different trigger.
  //
  // Ablation (§ablation table, row 2): the same `scannedPids === null`
  // `throw` → `return` mutation reddens this test too - the promise
  // resolves, so `removeHostPidMetadata` gets called after all.
  it("does NOT purge pid metadata when the stop refuses - a refusal must not read as a clean exit", async () => {
    const runner: ProcessRunner = async (command) => {
      if (command === "powershell.exe") throw new Error("spawn failed");
      return success("");
    };
    const controller = createWindowsController(runner, noTimingDeps);

    await expect(
      controller.stop(serviceLabelFor("staging"), { force: false }),
    ).rejects.toMatchObject({ code: "E_SERVICE_CONTROL_FAILED" });

    expect(mocks.removeHostPidMetadata).not.toHaveBeenCalled();
  });
});

// `killHostProcessTree` (Codex round 2 on #1755, one P2): the scan is a
// SNAPSHOT, so a process the host or an agent under it spawns after
// `Get-CimInstance` materializes the table is in no round's kill set - and
// with no `/T`, nothing walks down to catch it. `killProcessIds`' argv is
// covered above; these pin the ROUND STRUCTURE around it: a bounded
// scan-then-kill loop that stops the moment a scan comes back empty.
describe("killHostProcessTree convergence loop", () => {
  beforeEach(() => {
    mocks.readHostPidMetadata.mockReset();
    mocks.readHostPidMetadata.mockResolvedValue(null);
    mocks.removeHostPidMetadata.mockReset();
    mocks.removeHostPidMetadata.mockResolvedValue(undefined);
  });

  // A per-round scripted scan, for scenarios `convergingTableRunner`'s
  // kill-tracking can't express - a snapshot that materializes a pid no
  // earlier round ever saw (a late spawn), or a scan that only fails on a
  // LATER round. `responses[n]` is the table (or throw) the (n+1)th
  // `powershell.exe` call answers with; once exhausted, further calls answer
  // with an empty table (converged) rather than reusing the last response -
  // a test that needs more rounds than it scripted should say so explicitly.
  type RoundResponse =
    | {
        readonly kind: "table";
        readonly rows: readonly TableRowInput[];
      }
    | { readonly kind: "throw" };

  function roundedRunner(responses: readonly RoundResponse[]): {
    readonly runner: ProcessRunner;
    readonly calls: RecordedCall[];
  } {
    const calls: RecordedCall[] = [];
    let scanCount = 0;
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "powershell.exe") {
        const response = responses[scanCount] ?? { kind: "table", rows: [] };
        scanCount += 1;
        if (response.kind === "throw") throw new Error("spawn failed");
        return success(tableJson(response.rows));
      }
      return success("");
    };
    return { runner, calls };
  }

  it("convergence catches a late spawn: a process absent from round 1's snapshot is still killed in round 2", async () => {
    // Round 1 sees A and B; round 2's snapshot has C instead - a process that
    // spawned only after round 1's `Get-CimInstance` ran, which a single-pass
    // scan (the bug Codex found) would never enumerate at all; round 3 is
    // clean. This is the exact finding: without the loop, C survives the stop.
    const { runner, calls } = roundedRunner([
      {
        kind: "table",
        rows: [
          { processId: 401, parentProcessId: 1, slot: true },
          { processId: 402, parentProcessId: 1, slot: true },
        ],
      },
      {
        kind: "table",
        rows: [{ processId: 403, parentProcessId: 1, slot: true }],
      },
      { kind: "table", rows: [] },
    ]);
    const controller = createWindowsController(runner, noTimingDeps);

    await controller.stop(serviceLabelFor("staging"), { force: false });

    // The kill set is asserted FIRST on purpose: it is the finding's own
    // symptom, so a regression here reports "403 was never killed" rather
    // than an arithmetic complaint about how many times we scanned.
    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args),
    ).toEqual([
      ["/F", "/PID", "401"],
      ["/F", "/PID", "402"],
      ["/F", "/PID", "403"],
    ]);
    expect(
      calls.filter((call) => call.command === "powershell.exe"),
    ).toHaveLength(3);

    // Ablation (§C): in `killHostProcessTree`, change the loop bound from
    // `round <= WINDOWS_KILL_CONVERGENCE_ROUNDS` to `round <= 1` (a single
    // pass) → this test fails: only 401 and 402 are ever killed, one
    // `powershell.exe` call is made instead of three, and 403 - the late
    // spawn - survives the stop exactly as the Codex finding describes.
  });

  it("the bound holds AND the stop fails naming the survivors: a host that never stops spawning is not killed forever", async () => {
    // Every round's scan hands back a BRAND NEW pid, so the loop never
    // converges on its own - the only thing that ends it is the round bound.
    // Bounded is the right call: a host spawning faster than we can scan is
    // not converging, and grinding on it forever is worse than refusing and
    // naming the survivors so an operator (or the swap's own EBUSY detail
    // scan) can act on them.
    let scanCount = 0;
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "powershell.exe") {
        const pid = 800 + scanCount;
        scanCount += 1;
        return success(
          tableJson([{ processId: pid, parentProcessId: 1, slot: true }]),
        );
      }
      return success("");
    };
    const controller = createWindowsController(runner, noTimingDeps);

    // One more scan than kills: the confirming scan after the last kill
    // round is the one that catches the still-occupied slot and refuses,
    // rather than a scan that silently reports converged.
    await expect(
      controller.stop(serviceLabelFor("staging"), { force: false }),
    ).rejects.toMatchObject({
      code: "E_SERVICE_CONTROL_FAILED",
      details: { survivingPids: [800 + WINDOWS_KILL_CONVERGENCE_ROUNDS] },
    });

    expect(
      calls.filter((call) => call.command === "powershell.exe"),
    ).toHaveLength(WINDOWS_KILL_CONVERGENCE_ROUNDS + 1);
    const taskkillPids = calls
      .filter((call) => call.command === "taskkill")
      .map((call) => call.args[2]);
    expect(taskkillPids).toEqual(
      Array.from({ length: WINDOWS_KILL_CONVERGENCE_ROUNDS }, (_, index) =>
        String(800 + index),
      ),
    );

    // Ablation (§ablation table, row 1): in `killHostProcessTree`, change
    // the bound refusal's `throw cliError(...)` to `return;` (restore the
    // silent fallthrough) → this test fails: the call resolves instead of
    // rejecting, and the still-running pid (800 + ROUNDS) is reported as a
    // successful stop.
  });

  it("a lingering already-killed pid exhausts the bound - the same never-dying pid every round, not a fresh spawn", async () => {
    // The OTHER honest-failure path the function comment's caveat names:
    // `taskkill /F` is `TerminateProcess`, asynchronous, so a confirming scan
    // can briefly still list a pid a previous round already killed. The
    // bound absorbs ONE such round; this pushes that to its limit - the
    // scan returns the exact SAME pid every round (as if `taskkill` never
    // actually reaped it), never a fresh spawn - and the loop still refuses
    // rather than grinding forever or quietly reporting success.
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "powershell.exe") {
        return success(
          tableJson([{ processId: 900, parentProcessId: 1, slot: true }]),
        );
      }
      return success("");
    };
    const controller = createWindowsController(runner, noTimingDeps);

    await expect(
      controller.stop(serviceLabelFor("staging"), { force: false }),
    ).rejects.toMatchObject({
      code: "E_SERVICE_CONTROL_FAILED",
      details: { survivingPids: [900] },
    });

    expect(
      calls.filter((call) => call.command === "powershell.exe"),
    ).toHaveLength(WINDOWS_KILL_CONVERGENCE_ROUNDS + 1);
    // taskkill fired every round, not skipped just because it is the "same"
    // pid as last time - the loop has no way to know that without a scan
    // proving it, and a scan proving it IS what this test denies it.
    expect(calls.filter((call) => call.command === "taskkill")).toHaveLength(
      WINDOWS_KILL_CONVERGENCE_ROUNDS,
    );
  });

  it("refuses before killing anything when the scan is unavailable - the round-0 case of the general rule", async () => {
    // There used to be a pid.json fallback here: kill the one recorded pid,
    // unverified, and move on. That let a stop report success while
    // descendants the fallback never enumerated kept running and kept the
    // install dir open - the finding this pins the fix for. An unreadable
    // scan now refuses the whole stop, before anything is touched, so the
    // tree is left whole for the next attempt. The "NEVER /T" pin the old
    // fallback test carried is still covered by "re-kills scan-verified
    // processes" and "host-spawned" elsewhere in this file, which exercise a
    // real kill.
    const { runner, calls } = roundedRunner([{ kind: "throw" }]);
    const controller = createWindowsController(runner, noTimingDeps);

    await expect(
      controller.stop(serviceLabelFor("staging"), { force: false }),
    ).rejects.toMatchObject({ code: "E_SERVICE_CONTROL_FAILED" });

    expect(
      calls.filter((call) => call.command === "powershell.exe"),
    ).toHaveLength(1);
    expect(calls.filter((call) => call.command === "taskkill")).toHaveLength(0);
    expect(mocks.readHostPidMetadata).not.toHaveBeenCalled();

    // Ablation (§ablation table, row 2): in `killHostProcessTree`, change
    // `if (scanned === null) throw cliError(...)` to `if (scanned === null)
    // return;` → this test fails: the call resolves instead of rejecting,
    // and a scan that never ran is reported as a clean stop.
  });

  it("a scan that fails after earlier kills still fails the stop - a stale recorded pid is not a second opinion", async () => {
    // Round 0 kills 901 normally. Round 1's scan is unavailable - and this is
    // NOT a moment for any fallback: round 0 may already have killed the one
    // pid a fallback would have named, so consulting a recorded pid here
    // would be exactly the recycled-pid kill the scan-verification exists to
    // prevent. There is no fallback at all now, so the question this test
    // pins is narrower than it used to be: does an EARLIER round's real kill
    // still happen before the LATER round's refusal, and does the refusal
    // still refuse rather than quietly accepting round 0's kill as enough.
    const { runner, calls } = roundedRunner([
      {
        kind: "table",
        rows: [{ processId: 901, parentProcessId: 1, slot: true }],
      },
      { kind: "throw" },
    ]);
    const controller = createWindowsController(runner, noTimingDeps);

    await expect(
      controller.stop(serviceLabelFor("staging"), { force: false }),
    ).rejects.toMatchObject({ code: "E_SERVICE_CONTROL_FAILED" });

    expect(
      calls.filter((call) => call.command === "powershell.exe"),
    ).toHaveLength(2);
    // Round 0's kill still happened - the refusal is about round 1's scan,
    // not a reason to have skipped work already done.
    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args),
    ).toEqual([["/F", "/PID", "901"]]);
    expect(mocks.readHostPidMetadata).not.toHaveBeenCalled();

    // Ablation (§ablation table, row 2): the same `scanned === null` `throw`
    // → `return` mutation reddens this test too - round 1's unreadable scan
    // stops refusing, so the whole stop resolves even though it never
    // confirmed the tree came down.
  });

  it("carries the victim set BETWEEN rounds: round 1's orphan is only killable because round 0's victim is remembered", async () => {
    // Chronology (sample 5000 before every scan; every row is born before
    // it, so each is present in every scan taken while it lives):
    //   R0: host 100 (born 1000, slot) and its validated child 555 (born
    //       1500, a shell or provider binary whose own path matches nothing).
    //       Both are killed, 555 first.
    //   R1: 100 is gone. 555 is STILL listed - `taskkill /F` is
    //       `TerminateProcess`, asynchronous, and the loop's own comment names
    //       this case - and its edge now arrives as `parentProcessId` 0: the
    //       parent that would have vouched for it is dead. Its own path
    //       matches nothing. Without `priorVictims` carrying 100's window
    //       forward, 555 is an ordinary unrelated process and the loop reports
    //       convergence while it lives. With it, 555 (born 1500, inside
    //       [1000, 5000]) is seeded and killed again.
    //   R2: empty. Converged.
    const { runner, calls } = roundedRunner([
      {
        kind: "table",
        rows: [
          { processId: 100, parentProcessId: 1, created: 1000, slot: true },
          {
            processId: 555,
            parentProcessId: 100,
            claimedParentProcessId: 100,
            created: 1500,
            slot: false,
          },
        ],
      },
      {
        kind: "table",
        rows: [
          {
            processId: 555,
            parentProcessId: 0,
            claimedParentProcessId: 100,
            created: 1500,
            slot: false,
          },
        ],
      },
      { kind: "table", rows: [] },
    ]);
    const controller = createWindowsController(runner, { now: () => 5000 });

    await controller.stop(serviceLabelFor("staging"), { force: false });

    expect(
      calls.filter((call) => call.command === "powershell.exe"),
    ).toHaveLength(3);
    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args),
    ).toEqual([
      ["/F", "/PID", "555"],
      ["/F", "/PID", "100"],
      ["/F", "/PID", "555"],
    ]);

    // Ablation (§ablation table): in `classifyCarryOverClaim`, replace the
    // body with `return "none";` → this test reddens alongside the direct
    // "the finding" algebra pin below - 555 is never seeded in round 1, that
    // kill set comes back empty, and the stop resolves with 555 still alive.
  });

  it("the victim map ACCUMULATES across rounds rather than being replaced - round 2 still needs round 0's victim remembered", async () => {
    // The CLI (this process, pid 9999 here) was launched from shell 700,
    // which the host 100 spawned - the "terminal-run" topology. 700 is the
    // CLI's ancestor and is SPARED every round, and that is what makes this
    // history coherent: a long-lived row that keeps claiming a dead victim.
    // Chronology (the clock is sampled before each scan: 5000, 7000, 9000,
    // 11000):
    //   R0 (sample 5000): 100 (born 1000, slot), 700 (born 2000, child of
    //       100), CLI 9999 (born 2500, child of 700). Kill set: 100 only -
    //       700 and the CLI are the spared branch.
    //   R1 (sample 7000): 100 gone; 700 now claims a dead parent
    //       (`parentProcessId` 0) and is a carry-over seed through remembered
    //       100 (born 2000, inside [1000, 5000]); a NEW sibling of the CLI,
    //       555 (born 6000, validated child of 700), is 700's descendant and
    //       dies. 555 born after R0's sample is why it is absent from R0.
    //   R2 (sample 9000): 700 and the CLI again, plus another new sibling
    //       888 (born 8000). 888 dies for the same reason - and ONLY because
    //       100 is still remembered: a per-round reset would leave just 555
    //       in the map, 700 would no longer be a seed, and 888 would survive
    //       into a "converged" stop.
    //   R3 (sample 11000): 700 and the CLI. 700 is a seed with nothing
    //       unspared beneath it. Converged.
    const rows700 = (extra: readonly TableRowInput[]): TableRowInput[] => [
      {
        processId: 700,
        parentProcessId: 0,
        claimedParentProcessId: 100,
        created: 2000,
        slot: false,
      },
      {
        processId: 9999,
        parentProcessId: 700,
        claimedParentProcessId: 700,
        created: 2500,
        slot: false,
      },
      ...extra,
    ];
    const { runner, calls } = roundedRunner([
      {
        kind: "table",
        rows: [
          { processId: 100, parentProcessId: 1, created: 1000, slot: true },
          {
            processId: 700,
            parentProcessId: 100,
            claimedParentProcessId: 100,
            created: 2000,
            slot: false,
          },
          {
            processId: 9999,
            parentProcessId: 700,
            claimedParentProcessId: 700,
            created: 2500,
            slot: false,
          },
        ],
      },
      {
        kind: "table",
        rows: rows700([
          {
            processId: 555,
            parentProcessId: 700,
            claimedParentProcessId: 700,
            created: 6000,
            slot: false,
          },
        ]),
      },
      {
        kind: "table",
        rows: rows700([
          {
            processId: 888,
            parentProcessId: 700,
            claimedParentProcessId: 700,
            created: 8000,
            slot: false,
          },
        ]),
      },
      { kind: "table", rows: rows700([]) },
    ]);
    const samples = [5000, 7000, 9000, 11000];
    let sample = 0;
    const controller = createWindowsController(runner, {
      now: () => {
        const value = samples[sample] ?? 11000;
        sample += 1;
        return value;
      },
    });

    const originalPid = Object.getOwnPropertyDescriptor(process, "pid");
    Object.defineProperty(process, "pid", { value: 9999, configurable: true });
    try {
      await controller.stop(serviceLabelFor("staging"), { force: false });
    } finally {
      if (originalPid !== undefined) {
        Object.defineProperty(process, "pid", originalPid);
      }
    }

    expect(
      calls.filter((call) => call.command === "powershell.exe"),
    ).toHaveLength(4);
    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args),
    ).toEqual([
      ["/F", "/PID", "100"],
      ["/F", "/PID", "555"],
      ["/F", "/PID", "888"],
    ]);

    // Ablation: in `killHostProcessTree`, keep only the latest round's
    // victims - `priorVictims.clear()` just before the recording loop at the
    // END of each round → this test reddens: round 2 remembers only 555, 700
    // is no longer a seed, and the stop resolves without ever issuing a kill
    // for 888. (Clearing at the TOP of every round is the cruder mutation and
    // reddens earlier: round 1 already remembers nothing, so 555 is never
    // issued either and the stop resolves after the single kill of 100.)
  });

  it("the victim recorder APPENDS: a lingering victim is re-killed through the OLDER window after its parent's pid was killed again as a newcomer", async () => {
    // The loop-level twin of the "two victim windows for one pid" algebra
    // pin: that one builds its memory by hand, so only a fixture that runs
    // `rememberIncarnation` twice for one pid in the SAME map can tell an
    // append from an overwrite. Chronology (samples 5000, 7000, 9000,
    // 11000):
    //   R0 (sample 5000): host 100 (born 1000, slot) and its validated child
    //       555 (born 2000). Both killed; victims 100 = [1000, 5000],
    //       555 = [2000, 5000].
    //   R1 (sample 7000): a re-launched slot process wears pid 100 again
    //       (born 6000, slot-matched); 555 lingers in its asynchronous
    //       `TerminateProcess`, and the scan zeroes its edge because the
    //       holder of 100 is now younger than it. 555 claims remembered 100
    //       and sits inside the OLD window: seed. Both killed again; 100 gains
    //       a second window [6000, 7000].
    //   R2 (sample 9000): 555 still lingers, still claiming 100. Against the
    //       newer window it is "older than the victim" - none; against the
    //       older one it is inside - seed. The older entry is what still
    //       issues the kill.
    //   R3 (sample 11000): empty. Converged.
    const samples = [5000, 7000, 9000, 11000];
    let sample = 0;
    const lingering555: TableRowInput = {
      processId: 555,
      parentProcessId: 0,
      claimedParentProcessId: 100,
      created: 2000,
      slot: false,
    };
    const { runner, calls } = roundedRunner([
      {
        kind: "table",
        rows: [
          { processId: 100, parentProcessId: 1, created: 1000, slot: true },
          {
            processId: 555,
            parentProcessId: 100,
            claimedParentProcessId: 100,
            created: 2000,
            slot: false,
          },
        ],
      },
      {
        kind: "table",
        rows: [
          { processId: 100, parentProcessId: 1, created: 6000, slot: true },
          lingering555,
        ],
      },
      { kind: "table", rows: [lingering555] },
      { kind: "table", rows: [] },
    ]);
    const controller = createWindowsController(runner, {
      now: () => {
        const value = samples[sample] ?? 11000;
        sample += 1;
        return value;
      },
    });

    await controller.stop(serviceLabelFor("staging"), { force: false });

    expect(
      calls.filter((call) => call.command === "powershell.exe"),
    ).toHaveLength(4);
    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args),
    ).toEqual([
      ["/F", "/PID", "555"],
      ["/F", "/PID", "100"],
      ["/F", "/PID", "100"],
      ["/F", "/PID", "555"],
      ["/F", "/PID", "555"],
    ]);

    // Ablation: in `rememberIncarnation`, replace the push with an overwrite
    // (`memory.set(pid, [incarnation])` on both arms) → this test reddens:
    // round 2 remembers only the newcomer's window for 100, 555 (born 2000)
    // reads as older than that victim, and the stop resolves after three
    // scans and four kills with 555 still alive. Nothing else in the loop
    // masks it - 555 is a victim, never a suspect, so no suspect entry keeps
    // it in play.
  });

  it("kills within a round deepest-first: a 3-node chain is issued grandchild, child, host", async () => {
    // `orderWindowsKillsDescendantsFirst` at the LOOP level, not just as a
    // standalone algebra pin: a round's kill set is issued in argv order
    // grandchild -> child -> host, shrinking the window where a parent is
    // already gone while its still-scanned child is not yet reaped.
    const { runner, calls } = roundedRunner([
      {
        kind: "table",
        rows: [
          { processId: 100, parentProcessId: 1, slot: true },
          { processId: 150, parentProcessId: 100, slot: false },
          { processId: 160, parentProcessId: 150, slot: false },
        ],
      },
      { kind: "table", rows: [] },
    ]);
    const controller = createWindowsController(runner, noTimingDeps);

    await controller.stop(serviceLabelFor("staging"), { force: false });

    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args[2]),
    ).toEqual(["160", "150", "100"]);

    // Ablation (§ablation table): in `orderWindowsKillsDescendantsFirst`,
    // change the body to `return pids;` (issue order unchanged) → run and
    // confirmed: this test reddens (order reverts to ascending-pid), and so
    // do the standalone algebra pin below and the "host-spawned" /
    // "terminal-run" tests above, which also assert deepest-first order now
    // that the loop applies it.
  });

  // P2-2 (round 5d): an older stranger claiming a killed process as its
  // parent is DECIDED, not undecided - a process cannot predate its own
  // parent, so the claim is simply false, and every retry finds the same
  // stranger sitting in exactly the same place. The stop must actually
  // SUCCEED around it rather than refusing forever over a claim that can
  // never resolve.
  it("an older stranger claiming a killed victim as its parent, present in every scan, does not block a successful stop", async () => {
    const { runner, calls } = roundedRunner([
      {
        kind: "table",
        rows: [
          { processId: 100, parentProcessId: 1, created: 1000, slot: true },
          {
            processId: 777,
            parentProcessId: 0,
            claimedParentProcessId: 100,
            created: 500,
            slot: false,
          },
        ],
      },
      {
        kind: "table",
        rows: [
          {
            processId: 777,
            parentProcessId: 0,
            claimedParentProcessId: 100,
            created: 500,
            slot: false,
          },
        ],
      },
    ]);
    const controller = createWindowsController(runner, { now: () => 2000 });

    await expect(
      controller.stop(serviceLabelFor("staging"), { force: false }),
    ).resolves.toBeUndefined();

    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args[2]),
    ).toEqual(["100"]);

    // Ablation (§ablation table): change `created < victim.created` to
    // `return "unattributed"` in `classifyAgainstVictim` → this test
    // reddens: 777 (born 500, before 100's own birth at 1000) is reported
    // unattributed forever, and the stop that should succeed refuses
    // instead.
  });

  // P1-a (round 5c): `seenAliveAt` must be sampled BEFORE the scan that
  // selects a round's victims, not before the kills that follow it. Before
  // the scan is what lets the soundness argument hold: the scan then
  // observes the victim alive at some instant AFTER the sample, so the pid
  // was demonstrably still the victim's at the sampled instant. Sampled
  // later, the clock could read a moment after the victim already exited,
  // its pid was reused, and the replacement forked a child - all before the
  // sample - and that child's birth would then fall inside a window it has
  // no business being in.
  it("the clock is sampled BEFORE the scan, not after: a row born during the scan is unattributed and the stop refuses", async () => {
    let clock = 2000;
    const now = (): number => clock;
    const calls: RecordedCall[] = [];
    let scanCount = 0;
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "powershell.exe") {
        scanCount += 1;
        if (scanCount === 1) {
          const stdout = tableJson([
            { processId: 100, parentProcessId: 1, created: 1000, slot: true },
          ]);
          // Time passes WHILE this scan "runs" (the real analogue is
          // `Get-CimInstance` taking real wall-clock time) - after the
          // sample that fed round 0's `seenAliveAt`, before round 1's.
          clock = 5000;
          return success(stdout);
        }
        if (scanCount === 2) {
          return success(
            tableJson([
              {
                processId: 777,
                parentProcessId: 0,
                claimedParentProcessId: 100,
                created: 3000,
                slot: false,
              },
            ]),
          );
        }
        return success(tableJson([]));
      }
      return success("");
    };
    const controller = createWindowsController(runner, { now });

    await expect(
      controller.stop(serviceLabelFor("staging"), { force: false }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      details: { unattributedPids: [777] },
    });

    // Round 0 killed 100 using the sample taken BEFORE its scan (2000): 777
    // was born at 3000, after that sample, so round 1 refuses it rather
    // than silently killing or silently sparing it.
    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args[2]),
    ).toEqual(["100"]);

    // Ablation (§ablation table): in `killHostProcessTree`, move the
    // `deps.now()` sample to AFTER `scanSlotProcessTable` returns → this
    // test reddens: round 0's sample would then read the clock post-bump
    // (5000), 777's birth (3000) would fall inside `[1000, 5000]`, and the
    // stop would resolve having force-killed a row it could never actually
    // prove belonged to the host.
  });

  // A pid killed again in a later round gets a SECOND `priorVictims` entry
  // with THAT round's `seenAliveAt` - never frozen at the round it was first
  // killed - so a later orphan's window is bounded by how long the victim was
  // actually still provably alive, not by the first round that happened to
  // notice it.
  it("a repeated victim's seenAliveAt advances across rounds, widening what a later orphan can be attributed to", async () => {
    // Chronology (samples 2000, 4000, 6000, 8000):
    //   R0 (sample 2000): 100 (born 1000, slot). Killed.
    //   R1 (sample 4000): 100 is STILL listed (`taskkill /F` is
    //       asynchronous - the loop's own comment names this exact case) and
    //       has meanwhile spawned 555 (born 3000, validated child). Both are
    //       killed, 555 first. 100's window now extends to 4000.
    //   R2 (sample 6000): 100 is gone; 555 lingers the same way, its edge
    //       now `parentProcessId` 0. Born 3000, it is AFTER round 0's bound
    //       (2000) but inside round 1's (4000): only the widened window can
    //       attribute it, and it is killed again rather than reported as
    //       undecided.
    //   R3 (sample 8000): empty. Converged.
    const { runner, calls } = roundedRunner([
      {
        kind: "table",
        rows: [
          { processId: 100, parentProcessId: 1, created: 1000, slot: true },
        ],
      },
      {
        kind: "table",
        rows: [
          { processId: 100, parentProcessId: 1, created: 1000, slot: true },
          {
            processId: 555,
            parentProcessId: 100,
            claimedParentProcessId: 100,
            created: 3000,
            slot: false,
          },
        ],
      },
      {
        kind: "table",
        rows: [
          {
            processId: 555,
            parentProcessId: 0,
            claimedParentProcessId: 100,
            created: 3000,
            slot: false,
          },
        ],
      },
      { kind: "table", rows: [] },
    ]);
    const samples = [2000, 4000, 6000, 8000];
    let sample = 0;
    const controller = createWindowsController(runner, {
      now: () => {
        const value = samples[sample] ?? 8000;
        sample += 1;
        return value;
      },
    });

    await controller.stop(serviceLabelFor("staging"), { force: false });

    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args),
    ).toEqual([
      ["/F", "/PID", "100"],
      ["/F", "/PID", "555"],
      ["/F", "/PID", "100"],
      ["/F", "/PID", "555"],
    ]);

    // Ablation: in `rememberIncarnation`, skip the push when an entry already
    // exists (first incarnation only) → this test reddens: 100's only window
    // ends at round 0's 2000, 555 (born 3000) falls outside it, and round 2
    // reports it unattributed instead of killing it.
  });

  // P2 (round 5c): a kill set of `[]` used to mean convergence unconditionally.
  // A row claiming a killed process as parent but born after it was last
  // proven alive is undecidable (a row born BEFORE the victim existed is not:
  // it is decided to be somebody else's, see the P2-2 pin) - and reporting the
  // stop successful while it survives is the bug this refusal exists to
  // close. Kills still happen first: a round with
  // BOTH a killable seed and an undecidable row proceeds to kill the seed,
  // and only refuses once a later round's kill set is empty with the
  // undecidable row still unexplained.
  it("kills happen first even when an unattributed row sits in the same round's scan; the throw only comes once nothing is left to kill", async () => {
    // Chronology (samples 5000, 7000, 9000):
    //   R0 (sample 5000): host 100 (born 1000, slot). Killed.
    //   R1 (sample 7000): a NEW slot process 200 (born 6200 - a relaunch,
    //       hence absent from R0) and 777 (born 6000, claims 100, after 100's
    //       window closed at 5000, so undecided). kill=[200],
    //       unattributed=[777]: 200 dies, the refusal waits.
    //   R2 (sample 9000): only 777. Nothing to kill, 777 still undecided:
    //       refused, naming it.
    const { runner, calls } = roundedRunner([
      {
        kind: "table",
        rows: [
          { processId: 100, parentProcessId: 1, created: 1000, slot: true },
        ],
      },
      {
        kind: "table",
        rows: [
          { processId: 200, parentProcessId: 1, created: 6200, slot: true },
          {
            processId: 777,
            parentProcessId: 0,
            claimedParentProcessId: 100,
            created: 6000,
            slot: false,
          },
        ],
      },
      {
        kind: "table",
        rows: [
          {
            processId: 777,
            parentProcessId: 0,
            claimedParentProcessId: 100,
            created: 6000,
            slot: false,
          },
        ],
      },
    ]);
    const samples = [5000, 7000, 9000];
    let sample = 0;
    const controller = createWindowsController(runner, {
      now: () => {
        const value = samples[sample] ?? 9000;
        sample += 1;
        return value;
      },
    });

    await expect(
      controller.stop(serviceLabelFor("staging"), { force: false }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      details: { unattributedPids: [777] },
    });

    // 200 (an ordinary slot match) was killed even though 777 (undecided)
    // sat alongside it in the very same round's scan.
    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args),
    ).toEqual([
      ["/F", "/PID", "100"],
      ["/F", "/PID", "200"],
    ]);

    // Ablation (§ablation table): in `killHostProcessTree`, return `kill`
    // only (drop the `unattributed.length > 0` throw) → this test's
    // rejection reddens into a resolve, reporting the host stopped with 777
    // still alive.
  });

  it("P2-1: an undecided row that exits between rounds leaves its child undecided too - the suspect memory outlives the row that earned it", async () => {
    // Chronology (epoch micros; the clock is sampled BEFORE each scan):
    //   R0 sample 5000: host 100 (born 1000, slot) -> killed.
    //   R1 sample 7000: slot 200 (born 6200, a re-launch), non-slot 777
    //     (born 6000, claims 100, born AFTER 100's window closed at 5000)
    //     and 777's live, validated child 888 (born 6500).
    //     kill=[200], unattributed=[777, 888] -> 200 is killed, 777 and 888
    //     are remembered as suspects.
    //   R2 sample 9000: 777 has exited on its own. Only 888 remains, parent
    //     0, claimed 777.
    // 777 was never a victim, so without the suspect memory 888 is an
    // ordinary orphan claiming a pid nothing remembers: empty kill, empty
    // unattributed, and the stop reports success with a possible host
    // grandchild alive. With it, 888 inherits 777's suspicion and the loop
    // refuses, naming 888.
    const samples = [5000, 7000, 9000, 11000];
    let sample = 0;
    const { runner, calls } = roundedRunner([
      {
        kind: "table",
        rows: [
          { processId: 100, parentProcessId: 1, created: 1000, slot: true },
        ],
      },
      {
        kind: "table",
        rows: [
          { processId: 200, parentProcessId: 1, created: 6200, slot: true },
          {
            processId: 777,
            parentProcessId: 0,
            claimedParentProcessId: 100,
            created: 6000,
            slot: false,
          },
          {
            processId: 888,
            parentProcessId: 777,
            claimedParentProcessId: 777,
            created: 6500,
            slot: false,
          },
        ],
      },
      {
        kind: "table",
        rows: [
          {
            processId: 888,
            parentProcessId: 0,
            claimedParentProcessId: 777,
            created: 6500,
            slot: false,
          },
        ],
      },
    ]);
    const controller = createWindowsController(runner, {
      now: () => {
        const value = samples[sample] ?? 11000;
        sample += 1;
        return value;
      },
    });

    await expect(
      controller.stop(serviceLabelFor("staging"), { force: false }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      details: { unattributedPids: [888] },
    });

    expect(
      calls.filter((call) => call.command === "powershell.exe"),
    ).toHaveLength(3);
    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args),
    ).toEqual([
      ["/F", "/PID", "100"],
      ["/F", "/PID", "200"],
    ]);

    // Ablation (§ablation table): in `killHostProcessTree`, drop the
    // `priorSuspects` recording loop (record victims only) → this test
    // reddens: round 2 finds nothing to kill and nothing it remembers, and
    // the stop RESOLVES with 888 alive. Alternatively make
    // `classifyAgainstSuspect` return "none" → same outcome. Neither is
    // masked by 888's own suspect entry: a row's classification consults
    // only its CLAIMED PARENT's incarnations, never its own.
  });

  it("P2 (round 5e): a newer incarnation of a suspect's pid does not erase the suspicion about the older one's child", async () => {
    // Chronology (samples 5000, 7000, 9000, 11000):
    //   R0 (sample 5000): host 100 (born 1000, slot). Killed.
    //   R1 (sample 7000): slot 200 (born 6200), 777 (born 6000, claims dead
    //       100 - undecided) and 777's validated child 888 (born 6500).
    //       kill=[200], unattributed=[777, 888].
    //   R2 (sample 9000): old 777 has exited; a NEW slot-matched process
    //       wears pid 777 (born 8000). 888 is still there; the scan zeroes
    //       its edge because the holder of 777 is younger than it. 888 is
    //       undecided (suspect 777 at 6000); the newcomer is killed as a slot
    //       match and becomes victim 777 = [8000, 9000].
    //   R3 (sample 11000): only 888. Against victim 777 (born 8000) it is
    //       "older than the victim" - decided, and wrongly, if that were the
    //       only memory consulted. The remembered suspect incarnation of 777
    //       (born 6000) keeps it undecided: refused, naming 888.
    const samples = [5000, 7000, 9000, 11000];
    let sample = 0;
    const { runner, calls } = roundedRunner([
      {
        kind: "table",
        rows: [
          { processId: 100, parentProcessId: 1, created: 1000, slot: true },
        ],
      },
      {
        kind: "table",
        rows: [
          { processId: 200, parentProcessId: 1, created: 6200, slot: true },
          {
            processId: 777,
            parentProcessId: 0,
            claimedParentProcessId: 100,
            created: 6000,
            slot: false,
          },
          {
            processId: 888,
            parentProcessId: 777,
            claimedParentProcessId: 777,
            created: 6500,
            slot: false,
          },
        ],
      },
      {
        kind: "table",
        rows: [
          { processId: 777, parentProcessId: 1, created: 8000, slot: true },
          {
            processId: 888,
            parentProcessId: 0,
            claimedParentProcessId: 777,
            created: 6500,
            slot: false,
          },
        ],
      },
      {
        kind: "table",
        rows: [
          {
            processId: 888,
            parentProcessId: 0,
            claimedParentProcessId: 777,
            created: 6500,
            slot: false,
          },
        ],
      },
    ]);
    const controller = createWindowsController(runner, {
      now: () => {
        const value = samples[sample] ?? 11000;
        sample += 1;
        return value;
      },
    });

    await expect(
      controller.stop(serviceLabelFor("staging"), { force: false }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      details: { unattributedPids: [888] },
    });

    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args),
    ).toEqual([
      ["/F", "/PID", "100"],
      ["/F", "/PID", "200"],
      ["/F", "/PID", "777"],
    ]);

    // Ablation: in `classifyCarryOverClaim`, return the FIRST verdict instead
    // of the strongest (`return classifyAgainstVictim(...)` inside the
    // victims loop) → this test reddens: round 3 consults victim 777 (born
    // 8000) first, decides 888 is older than it, never reaches the remembered
    // suspect, and the stop RESOLVES with 888 alive. The recorder's
    // append-vs-overwrite is NOT what this fixture exercises - 777's suspect
    // and victim incarnations live in different maps, and 888's two suspect
    // entries are identical - so overwriting `rememberIncarnation` leaves it
    // green; the lingering-victim loop test above is the one that reddens.
  });

  it("a suspicion earned while a live parent's age was unreadable is cleared once the age reads and the edge validates", async () => {
    // Chronology (samples 5000, 7000, 9000):
    //   R0 (sample 5000): host 100 (born 1000, slot). Killed.
    //   R1 (sample 7000): slot 200 (born 6200); an unrelated replacement
    //       wearing pid 100, whose creation time Windows would not report
    //       this time (`created` 0); its child 888 (born 6500), whose edge
    //       the scan therefore zeroes. 888 claims remembered 100 and is
    //       born after the window: undecided. kill=[200],
    //       unattributed=[888]; 888 is remembered as a suspect.
    //   R2 (sample 9000): the replacement's age reads (6000, older than
    //       888) and the scan validates 888's edge to it. That is lineage
    //       the scan has proven; the earlier suspicion must not refuse the
    //       stop over a stranger's child. Converged.
    const samples = [5000, 7000, 9000];
    let sample = 0;
    const { runner, calls } = roundedRunner([
      {
        kind: "table",
        rows: [
          { processId: 100, parentProcessId: 1, created: 1000, slot: true },
        ],
      },
      {
        kind: "table",
        rows: [
          { processId: 200, parentProcessId: 1, created: 6200, slot: true },
          {
            processId: 100,
            parentProcessId: 0,
            claimedParentProcessId: 1,
            created: 0,
            slot: false,
          },
          {
            processId: 888,
            parentProcessId: 0,
            claimedParentProcessId: 100,
            created: 6500,
            slot: false,
          },
        ],
      },
      {
        kind: "table",
        rows: [
          {
            processId: 100,
            parentProcessId: 0,
            claimedParentProcessId: 1,
            created: 6000,
            slot: false,
          },
          {
            processId: 888,
            parentProcessId: 100,
            claimedParentProcessId: 100,
            created: 6500,
            slot: false,
          },
        ],
      },
    ]);
    const controller = createWindowsController(runner, {
      now: () => {
        const value = samples[sample] ?? 9000;
        sample += 1;
        return value;
      },
    });

    await controller.stop(serviceLabelFor("staging"), { force: false });

    expect(
      calls.filter((call) => call.command === "powershell.exe"),
    ).toHaveLength(3);
    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args),
    ).toEqual([
      ["/F", "/PID", "100"],
      ["/F", "/PID", "200"],
    ]);
  });

  it("round-6 P2: a spared shell's uncertainty outlives the shell - its children still refuse the stop after it exits", async () => {
    // The CLI (this process, pid 9999 here) runs in a terminal shell 700 the
    // host spawned - the "terminal-run" topology - and the host's own age is
    // unreadable, so 700 can be placed neither way for the whole loop.
    // Chronology (samples 5000, 7000, 9000):
    //   R0 (sample 5000): host 100 (slot, `created` 0 - unreadable), shell
    //       700 (born 2000) claiming it with a zeroed edge, the CLI (born
    //       2500) as 700's validated child. kill=[100]; victim 100 =
    //       [0, 5000]. 700 is spared by ancestry; nothing is undecided yet
    //       because nothing was remembered yet.
    //   R1 (sample 7000): 700 and the CLI again, a side worker 888 (born
    //       6000, 700's validated child) and a re-launched slot 200 (born
    //       6200). Against the unreadable victim 700 is undecided; the
    //       closure is {700, CLI, 888}; 700 and the CLI are spared from the
    //       REPORT, so unattributed=[888]. kill=[200]. The memory must take
    //       the whole closure: 700 and 888 become suspects.
    //   R2 (sample 9000): 700 has exited. The CLI and 888 now claim absent
    //       700, and a NEW child 889 (born 8000) does too. Nothing was
    //       killed, so the verdict rests on memory: suspect 700 (born 2000)
    //       makes every claim born after it undecided. The CLI is spared;
    //       888 and 889 are named, and the stop refuses. Before this fix
    //       only 888 was remembered - by its own pid, not its parent's - and
    //       the loop reported a converged stop with both alive.
    const samples = [5000, 7000, 9000];
    let sample = 0;
    const shell700 = (parent: number): TableRowInput => ({
      processId: 700,
      parentProcessId: parent,
      claimedParentProcessId: 100,
      created: 2000,
      slot: false,
    });
    const cli9999 = (parent: number): TableRowInput => ({
      processId: 9999,
      parentProcessId: parent,
      claimedParentProcessId: 700,
      created: 2500,
      slot: false,
    });
    const { runner, calls } = roundedRunner([
      {
        kind: "table",
        rows: [
          { processId: 100, parentProcessId: 1, created: 0, slot: true },
          shell700(0),
          cli9999(700),
        ],
      },
      {
        kind: "table",
        rows: [
          shell700(0),
          cli9999(700),
          {
            processId: 888,
            parentProcessId: 700,
            claimedParentProcessId: 700,
            created: 6000,
            slot: false,
          },
          { processId: 200, parentProcessId: 1, created: 6200, slot: true },
        ],
      },
      {
        kind: "table",
        rows: [
          cli9999(0),
          {
            processId: 888,
            parentProcessId: 0,
            claimedParentProcessId: 700,
            created: 6000,
            slot: false,
          },
          {
            processId: 889,
            parentProcessId: 0,
            claimedParentProcessId: 700,
            created: 8000,
            slot: false,
          },
        ],
      },
    ]);
    const controller = createWindowsController(runner, {
      now: () => {
        const value = samples[sample] ?? 9000;
        sample += 1;
        return value;
      },
    });

    const originalPid = Object.getOwnPropertyDescriptor(process, "pid");
    Object.defineProperty(process, "pid", { value: 9999, configurable: true });
    try {
      await expect(
        controller.stop(serviceLabelFor("staging"), { force: false }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        details: { unattributedPids: [888, 889] },
      });
    } finally {
      if (originalPid !== undefined) {
        Object.defineProperty(process, "pid", originalPid);
      }
    }

    expect(
      calls.filter((call) => call.command === "powershell.exe"),
    ).toHaveLength(3);
    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args),
    ).toEqual([
      ["/F", "/PID", "100"],
      ["/F", "/PID", "200"],
    ]);

    // Ablation: in `killHostProcessTree`, record suspects from `unattributed`
    // instead of `undecided` → this test reddens: round 2 remembers 888 but
    // not 700, no row's claim on 700 matches anything, and the stop RESOLVES
    // with 888 and 889 alive (same kills, same three scans). 889 is why a
    // self-identity rule would not have been enough: it was never seen
    // before, so nothing about its own pid could be remembered - only its
    // parent's.
  });

  it("round-6 P2, overlap: a spared shell that is BOTH a victim's validated child and an undecided root is still remembered", async () => {
    // A spared shell can sit in both closures at once - the killed host's
    // validated child AND a descendant of an undecided root - and it is
    // never killed, so the kill bookkeeping alone would remember nothing
    // about it. It is a PLACED ancestor of the CLI: reported as lineage,
    // remembered with a window like a kill, and its later child is placed
    // through that window. Chronology (samples 5000, 7000, 9000; CLI is
    // pid 9999):
    //   R0 (sample 5000): slot 200 (age unreadable) and slot 100 (born
    //       1000) claiming 200 with a zeroed edge; shell 700 (born 2000) is
    //       100's validated child, the CLI (born 2500) is 700's. Kill 200
    //       and 100; 700 and the CLI are spared. Victims 200 = [0, 5000],
    //       100 = [1000, 5000].
    //   R1 (sample 7000): 200 is gone; 100 lingers in its TerminateProcess,
    //       700 and the CLI remain, and a side worker 888 (born 6000) sits
    //       under 700. 100 is a slot seed AND, against the unreadable victim
    //       200, undecided - so both closures are {100, 700, CLI, 888}. The
    //       actual kill is [888, 100]; 700 is a placed ancestor, remembered
    //       as 700 = [2000, 7000] (and by identity); the CLI is its own
    //       branch. Nothing is left undecided.
    //   R2 (sample 9000): 100 and 888 are gone, 700 spawned 889 (born 8000)
    //       and exited. The CLI and 889 claim absent 700: the CLI (born 2500)
    //       falls inside 700's window and is spared as itself; 889 falls
    //       after it and is undecided. The stop refuses naming 889.
    const samples = [5000, 7000, 9000];
    let sample = 0;
    const { runner, calls } = roundedRunner([
      {
        kind: "table",
        rows: [
          // An unreadable age zeroes the row's own edge too - the scan
          // cannot validate a parent for a row whose birth it cannot read -
          // so 200 carries its claim on pid 1 with `parentProcessId` 0.
          {
            processId: 200,
            parentProcessId: 0,
            claimedParentProcessId: 1,
            created: 0,
            slot: true,
          },
          {
            processId: 100,
            parentProcessId: 0,
            claimedParentProcessId: 200,
            created: 1000,
            slot: true,
          },
          {
            processId: 700,
            parentProcessId: 100,
            claimedParentProcessId: 100,
            created: 2000,
            slot: false,
          },
          {
            processId: 9999,
            parentProcessId: 700,
            claimedParentProcessId: 700,
            created: 2500,
            slot: false,
          },
        ],
      },
      {
        kind: "table",
        rows: [
          {
            processId: 100,
            parentProcessId: 0,
            claimedParentProcessId: 200,
            created: 1000,
            slot: true,
          },
          {
            processId: 700,
            parentProcessId: 100,
            claimedParentProcessId: 100,
            created: 2000,
            slot: false,
          },
          {
            processId: 9999,
            parentProcessId: 700,
            claimedParentProcessId: 700,
            created: 2500,
            slot: false,
          },
          {
            processId: 888,
            parentProcessId: 700,
            claimedParentProcessId: 700,
            created: 6000,
            slot: false,
          },
        ],
      },
      {
        kind: "table",
        rows: [
          {
            processId: 9999,
            parentProcessId: 0,
            claimedParentProcessId: 700,
            created: 2500,
            slot: false,
          },
          {
            processId: 889,
            parentProcessId: 0,
            claimedParentProcessId: 700,
            created: 8000,
            slot: false,
          },
        ],
      },
    ]);
    const controller = createWindowsController(runner, {
      now: () => {
        const value = samples[sample] ?? 9000;
        sample += 1;
        return value;
      },
    });

    const originalPid = Object.getOwnPropertyDescriptor(process, "pid");
    Object.defineProperty(process, "pid", { value: 9999, configurable: true });
    try {
      await expect(
        controller.stop(serviceLabelFor("staging"), { force: false }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        details: { unattributedPids: [889] },
      });
    } finally {
      if (originalPid !== undefined) {
        Object.defineProperty(process, "pid", originalPid);
      }
    }

    expect(
      calls.filter((call) => call.command === "powershell.exe"),
    ).toHaveLength(3);
    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args),
    ).toEqual([
      // R0: both slot rows have zeroed edges (depth 0), so pid order.
      ["/F", "/PID", "100"],
      ["/F", "/PID", "200"],
      // R1: 888 (depth 2) before the lingering 100.
      ["/F", "/PID", "888"],
      ["/F", "/PID", "100"],
    ]);

    // Ablation: in `killHostProcessTree`, drop the `protectedAncestors`
    // recording loop → this test reddens: 700 is neither killed nor - being
    // subtracted from `undecided` as something the loop was about to
    // remember - a suspect, round 2 finds nothing that remembers it, and the
    // stop RESOLVES with 889 alive.
  });

  it("a placed CLI ancestor is remembered with a window though it is never killed: its later children are placed after it exits", async () => {
    // The all-known-age form of the same invariant - no unreadable age, no
    // pid reuse. The host spawned shell 700 to run this CLI (pid 9999);
    // ages are all readable, so 700 is PLACED every round (a validated
    // child of the host, then a carry-over seed through the host's window),
    // spared as the CLI's ancestor, and - before this fix - never recorded,
    // because only kills were. Chronology (samples 5000, 7000, 9000,
    // 11000):
    //   R0 (sample 5000): host 100 (born 1000, slot) -> shell 700 (born
    //       2000) -> CLI (born 2500). kill=[100]; 700 is a placed ancestor,
    //       remembered as 700 = [2000, 5000].
    //   R1 (sample 7000): 700 orphaned (claims dead 100, inside its window:
    //       seed), the CLI, and a side worker 888 (born 6000) under 700.
    //       kill=[888]; 700 placed again, second window [2000, 7000].
    //   R2 (sample 9000): 700 spawned 889 (born 8000) and exited; 888
    //       lingers. All three claim absent 700. The CLI (born 2500) and 888
    //       (born 6000) fall inside 700's windows: seeds - the CLI is spared,
    //       888 is killed. 889 falls after the last window: undecided.
    //       kill=[888], unattributed=[889] - kills first.
    //   R3 (sample 11000): the CLI and 889. Nothing to kill; 889 is still
    //       undecided, and the stop refuses naming it. Before this fix round
    //       2 already resolved: nothing remembered 700, so the CLI, 888 and
    //       889 were three orphans claiming a pid nobody knew.
    const samples = [5000, 7000, 9000, 11000];
    let sample = 0;
    const cliUnder = (parent: number): TableRowInput => ({
      processId: 9999,
      parentProcessId: parent,
      claimedParentProcessId: 700,
      created: 2500,
      slot: false,
    });
    const { runner, calls } = roundedRunner([
      {
        kind: "table",
        rows: [
          { processId: 100, parentProcessId: 1, created: 1000, slot: true },
          {
            processId: 700,
            parentProcessId: 100,
            claimedParentProcessId: 100,
            created: 2000,
            slot: false,
          },
          cliUnder(700),
        ],
      },
      {
        kind: "table",
        rows: [
          {
            processId: 700,
            parentProcessId: 0,
            claimedParentProcessId: 100,
            created: 2000,
            slot: false,
          },
          cliUnder(700),
          {
            processId: 888,
            parentProcessId: 700,
            claimedParentProcessId: 700,
            created: 6000,
            slot: false,
          },
        ],
      },
      {
        kind: "table",
        rows: [
          cliUnder(0),
          {
            processId: 888,
            parentProcessId: 0,
            claimedParentProcessId: 700,
            created: 6000,
            slot: false,
          },
          {
            processId: 889,
            parentProcessId: 0,
            claimedParentProcessId: 700,
            created: 8000,
            slot: false,
          },
        ],
      },
      {
        kind: "table",
        rows: [
          cliUnder(0),
          {
            processId: 889,
            parentProcessId: 0,
            claimedParentProcessId: 700,
            created: 8000,
            slot: false,
          },
        ],
      },
    ]);
    const controller = createWindowsController(runner, {
      now: () => {
        const value = samples[sample] ?? 11000;
        sample += 1;
        return value;
      },
    });

    const originalPid = Object.getOwnPropertyDescriptor(process, "pid");
    Object.defineProperty(process, "pid", { value: 9999, configurable: true });
    try {
      await expect(
        controller.stop(serviceLabelFor("staging"), { force: false }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        details: { unattributedPids: [889] },
      });
    } finally {
      if (originalPid !== undefined) {
        Object.defineProperty(process, "pid", originalPid);
      }
    }

    expect(
      calls.filter((call) => call.command === "powershell.exe"),
    ).toHaveLength(4);
    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args),
    ).toEqual([
      ["/F", "/PID", "100"],
      ["/F", "/PID", "888"],
      ["/F", "/PID", "888"],
    ]);

    // Ablation: in `killHostProcessTree`, drop the `protectedAncestors`
    // recording loop → this test reddens: round 2 finds three orphans
    // claiming a pid nothing remembers, kills nothing, reports nothing, and
    // the stop RESOLVES after three scans with 888 and 889 alive.
  });

  it("round-7 P2: the CLI's own scan is never remembered as a host suspect - a stranger reusing its pid does not refuse a later stop", async () => {
    // The CLI (pid 9999) claims a host whose age is unreadable, so it is
    // undecided for as long as that host is remembered - and every scan it
    // runs is its validated child AND slot-matched (the scan's command line
    // names the slot paths). Chronology (samples 5000, 7000, 9000):
    //   R0 (sample 5000): host 100 (slot, `created` 0), the CLI (born 2500)
    //       claiming it, and this round's own scan 555 (born 5500, under the
    //       CLI, slot-matched). Memory is empty, so nothing is undecided yet.
    //       kill=[100]; the CLI's branch is spared.
    //   R1 (sample 7000): 100 lingers (seed), the CLI is now undecided
    //       against victim 100 of unreadable age, and this round's scan 777
    //       (born 7500) sits under it - in the suspect closure, spared from
    //       the kill. kill=[100]. NOTHING is remembered as a suspect: the
    //       CLI's branch is its own, not the host's.
    //   R2 (sample 9000): scan 777 has long exited; an unrelated process
    //       took pid 777 (born 8000), forked 888 (born 8500) and exited. 888
    //       claims 777 as an orphan. Nothing remembers 777: converged. Had
    //       777 been recorded as a host suspect, 888 would have refused the
    //       stop over a stranger.
    const samples = [5000, 7000, 9000];
    let sample = 0;
    // An unreadable age zeroes the row's own edge (the scan cannot validate
    // a parent for a birth it cannot read), so the host carries its claim on
    // pid 1 with `parentProcessId` 0.
    const host100: TableRowInput = {
      processId: 100,
      parentProcessId: 0,
      claimedParentProcessId: 1,
      created: 0,
      slot: true,
    };
    const cli = {
      processId: 9999,
      parentProcessId: 0,
      claimedParentProcessId: 100,
      created: 2500,
      slot: false,
    };
    const ownScan = (pid: number, created: number): TableRowInput => ({
      processId: pid,
      parentProcessId: 9999,
      claimedParentProcessId: 9999,
      created,
      slot: true,
    });
    const { runner, calls } = roundedRunner([
      { kind: "table", rows: [host100, cli, ownScan(555, 5500)] },
      { kind: "table", rows: [host100, cli, ownScan(777, 7500)] },
      {
        kind: "table",
        rows: [
          cli,
          {
            processId: 888,
            parentProcessId: 0,
            claimedParentProcessId: 777,
            created: 8500,
            slot: false,
          },
        ],
      },
    ]);
    const controller = createWindowsController(runner, {
      now: () => {
        const value = samples[sample] ?? 9000;
        sample += 1;
        return value;
      },
    });

    const originalPid = Object.getOwnPropertyDescriptor(process, "pid");
    Object.defineProperty(process, "pid", { value: 9999, configurable: true });
    try {
      await controller.stop(serviceLabelFor("staging"), { force: false });
    } finally {
      if (originalPid !== undefined) {
        Object.defineProperty(process, "pid", originalPid);
      }
    }

    expect(
      calls.filter((call) => call.command === "powershell.exe"),
    ).toHaveLength(3);
    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args),
    ).toEqual([
      ["/F", "/PID", "100"],
      ["/F", "/PID", "100"],
    ]);

    // Ablation: in `computeWindowsHostKillSet`, drop `!cliBranch.has(pid)`
    // from the `undecided` filter → this test reddens: round 1 remembers
    // scan 777 (born 7500) as a suspect, round 2 finds 888 (born 8500)
    // claiming it, and the stop REFUSES naming 888 - a stranger's child.
  });

  it("two missing wrappers: the shell above the CLI stays protected by identity after the edges that proved its ancestry are gone", async () => {
    // Remembering a placed ancestor's WINDOW is what places its children;
    // remembering its IDENTITY is what keeps the ancestor itself protected.
    // Chronology (samples 5000, 7000, 9000; CLI is pid 9999):
    //   R0 (sample 5000): slot 100 (born 1000) -> wrapper 600 (born 1500)
    //       -> shell 700 (born 2000) -> wrapper 800 (born 2250) -> CLI (born
    //       2500), every age readable. kill=[100]; 600, 700 and 800 are the
    //       CLI's placed ancestors, remembered by window and by identity.
    //   R1 (sample 7000): both wrappers have exited on their own. 700
    //       claims absent 600 (inside 600's window: a seed) and the CLI
    //       claims absent 800; a side worker 888 (born 6000) sits under 700.
    //       The live walk from the CLI ends at its zeroed edge, so on the
    //       window alone 700 is an ordinary host descendant to kill. Its
    //       identity (700, born 2000) says it is the shell this CLI runs in:
    //       spared, placed again, and only 888 is killed.
    //   R2 (sample 9000): 700 and the CLI. Nothing to kill, nothing
    //       undecided. Converged - with the shell alive.
    const samples = [5000, 7000, 9000];
    let sample = 0;
    const { runner, calls } = roundedRunner([
      {
        kind: "table",
        rows: [
          { processId: 100, parentProcessId: 1, created: 1000, slot: true },
          {
            processId: 600,
            parentProcessId: 100,
            claimedParentProcessId: 100,
            created: 1500,
            slot: false,
          },
          {
            processId: 700,
            parentProcessId: 600,
            claimedParentProcessId: 600,
            created: 2000,
            slot: false,
          },
          {
            processId: 800,
            parentProcessId: 700,
            claimedParentProcessId: 700,
            created: 2250,
            slot: false,
          },
          {
            processId: 9999,
            parentProcessId: 800,
            claimedParentProcessId: 800,
            created: 2500,
            slot: false,
          },
        ],
      },
      {
        kind: "table",
        rows: [
          {
            processId: 700,
            parentProcessId: 0,
            claimedParentProcessId: 600,
            created: 2000,
            slot: false,
          },
          {
            processId: 9999,
            parentProcessId: 0,
            claimedParentProcessId: 800,
            created: 2500,
            slot: false,
          },
          {
            processId: 888,
            parentProcessId: 700,
            claimedParentProcessId: 700,
            created: 6000,
            slot: false,
          },
        ],
      },
      {
        kind: "table",
        rows: [
          {
            processId: 700,
            parentProcessId: 0,
            claimedParentProcessId: 600,
            created: 2000,
            slot: false,
          },
          {
            processId: 9999,
            parentProcessId: 0,
            claimedParentProcessId: 800,
            created: 2500,
            slot: false,
          },
        ],
      },
    ]);
    const controller = createWindowsController(runner, {
      now: () => {
        const value = samples[sample] ?? 9000;
        sample += 1;
        return value;
      },
    });

    const originalPid = Object.getOwnPropertyDescriptor(process, "pid");
    Object.defineProperty(process, "pid", { value: 9999, configurable: true });
    try {
      await controller.stop(serviceLabelFor("staging"), { force: false });
    } finally {
      if (originalPid !== undefined) {
        Object.defineProperty(process, "pid", originalPid);
      }
    }

    expect(
      calls.filter((call) => call.command === "powershell.exe"),
    ).toHaveLength(3);
    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args),
    ).toEqual([
      ["/F", "/PID", "100"],
      ["/F", "/PID", "888"],
    ]);

    // Ablation: in `killHostProcessTree`, drop the `priorProtected`
    // recording (or in `computeWindowsHostKillSet` the identity lookup) →
    // this test reddens: round 1 issues `taskkill /F /PID 700` as well -
    // the shell this CLI is running in - after 888 (descendants first).
  });

  // The unattributed refusal exercised through all four callers that run
  // `killHostProcessTree`: none of them may treat it as anything softer than
  // the scan-unavailable refusal already covered above. The fourth is the
  // install swap's between-retry escalation, `killLingeringSlotProcesses`,
  // which throws like the others; that `swapLockRetryHook` then logs the
  // refusal and lets the rename retry anyway is existing, documented
  // behaviour of the hook (see `killLingeringSlotProcesses`'s own comment),
  // not of the function under test here.
  describe("all four killHostProcessTree callers refuse the same way on an unattributed row", () => {
    function unattributedRefusalRounds(): readonly RoundResponse[] {
      return [
        {
          kind: "table",
          rows: [
            { processId: 100, parentProcessId: 1, created: 1000, slot: true },
          ],
        },
        {
          kind: "table",
          rows: [
            {
              processId: 777,
              parentProcessId: 0,
              claimedParentProcessId: 100,
              created: 999_999,
              slot: false,
            },
          ],
        },
      ];
    }
    const unattributedDeps: WindowsControllerDeps = { now: () => 5000 };

    it("stop does NOT purge pid metadata when the refusal is an unattributed row, not just when the scan itself fails", async () => {
      const { runner } = roundedRunner(unattributedRefusalRounds());
      const controller = createWindowsController(runner, unattributedDeps);

      await expect(
        controller.stop(serviceLabelFor("staging"), { force: false }),
      ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED });

      expect(mocks.removeHostPidMetadata).not.toHaveBeenCalled();
    });

    it("uninstall never reaches schtasks /Delete when the tree kill refuses on an unattributed row", async () => {
      const { runner, calls } = roundedRunner(unattributedRefusalRounds());
      const controller = createWindowsController(runner, unattributedDeps);

      await expect(
        controller.uninstall({ label: serviceLabelFor("staging") }),
      ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED });

      expect(
        calls.some(
          (call) => call.command === "schtasks" && call.args[0] === "/Delete",
        ),
      ).toBe(false);
    });

    it("restart never reaches schtasks /Run when the tree kill refuses on an unattributed row", async () => {
      const { runner, calls } = roundedRunner(unattributedRefusalRounds());
      const controller = createWindowsController(runner, unattributedDeps);

      await expect(
        controller.restart(serviceLabelFor("staging")),
      ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED });

      expect(
        calls.some(
          (call) => call.command === "schtasks" && call.args[0] === "/Run",
        ),
      ).toBe(false);
    });

    it("killLingeringSlotProcesses (the install swap's between-retry kill) throws the same refusal, naming the row", async () => {
      // The swap path has no pid metadata to purge and no task to touch;
      // what it must not do is resolve, because `swapLockRetryHook` reads a
      // resolved kill as "the slot was cleared, retry the rename". The hook's
      // own decision to log and retry anyway is its business; this function
      // has to hand it the truth.
      const { runner } = roundedRunner(unattributedRefusalRounds());

      await expect(
        killLingeringSlotProcesses(
          serviceLabelFor("staging"),
          runner,
          unattributedDeps,
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        details: { unattributedPids: [777] },
      });
    });
  });
});

// `computeWindowsHostKillSet` is the algebra a host stop's kill set is built
// from (victims = slot ∪ descendants(slot); spared = cli ∪ descendants(cli) ∪
// (ancestors(cli) − slot); kill = victims − spared). These pins exercise it
// both directly and through `controller.stop`, because the direct unit tests
// alone would not catch a wiring bug that hands the wrong pid in as `cliPid`
// (`process.pid`, not PowerShell's own `$PID` inside the scan script).
describe("computeWindowsHostKillSet and the taskkill self-protection it drives", () => {
  beforeEach(() => {
    mocks.readHostPidMetadata.mockReset();
    mocks.readHostPidMetadata.mockResolvedValue(null);
    mocks.removeHostPidMetadata.mockReset();
    mocks.removeHostPidMetadata.mockResolvedValue(undefined);
  });

  it("host-spawned: kills the host and its non-CLI-ancestor descendants, sparing the CLI's own subtree", async () => {
    // idle 0 (the row every real scan returns)
    // host 100 (Slot) -> cli 200 -> powershell 250
    // cli 200 -> helper 300
    // host 100 -> agent 400
    // self = 200 (the CLI's own pid)
    const rows: TableRowInput[] = [
      { processId: 0, parentProcessId: 0, slot: false },
      { processId: 100, parentProcessId: 1, slot: true },
      { processId: 200, parentProcessId: 100, slot: false },
      { processId: 250, parentProcessId: 200, slot: false },
      { processId: 300, parentProcessId: 200, slot: false },
      { processId: 400, parentProcessId: 100, slot: false },
    ];

    const { runner, calls } = convergingTableRunner(rows);
    const controller = createWindowsController(runner, noTimingDeps);

    const originalPid = Object.getOwnPropertyDescriptor(process, "pid");
    Object.defineProperty(process, "pid", { value: 200, configurable: true });
    try {
      await controller.stop(serviceLabelFor("staging"), { force: false });
    } finally {
      if (originalPid !== undefined) {
        Object.defineProperty(process, "pid", originalPid);
      }
    }

    const taskkillArgs = calls
      .filter((call) => call.command === "taskkill")
      .map((call) => call.args);
    // Deepest-first (`orderWindowsKillsDescendantsFirst`): 400 hangs off 100,
    // so it is issued first. The KILL SET is unchanged from before that
    // ordering existed - both pids, nothing more, nothing less - only the
    // argv order changed.
    expect(taskkillArgs).toEqual([
      ["/F", "/PID", "400"],
      ["/F", "/PID", "100"],
    ]);
    expect(taskkillArgs.every((args) => !args.includes("/T"))).toBe(true);
    // The scan ANSWERED, so the pid.json fallback must not be consulted at
    // all. Before pid 0 was accepted, the idle row failed the whole parse and
    // every stop silently degraded to that fallback.
    expect(mocks.readHostPidMetadata).not.toHaveBeenCalled();

    // Ablation: in `isProcessTableId`, require `value > 0` again → this test
    // fails: the idle row rejects the table, `findSlotProcessIds` returns
    // null, the fallback is read, and the kill set collapses to nothing.
  });

  it("terminal-run: a non-slot shell ancestor between the host and the CLI is spared", async () => {
    // idle 0
    // host 100 (Slot) -> shell 50 -> cli 200 -> powershell 250
    // host 100 -> agent 400
    // self = 200
    const rows: TableRowInput[] = [
      { processId: 0, parentProcessId: 0, slot: false },
      { processId: 100, parentProcessId: 1, slot: true },
      { processId: 50, parentProcessId: 100, slot: false },
      { processId: 200, parentProcessId: 50, slot: false },
      { processId: 250, parentProcessId: 200, slot: false },
      { processId: 400, parentProcessId: 100, slot: false },
    ];

    const { runner, calls } = convergingTableRunner(rows);
    const controller = createWindowsController(runner, noTimingDeps);

    const originalPid = Object.getOwnPropertyDescriptor(process, "pid");
    Object.defineProperty(process, "pid", { value: 200, configurable: true });
    try {
      await controller.stop(serviceLabelFor("staging"), { force: false });
    } finally {
      if (originalPid !== undefined) {
        Object.defineProperty(process, "pid", originalPid);
      }
    }

    const taskkillArgs = calls
      .filter((call) => call.command === "taskkill")
      .map((call) => call.args);
    // Deepest-first, same reasoning as the host-spawned test above: 400 hangs
    // off 100, so it is issued first. The kill SET is unchanged.
    expect(taskkillArgs).toEqual([
      ["/F", "/PID", "400"],
      ["/F", "/PID", "100"],
    ]);
    // 50 (a non-slot ancestor of the CLI) is spared, and never appears.
    expect(taskkillArgs.some((args) => args[2] === "50")).toBe(false);
    // Nor does pid 0, which is in the table and in nobody's kill set.
    expect(taskkillArgs.some((args) => args[2] === "0")).toBe(false);
    expect(mocks.readHostPidMetadata).not.toHaveBeenCalled();
  });

  it("wrong-self regression: self must be the CLI's pid, not PowerShell's own - putting self at the powershell node kills the CLI's own child", () => {
    // Same host-spawned shape as above, but self is (wrongly) placed at the
    // POWERSHELL node (250) instead of the CLI (200). Helper 300 is the CLI's
    // child and PowerShell's SIBLING, so seeding the spared set from 250 no
    // longer covers it: it lands in the kill set and would be force-killed,
    // which is exactly the damage `cliPid = process.pid` (not the scan
    // script's `$PID`) prevents.
    const rows: TableRowInput[] = [
      { processId: 0, parentProcessId: 0, slot: false },
      { processId: 100, parentProcessId: 1, slot: true },
      { processId: 200, parentProcessId: 100, slot: false },
      { processId: 250, parentProcessId: 200, slot: false },
      { processId: 300, parentProcessId: 200, slot: false },
      { processId: 400, parentProcessId: 100, slot: false },
    ];

    const killSet = computeWindowsHostKillSet(
      rowsOf(rows),
      250,
      nothingRemembered,
    );

    expect(killSet.kill).toEqual([100, 300, 400]);
    expect(killSet.unattributed).toEqual([]);
    // Ablation for the CALL SITE (`findSlotProcessIds(label, run, process.pid)`
    // in `killHostProcessTree`): this test calls the algebra directly and
    // would not see it. The host-spawned integration test above is the one
    // that catches a wrong pid being threaded in, because it drives
    // `controller.stop` and asserts the taskkill argv.
  });

  it("a stale parent id the scan could not verify (arriving as 0) does not make a stranger a victim", () => {
    // The reuse the script's CreationDate check exists for: process 400
    // outlived its creator, Windows later gave that id to the Traycer host,
    // and 400's `ParentProcessId` still names it. The scan cannot vouch for
    // that edge - the claimed parent is younger than its claimed child - so it
    // emits 0, and 400 stays out of the host's subtree instead of being
    // force-killed as a descendant.
    const rows: TableRowInput[] = [
      { processId: 0, parentProcessId: 0, slot: false },
      { processId: 100, parentProcessId: 1, slot: true },
      { processId: 400, parentProcessId: 0, slot: false },
      { processId: 200, parentProcessId: 100, slot: false },
    ];

    expect(
      computeWindowsHostKillSet(rowsOf(rows), 200, nothingRemembered).kill,
    ).toEqual([100]);
  });

  it("a recycled id on the CLI's own ancestry (arriving as 0) spares nothing extra", () => {
    // The other direction of the same reuse: the CLI's claimed parent cannot
    // be verified, so the ancestry walk ends immediately. The CLI and its
    // subtree are still spared - that comes from the descendant closure, not
    // from ancestry - and the host is still killed rather than being spared as
    // a wrongly-believed ancestor.
    const rows: TableRowInput[] = [
      { processId: 0, parentProcessId: 0, slot: false },
      { processId: 100, parentProcessId: 1, slot: true },
      { processId: 200, parentProcessId: 0, slot: false },
      { processId: 300, parentProcessId: 200, slot: false },
      { processId: 400, parentProcessId: 100, slot: false },
    ];

    expect(
      computeWindowsHostKillSet(rowsOf(rows), 200, nothingRemembered).kill,
    ).toEqual([100, 400]);
  });

  // Direct algebra pins for the three subtraction terms, each isolating one
  // ablation.
  describe("computeWindowsHostKillSet - algebra pins", () => {
    const rows: TableRowInput[] = [
      { processId: 100, parentProcessId: 1, slot: true },
      { processId: 50, parentProcessId: 100, slot: false },
      { processId: 200, parentProcessId: 50, slot: false },
      { processId: 300, parentProcessId: 200, slot: false },
      { processId: 400, parentProcessId: 100, slot: false },
    ];

    it("kills the slot and its descendants, sparing the CLI's ancestry and subtree", () => {
      expect(
        computeWindowsHostKillSet(rowsOf(rows), 200, nothingRemembered).kill,
      ).toEqual([100, 400]);

      // Ablation: in `computeWindowsHostKillSet`, drop the
      // `if (!slot.has(ancestor))` condition so every ancestor of the CLI is
      // spared unconditionally → this test fails: 100 would be spared even
      // though it is the slot-matched host, changing the expected kill set
      // from [100, 400] to [400].
    });

    it("spares the CLI's own descendants (not just the CLI itself)", () => {
      // 300 is the CLI's own child - PowerShell, or the detached upgrade
      // finalizer - and it is a descendant of the slot-matched host too, so
      // only the descendant closure around the CLI keeps it out of the kill
      // set.
      const withChild: TableRowInput[] = [
        { processId: 100, parentProcessId: 1, slot: true },
        { processId: 200, parentProcessId: 100, slot: false },
        { processId: 300, parentProcessId: 200, slot: false },
      ];
      expect(
        computeWindowsHostKillSet(rowsOf(withChild), 200, nothingRemembered)
          .kill,
      ).toEqual([100]);

      // Ablation: in `computeWindowsHostKillSet`, change
      // `withDescendants(new Set([cliPid]), children)` to `new Set([cliPid])`
      // (seeding `spared` with the CLI's own pid but not its subtree) → this
      // test fails: the kill set becomes [100, 300], because 300 is a victim
      // through the host and nothing spares it any more.
    });
  });

  // `priorVictims` (Codex round 4): a process spawned by the host AFTER an
  // earlier round killed it arrives with `parentProcessId` 0 - the table
  // cannot vouch for a parent that is already dead - so a row is only linked
  // back to the slot through the UNVALIDATED `claimedParentProcessId`, made
  // safe against pid reuse by comparing creation times.
  //
  // Codex round 5b: an earlier version of this carry-over answered lineage -
  // "which incarnation of this pid created this row" - by inspecting the
  // pid's CURRENT holder. That cannot work: a pid reused and then vacated
  // between two scans leaves no trace in the table at all, so a stranger
  // forked by that intermediate holder arrives looking exactly like the
  // victim's own child, and the occupant check passed it through. The
  // replacement was a lifetime window, `pid -> { created, killedAt }`.
  //
  // Codex round 5c - an independent cold review found three P1s and a P2
  // against that 5b window:
  //   P1-a - the soundness argument assumed its own conclusion. Sampling the
  //     clock before the KILL does not prove the victim was still alive at
  //     that instant: it can exit on its own, its pid be reused, and the
  //     replacement fork a child, all before the sample is taken. The bound
  //     is now sampled BEFORE THE SCAN and renamed `seenAliveAt` - the scan
  //     that follows observes the victim alive at some instant after the
  //     sample, which is what makes the sample honest.
  //   P1-b - millisecond rounding let a previous holder's fork-and-exit and
  //     the victim's own birth project to the same millisecond, wrongly
  //     admitting a stranger. `Created` is now epoch MICROSECONDS.
  //   P1-c - the scan's edge validation compared LOCAL DateTimes; across a
  //     DST fall-back a newer holder can look older and the scan would
  //     VALIDATE a stranger's edge instead of refusing it. Both operands are
  //     now `.ToUniversalTime()` (see the script-pin test above).
  //   P2 - a row born after the bound but genuinely the host's own child was
  //     refused forever and silently spared, and the loop reported the stop
  //     successful with it alive. `computeWindowsHostKillSet` now returns
  //     `unattributed` alongside `kill`, and the loop (below) throws rather
  //     than reading an empty `kill` as convergence while `unattributed` is
  //     non-empty.
  describe("computeWindowsHostKillSet - victim carry-over (lifetime window: created..seenAliveAt)", () => {
    // (processId, parentProcessId, claimedParentProcessId, created, slot).
    function victimRow(
      processId: number,
      parentProcessId: number,
      claimedParentProcessId: number,
      created: number,
      slot: boolean,
    ): TableRowInput {
      return {
        processId,
        parentProcessId,
        claimedParentProcessId,
        created,
        slot,
      };
    }

    const remembered = victimMemory(
      new Map<number, readonly WindowsKillVictim[]>([
        [100, [{ created: 1000, seenAliveAt: 5000 }]],
      ]),
    );
    const cliPid = 9999;
    const cliRow = victimRow(cliPid, 0, 0, 500, false);

    it("born inside the lifetime window is killed", () => {
      const table = rowsOf([victimRow(777, 0, 100, 3000, false), cliRow]);
      expect(computeWindowsHostKillSet(table, cliPid, remembered)).toEqual({
        kill: [777],
        protectedAncestors: [],
        undecided: [],
        unattributed: [],
      });
    });

    it("P1-a: born after seenAliveAt is unattributed, neither killed nor silently spared", () => {
      // The cold review's finding: an earlier version sampled the clock
      // before the KILL rather than before the SCAN, so a row born after the
      // victim genuinely exited - but before that stale sample was taken -
      // could pass as "still inside the window". Refusing to kill it is not
      // enough on its own either: an even earlier version silently spared
      // rows like this, which is the P2 the loop-level tests below cover.
      const table = rowsOf([victimRow(777, 0, 100, 6000, false), cliRow]);
      expect(computeWindowsHostKillSet(table, cliPid, remembered)).toEqual({
        kill: [],
        protectedAncestors: [],
        undecided: [777],
        unattributed: [777],
      });
    });

    it("P2-2: a row older than the victim is DECIDED, not undecided - it cannot be the victim's child at all", () => {
      // A process cannot predate its own parent, so 777 (born 900, before
      // 100's own birth at 1000) never was 100's child - the claimed id is
      // one 777 has worn since before 100 existed, which this scan simply
      // cannot verify (no live parent survives to validate the edge). That
      // is a decided "no", not an open question: reporting it as
      // unattributed would fail the stop over a long-lived stranger that
      // every retry finds sitting in exactly the same place - a refusal
      // nothing can clear. The caller-level test below drives this through
      // `controller.stop` and confirms the stop actually succeeds.
      const table = rowsOf([victimRow(777, 0, 100, 900, false), cliRow]);
      expect(computeWindowsHostKillSet(table, cliPid, remembered)).toEqual({
        kill: [],
        protectedAncestors: [],
        undecided: [],
        unattributed: [],
      });
    });

    it("both window bounds are inclusive: the same microsecond as the parent's birth, and the same microsecond as seenAliveAt, are both killed", () => {
      const sameAsBirth = rowsOf([victimRow(777, 0, 100, 1000, false), cliRow]);
      expect(
        computeWindowsHostKillSet(sameAsBirth, cliPid, remembered),
      ).toEqual({
        kill: [777],
        protectedAncestors: [],
        undecided: [],
        unattributed: [],
      });

      const sameAsSeenAliveAt = rowsOf([
        victimRow(777, 0, 100, 5000, false),
        cliRow,
      ]);
      expect(
        computeWindowsHostKillSet(sameAsSeenAliveAt, cliPid, remembered),
      ).toEqual({
        kill: [777],
        protectedAncestors: [],
        undecided: [],
        unattributed: [],
      });

      // Ablation (§ablation table): change `created < victim.created` to
      // `return "unattributed"` → the P2-2 test above reddens, becoming
      // `{ kill: [], protectedAncestors: [], undecided: [777], unattributed: [777] }` instead of deciding the row is
      // simply not the victim's child.
      // Ablation (§ablation table): drop `row.created <= victim.seenAliveAt`
      // → the P1-a test above reddens the same way - exactly the bug this
      // fix exists to close.
    });

    it("created 0 on the row, and separately on the victim, both refuse the link as unattributed", () => {
      const unknownRowAge = rowsOf([victimRow(777, 0, 100, 0, false), cliRow]);
      expect(
        computeWindowsHostKillSet(unknownRowAge, cliPid, remembered),
      ).toEqual({
        kill: [],
        protectedAncestors: [],
        undecided: [777],
        unattributed: [777],
      });

      const unknownVictimAge = victimMemory(
        new Map<number, readonly WindowsKillVictim[]>([
          [100, [{ created: 0, seenAliveAt: 5000 }]],
        ]),
      );
      const ordinaryRow = rowsOf([victimRow(777, 0, 100, 3000, false), cliRow]);
      expect(
        computeWindowsHostKillSet(ordinaryRow, cliPid, unknownVictimAge),
      ).toEqual({
        kill: [],
        protectedAncestors: [],
        undecided: [777],
        unattributed: [777],
      });

      // Ablation (§ablation table): drop the zero-age branch entirely
      // (`victim.created === 0 || row.created === 0`) → BOTH assertions
      // above redden, in opposite directions. The row of age 0 falls into
      // the lower bound (`0 < 1000`) and is DECIDED as older than the victim
      // (`{ kill: [], protectedAncestors: [], undecided: [], unattributed: [] }`), which is "we could not read an
      // age" masquerading as proof. The victim of age 0 admits everything
      // (`3000 < 0` is false, `3000 <= 5000` is true) and 777 is killed
      // (`{ kill: [777], protectedAncestors: [], undecided: [], unattributed: [] }`). Neither reading of an
      // unreadable age is acceptable, which is why the guard runs first.
    });

    it("a validated live edge is neither killed nor unattributed - the carry-over is not even consulted", () => {
      // 777 has a validated `parentProcessId` of its own (100, nonzero) - the
      // scan found a live parent for it in this very table, so the
      // carry-over question never arises for it at all.
      const table = rowsOf([
        victimRow(100, 0, 0, 3000, false),
        victimRow(777, 100, 100, 4000, false),
        cliRow,
      ]);
      expect(computeWindowsHostKillSet(table, cliPid, remembered)).toEqual({
        kill: [],
        protectedAncestors: [],
        undecided: [],
        unattributed: [],
      });
    });

    it("a claimed parent that is not a remembered victim is neither killed nor unattributed", () => {
      const table = rowsOf([victimRow(777, 0, 424242, 3000, false), cliRow]);
      expect(computeWindowsHostKillSet(table, cliPid, remembered)).toEqual({
        kill: [],
        protectedAncestors: [],
        undecided: [],
        unattributed: [],
      });
    });

    it("a spared row claiming a victim pid is excluded from unattributed too - a process already decided never to kill is not an open question", () => {
      // 700 claims the dead host (100) as its parent, born after
      // `seenAliveAt` - ordinarily unattributed on its own. But the CLI
      // (9999) claims 700 as its own validated parent here, so 700 is spared
      // by the ancestry exclusion regardless of its carry-over
      // classification - reporting it would fail every stop issued from a
      // Traycer-hosted terminal whose shell happens to sit on a pid the host
      // once held.
      //
      // Excluded from the REPORT, not from the memory feed: 700 is still the
      // round's undecided closure, and the loop remembers it as a suspect so
      // that a child of 700 that shows up after 700 has exited still finds
      // its parent's pid remembered. The CLI itself, though under 700, is
      // not: the CLI's own branch is never a host suspect.
      const table = rowsOf([
        victimRow(700, 0, 100, 6000, false),
        victimRow(cliPid, 700, 700, 6500, false),
      ]);
      expect(computeWindowsHostKillSet(table, cliPid, remembered)).toEqual({
        kill: [],
        protectedAncestors: [],
        undecided: [700],
        unattributed: [],
      });
    });

    it("a spared undecided shell's unspared child is reported, and the shell itself is kept in the memory feed", () => {
      // The cold review's round-6 P2, as one round: the host was killed with
      // an UNREADABLE age, so shell 700 (claiming it, born 2000) can be
      // placed neither way; the CLI (9999) is 700's validated child, and so
      // is a side worker 888 (born 6000). 700 is spared by ancestry and 888
      // is reported. Without 700 in `undecided` the loop would remember only
      // 888, and once 700 exits nothing would remember the pid its children
      // claim.
      const unreadableHost = victimMemory(
        new Map<number, readonly WindowsKillVictim[]>([
          [100, [{ created: 0, seenAliveAt: 5000 }]],
        ]),
      );
      const table = rowsOf([
        victimRow(700, 0, 100, 2000, false),
        victimRow(cliPid, 700, 700, 2500, false),
        victimRow(888, 700, 700, 6000, false),
        victimRow(200, 0, 0, 6200, true),
      ]);
      expect(computeWindowsHostKillSet(table, cliPid, unreadableHost)).toEqual({
        kill: [200],
        protectedAncestors: [],
        undecided: [700, 888],
        unattributed: [888],
      });

      // Ablation: in `computeWindowsHostKillSet`, build `undecided` with the
      // `!spared.has(pid)` filter too (make it equal to `unattributed`) →
      // this assertion and the one above redden on `undecided`, and the
      // loop-level "round-6 P2" test reddens into a resolved stop.
    });

    it("overlap: a spared shell in BOTH closures - the killed host's validated child and an undecided root's descendant - stays in the memory feed", () => {
      // Round 1 of the loop-level overlap test: lingering host 100 is a slot
      // seed and, against the unreadable victim 200 it claims, undecided at
      // once. Shell 700 (the CLI's parent) and side worker 888 are its
      // validated descendants. The kill is the victim closure minus the
      // spared branch; 700 is a placed ancestor and is remembered with a
      // window instead of being killed; `undecided` is the suspect closure
      // minus everything that will be remembered that way and minus the
      // CLI's own branch - here, nothing.
      const unreadableSlot = victimMemory(
        new Map<number, readonly WindowsKillVictim[]>([
          [200, [{ created: 0, seenAliveAt: 5000 }]],
          [100, [{ created: 1000, seenAliveAt: 5000 }]],
        ]),
      );
      const table = rowsOf([
        victimRow(100, 0, 200, 1000, true),
        victimRow(700, 100, 100, 2000, false),
        victimRow(cliPid, 700, 700, 2500, false),
        victimRow(888, 700, 700, 6000, false),
      ]);
      expect(computeWindowsHostKillSet(table, cliPid, unreadableSlot)).toEqual({
        kill: [100, 888],
        // 700 is a PLACED ancestor of the CLI (a validated child of the
        // lingering host, which is a seed): reported as lineage to remember
        // with a window, and therefore out of `undecided`. The CLI is out of
        // it as its own branch.
        protectedAncestors: [700],
        undecided: [],
        unattributed: [],
      });

      // Ablation: drop `protectedAncestors` from `remembered` → 700 is
      // listed in BOTH `protectedAncestors` and `undecided`.
    });

    it("the CLI's own branch is never a host suspect: its slot-matched scan under an undecided CLI is neither reported nor remembered", () => {
      // The cold review's round-7 P2, as one round. The host (100) was
      // killed with an UNREADABLE age, so the CLI (9999, claiming it) is
      // undecided this round, and its own PowerShell scan 777 - a validated
      // child, slot-MATCHED because its command line names the slot paths -
      // lands in the suspect closure. Spared from the kill and not an
      // ancestor, it would otherwise stay in `undecided` and be remembered
      // as a HOST suspect; a stranger that later reuses pid 777 would then
      // have its child refuse a stop.
      const unreadableHost = victimMemory(
        new Map<number, readonly WindowsKillVictim[]>([
          [100, [{ created: 0, seenAliveAt: 5000 }]],
        ]),
      );
      const table = rowsOf([
        // Unreadable age, so the host's own edge is zeroed too.
        victimRow(100, 0, 1, 0, true),
        victimRow(cliPid, 0, 100, 2500, false),
        victimRow(777, cliPid, cliPid, 7500, true),
      ]);
      expect(computeWindowsHostKillSet(table, cliPid, unreadableHost)).toEqual({
        kill: [100],
        protectedAncestors: [],
        undecided: [],
        unattributed: [],
      });

      // Ablation: in `computeWindowsHostKillSet`, drop `!cliBranch.has(pid)`
      // from the `undecided` filter → `undecided: [777, 9999]`, and the
      // loop-level "round-7 P2" test refuses a stop over a stranger's child.
    });

    it("a remembered ancestor is spared by IDENTITY once the wrappers between it and the CLI have exited; a reused pid with a different birth is not", () => {
      // Round 1 of the loop-level "two missing wrappers" test. Round 0 saw
      // slot 100 -> wrapper 600 -> shell 700 -> wrapper 800 -> CLI, killed
      // 100 and remembered 600, 700 and 800 as placed ancestors, by window
      // and by identity. Both wrappers have since exited: 700 (born 2000)
      // claims absent 600 inside 600's window - a seed, an ordinary host
      // descendant on the window alone - and the CLI claims absent 800. The
      // live walk from the CLI stops at its zeroed edge, so nothing but the
      // remembered identity says 700 is the shell this CLI runs in. Its
      // other child 888 is still the host's and is killed.
      const chainRemembered: WindowsKillMemory = {
        victims: new Map<number, readonly WindowsKillVictim[]>([
          [100, [{ created: 1000, seenAliveAt: 5000 }]],
          [600, [{ created: 1500, seenAliveAt: 5000 }]],
          [700, [{ created: 2000, seenAliveAt: 5000 }]],
          [800, [{ created: 2250, seenAliveAt: 5000 }]],
        ]),
        suspects: new Map(),
        protectedAncestors: new Map<number, readonly number[]>([
          [600, [1500]],
          [700, [2000]],
          [800, [2250]],
        ]),
      };
      const sameShell = rowsOf([
        victimRow(700, 0, 600, 2000, false),
        victimRow(cliPid, 0, 800, 2500, false),
        victimRow(888, 700, 700, 6000, false),
      ]);
      expect(
        computeWindowsHostKillSet(sameShell, cliPid, chainRemembered),
      ).toEqual({
        kill: [888],
        protectedAncestors: [700],
        undecided: [],
        unattributed: [],
      });

      // A stranger wearing pid 700, born 9000: no identity match, and its
      // claim on 600 falls after 600's window - undecided, reported, and
      // certainly not spared as anybody's ancestor.
      const reusedPid = rowsOf([
        victimRow(700, 0, 600, 9000, false),
        victimRow(cliPid, 0, 800, 2500, false),
        victimRow(888, 700, 700, 9500, false),
      ]);
      expect(
        computeWindowsHostKillSet(reusedPid, cliPid, chainRemembered),
      ).toEqual({
        kill: [],
        protectedAncestors: [],
        undecided: [700, 888],
        unattributed: [700, 888],
      });

      // Ablation: in `computeWindowsHostKillSet`, drop the identity lookup
      // (build `ancestors` from the live walk only) → the first assertion
      // reddens with `kill: [700, 888]` and `protectedAncestors: []`: the
      // shell this CLI runs in is killed as an ordinary host descendant.
    });

    it("both non-empty: a killable seed and an unattributed row coexist in the same verdict", () => {
      const table = rowsOf([
        victimRow(777, 0, 100, 3000, false),
        victimRow(888, 0, 100, 6000, false),
        cliRow,
      ]);
      expect(computeWindowsHostKillSet(table, cliPid, remembered)).toEqual({
        kill: [777],
        protectedAncestors: [],
        undecided: [888],
        unattributed: [888],
      });
    });

    it("an ordinary slot row is killed through the ordinary walk, independent of any carry-over", () => {
      const table = rowsOf([victimRow(200, 0, 0, 2000, true), cliRow]);
      expect(computeWindowsHostKillSet(table, cliPid, remembered)).toEqual({
        kill: [200],
        protectedAncestors: [],
        undecided: [],
        unattributed: [],
      });
    });

    it("the CLI exclusion holds against victim ancestry: a shell claiming the dead host as parent spares the CLI and the shell, but not the CLI's sibling", () => {
      // Shell 700 claims the dead host (100) as its parent - inside the
      // window, so a carry-over seed - and the CLI is the shell's own,
      // ordinary (validated) child. Sibling 800 is killed as 700's
      // descendant, but the CLI and the shell above it are BOTH spared: the
      // shell's status as a carry-over victim does not override the
      // ancestry exclusion any more than it would for an ordinary non-slot
      // shell. A row that ends up spared can never be the reason a round's
      // kill set comes back non-empty - only an UNSPARED survivor can stall
      // convergence.
      //
      // The shell is spared from the kill and reported as a placed ancestor:
      // the loop remembers it with the window it would have given a kill, so
      // that a child it spawns after this scan is still placed once the shell
      // has exited.
      const table = rowsOf([
        victimRow(700, 0, 100, 2000, false),
        victimRow(cliPid, 700, 700, 2500, false),
        victimRow(800, 700, 700, 2500, false),
      ]);
      expect(computeWindowsHostKillSet(table, cliPid, remembered)).toEqual({
        kill: [800],
        protectedAncestors: [700],
        undecided: [],
        unattributed: [],
      });
    });

    // These three shapes are decided by the ORDINARY descendant walk, not by
    // `classifyCarryOverClaim` - EXCEPT the seed row in the third case, which
    // the carry-over does seed; its descendants are what the ordinary walk
    // then reaches. They stay alongside the window tests because they were
    // the ones the old occupant check risked getting wrong (a live parent
    // that happens to be a former victim's pid, recycled).
    describe("shapes the ordinary walk decides, not the carry-over", () => {
      it("a lingering victim (still occupying its own pid) is killed through the ordinary walk", () => {
        // `taskkill /F` is asynchronous: the confirming scan can briefly
        // still list the exact pid a previous round already killed. 100 IS
        // the victim, still there, and it is ALSO a genuine slot match
        // (`slot: true`) - so it is killed as an ordinary slot-descendant
        // walk. 777 comes along as its ordinary, validated child.
        const table = rowsOf([
          victimRow(100, 0, 0, 1000, true),
          victimRow(777, 100, 100, 4000, false),
          cliRow,
        ]);
        expect(computeWindowsHostKillSet(table, cliPid, remembered)).toEqual({
          kill: [100, 777],
          protectedAncestors: [],
          undecided: [],
          unattributed: [],
        });
      });

      it("the pid was recycled by a process that is now ITSELF a slot match - killed regardless of the carry-over", () => {
        // 100 is a stranger (not the victim) that happens to match the slot
        // on its own path/command line. It is killed because it is a slot
        // process, full stop - 777 already has a validated live parent (100)
        // that is itself a victim through the ordinary walk.
        const table = rowsOf([
          victimRow(100, 0, 0, 3000, true),
          victimRow(777, 100, 100, 4000, false),
          cliRow,
        ]);
        expect(computeWindowsHostKillSet(table, cliPid, remembered)).toEqual({
          kill: [100, 777],
          protectedAncestors: [],
          undecided: [],
          unattributed: [],
        });
      });

      it("a grandchild and great-grandchild of a carry-over seed are killed through the ordinary descendant walk", () => {
        // 200 IS seeded through the carry-over (born inside the dead
        // victim's window, claimed parent 100). 300 and 400 are NOT
        // themselves carry-over candidates - they have validated live
        // parents (200 and 300) - so they are killed as ordinary descendants
        // of the seed.
        const table = rowsOf([
          victimRow(200, 0, 100, 2000, false),
          victimRow(300, 200, 200, 2100, false),
          victimRow(400, 300, 300, 2200, false),
          cliRow,
        ]);
        expect(computeWindowsHostKillSet(table, cliPid, remembered)).toEqual({
          kill: [200, 300, 400],
          protectedAncestors: [],
          undecided: [],
          unattributed: [],
        });
      });
    });

    it("the gate is not redundant: a validated live edge to a process wearing a victim's pid is decided by the edge, not by the window", () => {
      // LEGITIMATE scan output: after victim 100 died, an unrelated process
      // took pid 100 (born 6000, after the window closed at 5000) and forked
      // 777 (born 7000). The scan validates 777's edge - its parent is live
      // and older - so `parentProcessId` is 100. On the window alone 777 is
      // born after `seenAliveAt` and would be reported as undecided, failing
      // the stop over a stranger's child; the edge is the better fact, and
      // the gate is what applies it.
      const table = rowsOf([
        victimRow(100, 0, 0, 6000, false),
        victimRow(777, 100, 100, 7000, false),
        cliRow,
      ]);
      expect(computeWindowsHostKillSet(table, cliPid, remembered)).toEqual({
        kill: [],
        protectedAncestors: [],
        undecided: [],
        unattributed: [],
      });

      // Ablation (§ablation table): drop `row.parentProcessId !== 0` → this
      // test reddens, becoming `{ kill: [], protectedAncestors: [], undecided: [777], unattributed: [777] }` - the
      // window alone cannot place a row born after 5000, and a stop would be
      // refused over a process the scan had already tied to a living,
      // unrelated parent.
    });

    it("the gate is checked before the window: defensive, synthetic input pins the order of the checks", () => {
      // Deliberately SYNTHETIC: a victim window wide enough (to 6000) to
      // contain a row whose validated live parent (born 3000) is itself
      // inside that window cannot be produced by the pre-scan loop. It pins
      // the ORDER only - the gate is evaluated before the window is ever
      // consulted - so a future change cannot quietly reorder them.
      const widerWindow = victimMemory(
        new Map<number, readonly WindowsKillVictim[]>([
          [100, [{ created: 1000, seenAliveAt: 6000 }]],
        ]),
      );
      const table = rowsOf([
        victimRow(100, 0, 0, 3000, false),
        victimRow(777, 100, 100, 4000, false),
        cliRow,
      ]);
      expect(computeWindowsHostKillSet(table, cliPid, widerWindow)).toEqual({
        kill: [],
        protectedAncestors: [],
        undecided: [],
        unattributed: [],
      });
    });

    // Round 5e: memory is per INCARNATION. A pid can be killed twice as two
    // processes, or be a suspect in one round and a victim in the next, and
    // each incarnation is evidence about the rows born during it. The
    // strongest verdict across incarnations wins; a newer holder of a pid
    // never erases what the loop learned about the older holder's children.
    describe("incarnations - a later holder of a pid does not erase the earlier one", () => {
      it("two victim windows for one pid: a row inside the OLDER window is still seeded", () => {
        // 100 was killed at [1000, 2000], reused, and the newcomer (born
        // 6000, slot-matched) killed at [6000, 9000]. 555 (born 1500) claims
        // 100: against the newer incarnation it is "older than the victim",
        // against the older one it is inside the window. Seed.
        const twoWindows = victimMemory(
          new Map<number, readonly WindowsKillVictim[]>([
            [
              100,
              [
                { created: 1000, seenAliveAt: 2000 },
                { created: 6000, seenAliveAt: 9000 },
              ],
            ],
          ]),
        );
        const table = rowsOf([victimRow(555, 0, 100, 1500, false), cliRow]);
        expect(computeWindowsHostKillSet(table, cliPid, twoWindows)).toEqual({
          kill: [555],
          protectedAncestors: [],
          undecided: [],
          unattributed: [],
        });

        // Ablation: in `classifyCarryOverClaim`, consult only the LAST
        // incarnation of the claimed pid → this test reddens
        // (`{ kill: [], protectedAncestors: [], undecided: [], unattributed: [] }`): 555 is decided as somebody
        // else's child and silently spared.
      });

      it("a suspect incarnation and a later victim incarnation of one pid: a row between them stays undecided", () => {
        // 777 was undecided (born 6000), exited, and its pid was taken by a
        // slot-matched process (born 8000) that was then killed. 888 (born
        // 6500) claims 777: "older than the victim" against the newer
        // incarnation, but born after the suspect's birth against the older
        // one. The open question outranks the decided one.
        const mixed: WindowsKillMemory = {
          victims: new Map<number, readonly WindowsKillVictim[]>([
            [777, [{ created: 8000, seenAliveAt: 9000 }]],
          ]),
          suspects: new Map<number, readonly number[]>([[777, [6000]]]),
          protectedAncestors: new Map(),
        };
        const table = rowsOf([victimRow(888, 0, 777, 6500, false), cliRow]);
        expect(computeWindowsHostKillSet(table, cliPid, mixed)).toEqual({
          kill: [],
          protectedAncestors: [],
          undecided: [888],
          unattributed: [888],
        });
      });

      it("two suspect incarnations of one pid: the older one still covers a row born before the newer", () => {
        const twoSuspects = suspectMemory(
          new Map<number, readonly number[]>([[777, [6000, 8000]]]),
        );
        const table = rowsOf([victimRow(888, 0, 777, 6500, false), cliRow]);
        expect(computeWindowsHostKillSet(table, cliPid, twoSuspects)).toEqual({
          kill: [],
          protectedAncestors: [],
          undecided: [888],
          unattributed: [888],
        });
      });

      it("a later validated edge outranks an earlier suspicion about the same process: an unreadable parent age that becomes readable clears the row", () => {
        // 888 (born 6500) was reported undecided in an earlier round because
        // its live parent - an unrelated process wearing dead victim 100's
        // pid, born 6000 - had an unreadable creation time then, so the scan
        // zeroed the edge and 888's claim on remembered 100 fell after the
        // window. This round the age is readable (6000, older than 888), the
        // scan validates the edge, and that is real lineage: a reused pid
        // always goes to a process younger than the old holder's children,
        // so a validated edge can never be a coincidence of reuse. The
        // remembered suspicion about 888 must not override it, or the stop
        // would be refused over a stranger's child the scan has already
        // placed.
        const suspected: WindowsKillMemory = {
          victims: new Map<number, readonly WindowsKillVictim[]>([
            [100, [{ created: 1000, seenAliveAt: 5000 }]],
          ]),
          suspects: new Map<number, readonly number[]>([[888, [6500]]]),
          protectedAncestors: new Map(),
        };
        const table = rowsOf([
          victimRow(100, 0, 0, 6000, false),
          victimRow(888, 100, 100, 6500, false),
          cliRow,
        ]);
        expect(computeWindowsHostKillSet(table, cliPid, suspected)).toEqual({
          kill: [],
          protectedAncestors: [],
          undecided: [],
          unattributed: [],
        });

        // The descendant closure, not a self-identity rule, is what keeps a
        // child undecided when its LIVE parent is itself undecided: the same
        // 888 under a parent 777 that claims dead 100 and was born after the
        // window is reported with it.
        const underSuspectParent = rowsOf([
          victimRow(777, 0, 100, 6000, false),
          victimRow(888, 777, 777, 6500, false),
          cliRow,
        ]);
        expect(
          computeWindowsHostKillSet(underSuspectParent, cliPid, suspected),
        ).toEqual({
          kill: [],
          protectedAncestors: [],
          undecided: [777, 888],
          unattributed: [777, 888],
        });

        // Ablation: in `classifyCarryOverClaim`, before the gate, return
        // "unattributed" when `memory.suspects.get(row.processId)` contains
        // `row.created` (the self-identity rule an earlier draft had) → the
        // first assertion reddens (`unattributed: [888]`).
      });
    });

    // Round 5d: a pid an earlier round could place neither in the slot nor
    // out of it is remembered as a SUSPECT (by the age of the incarnation
    // that round saw), and suspicion is inherited - a child of a process we
    // cannot tie to the slot cannot be tied to it either. A suspect has no
    // upper bound: inside it the row is provably the suspect's child, outside
    // it the row may be the suspect's or a stranger's, and both are
    // undecided (see `classifyAgainstSuspect`).
    describe("suspect inheritance - claims on a pid an earlier round could not place", () => {
      const suspected = suspectMemory(
        new Map<number, readonly number[]>([[777, [6000]]]),
      );

      it("a row claiming a suspect and born after it is unattributed, with no upper bound to clear it", () => {
        const table = rowsOf([
          victimRow(888, 0, 777, 6500, false),
          victimRow(889, 0, 777, 900_000, false),
          cliRow,
        ]);
        expect(computeWindowsHostKillSet(table, cliPid, suspected)).toEqual({
          kill: [],
          protectedAncestors: [],
          undecided: [888, 889],
          unattributed: [888, 889],
        });

        // Ablation (§ablation table): make `classifyAgainstSuspect` return
        // "none" for a row born at or after the suspect → this test reddens
        // (`unattributed: []`), and so does the loop-level P2-1 pin above.
      });

      it("a row provably older than the suspect's incarnation is decided, not undecided", () => {
        // Same lower bound, same reason as the victim rule: a process cannot
        // predate its parent, so the claimed id is an earlier holder's.
        const table = rowsOf([victimRow(888, 0, 777, 5000, false), cliRow]);
        expect(computeWindowsHostKillSet(table, cliPid, suspected)).toEqual({
          kill: [],
          protectedAncestors: [],
          undecided: [],
          unattributed: [],
        });
      });

      it("an unreadable age on either side is undecided", () => {
        const zeroRow = rowsOf([victimRow(888, 0, 777, 0, false), cliRow]);
        expect(computeWindowsHostKillSet(zeroRow, cliPid, suspected)).toEqual({
          kill: [],
          protectedAncestors: [],
          undecided: [888],
          unattributed: [888],
        });
        const zeroSuspect = suspectMemory(
          new Map<number, readonly number[]>([[777, [0]]]),
        );
        const table = rowsOf([victimRow(888, 0, 777, 5000, false), cliRow]);
        expect(computeWindowsHostKillSet(table, cliPid, zeroSuspect)).toEqual({
          kill: [],
          protectedAncestors: [],
          undecided: [888],
          unattributed: [888],
        });
      });

      it("a validated live child of an undecided row is named with it - the closure is over the same children map the kill set walks", () => {
        // 777 itself is undecided against the remembered victim (born after
        // 100's window). 888 is 777's ordinary validated child and has no
        // claim of its own; it is reported because uncertainty about its
        // parent is uncertainty about it.
        const table = rowsOf([
          victimRow(777, 0, 100, 6000, false),
          victimRow(888, 777, 777, 6500, false),
          cliRow,
        ]);
        expect(computeWindowsHostKillSet(table, cliPid, remembered)).toEqual({
          kill: [],
          protectedAncestors: [],
          undecided: [777, 888],
          unattributed: [777, 888],
        });
      });

      it("a pid this scan decides to kill is never also reported as undecided", () => {
        // 777 is undecided; its child 888 is slot-matched in its own right
        // and so is killed. Reporting 888 in both lists would put one pid in
        // front of the user in two contradictory roles.
        const table = rowsOf([
          victimRow(777, 0, 100, 6000, false),
          victimRow(888, 777, 777, 6500, true),
          cliRow,
        ]);
        expect(computeWindowsHostKillSet(table, cliPid, remembered)).toEqual({
          kill: [888],
          protectedAncestors: [],
          undecided: [777],
          unattributed: [777],
        });
      });
    });
  });

  it("orderWindowsKillsDescendantsFirst: deepest first, ties broken by pid", () => {
    // root(10) -> {15, 20} -> 30 (child of 20). 15 and 20 are both depth 1 and
    // must sort by pid (15 before 20) rather than by Map iteration order.
    const table = rowsOf([
      { processId: 10, parentProcessId: 0, slot: false },
      { processId: 20, parentProcessId: 10, slot: false },
      { processId: 15, parentProcessId: 10, slot: false },
      { processId: 30, parentProcessId: 20, slot: false },
    ]);

    expect(orderWindowsKillsDescendantsFirst([10, 20, 15, 30], table)).toEqual([
      30, 15, 20, 10,
    ]);

    // Ablation (§ablation table): in `orderWindowsKillsDescendantsFirst`,
    // change the body to `return pids;` → this test reddens: the input order
    // ([10, 20, 15, 30]) comes back unchanged instead of deepest-first.
  });

  it("orderWindowsKillsDescendantsFirst terminates and orders sanely on a cycle - a torn table must not hang the kill", () => {
    // 10's parent claims 20 and 20's parent claims 10: a cycle a real scan
    // should never produce, but `depthOf`'s own `seen` set is what stands
    // between a torn snapshot and an infinite loop, not an assumption that
    // the table is well-formed.
    const table = rowsOf([
      { processId: 10, parentProcessId: 20, slot: false },
      { processId: 20, parentProcessId: 10, slot: false },
    ]);

    expect(orderWindowsKillsDescendantsFirst([10, 20], table)).toEqual([
      10, 20,
    ]);

    // The test terminating at all - within the suite's own timeout - is the
    // pin. Both walks stop at depth 1 (the cycle guard turns back the moment
    // it revisits a pid already on the chain), so the tie is broken by pid
    // ascending like any other.
  });
});

describe("Scheduled Task XML identity", () => {
  it("names Traycer as the task Author", () => {
    // Probed live on Windows 11: a task registered from this XML without an
    // <Author> shows `Author: N/A` in `schtasks /Query /V` and in the Task
    // Scheduler UI - anonymous provenance for the one entry that starts a
    // background process at every login. Same defect class as the macOS
    // "sh from Unknown Developer" login item, one field cheaper to fix.
    const prevDomain = process.env.USERDOMAIN;
    const prevUser = process.env.USERNAME;
    process.env.USERDOMAIN = "TESTBOX";
    process.env.USERNAME = "testuser";
    try {
      const xml = buildScheduledTaskXml({
        label: serviceLabelFor("staging"),
        cli: {
          command: "C:\\Users\\test\\.traycer\\cli\\bin\\traycer.exe",
          args: [],
        },
      });
      expect(xml).toContain("<Author>Traycer</Author>");
    } finally {
      if (prevDomain === undefined) delete process.env.USERDOMAIN;
      else process.env.USERDOMAIN = prevDomain;
      if (prevUser === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = prevUser;
    }
  });
});

describe("parseSchtasksLastRunResult", () => {
  it("extracts Last Run Result from /Query /V LIST output", () => {
    const stdout = [
      "Folder: \\Traycer",
      "HostName: DESKTOP",
      "TaskName: \\Traycer\\Host-Staging",
      "Next Run Time: N/A",
      "Status: Ready",
      "Logon Mode: Interactive only",
      "Last Run Time: 1/1/2026 12:00:00 AM",
      "Last Run Result: 0x41301",
      "Author: DESKTOP\\user",
      "Task To Run: wscript.exe //B host-start-hidden.vbs",
      "",
    ].join("\r\n");
    expect(parseSchtasksLastRunResult(stdout)).toBe("0x41301");
  });

  it("is case-insensitive and trims the value", () => {
    expect(parseSchtasksLastRunResult("last run result:  267011  \n")).toBe(
      "267011",
    );
  });

  it("reads the positional result from localized headerless CSV", () => {
    const localizedCsv =
      '"ORDINATEUR","\\\\Traycer\\\\Host","N/A","Ready","Interactive only","01/01/2026 00:00:00","0x41301","user","wscript.exe //B host-start-hidden.vbs"';
    expect(parseSchtasksLastRunResult(localizedCsv)).toBe("0x41301");
  });

  it("returns null when the field is missing or empty", () => {
    expect(parseSchtasksLastRunResult("Status: Ready\n")).toBeNull();
    expect(parseSchtasksLastRunResult("Last Run Result:\n")).toBeNull();
    expect(parseSchtasksLastRunResult("")).toBeNull();
  });
});

describe("Windows startService post-/Run spawn verification", () => {
  beforeEach(() => {
    mocks.readHostPidMetadata.mockReset();
    mocks.readHostPidMetadata.mockResolvedValue(null);
    mocks.removeHostPidMetadata.mockReset();
    mocks.removeHostPidMetadata.mockResolvedValue(undefined);
    setWindowsStartEvidenceDepsForTests(null);
    setWindowsTaskInstallDepsForTests(null);
  });

  afterEach(() => {
    setWindowsStartEvidenceDepsForTests(null);
    setWindowsTaskInstallDepsForTests(null);
  });

  it("surfaces Last Run Result when /Run is accepted but nothing spawns", async () => {
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (
        command === "schtasks" &&
        args[0] === "/Query" &&
        args.includes("/V")
      ) {
        return success(
          [
            "TaskName: \\Traycer\\Host-Staging",
            "Last Run Result: 0x1",
            "Status: Ready",
            "",
          ].join("\r\n"),
        );
      }
      return success("");
    };

    const deps: WindowsStartEvidenceDeps = {
      captureBaseline: async () => emptySpawnBaseline(),
      createEvidenceReader: () => ({ collect: async () => null }),
      sleep: async () => undefined,
      verifyTimeoutMs: 40,
      verifyPollMs: 10,
    };
    setWindowsStartEvidenceDepsForTests(deps);

    const controller = createWindowsController(runner, noTimingDeps);
    await expect(
      controller.start(serviceLabelFor("staging")),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: expect.stringContaining("Last Run Result: 0x1"),
      details: expect.objectContaining({ lastRunResult: "0x1" }),
    });

    expect(
      calls.some(
        (call) =>
          call.command === "schtasks" &&
          call.args[0] === "/Run" &&
          call.args.includes("\\Traycer\\Host-Staging"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.command === "schtasks" &&
          call.args[0] === "/Query" &&
          call.args.includes("/V"),
      ),
    ).toBe(true);
  });

  it("returns successfully when post-baseline spawn evidence appears", async () => {
    let polls = 0;
    const deps: WindowsStartEvidenceDeps = {
      captureBaseline: async () => emptySpawnBaseline(),
      createEvidenceReader: () => ({
        collect: async () => {
          polls += 1;
          if (polls < 2) return null;
          return {
            kind: "starting-marker",
            reason: "post-baseline starting marker",
            marker: null,
            pid: null,
          };
        },
      }),
      sleep: async () => undefined,
      verifyTimeoutMs: 5_000,
      verifyPollMs: 1,
    };
    setWindowsStartEvidenceDepsForTests(deps);

    const runner: ProcessRunner = async () => success("");
    const controller = createWindowsController(runner, noTimingDeps);
    await expect(
      controller.start(serviceLabelFor("staging")),
    ).resolves.toBeUndefined();
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it("controller.install performs one task rewrite followed by one verified /Run", async () => {
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      return success("");
    };
    setWindowsTaskInstallDepsForTests(stagedTaskInstallDeps());
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

    await createWindowsController(runner, noTimingDeps).install({
      label: serviceLabelFor("staging"),
      cli: { command: "C:\\traycer.exe", args: [] },
      enableLinger: false,
    });

    expect(
      calls.filter(
        (call) => call.command === "schtasks" && call.args[0] === "/Create",
      ),
    ).toHaveLength(1);
    expect(
      calls.filter(
        (call) => call.command === "schtasks" && call.args[0] === "/Run",
      ),
    ).toHaveLength(1);
  });

  // `registrationCommitted: true` is the signal `didServiceRegistrationCommit`
  // reads: `/Create` already succeeded here (the task exists with its logon
  // trigger), so a caller holding a host-start adoption lease must honour it
  // rather than treat this as a clean pre-registration failure.
  it("marks a /Run failure after a successful /Create as a committed registration", async () => {
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "schtasks" && args[0] === "/Run") {
        throw new ProcessRunError(
          "schtasks /Run exited with code 1: Access is denied.",
          command,
          args,
          1,
          "",
          "ERROR: Access is denied.",
        );
      }
      return success("");
    };
    setWindowsTaskInstallDepsForTests(stagedTaskInstallDeps());
    setWindowsStartEvidenceDepsForTests({
      captureBaseline: async () => emptySpawnBaseline(),
      createEvidenceReader: () => ({ collect: async () => null }),
      sleep: async () => undefined,
      verifyTimeoutMs: 40,
      verifyPollMs: 10,
    });

    let caught: unknown = null;
    try {
      await createWindowsController(runner, noTimingDeps).install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      details: { registrationCommitted: true },
    });
    expect(didServiceRegistrationCommit(caught)).toBe(true);
    expect(
      calls.filter(
        (call) => call.command === "schtasks" && call.args[0] === "/Create",
      ),
    ).toHaveLength(1);
  });

  // Same committed classification as the /Run failure above, for the other
  // post-registration failure mode: /Run was ACCEPTED (the scheduler took
  // the request) but no post-baseline spawn evidence ever showed up.
  it("marks a spawn-evidence timeout after an accepted /Run as a committed registration", async () => {
    const runner: ProcessRunner = async () => success("");
    const deps: WindowsStartEvidenceDeps = {
      captureBaseline: async () => emptySpawnBaseline(),
      createEvidenceReader: () => ({ collect: async () => null }),
      sleep: async () => undefined,
      verifyTimeoutMs: 40,
      verifyPollMs: 10,
    };
    setWindowsStartEvidenceDepsForTests(deps);

    let caught: unknown = null;
    try {
      await createWindowsController(runner, noTimingDeps).start(
        serviceLabelFor("staging"),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      details: { registrationCommitted: true },
    });
    expect(didServiceRegistrationCommit(caught)).toBe(true);
  });

  // The negative twin: a `/Create` failure happens BEFORE the task exists at
  // all, so it must never carry the committed flag.
  it("does not mark a /Create failure as a committed registration", async () => {
    const runner: ProcessRunner = async (command, args) => {
      if (command === "schtasks" && args[0] === "/Create") {
        throw new ProcessRunError(
          "schtasks /Create exited with code 1: Access is denied.",
          command,
          args,
          1,
          "",
          "ERROR: Access is denied.",
        );
      }
      return success("");
    };
    setWindowsTaskInstallDepsForTests(stagedTaskInstallDeps());

    let caught: unknown = null;
    try {
      await createWindowsController(runner, noTimingDeps).install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
    });
    expect(didServiceRegistrationCommit(caught)).toBe(false);
  });

  // A mutation-authority loss is not a `CliError`: it must keep its own
  // identity (`isServiceMutationAuthorityError`) rather than being wrapped,
  // and `markRegistrationCommitted` marks it by reference instead of via
  // `details.registrationCommitted`.
  it("marks a mutation-authority loss from /Run after a successful /Create as a committed registration", async () => {
    const authorityError = new ServiceMutationAuthorityError(
      new Error("maintenance lease revoked"),
    );
    const runner: ProcessRunner = async (command, args) => {
      if (command === "schtasks" && args[0] === "/Run") {
        throw authorityError;
      }
      return success("");
    };
    setWindowsTaskInstallDepsForTests(stagedTaskInstallDeps());
    setWindowsStartEvidenceDepsForTests({
      captureBaseline: async () => emptySpawnBaseline(),
      createEvidenceReader: () => ({ collect: async () => null }),
      sleep: async () => undefined,
      verifyTimeoutMs: 40,
      verifyPollMs: 10,
    });

    let caught: unknown = null;
    try {
      await createWindowsController(runner, noTimingDeps).install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(authorityError);
    expect(isServiceMutationAuthorityError(caught)).toBe(true);
    expect(didServiceRegistrationCommit(caught)).toBe(true);
  });

  // The negative twin: a mutation-authority loss from `/Create` happens
  // BEFORE the task exists at all, so it must stay an authority error
  // without ever being read as committed.
  it("does not mark a mutation-authority loss from /Create (pre-registration) as a committed registration", async () => {
    const authorityError = new ServiceMutationAuthorityError(
      new Error("maintenance lease revoked"),
    );
    const runner: ProcessRunner = async (command, args) => {
      if (command === "schtasks" && args[0] === "/Create") {
        throw authorityError;
      }
      return success("");
    };
    setWindowsTaskInstallDepsForTests(stagedTaskInstallDeps());

    let caught: unknown = null;
    try {
      await createWindowsController(runner, noTimingDeps).install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(authorityError);
    expect(isServiceMutationAuthorityError(caught)).toBe(true);
    expect(didServiceRegistrationCommit(caught)).toBe(false);
  });

  // The staging cleanup runs in `installService`'s `finally`, AFTER `/Create`
  // has already registered the task. An authority loss there is therefore
  // just as post-registration as one from `/Run` itself - and since the
  // `finally` throw pre-empts the try block's own control flow, `/Run` is
  // never reached at all.
  it("marks a mutation-authority loss from the staging cleanup after a successful /Create as a committed registration, without attempting /Run", async () => {
    const authorityError = new ServiceMutationAuthorityError(
      new Error("maintenance lease revoked"),
    );
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      return success("");
    };
    setWindowsTaskInstallDepsForTests({
      stageTaskDefinition: async () => ({
        tmpDir: "/tmp/traycer-task-test",
        xmlPath: "/tmp/traycer-task-test/task.xml",
      }),
      removeStagedTaskDefinition: async () => {
        throw authorityError;
      },
    });

    let caught: unknown = null;
    try {
      await createWindowsController(runner, noTimingDeps).install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(authorityError);
    expect(isServiceMutationAuthorityError(caught)).toBe(true);
    expect(didServiceRegistrationCommit(caught)).toBe(true);
    expect(
      calls.filter(
        (call) => call.command === "schtasks" && call.args[0] === "/Run",
      ),
    ).toHaveLength(0);
  });

  // The negative twin: `/Create` itself fails, so the task was never
  // registered - the staging cleanup's authority loss must not be read as
  // committed. This is deliberate, not an oversight: the authority loss is
  // still what propagates, REPLACING the `SERVICE_INSTALL_FAILED` cliError
  // the `/Create` catch block built (a `finally` throw pre-empts the try
  // block's own control flow), because "may not mutate at all" is the more
  // fundamental fact of the two. It just must not be misread as committed,
  // since the task itself was never registered.
  it("does not mark a mutation-authority loss from the staging cleanup when /Create failed as a committed registration", async () => {
    const authorityError = new ServiceMutationAuthorityError(
      new Error("maintenance lease revoked"),
    );
    const runner: ProcessRunner = async (command, args) => {
      if (command === "schtasks" && args[0] === "/Create") {
        throw new ProcessRunError(
          "schtasks /Create exited with code 1: Access is denied.",
          command,
          args,
          1,
          "",
          "ERROR: Access is denied.",
        );
      }
      return success("");
    };
    setWindowsTaskInstallDepsForTests({
      stageTaskDefinition: async () => ({
        tmpDir: "/tmp/traycer-task-test",
        xmlPath: "/tmp/traycer-task-test/task.xml",
      }),
      removeStagedTaskDefinition: async () => {
        throw authorityError;
      },
    });

    let caught: unknown = null;
    try {
      await createWindowsController(runner, noTimingDeps).install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(authorityError);
    expect(isServiceMutationAuthorityError(caught)).toBe(true);
    expect(didServiceRegistrationCommit(caught)).toBe(false);
  });

  // A NON-authority staging cleanup failure is the ordinary case (a leftover
  // temp dir, a locked file) - it is logged at debug and swallowed, so when
  // `/Create` failed the propagating error stays the `SERVICE_INSTALL_FAILED`
  // cliError the catch block built, not the cleanup's own error.
  it("does not let a non-authority staging cleanup failure override a /Create failure", async () => {
    const runner: ProcessRunner = async (command, args) => {
      if (command === "schtasks" && args[0] === "/Create") {
        throw new ProcessRunError(
          "schtasks /Create exited with code 1: Access is denied.",
          command,
          args,
          1,
          "",
          "ERROR: Access is denied.",
        );
      }
      return success("");
    };
    setWindowsTaskInstallDepsForTests({
      stageTaskDefinition: async () => ({
        tmpDir: "/tmp/traycer-task-test",
        xmlPath: "/tmp/traycer-task-test/task.xml",
      }),
      removeStagedTaskDefinition: async () => {
        throw new Error("EBUSY");
      },
    });

    let caught: unknown = null;
    try {
      await createWindowsController(runner, noTimingDeps).install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
    });
    expect(didServiceRegistrationCommit(caught)).toBe(false);
  });

  // The other side of the same swallow: a non-authority cleanup failure must
  // not stop install from proceeding to the verified `/Run` once `/Create`
  // already succeeded.
  it("still runs /Run after a non-authority staging cleanup failure when /Create succeeded", async () => {
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      return success("");
    };
    setWindowsTaskInstallDepsForTests({
      stageTaskDefinition: async () => ({
        tmpDir: "/tmp/traycer-task-test",
        xmlPath: "/tmp/traycer-task-test/task.xml",
      }),
      removeStagedTaskDefinition: async () => {
        throw new Error("EBUSY");
      },
    });
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

    await expect(
      createWindowsController(runner, noTimingDeps).install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      }),
    ).resolves.toBeUndefined();

    expect(
      calls.filter(
        (call) => call.command === "schtasks" && call.args[0] === "/Run",
      ),
    ).toHaveLength(1);
  });

  // The post-`/Run` evidence poll is wrapped in try/catch so a NON-authority
  // rejection from `evidenceReader.collect()` is also rethrown marked
  // committed: the task exists and `/Run` was accepted, so everything from
  // here on is post-registration whatever the cause of the failure.
  it("marks a non-authority evidence-poll failure after an accepted /Run as a committed registration", async () => {
    const evidenceError = new Error("EIO");
    const runner: ProcessRunner = async () => success("");
    setWindowsTaskInstallDepsForTests(stagedTaskInstallDeps());
    setWindowsStartEvidenceDepsForTests({
      captureBaseline: async () => emptySpawnBaseline(),
      createEvidenceReader: () => ({
        collect: async () => {
          throw evidenceError;
        },
      }),
      sleep: async () => undefined,
      verifyTimeoutMs: 40,
      verifyPollMs: 10,
    });

    let caught: unknown = null;
    try {
      await createWindowsController(runner, noTimingDeps).install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(evidenceError);
    expect(didServiceRegistrationCommit(caught)).toBe(true);
  });

  // `readTaskLastRunResult` is only ever reached after `/Run` was accepted
  // and the post-baseline spawn-evidence poll timed out, so an authority
  // loss from that diagnostic query is just as post-registration as the
  // `/Run` failure it exists to explain.
  it("marks a mutation-authority loss from the Last Run Result query after an accepted /Run as a committed registration", async () => {
    const authorityError = new ServiceMutationAuthorityError(
      new Error("maintenance lease revoked"),
    );
    const runner: ProcessRunner = async (command, args) => {
      if (command === "schtasks" && args[0] === "/Query") {
        throw authorityError;
      }
      return success("");
    };
    setWindowsTaskInstallDepsForTests(stagedTaskInstallDeps());
    setWindowsStartEvidenceDepsForTests({
      captureBaseline: async () => emptySpawnBaseline(),
      createEvidenceReader: () => ({ collect: async () => null }),
      sleep: async () => undefined,
      verifyTimeoutMs: 40,
      verifyPollMs: 10,
    });

    let caught: unknown = null;
    try {
      await createWindowsController(runner, noTimingDeps).install({
        label: serviceLabelFor("staging"),
        cli: { command: "C:\\traycer.exe", args: [] },
        enableLinger: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(authorityError);
    expect(isServiceMutationAuthorityError(caught)).toBe(true);
    expect(didServiceRegistrationCommit(caught)).toBe(true);
  });
});

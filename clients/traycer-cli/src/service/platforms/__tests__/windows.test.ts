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
    expect(parseWindowsProcessTableJson('[100, "not-a-row"]')).toBeNull();

    // Ablation: in `parseProcessTableJson`, change `return null;` on a
    // malformed row to `continue;` (skipping just that row instead of
    // failing the whole parse) → the malformed-row assertions above fail:
    // a partial table would come back instead of `null`.
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
      "foreach ($row in $table) { $created[[int]$row.ProcessId] = $row.CreationDate }",
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
    expect(script).toContain("Created = $createdMs");
    // `Created`'s own guard: 0 when Windows reports no creation time at all
    // (pid 0 and System have none), never a stale or default timestamp.
    expect(script).toContain("$createdMs = 0");
    expect(script).toContain("if ($null -ne $_.CreationDate) {");

    // Ablation: in `buildSlotProcessTableScanScript`, drop
    // `...PARENT_EDGE_VALIDATION_SCRIPT_LINES` and emit
    // `ParentProcessId = [int]$_.ParentProcessId` again → this test fails, and
    // a recycled creator id becomes a believed ancestry edge.
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

    await killLingeringSlotProcesses(serviceLabelFor("staging"), runner);

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
    const controller = createWindowsController(runner);

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
    const controller = createWindowsController(runner);

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
    const controller = createWindowsController(runner);

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
    const controller = createWindowsController(runner);

    await controller.uninstall({ label: serviceLabelFor("staging") });

    expect(mocks.removeHostPidMetadata).toHaveBeenCalledWith("staging");
  });

  it("purges pid metadata on stop so a deliberate stop never reads as a crash", async () => {
    const runner: ProcessRunner = async (command) =>
      command === "powershell.exe" ? success("[]") : success("");
    const controller = createWindowsController(runner);

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
    const controller = createWindowsController(runner);

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
    const controller = createWindowsController(runner);

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
    const controller = createWindowsController(runner);

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
    const controller = createWindowsController(runner);

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
    const controller = createWindowsController(runner);

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
    // Round 0 kills host 100 (a genuine slot match). Round 1's snapshot shows
    // orphan 555, spawned after round 0's kill destroyed the edge proving it
    // belongs to the slot: its `parentProcessId` arrives as 0 (unverifiable,
    // host is dead), and its own path/command line matches nothing (a shell
    // or provider binary). Without `priorVictims` carrying host 100's
    // creation time forward, 555 looks like an ordinary unrelated process and
    // the loop would report convergence while it lives - the finding this
    // whole carry-over mechanism exists to close.
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
    const controller = createWindowsController(runner);

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
      ["/F", "/PID", "555"],
    ]);

    // Ablation (§ablation table): in `isChildOfVictim`, replace the body with
    // `return false;` → this test reddens alongside the direct "the finding"
    // algebra pin below - 555 is never seeded, round 1's kill set comes back
    // empty, and the stop resolves with 555 still alive.
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
    const controller = createWindowsController(runner);

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
    const controller = createWindowsController(runner);

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
    const controller = createWindowsController(runner);

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
      new Map<number, number>(),
    );

    expect(killSet).toEqual([100, 300, 400]);
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
      computeWindowsHostKillSet(rowsOf(rows), 200, new Map<number, number>()),
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
      computeWindowsHostKillSet(rowsOf(rows), 200, new Map<number, number>()),
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
        computeWindowsHostKillSet(rowsOf(rows), 200, new Map<number, number>()),
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
        computeWindowsHostKillSet(
          rowsOf(withChild),
          200,
          new Map<number, number>(),
        ),
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
  describe("computeWindowsHostKillSet - victim carry-over (claimedParentProcessId + created)", () => {
    it("the finding: a live row whose claimed parent is a remembered victim is killed - the same table with an empty victim map is not", () => {
      // Orphan 999 spawned after round 0 killed host 100: its real parent is
      // dead, so `parentProcessId` arrives as 0, and its own path matches
      // nothing (a shell or provider binary). Only `claimedParentProcessId`
      // still names 100, and `created` (1500) is not earlier than the
      // victim's own recorded creation time (1000).
      const table = rowsOf([
        {
          processId: 999,
          parentProcessId: 0,
          claimedParentProcessId: 100,
          created: 1500,
          slot: false,
        },
      ]);
      const priorVictims = new Map<number, number>([[100, 1000]]);

      expect(computeWindowsHostKillSet(table, 1, priorVictims)).toEqual([999]);
      // The contrast IS the finding: without the remembered victim, 999 looks
      // like an ordinary unrelated process and survives.
      expect(
        computeWindowsHostKillSet(table, 1, new Map<number, number>()),
      ).toEqual([]);

      // Ablation (§ablation table): in `isChildOfVictim`, replace the body
      // with `return false;` → run and confirmed: the first assertion above
      // reddens (`toEqual([999])` becomes `[]`, since the second already
      // expects `[]`), and so do three others that depend on the same
      // positive path - the loop-level carry-over test below, the
      // same-millisecond half of the "recycled parent id" test, and the "CLI
      // exclusion" test. The ablation table names only this test and the
      // carry-over test; disabling the function outright reddens every test
      // that seeds through it, which is wider than the table's own row.
    });

    it("recycled parent id: a claimed child OLDER than the victim is not killed; the SAME millisecond is", () => {
      // A fork can land in the same millisecond as its parent's own
      // creation, so equality must not invalidate - only a claimed child
      // strictly OLDER than the victim it claims as parent is a recycled id
      // wearing that victim's old pid.
      const priorVictims = new Map<number, number>([[100, 2000]]);
      const older = rowsOf([
        {
          processId: 999,
          parentProcessId: 0,
          claimedParentProcessId: 100,
          created: 1500,
          slot: false,
        },
      ]);
      expect(computeWindowsHostKillSet(older, 1, priorVictims)).toEqual([]);

      const sameMillisecond = rowsOf([
        {
          processId: 999,
          parentProcessId: 0,
          claimedParentProcessId: 100,
          created: 2000,
          slot: false,
        },
      ]);
      expect(
        computeWindowsHostKillSet(sameMillisecond, 1, priorVictims),
      ).toEqual([999]);

      // Ablation (§ablation table): in `isChildOfVictim`, drop the
      // `victimCreated <= row.created` check (treat any claimed match as a
      // hit) → the first assertion above reddens: the older row would be
      // killed as though 999 were really the victim's child.
    });

    it("unknown age fails closed: created 0 on the row, and separately on the victim, both refuse the link", () => {
      const priorVictims = new Map<number, number>([[100, 2000]]);
      const unknownRowAge = rowsOf([
        {
          processId: 999,
          parentProcessId: 0,
          claimedParentProcessId: 100,
          created: 0,
          slot: false,
        },
      ]);
      expect(computeWindowsHostKillSet(unknownRowAge, 1, priorVictims)).toEqual(
        [],
      );

      const unknownVictimAge = new Map<number, number>([[100, 0]]);
      const ordinaryRow = rowsOf([
        {
          processId: 999,
          parentProcessId: 0,
          claimedParentProcessId: 100,
          created: 1500,
          slot: false,
        },
      ]);
      expect(
        computeWindowsHostKillSet(ordinaryRow, 1, unknownVictimAge),
      ).toEqual([]);
    });

    it("the CLI exclusion holds against victim ancestry: a shell claiming the dead host as parent spares the CLI and the shell, but not the CLI's sibling", () => {
      // Round 0 killed host 100. Round 1's table: shell 50 claims the dead
      // host as its parent (a live edge the scan cannot verify, so
      // `parentProcessId` is 0) and is itself old enough to be believed as
      // host 100's child; the CLI (200) and a sibling (300) are both
      // ordinary, VALIDATED children of the still-live shell 50.
      const priorVictims = new Map<number, number>([[100, 1000]]);
      const table = rowsOf([
        {
          processId: 50,
          parentProcessId: 0,
          claimedParentProcessId: 100,
          created: 1500,
          slot: false,
        },
        { processId: 200, parentProcessId: 50, slot: false },
        { processId: 300, parentProcessId: 50, slot: false },
      ]);

      expect(computeWindowsHostKillSet(table, 200, priorVictims)).toEqual([
        300,
      ]);
      // The shell is a victim through the carry-over (it claims the dead
      // host as parent), but it is ALSO an ancestor of the CLI, so ancestry
      // spares it just as it would an ordinary non-slot shell. The CLI is
      // spared through the descendant closure as always. Neither exclusion
      // depends on the other - the sibling has no ancestry claim to the CLI
      // and is not itself seeded, so only the shell's own victim-descendant
      // closure could have reached it, and did.
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

    const controller = createWindowsController(runner);
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
    const controller = createWindowsController(runner);
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

    await createWindowsController(runner).install({
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
      await createWindowsController(runner).install({
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
      await createWindowsController(runner).start(serviceLabelFor("staging"));
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
      await createWindowsController(runner).install({
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
      await createWindowsController(runner).install({
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
      await createWindowsController(runner).install({
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
      await createWindowsController(runner).install({
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
      await createWindowsController(runner).install({
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
      await createWindowsController(runner).install({
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
      createWindowsController(runner).install({
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
      await createWindowsController(runner).install({
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
      await createWindowsController(runner).install({
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

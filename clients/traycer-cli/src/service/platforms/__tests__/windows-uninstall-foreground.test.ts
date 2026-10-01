import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWindowsController,
  setWindowsAccountSidResolverForTests,
  setWindowsDefinitionDepsForTests,
  setWindowsTaskUserSidReaderForTests,
  type ProcessRunner,
  type WindowsControllerDeps,
} from "../windows";
import { serviceLabelFor, windowsTaskName } from "../../label";
import { hostPidMetadataPath } from "../../../store/paths";

// RED sibling (A of a 4-part design - A=this file (Windows backend), B=the
// stop-intent decorator, C=the command-level surface
// (`service-uninstall-foreground.test.ts`), D=macOS/Linux, each owned by a
// different agent). Production is UNCHANGED here: `windows.ts`'s
// `uninstallService` (`../windows.ts:455-514`) does not accept or read a
// `leaveForegroundRun` field at all, so it unconditionally runs the
// scan+kill+pid-removal sequence regardless of what is passed in
// `UninstallServiceOptions`.
//
// Target design this suite is written against (not yet implemented):
// `uninstallService`, when `options.leaveForegroundRun !== null`, must KEEP
// `schtasks /End`/`/Delete`, the launcher `rm` and the folder cleanup, but
// SKIP `killVerifiedProcessTree` (the slot scan + handle-bound kill) and
// SKIP `removeHostPidMetadata` - Windows-parity with macOS/Linux, where
// uninstall never reaches a host process at all.
//
// HOME isolation: this file runs ONLY through the mandated `sweep-home.sh`
// wrapper, which sets `HOME`/`USERPROFILE` to a fresh `mktemp` directory for
// the whole vitest PROCESS before any module loads - so `node:os.homedir()`
// (which `store/paths.ts` binds at module load into `TRAYCER_HOME`) resolves
// under that private directory with no in-file `node:os` mock needed, unlike
// `windows.test.ts`'s own per-suite `vi.mock("node:os", ...)`.
//
// `pid.json` is a REAL file, not a mock: `hostPidMetadataPath` from the real
// `store/paths` resolves the on-disk path, and this suite reads/writes it
// with real `node:fs/promises` calls so it can assert byte-identity across
// `uninstall`.

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

function success(stdout: string): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  return { stdout, stderr: "", exitCode: 0 };
}

// Both halves of a kill round are `powershell.exe` invocations, told apart by
// the script they carry - mirrors `windows.test.ts`'s own `isScanCall` /
// `isKillCall` exactly, since a new file must recognize the same two real
// commands the production kill loop issues.
function isScanCall(command: string, args: readonly string[]): boolean {
  return (
    command === "powershell.exe" &&
    args.some((arg) => arg.includes("Get-CimInstance Win32_Process"))
  );
}

function isKillCall(command: string, args: readonly string[]): boolean {
  return (
    command === "powershell.exe" &&
    args.some((arg) => arg.includes("GetProcessById"))
  );
}

interface TableRowInput {
  readonly processId: number;
  readonly parentProcessId: number;
  readonly slot: boolean;
}

function tableJson(rows: readonly TableRowInput[]): string {
  return JSON.stringify(
    rows.map((row) => ({
      ProcessId: row.processId,
      ParentProcessId: row.parentProcessId,
      ClaimedParentProcessId: row.parentProcessId,
      Created: 0,
      Slot: row.slot,
    })),
  );
}

// A scan-then-kill fixture that CONVERGES the way the real scan does, mirroring
// `windows.test.ts`'s `convergingTableRunner`: one slot-matched row (the
// terminal-started host) on the first scan, then empty on every later scan
// because the kill removed it from the live set.
function convergingTableRunner(rows: readonly TableRowInput[]): {
  readonly runner: ProcessRunner;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let live = rows;
  const runner: ProcessRunner = async (command, args) => {
    calls.push({ command, args });
    if (isScanCall(command, args)) return success(tableJson(live));
    if (isKillCall(command, args)) {
      const killedPids = new Set<number>();
      const script = args.find((arg) => arg.includes("GetProcessById")) ?? "";
      for (const match of script.matchAll(/ProcessId = (\d+);/g)) {
        killedPids.add(Number(match[1]));
      }
      live = live.filter((row) => !killedPids.has(row.processId));
    }
    return success("");
  };
  return { runner, calls };
}

const noTimingDeps: WindowsControllerDeps = { now: () => 0 };

// The ownership gate reads the registered task in front of every verb that
// changes it and fails closed when it cannot tell whose it is: the task under
// test is registered by the account these tests run as.
const CALLER_SID = "S-1-5-21-1000-2000-3000-1001";
const OWN_TASK_XML = `<Task><Principals><Principal id="Author"><UserId>${CALLER_SID}</UserId></Principal></Principals><Settings><Enabled>true</Enabled></Settings><Actions Context="Author"><Exec><Command>x</Command></Exec></Actions></Task>`;

beforeEach(() => {
  setWindowsTaskUserSidReaderForTests(() => CALLER_SID);
  setWindowsAccountSidResolverForTests(async () => null);
  setWindowsDefinitionDepsForTests({
    queryTaskXml: async () => ({ kind: "xml", xml: OWN_TASK_XML }),
    predictCli: async () => {
      throw new Error("predictCli is not part of an uninstall");
    },
    resolveCli: async () => {
      throw new Error("resolveCli is not part of an uninstall");
    },
  });
});

afterEach(() => {
  setWindowsTaskUserSidReaderForTests(null);
  setWindowsAccountSidResolverForTests(null);
  setWindowsDefinitionDepsForTests(null);
});

const LABEL = serviceLabelFor("staging");
const TASK_NAME = windowsTaskName(LABEL);

const TERMINAL_HOST_ROW: TableRowInput = {
  processId: 4242,
  parentProcessId: 1,
  slot: true,
};

async function writeRealPidJson(): Promise<{
  readonly path: string;
  readonly bytes: Buffer;
}> {
  const path = hostPidMetadataPath("staging");
  await mkdir(path.replace(/[^/\\]+$/, ""), { recursive: true });
  const bytes = Buffer.from(
    JSON.stringify({
      pid: TERMINAL_HOST_ROW.processId,
      hostId: "host-under-test",
      version: "1.9.0",
      websocketUrl: "ws://127.0.0.1:54999/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      processStartIdentityRead: "absent",
      layer0: null,
      layer0Slot: null,
    }),
    "utf8",
  );
  await writeFile(path, bytes);
  return { path, bytes };
}

describe("Windows uninstall - leaving a terminal foreground run alone", () => {
  // (RED) Target design: passing a non-null `leaveForegroundRun` must skip the
  // slot scan, the kill, and the pid.json removal entirely, while still
  // running `schtasks /Delete`. Current `uninstallService` reads no such
  // field and always runs the scan+kill+pid-removal sequence, so this fails
  // on unmodified `windows.ts`.
  it("leaveForegroundRun !== null skips the scan/kill and pid.json removal, but still deletes the task", async () => {
    const { runner, calls } = convergingTableRunner([TERMINAL_HOST_ROW]);
    const controller = createWindowsController(runner, noTimingDeps);
    const { path: pidJsonPath, bytes: before } = await writeRealPidJson();

    await controller.uninstall({
      label: LABEL,
      leaveForegroundRun: {
        supervisorPid: TERMINAL_HOST_ROW.processId,
        hostPid: TERMINAL_HOST_ROW.processId,
      },
    });

    // No slot scan and no kill script ran at all.
    expect(calls.some((call) => isScanCall(call.command, call.args))).toBe(
      false,
    );
    expect(calls.some((call) => isKillCall(call.command, call.args))).toBe(
      false,
    );

    // The task deletion still ran.
    expect(
      calls.some(
        (call) =>
          call.command === "schtasks" &&
          call.args[0] === "/Delete" &&
          call.args[1] === "/TN" &&
          call.args[2] === TASK_NAME &&
          call.args[3] === "/F",
      ),
    ).toBe(true);

    // pid.json survives, byte-identical.
    const after = await readFile(pidJsonPath);
    expect(after.equals(before)).toBe(true);
  });

  // (control, GREEN) Unchanged/current behavior: `leaveForegroundRun: null`
  // exercises the exact path current code already takes today - scan, kill
  // and pid.json removal all run, and `/Delete` runs too. This should pass
  // on unmodified `windows.ts`.
  it("(control) leaveForegroundRun: null runs the full scan+kill+pid-removal sequence like today", async () => {
    const { runner, calls } = convergingTableRunner([TERMINAL_HOST_ROW]);
    const controller = createWindowsController(runner, noTimingDeps);
    const { path: pidJsonPath } = await writeRealPidJson();

    await controller.uninstall({
      label: LABEL,
      leaveForegroundRun: null,
    });

    expect(calls.some((call) => isScanCall(call.command, call.args))).toBe(
      true,
    );
    expect(calls.some((call) => isKillCall(call.command, call.args))).toBe(
      true,
    );
    expect(
      calls.some(
        (call) =>
          call.command === "schtasks" &&
          call.args[0] === "/Delete" &&
          call.args[1] === "/TN" &&
          call.args[2] === TASK_NAME &&
          call.args[3] === "/F",
      ),
    ).toBe(true);

    // pid.json is removed on this path, exactly like today.
    await expect(readFile(pidJsonPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

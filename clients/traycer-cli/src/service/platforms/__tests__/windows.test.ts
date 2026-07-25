import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildWindowsSlotProcessScanScript,
  createWindowsController,
  parseSchtasksLastRunResult,
  parseWindowsProcessIdJson,
  setWindowsStartEvidenceDepsForTests,
  setWindowsTaskInstallDepsForTests,
  type ProcessRunner,
  type WindowsStartEvidenceDeps,
  type WindowsTaskInstallDeps,
} from "../windows";
import { serviceLabelFor } from "../../label";
import type { RunResult } from "../../process-runner";
import type { SpawnEvidenceBaseline } from "../../../host/spawn-evidence";
import { CLI_ERROR_CODES } from "../../../runner/errors";

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

  it("parses PowerShell process id JSON", () => {
    expect(parseWindowsProcessIdJson("123")).toEqual([123]);
    expect(parseWindowsProcessIdJson("[123,456]")).toEqual([123, 456]);
    expect(parseWindowsProcessIdJson("")).toEqual([]);
    expect(parseWindowsProcessIdJson('"not-a-pid"')).toEqual([]);
  });

  it("builds a slot-scoped process scan that excludes the current CLI process", () => {
    const script = buildWindowsSlotProcessScanScript({
      hostHome: "C:\\Users\\Traycer Dev\\.traycer\\host\\staging",
      currentPid: 1234,
    });
    expect(script).toContain("$excluded = @(1234, $PID)");
    expect(script).toContain(".traycer\\host\\staging\\install\\");
    expect(script).toContain("Replace('/', '\\')");
  });

  it("does not use broad production roots as process-match prefixes", () => {
    const script = buildWindowsSlotProcessScanScript({
      hostHome: "C:\\Users\\Traycer Dev\\.traycer\\host",
      currentPid: 1234,
    });
    expect(script).toContain(
      "c:\\users\\traycer dev\\.traycer\\host\\install\\",
    );
    expect(script).not.toContain("'c:\\users\\traycer dev\\.traycer\\host'");
  });

  it("kills slot-scanned processes when pid metadata is missing", async () => {
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      return command === "powershell.exe" ? success("[401,402]") : success("");
    };
    const controller = createWindowsController(runner);

    await controller.stop(serviceLabelFor("staging"));

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
      ["/T", "/F", "/PID", "401"],
      ["/T", "/F", "/PID", "402"],
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
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      return command === "powershell.exe" ? success("[401,402]") : success("");
    };
    const controller = createWindowsController(runner);

    await controller.stop(serviceLabelFor("staging"));

    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args[3]),
    ).toEqual(["401", "402"]);
  });

  it("does not kill the recorded pid when the scan verifies it no longer matches the host", async () => {
    // pid.json says 401, but the verified slot scan only finds 402 - the OS
    // recycled 401 for an unrelated process, which must survive.
    mocks.readHostPidMetadata.mockResolvedValue({
      pid: 401,
      hostId: "host-test",
      version: "1.0.0",
      websocketUrl: "ws://127.0.0.1:54321/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      return command === "powershell.exe" ? success("[402]") : success("");
    };
    const controller = createWindowsController(runner);

    await controller.stop(serviceLabelFor("staging"));

    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args[3]),
    ).toEqual(["402"]);
  });

  it("falls back to the recorded pid when the slot scan cannot run", async () => {
    mocks.readHostPidMetadata.mockResolvedValue({
      pid: 401,
      hostId: "host-test",
      version: "1.0.0",
      websocketUrl: "ws://127.0.0.1:54321/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "powershell.exe") throw new Error("spawn failed");
      return success("");
    };
    const controller = createWindowsController(runner);

    await controller.stop(serviceLabelFor("staging"));

    expect(
      calls
        .filter((call) => call.command === "taskkill")
        .map((call) => call.args[3]),
    ).toEqual(["401"]);
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

    await controller.stop(serviceLabelFor("staging"));

    expect(mocks.removeHostPidMetadata).toHaveBeenCalledWith("staging");
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
});

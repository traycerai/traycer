import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildWindowsSlotProcessScanScript,
  createWindowsController,
  parseWindowsProcessIdJson,
  type ProcessRunner,
} from "../windows";
import { serviceLabelFor } from "../../label";
import type { RunResult } from "../../process-runner";

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

describe("Windows service stale host cleanup", () => {
  beforeEach(() => {
    mocks.readHostPidMetadata.mockReset();
    mocks.readHostPidMetadata.mockResolvedValue(null);
    mocks.removeHostPidMetadata.mockReset();
    mocks.removeHostPidMetadata.mockResolvedValue(undefined);
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

  it("deduplicates pid metadata with slot-scanned processes", async () => {
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

  it("purges pid metadata on stop so a deliberate stop never reads as a crash", async () => {
    const runner: ProcessRunner = async (command) =>
      command === "powershell.exe" ? success("[]") : success("");
    const controller = createWindowsController(runner);

    await controller.stop(serviceLabelFor("staging"));

    expect(mocks.removeHostPidMetadata).toHaveBeenCalledWith("staging");
  });
});

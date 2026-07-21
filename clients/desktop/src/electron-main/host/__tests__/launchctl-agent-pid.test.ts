import { describe, expect, it, vi } from "vitest";
import {
  parseLaunchctlPid,
  runLaunchctlPrint,
  type LaunchctlPrintChildProcess,
} from "../launchctl-agent-pid";

vi.mock("../../app/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// A spawn stub whose child emits its stdout then an `exit` (or `error`) on a
// microtask - after `runLaunchctlPrint` has registered its listeners.
function fakeSpawn(opts: {
  stdout: string | null;
  code: number | null;
  emitError: boolean;
}) {
  return () => {
    let dataListener: ((chunk: Buffer | string) => void) | null = null;
    const listeners: Record<string, (...args: unknown[]) => void> = {};
    const child: LaunchctlPrintChildProcess = {
      stdout:
        opts.stdout === null
          ? null
          : {
              on: (_event: "data", listener) => {
                dataListener = listener;
                return child;
              },
            },
      once: (event, listener) => {
        listeners[event] = listener as (...args: unknown[]) => void;
        return child;
      },
      kill: vi.fn().mockReturnValue(true),
    };
    void Promise.resolve().then(() => {
      if (opts.stdout !== null && dataListener !== null) {
        dataListener(opts.stdout);
      }
      if (opts.emitError) {
        listeners.error?.(new Error("spawn failed"));
      } else {
        listeners.exit?.(opts.code, null);
      }
    });
    return child;
  };
}

describe("parseLaunchctlPid", () => {
  it("extracts the pid from a running job", () => {
    expect(parseLaunchctlPid("\tpid = 12345\n\tstate = running")).toBe(12345);
  });

  it("returns null when the job is loaded but not running (no pid line)", () => {
    expect(
      parseLaunchctlPid("\tstate = not running\n\tprogram = foo"),
    ).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(parseLaunchctlPid("")).toBeNull();
  });

  it("ignores a zero or malformed pid", () => {
    expect(parseLaunchctlPid("\tpid = 0")).toBeNull();
    expect(parseLaunchctlPid("\tpid = notanumber")).toBeNull();
  });

  it("does not match a substring like `lastpid`", () => {
    // The anchored line match requires `pid = <n>` on its own line.
    expect(parseLaunchctlPid("\tlast exit pid = 9\n")).toBeNull();
  });
});

describe("runLaunchctlPrint", () => {
  it("resolves stdout when the job is loaded (exit 0)", async () => {
    const result = await runLaunchctlPrint(
      "gui/501/ai.traycer.host.agent",
      fakeSpawn({ stdout: "\tpid = 777\n", code: 0, emitError: false }),
    );
    expect(result).toBe("\tpid = 777\n");
    expect(parseLaunchctlPid(result ?? "")).toBe(777);
  });

  it("resolves null when the job is not loaded (non-zero exit)", async () => {
    const result = await runLaunchctlPrint(
      "gui/501/ai.traycer.host.agent",
      fakeSpawn({
        stdout: "Could not find service",
        code: 113,
        emitError: false,
      }),
    );
    expect(result).toBeNull();
  });

  it("resolves null when the spawn errors", async () => {
    const result = await runLaunchctlPrint(
      "gui/501/ai.traycer.host.agent",
      fakeSpawn({ stdout: null, code: null, emitError: true }),
    );
    expect(result).toBeNull();
  });
});

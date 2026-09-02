import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandRequest } from "../secret-providers/run-command";

/**
 * `runCommand` is the one seam in this directory that drives a REAL
 * `node:child_process` rather than being driven behind a fake
 * `CommandRunner` - every other suite here fakes the runner and never
 * spawns a process. There is no practical way to make a genuinely spawned
 * process's stdout pipe emit `error` from outside the process, so this
 * suite mocks `node:child_process` itself and drives a fake `ChildProcess`
 * directly.
 */

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  default: { spawn: spawnMock },
}));

class FakeStdout extends EventEmitter {}

class FakeStdin extends EventEmitter {
  end(): void {}
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new FakeStdout();
  readonly stdin = new FakeStdin();
  readonly kill = vi.fn();
}

afterEach(() => {
  vi.clearAllMocks();
});

const REQUEST: CommandRequest = {
  file: "secret-tool",
  args: ["lookup", "application", "chrome"],
  stdin: null,
  timeoutMs: 30_000,
};

describe("runCommand", () => {
  it("settles spawn-failed when the stdout pipe errors", async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const { runCommand } = await import("../secret-providers/run-command");

    const pending = runCommand(REQUEST);
    const pipeError = Object.assign(new Error("read EPIPE"), {
      code: "EPIPE",
    });
    child.stdout.emit("error", pipeError);

    await expect(pending).resolves.toEqual({
      kind: "spawn-failed",
      code: "EPIPE",
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it } from "vitest";

import {
  ProcessRunError,
  ProcessSpawnError,
  runCommand,
} from "../process-runner";

// Real children, no mocks: the discriminator under test is "did this
// command reach the OS", and only a real `execFile` can answer that. Each
// case is a distinct failure shape execFile reports, and the class the
// runner must assign to it.
const options = {
  env: undefined,
  cwd: undefined,
  timeoutMs: 30_000,
  tolerateNonZeroExit: false,
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the command to fail");
}

describe("runCommand spawn-failure classification", () => {
  it("a binary that does not exist is a spawn failure", async () => {
    const error = await rejection(
      runCommand("traycer-no-such-binary-4f9c2e", ["--version"], options),
    );
    expect(error).toBeInstanceOf(ProcessSpawnError);
    expect(error).toBeInstanceOf(ProcessRunError);
    expect((error as Error).message).toContain("could not be spawned (ENOENT)");
  });

  it("a child that ran and exited non-zero is a run failure, not a spawn failure", async () => {
    const error = await rejection(
      runCommand(process.execPath, ["-e", "process.exit(3)"], options),
    );
    expect(error).toBeInstanceOf(ProcessRunError);
    expect(error).not.toBeInstanceOf(ProcessSpawnError);
    expect((error as ProcessRunError).exitCode).toBe(3);
  });

  // The case a "string error code means it never started" heuristic gets
  // wrong: execFile reports `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` - a string
  // code - for a child that DID start and produced more than `maxBuffer`.
  // Callers that act on "provably never reached its target" (the macOS
  // bootout eviction) must not be told that about a command that ran.
  it("a child that overflowed maxBuffer ran, so it is a run failure", async () => {
    const error = await rejection(
      runCommand(
        process.execPath,
        ["-e", 'process.stdout.write("x".repeat(5 * 1024 * 1024))'],
        options,
      ),
    );
    expect(error).toBeInstanceOf(ProcessRunError);
    expect(error).not.toBeInstanceOf(ProcessSpawnError);
  });
});

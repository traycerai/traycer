import { describe, expect, it } from "vitest";

import {
  ProcessRunError,
  ProcessSpawnError,
  ProcessTimeoutError,
  runCommand,
  runCommandForBytes,
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
    expect(error).not.toBeInstanceOf(ProcessTimeoutError);
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
    expect(error).not.toBeInstanceOf(ProcessTimeoutError);
  });

  // The recycle-timeout fix's own discriminator: a child the RUNNER killed
  // for outliving `timeoutMs` must be distinguishable from every other run
  // failure, because `launchctl kickstart -k` / `systemctl restart` callers
  // report this shape as "unconfirmed", never as "failed" - killing the CLI
  // process withdraws nothing the service manager already accepted.
  it("a child that outlives timeoutMs is killed and reported as a ProcessTimeoutError", async () => {
    const error = await rejection(
      runCommand(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        ...options,
        timeoutMs: 200,
      }),
    );
    expect(error).toBeInstanceOf(ProcessTimeoutError);
    expect(error).toBeInstanceOf(ProcessRunError);
    expect(error).not.toBeInstanceOf(ProcessSpawnError);
    expect((error as ProcessTimeoutError).timeoutMs).toBe(200);
    expect((error as Error).message).toContain("timed out after 200ms");
  });
});

// `runCommandForBytes`: {@link runCommand}'s sibling for a read whose stdout
// is not UTF-8 (`schtasks /Query /XML` on Windows). Real children again - the
// question is exactly the same class of "did this reach the OS" as above,
// now against the `{stdout: Buffer, exitCode}` shape and buffer decoding.
const bytesOptions = {
  env: undefined,
  cwd: undefined,
  timeoutMs: 30_000,
};

describe("runCommandForBytes", () => {
  it("resolves { stdout: Buffer, exitCode } on a non-zero exit, rather than rejecting", async () => {
    const result = await runCommandForBytes(
      process.execPath,
      ["-e", 'process.stdout.write("partial-output"); process.exit(3)'],
      bytesOptions,
    );

    expect(result.exitCode).toBe(3);
    expect(Buffer.isBuffer(result.stdout)).toBe(true);
    expect(result.stdout.toString("utf8")).toBe("partial-output");
  });

  it("resolves stdout as raw bytes, not a UTF-8-decoded string (the whole reason this function exists)", async () => {
    // A UTF-16LE-with-BOM buffer: this is exactly the shape `schtasks
    // /Query /TN <task> /XML` writes, and decoding it as UTF-8 mangles it.
    // Round-tripping it through the child's stdout and back through
    // `TextDecoder("utf-16le")` proves the runner never touched the bytes.
    const text = "<Task>hello</Task>";
    const utf16le = Buffer.from(`﻿${text}`, "utf16le");
    const script = `process.stdout.write(Buffer.from(${JSON.stringify(utf16le.toString("base64"))}, "base64"))`;

    const result = await runCommandForBytes(
      process.execPath,
      ["-e", script],
      bytesOptions,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.equals(utf16le)).toBe(true);
    expect(
      new TextDecoder("utf-16le", { fatal: true }).decode(
        result.stdout.subarray(2),
      ),
    ).toBe(text);
  });

  it("rejects when the command does not exist", async () => {
    const error = await rejection(
      runCommandForBytes(
        "traycer-no-such-binary-4f9c2e",
        ["--version"],
        bytesOptions,
      ),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  it("resolves { exitCode: 0 } for a command that ran and exited cleanly", async () => {
    const result = await runCommandForBytes(
      process.execPath,
      ["-e", "process.exit(0)"],
      bytesOptions,
    );
    expect(result.exitCode).toBe(0);
  });
});

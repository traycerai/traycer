import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Raised in review of oss#1019. The two halves of the int#4840 fix combine
// into a way to report a failed run as successful:
//
//   1. the CLI drains instead of calling `process.exit`, so a command
//      interrupted by an unhandled rejection KEEPS RUNNING and can still
//      return an `ok` result;
//   2. exit-code arbitration is monotonic, so the fatal `1` survives;
//   3. Desktop's `streamTraycerCli` now trusts a terminal `ok` OVER the
//      non-zero exit code.
//
// Together: a process-fatal failure during `host install` would emit `ok`,
// exit 1, and Desktop would report the install as successful.
//
// Fixed CLI-side rather than by narrowing Desktop's condition. Desktop cannot
// tell a teardown abort from a fatal handler without guessing from exit codes
// and stderr text - which is exactly the inference `sawTerminalOk` replaced.
// The CLI knows, so the CLI must not make the claim.

const stdoutChunks: string[] = [];

describe("terminal result after a process-fatal failure", () => {
  let priorExitCode: number | string | null | undefined;

  beforeEach(() => {
    priorExitCode = process.exitCode;
    process.exitCode = undefined;
    stdoutChunks.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
      callback: (() => void) | undefined,
    ) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      if (callback !== undefined) callback();
      return true;
    }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(((
      _chunk: string | Uint8Array,
      callback: (() => void) | undefined,
    ) => {
      if (callback !== undefined) callback();
      return true;
    }) as never);
    // `processFatal` is module state; a fresh import per test resets it.
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = priorExitCode;
  });

  function terminalEnvelope(): Record<string, unknown> | null {
    let terminal: Record<string, unknown> | null = null;
    for (const line of stdoutChunks.join("").split("\n")) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed !== null && typeof parsed === "object") {
        const env = parsed as Record<string, unknown>;
        if (env.type === "result") terminal = env;
      }
    }
    return terminal;
  }

  it("reports an error envelope when the command succeeded but the process did not", async () => {
    const { markProcessFatal } = await import("../exit");
    const { runCommand } = await import("../runner");

    // The unhandled-rejection handler fires while the command is in flight.
    markProcessFatal();

    await runCommand(
      async () => ({ data: { ok: true }, human: "ok", exitCode: 0 }),
      { json: true, quiet: null, noProgress: null, noBootstrap: null },
    );

    const terminal = terminalEnvelope();
    expect(terminal).not.toBeNull();
    // The load-bearing assertion: NOT `ok`. Desktop keys on exactly this.
    expect(terminal?.status).toBe("error");
    expect((terminal?.error as Record<string, unknown>).code).toBe(
      "E_UNEXPECTED",
    );
    expect(process.exitCode).toBe(1);
  });

  it("still emits the ok envelope when no process-fatal occurred", async () => {
    const { runCommand } = await import("../runner");

    await runCommand(
      async () => ({ data: { ok: true }, human: "ok", exitCode: 0 }),
      { json: true, quiet: null, noProgress: null, noBootstrap: null },
    );

    // Guards against the fix degenerating into "never report success".
    const terminal = terminalEnvelope();
    expect(terminal?.status).toBe("ok");
    expect(process.exitCode).toBe(0);
  });
});

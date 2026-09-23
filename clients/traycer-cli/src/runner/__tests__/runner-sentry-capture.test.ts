import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The runner used to report EVERY thrown command error to Sentry, before
// `toCliError` had classified it. Three expected outcomes - an expired token,
// a missing `TRAYCER_EPIC_ID` and the host-busy restart refusal - produced
// 214k events in one billing period on their own.
//
// Classification now runs first: an expected code leaves a breadcrumb, and
// everything else is still captured. What must NOT change is what the caller
// sees - the local log line, the NDJSON error envelope and the exit code are
// the command's answer and are independent of whether we told Sentry.

interface Breadcrumb {
  readonly category: string;
  readonly message: string;
  readonly data: { readonly code: string };
}

const sentryMocks = vi.hoisted(() => ({
  captureException: vi.fn<(err: unknown) => void>(),
  addBreadcrumb: vi.fn<(crumb: unknown) => void>(),
  close: vi.fn<(timeout: number) => Promise<boolean>>(() =>
    Promise.resolve(true),
  ),
}));

vi.mock("@sentry/node", () => ({
  captureException: (err: unknown) => sentryMocks.captureException(err),
  addBreadcrumb: (crumb: unknown) => sentryMocks.addBreadcrumb(crumb),
  close: (timeout: number) => sentryMocks.close(timeout),
}));

const stdoutChunks: string[] = [];

describe("runner Sentry capture", () => {
  let priorExitCode: number | string | null | undefined;

  beforeEach(() => {
    priorExitCode = process.exitCode;
    process.exitCode = undefined;
    stdoutChunks.length = 0;
    sentryMocks.captureException.mockReset();
    sentryMocks.addBreadcrumb.mockReset();
    sentryMocks.close.mockReset().mockResolvedValue(true);
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
    // Exit arbitration is module state; a fresh import per test resets it.
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

  async function runThrowing(err: unknown): Promise<void> {
    const { runCommand } = await import("../runner");
    await runCommand(
      async () => {
        throw err;
      },
      { json: true, quiet: null, noProgress: null, noBootstrap: null },
    );
  }

  it("does not capture an expected code, and still answers the caller", async () => {
    const { CLI_ERROR_CODES, CliError } = await import("../errors");

    await runThrowing(
      new CliError({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: "session expired",
        details: null,
        exitCode: 4,
      }),
    );

    expect(sentryMocks.captureException).not.toHaveBeenCalled();
    const terminal = terminalEnvelope();
    expect(terminal?.status).toBe("error");
    expect((terminal?.error as Record<string, unknown>).code).toBe(
      "E_AUTH_REJECTED",
    );
    expect(process.exitCode).toBe(4);
  });

  it("leaves a breadcrumb naming the skipped code", async () => {
    const { CLI_ERROR_CODES, CliError } = await import("../errors");

    await runThrowing(
      new CliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "host is busy",
        details: null,
        exitCode: 1,
      }),
    );

    expect(sentryMocks.addBreadcrumb).toHaveBeenCalledTimes(1);
    const crumb = sentryMocks.addBreadcrumb.mock.calls[0][0] as Breadcrumb;
    expect(crumb.category).toBe("cli");
    expect(crumb.data.code).toBe("E_HOST_BUSY");
  });

  it("captures a code that means the machine is broken", async () => {
    const { CLI_ERROR_CODES, CliError } = await import("../errors");
    const err = new CliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
      message: "extract failed",
      details: null,
      exitCode: 1,
    });

    await runThrowing(err);

    expect(sentryMocks.captureException).toHaveBeenCalledTimes(1);
    expect(sentryMocks.captureException).toHaveBeenCalledWith(err);
    expect(sentryMocks.addBreadcrumb).not.toHaveBeenCalled();
  });

  it("captures a plain Error, which classifies as UNEXPECTED", async () => {
    const err = new Error("boom");

    await runThrowing(err);

    expect(sentryMocks.captureException).toHaveBeenCalledWith(err);
    expect((terminalEnvelope()?.error as Record<string, unknown>).code).toBe(
      "E_UNEXPECTED",
    );
  });

  it("captures a non-Error throw", async () => {
    await runThrowing("just a string");

    expect(sentryMocks.captureException).toHaveBeenCalledWith("just a string");
    expect((terminalEnvelope()?.error as Record<string, unknown>).code).toBe(
      "E_UNEXPECTED",
    );
  });
});

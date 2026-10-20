import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import {
  cliSentryRepeatKey,
  defaultRepeatGateIo,
  type RepeatDecision,
  type RepeatGateIo,
} from "../sentry-repeat-gate";
import { config } from "../../config";

// The runner used to report EVERY thrown command error to Sentry, before
// `toCliError` had classified it. Three expected outcomes - an expired token,
// a missing `TRAYCER_EPIC_ID` and the host-busy restart refusal - produced
// 214k events in one billing period on their own.
//
// Classification now runs first: an expected code leaves a breadcrumb, and
// everything else is still captured. What must NOT change is what the caller
// sees - the local log line, the NDJSON error envelope and the exit code are
// the command's answer and are independent of whether we told Sentry.
//
// A non-expected code is also gated per-machine-per-window by
// sentry-repeat-gate.ts (see that module's own test file for the gate's
// logic); this file mocks the gate itself so every case here exercises
// runner.ts's wiring to it - `getClient()`, the decision branch, and the
// arguments passed through - without touching a real ledger file.

interface Breadcrumb {
  readonly category: string;
  readonly message: string;
  readonly data: Record<string, unknown>;
}

const sentryMocks = vi.hoisted(() => ({
  captureException: vi.fn<(err: unknown, context: unknown) => void>(),
  addBreadcrumb: vi.fn<(crumb: unknown) => void>(),
  close: vi.fn<(timeout: number) => Promise<boolean>>(() =>
    Promise.resolve(true),
  ),
  getClient: vi.fn<() => object | undefined>(),
}));

vi.mock("@sentry/node", () => ({
  captureException: (err: unknown, context: unknown) =>
    sentryMocks.captureException(err, context),
  addBreadcrumb: (crumb: unknown) => sentryMocks.addBreadcrumb(crumb),
  close: (timeout: number) => sentryMocks.close(timeout),
  getClient: () => sentryMocks.getClient(),
}));

const repeatGateMocks = vi.hoisted(() => ({
  recordCliFailureForSentry:
    vi.fn<
      (
        environment: string,
        key: string,
        io: RepeatGateIo,
      ) => Promise<RepeatDecision>
    >(),
}));

vi.mock("../sentry-repeat-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sentry-repeat-gate")>();
  return {
    ...actual,
    recordCliFailureForSentry: repeatGateMocks.recordCliFailureForSentry,
  };
});

const stdoutChunks: string[] = [];

describe("runner Sentry capture", () => {
  let priorExitCode: number | string | null | undefined;
  let stdoutWriteSpy: MockInstance;

  beforeEach(() => {
    priorExitCode = process.exitCode;
    process.exitCode = undefined;
    stdoutChunks.length = 0;
    sentryMocks.captureException.mockReset();
    sentryMocks.addBreadcrumb.mockReset();
    sentryMocks.close.mockReset().mockResolvedValue(true);
    // A build with a live DSN has a client; individual tests override this
    // to exercise the "no client" early return.
    sentryMocks.getClient.mockReset().mockReturnValue({});
    repeatGateMocks.recordCliFailureForSentry
      .mockReset()
      .mockResolvedValue({ kind: "report", repeatsSinceLastReport: 0 });
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
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

  // Both codes report a state of the connection the command has already told
  // the user about (see `mapHostRpcError` in host-rpc.ts), not a CLI defect,
  // so neither may reach `Sentry.captureException`. What they differ in is
  // what they tell a caller about the request - whether it can simply be sent
  // again, or may already have been carried out - and not in how the runner
  // reports them, so the runner's contract is pinned once over both: no
  // capture, one breadcrumb naming the code, the code and the message on the
  // NDJSON envelope, and the exit code the error carries.
  it.each([
    {
      key: "HOST_UNREACHABLE" as const,
      expected: "E_HOST_UNREACHABLE",
      message: "WebSocket dial timed out after 10000ms",
    },
    {
      key: "HOST_REQUEST_OUTCOME_UNKNOWN" as const,
      expected: "E_HOST_REQUEST_OUTCOME_UNKNOWN",
      message:
        "traycer: WebSocket frame timed out after 15000ms - the request was sent and the host may have carried it out; check before sending it again.",
    },
  ])(
    "answers the caller with $expected without capturing it as a defect",
    async ({ key, expected, message }) => {
      const { CLI_ERROR_CODES, CliError } = await import("../errors");

      await runThrowing(
        new CliError({
          code: CLI_ERROR_CODES[key],
          message,
          details: null,
          exitCode: 1,
        }),
      );

      expect(sentryMocks.captureException).not.toHaveBeenCalled();
      expect(sentryMocks.addBreadcrumb).toHaveBeenCalledTimes(1);
      const crumb = sentryMocks.addBreadcrumb.mock.calls[0][0] as Breadcrumb;
      expect(crumb.category).toBe("cli");
      expect(crumb.data.code).toBe(expected);

      const terminal = terminalEnvelope();
      expect(terminal?.status).toBe("error");
      const reported = terminal?.error as Record<string, unknown>;
      expect(reported.code).toBe(expected);
      // The guidance the caller acts on travels on the envelope, not only in
      // the human line.
      expect(reported.message).toBe(message);
      expect(process.exitCode).toBe(1);
    },
  );

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
    expect(sentryMocks.captureException).toHaveBeenCalledWith(err, {
      extra: { repeatsSinceLastReport: 0 },
    });
    expect(sentryMocks.addBreadcrumb).not.toHaveBeenCalled();
  });

  it("captures a plain Error, which classifies as UNEXPECTED", async () => {
    const err = new Error("boom");

    await runThrowing(err);

    expect(sentryMocks.captureException).toHaveBeenCalledWith(err, {
      extra: { repeatsSinceLastReport: 0 },
    });
    expect((terminalEnvelope()?.error as Record<string, unknown>).code).toBe(
      "E_UNEXPECTED",
    );
  });

  it("captures a non-Error throw", async () => {
    await runThrowing("just a string");

    expect(sentryMocks.captureException).toHaveBeenCalledWith("just a string", {
      extra: { repeatsSinceLastReport: 0 },
    });
    expect((terminalEnvelope()?.error as Record<string, unknown>).code).toBe(
      "E_UNEXPECTED",
    );
  });

  it("does not capture, and does not consult the repeat gate, when there is no live Sentry client", async () => {
    const { CLI_ERROR_CODES, CliError } = await import("../errors");
    sentryMocks.getClient.mockReturnValue(undefined);
    const err = new CliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
      message: "extract failed",
      details: null,
      exitCode: 1,
    });

    await runThrowing(err);

    expect(repeatGateMocks.recordCliFailureForSentry).not.toHaveBeenCalled();
    expect(sentryMocks.captureException).not.toHaveBeenCalled();
    expect(sentryMocks.addBreadcrumb).not.toHaveBeenCalled();
  });

  it("leaves a repeat breadcrumb instead of capturing when the gate says suppress", async () => {
    const { CLI_ERROR_CODES, CliError } = await import("../errors");
    repeatGateMocks.recordCliFailureForSentry.mockResolvedValue({
      kind: "suppress",
      repeatsInWindow: 4,
    });
    const err = new CliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
      message: "extract failed",
      details: null,
      exitCode: 1,
    });

    await runThrowing(err);

    expect(sentryMocks.captureException).not.toHaveBeenCalled();
    expect(sentryMocks.addBreadcrumb).toHaveBeenCalledTimes(1);
    const crumb = sentryMocks.addBreadcrumb.mock.calls[0][0] as Breadcrumb;
    expect(crumb.category).toBe("cli");
    expect(crumb.message).toBe(
      "CLI command failure repeated inside the report window",
    );
    expect(crumb.data.code).toBe("E_HOST_INSTALL_FAILED");
    expect(crumb.data.repeatsInWindow).toBe(4);
  });

  it("captures with the gate's repeatsSinceLastReport count when the gate says report", async () => {
    const { CLI_ERROR_CODES, CliError } = await import("../errors");
    repeatGateMocks.recordCliFailureForSentry.mockResolvedValue({
      kind: "report",
      repeatsSinceLastReport: 3,
    });
    const err = new CliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
      message: "extract failed",
      details: null,
      exitCode: 1,
    });

    await runThrowing(err);

    expect(sentryMocks.captureException).toHaveBeenCalledWith(err, {
      extra: { repeatsSinceLastReport: 3 },
    });
    expect(sentryMocks.addBreadcrumb).not.toHaveBeenCalled();
  });

  it("never consults the repeat gate for an expected code", async () => {
    const { CLI_ERROR_CODES, CliError } = await import("../errors");

    await runThrowing(
      new CliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "host is busy",
        details: null,
        exitCode: 1,
      }),
    );

    expect(repeatGateMocks.recordCliFailureForSentry).not.toHaveBeenCalled();
  });

  it("calls the gate with exactly (runtime.environment, the real cliSentryRepeatKey, defaultRepeatGateIo)", async () => {
    const { CLI_ERROR_CODES, CliError } = await import("../errors");
    const err = new CliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
      message: "extract failed",
      details: null,
      exitCode: 1,
    });

    await runThrowing(err);

    expect(repeatGateMocks.recordCliFailureForSentry).toHaveBeenCalledTimes(1);
    expect(repeatGateMocks.recordCliFailureForSentry).toHaveBeenCalledWith(
      config.environment,
      cliSentryRepeatKey(err.code, err, err.message),
      defaultRepeatGateIo,
    );
  });

  // This pins only the NDJSON envelope's order relative to the gate.
  // `runtime.logger.error("CLI command failed", ...)` cannot be pinned the
  // same way without mocking a production module: `createCliLogger`
  // (../logger.ts) writes error lines through `appendFileSync` to a log
  // file, not to stdout/stderr, so nothing this suite already spies on
  // observes it - and this suite deliberately mocks only `@sentry/node` and
  // `../sentry-repeat-gate`, not `../logger` or `node:fs`.
  it("emits the error envelope before consulting the repeat gate", async () => {
    const { CLI_ERROR_CODES, CliError } = await import("../errors");
    const err = new CliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
      message: "extract failed",
      details: null,
      exitCode: 1,
    });

    await runThrowing(err);

    // `stdoutChunks` is populated, in call order, by the SAME spy whose
    // `invocationCallOrder` this compares against - so this index locates
    // the exact stdout.write call that carried the error envelope.
    const errorEnvelopeCallIndex = stdoutChunks.findIndex((chunk) =>
      chunk.includes('"status":"error"'),
    );
    expect(errorEnvelopeCallIndex).toBeGreaterThanOrEqual(0);
    const errorEnvelopeCallOrder =
      stdoutWriteSpy.mock.invocationCallOrder[errorEnvelopeCallIndex];
    const gateCallOrder =
      repeatGateMocks.recordCliFailureForSentry.mock.invocationCallOrder[0];

    expect(errorEnvelopeCallOrder).toBeLessThan(gateCallOrder);
  });
});

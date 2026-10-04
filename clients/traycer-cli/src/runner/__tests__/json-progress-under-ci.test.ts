import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Ruling under test: in `--json` mode NDJSON progress events are emitted even
// when CI or TRAYCER_NONINTERACTIVE is set (Desktop's idle timer is fed by
// them). An explicit `--no-progress` still suppresses, human mode under CI
// stays suppressed, and `nonInteractive` itself is unchanged.

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

const PROGRESS_MESSAGE = "json-progress-under-ci-marker";
const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];

let priorExitCode: number | string | null | undefined;
let priorCi: string | undefined;
let priorNonInteractive: string | undefined;

beforeEach(() => {
  priorExitCode = process.exitCode;
  process.exitCode = undefined;
  priorCi = process.env.CI;
  priorNonInteractive = process.env.TRAYCER_NONINTERACTIVE;
  delete process.env.CI;
  delete process.env.TRAYCER_NONINTERACTIVE;
  stdoutChunks.length = 0;
  stderrChunks.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
    callback: (() => void) | undefined,
  ) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    if (callback !== undefined) callback();
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
    callback: (() => void) | undefined,
  ) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    if (callback !== undefined) callback();
    return true;
  }) as never);
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = priorExitCode;
  if (priorCi === undefined) delete process.env.CI;
  else process.env.CI = priorCi;
  if (priorNonInteractive === undefined)
    delete process.env.TRAYCER_NONINTERACTIVE;
  else process.env.TRAYCER_NONINTERACTIVE = priorNonInteractive;
});

interface Line {
  readonly type: string;
}

function ndjsonLines(): Line[] {
  const lines: Line[] = [];
  for (const raw of stdoutChunks.join("").split("\n")) {
    if (raw.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "type" in parsed &&
        typeof parsed.type === "string"
      ) {
        lines.push({ type: parsed.type });
      }
    } catch {
      continue;
    }
  }
  return lines;
}

async function runProgressOnce(flags: {
  json: boolean;
  quiet: boolean | null;
  noProgress: boolean | null;
  noBootstrap: boolean | null;
}): Promise<void> {
  const { runCommand } = await import("../runner");
  await runCommand(async (ctx) => {
    ctx.progress({
      stage: "x",
      message: PROGRESS_MESSAGE,
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
    });
    return { data: { ok: true }, human: null, exitCode: 0 };
  }, flags);
}

function types(): string[] {
  return ndjsonLines().map((line) => line.type);
}

describe("--json progress under CI / non-interactive", () => {
  it("(j1) CI=1 with --json still emits exactly one progress line, then the result", async () => {
    process.env.CI = "1";
    await runProgressOnce({
      json: true,
      quiet: null,
      noProgress: null,
      noBootstrap: null,
    });
    expect(types()).toEqual(["progress", "result"]);
  });

  it("(j2) TRAYCER_NONINTERACTIVE=1 with --json still emits exactly one progress line, then the result", async () => {
    process.env.TRAYCER_NONINTERACTIVE = "1";
    await runProgressOnce({
      json: true,
      quiet: null,
      noProgress: null,
      noBootstrap: null,
    });
    expect(types()).toEqual(["progress", "result"]);
  });

  it("(j3 control) CI=1 with --json --no-progress emits no progress line", async () => {
    process.env.CI = "1";
    await runProgressOnce({
      json: true,
      quiet: null,
      noProgress: true,
      noBootstrap: null,
    });
    expect(types()).toEqual(["result"]);
  });

  it("(j4 control) CI=1 in human mode writes no progress to stderr", async () => {
    process.env.CI = "1";
    await runProgressOnce({
      json: false,
      quiet: null,
      noProgress: null,
      noBootstrap: null,
    });
    expect(stderrChunks.join("")).not.toContain(PROGRESS_MESSAGE);
    expect(types()).not.toContain("progress");
  });

  it("(j5 control) CI=1 still resolves nonInteractive true", async () => {
    process.env.CI = "1";
    const { resolveRuntimeContext, readonlyEnv } = await import("../runtime");
    const runtime = resolveRuntimeContext(
      { json: true, quiet: null, noProgress: null, noBootstrap: null },
      readonlyEnv(),
    );
    expect(runtime.nonInteractive).toBe(true);
  });
});

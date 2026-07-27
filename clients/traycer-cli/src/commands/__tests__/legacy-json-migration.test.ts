import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

// Native Packaging legacy-JSON migration
// (ticket:e86b8372-…/a9fa5e4c-…). The previously plain-JSON commands -
// whoami, config shell get, config env list, config env get - now go
// through the shared NDJSON runner. The contract is:
//
//   1. JSON mode emits exactly one terminal `result` event on stdout
//      (no free-form text, no `console.log` shapes).
//   2. The terminal event carries either `status: "ok"` + `data` or
//      `status: "error"` + `error.{code, message, details}`.
//   3. The runner owns process.exit - command bodies must not call
//      process.exit themselves.
//
// We invoke `runCommand(...)` directly so the test boundary matches
// what the entry-point wires up via `withRunner`, capturing stdout
// to assert the envelope shape.

// `store/paths` binds its home root from `os.homedir()` at module load.
// Keep the environment mutation below, but redirect `homedir()` too.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;
let exitSpy: MockInstance;
let stdoutSpy: MockInstance;
let stderrSpy: MockInstance;
let stdoutChunks: string[];
let stderrChunks: string[];

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-legacy-json-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  stdoutChunks = [];
  stderrChunks = [];
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as never);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as never);
  // The runner owns process.exit - translate to a throw so the test
  // can `await` the call and then inspect captured stdout.
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code: number | undefined,
  ) => {
    throw new Error(`__test_exit_${code ?? 0}`);
  }) as never);
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_USERPROFILE === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  }
  rmSync(workHome, { recursive: true, force: true });
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  exitSpy.mockRestore();
  vi.restoreAllMocks();
  vi.doUnmock("../../auth/validate");
});

interface ParsedRunnerOutput {
  readonly stdoutLines: readonly string[];
  readonly envelopes: ReadonlyArray<Record<string, unknown>>;
  readonly terminal: Record<string, unknown> | null;
  readonly exitCode: number;
}

function joined(chunks: readonly string[]): string {
  return chunks.join("");
}

async function runAndCapture(
  fn: () => Promise<void>,
): Promise<ParsedRunnerOutput> {
  let exitCode = 0;
  try {
    await fn();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("__test_exit_")) {
      exitCode = Number.parseInt(err.message.replace("__test_exit_", ""), 10);
    } else {
      throw err;
    }
  }
  const stdout = joined(stdoutChunks);
  const stdoutLines = stdout.split("\n").filter((l) => l.length > 0);
  const envelopes: Record<string, unknown>[] = [];
  for (const line of stdoutLines) {
    // Be tolerant of human-mode runs that intentionally emit free-form
    // text; the JSON-mode assertions below explicitly require every
    // line to be JSON, so a runtime parse error there means a real
    // contract violation, not a test wiring issue.
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed !== null && typeof parsed === "object") {
      envelopes.push(parsed as Record<string, unknown>);
    }
  }
  let terminal: Record<string, unknown> | null = null;
  for (const env of envelopes) {
    if (env.type === "result") terminal = env;
  }
  return { stdoutLines, envelopes, terminal, exitCode };
}

async function runJsonCommand(
  fn: import("../../runner/runner").CommandFn,
): Promise<ParsedRunnerOutput> {
  const { runCommand } = await import("../../runner/runner");
  return runAndCapture(async () => {
    await runCommand(fn, {
      json: true,
      quiet: null,
      noProgress: null,
      noBootstrap: null,
    });
  });
}

async function runHumanCommand(
  fn: import("../../runner/runner").CommandFn,
): Promise<ParsedRunnerOutput> {
  const { runCommand } = await import("../../runner/runner");
  return runAndCapture(async () => {
    await runCommand(fn, {
      json: null,
      quiet: null,
      noProgress: null,
      noBootstrap: null,
    });
  });
}

function assertSingleTerminalResult(out: ParsedRunnerOutput): void {
  const resultIndices: number[] = [];
  out.envelopes.forEach((env, idx) => {
    if (env.type === "result") resultIndices.push(idx);
  });
  expect(
    resultIndices.length,
    `expected exactly one terminal 'result' event, got ${resultIndices.length}`,
  ).toBe(1);
  // The terminal event must be the LAST stdout line - downstream
  // parsers stop reading once they see it.
  expect(resultIndices[0]).toBe(out.envelopes.length - 1);
}

describe("whoami runner migration", () => {
  it("emits a single ok result envelope with the user payload when credentials are valid", async () => {
    vi.doMock("../../auth/validate", () => ({
      validateStoredCredentials: async () => ({
        kind: "valid",
        credentials: {
          token: "tok",
          authnBaseUrl: "https://authn.example.com",
          savedAt: "2026-05-15T00:00:00Z",
          user: { id: "u1", email: "user@example.com", name: "User One" },
        },
      }),
    }));
    const { whoamiCommand } = await import("../whoami");
    const out = await runJsonCommand(whoamiCommand);
    assertSingleTerminalResult(out);
    expect(out.exitCode).toBe(0);
    expect(out.terminal).toMatchObject({
      type: "result",
      status: "ok",
      data: {
        status: "valid",
        user: { id: "u1", email: "user@example.com", name: "User One" },
        authnBaseUrl: "https://authn.example.com",
      },
    });
    // No free-form stdout other than NDJSON.
    for (const line of out.stdoutLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("emits a single ok result with status='no-credentials' and exits 1 when not signed in", async () => {
    vi.doMock("../../auth/validate", () => ({
      validateStoredCredentials: async () => ({ kind: "no-credentials" }),
    }));
    const { whoamiCommand } = await import("../whoami");
    const out = await runJsonCommand(whoamiCommand);
    assertSingleTerminalResult(out);
    expect(out.exitCode).toBe(1);
    expect(out.terminal).toMatchObject({
      type: "result",
      status: "ok",
      data: { status: "no-credentials" },
    });
  });

  it("emits a single ok result with status='rejected' and exits 1 when the token was rejected", async () => {
    vi.doMock("../../auth/validate", () => ({
      validateStoredCredentials: async () => ({ kind: "rejected" }),
    }));
    const { whoamiCommand } = await import("../whoami");
    const out = await runJsonCommand(whoamiCommand);
    assertSingleTerminalResult(out);
    expect(out.exitCode).toBe(1);
    expect(out.terminal).toMatchObject({
      status: "ok",
      data: { status: "rejected" },
    });
  });

  it("emits a single error envelope with code=E_AUTH_NETWORK and exits 2 on a network failure", async () => {
    vi.doMock("../../auth/validate", () => ({
      validateStoredCredentials: async () => ({ kind: "network-error" }),
    }));
    const { whoamiCommand } = await import("../whoami");
    const out = await runJsonCommand(whoamiCommand);
    assertSingleTerminalResult(out);
    expect(out.exitCode).toBe(2);
    const terminal = out.terminal;
    expect(terminal).toMatchObject({
      type: "result",
      status: "error",
    });
    expect((terminal?.error as Record<string, unknown>)?.code).toBe(
      "E_AUTH_NETWORK",
    );
  });

  it("emits only the human line on stdout when JSON mode is off", async () => {
    vi.doMock("../../auth/validate", () => ({
      validateStoredCredentials: async () => ({
        kind: "valid",
        credentials: {
          token: "tok",
          authnBaseUrl: "https://authn.example.com",
          savedAt: "2026-05-15T00:00:00Z",
          user: { id: "u1", email: "user@example.com", name: "User One" },
        },
      }),
    }));
    const { whoamiCommand } = await import("../whoami");
    const out = await runHumanCommand(whoamiCommand);
    // No NDJSON envelopes leak into human mode.
    expect(out.terminal).toBeNull();
    expect(joined(stdoutChunks)).toContain("Logged in as user@example.com.");
    expect(out.exitCode).toBe(0);
  });
});

function seedEnvOverrides(overrides: Readonly<Record<string, string>>): void {
  const cliDir = join(workHome, ".traycer", "cli");
  mkdirSync(cliDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(cliDir, "config.json"),
    JSON.stringify({
      version: 1,
      shell: { path: null, args: null },
      envOverrides: overrides,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
}

function seedShellConfig(
  path: string | null,
  args: readonly string[] | null,
): void {
  const cliDir = join(workHome, ".traycer", "cli");
  mkdirSync(cliDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(cliDir, "config.json"),
    JSON.stringify({
      version: 1,
      shell: { path, args },
      envOverrides: {},
    }),
    { encoding: "utf8", mode: 0o600 },
  );
}

describe("config env list runner migration", () => {
  it("emits a single ok result with a sorted array of overrides", async () => {
    seedEnvOverrides({ B_KEY: "two", A_KEY: "one" });
    const { configEnvListCommand } = await import("../config-env-list");
    const out = await runJsonCommand(configEnvListCommand);
    assertSingleTerminalResult(out);
    expect(out.exitCode).toBe(0);
    expect(out.terminal).toMatchObject({
      status: "ok",
      data: [
        { key: "A_KEY", value: "one" },
        { key: "B_KEY", value: "two" },
      ],
    });
  });

  it("emits a single ok result with an empty array when no overrides are stored", async () => {
    const { configEnvListCommand } = await import("../config-env-list");
    const out = await runJsonCommand(configEnvListCommand);
    assertSingleTerminalResult(out);
    expect(out.terminal).toMatchObject({
      status: "ok",
      data: [],
    });
  });
});

describe("config env get runner migration", () => {
  it("emits ok with the key/value pair when present", async () => {
    seedEnvOverrides({ FOO: "bar" });
    const { buildConfigEnvGetCommand } = await import("../config-env-get");
    const out = await runJsonCommand(buildConfigEnvGetCommand({ key: "FOO" }));
    assertSingleTerminalResult(out);
    expect(out.terminal).toMatchObject({
      status: "ok",
      data: { key: "FOO", value: "bar" },
    });
    expect(out.exitCode).toBe(0);
  });

  it("emits a CONFIG_MISSING_KEY error envelope when the key is unset", async () => {
    seedEnvOverrides({});
    const { buildConfigEnvGetCommand } = await import("../config-env-get");
    const out = await runJsonCommand(
      buildConfigEnvGetCommand({ key: "MISSING" }),
    );
    assertSingleTerminalResult(out);
    expect(out.terminal).toMatchObject({ status: "error" });
    expect((out.terminal?.error as Record<string, unknown>).code).toBe(
      "E_CONFIG_MISSING_KEY",
    );
    expect((out.terminal?.error as Record<string, unknown>).details).toEqual({
      key: "MISSING",
    });
    expect(out.exitCode).toBe(1);
  });
});

describe("config shell get runner migration", () => {
  it("emits ok with the effective shell config and `synthesised: false` when stored", async () => {
    seedShellConfig("/bin/zsh", ["-i", "-l"]);
    const { configShellGetCommand } = await import("../config-shell-get");
    const out = await runJsonCommand(configShellGetCommand);
    assertSingleTerminalResult(out);
    expect(out.terminal).toMatchObject({
      status: "ok",
      data: {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: false,
      },
    });
  });

  it("emits ok with `synthesised: true` when neither path nor args is stored", async () => {
    const { configShellGetCommand } = await import("../config-shell-get");
    const out = await runJsonCommand(configShellGetCommand);
    assertSingleTerminalResult(out);
    const data = out.terminal?.data as Record<string, unknown>;
    expect(data.synthesised).toBe(true);
    // Defaults are platform-specific - assert shape rather than literals.
    expect(typeof data.path).toBe("string");
    expect(Array.isArray(data.args)).toBe(true);
  });
});

describe("cli mark-source upgrade-lockout prevention", () => {
  // The split between PM-only `cli mark-source` and user-facing
  // `cli re-anchor` exists to prevent a footgun: passing `--source
  // homebrew` on a manually installed binary would route every
  // future `cli upgrade` through `brew upgrade traycer`, which
  // doesn't know about the install. The test asserts the rejection so
  // a future refactor that re-introduces `manual` here regresses
  // loudly instead of silently.
  it("rejects --source manual with E_INVALID_ARGUMENT and surfaces the re-anchor hint", async () => {
    const { buildCliMarkSourceCommand } = await import("../cli-mark-source");
    const cmd = buildCliMarkSourceCommand({
      source: "manual",
      binaryPath: "/usr/local/bin/traycer",
      version: "1.0.0",
    });
    const out = await runJsonCommand(cmd);
    assertSingleTerminalResult(out);
    expect(out.terminal).toMatchObject({ status: "error" });
    const error = out.terminal?.error as Record<string, unknown>;
    expect(error.code).toBe("E_INVALID_ARGUMENT");
    expect(String(error.message)).toContain("cli re-anchor");
    expect(out.exitCode).toBe(1);
  });

  it("rejects an unknown source with E_INVALID_ARGUMENT", async () => {
    const { buildCliMarkSourceCommand } = await import("../cli-mark-source");
    const cmd = buildCliMarkSourceCommand({
      source: "snap",
      binaryPath: "/usr/local/bin/traycer",
      version: "1.0.0",
    });
    const out = await runJsonCommand(cmd);
    assertSingleTerminalResult(out);
    expect(out.terminal).toMatchObject({ status: "error" });
    expect((out.terminal?.error as Record<string, unknown>).code).toBe(
      "E_INVALID_ARGUMENT",
    );
  });
});

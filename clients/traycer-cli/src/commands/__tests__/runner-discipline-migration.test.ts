import { mkdtempSync, rmSync } from "node:fs";
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

// Native Packaging runner-discipline migration: every runner-aware
// command (logout, config env set/delete, config shell set/reset,
// cli re-anchor, host uninstall) must emit exactly one terminal
// `result` event in JSON mode and route errors through `cliError(...)`
// with a stable machine-readable code. The runner - not the command -
// owns process.exit and the NDJSON envelope.
//
// This file pins the behaviour of the commands the legacy-JSON
// migration ticket added/touched. It mirrors the harness shape of
// `legacy-json-migration.test.ts` so future drift in the runner
// contract surfaces in the same way across the suite.

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
  workHome = mkdtempSync(join(tmpdir(), "traycer-runner-disc-test-"));
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
  expect(resultIndices[0]).toBe(out.envelopes.length - 1);
}

// ----------------------------- logoutCommand ----------------------------

describe("logoutCommand runner contract", () => {
  it("JSON mode: emits a single ok result with loggedOut=true when credentials were removed", async () => {
    vi.doMock("../../store/credentials", () => ({
      deleteCredentials: async () => true,
    }));
    const { logoutCommand } = await import("../logout");
    const out = await runJsonCommand(logoutCommand);
    assertSingleTerminalResult(out);
    expect(out.exitCode).toBe(0);
    expect(out.terminal).toMatchObject({
      type: "result",
      status: "ok",
      data: { loggedOut: true },
    });
  });

  it("JSON mode: emits a single ok result with loggedOut=false when nothing was on disk", async () => {
    vi.doMock("../../store/credentials", () => ({
      deleteCredentials: async () => false,
    }));
    const { logoutCommand } = await import("../logout");
    const out = await runJsonCommand(logoutCommand);
    assertSingleTerminalResult(out);
    expect(out.exitCode).toBe(0);
    expect(out.terminal).toMatchObject({
      status: "ok",
      data: { loggedOut: false },
    });
  });

  it("human mode: prints 'Logged out.' when credentials were removed", async () => {
    vi.doMock("../../store/credentials", () => ({
      deleteCredentials: async () => true,
    }));
    const { logoutCommand } = await import("../logout");
    const out = await runHumanCommand(logoutCommand);
    expect(out.terminal).toBeNull();
    expect(joined(stdoutChunks)).toContain("Logged out.");
    expect(out.exitCode).toBe(0);
  });

  it("human mode: prints 'Not logged in.' when nothing was on disk", async () => {
    vi.doMock("../../store/credentials", () => ({
      deleteCredentials: async () => false,
    }));
    const { logoutCommand } = await import("../logout");
    const out = await runHumanCommand(logoutCommand);
    expect(out.terminal).toBeNull();
    expect(joined(stdoutChunks)).toContain("Not logged in.");
    expect(out.exitCode).toBe(0);
  });
});

// ----------------------- buildConfigEnvSetCommand -----------------------

describe("buildConfigEnvSetCommand validation", () => {
  it("emits a single CONFIG_INVALID_VALUE error envelope when the key fails the regex", async () => {
    const { buildConfigEnvSetCommand } = await import("../config-env-set");
    const cmd = buildConfigEnvSetCommand({
      key: "1BAD-KEY",
      value: "x",
    });
    const out = await runJsonCommand(cmd);
    assertSingleTerminalResult(out);
    expect(out.terminal).toMatchObject({ status: "error" });
    const error = out.terminal?.error as Record<string, unknown>;
    expect(error.code).toBe("E_CONFIG_INVALID_VALUE");
    expect(String(error.message)).toContain("invalid key");
    expect(out.exitCode).toBe(1);
  });

  it("accepts a valid key and emits ok with the (key, value) payload", async () => {
    const { buildConfigEnvSetCommand } = await import("../config-env-set");
    const cmd = buildConfigEnvSetCommand({
      key: "GOOD_KEY",
      value: "hello",
    });
    const out = await runJsonCommand(cmd);
    assertSingleTerminalResult(out);
    expect(out.terminal).toMatchObject({
      status: "ok",
      data: { key: "GOOD_KEY", value: "hello" },
    });
    expect(out.exitCode).toBe(0);
  });
});

// ---------------------- buildConfigEnvUnsetCommand ----------------------

describe("buildConfigEnvUnsetCommand", () => {
  it("accepts a valid key and emits ok with a null value payload", async () => {
    const { buildConfigEnvUnsetCommand } = await import("../config-env-unset");
    const cmd = buildConfigEnvUnsetCommand({
      key: "OPENAI_API_KEY",
    });
    const out = await runJsonCommand(cmd);
    assertSingleTerminalResult(out);
    expect(out.terminal).toMatchObject({
      status: "ok",
      data: { key: "OPENAI_API_KEY", value: null },
    });
    expect(out.exitCode).toBe(0);
  });
});

// --------------------- buildConfigEnvDeleteCommand ---------------------

describe("buildConfigEnvDeleteCommand missing-key surface", () => {
  it("emits CONFIG_MISSING_KEY when the override doesn't exist", async () => {
    const { buildConfigEnvDeleteCommand } =
      await import("../config-env-delete");
    const cmd = buildConfigEnvDeleteCommand({
      key: "NOT_PRESENT",
    });
    const out = await runJsonCommand(cmd);
    assertSingleTerminalResult(out);
    expect(out.terminal).toMatchObject({ status: "error" });
    const error = out.terminal?.error as Record<string, unknown>;
    expect(error.code).toBe("E_CONFIG_MISSING_KEY");
    expect(error.details).toEqual({ key: "NOT_PRESENT" });
    expect(out.exitCode).toBe(1);
  });
});

// ---------------------- buildConfigShellSetCommand ---------------------

describe("buildConfigShellSetCommand conflict-detection", () => {
  // The actual `--clear-args` vs positional-args conflict is enforced in
  // the entrypoint wrapper (see index.ts); the command body itself
  // refuses an all-null call so a future re-route still routes through
  // a CONFIG_INVALID_VALUE rather than a silent no-op. Both surfaces
  // share the same error code, so a refactor that pushes the check up
  // OR down keeps the contract stable.
  it("rejects path=null + args=null with CONFIG_INVALID_VALUE", async () => {
    const { buildConfigShellSetCommand } = await import("../config-shell-set");
    const cmd = buildConfigShellSetCommand({ path: null, args: null });
    const out = await runJsonCommand(cmd);
    assertSingleTerminalResult(out);
    expect(out.terminal).toMatchObject({ status: "error" });
    const error = out.terminal?.error as Record<string, unknown>;
    expect(error.code).toBe("E_CONFIG_INVALID_VALUE");
    expect(String(error.message)).toContain("--clear-args");
    expect(out.exitCode).toBe(1);
  });

  it("entrypoint: --clear-args combined with positional args is rejected via CONFIG_INVALID_VALUE", async () => {
    // The wrapper in index.ts owns the conflict check. We exercise it
    // through the live commander tree to keep this test honest about
    // what the user actually sees on the wire.
    const { buildProgram } = await import("../../index");
    const program = buildProgram();
    program.exitOverride();
    try {
      await program.parseAsync(
        ["config", "shell", "set", "--json", "--clear-args", "--", "-i"],
        { from: "user" },
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("__test_exit_")) {
        // expected - the runner reached process.exit(1)
      } else {
        throw err;
      }
    }
    const ndjson = joined(stdoutChunks)
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((v): v is Record<string, unknown> => v !== null);
    const terminal = ndjson[ndjson.length - 1];
    expect(terminal).toMatchObject({ type: "result", status: "error" });
    expect((terminal?.error as Record<string, unknown>).code).toBe(
      "E_CONFIG_INVALID_VALUE",
    );
    expect(
      String((terminal?.error as Record<string, unknown>).message),
    ).toContain("--clear-args");
  });
});

// ---------------------- configShellResetCommand -----------------------

describe("configShellResetCommand happy path", () => {
  it("emits a single ok result and exits 0", async () => {
    const { configShellResetCommand } = await import("../config-shell-reset");
    const out = await runJsonCommand(configShellResetCommand);
    assertSingleTerminalResult(out);
    expect(out.terminal).toMatchObject({
      status: "ok",
      data: { reset: true },
    });
    expect(out.exitCode).toBe(0);
  });
});

// ----------------------- buildCliReAnchorCommand ----------------------

describe("buildCliReAnchorCommand happy-path manual re-anchor", () => {
  it("writes a manifest with source='manual' under the per-environment CLI lock", async () => {
    // Stage a real binary file the writeMarkSource pathway can stat.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const cliDir = join(workHome, ".traycer", "cli");
    mkdirSync(cliDir, { recursive: true, mode: 0o700 });
    const binaryPath = join(workHome, "traycer-bin");
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    // Point the readCliManifest system-marker probe at an empty tmp dir
    // so a Linux CI host with /var/lib/traycer/source.apt present
    // doesn't inject a fake "apt" prior-state into the test.
    const markerSandbox = mkdtempSync(join(tmpdir(), "traycer-marker-sb-"));
    const { __setSystemSourceMarkerDirForTest } =
      await import("../../manifest/cli-manifest");
    const previousMarkerDir = __setSystemSourceMarkerDirForTest(markerSandbox);

    const { buildCliReAnchorCommand } = await import("../cli-re-anchor");
    const cmd = buildCliReAnchorCommand({
      binaryPath,
      version: "1.2.3",
    });
    const out = await runJsonCommand(cmd);
    __setSystemSourceMarkerDirForTest(previousMarkerDir);
    rmSync(markerSandbox, { recursive: true, force: true });
    assertSingleTerminalResult(out);
    expect(out.terminal).toMatchObject({ status: "ok" });
    const data = out.terminal?.data as Record<string, unknown>;
    const current = data.current as Record<string, unknown>;
    expect(current.source).toBe("manual");
    expect(current.version).toBe("1.2.3");
    expect(current.binaryPath).toBe(binaryPath);
    expect(out.exitCode).toBe(0);
  });

  it("rejects a missing binary path with E_INVALID_ARGUMENT", async () => {
    const { buildCliReAnchorCommand } = await import("../cli-re-anchor");
    const cmd = buildCliReAnchorCommand({
      binaryPath: join(workHome, "does-not-exist"),
      version: "1.0.0",
    });
    const out = await runJsonCommand(cmd);
    assertSingleTerminalResult(out);
    expect(out.terminal).toMatchObject({ status: "error" });
    expect((out.terminal?.error as Record<string, unknown>).code).toBe(
      "E_INVALID_ARGUMENT",
    );
    expect(out.exitCode).toBe(1);
  });
});

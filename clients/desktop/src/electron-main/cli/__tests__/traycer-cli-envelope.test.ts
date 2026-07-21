import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Native-packaging follow-up bug: previously the Desktop CLI bridge
// passed `runTraycerCliJson`'s parsed-JSON return straight to the
// host-management projector functions, but the shared runner in
// `traycer-cli/src/runner/output.ts` wraps every terminal payload in a
// `{ type: "result", status: "ok", data: ... }` envelope (with an
// `{ type: "result", status: "error", error: { code, message, details } }`
// shape on failure). The renderer's Doctor card therefore read
// envelope keys instead of the issue list, and the Doctor
// `CLI_UPGRADE_PENDING` issue was unreachable from the Pending CLI
// Upgrade IPC projector.
//
// These tests pin the unwrap contract:
//   - successful envelopes resolve to the inner `data` payload
//   - the `CLI_UPGRADE_PENDING` issue code survives projection
//   - error envelopes reject with `TraycerCliError` carrying the
//     stable CLI error code, message, details, and stderr tail
//   - long-running streaming commands fan progress events and still
//     get JSON mode injected when the caller forgot `--json`

// `resolveTraycerCliInvocation` always runs through `discoverCli` +
// `resolveBundledCliPath`, regardless of packaging state. We satisfy
// the discovery chain by setting `TRAYCER_CLI_BUNDLED_BIN` to a known
// path - the actual binary isn't executed in this test (spawn is
// stubbed), so the path just needs to be on disk and executable.
vi.mock("electron", () => ({
  app: {
    getAppPath: (): string => "/tmp/traycer-test/desktop",
  },
}));

Object.defineProperty(process, "resourcesPath", {
  value: "/tmp/traycer-test/resources",
  configurable: true,
});

vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info" },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// `resolveTraycerCliInvocation` walks the real discovery chain (manifest →
// PATH → bundled), which depends on the host machine's filesystem +
// `isDevBuild`. Mock the discovery layer here so these tests pin the
// `runTraycerCli*` envelope/error contract without coupling to the dev
// CLI wrapper being staged at `~/.traycer/cli/dev/bin/traycer`. The
// returned path is never actually exec'd - `node:child_process` is
// stubbed below.
vi.mock("../cli-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli-discovery")>();
  return {
    ...actual,
    discoverCli: async () => ({
      kind: "bundled" as const,
      binaryPath: "/tmp/traycer-test/discovered-cli/traycer",
    }),
    resolveBundledCliPath: async () => "/tmp/traycer-test/bundled-cli/traycer",
  };
});

interface FakeChildOptions {
  readonly stdoutLines: readonly string[];
  readonly stderr: string;
  readonly exitCode: number;
}

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter() as EventEmitter & {
    setEncoding: (enc: string) => void;
  };
  readonly stderr = new EventEmitter() as EventEmitter & {
    setEncoding: (enc: string) => void;
  };
  killed = false;
  killSignal: NodeJS.Signals | null = null;
  constructor(opts: FakeChildOptions) {
    super();
    this.stdout.setEncoding = () => undefined;
    this.stderr.setEncoding = () => undefined;
    // Defer emissions so the helper has time to subscribe.
    queueMicrotask(() => {
      for (const line of opts.stdoutLines) {
        this.stdout.emit("data", `${line}\n`);
      }
      if (opts.stderr.length > 0) {
        this.stderr.emit("data", opts.stderr);
      }
      this.emit("close", opts.exitCode);
    });
  }
  kill(signal: NodeJS.Signals): void {
    this.killed = true;
    this.killSignal = signal;
  }

  close(exitCode: number | null): void {
    this.emit("close", exitCode);
  }
}

// Fixup C4: unlike `FakeChild`, never settles on its own - stands in for a
// subprocess still running a long download, so a test can assert `kill()`
// only happens once the caller's `AbortSignal` fires, not before.
class HangingFakeChild extends EventEmitter {
  readonly stdout = new EventEmitter() as EventEmitter & {
    setEncoding: (enc: string) => void;
  };
  readonly stderr = new EventEmitter() as EventEmitter & {
    setEncoding: (enc: string) => void;
  };
  killed = false;
  killSignal: NodeJS.Signals | null = null;
  constructor() {
    super();
    this.stdout.setEncoding = () => undefined;
    this.stderr.setEncoding = () => undefined;
  }
  kill(signal: NodeJS.Signals): void {
    this.killed = true;
    this.killSignal = signal;
  }

  close(exitCode: number | null): void {
    this.emit("close", exitCode);
  }
}

let spawnImpl:
  | ((cmd: string, args: readonly string[]) => FakeChild | HangingFakeChild)
  | null = null;
let execFileImpl:
  | ((
      cmd: string,
      args: readonly string[],
      opts: unknown,
      callback: (err: Error | null, stdout: string, stderr: string) => void,
    ) => void)
  | null = null;

vi.mock("node:child_process", () => {
  const spawn = (cmd: string, args: readonly string[]): FakeChild => {
    if (spawnImpl === null) {
      throw new Error("spawn not configured for this test");
    }
    return spawnImpl(cmd, args);
  };
  const execFile = (
    cmd: string,
    args: readonly string[],
    opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (execFileImpl === null) {
      throw new Error("execFile not configured for this test");
    }
    execFileImpl(cmd, args, opts, cb);
  };
  // Provide both ESM-style named exports and a default export so any
  // intermediate transformer that reads `default.spawn` (vite/esbuild
  // sometimes does this for CJS interop) still finds the stubs.
  return {
    spawn,
    execFile,
    default: { spawn, execFile },
  };
});

beforeEach(() => {
  spawnImpl = null;
  execFileImpl = null;
  vi.resetModules();
});

afterEach(() => {
  spawnImpl = null;
  execFileImpl = null;
});

interface ExecFileSetupArgs {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function configureExecFile(args: ExecFileSetupArgs): {
  readonly capturedArgs: readonly string[][];
  readonly capturedCommands: readonly string[];
} {
  const capturedArgs: string[][] = [];
  const capturedCommands: string[] = [];
  execFileImpl = (cmd, calledArgs, _opts, callback) => {
    capturedCommands.push(cmd);
    capturedArgs.push([...calledArgs]);
    if (args.exitCode === 0) {
      callback(null, args.stdout, args.stderr);
      return;
    }
    // execFile decorates its callback Error with stdout/stderr buffers
    // and a numeric exit code in `code`. The @types/node ErrnoException
    // types `code` as `string`, but at runtime non-zero exits assign a
    // number - the wrapper's `toNumberOrNull(err.code)` covers that
    // case. We attach the fields via a typed extension on Error.
    class ExecFileError extends Error {
      stdout = "";
      stderr = "";
      code: string | number | null = null;
    }
    const err = new ExecFileError(`exited with code ${args.exitCode}`);
    err.stdout = args.stdout;
    err.stderr = args.stderr;
    err.code = args.exitCode;
    callback(err, args.stdout, args.stderr);
  };
  return { capturedArgs, capturedCommands };
}

describe("runTraycerCliJson unwraps result envelopes", () => {
  it("returns the inner data payload from {type:result, status:ok} envelopes", async () => {
    const doctorIssues = [
      {
        code: "CLI_UPGRADE_PENDING",
        severity: "warning",
        title: "CLI upgrade staged",
        message: "Restart the host to finalise the swap.",
        fixAction: "host-restart",
        terminalCommand: "traycer host restart",
        details: { stagedBinaryPath: "/tmp/x" },
      },
    ];
    const envelope = {
      type: "result",
      status: "ok",
      data: { issues: doctorIssues },
      timestamp: "2026-05-15T00:00:00Z",
    };
    configureExecFile({
      stdout: `${JSON.stringify(envelope)}\n`,
      stderr: "",
      exitCode: 0,
    });
    const { runTraycerCliJson } = await import("../traycer-cli");
    const result = await runTraycerCliJson<{ issues: typeof doctorIssues }>([
      "host",
      "doctor",
    ]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe("CLI_UPGRADE_PENDING");
    expect(result.issues[0]?.fixAction).toBe("host-restart");
  });

  it("appends --json when the caller forgot it", async () => {
    const envelope = {
      type: "result",
      status: "ok",
      data: { ok: true },
      timestamp: "2026-05-15T00:00:00Z",
    };
    const setup = configureExecFile({
      stdout: `${JSON.stringify(envelope)}\n`,
      stderr: "",
      exitCode: 0,
    });
    const { runTraycerCliJson } = await import("../traycer-cli");
    await runTraycerCliJson(["host", "uninstall"]);
    expect(setup.capturedArgs[0]).toContain("--json");
  });

  it("rejects with TraycerCliError carrying the CLI error code on {status:error} envelopes", async () => {
    const envelope = {
      type: "result",
      status: "error",
      error: {
        code: "E_CLI_UPGRADE_REPLACE_FAILED",
        message: "cli upgrade: replace failed: EBUSY",
        details: { livePath: "/usr/local/bin/traycer" },
      },
      timestamp: "2026-05-15T00:00:00Z",
    };
    configureExecFile({
      stdout: `${JSON.stringify(envelope)}\n`,
      stderr:
        "error: cli upgrade: replace failed [code=E_CLI_UPGRADE_REPLACE_FAILED]\n",
      exitCode: 1,
    });
    const { runTraycerCliJson, TraycerCliError } =
      await import("../traycer-cli");
    await expect(runTraycerCliJson(["cli", "upgrade"])).rejects.toMatchObject({
      code: "E_CLI_UPGRADE_REPLACE_FAILED",
      message: expect.stringContaining("replace failed"),
    });
    // Stable construction even on the error path - the stderr tail
    // makes it into the surfaced TraycerCliError instance.
    let thrown: unknown = null;
    try {
      await runTraycerCliJson(["cli", "upgrade"]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TraycerCliError);
  });

  it("extracts the error envelope even when execFile rejects with an Error that lacks .stdout/.stderr (Electron/Node decoration gap)", async () => {
    // Regression: the dev-wrapper / dev-mode invocation path was surfacing
    // "Command failed: <cmd>" toasts because the Error reaching
    // runTraycerCliJson's catch had no .stdout / .stderr attached, so
    // envelope extraction read empty strings and fell through to the
    // bare-error branch. The CLI's real `E_HOST_VERIFY_FAILED` message
    // never made it to the user. `runTraycerCli` now (re-)attaches both
    // buffers from the callback args before rejecting; this test pins
    // that contract by simulating a callback Error that arrives bare.
    const envelope = {
      type: "result",
      status: "error",
      error: {
        code: "E_HOST_VERIFY_FAILED",
        message:
          "host registry: no trusted signing keys are configured for this build, so host versions cannot be verified.",
        details: { sources: [], environment: "dev" },
      },
      timestamp: "2026-05-15T00:00:00Z",
    };
    const envelopeJson = `${JSON.stringify(envelope)}\n`;
    execFileImpl = (_cmd, _args, _opts, callback) => {
      // Pass stdout / stderr only as positional callback args - do NOT
      // decorate the Error with them, mirroring the Electron-Node
      // behaviour the dev-wrapper invocations were hitting.
      const bareErr = new Error("Command failed: /tmp/traycer ...");
      callback(bareErr, envelopeJson, "");
    };
    const { runTraycerCliJson, TraycerCliError } =
      await import("../traycer-cli");
    let thrown: unknown = null;
    try {
      await runTraycerCliJson(["host", "available"]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TraycerCliError);
    expect(thrown).toMatchObject({
      code: "E_HOST_VERIFY_FAILED",
      message: expect.stringContaining("no trusted signing keys"),
    });
  });

  it("ignores progress events before the terminal result line", async () => {
    // Fixup D2: a progress line trails the result line here, deliberately -
    // if the loop just took whatever line came last (rather than genuinely
    // skipping progress-typed events), it would wrongly select this
    // trailing progress event instead of the result. Positioning every
    // progress line before the result (the old fixture) made this
    // indistinguishable from "last line wins", since both implementations
    // would land on the same line.
    const lines = [
      JSON.stringify({
        type: "progress",
        stage: "download",
        percent: 25,
        bytes: 1000,
        totalBytes: 4000,
        message: "downloading",
        timestamp: "2026-05-15T00:00:00Z",
      }),
      JSON.stringify({
        type: "result",
        status: "ok",
        data: { final: true, version: "1.5.0" },
        timestamp: "2026-05-15T00:00:01Z",
      }),
      JSON.stringify({
        type: "progress",
        stage: "download",
        percent: 100,
        bytes: 4000,
        totalBytes: 4000,
        message: "finishing up",
        timestamp: "2026-05-15T00:00:02Z",
      }),
    ];
    configureExecFile({
      stdout: `${lines.join("\n")}\n`,
      stderr: "",
      exitCode: 0,
    });
    const { runTraycerCliJson } = await import("../traycer-cli");
    const result = await runTraycerCliJson<{ final: boolean; version: string }>(
      ["host", "available"],
    );
    expect(result.final).toBe(true);
    expect(result.version).toBe("1.5.0");
  });
});

describe("streamTraycerCliJson resolves data, fans progress, and converts error envelopes", () => {
  it("V10: bundled wrappers invoke the bundled CLI instead of the discovered CLI", async () => {
    const terminalLine = JSON.stringify({
      type: "result",
      status: "ok",
      data: { version: "1.5.0" },
      timestamp: "2026-05-15T00:00:00Z",
    });
    const runSetup = configureExecFile({
      stdout: `${terminalLine}\n`,
      stderr: "",
      exitCode: 0,
    });
    let streamCommand = "";
    spawnImpl = (cmd) => {
      streamCommand = cmd;
      return new FakeChild({
        stdoutLines: [terminalLine],
        stderr: "",
        exitCode: 0,
      });
    };
    const { runBundledTraycerCliJson, streamBundledTraycerCliJson } =
      await import("../traycer-cli");

    await runBundledTraycerCliJson<{ version: string }>(["host", "status"]);
    await streamBundledTraycerCliJson<{ version: string }>({
      args: ["host", "download", "--automatic"],
      onEvent: () => undefined,
      env: null,
      timeoutMs: 5_000,
      signal: null,
    });

    expect(runSetup.capturedCommands).toEqual([
      "/tmp/traycer-test/bundled-cli/traycer",
    ]);
    expect(streamCommand).toBe("/tmp/traycer-test/bundled-cli/traycer");
  });

  it("forces --json onto args and emits each progress event before resolving with unwrapped data", async () => {
    const lines = [
      JSON.stringify({
        type: "progress",
        stage: "stage-1",
        percent: 10,
        bytes: 100,
        totalBytes: 1000,
        message: "downloading",
        timestamp: "2026-05-15T00:00:00Z",
      }),
      JSON.stringify({
        type: "progress",
        stage: "stage-2",
        percent: 100,
        bytes: 1000,
        totalBytes: 1000,
        message: "extracting",
        timestamp: "2026-05-15T00:00:01Z",
      }),
      JSON.stringify({
        type: "result",
        status: "ok",
        data: { version: "1.5.0", installedAt: "2026-05-15T00:00:02Z" },
        timestamp: "2026-05-15T00:00:02Z",
      }),
    ];
    let capturedArgs: readonly string[] = [];
    spawnImpl = (_cmd, args) => {
      capturedArgs = [...args];
      return new FakeChild({ stdoutLines: lines, stderr: "", exitCode: 0 });
    };
    const { streamTraycerCliJson } = await import("../traycer-cli");
    const progressEvents: Array<{ stage: string; percent: number | null }> = [];
    const result = await streamTraycerCliJson<{ version: string }>({
      args: ["host", "install", "latest"],
      onEvent: (event) => {
        if (event.type === "progress") {
          progressEvents.push({ stage: event.stage, percent: event.percent });
        }
      },
      env: null,
      timeoutMs: 5_000,
      signal: null,
    });
    expect(capturedArgs).toContain("--json");
    expect(progressEvents).toEqual([
      { stage: "stage-1", percent: 10 },
      { stage: "stage-2", percent: 100 },
    ]);
    expect(result.data.version).toBe("1.5.0");
  });

  it("rejects with TraycerCliError when the CLI emits a {status:error} terminal envelope", async () => {
    const errorLine = JSON.stringify({
      type: "result",
      status: "error",
      error: {
        code: "E_HOST_INSTALL_FAILED",
        message: "verification failed",
        details: { checksum: "mismatch" },
      },
      timestamp: "2026-05-15T00:00:00Z",
    });
    spawnImpl = () =>
      new FakeChild({
        stdoutLines: [errorLine],
        stderr: "error: verification failed [code=E_HOST_INSTALL_FAILED]\n",
        exitCode: 1,
      });
    const { streamTraycerCliJson, TraycerCliError } =
      await import("../traycer-cli");
    let thrown: unknown = null;
    try {
      await streamTraycerCliJson<unknown>({
        args: ["host", "install", "latest", "--json"],
        onEvent: () => undefined,
        env: null,
        timeoutMs: 5_000,
        signal: null,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TraycerCliError);
    if (thrown instanceof TraycerCliError) {
      expect(thrown.code).toBe("E_HOST_INSTALL_FAILED");
      expect(thrown.message).toContain("verification failed");
    }
  });
});

// Fixup C4: `streamBundledTraycerCliJson`'s only cancellable caller
// (`runDownloadLane`'s `AbortController`) used to abort a signal nothing
// downstream ever read - the spawned subprocess ran to completion
// regardless, so `removeTraycer`'s "abort the in-flight download" claim was
// cosmetic. The subprocess must actually be killed the moment the signal
// fires, and the awaited call must reject rather than hang.
describe("streamTraycerCliJson kills the subprocess when its signal aborts", () => {
  it("kills the still-running child but waits for close before rejecting", async () => {
    const child = new HangingFakeChild();
    spawnImpl = () => child;
    const { streamTraycerCliJson } = await import("../traycer-cli");
    const abortController = new AbortController();

    const promise = streamTraycerCliJson<unknown>({
      args: ["host", "download", "--automatic"],
      onEvent: () => undefined,
      env: null,
      timeoutMs: 5_000,
      signal: abortController.signal,
    });

    // Wait for the real stream wrapper to spawn and subscribe before
    // asserting nothing has happened yet.
    await vi.waitFor(() => {
      expect(child.stdout.listenerCount("data")).toBeGreaterThan(0);
    });
    expect(child.killed).toBe(false);

    abortController.abort();

    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGKILL");

    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => {
      expect(child.stdout.listenerCount("data")).toBeGreaterThan(0);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    child.close(null);
    await expect(promise).rejects.toThrow();
  });

  it("kills immediately when the signal is already aborted before the call starts", async () => {
    const child = new HangingFakeChild();
    spawnImpl = () => child;
    const { streamTraycerCliJson } = await import("../traycer-cli");
    const abortController = new AbortController();
    abortController.abort();

    const promise = streamTraycerCliJson<unknown>({
      args: ["host", "download", "--automatic"],
      onEvent: () => undefined,
      env: null,
      timeoutMs: 5_000,
      signal: abortController.signal,
    });
    await vi.waitFor(() => {
      expect(child.stdout.listenerCount("data")).toBeGreaterThan(0);
    });
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGKILL");
    child.close(null);
    await expect(promise).rejects.toThrow();
  });
});

describe("streamTraycerCliJson timeout waits for the child close", () => {
  it("F11: keeps the download stream unsettled after timeout until the killed child closes", async () => {
    vi.useFakeTimers();
    try {
      const child = new HangingFakeChild();
      spawnImpl = () => child;
      const { streamTraycerCliJson } = await import("../traycer-cli");

      const promise = streamTraycerCliJson<unknown>({
        args: ["host", "download", "--automatic"],
        onEvent: () => undefined,
        env: null,
        timeoutMs: 5_000,
        signal: null,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGKILL");

      let settled = false;
      void promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);

      child.close(null);
      await expect(promise).rejects.toThrow("timed out");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runTraycerCliPlainJson preserves legacy plain-JSON output", () => {
  it("parses a single plain JSON document (no NDJSON envelope) for `host status --json`", async () => {
    // `host status --json` predates the shared NDJSON runner - it
    // emits a single pretty-printed JSON document on stdout. Routing
    // it through `runTraycerCliJson` (envelope-only) would reject with
    // "emitted no terminal result line"; `runTraycerCliPlainJson`
    // returns the parsed object verbatim instead.
    const plain = {
      running: true,
      pidMetadata: {
        pid: 1234,
        version: "1.5.0",
        websocketUrl: "ws://127.0.0.1:7100",
        startedAt: "2026-05-15T00:00:00Z",
        hostId: "abc-123",
      },
      bootstrapMarkers: [],
      bootstrapLogPath: "/Users/test/.traycer/host/bootstrap.log",
      bootstrapLogTail: "",
    };
    configureExecFile({
      stdout: `${JSON.stringify(plain, null, 2)}\n`,
      stderr: "",
      exitCode: 0,
    });
    const { runTraycerCliPlainJson } = await import("../traycer-cli");
    const result = await runTraycerCliPlainJson<typeof plain>([
      "host",
      "status",
      "--json",
    ]);
    expect(result.running).toBe(true);
    expect(result.pidMetadata?.pid).toBe(1234);
    expect(result.bootstrapLogPath).toContain("bootstrap.log");
  });

  it("parses `config shell get --json` plain output", async () => {
    const plain = {
      path: "/bin/zsh",
      args: ["-i", "-l"],
      synthesised: false,
    };
    configureExecFile({
      stdout: `${JSON.stringify(plain, null, 2)}\n`,
      stderr: "",
      exitCode: 0,
    });
    const { runTraycerCliPlainJson } = await import("../traycer-cli");
    const result = await runTraycerCliPlainJson<typeof plain>([
      "config",
      "shell",
      "get",
      "--json",
    ]);
    expect(result.path).toBe("/bin/zsh");
    expect(result.args).toEqual(["-i", "-l"]);
    expect(result.synthesised).toBe(false);
  });

  it("ensures --json is appended even when callers forget it", async () => {
    const setup = configureExecFile({
      stdout: `${JSON.stringify({ path: "/bin/bash", args: [], synthesised: true })}\n`,
      stderr: "",
      exitCode: 0,
    });
    const { runTraycerCliPlainJson } = await import("../traycer-cli");
    await runTraycerCliPlainJson(["config", "shell", "get"]);
    expect(setup.capturedArgs[0]).toContain("--json");
  });

  it("rejects with TraycerCliError when stdout is not valid JSON", async () => {
    configureExecFile({
      stdout: "this is not json\n",
      stderr: "",
      exitCode: 0,
    });
    const { runTraycerCliPlainJson, TraycerCliError } =
      await import("../traycer-cli");
    let thrown: unknown = null;
    try {
      await runTraycerCliPlainJson(["host", "status", "--json"]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TraycerCliError);
    if (thrown instanceof TraycerCliError) {
      expect(thrown.message).toContain("not valid JSON");
    }
  });

  it("rejects with TraycerCliError on non-zero exit with stderr tail attached", async () => {
    configureExecFile({
      stdout: "",
      stderr: "boom\n",
      exitCode: 2,
    });
    const { runTraycerCliPlainJson, TraycerCliError } =
      await import("../traycer-cli");
    let thrown: unknown = null;
    try {
      await runTraycerCliPlainJson(["config", "env", "list", "--json"]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TraycerCliError);
    if (thrown instanceof TraycerCliError) {
      expect(thrown.stderrTail).toContain("boom");
    }
  });
});

describe("runTraycerCliJson preserves successful envelopes on non-zero exit", () => {
  // `traycer host doctor --json` emits a fully-formed
  // `{type:"result", status:"ok", data:{issues:[...]}}` envelope and
  // sets `exitCode=1` whenever any issue's severity is `error` or
  // `fatal`. Desktop must render those issues - the helper must NOT
  // discard the unwrapped success payload just because execFile
  // surfaces the non-zero exit as a rejection.
  it("resolves with unwrapped data when stdout has a success envelope but exit code is non-zero (Doctor case)", async () => {
    const issues = [
      {
        code: "HOST_NOT_RUNNING",
        severity: "error" as const,
        title: "Host is not running",
        message: "Start the host to use Traycer.",
        fixAction: "host-start",
        terminalCommand: "traycer host start",
        details: null,
      },
      {
        code: "CLI_UPGRADE_PENDING",
        severity: "warning" as const,
        title: "CLI upgrade staged",
        message: "Restart the host to finalise the swap.",
        fixAction: "host-restart",
        terminalCommand: "traycer host restart",
        details: { stagedVersion: "1.6.0" },
      },
    ];
    const envelope = {
      type: "result",
      status: "ok",
      data: { issues },
      timestamp: "2026-05-15T00:00:00Z",
    };
    configureExecFile({
      stdout: `${JSON.stringify(envelope)}\n`,
      stderr: "doctor: 1 error\n",
      exitCode: 1,
    });
    const { runTraycerCliJson } = await import("../traycer-cli");
    const result = await runTraycerCliJson<{ issues: typeof issues }>([
      "host",
      "doctor",
    ]);
    expect(Array.isArray(result.issues)).toBe(true);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "HOST_NOT_RUNNING",
      "CLI_UPGRADE_PENDING",
    ]);
    const pending = result.issues.find(
      (issue) => issue.code === "CLI_UPGRADE_PENDING",
    );
    expect(pending?.fixAction).toBe("host-restart");
    expect(pending?.terminalCommand).toBe("traycer host restart");
  });

  it("still rejects with TraycerCliError when non-zero exit emits an error terminal envelope on stdout", async () => {
    // The dual: a non-zero exit accompanied by an *error* envelope
    // must keep rejecting with the CLI's stable error code so Desktop
    // surfaces the right recovery affordance.
    const envelope = {
      type: "result",
      status: "error",
      error: {
        code: "E_HOST_INSTALL_FAILED",
        message: "verification failed",
        details: { checksum: "mismatch" },
      },
      timestamp: "2026-05-15T00:00:00Z",
    };
    configureExecFile({
      stdout: `${JSON.stringify(envelope)}\n`,
      stderr: "error: verification failed [code=E_HOST_INSTALL_FAILED]\n",
      exitCode: 1,
    });
    const { runTraycerCliJson, TraycerCliError } =
      await import("../traycer-cli");
    let thrown: unknown = null;
    try {
      await runTraycerCliJson(["host", "install", "latest"]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TraycerCliError);
    if (thrown instanceof TraycerCliError) {
      expect(thrown.code).toBe("E_HOST_INSTALL_FAILED");
      expect(thrown.message).toContain("verification failed");
      expect(thrown.stderrTail).toContain("E_HOST_INSTALL_FAILED");
    }
  });

  it("rejects with TraycerCliError carrying exit code + stderr tail when non-zero exit emits no parseable envelope", async () => {
    configureExecFile({
      stdout: "not json at all\n",
      stderr: "panic: segfault\n",
      exitCode: 139,
    });
    const { runTraycerCliJson, TraycerCliError } =
      await import("../traycer-cli");
    let thrown: unknown = null;
    try {
      await runTraycerCliJson(["host", "doctor"]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TraycerCliError);
    if (thrown instanceof TraycerCliError) {
      expect(thrown.exitCode).toBe(139);
      expect(thrown.stderrTail).toContain("segfault");
    }
  });
});

describe("runTraycerCliJson timeout must exceed the CLI's own lock wait (fixup A8)", () => {
  it("passes execFile a timeout that exceeds the CLI's 30s cli-lock wait, not merely matches or falls short of it", async () => {
    // Every lock-taking CLI command this helper backs (`host service
    // install/uninstall`, `host stamp-runtime`, `host free-port`, `host
    // uninstall [--all]`) waits up to `waitMs: 30_000` internally on the
    // shared cli-lock before terminally throwing `E_CLI_LOCK_BUSY`. A
    // desktop subprocess timeout at or below that window SIGKILLs the CLI
    // before it can ever emit that classification - and, worse, can kill
    // it the instant after it wins the lock and enters its critical
    // section (a torn install/staged/pid record).
    let capturedTimeout: number | null = null;
    execFileImpl = (_cmd, _args, opts, callback) => {
      capturedTimeout = (opts as { readonly timeout: number }).timeout;
      const envelope = {
        type: "result",
        status: "ok",
        data: {},
        timestamp: "2026-05-15T00:00:00Z",
      };
      callback(null, `${JSON.stringify(envelope)}\n`, "");
    };
    const { runTraycerCliJson } = await import("../traycer-cli");
    await runTraycerCliJson(["host", "service", "uninstall"]);
    if (capturedTimeout === null) {
      throw new Error("execFile was never invoked");
    }
    expect(capturedTimeout).toBeGreaterThan(30_000);
  });
});

describe("CLI_UPGRADE_PENDING preservation through Desktop projection", () => {
  it("survives projectDoctorReport after envelope unwrapping", async () => {
    // The bug we're guarding against: before this fix, the Doctor IPC
    // handler called `projectDoctorReport(raw)` where `raw` was the
    // envelope `{type:"result", status:"ok", data:{issues:[...]}}`,
    // so `raw.issues` was `undefined` and the issue list - including
    // the CLI_UPGRADE_PENDING card the Pending CLI Upgrade flow
    // depends on - was silently lost. The fix routes raw through
    // `runTraycerCliJson` which unwraps `data` first.
    const pendingIssue = {
      code: "CLI_UPGRADE_PENDING",
      severity: "warning" as const,
      title: "CLI upgrade staged",
      message: "Restart the host to finalise the swap.",
      fixAction: "host-restart",
      terminalCommand: "traycer host restart",
      details: { stagedVersion: "1.5.0", stagedAt: "2026-05-14T00:00:00Z" },
    };
    const envelope = {
      type: "result",
      status: "ok",
      data: { issues: [pendingIssue] },
      timestamp: "2026-05-15T00:00:00Z",
    };
    configureExecFile({
      stdout: `${JSON.stringify(envelope)}\n`,
      stderr: "",
      exitCode: 0,
    });
    const { runTraycerCliJson } = await import("../traycer-cli");
    const data = await runTraycerCliJson<{
      issues: ReadonlyArray<typeof pendingIssue>;
    }>(["host", "doctor"]);
    // Fixup D2: call the real projector instead of re-implementing its
    // field reads inline - the earlier version manually mirrored the
    // mapping logic, so a regression inside `projectDoctorReport` itself
    // (e.g. silently dropping `fixAction`/`terminalCommand`) would not
    // have been caught here.
    const { projectDoctorReport } =
      await import("../../ipc/host-management-ipc");
    const report = projectDoctorReport(data);
    const issue = report.issues.find((i) => i.code === "CLI_UPGRADE_PENDING");
    expect(issue).toBeDefined();
    expect(issue?.fixAction).toBe("host-restart");
    expect(issue?.terminalCommand).toBe("traycer host restart");
  });
});

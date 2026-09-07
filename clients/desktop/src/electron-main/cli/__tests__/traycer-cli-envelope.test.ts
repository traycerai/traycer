import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


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

// The returned path is never actually exec'd - `node:child_process` is stubbed below.
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
      // Node always passes both `(code, signal)` on `close`; a child that
      // exited on its own reports a null signal.
      this.emit("close", opts.exitCode, null);
    });
  }
  kill(signal: NodeJS.Signals): void {
    this.killed = true;
    this.killSignal = signal;
  }

  close(exitCode: number | null, signal: NodeJS.Signals | null): void {
    this.emit("close", exitCode, signal);
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

  close(exitCode: number | null, signal: NodeJS.Signals | null): void {
    this.emit("close", exitCode, signal);
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
    // The CLI's real `E_HOST_VERIFY_FAILED` message never made it to the user.
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
    // Positioning every progress line before the result (the old fixture) made this indistinguishable from "last line wins", since both implementations would land on the same line.
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
      idleTimeoutMs: 5_000,
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
      idleTimeoutMs: 5_000,
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
        idleTimeoutMs: 5_000,
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

describe("streamTraycerCliJson trusts a completed terminal result over the exit code", () => {
  it("resolves with the payload when a successful envelope is followed by a non-zero exit", async () => {
    const terminalLine = JSON.stringify({
      type: "result",
      status: "ok",
      data: { version: "1.1.9" },
      timestamp: "2026-05-15T00:00:00Z",
    });
    spawnImpl = () =>
      new FakeChild({
        stdoutLines: [terminalLine],
        // The exact field signature: work done, then the abort.
        stderr:
          "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76\r\n",
        exitCode: 134,
      });
    const { streamTraycerCliJson } = await import("../traycer-cli");

    const result = await streamTraycerCliJson<{ version: string }>({
      args: ["host", "install", "latest"],
      onEvent: () => undefined,
      env: null,
      idleTimeoutMs: 5_000,
      signal: null,
    });

    expect(result.data).toEqual({ version: "1.1.9" });
  });

  it("still rejects a non-zero exit that produced no terminal result", async () => {
    spawnImpl = () =>
      new FakeChild({
        stdoutLines: [],
        stderr: "boom\n",
        exitCode: 3,
      });
    const { streamTraycerCliJson, TraycerCliError } =
      await import("../traycer-cli");
    let thrown: unknown = null;
    try {
      await streamTraycerCliJson<unknown>({
        args: ["host", "install", "latest"],
        onEvent: () => undefined,
        env: null,
        idleTimeoutMs: 5_000,
        signal: null,
      });
    } catch (err) {
      thrown = err;
    }
    // The guard is keyed on "a terminal ok was seen", not on the exit code,
    // so a run that never produced one fails exactly as it did before.
    expect(thrown).toBeInstanceOf(TraycerCliError);
    if (thrown instanceof TraycerCliError) {
      expect(thrown.message).toContain("exited with code 3");
    }
  });
});

// The subprocess must actually be killed the moment the signal fires, and the awaited call must reject rather than hang.
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
      idleTimeoutMs: 5_000,
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

    child.close(null, "SIGKILL");
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
      idleTimeoutMs: 5_000,
      signal: abortController.signal,
    });
    await vi.waitFor(() => {
      expect(child.stdout.listenerCount("data")).toBeGreaterThan(0);
    });
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGKILL");
    child.close(null, "SIGKILL");
    await expect(promise).rejects.toThrow();
  });
});

// A kill this process never asked for - systemd stopping the unit, the OOM killer, an operator's `kill` - leaves `code` null on `close`.
describe("streamTraycerCliJson reports an external kill by its signal", () => {
  it("names the signal instead of reporting a missing terminal result", async () => {
    const child = new HangingFakeChild();
    spawnImpl = () => child;
    const { streamTraycerCliJson } = await import("../traycer-cli");

    const promise = streamTraycerCliJson<unknown>({
      args: ["host", "install", "--release", "1.1.8-rc.2"],
      onEvent: () => undefined,
      env: null,
      idleTimeoutMs: 5_000,
      signal: null,
    });
    await vi.waitFor(() => {
      expect(child.stdout.listenerCount("data")).toBeGreaterThan(0);
    });

    // Nothing in this process killed it: no abort, no timeout.
    expect(child.killed).toBe(false);
    child.close(null, "SIGTERM");

    await expect(promise).rejects.toThrow("killed by SIGTERM");
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
        idleTimeoutMs: 5_000,
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

      // The idle kill is a SIGKILL, so `close` carries a signal. The
      // timeout check runs before the signal branch, so this still reports
      // the idle budget rather than the bare "killed by SIGKILL".
      child.close(null, "SIGKILL");
      await expect(promise).rejects.toThrow("produced no output");
    } finally {
      vi.useRealTimers();
    }
  });

  // A 700MB host download on a throttled link runs far past any fixed ceiling we would be willing to set, but it never stops reporting.
  it("re-arms the idle budget on every event, and only kills a child that goes quiet", async () => {
    vi.useFakeTimers();
    try {
      const child = new HangingFakeChild();
      spawnImpl = () => child;
      const { streamTraycerCliJson } = await import("../traycer-cli");

      const promise = streamTraycerCliJson<unknown>({
        args: ["host", "download", "--automatic"],
        onEvent: () => undefined,
        env: null,
        idleTimeoutMs: 5_000,
        signal: null,
      });

      // Four reporting rounds - 16s in total, well past the 5s budget.
      for (let round = 0; round < 4; round += 1) {
        await vi.advanceTimersByTimeAsync(4_000);
        expect(child.killed).toBe(false);
        child.stdout.emit(
          "data",
          `${JSON.stringify({
            type: "progress",
            stage: "download",
            percent: round * 25,
            bytes: round * 1_000_000,
            totalBytes: 4_000_000,
            message: "downloading host",
            timestamp: "2026-05-15T00:00:00Z",
          })}\n`,
        );
      }

      await vi.advanceTimersByTimeAsync(4_999);
      expect(child.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGKILL");

      child.close(null, "SIGKILL");
      await expect(promise).rejects.toThrow("produced no output for 5000ms");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runTraycerCliPlainJson preserves legacy plain-JSON output", () => {
  it("parses a single plain JSON document (no NDJSON envelope) for `host status --json`", async () => {
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
  // Desktop must render those issues - the helper must NOT discard the unwrapped success payload just because execFile surfaces the non-zero exit as a rejection.
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
    // The fix routes raw through `runTraycerCliJson` which unwraps `data` first.
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
    const { projectDoctorReport } =
      await import("../../ipc/host-management-ipc");
    const report = projectDoctorReport(data);
    const issue = report.issues.find((i) => i.code === "CLI_UPGRADE_PENDING");
    expect(issue).toBeDefined();
    expect(issue?.fixAction).toBe("host-restart");
    expect(issue?.terminalCommand).toBe("traycer host restart");
  });
});

// A child that already delivered its outcome and then wedges in teardown must settle on THAT outcome when the idle timer kills it.
describe("idle-kill salvages a terminal envelope already parsed (fixup A)", () => {
  it("resolves with the parsed data when the idle timer kills a child that already emitted a terminal ok line", async () => {
    vi.useFakeTimers();
    try {
      const child = new HangingFakeChild();
      spawnImpl = () => child;
      const { streamTraycerCliJson } = await import("../traycer-cli");
      const terminalLine = JSON.stringify({
        type: "result",
        status: "ok",
        data: { version: "1.5.0" },
        timestamp: "2026-05-15T00:00:00Z",
      });

      const promise = streamTraycerCliJson<{ version: string }>({
        args: ["host", "install", "latest"],
        onEvent: () => undefined,
        env: null,
        idleTimeoutMs: 5_000,
        signal: null,
      });
      // Let `resolveTraycerCliInvocation`'s mocked awaits settle so the
      // child is spawned and its stdout listener attached before we feed it
      // a line - fake timers do not advance real microtask queues.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      child.stdout.emit("data", `${terminalLine}\n`);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGKILL");

      child.close(null, "SIGKILL");
      const result = await promise;
      expect(result.data).toEqual({ version: "1.5.0" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with the parsed error envelope's code, not the generic timeout message, when idle-killed after a terminal error line", async () => {
    vi.useFakeTimers();
    try {
      const child = new HangingFakeChild();
      spawnImpl = () => child;
      const { streamTraycerCliJson, TraycerCliError } =
        await import("../traycer-cli");
      const errorLine = JSON.stringify({
        type: "result",
        status: "error",
        error: {
          code: "E_CLI_LOCK_BUSY",
          message: "cli-lock is held by another process",
          details: null,
        },
        timestamp: "2026-05-15T00:00:00Z",
      });

      const promise = streamTraycerCliJson<unknown>({
        args: ["host", "service", "install"],
        onEvent: () => undefined,
        env: null,
        idleTimeoutMs: 5_000,
        signal: null,
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      child.stdout.emit("data", `${errorLine}\n`);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGKILL");

      child.close(null, "SIGKILL");
      let thrown: unknown = null;
      try {
        await promise;
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(TraycerCliError);
      if (thrown instanceof TraycerCliError) {
        expect(thrown.code).toBe("E_CLI_LOCK_BUSY");
        expect(thrown.message).toContain("cli-lock is held");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("still rejects with the generic 'produced no output' message when idle-killed before any envelope was parsed", async () => {
    vi.useFakeTimers();
    try {
      const child = new HangingFakeChild();
      spawnImpl = () => child;
      const { streamTraycerCliJson } = await import("../traycer-cli");

      const promise = streamTraycerCliJson<unknown>({
        args: ["host", "install", "latest"],
        onEvent: () => undefined,
        env: null,
        idleTimeoutMs: 5_000,
        signal: null,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(child.killed).toBe(true);

      child.close(null, "SIGKILL");
      await expect(promise).rejects.toThrow("produced no output for 5000ms");
    } finally {
      vi.useRealTimers();
    }
  });
});

// Fixup B: `sawTerminalOk` is now checked BEFORE the `signal !== null` branch in the `close` handler.
// The no-envelope case (a signal with nothing parsed) is already pinned by "streamTraycerCliJson reports an external kill by its signal" above.
describe("close-handler ordering: a completed terminal ok wins over ANY signal (fixup B)", () => {
  it("resolves with the parsed data when an external signal (not this wrapper's own kill) arrives after a terminal ok line", async () => {
    const child = new HangingFakeChild();
    spawnImpl = () => child;
    const { streamTraycerCliJson } = await import("../traycer-cli");
    const terminalLine = JSON.stringify({
      type: "result",
      status: "ok",
      data: { version: "1.5.0" },
      timestamp: "2026-05-15T00:00:00Z",
    });

    const promise = streamTraycerCliJson<{ version: string }>({
      args: ["host", "install", "latest"],
      onEvent: () => undefined,
      env: null,
      idleTimeoutMs: 5_000,
      signal: null,
    });
    await vi.waitFor(() => {
      expect(child.stdout.listenerCount("data")).toBeGreaterThan(0);
    });
    child.stdout.emit("data", `${terminalLine}\n`);

    // Nothing in this process killed it - systemd/an operator did, same as
    // the pre-existing "reports an external kill by its signal" test above,
    // but here a terminal ok was already parsed.
    expect(child.killed).toBe(false);
    child.close(null, "SIGTERM");

    const result = await promise;
    expect(result.data).toEqual({ version: "1.5.0" });
  });
});

describe("unterminated-line cap kills a runaway child (fixup C)", () => {
  it("SIGKILLs the child and rejects with 'unterminated' when stdout floods past the 1 MiB cap without a newline", async () => {
    const child = new HangingFakeChild();
    spawnImpl = () => child;
    const { streamTraycerCliJson } = await import("../traycer-cli");

    const promise = streamTraycerCliJson<unknown>({
      args: ["host", "download", "--automatic"],
      onEvent: () => undefined,
      env: null,
      idleTimeoutMs: 5_000,
      signal: null,
    });
    await vi.waitFor(() => {
      expect(child.stdout.listenerCount("data")).toBeGreaterThan(0);
    });

    child.stdout.emit("data", "x".repeat(1024 * 1024 + 1));
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGKILL");

    child.close(null, "SIGKILL");
    await expect(promise).rejects.toThrow("unterminated");
  });

  it("keeps the terminal ok payload when the cap trips AFTER a terminal envelope was already parsed", async () => {
    const child = new HangingFakeChild();
    spawnImpl = () => child;
    const { streamTraycerCliJson } = await import("../traycer-cli");
    const terminalLine = JSON.stringify({
      type: "result",
      status: "ok",
      data: { version: "1.5.0" },
      timestamp: "2026-05-15T00:00:00Z",
    });

    const promise = streamTraycerCliJson<{ version: string }>({
      args: ["host", "install", "latest"],
      onEvent: () => undefined,
      env: null,
      idleTimeoutMs: 5_000,
      signal: null,
    });
    await vi.waitFor(() => {
      expect(child.stdout.listenerCount("data")).toBeGreaterThan(0);
    });

    child.stdout.emit("data", `${terminalLine}\n`);
    // A newline-free flood arrives after the envelope - still killed (the
    // cap check runs unconditionally), but the envelope is what wins.
    child.stdout.emit("data", "y".repeat(1024 * 1024 + 1));
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGKILL");

    child.close(null, "SIGKILL");
    const result = await promise;
    expect(result.data).toEqual({ version: "1.5.0" });
  });
});

describe("stderr excerpt appended to every no-envelope rejection (fixup D)", () => {
  it("appends the last non-empty stderr line to the non-zero-exit rejection", async () => {
    spawnImpl = () =>
      new FakeChild({
        stdoutLines: [],
        stderr: "warning: retrying\n\ndyld: missing library\n",
        exitCode: 3,
      });
    const { streamTraycerCliJson, TraycerCliError } =
      await import("../traycer-cli");
    let thrown: unknown = null;
    try {
      await streamTraycerCliJson<unknown>({
        args: ["host", "install", "latest"],
        onEvent: () => undefined,
        env: null,
        idleTimeoutMs: 5_000,
        signal: null,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TraycerCliError);
    if (thrown instanceof TraycerCliError) {
      expect(thrown.message).toContain("exited with code 3");
      expect(thrown.message).toContain(": dyld: missing library");
    }
  });

  it("appends the last non-empty stderr line to the killed-by-external-signal rejection", async () => {
    const child = new HangingFakeChild();
    spawnImpl = () => child;
    const { streamTraycerCliJson } = await import("../traycer-cli");

    const promise = streamTraycerCliJson<unknown>({
      args: ["host", "install", "latest"],
      onEvent: () => undefined,
      env: null,
      idleTimeoutMs: 5_000,
      signal: null,
    });
    await vi.waitFor(() => {
      expect(child.stdout.listenerCount("data")).toBeGreaterThan(0);
    });
    child.stderr.emit("data", "panic\n\ndyld: missing library\n");
    child.close(null, "SIGTERM");

    await expect(promise).rejects.toThrow("dyld: missing library");
  });

  it("appends the last non-empty stderr line to the 'no terminal result' rejection", async () => {
    spawnImpl = () =>
      new FakeChild({
        stdoutLines: [],
        stderr: "info: starting up\n\ndyld: missing library\n",
        exitCode: 0,
      });
    const { streamTraycerCliJson, TraycerCliError } =
      await import("../traycer-cli");
    let thrown: unknown = null;
    try {
      await streamTraycerCliJson<unknown>({
        args: ["host", "install", "latest"],
        onEvent: () => undefined,
        env: null,
        idleTimeoutMs: 5_000,
        signal: null,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TraycerCliError);
    if (thrown instanceof TraycerCliError) {
      expect(thrown.message).toContain("emitted no terminal result");
      expect(thrown.message).toContain("dyld: missing library");
    }
  });

  it("appends the last non-empty stderr line to the idle-kill rejection", async () => {
    vi.useFakeTimers();
    try {
      const child = new HangingFakeChild();
      spawnImpl = () => child;
      const { streamTraycerCliJson } = await import("../traycer-cli");

      const promise = streamTraycerCliJson<unknown>({
        args: ["host", "download", "--automatic"],
        onEvent: () => undefined,
        env: null,
        idleTimeoutMs: 5_000,
        signal: null,
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      child.stderr.emit("data", "retrying\n\ndyld: missing library\n");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(child.killed).toBe(true);

      child.close(null, "SIGKILL");
      await expect(promise).rejects.toThrow("dyld: missing library");
    } finally {
      vi.useRealTimers();
    }
  });
});

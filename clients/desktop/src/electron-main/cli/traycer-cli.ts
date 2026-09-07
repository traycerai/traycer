import { execFile, spawn } from "node:child_process";
import { log } from "../app/logger";
import {
  CLI_INVOCATION_PROBE_TIMEOUT_MS,
  cliBinaryName,
  discoverCli,
  resolveBundledCliPath,
} from "./cli-discovery";

/**
 * `runTraycerCliJsonWithInvocation` used to SIGKILL at a flat 10s - well inside that 30s window.
 * Must exceed the CLI's own lock wait with real margin for process spawn + stdio/IPC overhead, never merely match it.
 */
const CLI_JSON_TIMEOUT_MS = 45_000;

const STREAM_LINE_CAP_BYTES = 1024 * 1024;

export interface TraycerCliErrorInit {
  readonly message: string;
  readonly code: string | null;
  readonly details: unknown;
  readonly exitCode: number | null;
  readonly stderrTail: string;
}

export class TraycerCliError extends Error {
  readonly code: string | null;
  readonly details: unknown;
  readonly exitCode: number | null;
  readonly stderrTail: string;

  constructor(init: TraycerCliErrorInit, legacyMessage: null);
  constructor(code: string, message: string);
  constructor(
    initOrCode: TraycerCliErrorInit | string,
    legacyMessage: string | null,
  ) {
    if (typeof initOrCode === "string") {
      super(typeof legacyMessage === "string" ? legacyMessage : initOrCode);
      this.name = "TraycerCliError";
      this.code = initOrCode;
      this.details = null;
      this.exitCode = null;
      this.stderrTail = "";
      return;
    }
    super(initOrCode.message);
    this.name = "TraycerCliError";
    this.code = initOrCode.code;
    this.details = initOrCode.details;
    this.exitCode = initOrCode.exitCode;
    this.stderrTail = initOrCode.stderrTail;
  }
}

/** Surface that envelope here verbatim so projector functions in `host-management-ipc.ts` can switch on `status` without re-reading raw lines. */
export type NdjsonEvent =
  | {
      readonly type: "progress";
      readonly stage: string;
      readonly percent: number | null;
      readonly bytes: number | null;
      readonly totalBytes: number | null;
      readonly message: string | null;
      // Monotonic count of completed units of work within the stage (archive
      // entries). Absent from any CLI predating it, which the parser below
      // normalises to `null` like every other numeric.
      readonly workUnits: number | null;
    }
  | {
      readonly type: "result";
      readonly status: "ok";
      readonly data: unknown;
    }
  | {
      readonly type: "result";
      readonly status: "error";
      readonly error: {
        readonly code: string | null;
        readonly message: string;
        readonly details: unknown;
      };
    };

export interface TraycerCliInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

export async function resolveTraycerCliInvocation(): Promise<TraycerCliInvocation> {
  // The impatient deadline: this runs on every CLI invocation, status polls
  // included, and nothing it decides can change who owns the slot - an
  // unvetted candidate here only means this call uses the bundled binary.
  const discovered = await discoverCli(CLI_INVOCATION_PROBE_TIMEOUT_MS);
  if (discovered.kind !== "none") {
    return { command: discovered.binaryPath, args: [] };
  }
  const bundled = await resolveBundledCliPath();
  if (bundled !== null) {
    return { command: bundled, args: [] };
  }
  throw new Error(
    `traycer CLI: no CLI found via manifest, PATH, or bundled resources (looked for ${cliBinaryName()}). Packaged builds bundle the CLI under resources/cli; \`make dev-desktop\` stages the dev CLI wrapper.`,
  );
}

export async function resolveBundledTraycerCliInvocation(): Promise<TraycerCliInvocation> {
  const bundled = await resolveBundledCliPath();
  if (bundled !== null) {
    return { command: bundled, args: [] };
  }
  throw new Error(
    `traycer CLI: no bundled CLI found (looked for ${cliBinaryName()} under app resources). This is a broken install - run \`traycer host doctor\` or reinstall Traycer.`,
  );
}

export interface RunTraycerCliOptions {
  /** Subcommand args appended after the resolved CLI command. */
  readonly args: readonly string[];
  readonly maxBuffer: number;
  readonly timeoutMs: number;
}

export interface TraycerCliResult {
  readonly stdout: string;
  readonly stderr: string;
}

export async function runTraycerCli(
  opts: RunTraycerCliOptions,
): Promise<TraycerCliResult> {
  const inv = await resolveTraycerCliInvocation();
  return runTraycerCliWithInvocation(inv, opts);
}

/** Same as `runTraycerCli`, but the caller supplies an already-resolved `TraycerCliInvocation` instead of letting this module resolve one via `resolveTraycerCliInvocation()`. */
async function runTraycerCliWithInvocation(
  inv: TraycerCliInvocation,
  opts: RunTraycerCliOptions,
): Promise<TraycerCliResult> {
  const allArgs = [...inv.args, ...opts.args];
  return new Promise((resolve, reject) => {
    execFile(
      inv.command,
      allArgs,
      {
        encoding: "utf8",
        maxBuffer: opts.maxBuffer,
        timeout: opts.timeoutMs,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err !== null) {
          const stdoutStr = String(stdout);
          const stderrStr = String(stderr);
          log.warn("[traycer-cli] subprocess failed", {
            command: inv.command,
            args: allArgs,
            stdout: stdoutStr.slice(-512),
            stderr: stderrStr.slice(-512),
            error: err.message,
          });
          const wrapped = new Error(err.message);
          wrapped.name = err.name;
          wrapped.stack = err.stack;
          const decorated = wrapped as Error & {
            stdout: string;
            stderr: string;
            code: unknown;
            killed: unknown;
            signal: unknown;
            cmd: unknown;
          };
          decorated.stdout = stdoutStr;
          decorated.stderr = stderrStr;
          decorated.code = (err as { code?: unknown }).code;
          decorated.killed = (err as { killed?: unknown }).killed;
          decorated.signal = (err as { signal?: unknown }).signal;
          decorated.cmd = (err as { cmd?: unknown }).cmd;
          reject(decorated);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export async function runTraycerCliPlainJson<T>(
  args: readonly string[],
): Promise<T> {
  const augmented = ensureJsonFlag(args);
  let result: TraycerCliResult;
  try {
    result = await runTraycerCli({
      args: augmented,
      maxBuffer: 1024 * 1024,
      timeoutMs: 10_000,
    });
  } catch (err) {
    const stdout =
      err !== null && typeof err === "object" && "stdout" in err
        ? String((err as { stdout: unknown }).stdout ?? "")
        : "";
    const stderr =
      err !== null && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr ?? "")
        : "";
    const salvaged = parseCompleteJson<T>(stdout);
    if (salvaged !== null) {
      log.warn("[traycer-cli] non-zero exit after complete plain JSON", {
        args: augmented,
        stderrTail: stderr.slice(-512),
      });
      return salvaged.value;
    }
    const baseMessage = err instanceof Error ? err.message : String(err);
    const stderrTail = stderr.slice(-2048);
    // Node's child_process error message is just `Command failed: <cmd>`;
    // append a short stderr excerpt so toasts/UIs surface the real cause
    // instead of an opaque "Command failed" string.
    const message = appendStderrSummary(baseMessage, stderrTail);
    throw new TraycerCliError(
      {
        message,
        code: null,
        details: null,
        exitCode:
          err !== null && typeof err === "object" && "code" in err
            ? toNumberOrNull((err as { code: unknown }).code)
            : null,
        stderrTail,
      },
      null,
    );
  }
  const trimmed = result.stdout.trim();
  if (trimmed.length === 0) {
    throw new TraycerCliError(
      {
        message: `traycer-cli emitted no stdout for: ${augmented.join(" ")}`,
        code: null,
        details: null,
        exitCode: 0,
        stderrTail: result.stderr.slice(-2048),
      },
      null,
    );
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new TraycerCliError(
      {
        message: `traycer-cli stdout was not valid JSON for: ${augmented.join(" ")} (${reason})`,
        code: null,
        details: null,
        exitCode: 0,
        stderrTail: result.stderr.slice(-2048),
      },
      null,
    );
  }
}

export async function runTraycerCliJson<T>(
  args: readonly string[],
): Promise<T> {
  const inv = await resolveTraycerCliInvocation();
  return runTraycerCliJsonWithInvocation(inv, args);
}

export async function runBundledTraycerCliJson<T>(
  args: readonly string[],
): Promise<T> {
  const inv = await resolveBundledTraycerCliInvocation();
  return runTraycerCliJsonWithInvocation(inv, args);
}

async function runTraycerCliJsonWithInvocation<T>(
  inv: TraycerCliInvocation,
  args: readonly string[],
): Promise<T> {
  const augmented = ensureJsonFlag(args);
  let result: TraycerCliResult;
  try {
    result = await runTraycerCliWithInvocation(inv, {
      args: augmented,
      maxBuffer: 1024 * 1024,
      timeoutMs: CLI_JSON_TIMEOUT_MS,
    });
  } catch (err) {
    // The Desktop Doctor card must render those issues, so a successful envelope on a non-zero exit resolves with the unwrapped `data` payload rather than throwing it.
    const stdout =
      err !== null && typeof err === "object" && "stdout" in err
        ? String((err as { stdout: unknown }).stdout ?? "")
        : "";
    const stderr =
      err !== null && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr ?? "")
        : "";
    const fromEnvelope = extractTerminalEnvelope(stdout, stderr.slice(-2048));
    if (fromEnvelope instanceof TraycerCliError) {
      throw fromEnvelope;
    }
    if (fromEnvelope !== null) {
      return fromEnvelope as T;
    }
    const baseMessage = err instanceof Error ? err.message : String(err);
    const stderrTail = stderr.slice(-2048);
    // Surface stderr in the message so the renderer's error toast / row
    // shows the actual reason rather than a bare "Command failed: …".
    const message = appendStderrSummary(baseMessage, stderrTail);
    throw new TraycerCliError(
      {
        message,
        code: null,
        details: null,
        exitCode:
          err !== null && typeof err === "object" && "code" in err
            ? toNumberOrNull((err as { code: unknown }).code)
            : null,
        stderrTail,
      },
      null,
    );
  }
  const envelope = extractTerminalEnvelope(
    result.stdout,
    result.stderr.slice(-2048),
  );
  if (envelope === null) {
    throw new TraycerCliError(
      {
        message: `traycer-cli emitted no terminal result line for: ${augmented.join(" ")}`,
        code: null,
        details: null,
        exitCode: 0,
        stderrTail: result.stderr.slice(-2048),
      },
      null,
    );
  }
  if (envelope instanceof TraycerCliError) {
    throw envelope;
  }
  return envelope as T;
}

export interface StreamTraycerCliOptions {
  readonly args: readonly string[];
  readonly onEvent: (event: NdjsonEvent) => void;
  readonly env: Readonly<Record<string, string>> | null;
  readonly idleTimeoutMs: number;
  readonly signal: AbortSignal | null;
}

export interface StreamTraycerCliResult<T> {
  readonly data: T;
}

/** Always invokes the CLI in `--json` mode - the wrapper injects `--json` if the caller forgot it so progress NDJSON is guaranteed. */
export async function streamTraycerCliJson<T>(
  opts: StreamTraycerCliOptions,
): Promise<StreamTraycerCliResult<T>> {
  const inv = await resolveTraycerCliInvocation();
  return streamTraycerCliJsonWithInvocation(inv, opts);
}

export async function streamBundledTraycerCliJson<T>(
  opts: StreamTraycerCliOptions,
): Promise<StreamTraycerCliResult<T>> {
  const inv = await resolveBundledTraycerCliInvocation();
  return streamTraycerCliJsonWithInvocation(inv, opts);
}

async function streamTraycerCliJsonWithInvocation<T>(
  inv: TraycerCliInvocation,
  opts: StreamTraycerCliOptions,
): Promise<StreamTraycerCliResult<T>> {
  const augmentedArgs = ensureJsonFlag(opts.args);
  const allArgs = [...inv.args, ...augmentedArgs];
  return new Promise<StreamTraycerCliResult<T>>((resolve, reject) => {
    const child = spawn(inv.command, allArgs, {
      env: opts.env === null ? process.env : { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdoutBuffer = "";
    let stderrTail = "";
    let terminalResult: T | null = null;
    let sawTerminalOk = false;
    let terminalError: TraycerCliError | null = null;
    let abortError: TraycerCliError | null = null;
    // Deliberately NEVER set once a terminal envelope has been parsed: the envelope is the work's outcome and `close` must report it, exactly as the run path salvages the envelope out.
    let killError: TraycerCliError | null = null;
    let settled = false;
    const cleanupAbortListener = (): void => {
      if (opts.signal !== null) {
        opts.signal.removeEventListener("abort", onAbort);
      }
    };
    let timer: NodeJS.Timeout | null = null;
    const onIdleTimeout = (): void => {
      if (settled) return;
      // Keep this stream promise pending until `close`, just like explicit cancellation, so Remove Traycer's download-drain cannot launch an uninstall while the child is still exiting.
      if (!sawTerminalOk && terminalError === null) {
        killError = new TraycerCliError(
          {
            message: appendStderrSummary(
              `traycer-cli produced no output for ${opts.idleTimeoutMs}ms (${augmentedArgs.join(" ")})`,
              stderrTail,
            ),
            code: null,
            details: null,
            exitCode: null,
            stderrTail,
          },
          null,
        );
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore - already exited
      }
    };
    const armIdleTimer = (): void => {
      if (settled || abortError !== null || killError !== null) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(onIdleTimeout, opts.idleTimeoutMs);
    };
    const clearIdleTimer = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    armIdleTimer();
    // The child is killed immediately, but this promise settles only after `close` so a follow-on uninstall cannot race a child still holding or promoting files.
    const onAbort = (): void => {
      if (settled || abortError !== null || killError !== null) return;
      clearIdleTimer();
      abortError = new TraycerCliError(
        {
          message: `traycer-cli aborted: ${augmentedArgs.join(" ")}`,
          code: null,
          details: null,
          exitCode: null,
          stderrTail,
        },
        null,
      );
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore - already exited
      }
    };
    if (opts.signal !== null) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf("\n");
        if (line.length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Not JSON - the CLI shouldn't emit non-JSON in `--json` mode
          // but be tolerant of stray output.
          log.warn("[traycer-cli] ignored non-JSON stdout line", {
            lineLength: line.length,
          });
          continue;
        }
        const event = parseNdjsonEvent(parsed);
        if (event === null) continue;
        // The child is demonstrably alive and reporting: restart its
        // inactivity budget. This is what lets a multi-hour download on a
        // throttled link run to completion.
        armIdleTimer();
        if (event.type === "progress") {
          opts.onEvent(event);
          continue;
        }
        if (event.status === "ok") {
          terminalResult = event.data as T;
          sawTerminalOk = true;
          opts.onEvent(event);
          continue;
        }
        terminalError = new TraycerCliError(
          {
            message: event.error.message,
            code: event.error.code,
            details: event.error.details,
            exitCode: null,
            stderrTail,
          },
          null,
        );
        opts.onEvent(event);
      }
      // Parity with the run path's 1 MiB `maxBuffer` anti-runaway guard: an unterminated "line" past any real NDJSON event's size is a defective child, and unparsed bytes deliberately.
      if (
        !settled &&
        abortError === null &&
        killError === null &&
        stdoutBuffer.length > STREAM_LINE_CAP_BYTES
      ) {
        if (!sawTerminalOk && terminalError === null) {
          killError = new TraycerCliError(
            {
              message: `traycer-cli emitted an unterminated ${stdoutBuffer.length}-byte stdout line (${augmentedArgs.join(" ")})`,
              code: null,
              details: null,
              exitCode: null,
              stderrTail,
            },
            null,
          );
        }
        stdoutBuffer = "";
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore - already exited
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2048);
    });

    child.on("error", (err) => {
      if (settled || abortError !== null || killError !== null) return;
      settled = true;
      clearIdleTimer();
      cleanupAbortListener();
      reject(
        new TraycerCliError(
          {
            message: err.message,
            code: null,
            details: null,
            exitCode: null,
            stderrTail,
          },
          null,
        ),
      );
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearIdleTimer();
      cleanupAbortListener();
      if (abortError !== null) {
        reject(abortError);
        return;
      }
      if (killError !== null) {
        reject(killError);
        return;
      }
      if (terminalError !== null) {
        reject(
          new TraycerCliError(
            {
              message: terminalError.message,
              code: terminalError.code,
              details: terminalError.details,
              exitCode,
              stderrTail,
            },
            null,
          ),
        );
        return;
      }
      // Checked BEFORE the signal branch below for that reason.
      if (sawTerminalOk) {
        if (
          (typeof exitCode === "number" && exitCode !== 0) ||
          signal !== null
        ) {
          log.warn("[traycer-cli] non-zero exit after a successful result", {
            args: augmentedArgs,
            exitCode,
            signal,
            stderrTail: stderrTail.slice(-512),
          });
        }
        resolve({ data: terminalResult as T });
        return;
      }
      // Checked after the abort/kill paths above: those kill the child
      // themselves and already carry a more specific cause, so only a kill
      // this process did not ask for reaches here.
      if (signal !== null) {
        reject(
          new TraycerCliError(
            {
              message: appendStderrSummary(
                `traycer-cli was killed by ${signal}: ${augmentedArgs.join(" ")}`,
                stderrTail,
              ),
              code: null,
              details: null,
              exitCode,
              stderrTail,
            },
            null,
          ),
        );
        return;
      }
      if (typeof exitCode === "number" && exitCode !== 0) {
        reject(
          new TraycerCliError(
            {
              message: appendStderrSummary(
                `traycer-cli exited with code ${exitCode}: ${augmentedArgs.join(" ")}`,
                stderrTail,
              ),
              code: null,
              details: null,
              exitCode,
              stderrTail,
            },
            null,
          ),
        );
        return;
      }
      // Exited 0 but never emitted a terminal line - the CLI ran and stayed
      // silent. Distinct from the non-zero case above, and the message says so.
      reject(
        new TraycerCliError(
          {
            message: appendStderrSummary(
              `traycer-cli emitted no terminal result for: ${augmentedArgs.join(" ")}`,
              stderrTail,
            ),
            code: null,
            details: null,
            exitCode,
            stderrTail,
          },
          null,
        ),
      );
    });
  });
}

function parseNdjsonEvent(value: unknown): NdjsonEvent | null {
  if (value === null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const type = obj.type;
  if (type === "progress") {
    return {
      type: "progress",
      stage: typeof obj.stage === "string" ? obj.stage : "",
      percent:
        typeof obj.percent === "number" && Number.isFinite(obj.percent)
          ? obj.percent
          : null,
      bytes:
        typeof obj.bytes === "number" && Number.isFinite(obj.bytes)
          ? obj.bytes
          : null,
      totalBytes:
        typeof obj.totalBytes === "number" && Number.isFinite(obj.totalBytes)
          ? obj.totalBytes
          : null,
      message: typeof obj.message === "string" ? obj.message : null,
      workUnits:
        typeof obj.workUnits === "number" && Number.isFinite(obj.workUnits)
          ? obj.workUnits
          : null,
    };
  }
  if (type === "result") {
    // The shared runner discriminates terminal events on `status`. Old
    // pre-runner CLIs emitted a bare `{type:"result", data:...}` - treat
    // an absent `status` as ok so a partial rollout doesn't break.
    const status = obj.status;
    if (status === "error") {
      const errRaw =
        obj.error !== null && typeof obj.error === "object"
          ? (obj.error as Record<string, unknown>)
          : {};
      return {
        type: "result",
        status: "error",
        error: {
          code: typeof errRaw.code === "string" ? errRaw.code : null,
          message:
            typeof errRaw.message === "string" ? errRaw.message : "cli error",
          details: errRaw.details ?? null,
        },
      };
    }
    return { type: "result", status: "ok", data: obj.data };
  }
  // Legacy `{type:"error", code, message, details}` shape (pre-runner
  // CLI) - coerce into the unified result-error envelope.
  if (type === "error") {
    return {
      type: "result",
      status: "error",
      error: {
        code: typeof obj.code === "string" ? obj.code : null,
        message: typeof obj.message === "string" ? obj.message : "cli error",
        details: obj.details ?? null,
      },
    };
  }
  return null;
}

function parseCompleteJson<T>(stdout: string): { readonly value: T } | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    return { value: JSON.parse(trimmed) as T };
  } catch {
    // Truncated or non-JSON: not a complete answer, so not salvageable.
    return null;
  }
}

function extractTerminalEnvelope(
  stdout: string,
  stderrTail: string,
): unknown | TraycerCliError | null {
  const lines = stdout.split(/\r?\n/);
  type TerminalEvent = Extract<NdjsonEvent, { readonly type: "result" }>;
  let terminal: TerminalEvent | null = null;
  for (const line of lines) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.warn("[traycer-cli] ignored non-JSON terminal stdout line", {
        lineLength: line.length,
      });
      continue;
    }
    const event = parseNdjsonEvent(parsed);
    if (event === null) continue;
    if (event.type === "progress") continue;
    terminal = event;
  }
  if (terminal === null) return null;
  if (terminal.status === "error") {
    return new TraycerCliError(
      {
        message: terminal.error.message,
        code: terminal.error.code,
        details: terminal.error.details,
        exitCode: null,
        stderrTail,
      },
      null,
    );
  }
  return terminal.data;
}

/** Called once at the wrapper boundary so callers can omit the flag and never have to think about progress-streaming vs. envelope parsing. */
function ensureJsonFlag(args: readonly string[]): readonly string[] {
  for (const arg of args) {
    if (arg === "--json") return args;
  }
  return [...args, "--json"];
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function appendStderrSummary(baseMessage: string, stderr: string): string {
  const lines = stderr.split(/\r?\n/);
  let lastNonEmpty = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed.length > 0) {
      lastNonEmpty = trimmed;
      break;
    }
  }
  if (lastNonEmpty.length === 0) return baseMessage;
  const maxExcerpt = 240;
  const excerpt =
    lastNonEmpty.length <= maxExcerpt
      ? lastNonEmpty
      : `${lastNonEmpty.slice(0, maxExcerpt - 1)}…`;
  if (baseMessage.includes(excerpt)) return baseMessage;
  return `${baseMessage}: ${excerpt}`;
}

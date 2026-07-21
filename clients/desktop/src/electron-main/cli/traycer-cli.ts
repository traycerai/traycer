import { execFile, spawn } from "node:child_process";
import { log } from "../app/logger";
import {
  cliBinaryName,
  discoverCli,
  resolveBundledCliPath,
} from "./cli-discovery";

/**
 * Fixup A8: every lock-taking CLI command (`host service install/uninstall`,
 * `host stamp-runtime`, `host free-port`, `host uninstall [--all]`, `host
 * restart`, `host apply`, `host install`, `host ensure`, ...) waits up to
 * `waitMs: 30_000` internally on the shared `cli-lock` before terminally
 * throwing `E_CLI_LOCK_BUSY` (every `withCliLock` call site under
 * `traycer-cli/src/commands/`). `runTraycerCliJsonWithInvocation` used to
 * SIGKILL at a flat 10s - well inside that 30s window - so desktop never
 * saw the CLI's own busy classification (breaking the exhausted-lock ->
 * `deferred` terminal contract) and, worse, could kill the CLI the instant
 * AFTER it won the lock and entered its critical section: a torn
 * install/staged/pid record, the single most dangerous defect class in
 * this ticket. Must exceed the CLI's own lock wait with real margin for
 * process spawn + stdio/IPC overhead, never merely match it.
 */
const CLI_JSON_TIMEOUT_MS = 45_000;

/**
 * Structured error thrown when the CLI subprocess exits non-zero or emits
 * an NDJSON `error` event. Carries the CLI's stable error `code` (e.g.
 * `CLI_UPGRADE_REPLACE_FAILED`) when present so Desktop can render a
 * targeted recovery affordance instead of a generic toast.
 */
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

/**
 * One NDJSON record emitted by a long-running CLI subcommand. The CLI
 * writes one JSON document per line on stdout: `progress` events stream
 * intermediate state, `result` events carry the terminal payload (with
 * `status: "ok"` + `data` on success, or `status: "error"` + `error`
 * shape on failure).
 *
 * The shared runner in `traycer-cli/src/runner/output.ts` is the
 * canonical producer. Surface that envelope here verbatim so projector
 * functions in `host-management-ipc.ts` can switch on `status`
 * without re-reading raw lines.
 */
export type NdjsonEvent =
  | {
      readonly type: "progress";
      readonly stage: string;
      readonly percent: number | null;
      readonly bytes: number | null;
      readonly totalBytes: number | null;
      readonly message: string | null;
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

/**
 * Locates the `traycer` CLI command for subprocess invocation.
 *
 * Resolution is identical in packaged and unpackaged builds (Tech Plan
 * Decision 6):
 *
 *   1. CLI manifest (`~/.traycer/cli/manifest.json`) - package-manager
 *      or Desktop-staged CLI is authoritative.
 *   2. PATH fallback - `traycer` (or `traycer.exe` on Windows) on PATH.
 *   3. Bundled CLI fallback (`resolveBundledCliPath`) - when packaged,
 *      arch-scoped `<resourcesPath>/cli/<plat>-<arch>/` then flat
 *      `<resourcesPath>/cli/`; when unpackaged (`make dev-desktop`), the
 *      staged dev wrapper at the `cli/dev-wrapper-paths.json` layout.
 *
 * Returns the absolute command + leading args. Callers append subcommand
 * args after.
 */
export interface TraycerCliInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

export async function resolveTraycerCliInvocation(): Promise<TraycerCliInvocation> {
  const discovered = await discoverCli();
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

/**
 * Bundled-only resolution for `HostController` (Host Update Layer Redesign
 * Tech Plan, D7: "The controller always invokes the desktop-bundled,
 * version-matched CLI for host operations. The discovered
 * package-manager/PATH CLI remains for terminal use and CLI
 * self-management."). Skips the manifest/PATH steps `resolveTraycerCliInvocation`
 * uses - a controller-driven host mutation must never race a differently
 * versioned PATH/manifest CLI outside the lock's current-generation
 * guarantee. `resolveBundledCliPath` already resolves to the staged dev
 * wrapper in dev builds, so this covers both packaged and `make
 * dev-desktop` transparently.
 */
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
  /**
   * Subcommand args appended after the resolved CLI command. E.g.
   * `["host", "status"]` or `["config", "shell", "set", "--path", "/bin/bash"]`.
   */
  readonly args: readonly string[];
  /**
   * Bytes of stdout we'll buffer before treating it as an attack / runaway.
   * The CLI emits small JSON blobs - anything past this is suspicious.
   */
  readonly maxBuffer: number;
  /**
   * How long to wait for the CLI to finish. Defaults to 10s - config
   * reads/writes are nearly instant; host-start is invoked separately
   * via launchd, not this helper, so 10s is comfortable.
   */
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

/**
 * Same as `runTraycerCli`, but the caller supplies an already-resolved
 * `TraycerCliInvocation` instead of letting this module resolve one via
 * `resolveTraycerCliInvocation()`. Extracted so `runBundledTraycerCliJson`
 * (D7: bundled-only invocation for `HostController`) can reuse the exact
 * same spawn/error-decoration logic without re-resolving through the
 * manifest/PATH steps.
 */
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
          // Build a fresh Error rather than mutating the rejected object
          // in-place. Node's execFile is documented to decorate the
          // callback Error with `.stdout` / `.stderr` on non-zero exit,
          // but the property is sometimes a Buffer or missing in
          // Electron's Node depending on the encoding negotiation - and
          // the missing case made `runTraycerCliJson`'s envelope
          // extraction fall through to the bare "Command failed: <cmd>"
          // Node message instead of surfacing the CLI's real
          // NDJSON error (e.g. `E_HOST_VERIFY_FAILED`). Wrapping in a
          // new object force-attaches both fields as strings without
          // mutating the original (which keeps the original observable
          // to anyone holding a stale reference - logs, audit trails).
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

/**
 * Convenience: run a short-lived CLI subcommand whose `--json` output is
 * a single plain JSON document (NOT the shared-runner NDJSON envelope).
 *
 * This helper exists as an escape hatch for any future CLI subcommand
 * that intentionally emits plain JSON rather than the runner's NDJSON
 * envelope. As of the Native Packaging legacy-JSON migration, none of
 * the Desktop host-management or config IPC handlers route through
 * here - `host status`, `config shell get`, `config env list`,
 * `whoami`, and `config env get` all emit the shared runner envelope
 * and are invoked through `runTraycerCliJson`.
 *
 * Keep this helper around for tests that pin the plain-JSON parsing
 * contract; if a new plain-JSON command appears (e.g. a third-party
 * extension command), invoke it through here and document the
 * rationale at the call site.
 */
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
    const stderr =
      err !== null && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr ?? "")
        : "";
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

/**
 * Convenience: run a short-lived CLI subcommand in `--json` mode and
 * return the *unwrapped* `result.data` payload. The shared runner emits
 * one or more NDJSON lines on stdout - zero or more `progress` events
 * followed by a single terminal `result` line. This helper:
 *
 *   - parses every non-empty line as NDJSON
 *   - drops `progress` records (use `streamTraycerCliJson` to receive them)
 *   - on `status: "ok"` resolves with the inner `data` field
 *   - on `status: "error"` rejects with a `TraycerCliError` carrying the
 *     CLI's stable error `code`, `details`, and the stderr tail
 *
 * If the subprocess exits non-zero but never emitted a terminal envelope
 * (e.g. spawn error / crash) we still reject with a `TraycerCliError`
 * so Desktop projectors never see a half-formed payload.
 */
export async function runTraycerCliJson<T>(
  args: readonly string[],
): Promise<T> {
  const inv = await resolveTraycerCliInvocation();
  return runTraycerCliJsonWithInvocation(inv, args);
}

/**
 * Bundled-only counterpart to `runTraycerCliJson` (D7: `HostController`
 * host operations always invoke the desktop-bundled, version-matched CLI -
 * never the discovered manifest/PATH CLI `runTraycerCliJson` resolves).
 * Same envelope contract; only the invocation resolution differs.
 */
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
    // execFile rejects on non-zero exit with an Error that carries
    // `stdout` / `stderr`. The CLI may still have emitted a terminal
    // `result` line on stdout before exiting - surface that envelope
    // verbatim so Desktop can pick the right recovery affordance.
    // `traycer host doctor --json` is the canonical case: it emits a
    // successful `{type:"result", status:"ok", data:{issues:[...]}}`
    // envelope and *also* sets `exitCode=1` whenever any issue severity
    // is `error`/`fatal`. The Desktop Doctor card must render those
    // issues, so a successful envelope on a non-zero exit resolves with
    // the unwrapped `data` payload rather than throwing it.
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

export interface RunTraycerCliWithStdinOptions {
  readonly args: readonly string[];
  /** Written to the CLI's stdin, then stdin is closed so the read hits EOF. */
  readonly stdin: string;
  readonly timeoutMs: number;
}

/**
 * Run a short-lived CLI subcommand, pipe `stdin` to its stdin, and resolve with
 * the unwrapped `result.data` payload from the shared NDJSON envelope.
 *
 * `execFile` (used by `runTraycerCli`) can't feed stdin, so this uses `spawn`
 * with an open stdin pipe. The sole caller is `traycer login --token -`, which
 * reads the bearer from stdin so it never appears in the process argument list.
 * Always invokes `--json` so a terminal `result` envelope is emitted.
 */
export async function runTraycerCliWithStdin<T>(
  opts: RunTraycerCliWithStdinOptions,
): Promise<T> {
  const MAX_STDOUT_BYTES = 1024 * 1024;
  const inv = await resolveTraycerCliInvocation();
  const augmentedArgs = ensureJsonFlag(opts.args);
  const allArgs = [...inv.args, ...augmentedArgs];
  return new Promise<T>((resolve, reject) => {
    const child = spawn(inv.command, allArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderrTail = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
      reject(
        new TraycerCliError(
          {
            message: `traycer-cli timed out after ${opts.timeoutMs}ms (${augmentedArgs.join(" ")})`,
            code: null,
            details: null,
            exitCode: null,
            stderrTail,
          },
          null,
        ),
      );
    }, opts.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_STDOUT_BYTES && !settled) {
        settled = true;
        clearTimeout(timer);
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
        reject(
          new TraycerCliError(
            {
              message: `traycer-cli stdout exceeded ${MAX_STDOUT_BYTES} bytes (${augmentedArgs.join(" ")})`,
              code: null,
              details: null,
              exitCode: null,
              stderrTail,
            },
            null,
          ),
        );
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2048);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const envelope = extractTerminalEnvelope(stdout, stderrTail);
      if (envelope instanceof TraycerCliError) {
        reject(envelope);
        return;
      }
      if (envelope !== null) {
        resolve(envelope as T);
        return;
      }
      reject(
        new TraycerCliError(
          {
            message: `traycer-cli emitted no terminal result for: ${augmentedArgs.join(" ")}`,
            code: null,
            details: null,
            exitCode: typeof exitCode === "number" ? exitCode : null,
            stderrTail,
          },
          null,
        ),
      );
    });

    // EPIPE if the child exited before consuming stdin - the close/error
    // handlers already drive the rejection, so swallow it here.
    child.stdin.on("error", () => {});
    child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

export interface StreamTraycerCliOptions {
  readonly args: readonly string[];
  readonly onEvent: (event: NdjsonEvent) => void;
  readonly env: Readonly<Record<string, string>> | null;
  readonly timeoutMs: number;
  // Fixup C4: killed the moment this fires (SIGKILL, same as the timeout/
  // stdout-overflow paths below) instead of only flipping `.aborted` on a
  // controller nothing downstream ever consulted. `null` for callers with
  // no cancellation surface (every mutation-lane call via `streamBundled` -
  // only the download lane's `AbortController` ever aborts).
  readonly signal: AbortSignal | null;
}

export interface StreamTraycerCliResult<T> {
  readonly data: T;
}

/**
 * Spawn a CLI subcommand that emits NDJSON on stdout, fan progress events
 * to `onEvent`, and resolve with the unwrapped `result.data` payload. Used
 * by host-management long-running operations (install / update /
 * register-service) so Settings → Host and the Doctor failure card can
 * render intermediate progress without polling.
 *
 * Always invokes the CLI in `--json` mode - the wrapper injects `--json`
 * if the caller forgot it so progress NDJSON is guaranteed.
 */
export async function streamTraycerCliJson<T>(
  opts: StreamTraycerCliOptions,
): Promise<StreamTraycerCliResult<T>> {
  const inv = await resolveTraycerCliInvocation();
  return streamTraycerCliJsonWithInvocation(inv, opts);
}

/**
 * Bundled-only counterpart to `streamTraycerCliJson` (D7: every CLI
 * subprocess `HostController` spawns for a host mutation - apply, install,
 * ensure, download, service register/deregister, restart, uninstall - uses
 * the desktop-bundled, version-matched CLI, never the discovered
 * manifest/PATH one). Same NDJSON progress/result contract; only the
 * invocation resolution differs.
 */
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
    let timeoutError: TraycerCliError | null = null;
    let settled = false;
    const cleanupAbortListener = (): void => {
      if (opts.signal !== null) {
        opts.signal.removeEventListener("abort", onAbort);
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      // Killing a timed-out child does not mean it has released its files.
      // Keep this stream promise pending until `close`, just like explicit
      // cancellation, so Remove Traycer's download-drain cannot launch an
      // uninstall while the child is still exiting.
      timeoutError = new TraycerCliError(
        {
          message: `traycer-cli timed out after ${opts.timeoutMs}ms (${augmentedArgs.join(" ")})`,
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
    }, opts.timeoutMs);
    // Fixup C4: the ONLY current caller (`runDownloadLane`'s
    // `abortInFlightDownload`) used to flip `AbortController.signal.aborted`
    // with nothing downstream ever wired to it - the spawned CLI subprocess
    // ran to completion regardless, so Remove Traycer's cancellation was
    // cosmetic (a download could burn network/CPU for up to
    // `CLI_JSON_TIMEOUT_MS` after removal). The child is killed immediately,
    // but this promise settles only after `close` so a follow-on uninstall
    // cannot race a child still holding or promoting files.
    const onAbort = (): void => {
      if (settled || abortError !== null || timeoutError !== null) return;
      clearTimeout(timer);
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
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2048);
    });

    child.on("error", (err) => {
      if (settled || abortError !== null || timeoutError !== null) return;
      settled = true;
      clearTimeout(timer);
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

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupAbortListener();
      if (abortError !== null) {
        reject(abortError);
        return;
      }
      if (timeoutError !== null) {
        reject(timeoutError);
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
      if (typeof exitCode === "number" && exitCode !== 0) {
        reject(
          new TraycerCliError(
            {
              message: `traycer-cli exited with code ${exitCode}: ${augmentedArgs.join(" ")}`,
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
      if (!sawTerminalOk) {
        reject(
          new TraycerCliError(
            {
              message: `traycer-cli emitted no terminal result for: ${augmentedArgs.join(" ")}`,
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
      resolve({ data: terminalResult as T });
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

/**
 * Walk an `--json` subprocess's stdout looking for the terminal `result`
 * NDJSON line, ignoring progress events and any non-JSON noise. Returns:
 *   - `unknown` (the unwrapped `data` payload) on a success envelope
 *   - a `TraycerCliError` on an error envelope
 *   - `null` when no terminal line is present at all
 *
 * Used by `runTraycerCliJson` so query commands get the same envelope
 * contract as streamed long-running ones - projector functions never
 * see the `{type:"result", status:"ok", data:...}` outer shape.
 */
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

/**
 * Ensure the args list passes `--json` so the CLI emits NDJSON envelopes.
 * Called once at the wrapper boundary so callers can omit the flag and
 * never have to think about progress-streaming vs. envelope parsing.
 */
function ensureJsonFlag(args: readonly string[]): readonly string[] {
  for (const arg of args) {
    if (arg === "--json") return args;
  }
  return [...args, "--json"];
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Appends a one-line excerpt of the CLI's stderr to a base error message.
 * Picks the last non-empty stderr line (usually the most specific error,
 * e.g. `error: unknown option '--cli-bin'`) and trims it so the combined
 * message fits in a single-line toast / error chip. No-ops when stderr is
 * empty so messages that already carry detail stay unchanged.
 */
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

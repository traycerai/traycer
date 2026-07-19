import { spawn, type ChildProcess } from "node:child_process";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";

// Bounded timeout for the `lsof`/`netstat` ownership probes below. Both now
// run entirely inside `cli-lock` (Tech Plan, "Lifecycle lock coverage") -
// an unbounded subprocess probe would let a wedged/hijacked binary hold the
// lock indefinitely: the holder stays positively alive, so
// ticket-1's hardened stale-lock breaking correctly refuses to break it,
// and every other host mutation wedges until a human kills the process by
// hand. 5s is generous for a local `lsof`/`netstat` invocation (normally
// sub-100ms) while still bounding the time and captured-output cost a caller
// waiting on `cli-lock` can tolerate.
export const PORT_PROBE_TIMEOUT_MS = 5_000;
const PORT_PROBE_KILL_GRACE_MS = 500;
// Matches Node's execFile default maxBuffer. The time deadline cannot cap a
// hostile probe's memory growth, so stdout and stderr share this byte budget.
const PORT_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;

// Shared by `host free-port-and-restart` and `host free-port` (Host
// Update Layer Redesign Tech Plan, "Lifecycle lock coverage") - the
// verify-then-SIGTERM sequence Doctor's port-conflict repair drives.
// Both commands run this under `cli-lock` themselves; this module is
// lock-agnostic.
//
// Lifecycle:
//   1. Validate that the target PID is alive (`process.kill(pid, 0)`)
//      AND that it actually owns `port`. The latter check shells out
//      to `lsof` on POSIX and `netstat` on Windows, each bounded by
//      `PORT_PROBE_TIMEOUT_MS`, so we refuse to SIGTERM a random process
//      that happens to share an ID with the conflicting one (PIDs are
//      reused aggressively on Linux) - and a hung probe can't wedge
//      `cli-lock` forever.
//   2. Send SIGTERM. A failure surfaces as `killError` in the result
//      rather than a thrown error - the caller already has the user's
//      "yes I want to kill this" confirmation, so a missed kill isn't
//      promoted to a CLI error. `process.kill` is a synchronous syscall
//      (no subprocess, no I/O wait), so it has no analogous hang risk and
//      needs no timeout of its own.

export interface KillConflictingPortOwnerOptions {
  readonly pid: number;
  readonly port: number;
  // Prefixes error messages ("host free-port" vs "host
  // free-port-and-restart") so callers keep their own command's voice.
  readonly commandName: string;
}

export interface KillConflictingPortOwnerResult {
  readonly killed: boolean;
  readonly killError: string | null;
}

export async function killConflictingPortOwner(
  opts: KillConflictingPortOwnerOptions,
): Promise<KillConflictingPortOwnerResult> {
  try {
    process.kill(opts.pid, 0);
  } catch (err) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `${opts.commandName}: pid ${opts.pid} is not alive (${err instanceof Error ? err.message : String(err)})`,
      details: { pid: opts.pid, port: opts.port },
      exitCode: 1,
    });
  }
  const ownership = await pidOwnsPort(opts.pid, opts.port);
  if (!ownership.owns) {
    // Disambiguate five failure modes that all surface as
    // !ownership.owns so the operator sees the actionable message:
    //   - probe="no-listener" - port has no listener; SIGTERMing the
    //     user-supplied pid would kill an unrelated process.
    //   - probe="timeout" - the probe binary hung past
    //     `PORT_PROBE_TIMEOUT_MS`; a conservative "could not determine",
    //     never a silent "no listener" or a silent "owns".
    //   - probe="output-overflow" - the probe exceeded the bounded output
    //     budget; refuse to act because its ownership result is incomplete.
    //   - probe="unsupported" - we couldn't verify (binary missing or
    //     unexpected error); refuse to act blind.
    //   - default - someone other than opts.pid is the listener.
    const message =
      ownership.probe === "no-listener"
        ? `${opts.commandName}: port ${opts.port} has no listener; nothing to free`
        : ownership.probe === "timeout"
          ? `${opts.commandName}: could not verify pid ${opts.pid} owns port ${opts.port} (probe timed out after ${PORT_PROBE_TIMEOUT_MS}ms); refusing to kill blind`
          : ownership.probe === "output-overflow"
            ? `${opts.commandName}: could not verify pid ${opts.pid} owns port ${opts.port} (probe exceeded ${PORT_PROBE_MAX_OUTPUT_BYTES} output bytes); refusing to kill blind`
            : ownership.probe === "unsupported"
              ? `${opts.commandName}: could not verify pid ${opts.pid} owns port ${opts.port} (probe unsupported on this host); refusing to kill blind`
              : ownership.actualPid !== null
                ? `${opts.commandName}: pid ${opts.pid} does not own port ${opts.port} (port ${opts.port} is held by pid ${ownership.actualPid})`
                : `${opts.commandName}: pid ${opts.pid} does not own port ${opts.port} (no process holds the port)`;
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message,
      details: {
        pid: opts.pid,
        port: opts.port,
        actualPid: ownership.actualPid,
        probe: ownership.probe,
      },
      exitCode: 1,
    });
  }
  try {
    process.kill(opts.pid, "SIGTERM");
    return { killed: true, killError: null };
  } catch (err) {
    return {
      killed: false,
      killError: err instanceof Error ? err.message : String(err),
    };
  }
}

interface PortOwnership {
  readonly owns: boolean;
  readonly actualPid: number | null;
  readonly probe:
    | "lsof"
    | "netstat"
    | "unsupported"
    | "no-listener"
    | "timeout"
    | "output-overflow";
}

// Probe whether `pid` is the listener on `port`. POSIX uses `lsof -nP -iTCP:<port> -sTCP:LISTEN`;
// Windows uses `netstat -ano` filtered by port. We don't fail when the
// probe binary is unavailable - instead we return `unsupported` so the
// caller's error message can distinguish "we couldn't verify" from "we
// verified the PID doesn't own the port". When the probe runs cleanly
// and reports zero listeners we return `no-listener` so the caller can
// surface that distinct state as well.
async function pidOwnsPort(pid: number, port: number): Promise<PortOwnership> {
  if (process.platform === "win32") {
    return windowsPidOwnsPort(pid, port);
  }
  return posixPidOwnsPort(pid, port);
}

// Narrow probe-process failures to the one shape callers need. The `code`
// field on ENOENT is a string ("ENOENT") whereas a non-zero process exit
// carries a number. `killed` is set only by the hard deadline below.
interface ExecFileError {
  readonly code: string | number | undefined;
  readonly signal: string | undefined;
  readonly stdout: string | undefined;
  readonly stderr: string | undefined;
  readonly killed: boolean;
  readonly outputOverflow: boolean;
}

interface ProbeExecutionResult {
  readonly stdout: string;
}

function terminateProbeProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // Windows netstat.exe does not fork. This intentionally terminates only
    // the direct child; POSIX gets process-group teardown below for wrappers.
    child.kill(signal);
    return;
  }
  // Probes run in their own POSIX process group, so this also reaps helper
  // children a compromised shell wrapper may have left behind.
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function executePortProbe(
  command: string,
  args: readonly string[],
): Promise<ProbeExecutionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const clearTimers = (): void => {
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      timeoutTimer = null;
      killTimer = null;
    };
    const settle = (result: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      result();
    };
    const timeoutError = (): ExecFileError => ({
      code: undefined,
      signal: "SIGKILL",
      stdout,
      stderr,
      killed: true,
      outputOverflow: false,
    });

    const outputOverflowError = (): ExecFileError => ({
      code: undefined,
      signal: "SIGKILL",
      stdout,
      stderr,
      killed: true,
      outputOverflow: true,
    });
    const appendOutput = (
      destination: "stdout" | "stderr",
      chunk: Buffer,
    ): void => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > PORT_PROBE_MAX_OUTPUT_BYTES) {
        terminateProbeProcessTree(child, "SIGKILL");
        settle(() => reject(outputOverflowError()));
        return;
      }
      if (destination === "stdout") {
        stdout += chunk.toString();
        return;
      }
      stderr += chunk.toString();
    };

    child.stdout?.on("data", (chunk) => {
      appendOutput("stdout", chunk);
    });
    child.stderr?.on("data", (chunk) => {
      appendOutput("stderr", chunk);
    });
    child.once("error", (err) => {
      settle(() => reject(err));
    });
    child.once("close", (code, signal) => {
      if (timedOut) {
        settle(() => reject(timeoutError()));
        return;
      }
      if (code === 0) {
        settle(() => resolve({ stdout }));
        return;
      }
      settle(() =>
        reject({
          code: code ?? undefined,
          signal: signal ?? undefined,
          stdout,
          stderr,
          killed: false,
          outputOverflow: false,
        } satisfies ExecFileError),
      );
    });
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProbeProcessTree(child, "SIGTERM");
      // `execFile`'s built-in timeout only sends SIGTERM and then waits for
      // normal exit. A TERM-ignoring probe would therefore hold cli-lock
      // forever. Escalate and settle at a hard deadline instead.
      killTimer = setTimeout(() => {
        terminateProbeProcessTree(child, "SIGKILL");
        settle(() => reject(timeoutError()));
      }, PORT_PROBE_KILL_GRACE_MS);
    }, PORT_PROBE_TIMEOUT_MS);
  });
}

function readExecFileError(err: unknown): ExecFileError {
  if (typeof err !== "object" || err === null) {
    return {
      code: undefined,
      signal: undefined,
      stdout: undefined,
      stderr: undefined,
      killed: false,
      outputOverflow: false,
    };
  }
  const obj = err as Record<string, unknown>;
  const code =
    typeof obj.code === "string" || typeof obj.code === "number"
      ? obj.code
      : undefined;
  const signal = typeof obj.signal === "string" ? obj.signal : undefined;
  const stdout = typeof obj.stdout === "string" ? obj.stdout : undefined;
  const stderr = typeof obj.stderr === "string" ? obj.stderr : undefined;
  const killed = typeof obj.killed === "boolean" ? obj.killed : false;
  const outputOverflow =
    typeof obj.outputOverflow === "boolean" ? obj.outputOverflow : false;
  return { code, signal, stdout, stderr, killed, outputOverflow };
}

async function posixPidOwnsPort(
  pid: number,
  port: number,
): Promise<PortOwnership> {
  let stdout: string;
  try {
    const result = await executePortProbe("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fpn",
    ]);
    stdout = result.stdout;
  } catch (err) {
    const info = readExecFileError(err);
    if (info.outputOverflow) {
      return { owns: false, actualPid: null, probe: "output-overflow" };
    }
    // `killed` marks our hard deadline: `lsof` exceeded
    // `PORT_PROBE_TIMEOUT_MS` and was escalated to SIGKILL. Check it before
    // the ENOENT/no-listener heuristics so a hang can never be misread as
    // either of those.
    if (info.killed) {
      return { owns: false, actualPid: null, probe: "timeout" };
    }
    // ENOENT: lsof isn't installed (some minimal containers / Alpine
    // setups). We can't verify; let the caller refuse to act blind.
    if (info.code === "ENOENT") {
      return { owns: false, actualPid: null, probe: "unsupported" };
    }
    // lsof exits 1 with empty stdout when nothing matches the filter
    // (no listener on the port). That's a legitimate "no-listener"
    // signal, NOT a probe failure - distinguish it so the caller can
    // emit a clearer message than "couldn't verify".
    if (
      info.code === 1 &&
      (info.stdout === undefined || info.stdout.length === 0)
    ) {
      return { owns: false, actualPid: null, probe: "no-listener" };
    }
    // Anything else (exit 2+, killed by signal, etc.) is a genuine
    // probe failure we can't reason about - re-throw so the runner
    // surfaces a structured error rather than this helper silently
    // returning `unsupported` and the caller refusing to act.
    throw err;
  }
  // lsof -F output: lines prefixed with `p<pid>` repeated per file
  // descriptor for that pid. The first numeric segment after `p` is
  // the owning pid.
  const pids = stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith("p"))
    .map((l) => Number.parseInt(l.slice(1), 10))
    .filter((n) => Number.isFinite(n));
  if (pids.length === 0) {
    return { owns: false, actualPid: null, probe: "no-listener" };
  }
  return {
    owns: pids.includes(pid),
    actualPid: pids[0] ?? null,
    probe: "lsof",
  };
}

// `netstat -p TCP` only enumerates IPv4 listeners; a host bound to
// `[::1]:port` (IPv6 loopback) is invisible to that query, so we run
// both protocols and combine the results before deciding ownership.
async function netstatListenersForProto(proto: "TCP" | "TCPv6"): Promise<{
  readonly stdout: string;
  readonly available: boolean;
  readonly timedOut: boolean;
  readonly outputOverflow: boolean;
}> {
  try {
    const { stdout } = await executePortProbe("netstat", ["-ano", "-p", proto]);
    return { stdout, available: true, timedOut: false, outputOverflow: false };
  } catch (err) {
    const info = readExecFileError(err);
    if (info.outputOverflow) {
      return {
        stdout: "",
        available: false,
        timedOut: false,
        outputOverflow: true,
      };
    }
    // A hang past `PORT_PROBE_TIMEOUT_MS` must never fall into the
    // "TCPv6 disabled" leniency below - that path silently treats the
    // proto as "ran, zero listeners", which would let a genuinely
    // unverified probe read as a clean "no-listener" (or, combined with
    // the OTHER proto's real output, a wrong ownership verdict). Surface
    // it distinctly so the caller returns a "could not determine", never
    // a silent success.
    if (info.killed) {
      return {
        stdout: "",
        available: false,
        timedOut: true,
        outputOverflow: false,
      };
    }
    if (info.code === "ENOENT") {
      return {
        stdout: "",
        available: false,
        timedOut: false,
        outputOverflow: false,
      };
    }
    // Some hosts disable TCPv6 entirely - `netstat -p TCPv6` exits
    // non-zero but TCP still works. Treat as "no data for this proto"
    // rather than a probe failure so the IPv4 path can still answer.
    return {
      stdout: typeof info.stdout === "string" ? info.stdout : "",
      available: true,
      timedOut: false,
      outputOverflow: false,
    };
  }
}

async function windowsPidOwnsPort(
  pid: number,
  port: number,
): Promise<PortOwnership> {
  const ipv4 = await netstatListenersForProto("TCP");
  const ipv6 = await netstatListenersForProto("TCPv6");
  if (ipv4.outputOverflow || ipv6.outputOverflow) {
    return { owns: false, actualPid: null, probe: "output-overflow" };
  }
  if (ipv4.timedOut || ipv6.timedOut) {
    return { owns: false, actualPid: null, probe: "timeout" };
  }
  if (!ipv4.available && !ipv6.available) {
    return { owns: false, actualPid: null, probe: "unsupported" };
  }
  // Match `:<port>` followed by whitespace OR end-of-token, so port 80
  // doesn't match inside 8080. We avoid `\b` because `:` is a non-word
  // boundary on its own under JS regex.
  const portRegex = new RegExp(`:${port}(\\s|$)`);
  const owningPids = `${ipv4.stdout}\n${ipv6.stdout}`
    .split(/\r?\n/)
    .filter((line) => line.includes("LISTENING") && portRegex.test(line))
    .flatMap((line) => {
      const parts = line.trim().split(/\s+/);
      const last = parts[parts.length - 1];
      const parsed = Number.parseInt(last ?? "", 10);
      return Number.isFinite(parsed) ? [parsed] : [];
    });
  if (owningPids.length === 0) {
    return { owns: false, actualPid: null, probe: "no-listener" };
  }
  return {
    owns: owningPids.includes(pid),
    actualPid: owningPids[0] ?? null,
    probe: "netstat",
  };
}

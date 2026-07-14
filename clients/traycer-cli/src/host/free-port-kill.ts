import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";

const execFileAsync = promisify(execFile);

// Shared by `host free-port-and-restart` and `host free-port` (Host
// Update Layer Redesign Tech Plan, "Lifecycle lock coverage") - the
// verify-then-SIGTERM sequence Doctor's port-conflict repair drives.
// Both commands run this under `cli-lock` themselves; this module is
// lock-agnostic.
//
// Lifecycle:
//   1. Validate that the target PID is alive (`process.kill(pid, 0)`)
//      AND that it actually owns `port`. The latter check shells out
//      to `lsof` on POSIX and `netstat` on Windows so we refuse to SIGTERM
//      a random process that happens to share an ID with the conflicting
//      one (PIDs are reused aggressively on Linux).
//   2. Send SIGTERM. A failure surfaces as `killError` in the result
//      rather than a thrown error - the caller already has the user's
//      "yes I want to kill this" confirmation, so a missed kill isn't
//      promoted to a CLI error.

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
    // Disambiguate three failure modes that all surface as
    // !ownership.owns so the operator sees the actionable message:
    //   - probe="no-listener" - port has no listener; SIGTERMing the
    //     user-supplied pid would kill an unrelated process.
    //   - probe="unsupported" - we couldn't verify (binary missing or
    //     unexpected error); refuse to act blind.
    //   - default - someone other than opts.pid is the listener.
    const message =
      ownership.probe === "no-listener"
        ? `${opts.commandName}: port ${opts.port} has no listener; nothing to free`
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
  readonly probe: "lsof" | "netstat" | "unsupported" | "no-listener";
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

// Narrow `execFileAsync` rejections to the shape Node uses for spawn
// failures. The `code` field on ENOENT is a string ("ENOENT") whereas
// the `code` field on a non-zero process exit is a number; `signal` is
// populated only when the child was killed by a signal.
interface ExecFileError {
  readonly code: string | number | undefined;
  readonly signal: string | undefined;
  readonly stdout: string | undefined;
  readonly stderr: string | undefined;
}

function readExecFileError(err: unknown): ExecFileError {
  if (typeof err !== "object" || err === null) {
    return {
      code: undefined,
      signal: undefined,
      stdout: undefined,
      stderr: undefined,
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
  return { code, signal, stdout, stderr };
}

async function posixPidOwnsPort(
  pid: number,
  port: number,
): Promise<PortOwnership> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"],
      { encoding: "utf8" },
    );
    stdout = result.stdout;
  } catch (err) {
    const info = readExecFileError(err);
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
async function netstatListenersForProto(
  proto: "TCP" | "TCPv6",
): Promise<{ readonly stdout: string; readonly available: boolean }> {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", proto], {
      encoding: "utf8",
    });
    return { stdout, available: true };
  } catch (err) {
    const info = readExecFileError(err);
    if (info.code === "ENOENT") {
      return { stdout: "", available: false };
    }
    // Some hosts disable TCPv6 entirely - `netstat -p TCPv6` exits
    // non-zero but TCP still works. Treat as "no data for this proto"
    // rather than a probe failure so the IPv4 path can still answer.
    return {
      stdout: typeof info.stdout === "string" ? info.stdout : "",
      available: true,
    };
  }
}

async function windowsPidOwnsPort(
  pid: number,
  port: number,
): Promise<PortOwnership> {
  const ipv4 = await netstatListenersForProto("TCP");
  const ipv6 = await netstatListenersForProto("TCPv6");
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

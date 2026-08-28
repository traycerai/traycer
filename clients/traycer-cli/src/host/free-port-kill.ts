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
//   2. Send SIGTERM. A delivery failure surfaces as `killError` on the
//      result rather than a thrown error, so the caller can shape its own
//      command-specific CLI error. `process.kill` is a synchronous syscall
//      (no subprocess, no I/O wait), so it has no analogous hang risk and
//      needs no timeout of its own.
//   3. VERIFY that the SIGTERM actually achieved anything, by polling until
//      the target stops owning the port or `PORT_RELEASE_VERIFY_TIMEOUT_MS`
//      elapses. Step 2 succeeding means "the signal was delivered", which is
//      a much weaker claim than "the port conflict is resolved": a process
//      that traps or ignores SIGTERM keeps its listener and the repair has
//      done nothing. Callers turn a non-`released` verdict into a non-zero
//      CLI error (audit finding CLI-011) - previously BOTH commands reported
//      `exitCode: 0` with the failure demoted to a `killError` string, and
//      `free-port-and-restart` went on to restart the host into a port the
//      foreign listener still held, so Doctor and Desktop reported a
//      completed repair over an unresolved conflict.
//
// WHAT "RELEASED" MEANS, and why it is not "the port is now unbound". This
// command's job is to terminate the process the user confirmed, not to
// guarantee the port stays empty afterwards. On a machine whose service
// manager auto-respawns the host (launchd KeepAlive, systemd Restart=), the
// host can legitimately claim the freed port within milliseconds of the kill
// - the exact outcome the repair wants. Demanding an unbound port would
// report that success as a failure, so the verdict is keyed to the TARGET:
// released once `pid` no longer owns `port`, whoever holds it next.
//
// Nothing here escalates to SIGKILL. The user confirmed terminating a named
// process, not force-killing it, and a repair that quietly escalates past
// what was confirmed is worse than one that stops and says the process
// ignored the signal.

// Upper bound on the post-kill verification poll. A process that is going to
// exit on SIGTERM does so in milliseconds; this is generous for a loaded
// machine while staying well inside the 30s `cli-lock` wait callers hold.
export const PORT_RELEASE_VERIFY_TIMEOUT_MS = 5_000;
// 250ms rather than something tighter because every tick can cost a
// subprocess (`lsof`, or two `netstat` invocations on Windows). The common
// case settles on the first or second tick - SIGTERM is fast - so the
// interval only governs how hard the RARE failure case polls, and ~20
// iterations is a reasonable ceiling for a process that is ignoring the
// signal anyway.
const PORT_RELEASE_POLL_INTERVAL_MS = 250;
// How many CONSECUTIVE clean "nothing is listening" observations certify a
// release. Two, not one, because a single sample cannot tell a freed port from
// the gap between a supervised process exiting and its replacement binding -
// and systemd's default `RestartSec` is 100ms, comfortably inside the window a
// one-shot probe would call success.
//
// This NARROWS the race; it cannot close it, and pretending otherwise would be
// the same overclaim this module exists to remove. A supervisor with a long
// restart delay (launchd throttles to 10s) will still beat any bounded
// observation, and the restart itself takes time after that. What the extra
// sample buys is the common, fast-respawn case; what it costs is one poll
// interval on the success path.
const PORT_RELEASE_FREE_OBSERVATIONS_REQUIRED = 2;

export interface KillConflictingPortOwnerOptions {
  readonly pid: number;
  readonly port: number;
  // Prefixes error messages ("host free-port" vs "host
  // free-port-and-restart") so callers keep their own command's voice.
  readonly commandName: string;
}

// Verdict of the post-kill verification poll.
//   - "released"   - `pid` no longer owns `port`. The repair worked.
//   - "still-held" - `pid` is still alive AND still the listener at the
//                    deadline (it ignored or trapped SIGTERM), or the signal
//                    was never delivered at all.
//   - "unverified" - the ownership probe could not answer (binary missing,
//                    hung past its own timeout, output overflow). NOT
//                    success: the same "refuse to act blind" rule that
//                    guards the pre-kill check applies to the post-kill one.
export type PortReleaseStatus = "released" | "still-held" | "unverified";

export interface KillConflictingPortOwnerResult {
  readonly killed: boolean;
  readonly killError: string | null;
  readonly release: PortReleaseStatus;
  // Human-readable evidence behind `release` - which probe answered, or why
  // it could not. Callers put this in the error message and `details`.
  readonly releaseDetail: string;
  // Who holds the port at the end of verification, and non-null ONLY for
  // `release: "still-held"`. `released` requires consecutive no-listener
  // observations, so it always reports `null` here, and `unverified` never
  // names a holder it could not confirm.
  //
  // Stated precisely because an earlier version of this comment described a
  // `released`-with-holder combination the producer cannot emit, which invites
  // callers to add defensive `holderPid` checks on the success path for a
  // state that never arrives. `release` is the whole verdict; this field is
  // diagnostic.
  readonly holderPid: number | null;
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
  let killError: string | null = null;
  try {
    process.kill(opts.pid, "SIGTERM");
  } catch (err) {
    killError = err instanceof Error ? err.message : String(err);
  }
  // VERIFY EVEN WHEN THE SIGNAL FAILED, because "we could not signal it" is
  // not the same question as "is the port free", and the two come apart in
  // both directions.
  //
  // ESRCH is the case that matters: the verified owner exited on its own
  // between the ownership probe above and this `kill`, a race no lock can
  // close because the process is foreign. Reporting `still-held` on the
  // strength of the failed signal - as an earlier revision did - named a pid
  // that no longer exists and told the operator to terminate it, while the
  // port may well have been free the whole time. It also blinded us to a
  // replacement listener, which is the situation that actually needs saying.
  //
  // EPERM lands here too and is unaffected: a process we cannot signal is
  // still alive and still holding the port, so verification independently
  // reaches `still-held` and `killError` supplies the reason. And if the port
  // IS free despite a failed signal, the repair's goal is met - the caller's
  // `released` short-circuit reports success rather than manufacturing a
  // failure out of a signal nobody needed.
  const verification = await verifyPortReleased(opts.pid, opts.port);
  return {
    killed: killError === null,
    killError,
    release: verification.release,
    releaseDetail:
      killError === null
        ? verification.releaseDetail
        : `SIGTERM was not delivered (${killError}); ${verification.releaseDetail}`,
    holderPid: verification.holderPid,
  };
}

interface PortReleaseVerification {
  readonly release: PortReleaseStatus;
  readonly releaseDetail: string;
  readonly holderPid: number | null;
}

// Poll until nothing is listening on `port`, or the deadline passes.
//
// THE QUESTION IS THE PORT, NOT THE PROCESS. An earlier revision short-
// circuited on process exit - a dead pid owns no sockets, so `kill(pid, 0)`
// returning ESRCH looked like a definitive, subprocess-free release verdict.
// It is not, and three reviewers independently caught the same hole: the
// target dying says nothing about whether the PORT is free. A supervised
// foreign listener respawning under a NEW pid, or any other process claiming
// the port in the window between the SIGTERM and the check, leaves the
// conflict fully intact while the original pid is gone. Reporting `released`
// there would restart the host onto an occupied port and call it a completed
// repair - exactly the CLI-011 behaviour this whole change exists to remove.
//
// So every verdict now comes from the ownership probe, which is the only
// thing that actually looks at the port, and success requires NO LISTENER
// rather than merely "not the pid we signalled". `cli-lock` cannot help
// here: it serialises Traycer's own actors and has no authority over a
// foreign process or an OS supervisor.
//
// The cost is one `lsof`/`netstat` on the success path that the old fast
// path avoided. That is the correct trade - the fast path was buying a
// subprocess's worth of latency with a wrong answer - and it also removes
// the win32 special case, since `isProcessAlive` there is a synchronous
// `tasklist` spawn rather than a syscall.
//
// A replacement listener is deliberately NOT resolved against the Traycer
// host's own pid to allow "our host reclaimed its port" as success. That
// would need positive identity for a process this command never started, on
// a machine whose host is by definition not reachable - and guessing wrong
// in that direction is how the original bug read. A host that legitimately
// reclaims the port surfaces as a named holder in the error, and the next
// `traycer host doctor` reports the machine healthy.
async function verifyPortReleased(
  pid: number,
  port: number,
): Promise<PortReleaseVerification> {
  const deadline = Date.now() + PORT_RELEASE_VERIFY_TIMEOUT_MS;
  // Remembered so the timeout verdict can tell "we watched something keep the
  // port" from "we never got a usable answer" - different messages, and only
  // the first names a process for the user to deal with.
  let lastUnverifiedProbe: string | null = null;
  let lastHolderPid: number | null = null;
  let consecutiveFreeObservations = 0;
  for (;;) {
    // `pidOwnsPort` re-throws genuine probe failures (exit 2+, unexpected
    // signal). Before the kill that is correct - the runner turns it into a
    // structured error and nothing has happened yet. After the kill it is
    // not: a process has already been signalled, and crashing the command
    // with a raw subprocess error would lose that fact. Downgrade to
    // "unverified", which callers already refuse to treat as success.
    let ownership: PortOwnership;
    try {
      ownership = await pidOwnsPort(pid, port);
    } catch (err) {
      lastUnverifiedProbe = `threw: ${err instanceof Error ? err.message : String(err)}`;
      // Same reason as the probe-failure branch below: a sample we could not
      // read breaks the consecutive-free streak rather than being skipped over.
      consecutiveFreeObservations = 0;
      if (Date.now() >= deadline) break;
      await delay(PORT_RELEASE_POLL_INTERVAL_MS);
      continue;
    }
    // Probe-failure kinds report `owns: false` too, so they must be filtered
    // out BEFORE any `!owns` reasoning - otherwise a missing `lsof` would
    // certify every repair as successful.
    if (
      ownership.probe === "timeout" ||
      ownership.probe === "unsupported" ||
      ownership.probe === "output-overflow"
    ) {
      lastUnverifiedProbe = ownership.probe;
      // The streak breaks on a probe we could not read, not only on a sighted
      // listener. "Free, could-not-tell, free" is not two CONSECUTIVE free
      // observations - the middle sample is precisely where a replacement
      // could have bound and unbound unseen - and letting it count would turn
      // an intermittent inability to inspect the port into the stable
      // interval this loop exists to require.
      consecutiveFreeObservations = 0;
    } else if (ownership.probe === "no-listener") {
      // The only success verdict - but it has to hold across an interval, not
      // a single sample. One clean observation is equally consistent with "the
      // port is free" and "we looked during a supervised process's respawn
      // gap", and returning on the first would spend the rest of the
      // verification budget on nothing while handing the caller a restart that
      // races the replacement.
      lastUnverifiedProbe = null;
      lastHolderPid = null;
      consecutiveFreeObservations += 1;
      if (
        consecutiveFreeObservations >= PORT_RELEASE_FREE_OBSERVATIONS_REQUIRED
      ) {
        return {
          release: "released",
          releaseDetail: `port ${port} had no listener across ${consecutiveFreeObservations} checks ${PORT_RELEASE_POLL_INTERVAL_MS}ms apart (pid ${pid} released it)`,
          holderPid: null,
        };
      }
    } else {
      lastUnverifiedProbe = null;
      // Someone is still listening: either the target itself, or a
      // replacement. Both keep the conflict alive, so both keep polling and
      // both end as `still-held` - they differ only in the message. The free
      // streak resets, so a port that flaps between free and taken can never
      // accumulate its way to a release.
      consecutiveFreeObservations = 0;
      lastHolderPid = ownership.owns ? pid : ownership.actualPid;
    }
    if (Date.now() >= deadline) break;
    await delay(PORT_RELEASE_POLL_INTERVAL_MS);
  }
  if (lastUnverifiedProbe !== null) {
    return {
      release: "unverified",
      releaseDetail: `could not determine whether port ${port} was released (probe=${lastUnverifiedProbe})`,
      holderPid: null,
    };
  }
  // Ran out of budget having seen the port free, but never for long enough to
  // certify it, and never having seen anyone holding it either. Reporting
  // `still-held` here would name a holder that was never observed; reporting
  // `released` would be the single-sample claim this loop exists to avoid.
  // "We could not confirm it" is the only true statement available.
  if (lastHolderPid === null && consecutiveFreeObservations > 0) {
    return {
      release: "unverified",
      releaseDetail: `port ${port} appeared free but could not be observed free for ${PORT_RELEASE_FREE_OBSERVATIONS_REQUIRED} consecutive checks before the ${PORT_RELEASE_VERIFY_TIMEOUT_MS}ms deadline`,
      holderPid: null,
    };
  }
  if (lastHolderPid !== null && lastHolderPid !== pid) {
    return {
      release: "still-held",
      releaseDetail:
        `pid ${pid} released port ${port}, but pid ${lastHolderPid} is now listening on it ` +
        `${PORT_RELEASE_VERIFY_TIMEOUT_MS}ms after SIGTERM - the port is still occupied`,
      holderPid: lastHolderPid,
    };
  }
  return {
    release: "still-held",
    releaseDetail: `pid ${pid} still owns port ${port} ${PORT_RELEASE_VERIFY_TIMEOUT_MS}ms after SIGTERM`,
    holderPid: pid,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
      // `-w` suppresses lsof's warning chatter (unreadable /proc entries,
      // un-stat-able filesystems - routine inside containers). Without it the
      // empty-stderr requirement below would misread a warning as a probe
      // failure and refuse to certify perfectly good results on exactly the
      // machines where this repair is most likely to be needed.
      "-w",
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
    //
    // EMPTY STDERR IS PART OF THAT SIGNAL, because lsof overloads exit 1 for
    // BOTH "nothing matched" and "an error occurred". A transient permission
    // or /proc-inspection failure therefore looks identical to a clean empty
    // result from exit code and stdout alone. That ambiguity used to be
    // cheap: `no-listener` only ever produced a refusal ("nothing to free").
    // Post-kill verification promoted it to the sole success verdict, so the
    // same ambiguity would now certify a release over a port that is still
    // held. `-w` above removes the routine warning noise that would otherwise
    // make this check trigger constantly, leaving stderr as a real signal.
    if (
      info.code === 1 &&
      (info.stdout === undefined || info.stdout.length === 0)
    ) {
      return info.stderr === undefined || info.stderr.length === 0
        ? { owns: false, actualPid: null, probe: "no-listener" }
        : { owns: false, actualPid: null, probe: "unsupported" };
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
  // This proto exited non-zero for a reason we chose to tolerate (the
  // "TCPv6 is disabled" leniency below). Tracked separately from
  // `available` because the leniency is only safe when the OTHER proto
  // answers the question: a tolerated failure that produces zero rows is
  // indistinguishable from a genuine empty result, and the caller must not
  // read the second as the first. See `windowsPidOwnsPort`.
  readonly lenientFailure: boolean;
}> {
  try {
    const { stdout } = await executePortProbe("netstat", ["-ano", "-p", proto]);
    return {
      stdout,
      available: true,
      timedOut: false,
      outputOverflow: false,
      lenientFailure: false,
    };
  } catch (err) {
    const info = readExecFileError(err);
    if (info.outputOverflow) {
      return {
        stdout: "",
        available: false,
        timedOut: false,
        outputOverflow: true,
        lenientFailure: false,
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
        lenientFailure: false,
      };
    }
    if (info.code === "ENOENT") {
      return {
        stdout: "",
        available: false,
        timedOut: false,
        outputOverflow: false,
        lenientFailure: false,
      };
    }
    // Some hosts disable TCPv6 entirely - `netstat -p TCPv6` exits
    // non-zero but TCP still works. Treat as "no data for this proto"
    // rather than a probe failure so the IPv4 path can still answer - but
    // FLAG it, because this branch catches every unexpected netstat failure,
    // not just the disabled-TCPv6 one it was written for.
    return {
      stdout: typeof info.stdout === "string" ? info.stdout : "",
      available: true,
      timedOut: false,
      outputOverflow: false,
      lenientFailure: true,
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
    // ZERO ROWS IS ONLY "no listener" IF BOTH PROBES ACTUALLY RAN.
    //
    // The leniency in `netstatListenersForProto` exists for one situation -
    // TCPv6 disabled on the host - but it catches every unexpected `netstat`
    // failure, returning `available: true` with whatever (possibly empty)
    // stdout came back. When that happens and the other family also produced
    // no matching rows, the combined result is empty for a reason we never
    // observed, and `no-listener` would be a claim rather than a finding.
    //
    // That distinction is load-bearing now in a way it was not before. Prior
    // to post-kill verification, `no-listener` only ever caused a REFUSAL
    // ("port has no listener; nothing to free"), so mistaking it cost an
    // unnecessary error. `verifyPortReleased` treats it as the sole success
    // verdict, so the same mistake would certify a release nobody checked and
    // let the restart proceed onto a port that may still be held - the exact
    // failure this change exists to remove, arriving through the Windows door.
    if (ipv4.lenientFailure || ipv6.lenientFailure) {
      return { owns: false, actualPid: null, probe: "unsupported" };
    }
    return { owns: false, actualPid: null, probe: "no-listener" };
  }
  return {
    owns: owningPids.includes(pid),
    actualPid: owningPids[0] ?? null,
    probe: "netstat",
  };
}

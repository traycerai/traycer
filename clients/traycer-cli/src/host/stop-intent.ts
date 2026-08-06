import { rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { writeJsonAtomically } from "./lifecycle-probe";
import { hostStopIntentPath } from "../store/paths";
import type { Environment } from "../runner/environment";

/**
 * "Someone is deliberately stopping this host - do not bring it back."
 *
 * The supervisor relaunches a child that dies abnormally. That is correct for a
 * crash and catastrophic for a stop: `traycer host stop`, an install swap, or
 * Desktop's `host restart` would each be undone by the very process they are
 * trying to shut down.
 *
 * ### Why intent has to be STATED, not inferred
 *
 * Exit shape cannot answer this. On Windows `taskkill /T /F` gives the killed
 * process exit code 1, which is byte-identical to a host that genuinely crashed
 * with exit 1. On POSIX the supervisor forwards SIGTERM itself, so the child's
 * death during a stop wears the same signal as any other signal death. Every
 * heuristic here is a coin flip on whether we fight the user.
 *
 * ### Why it is a FILE and not an in-process flag
 *
 * The stopper is never the supervisor. On POSIX that barely matters - launchd
 * and systemd signal the supervisor directly, so it knows - but on Windows
 * `schtasks /End` terminates only the task's root process (`wscript.exe`) and
 * Task Scheduler does not job-object the tree, so the supervisor survives as an
 * orphan and is never told anything. A file is the only channel that reaches it.
 *
 * ### Staleness
 *
 * A stop that dies halfway through (the stopper is killed between writing intent
 * and finishing the kill) must not wedge the machine into never relaunching
 * again. Intent therefore EXPIRES: it only has to outlive stop → kill → settle,
 * so a few minutes is generous, and past that the supervisor resumes normal
 * crash recovery.
 */
export const STOP_INTENT_STALE_MS = 300_000;

export type StopIntentReason =
  "stop" | "restart" | "install-swap" | "uninstall";

export interface StopIntent {
  readonly v: 1;
  readonly requestedAt: string;
  readonly requestedByPid: number;
  readonly reason: StopIntentReason;
}

const STOP_INTENT_REASONS: ReadonlySet<string> = new Set<StopIntentReason>([
  "stop",
  "restart",
  "install-swap",
  "uninstall",
]);

/**
 * Record intent BEFORE anything is killed.
 *
 * Ordering is the whole contract: `stopService` removes pid.json only *after*
 * the kill, so "pid metadata is gone" cannot be the supervisor's pre-relaunch
 * check - it would already have relaunched by then. This lands first, which is
 * what makes the check race-free.
 *
 * Never throws, but REPORTS whether the record landed, and the caller has to
 * care on Windows.
 *
 * An earlier version of this comment claimed a failed write was harmless
 * because "the worst case is one unwanted relaunch, which the supervisor's own
 * budget and incumbent re-check then contain". That is false, and the
 * containment argument is what made it sound safe. If the write fails on
 * win32, `/End` and `taskkill` still run, the orphaned supervisor is never
 * signalled and sees no intent, so it reads the killed child's nonzero exit as
 * a crash and relaunches. A replacement that then stays healthy resets the
 * budget and IS the incumbent - so neither mechanism stops it, and `host stop`
 * has reported success while the host is still running.
 */
export async function writeStopIntent(
  environment: Environment | undefined,
  reason: StopIntentReason,
): Promise<boolean> {
  const intent: StopIntent = {
    v: 1,
    requestedAt: new Date().toISOString(),
    requestedByPid: process.pid,
    reason,
  };
  try {
    await writeJsonAtomically(hostStopIntentPath(environment), intent);
    return true;
  } catch {
    // Never throws: the caller decides what an unrecorded intent means, and
    // that answer is platform-dependent (see `withStopIntent`).
    return false;
  }
}

/**
 * Drop a served intent. Called when a start succeeds: a host that is being
 * started is no longer a host anyone is stopping, and leaving the file behind
 * would suppress the NEXT crash's recovery.
 */
export async function clearStopIntent(
  environment: Environment | undefined,
): Promise<void> {
  try {
    await rm(hostStopIntentPath(environment), { force: true });
  } catch {
    // Best effort: a stale intent expires on its own.
  }
}

/**
 * Which RECORD a supervisor has already answered, independent of any clock.
 *
 * `requestedAt` alone would be a timestamp comparison again; pairing it with the
 * writing pid makes this an identity rather than an ordering. Two different stop
 * requests cannot collide on both - they would have to be issued by the same
 * process in the same millisecond, which is the same process's single write.
 */
export interface StopIntentIdentity {
  readonly requestedAt: string;
  readonly requestedByPid: number;
}

export function stopIntentIdentity(intent: StopIntent): StopIntentIdentity {
  return {
    requestedAt: intent.requestedAt,
    requestedByPid: intent.requestedByPid,
  };
}

/** Whether `intent` IS the record named by `identity`. A null identity - no
 * record existed when the supervisor started - matches nothing, so any record
 * that appears later is a request this supervisor has not answered. */
export function isSameStopIntent(
  intent: StopIntent,
  identity: StopIntentIdentity | null,
): boolean {
  if (identity === null) return false;
  return (
    intent.requestedAt === identity.requestedAt &&
    intent.requestedByPid === identity.requestedByPid
  );
}

/** The record present right now, as an identity a supervisor can remember. */
export async function readStopIntentIdentity(
  environment: Environment | undefined,
): Promise<StopIntentIdentity | null> {
  const intent = await readStopIntent(environment);
  return intent === null ? null : stopIntentIdentity(intent);
}

/** `null` when absent, unreadable, or not a well-formed intent record. */
export async function readStopIntent(
  environment: Environment | undefined,
): Promise<StopIntent | null> {
  let text: string;
  try {
    text = await readFile(hostStopIntentPath(environment), "utf8");
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return parseStopIntent(raw);
}

/**
 * The supervisor's question: is there a stop intent that this invocation has
 * NOT already served?
 *
 * A torn or malformed file reads as NO intent - biased toward recovering the
 * host, matching `findLiveIncumbentHost`'s own bias. Leaving a machine hostless
 * on a garbled byte is the worse failure.
 *
 * `servedAtStartup` is the record that existed when this supervisor was
 * invoked. Our own existence answers it - something asked for a start after
 * asking for a stop, and the start is the newer instruction. Any OTHER record
 * is a request we have not answered.
 *
 * ### Why identity rather than deleting the file
 *
 * The obvious implementation is to `rm` the sentinel once at startup. It has a
 * race that matters: a stop landing between this supervisor's invocation and
 * its clear gets ERASED, and the supervisor then spawns a host the user just
 * stopped. Two supervisors (a logon trigger plus a manual start) make it worse,
 * because either one's clear can delete intent written after the other's.
 *
 * Remembering destroys nothing, so there is no window in which a real stop can
 * be lost. The record disappears on its own via `STOP_INTENT_STALE_MS`, and that
 * is the ONLY thing that retires it on the ordinary path: each supervisor
 * remembers separately, so a lingering record silences the process being retired
 * while a later one - which saw it at ITS start - reads it as served and starts
 * normally. Deleting it is what would re-arm the retired process; see
 * `withStopIntent`.
 *
 * It is also what makes checking intent on the FIRST attempt safe. Reading the
 * raw file there would make a logon-started supervisor refuse to start the host
 * at all within the freshness window of any stop - strictly worse than the bug.
 *
 * ### Why not a timestamp cutoff
 *
 * This compared the record's stamp against the supervisor's own start stamp:
 * two readings of a clock that can move between them. Both directions bite, and
 * both end the same way, with a machine that has no host:
 *
 *   - a BACKWARD step larger than our uptime makes a stop issued NOW look older
 *     than our start, so a live request reads as served, the orphaned win32
 *     supervisor sees nothing actionable, and it relaunches the host the user
 *     just stopped;
 *   - the same step leaves a PRE-EXISTING record looking future-dated, so a
 *     supervisor starting afterwards reads an already-answered stop as aimed at
 *     it, declines to spawn, and exits 0 - which `KeepAlive.SuccessfulExit=false`,
 *     `Restart=on-failure` and Task Scheduler all decline to answer. The host
 *     then stays down until the next logon rather than for the intended five
 *     minutes.
 *
 * Neither is exotic: a machine that boots with a wrong RTC - a dead CMOS cell, a
 * restored VM snapshot - takes its largest correction seconds after the logon
 * task started this process, exactly when uptime is smallest.
 *
 * The cutoff was only ever a PROXY for "did my own start answer this record",
 * and identity answers that question directly and without a clock. So the proxy
 * is gone rather than refined: the two cases it distinguished were the same
 * record either way, and no clock reading can separate them.
 *
 * KNOWN LIMIT: a stop written between this supervisor's invocation and its first
 * read of the file is remembered as pre-existing, and therefore read as served.
 * That window is a single file read at process start, and it is irreducible -
 * whether such a stop came before or after the start request is exactly what no
 * clock on a machine with a moving clock can tell us. It is also the cheaper
 * failure: a host that is running after a stop can be stopped again, whereas the
 * other direction leaves the machine with no host at all.
 */
export async function hasActionableStopIntent(
  environment: Environment | undefined,
  nowMs: number,
  servedAtStartup: StopIntentIdentity | null,
): Promise<boolean> {
  const intent = await readStopIntent(environment);
  if (intent === null) return false;
  if (!isStopIntentFresh(intent, nowMs)) return false;
  return !isSameStopIntent(intent, servedAtStartup);
}

/**
 * Whether `intent` is recent enough to still be acted on - a SYMMETRIC window,
 * `STOP_INTENT_STALE_MS` either side of `nowMs`.
 *
 * The forward half is not symmetry for its own sake. A future-dated stamp is
 * still evidence someone asked for a stop (a small skew between the stopper and
 * the supervisor should not discard a real request), but an UNBOUNDED forward
 * window is a wedge with no expiry at all, which is the one thing this whole
 * sentinel must never become. A backward wall-clock jump - a VM resuming, NTP
 * correcting a bad clock - leaves the record dated hours ahead, and nothing else
 * would ever retire it: it stays "recent" for as long as the jump lasts. Every
 * automatic start that had not already seen the record would then read it as a
 * live stop and decline to spawn, holding the machine hostless for exactly that
 * long. That is this ticket's own bug, reintroduced through the guard meant to
 * prevent it.
 *
 * Bounding the forward half caps that at the same five minutes the backward half
 * already accepts.
 */
export function isStopIntentFresh(intent: StopIntent, nowMs: number): boolean {
  const requestedAtMs = Date.parse(intent.requestedAt);
  if (Number.isNaN(requestedAtMs)) return false;
  return Math.abs(nowMs - requestedAtMs) < STOP_INTENT_STALE_MS;
}

function parseStopIntent(value: unknown): StopIntent | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (typeof record.requestedAt !== "string") return null;
  if (typeof record.requestedByPid !== "number") return null;
  if (typeof record.reason !== "string") return null;
  if (!STOP_INTENT_REASONS.has(record.reason)) return null;
  return {
    v: 1,
    requestedAt: record.requestedAt,
    requestedByPid: record.requestedByPid,
    reason: record.reason as StopIntentReason,
  };
}

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
 * Never throws. A stop that cannot write its intent still has to stop; the
 * worst case is one unwanted relaunch, which the supervisor's own budget and
 * incumbent re-check then contain.
 */
export async function writeStopIntent(
  environment: Environment | undefined,
  reason: StopIntentReason,
): Promise<void> {
  const intent: StopIntent = {
    v: 1,
    requestedAt: new Date().toISOString(),
    requestedByPid: process.pid,
    reason,
  };
  try {
    await writeJsonAtomically(hostStopIntentPath(environment), intent);
  } catch {
    // Best effort by design - see the doc comment.
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
 * The supervisor's question, answered in one call: may this crash be recovered,
 * or was the child's death asked for?
 *
 * A torn or malformed file reads as NO intent - biased toward recovering the
 * host, matching `findLiveIncumbentHost`'s own bias. Leaving a machine hostless
 * on a garbled byte is the worse failure.
 */
export async function hasFreshStopIntent(
  environment: Environment | undefined,
  nowMs: number,
): Promise<boolean> {
  const intent = await readStopIntent(environment);
  if (intent === null) return false;
  return isStopIntentFresh(intent, nowMs);
}

export function isStopIntentFresh(intent: StopIntent, nowMs: number): boolean {
  const requestedAtMs = Date.parse(intent.requestedAt);
  if (Number.isNaN(requestedAtMs)) return false;
  // A future-dated stamp (clock skew between the stopper and the supervisor, or
  // a wall-clock jump) still counts as fresh: it is evidence someone asked, and
  // the expiry exists to bound wedges, not to police clocks.
  if (requestedAtMs > nowMs) return true;
  return nowMs - requestedAtMs < STOP_INTENT_STALE_MS;
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

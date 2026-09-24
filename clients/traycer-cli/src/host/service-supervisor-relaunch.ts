import type { Environment } from "../runner/environment";
import { findLiveIncumbentHost } from "./incumbent-check";
import { readLiveSupervisorRun } from "./live-supervisor-run";
import { RELAUNCH_BACKOFF_MS } from "./relaunch-schedule";

// A service start issued while the service's own supervisor is alive.
//
// The supervisor relaunches its crashed child itself, on `RELAUNCH_BACKOFF_MS`.
// A start in that window reads the service as not running (the child is dead)
// and used to publish a host-start adoption proof and ask the service manager
// to start the service. But the service IS running - its supervisor is - so the
// manager starts nothing (`systemctl start` on an active unit, `/Run` on a
// running task with IgnoreNew), and no process could ever consume that proof.
// The supervisor's own relaunch then found a pending proof with somebody
// else's nonce and refused to spawn, spending an attempt per refusal, until
// the starter gave up. Measured on Linux with the desktop's local ensure as the
// starter: one child crash, 113.9 s of downtime, and a relaunch budget spent so
// the NEXT crash left the host down (CRASH-RELAUNCH-ENSURE-RACE).
//
// So a start that finds the service's supervisor alive leaves the relaunch to
// it: no proof, no start. The supervisor owns this fact and already publishes
// it - `supervisor.json` plus `supervisor-run.json` exist only while an
// admitted supervisor runs, carry its pid and start identity, and are removed
// on every exit, "budget exhausted" included - so the next start after an
// exhausted relaunch takes the ordinary path. The supervisor itself keeps
// treating a foreign proof as someone else's exact launch grant; nothing about
// that changes.

/** The service's own supervisor, alive: the process that will relaunch the host. */
export interface LiveServiceSupervisor {
  readonly supervisorPid: number;
}

/**
 * The service's supervisor when it is provably alive, or `null`.
 *
 * "The service's": an admission of `granted` or `unattended`, which only a
 * labelled service launch records - this environment's one service label,
 * since the record lives in that label's host home. A `foreground` run
 * (`traycer host start` in a terminal) is not the service, and a start there
 * is a different question, so it takes the ordinary path. A parked supervisor
 * exits before admission and writes no record, so `--defer-if-parked`
 * starts are untouched.
 *
 * "Provably alive": `readLiveSupervisorRun` - both records naming one pid, and
 * that pid the recorded process instance (pid plus start identity). A dead
 * pid, a pid the OS reused, a record whose identity could not be read, a run
 * state an exit left for its successor, or no record at all all read as
 * `null`: those starts behave exactly as before.
 */
export async function findLiveServiceSupervisor(
  environment: Environment,
): Promise<LiveServiceSupervisor | null> {
  const run = await readLiveSupervisorRun(environment);
  if (run === null || run.admission === "foreground") return null;
  return { supervisorPid: run.supervisorPid };
}

/**
 * How long a start waits for a live supervisor's relaunch: the longest single
 * backoff in its schedule (the start cannot know which attempt it is on), plus
 * room for the relaunched host to boot and answer.
 */
export const SUPERVISOR_RELAUNCH_BOOT_ALLOWANCE_MS = 30_000;
export const SUPERVISOR_RELAUNCH_WAIT_MS =
  Math.max(...RELAUNCH_BACKOFF_MS) + SUPERVISOR_RELAUNCH_BOOT_ALLOWANCE_MS;

export type SupervisorRelaunchWait =
  /** A live host answers its recorded endpoint. */
  | { readonly kind: "host-ready" }
  /**
   * The supervisor exited without bringing the host back (budget exhausted,
   * or it was stopped). Nothing is relaunching any more, so an ordinary start
   * is now the right move.
   */
  | { readonly kind: "supervisor-gone" }
  | { readonly kind: "timed-out" };

export interface SupervisorRelaunchWaitDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
}

export const defaultSupervisorRelaunchWaitDeps: SupervisorRelaunchWaitDeps = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  waitMs: SUPERVISOR_RELAUNCH_WAIT_MS,
  pollIntervalMs: 500,
};

/**
 * Wait for a live supervisor to bring its host back. Must be called OUTSIDE
 * any CLI lock: the relaunch itself contends for the attempt lock
 * (`withSupervisorRelaunchContender`), so a caller waiting under one would hold
 * off the very relaunch it is waiting for.
 */
export async function waitForSupervisorRelaunch(
  environment: Environment,
  deps: SupervisorRelaunchWaitDeps,
): Promise<SupervisorRelaunchWait> {
  const deadline = deps.now() + deps.waitMs;
  for (;;) {
    if ((await findLiveIncumbentHost(environment)) !== null) {
      return { kind: "host-ready" };
    }
    if ((await findLiveServiceSupervisor(environment)) === null) {
      return { kind: "supervisor-gone" };
    }
    if (deps.now() >= deadline) return { kind: "timed-out" };
    await deps.sleep(deps.pollIntervalMs);
  }
}

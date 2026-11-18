import {
  SHUTDOWN_FORCE_EXIT_MS,
  STOP_EXIT_GRACE_MARGIN_MS,
} from "@traycer/protocol/host/lifecycle-constants";
import type { PublishedProcessIdentityVerdict } from "../store/process-identity";

// How long a captured host gets to finish exiting after its stop: the host's
// own force-exit watchdog plus the stop margin, the same derivation as the
// platform stop paths' exit timeout.
export const HOST_EXIT_WAIT_MS =
  SHUTDOWN_FORCE_EXIT_MS + STOP_EXIT_GRACE_MARGIN_MS;
const HOST_EXIT_POLL_MS = 150;

/** A process as it was published: its pid and its recorded start identity. */
export interface PublishedProcess {
  readonly pid: number;
  readonly startIdentity: string | null;
}

/** What a probe established, kept distinct from "it threw". */
export type LivenessObservation = "gone" | "live" | "unknown";

export type ProbeProcessExited = (
  pid: number,
  startIdentity: string | null,
) => Promise<PublishedProcessIdentityVerdict>;

/**
 * Is the published process still alive?
 *
 * Every arm defaults toward `"unknown"`, because `"gone"` is the only answer
 * that licenses acting as if the process exited. In particular "nothing was
 * published" is NOT death: a host that started moments ago and has not
 * written pid.json yet is indistinguishable from a machine with no host.
 *
 * `indeterminate` (the OS probe could not answer) stays unknown for the same
 * reason. Only a verdict that positively places the recorded process in the
 * past - `dead`, or `mismatch` meaning its pid now belongs to something else -
 * counts as gone.
 */
export async function observePublishedProcess(
  probe: ProbeProcessExited,
  published: PublishedProcess | null,
  onProbeError: (err: unknown) => void,
): Promise<LivenessObservation> {
  if (published === null) return "unknown";
  // `readHostPidMetadata` accepts any JSON number, while the identity helper
  // answers `dead` for anything non-integral or <= 0. A record carrying
  // `pid: -5` would otherwise read as proof the host exited. A pid that cannot
  // name a process is unknown, not death.
  if (!Number.isInteger(published.pid) || published.pid <= 0) return "unknown";
  try {
    const verdict = await probe(published.pid, published.startIdentity);
    if (verdict === "dead" || verdict === "mismatch") return "gone";
    if (verdict === "current") return "live";
    return "unknown";
  } catch (err) {
    onProbeError(err);
    return "unknown";
  }
}

/**
 * `observePublishedProcess` that gives a process not yet proven gone until it
 * exits, bounded by the host's own shutdown budget.
 *
 * Only `gone` ends the wait early. `unknown` keeps polling too: the identity
 * probe reads liveness and then the start identity, so a normal exit between
 * the two reads answers `indeterminate` for a process that is dead. Persistent
 * `unknown` still ends at the deadline as `unknown`.
 *
 * A stop cannot be trusted to have waited. A launchd job still on launchd's
 * default 5 s `ExitTimeOut` has only its supervisor SIGKILLed when that runs
 * out; the host child lives on as an orphan through its own graceful shutdown,
 * and has already deleted `pid.json`. Only a pid captured before the stop can
 * still be waited on.
 *
 * The bound is hard: the deadline is monotonic, so a wall-clock correction
 * cannot stretch it, and a probe still running at the deadline is abandoned as
 * `unknown`.
 */
export async function waitForPublishedProcessExit(
  probe: ProbeProcessExited,
  published: PublishedProcess,
  onWaiting: () => void,
  onProbeError: (err: unknown) => void,
): Promise<LivenessObservation> {
  const deadline = performance.now() + HOST_EXIT_WAIT_MS;
  let waiting = false;
  for (;;) {
    let budgetTimer: NodeJS.Timeout | undefined;
    const verdict = await Promise.race([
      observePublishedProcess(probe, published, onProbeError),
      new Promise<LivenessObservation>((resolve) => {
        budgetTimer = setTimeout(
          () => resolve("unknown"),
          Math.max(0, deadline - performance.now()),
        );
      }),
    ]).finally(() => clearTimeout(budgetTimer));
    if (verdict === "gone" || performance.now() >= deadline) return verdict;
    if (!waiting) {
      waiting = true;
      onWaiting();
    }
    await new Promise<void>((resolve) => {
      setTimeout(
        resolve,
        Math.min(HOST_EXIT_POLL_MS, Math.max(0, deadline - performance.now())),
      );
    });
  }
}

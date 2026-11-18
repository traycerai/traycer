import { readPidMetadataState } from "./host-lifecycle";
import { getPublishedProcessIdentityVerdict } from "./process-identity";
import type { HostProcessLiveness } from "./host-recovery-governor";

/**
 * "Does the host process still exist?" - the one question the desktop's
 * automatic recovery is entitled to act on.
 *
 * ### Why existence, and not responsiveness
 *
 * An unreachable endpoint proves only that the host's main thread isn't
 * serving. It cannot distinguish a dead process from one blocked for tens of
 * seconds inside a single un-yieldable `Y.applyUpdate` on a large epic - and
 * v1.1.8-rc.2 resolved that ambiguity by SIGTERM-ing healthy hosts in a loop.
 *
 * The fix is not a finer-grained progress signal but a narrower question.
 * Under the settled policy an existing process is never auto-killed, whatever
 * it is doing, so busy / wedged / deadlocked all take the same path (manual
 * Retry). Existence is therefore the only input any automated decision needs.
 *
 * ### Evidence
 *
 * `pid.json` is written on bind and removed on graceful shutdown, and carries
 * `processStartIdentity` - the kernel's own record of when the publishing
 * process was created. `getPublishedProcessIdentityVerdict` combines a
 * cross-platform liveness probe (`kill(pid, 0)` on POSIX, `tasklist` on
 * Windows) with an exact comparison against that stamp, so a recycled pid now
 * owned by an unrelated process is positively identified rather than mistaken
 * for a living host. That helper is shared with the CLI's `cli-lock`
 * hardening by explicit design, which is why this reuses it instead of
 * calling `process.kill(pid, 0)` directly.
 *
 * It used to compare a wall-clock-derived start time against `startedAt`
 * instead. A `CLOCK_REALTIME` step between publication and this read made
 * that comparison answer `"mismatch"` for a perfectly healthy process, which
 * this function turned into `"dead"` - dropping the shield on exactly the
 * hosts it exists to protect (traycerai/traycer#740).
 */
export async function readPublishedHostProcessLiveness(
  pidMetadataFile: string,
): Promise<HostProcessLiveness> {
  const state = await readPidMetadataState(pidMetadataFile);
  // ENOENT - and ONLY ENOENT - means no process this gate could be protecting:
  // a deliberate stop already unlinked pid.json, and a host that has not bound
  // yet is invisible either way. The monitor's own metadata check decides
  // whether a respawn is even appropriate; here it simply removes the shield.
  if (state.kind === "absent") return "dead";
  // Every other read failure (a partial write, EACCES/EIO/EMFILE) leaves the
  // file's fate UNKNOWN - which is why `readPidMetadataState` keeps the two
  // apart. An inconclusive read must never become permission to restart, for
  // the same reason an inconclusive process probe must not: the transient
  // failures that produce it cluster under exactly the memory pressure a
  // stalled host is already under, so "I couldn't read it" would authorise
  // killing the host precisely when it is most likely to be alive and working.
  if (state.kind !== "parsed") return "alive";

  const verdict = await getPublishedProcessIdentityVerdict(
    state.snapshot.pid,
    state.startIdentity,
  );
  // `mismatch` is a positively identified recycled pid - the process running
  // under that number started AFTER pid.json was published, so it cannot be
  // the host. Treat it as dead so recovery is not blocked forever by an
  // unrelated process.
  if (verdict === "dead" || verdict === "mismatch") return "dead";
  // `current` is alive with identity confirmed. `indeterminate` means the
  // probe could not conclude (no start-time source, a refused `tasklist`), and
  // resolves to alive on purpose: guessing "dead" here kills a host that may
  // be working, while guessing "alive" costs at most a wait for the
  // unreachable-demote window and a manual Retry.
  return "alive";
}

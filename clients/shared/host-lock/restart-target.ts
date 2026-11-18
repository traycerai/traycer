import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import { getPublishedProcessIdentityVerdict } from "./process-identity";

/**
 * The one host process a forced restart was confirmed for: the pid and the
 * start identity it published when the person was offered the restart.
 */
export interface RestartTargetHost {
  readonly pid: number;
  readonly startIdentity: ProcessStartIdentity;
}

/** What `pid.json` says at the moment a bound restart is about to act. */
export type RestartTargetPublished =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | {
      readonly kind: "published";
      readonly pid: number;
      readonly startIdentity: ProcessStartIdentity | null;
    };

/**
 * Whether a forced restart confirmed for `target` may still act, asked at its
 * destructive step and under the lock that step holds. The confirmation was
 * about one process, and every step between it and the kill - the controller's
 * lane, the continuation lookup, the CLI's lifecycle lock wait - is a window in
 * which another actor can publish a healthy replacement. Killing that one would
 * end sessions nobody chose to end.
 *
 * So it refuses when `pid.json` names a different process that is, or may be,
 * running, and when `pid.json` cannot be read (a torn record could be a
 * replacement's). It proceeds when the record still names the target, and
 * when it names nothing live: an absent record, or one whose process is gone
 * or recycled, has no replacement in it to protect, and refusing there would
 * leave a host down that the person asked to bring back.
 */
export async function restartTargetStillCurrent(
  target: RestartTargetHost,
  published: RestartTargetPublished,
): Promise<boolean> {
  if (published.kind === "absent") return true;
  if (published.kind === "unreadable") return false;
  if (
    published.pid === target.pid &&
    published.startIdentity === target.startIdentity
  ) {
    return true;
  }
  const verdict = await getPublishedProcessIdentityVerdict(
    published.pid,
    published.startIdentity,
  );
  return verdict === "dead" || verdict === "mismatch";
}

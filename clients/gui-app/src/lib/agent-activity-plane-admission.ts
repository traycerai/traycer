import type { SchemaVersion } from "@traycer/protocol/framework/index";

/**
 * The `agent.activity.subscribe` minor whose open request carries
 * `plane: "local-only"`.
 */
export const AGENT_ACTIVITY_LOCAL_ONLY_MINOR = 2;

/**
 * Whether a session holding NO cloud verdict may open the activity stream.
 *
 * The released `@1.0`/`@1.1` lines have no way to ask for a plane, so a
 * subscriber gets whichever one the host picked - and when that is the cloud
 * union, the host acquires a per-user Notifications room on the bearer the
 * cloud stopped vouching for. That is why the unverified cohort opens nothing
 * today, and why "the host probably serves local now" is not good enough to
 * change it: the host's selection is a fact about a build, this predicate is
 * the fact about the CONNECTION.
 *
 * `servedBy` on the `state` frame cannot stand in. It reports a choice already
 * made and arrives after the room has been acquired, so by the time it could
 * answer, the spend this gate exists to prevent has happened.
 *
 * FAILS CLOSED on both non-version answers:
 *  - `false` - handshook, no such stream method (a host old enough to predate
 *    the whole activity stream).
 *  - `null` - unknown: no handshake settled yet, or no bound client. The
 *    stream client re-derives on its next handshake and the provider reopens,
 *    so refusing here strands nothing.
 *
 * A `signed-in` session never consults this - it opens on the released line
 * exactly as before, with the plane left to the host.
 */
export function negotiatedActivityServesLocalOnly(
  version: SchemaVersion | null,
): boolean {
  if (version === null) return false;
  return (
    version.major === 1 && version.minor >= AGENT_ACTIVITY_LOCAL_ONLY_MINOR
  );
}

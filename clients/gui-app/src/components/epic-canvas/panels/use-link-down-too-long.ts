import { useEffect, useState } from "react";
import type { EpicSyncPillState } from "@/lib/epic-sync-pill-state";

/**
 * How long the renderer↔host link may stay down before the pill escalates its
 * copy from "Reconnecting…" to "Still reconnecting…".
 *
 * Needed because a stream failure the host cannot classify now closes
 * RETRYABLE and the client reconnects forever - deliberately, so a blip can
 * never strand a surface. The cost is that "Reconnecting…" no longer implies
 * "back in a moment": a workspace that was actually deleted, or a host that is
 * off, produces the same word indefinitely. A minute is long enough that no
 * ordinary drop, wake, or host restart reaches it, and short enough that a
 * user who is waiting learns the retry is not converging.
 *
 * Escalation changes only the WORDS - same amber, same severity. The link
 * genuinely is retrying, and there is nothing for the user to do; presenting
 * that as an error would be a false alarm.
 */
const LINK_DOWN_ESCALATION_MS = 60_000;

/**
 * Whether the renderer↔host link has been down long enough to say so.
 *
 * Time-based rather than attempt-based on purpose: it is the same answer for a
 * local and a remote (multiplexed) session, and the alternative - publishing
 * the transport's private attempt counter - would have widened the status
 * contract of every stream client for a copy change.
 *
 * Takes the RAW derived pill state, never the settled display state: the
 * display settle (`useSyncPillDisplayState`) renames a genuine `synced` to
 * `syncing` until the claim has earned its interval, and this clock treats
 * `syncing` as no-evidence - so the settled state would mask a real recovery
 * that lands (and drops again) inside the hold window.
 */
export function useLinkDownTooLong(state: EpicSyncPillState): boolean {
  const isLinkDown = state === "connecting" || state === "reconnecting";
  // `connected` and `syncing` are the two rungs an open socket can reach with
  // NO application evidence behind it - `connected` when nothing else is
  // known (`deriveEpicSyncPillState` rule 3), `syncing` when renderer-only
  // unsynced work exists but no genuine cloud frame has landed this cycle
  // (rule 2: an open WebSocket proves neither receipt nor persistence).
  // Neither is proof of recovery, and treating either as such is what this
  // clock has to survive: in an ack-then-fatal loop the transport reaches
  // `open` on every handshake before the resolver's retryable close lands -
  // deriving `connected` on a clean epic and `syncing` on one with pending
  // local edits - so resetting on them restarted the minute each cycle and
  // the escalated copy could never appear for the exact loop it was written
  // to explain. Every remaining state either required a genuine cloud-status
  // frame this cycle (`synced`, `hostPending`, the `offline*` family) or is
  // the terminal `offline`, where no retry is running at all - so "not link
  // down and not one of these two" is exactly "application evidence arrived,
  // or the loop ended".
  const hasRecovered =
    !isLinkDown && state !== "connected" && state !== "syncing";
  const [escalated, setEscalated] = useState(false);
  // The clock runs per OUTAGE, entered on the first link-down render and left
  // only on real recovery. Keying the timer on "not recovered" alone armed it
  // during steady neutral `connected` too - an epic that idles there for a
  // minute (an older host, or cloud/dirty evidence that never arrives) had
  // `escalated` pre-set, and the FIRST frame of a genuinely new outage then
  // said "Still reconnecting…" about a retry that had just begun.
  const [inOutage, setInOutage] = useState(false);

  // Render-phase transitions, like the pill's settle hook: the moment the link
  // has genuinely recovered, the escalated copy must not paint even one frame.
  if (isLinkDown && !inOutage) {
    setInOutage(true);
  }
  if (hasRecovered && inOutage) {
    setInOutage(false);
  }
  if (hasRecovered && escalated) {
    setEscalated(false);
  }

  useEffect(() => {
    if (!inOutage) return undefined;
    const timer = setTimeout(() => {
      setEscalated(true);
    }, LINK_DOWN_ESCALATION_MS);
    return () => {
      clearTimeout(timer);
    };
    // Deliberately keyed on the outage BOOLEAN, not on `state`: `connecting`,
    // `reconnecting` and a handshake-only `connected` are ONE outage, and
    // re-running on those flips would restart the clock on a link that never
    // came back (the ack-then-fatal loop reaches `open` on every handshake).
  }, [inOutage]);

  return isLinkDown && escalated;
}

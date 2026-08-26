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
 * `syncing` until the claim has earned its interval, and this clock treats an
 * unevidenced `syncing` as part of the outage - so the settled state would
 * mask a real recovery that lands (and drops again) inside the hold window.
 *
 * `hasFreshCloudSyncStatus` is the same per-cycle evidence bit the pill
 * derivation itself weighs (input 3), NOT re-derived here: it is reset
 * atomically with the transport reaching `open`, so whenever this hook reads
 * it in a non-link-down state it describes the CURRENT subscription cycle.
 */
export function useLinkDownTooLong(
  state: EpicSyncPillState,
  hasFreshCloudSyncStatus: boolean,
): boolean {
  const isLinkDown = state === "connecting" || state === "reconnecting";
  // Recovery is EVIDENCE, not a state label. `connected` and `syncing` are
  // reachable both ways: on every handshake of an ack-then-fatal loop the
  // transport hits `open` before the resolver's retryable close lands
  // (`connected` on a clean epic, `syncing` on one with pending local edits -
  // no genuine cloud frame either way), but ALSO on a legacy host that never
  // sends the `epic.subscribe@1.1` dirty snapshot, where `hostDirtyState`
  // stays `unknown` forever and even a fully evidenced recovery derives
  // `connected`. Classifying by label alone got both wrong in turn: resetting
  // on the labels restarted the clock every handshake lap, and never
  // resetting on them left one legacy-host outage running through a healthy
  // connection, so escalation silently armed and every later brief drop said
  // "Still reconnecting…" from its first frame. The evidence bit separates
  // the two cases exactly: a genuine `cloudSyncStatus` frame landed this
  // cycle, or it did not. Every other non-link-down state either requires
  // that bit by derivation (`synced`, `hostPending`, the `offline*` family)
  // or is the terminal `offline`, where no retry is running at all.
  const hasRecovered =
    !isLinkDown && (state === "offline" || hasFreshCloudSyncStatus);
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

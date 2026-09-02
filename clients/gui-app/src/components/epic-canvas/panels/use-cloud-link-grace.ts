import { useEffect, useState } from "react";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { EpicSyncPillState } from "@/lib/epic-sync-pill-state";

/**
 * How long the host↔cloud link may be down before the pill says so.
 *
 * A collab socket drop is routinely recovered inside this window: the
 * provider re-dials after 1 s, and a fresh backend instance answers auth and
 * sync a few seconds later (a probe against production measured ~7 s from
 * open to `synced`). Painting amber for that interval taught users that the
 * product's connection was broken while, for the states this window covers,
 * the work was already on the host and replayed on reconnect - and during a
 * backend incident it did so several times a minute. Past this window the
 * outage is real enough to name.
 *
 * The window is a delay on NAMING an outage, never on warning about work at
 * risk; {@link CLOUD_LINK_DOWN_STATES} is where that distinction is drawn and
 * is the part to read before widening this.
 *
 * Deliberately longer than the presence plane's `stream-down` grace and far
 * shorter than `LINK_DOWN_ESCALATION_MS`: the first covers a link whose loss
 * makes the spinners stale, the second is the point where "…ing" stops being
 * honest about a retry that is not converging.
 */
export const CLOUD_LINK_GRACE_MS = 15_000;

/**
 * Every verdict that means "the host↔cloud leg is down" while the GUI↔host
 * transport is open.
 *
 * This is the OUTAGE CLOCK's membership, deliberately wider than the set we
 * are allowed to go quiet for. One physical outage produces several of these
 * in sequence - `reconnecting` while idle, `offlineWithUnsavedChanges` the
 * instant the user types, `offlineWithHostPending` once the host acks - and
 * they are all the same outage. Treating any of them as recovery restarts the
 * clock, which is how a continuously-edited Epic could stay quiet through an
 * outage that never ended.
 */
const CLOUD_LINK_DOWN_STATES: ReadonlySet<EpicSyncPillState> =
  new Set<EpicSyncPillState>([
    "connecting",
    "reconnecting",
    "offlineWithUnsavedChanges",
    "offlineWithHostPending",
    "offlineChangesSavedLocally",
  ]);

/**
 * The member of {@link CLOUD_LINK_DOWN_STATES} that may never be quieted, no
 * matter how young the outage is.
 *
 * The line is host ACKNOWLEDGEMENT, not an open transport. An `open` transport
 * proves the socket exists, never that the host received a frame or persisted
 * it. `offlineWithUnsavedChanges` is `deriveEpicSyncPillState`'s divergence
 * arm: renderer-only work still awaiting the host's ack, so closing the window
 * discards it and the amber copy is the only thing saying so. Quieting it for
 * even a second trades the user's data for the pill's calm.
 *
 * The others are on the far side of that line. `offlineWithHostPending` is only
 * reachable with `hasRuntimeDivergence` false, so the host has acked everything
 * this replica knows about and the open question is the host's own durable
 * flush, which no window kept open can help with. `offlineChangesSavedLocally`
 * is the strongest durability claim in the union. `connecting` / `reconnecting`
 * here mean the CLOUD leg is coming up while the transport is open.
 */
const NEVER_QUIET_STATES: ReadonlySet<EpicSyncPillState> =
  new Set<EpicSyncPillState>(["offlineWithUnsavedChanges"]);

/**
 * Whether the cloud leg is down right now - the OUTAGE CLOCK's predicate.
 *
 * Deliberately separate from {@link isCloudOnlyOutage}: this one decides
 * whether the outage is still running, that one decides whether we may be
 * quiet about it. Collapsing the two is the defect this split exists to
 * prevent.
 */
export function isCloudLinkDown(
  state: EpicSyncPillState,
  hostTransportStatus: StreamConnectionStatus,
): boolean {
  return hostTransportStatus === "open" && CLOUD_LINK_DOWN_STATES.has(state);
}

/** Whether this frame is one the grace may render as the neutral `syncing`. */
export function isCloudOnlyOutage(
  state: EpicSyncPillState,
  hostTransportStatus: StreamConnectionStatus,
): boolean {
  return (
    isCloudLinkDown(state, hostTransportStatus) &&
    !NEVER_QUIET_STATES.has(state)
  );
}

/**
 * Holds a cloud-only outage back as the neutral `syncing` verdict until it has
 * lasted {@link CLOUD_LINK_GRACE_MS}, then passes the derived verdict through.
 *
 * `syncing` is the honest placeholder: its copy is "Saving changes", it makes
 * no durability claim (that is `synced`'s alone), and it is exactly what the
 * ladder derives for pending work with no cloud evidence.
 *
 * Two predicates, not one, and the split is the whole point:
 *
 * - {@link isCloudLinkDown} runs the CLOCK. It stays true across every verdict
 *   one outage produces, so the window is measured from when the cloud leg
 *   actually went down. Only a real recovery, or a host-link drop, resets it -
 *   in the render phase, so a recovery never paints one stale amber frame.
 * - {@link isCloudOnlyOutage} decides whether we may be QUIET this frame.
 *   `offlineWithUnsavedChanges` is excluded, so it shows through immediately
 *   while the clock underneath it keeps running.
 *
 * Collapsing them is a live defect, not a tidiness question: during a sustained
 * outage every keystroke briefly derives `offlineWithUnsavedChanges`, so a
 * shared predicate would cancel the timer and clear the latch on each edit, and
 * the host's ack a moment later would start a fresh 15 s of quiet. A
 * continuously-edited Epic would then never reach amber, no matter how long the
 * outage lasted.
 */
export function useCloudLinkGrace(
  derived: EpicSyncPillState,
  hostTransportStatus: StreamConnectionStatus,
): EpicSyncPillState {
  const linkDown = isCloudLinkDown(derived, hostTransportStatus);
  const mayQuiet = isCloudOnlyOutage(derived, hostTransportStatus);
  const [sustained, setSustained] = useState(false);
  if (!linkDown && sustained) {
    setSustained(false);
  }
  useEffect(() => {
    if (!linkDown) return undefined;
    const timer = window.setTimeout(() => {
      setSustained(true);
    }, CLOUD_LINK_GRACE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [linkDown]);
  if (!mayQuiet || sustained) return derived;
  return "syncing";
}

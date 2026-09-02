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
 * The verdicts that describe ONLY the host↔cloud leg AND carry no work this
 * window is the last holder of.
 *
 * The line is host ACKNOWLEDGEMENT, not an open transport. An `open` transport
 * proves the socket exists, never that the host received a frame or persisted
 * it - which is why `offlineWithUnsavedChanges` is deliberately absent. That
 * verdict is `deriveEpicSyncPillState`'s divergence arm: renderer-only work
 * still awaiting the host's ack, so closing the window discards it and the
 * amber copy is the only thing saying so. Quieting it for even a second trades
 * the user's data for the pill's calm.
 *
 * The members that remain are all on the other side of that line:
 *
 * - `connecting` / `reconnecting` here mean the CLOUD leg is coming up while
 *   the transport is open - a host-link drop never reaches this hook.
 * - `offlineWithHostPending` is only reachable with `hasRuntimeDivergence`
 *   false, so the host has acked everything this replica knows about; the open
 *   question is the host's own durable flush, which no window kept open can
 *   help with.
 * - `offlineChangesSavedLocally` is the strongest durability claim in the
 *   union, and today unreachable from the deriver.
 */
const CLOUD_LINK_DOWN_STATES: ReadonlySet<EpicSyncPillState> =
  new Set<EpicSyncPillState>([
    "connecting",
    "reconnecting",
    "offlineWithHostPending",
    "offlineChangesSavedLocally",
  ]);

export function isCloudOnlyOutage(
  state: EpicSyncPillState,
  hostTransportStatus: StreamConnectionStatus,
): boolean {
  return hostTransportStatus === "open" && CLOUD_LINK_DOWN_STATES.has(state);
}

/**
 * Holds a cloud-only outage back as the neutral `syncing` verdict until it has
 * lasted {@link CLOUD_LINK_GRACE_MS}, then passes the derived verdict through.
 *
 * `syncing` is the honest placeholder: its copy is "Saving changes", it makes
 * no durability claim (that is `synced`'s alone), and it is exactly what the
 * ladder derives for pending work with no cloud evidence. The clock runs per
 * OUTAGE: any frame that is not a cloud-only outage resets it in the render
 * phase, so a recovery never paints one stale amber frame and a later drop
 * earns its own full window. Three kinds of frame reset it - a recovery, a
 * host-link drop, and renderer-only work awaiting the host's ack - and the
 * last two are passed straight through, because both are cases where this
 * window may be the only holder of an edit.
 */
export function useCloudLinkGrace(
  derived: EpicSyncPillState,
  hostTransportStatus: StreamConnectionStatus,
): EpicSyncPillState {
  const inOutage = isCloudOnlyOutage(derived, hostTransportStatus);
  const [sustained, setSustained] = useState(false);
  if (!inOutage && sustained) {
    setSustained(false);
  }
  useEffect(() => {
    if (!inOutage) return undefined;
    const timer = window.setTimeout(() => {
      setSustained(true);
    }, CLOUD_LINK_GRACE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [inOutage]);
  if (!inOutage || sustained) return derived;
  return "syncing";
}

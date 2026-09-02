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
 * product's connection was broken while nothing was lost - the host holds
 * every update durably and replays it on reconnect - and during a backend
 * incident it did so several times a minute. Past this window the outage is
 * real enough to name.
 *
 * Deliberately longer than the presence plane's `stream-down` grace and far
 * shorter than `LINK_DOWN_ESCALATION_MS`: the first covers a link whose loss
 * makes the spinners stale, the second is the point where "…ing" stops being
 * honest about a retry that is not converging.
 */
export const CLOUD_LINK_GRACE_MS = 15_000;

/**
 * The verdicts that describe ONLY the host↔cloud leg while the GUI↔host
 * transport is open. Every one of them keeps the user's edits somewhere
 * durable (the host's store) - which is what makes a quiet grace honest here
 * and NOT for a host-link drop, where an unsent edit exists in this window's
 * memory alone and the amber copy is the only thing telling the user so.
 */
const CLOUD_LINK_DOWN_STATES: ReadonlySet<EpicSyncPillState> =
  new Set<EpicSyncPillState>([
    "connecting",
    "reconnecting",
    "offlineWithUnsavedChanges",
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
 * OUTAGE: any frame that is not a cloud-only outage (recovery, or a host-link
 * drop, which bypasses this hook entirely) resets it in the render phase so a
 * recovery never paints one stale amber frame, and a later drop earns its own
 * full window.
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

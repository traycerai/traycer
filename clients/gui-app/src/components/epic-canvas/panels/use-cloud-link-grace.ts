import { useEffect, useState } from "react";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { EpicSyncPillState } from "@/lib/epic-sync-pill-state";

/**
 * How long the host↔cloud link may be down before the pill says so.
 * The window is a delay on NAMING an outage, never on warning about work at risk; {@link CLOUD_LINK_DOWN_STATES} is where that distinction is drawn and is the part to read before widening this.
 */
export const CLOUD_LINK_GRACE_MS = 15_000;

/**
 * Treating any of them as recovery restarts the clock, which is how a continuously-edited Epic could stay quiet through an outage that never ended.
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
 * The members of {@link CLOUD_LINK_DOWN_STATES} that may never be quieted, no matter how young the outage is.
 * The test is not "how bad does this look" but "is this verdict's copy the only thing telling the user to do, or not do, something that protects their work".
 */
const NEVER_QUIET_STATES: ReadonlySet<EpicSyncPillState> =
  new Set<EpicSyncPillState>([
    "offlineWithUnsavedChanges",
    "offlineWithHostPending",
  ]);

/**
 * Whether the cloud leg is down right now - the OUTAGE CLOCK's predicate.
 * Deliberately separate from {@link isCloudOnlyOutage}: this one decides whether the outage is still running, that one decides whether we may be quiet about it.
 */
export function isCloudLinkDown(
  state: EpicSyncPillState,
  hostTransportStatus: StreamConnectionStatus,
): boolean {
  return hostTransportStatus === "open" && CLOUD_LINK_DOWN_STATES.has(state);
}

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
 * Holds a cloud-only outage back as the neutral `syncing` verdict until it has lasted {@link CLOUD_LINK_GRACE_MS}, then passes the derived verdict through.
 * Only a real recovery, or a host-link drop, resets it - in the render phase, so a recovery never paints one stale amber frame. - {@link isCloudOnlyOutage} decides whether we may be QUIET this frame.
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

import type { HostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { ChatDeadTileBannerReason } from "./dead-tile-banner";

/**
 * The reason for a bound host `useHostReachability` reports unreachable.
 *
 * One mapping for every mount that turns the hook's verdict into copy, so no
 * surface can report a `plan-restricted` host (running fine, just with no
 * remote route on this account's plan) to its owner as being off - which is
 * how each of these mounts got it wrong at least once.
 *
 * Its own module rather than a sibling of `ChatDeadTileBanner`: that file is
 * components-only for fast refresh.
 */
export function unreachableHostBannerReason(
  unavailability: HostUnavailability | null,
): ChatDeadTileBannerReason {
  return unavailability === "plan-restricted"
    ? "host-plan-restricted"
    : "host-offline";
}

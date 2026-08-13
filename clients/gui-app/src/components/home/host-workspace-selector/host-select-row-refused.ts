import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { isConfirmedTransportRefusal } from "@traycer-clients/shared/host-client/remote-fetcher";
import { hasReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";

/**
 * Whether a host row in the composer's host-only picker refuses selection.
 *
 * Asked through `isConfirmedTransportRefusal` - the SAME ready-session-aware
 * gate every surface downstream of the pick dials through
 * (`dialableHostEndpoint` / `hostTransportKey`) - not by re-reading the raw
 * `hostUnavailability` verdict here. The two must agree, and a hand-rolled
 * second gate is how they stop agreeing: reading the raw verdict greyed out a
 * cloud-`offline` host this client held a READY live session to (firsthand
 * proof the route works), and refused the fuse-window recovery dial the
 * transport itself would have attempted (`notification-row.tsx`'s
 * `originRefusal` fixed the identical bug class). `indeterminate` stays
 * selectable for the reason the call-site comment has always given: a failed
 * liveness read is not a fact about the host, and a dial that fails is
 * recoverable where an un-pickable row is not.
 *
 * The account-level plan gate rides alongside, not inside: `remoteRestricted`
 * refuses every remote row regardless of its verdict (the remedy is an
 * upgrade, and the row renders the "Paid plan" chip saying so).
 */
export function hostSelectRowRefused(
  host: HostDirectoryEntry,
  remoteRestricted: boolean,
): boolean {
  if (remoteRestricted && host.kind === "remote") return true;
  return isConfirmedTransportRefusal(host, hasReadyRemoteSession(host.hostId));
}

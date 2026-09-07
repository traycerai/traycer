import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  isConfirmedTransportRefusal,
  isRemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { hasReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";
import type { HostTransportEndpoint } from "@traycer-clients/shared/host-transport/ws-rpc-client";

// NUL byte: a separator that cannot appear inside any host field value, so distinct field tuples can never collide into the same key.
// Matches the separator the app-wide `HostStreamProvider` has always used.
const SEPARATOR = String.fromCharCode(0);

/**
 * Canonical stream-transport identity.
 * `indeterminate` still dials; confirmed refusal returns null.
 */
export function hostTransportKey(
  entry: HostDirectoryEntry | null,
): string | null {
  return hostTransportKeyFor(
    entry,
    entry !== null && hasReadyRemoteSession(entry.hostId),
  );
}

/**
 * The parametric core of {@link hostTransportKey}, for the same reason {@link dialableHostEndpointFor} exists: a memoized render path that gates on this key must subscribe to session readiness and thread the current answer through, because the ambient cache.
 */
export function hostTransportKeyFor(
  entry: HostDirectoryEntry | null,
  hasReadySession: boolean,
): string | null {
  if (entry === null || entry.websocketUrl === null) return null;
  if (isConfirmedTransportRefusal(entry, hasReadySession)) return null;
  return [
    entry.hostId,
    entry.kind,
    entry.version ?? "",
    entry.websocketUrl,
  ].join(SEPARATOR);
}

/**
 * The dialable `{ hostId, websocketUrl }` endpoint for a directory entry, or `null` when the host cannot currently be dialed (no `websocketUrl`, or a CONFIRMED refusal).
 * Same dialability rule as `hostTransportKey`, including that a failed liveness read (`indeterminate`) still dials - these two must agree or a live session keeps a key while its re-dials are refused.
 */
export function dialableHostEndpoint(
  entry: HostDirectoryEntry | null,
): HostTransportEndpoint | null {
  return dialableHostEndpointFor(
    entry,
    entry !== null && hasReadyRemoteSession(entry.hostId),
  );
}

/**
 * The parametric core of {@link dialableHostEndpoint}: the caller supplies the ready-session answer instead of this function reading the pull-only cache itself.
 * For a React render path that must UPDATE when a session dies or appears, the ambient read above is a frozen answer (the cache emits no event and changes no directory value) - such callers subscribe (`useRemoteSessionPollReadiness` /.
 */
export function dialableHostEndpointFor(
  entry: HostDirectoryEntry | null,
  hasReadySession: boolean,
): HostTransportEndpoint | null {
  if (entry === null || entry.websocketUrl === null) return null;
  if (isConfirmedTransportRefusal(entry, hasReadySession)) return null;
  return { hostId: entry.hostId, websocketUrl: entry.websocketUrl };
}

/**
 * Identity a long-lived remote-aware stream owner rebuilds on: remote includes publicKey + relay URL; local/mock is hostId+userId only.
 * Remote safety assumes one shared relay attach URL (`remote-fetcher.ts`); a per-instance URL would dispose handles on respawn.
 */
export function remoteAwareOwnerIdentity(
  target: HostDirectoryEntry,
  userId: string,
): string {
  if (isRemoteHostDirectoryEntry(target)) {
    return [
      "remote",
      target.hostId,
      userId,
      target.publicKey,
      target.websocketUrl ?? "",
    ].join(SEPARATOR);
  }
  return ["local", target.hostId, userId].join(SEPARATOR);
}

/**
 * Nullable convenience wrapper over {@link remoteAwareOwnerIdentity} for callers that only have a possibly-absent target / signed-in user on hand.
 * Returns `null` when there is no target or no signed-in user - "not ready to own a stream" for every caller.
 */
export function remoteAwareOwnerIdentityKey(
  target: HostDirectoryEntry | null,
  userId: string | null,
): string | null {
  if (target === null || userId === null) {
    return null;
  }
  return remoteAwareOwnerIdentity(target, userId);
}

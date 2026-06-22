import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostTransportEndpoint } from "@traycer-clients/shared/host-transport/ws-rpc-client";

// NUL byte: a separator that cannot appear inside any host field value, so
// distinct field tuples can never collide into the same key. Matches the
// separator the app-wide `HostStreamProvider` has always used.
const SEPARATOR = String.fromCharCode(0);

/**
 * Canonical value-identity of a host's stream transport.
 *
 * Two `HostDirectoryEntry` objects with identical connection details produce
 * the same key, so a same-content re-emit of the entry - which happens on every
 * `onLocalHostChange` (each one rebuilds `localEntry` and, on desktop, crosses
 * the IPC bridge as a fresh object) - does NOT change the key. Callers that
 * memoize a `WsStreamClient` on this key therefore keep the SAME client instance
 * across benign directory churn, instead of tearing the socket down and
 * rebuilding it.
 *
 * Returns `null` when the host cannot be dialed (no `websocketUrl`) or is not
 * currently `available`; callers treat `null` as "no client".
 *
 * Shared by the app-wide `HostStreamProvider` (via
 * `readHostTransportKey(client.getActiveHost())`) and the per-tab
 * `useHostStreamClientFor`, so both streams compute the same notion of "same
 * transport" from the same fields and cannot drift.
 */
export function hostTransportKey(
  entry: HostDirectoryEntry | null,
): string | null {
  if (entry === null || entry.websocketUrl === null) return null;
  if (entry.status !== "available") return null;
  return [
    entry.hostId,
    entry.kind,
    entry.status,
    entry.version ?? "",
    entry.websocketUrl,
  ].join(SEPARATOR);
}

/**
 * The dialable `{ hostId, websocketUrl }` endpoint for a directory entry, or
 * `null` when the host cannot currently be dialed (no `websocketUrl`, or not
 * `available`). Same dialability rule as `hostTransportKey`.
 *
 * Read LIVE on every (re)dial by the session-owned durable streams (chat /
 * terminal) so a host that respawns on a new `websocketUrl` while the session
 * is warm - with no React tile mounted to recompute a memo - reconnects to the
 * new address instead of retrying the dead one. Mirrors the app-wide stream's
 * `endpoint: () => hostClient.getActiveHost()` live read.
 */
export function dialableHostEndpoint(
  entry: HostDirectoryEntry | null,
): HostTransportEndpoint | null {
  if (entry === null || entry.websocketUrl === null) return null;
  if (entry.status !== "available") return null;
  return { hostId: entry.hostId, websocketUrl: entry.websocketUrl };
}

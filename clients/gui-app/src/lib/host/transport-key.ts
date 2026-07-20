import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
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

/**
 * Canonical identity a long-lived REMOTE-AWARE stream OWNER - the app-wide
 * `HostStreamProvider`, the durable chat/terminal registries, and the epic
 * session mount - rebuilds on (R-1: closing the S1 rotation gap). Mode-aware:
 *
 *  - `remote`: `hostId + userId + publicKey + relay attach identity
 *    (websocketUrl)`, mirroring the `RemoteSessionIdentity` the shared
 *    `(hostId, userId, hostPublicKey, relayAttachUrl)` session cache keys on
 *    (`active-remote-sessions.ts`). Every remote host shares one fixed relay
 *    attach URL, so a same-host public-key rotation (re-enrollment /
 *    corruption recovery - `registerOrAdoptHost` overwrites the key on the
 *    same `hostId`) is a genuine identity change here, not something a URL
 *    move happens to also cover.
 *  - anything else (`local` / `mock`): `hostId + userId` only - a websocket
 *    URL move under a stable `hostId` is healed LIVE by the owned transport's
 *    endpoint re-dial (`dialableHostEndpoint` / `reconnectAll`), not by
 *    rebuilding the owner; folding the URL in here would turn a routine
 *    same-host respawn into full owner churn.
 *
 * Deliberately separate from `hostTransportKey` / `hostStreamTransportKeyFor`,
 * which encode DIALABILITY (can a socket be opened right now - and
 * deliberately omit the public key so a same-content directory re-emit does
 * not churn a live transport). This key encodes IDENTITY (should the owner
 * that decides whether to `acquireRemoteSession` again keep or replace what
 * it holds) and must not be conflated with dialability.
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
 * Nullable convenience wrapper over {@link remoteAwareOwnerIdentity} for
 * callers that only have a possibly-absent target / signed-in user on hand.
 * Returns `null` when there is no target or no signed-in user - "not ready
 * to own a stream" for every caller.
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

import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { TimerHandle } from "../timer-handle";
import { REMOTE_SESSION_LINGER_MS } from "./config";
import type { IRemoteSession } from "./remote-session";

/**
 * Get-or-create cache for the client's persistent remote (E2E) session,
 * keyed by the session's full identity (Architecture §4, fix #4 / S1 -
 * replaces the prior passive live-session-evidence registry). Independently-
 * constructed consumers for the same identity - the RPC messenger, the
 * durable stream client(s), the app-wide client - share exactly ONE
 * `RemoteSession`: one Noise handshake, one attach-grant mint, one relay
 * socket, one re-auth loop per identity, instead of one per consumer.
 *
 * Ref-counted with a keep-warm linger: `acquireRemoteSession` increments the
 * key's live-consumer count and hands back a per-consumer `IRemoteSession`
 * view; calling that view's `close()` releases this consumer's reference
 * rather than tearing down the shared connection directly. When the count
 * reaches zero the session is NOT torn down immediately - it lingers, still
 * connected, for `REMOTE_SESSION_LINGER_MS`, and a re-acquire inside that
 * window adopts the warm session and cancels the teardown (the S1 ticket
 * deferred this; the immediate-teardown behavior made every consumer
 * rebuild - a panel open, the messenger's single binding slot flipping to a
 * local host and back - pay a fresh mint + dial + handshake, and could tear
 * a dial down mid-establishment). Only when the window expires with the
 * count still zero is the session closed for real and the entry dropped; a
 * later acquire then constructs a FRESH session via the caller's factory -
 * nothing keeps a torn-down session reachable.
 */

/**
 * The session's full identity: everything that determines which physical
 * E2E connection a consumer should share. Mirrors the render layer's own
 * transport-identity keys (`hostTransportKey` / `remoteTransportKey`) so the
 * cache and the render layer agree by construction - a host static-key
 * rotation or a relay endpoint move is a genuine identity change, not a
 * detail the cache can serve stale (a `RemoteSession` is a Noise channel
 * pinned to one host public key over one relay attach URL; re-keying without
 * this would hand a consumer a session that can never re-handshake against
 * the new key).
 */
export interface RemoteSessionIdentity {
  readonly hostId: string;
  readonly userId: string;
  readonly hostPublicKey: string;
  readonly relayAttachUrl: string;
  /**
   * What this consumer needs a session to do with an `UNAUTHORIZED` fatal.
   * Part of the identity because it is not a preference the cache may serve
   * from a session built under the OTHER policy:
   *
   *  - `"revalidate"` (a `RemoteSessionOptions.auth` revalidator) redials and
   *    RE-SENDS every live subscription, which is right for the warm
   *    chat/terminal/epic sessions - a re-subscribe just re-snapshots.
   *  - `"terminal"` (`auth: null`) is what `openOneShotStreamTransport` picks
   *    deliberately for a side-effecting one-shot (Settings ▸ Worktrees
   *    `worktree.deleteByPath`): re-sending that subscribe would re-run the
   *    teardown script and git removal.
   *
   * Sharing across the two is unsafe in BOTH directions - a one-shot adopting
   * a revalidating session silently regains the replay it opted out of, and a
   * durable stream adopting a terminal session silently loses auth recovery -
   * and the factory that would have applied the policy never runs on a cache
   * hit. So the two never share a physical connection.
   */
  readonly authRecovery: "revalidate" | "terminal";
}

interface CacheEntry {
  readonly session: IRemoteSession<
    VersionedRpcRegistry,
    VersionedStreamRpcRegistry
  >;
  refCount: number;
  /** Armed while the entry lingers at refCount 0; null while consumers hold it. */
  lingerTimer: TimerHandle | null;
}

// Matches the `TRANSPORT_KEY_SEPARATOR` convention elsewhere in this codebase
// (`host-messenger.ts`, `use-host-stream-client-for.ts`): a NUL never
// appears in these identity fields, so joining with it cannot collide two
// distinct identities onto the same string key.
const KEY_SEPARATOR = "\u0000";

const entriesByKey = new Map<string, CacheEntry>();

/**
 * `hostId` is joined FIRST and unconditionally - `keyHostId`/
 * `hasReadyRemoteSession` parse the key's hostId prefix up to the first
 * separator, independent of how many further identity fields follow it.
 */
export function remoteSessionCacheKey(identity: RemoteSessionIdentity): string {
  return [
    identity.hostId,
    identity.userId,
    identity.hostPublicKey,
    identity.relayAttachUrl,
    identity.authRecovery,
  ].join(KEY_SEPARATOR);
}

/**
 * Returns the live session cached for `identity`, incrementing its ref-count
 * and handing back a fresh per-consumer view onto it. `createSession` runs at
 * most once per cache miss - a cache hit never calls it. A change to ANY
 * identity field (not just `hostId`/`userId`) is a cache miss: the render
 * layer already treats a `publicKey`/`websocketUrl` change as identity-
 * affecting and rebuilds its transport, so a stale cache hit on the OLD
 * identity would otherwise hand the new transport a session that can never
 * complete a Noise handshake against the host's new key.
 *
 * The returned view's `close()` releases this ONE reference; every other
 * method delegates straight through to the shared `RemoteSession`. When a
 * `close()` brings the key's count to zero, the shared session enters the
 * keep-warm linger (`REMOTE_SESSION_LINGER_MS`) instead of closing: it stays
 * cached and connected so a prompt re-acquire adopts it warm, and only the
 * window expiring with no consumers closes it for real.
 */
export function acquireRemoteSession<
  RpcRegistry extends VersionedRpcRegistry,
  StreamRegistry extends VersionedStreamRpcRegistry,
>(
  identity: RemoteSessionIdentity,
  createSession: () => IRemoteSession<RpcRegistry, StreamRegistry>,
): IRemoteSession<RpcRegistry, StreamRegistry> {
  const key = remoteSessionCacheKey(identity);
  let entry = entriesByKey.get(key);
  if (entry !== undefined && entry.session.isClosed()) {
    // A terminally-closed session (a session-level fatal closes it in place,
    // underneath every consumer - or while lingering with none) must never be
    // handed to a NEW acquirer: `start()` no-ops once closed, so the view
    // could never carry traffic again. Evict the dead entry so this acquire
    // constructs a fresh session; its remaining views release against the
    // entry captured at THEIR acquire time (the identity check in `release`),
    // so a late release can never touch the successor's refCount, and the
    // evicted entry's still-pending linger timer (if any) finds itself
    // superseded and does nothing.
    if (entry.lingerTimer !== null) {
      clearTimeout(entry.lingerTimer);
    }
    entriesByKey.delete(key);
    entry = undefined;
  }
  if (entry === undefined) {
    closeSupersededIdentities(identity, key);
    entry = { session: createSession(), refCount: 0, lingerTimer: null };
    entriesByKey.set(key, entry);
  }
  if (entry.lingerTimer !== null) {
    // Warm hit: the entry was lingering at refCount 0. Adopting it cancels
    // the pending teardown - this consumer now owns a live, possibly
    // already-ready session with no new mint/dial/handshake.
    clearTimeout(entry.lingerTimer);
    entry.lingerTimer = null;
  }
  entry.refCount += 1;

  // Sound: a given cache key is only ever populated - and read back - by
  // callers building the session from this app's one production registry
  // pair (`HostRpcRegistry`/`HostStreamRpcRegistry`), so re-specializing the
  // wide cache entry to this call's own generic parameters is safe.
  const session = entry.session as IRemoteSession<RpcRegistry, StreamRegistry>;

  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    // Identity check, not a key-string relookup: if THIS entry has already
    // been torn down and a fresh one re-created under the same key, a late
    // release (e.g. from a discarded render's view) must never touch the
    // successor's refCount.
    if (entriesByKey.get(key) !== entry) {
      return;
    }
    entry.refCount -= 1;
    if (entry.refCount > 0) {
      return;
    }
    // Keep-warm: defer the real teardown by the linger window. The entry
    // stays in the map (so `hasReadyRemoteSession` keeps reporting honest
    // liveness and a re-acquire adopts it), and the session keeps its own
    // reconnect/re-auth machinery running - bounded by the window, so an
    // abandoned session cannot dial forever.
    entry.lingerTimer = setTimeout(() => {
      entry.lingerTimer = null;
      // Superseded (evicted after a fatal, then re-created) or re-acquired
      // entries are not this timer's to tear down.
      if (entriesByKey.get(key) !== entry || entry.refCount > 0) {
        return;
      }
      entriesByKey.delete(key);
      entry.session.close();
    }, REMOTE_SESSION_LINGER_MS);
  };

  return {
    start: () => session.start(),
    isClosed: () => session.isClosed(),
    isReady: () => session.isReady(),
    sendUnary: (method, params) => session.sendUnary(method, params),
    subscribe: (method, params) => session.subscribe(method, params),
    subscribeWithParamsProvider: (method, paramsProvider) =>
      session.subscribeWithParamsProvider(method, paramsProvider),
    notifyBearerRotated: () => session.notifyBearerRotated(),
    onClosed: (listener) => session.onClosed(listener),
    subscribeAvailabilityRecovered: (listener) =>
      session.subscribeAvailabilityRecovered(listener),
    close: release,
  };
}

/**
 * Closes any zero-reference entry this acquire SUPERSEDES: same host, same
 * user, same recovery policy, but a different host public key or relay attach
 * URL - i.e. the host re-keyed or its endpoint moved, and the render layer has
 * just rebuilt its transport onto the new identity.
 *
 * Keep-warm exists so a prompt RE-ACQUIRE of the same identity is free. A
 * superseded identity can never be re-acquired (its key embeds the old public
 * key), so lingering buys nothing and costs two things: an authenticated relay
 * socket held open for the rest of the window, and - because
 * {@link hasReadyRemoteSession} matches on `hostId` alone - live-session
 * evidence attributed to a host whose current identity may still be dialing or
 * already failing, which is enough to render it Online and pass its scope gate.
 *
 * Entries at refCount > 0 are left alone: a consumer still holds them, and
 * tearing a live session out from under it is not this function's call.
 */
function closeSupersededIdentities(
  identity: RemoteSessionIdentity,
  currentKey: string,
): void {
  for (const [key, entry] of [...entriesByKey]) {
    if (key === currentKey || entry.refCount > 0) {
      continue;
    }
    const [hostId, userId, , , authRecovery] = key.split(KEY_SEPARATOR);
    if (
      hostId !== identity.hostId ||
      userId !== identity.userId ||
      authRecovery !== identity.authRecovery
    ) {
      // A different user or a different recovery policy - a legitimately
      // independent session for the same host, not a superseded one. (The two
      // fields skipped above are exactly the ones that must DIFFER for this to
      // be a supersession, and `key !== currentKey` already establishes that.)
      continue;
    }
    if (entry.lingerTimer !== null) {
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = null;
    }
    entriesByKey.delete(key);
    entry.session.close();
  }
}

/**
 * True if the cached session for `hostId` (any signed-in user) is currently
 * ready. A lingering keep-warm session (refCount 0, window not yet expired)
 * counts: it is a live, attached connection, so it is honest evidence - and a
 * session whose identity has been SUPERSEDED is closed at that moment (see
 * {@link closeSupersededIdentities}) rather than left to answer for the host
 * it can no longer serve.
 */
export function hasReadyRemoteSession(hostId: string): boolean {
  for (const [key, entry] of entriesByKey) {
    if (keyHostId(key) === hostId && entry.session.isReady()) {
      return true;
    }
  }
  return false;
}

/** Test-only: the number of live consumer references held for `identity`. */
export function remoteSessionRefCountForTest(
  identity: RemoteSessionIdentity,
): number {
  return entriesByKey.get(remoteSessionCacheKey(identity))?.refCount ?? 0;
}

function keyHostId(key: string): string {
  const separatorIndex = key.indexOf(KEY_SEPARATOR);
  return separatorIndex === -1 ? key : key.slice(0, separatorIndex);
}

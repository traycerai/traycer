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
  /**
   * Which auth context the session's creator was wired to - see
   * `createRemoteHostTransport`, which derives it from the bearer source.
   *
   * Part of the identity for the same reason as `authRecovery`, and it is the
   * keep-warm linger that makes it load-bearing. The factory captures its
   * creator's bearer provider, grant provider and auth revalidator, and a
   * cache hit never re-runs it. Without the linger those closures could only
   * ever be adopted by a consumer overlapping in time with the creator, so a
   * live creator vouched for them. A lingering session has NO consumers, so it
   * can outlive the context that built it: sign out and back into the same
   * account inside the window and every field above is identical, yet the
   * adopted session still mints through the previous context's released
   * credential lease. It fails closed rather than reusing a stale credential
   * (`CredentialLease.getBearerToken()` throws once released, which the
   * transport maps to a pre-dial failure) - but it fails PERMANENTLY: the
   * socket may look fine until its next drop and then never re-attach.
   *
   * Keyed on the bearer SOURCE, not the token: same-user refresh rotates the
   * lease in place (`RequestContextProvider.rotateCurrentBearer`) and does not
   * emit a fresh context, so a token refresh keeps sharing the connection.
   * Only a genuine context transition re-keys, which is exactly when adopting
   * would be wrong.
   */
  readonly authEpoch: string;
}

interface CacheEntry {
  readonly session: IRemoteSession<
    VersionedRpcRegistry,
    VersionedStreamRpcRegistry
  >;
  /**
   * The identity this entry was built for, kept as fields rather than re-parsed
   * out of the map key. The key is a positional join, so reading identity back
   * out of it means index-counting that silently rots the moment the key gains
   * a field - which it did, when `authRecovery` was added.
   */
  readonly identity: RemoteSessionIdentity;
  refCount: number;
  /** Armed while the entry lingers at refCount 0; null while consumers hold it. */
  lingerTimer: TimerHandle | null;
  /**
   * Set once this entry's identity has been SUPERSEDED - the host re-keyed or
   * moved, or the auth context that built it was retired, and a newer identity
   * for the same host and user has been acquired since (whatever recovery
   * policy that acquire wanted; see {@link closeSupersededIdentities}). Sticky:
   * supersession is a fact about the identity, not about the successor's
   * health, so a successor that later dies does not make this session current
   * again - its key still embeds the OLD public key or the retired epoch, so it
   * can never re-handshake, or never re-mint, and can never be re-acquired by
   * the render layer.
   *
   * A marked entry is barred from BOTH things the cache does for a live entry:
   * it never lingers (see `release`) and it never answers
   * {@link hasReadyRemoteSession} for its host. Needed because
   * {@link closeSupersededIdentities} can only close the entries that are free
   * AT THAT MOMENT - one still held by a consumer has to carry the verdict
   * forward itself, since nothing sweeps again after it is released.
   */
  superseded: boolean;
}

// Matches the `TRANSPORT_KEY_SEPARATOR` convention elsewhere in this codebase
// (`host-messenger.ts`, `use-host-stream-client-for.ts`): a NUL never
// appears in these identity fields, so joining with it cannot collide two
// distinct identities onto the same string key.
const KEY_SEPARATOR = "\u0000";

const entriesByKey = new Map<string, CacheEntry>();

/**
 * The map key, and nothing else: every consumer that needs an identity FIELD
 * back reads `CacheEntry.identity` instead of parsing this string, so fields
 * may be added here without any positional reader to keep in step.
 */
export function remoteSessionCacheKey(identity: RemoteSessionIdentity): string {
  return [
    identity.hostId,
    identity.userId,
    identity.hostPublicKey,
    identity.relayAttachUrl,
    identity.authRecovery,
    identity.authEpoch,
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
    entry = {
      session: createSession(),
      identity,
      refCount: 0,
      lingerTimer: null,
      superseded: false,
    };
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
    if (entry.superseded) {
      // Marked while this consumer still held it: the host re-keyed or moved
      // underneath a live reference, so `closeSupersededIdentities` could not
      // take it then and nothing sweeps again now. Close it HERE, at the only
      // other moment it is free. Lingering would buy nothing that keep-warm
      // exists for - this key can never be re-acquired - and would cost the
      // two things that motivated closing superseded identities in the first
      // place: an authenticated relay socket held open for the rest of the
      // window, and a ready session answering `hasReadyRemoteSession` for a
      // host whose CURRENT identity may still be dialing or already failing.
      entriesByKey.delete(key);
      entry.session.close();
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
 * Closes any zero-reference entry this acquire SUPERSEDES: same host and user,
 * but a different host public key or relay attach URL - i.e. the host re-keyed
 * or its endpoint moved, and the render layer has just rebuilt its transport
 * onto the new identity.
 *
 * Supersession is a property of the PHYSICAL identity (`hostPublicKey` +
 * `relayAttachUrl`) and is judged independently of `authRecovery`. The two are
 * easy to conflate and mean opposite things:
 *
 *  - same physical identity, different policy -> legitimately independent. The
 *    one-shot and durable sessions deliberately do not share a connection, and
 *    both are current. Leave it alone.
 *  - different physical identity -> superseded, WHATEVER the policy. A ready
 *    one-shot (`terminal`) session lingering under the old public key is just
 *    as stale as a durable one, and {@link hasReadyRemoteSession} matches on
 *    `hostId` across all policies - so skipping it because the acquiring
 *    consumer happened to want the OTHER policy leaves it reporting the host
 *    Online while the current identity is still dialing or already failing.
 *
 * Keep-warm exists so a prompt RE-ACQUIRE of the same identity is free. A
 * superseded identity can never be re-acquired (its key embeds the old public
 * key), so lingering buys nothing and costs an authenticated relay socket held
 * open for the rest of the window on top of the false liveness evidence.
 *
 * A session a consumer still HOLDS is not torn out from under it - that is not
 * this function's call - but it is still marked {@link CacheEntry.superseded},
 * because this is the only sweep there will ever be: supersession is detected
 * on the NEWER identity's cache miss, which has already happened by the time
 * that consumer releases. Without the mark, the release path would linger an
 * obsolete ready session for the full window and keep answering for the host.
 */
function closeSupersededIdentities(
  identity: RemoteSessionIdentity,
  currentKey: string,
): void {
  for (const [key, entry] of [...entriesByKey]) {
    if (key === currentKey) {
      continue;
    }
    if (
      entry.identity.hostId !== identity.hostId ||
      entry.identity.userId !== identity.userId
    ) {
      // A different host, or a different signed-in user on this host: an
      // independent session, and not ours to judge.
      continue;
    }
    if (
      entry.identity.hostPublicKey === identity.hostPublicKey &&
      entry.identity.relayAttachUrl === identity.relayAttachUrl &&
      entry.identity.authEpoch === identity.authEpoch
    ) {
      // Same physical identity AND the same auth context. `key !== currentKey`
      // therefore means it differs ONLY in `authRecovery` - the deliberate
      // one-shot/durable split, both current, neither superseding the other.
      //
      // The epoch has to be equal for that reasoning to hold. Two entries from
      // DIFFERENT contexts are not parallel: the older one belongs to a signed-
      // out session whose credential lease is gone. Leaving it current would
      // reproduce, through the auth dimension, exactly what supersession fixes
      // for a rotated key - `hasReadyRemoteSession` matches on `hostId` alone,
      // so the retired entry would report the host Online and pass its scope
      // gate while the live context is still dialing or has already failed,
      // and would hold an obsolete authenticated connection open for the rest
      // of the window.
      continue;
    }
    entry.superseded = true;
    if (entry.refCount > 0) {
      // Still held. `release` closes it the moment its last consumer lets go.
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
 * counts: it is a live, attached connection, so it is honest evidence.
 *
 * A SUPERSEDED entry never counts, whoever still holds it. Free ones are gone
 * from the map already (see {@link closeSupersededIdentities}); a held one is
 * still here but is pinned to a public key or relay URL the host has moved off,
 * or to a signed-out auth context, so reporting the host Online off it would be
 * attributing liveness to a connection the host's CURRENT identity does not
 * have - exactly the thing that renders a still-dialing (or already failing)
 * host as Online and passes its scope gate. Ignoring it costs only a brief
 * false negative while the current identity finishes dialing, which is the safe
 * direction.
 */
export function hasReadyRemoteSession(hostId: string): boolean {
  for (const entry of entriesByKey.values()) {
    if (
      entry.identity.hostId === hostId &&
      !entry.superseded &&
      entry.session.isReady()
    ) {
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

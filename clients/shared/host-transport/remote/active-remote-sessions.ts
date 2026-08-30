import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { TimerHandle } from "../timer-handle";
import type { RequestOfMethod, ResponseOfMethod } from "../host-messenger";
import type { ReconnectAllOptions } from "../host-stream-client";
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
   *
   * WHICH revalidator object wired a `"revalidate"` session is deliberately
   * NOT part of the identity: every production revalidator wraps the same
   * per-mount auth service and funnels into its single-flight revalidation,
   * so two consumers sharing one session share one recovery flow by
   * construction. A consumer wiring a revalidator with genuinely different
   * behavior must not share a session with the default ones - that would be
   * the moment to widen this field, not a reason to key on object identity.
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
   * adopted session's closures were wired by the RETIRED context. What that
   * does depends on the consumer's bearer thunk: one that captured the old
   * lease object fails closed but PERMANENTLY (`getBearerToken()` throws once
   * released - the socket may look fine until its next drop and then never
   * re-attach), while a live-read thunk silently heals onto a context the
   * session was never keyed or vouched for. Both are wrong things to hand a
   * new context, which is why the epoch is part of the identity.
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
  /**
   * Whether the process-wide proactive sweep may touch this entry at all -
   * poke its socket on a wake, or force-drop it after a long background.
   *
   * Recorded at acquire time from the consumer's replay contract, and
   * deliberately DISTINCT from `identity.authRecovery`: that field describes
   * what an UNAUTHORIZED fatal does, while this one describes whether a
   * reconnect's subscribe replay is safe to provoke. Today the two correlate
   * (the one-shot `worktree.deleteByPath` transport is the only `terminal`
   * consumer and the only replay-unsafe one), but a start->observe one-shot
   * stream could be replay-safe while still wanting terminal auth - so
   * safety is stated by the acquirer, not inferred.
   *
   * Stable per cached identity in practice: replay-unsafe consumers never
   * share an identity with durable ones (their `authRecovery` differs, which
   * is part of the cache key), so a cache hit cannot flip this.
   *
   * An ineligible entry is skipped by the sweep in BOTH modes. Its own
   * passive reconnect after a genuine transport loss keeps its existing
   * contract - this flag only bars the runtime from CAUSING that loss (or
   * hastening its discovery) on a socket that was healthy.
   */
  readonly proactiveWakeEligible: boolean;
  refCount: number;
  /**
   * Outstanding STATUS-POLL borrows (see {@link tryAcquireReadyRemoteSession}),
   * counted separately from `refCount` on purpose - this is the whole
   * non-lingering guarantee, so it is worth stating why a second counter beats
   * reusing the first.
   *
   * A borrow that incremented `refCount` would be indistinguishable from a
   * consumer, and the keep-warm teardown is scheduled from whoever brings the
   * count to zero. So owner-releases-then-poller-releases would arm the linger
   * at the POLLER's release: the session would outlive its last real consumer
   * by however long the poll happened to hold it, plus the full window. That is
   * exactly "prolong a session for status", and no amount of care at the call
   * site prevents it - the arithmetic does it.
   *
   * Keeping borrows out of `refCount` makes it unrepresentable instead:
   * `release`, `closeSupersededIdentities` and the linger timer never read this
   * field, so an outstanding borrow cannot arm, cancel, delay or extend a
   * teardown. A borrow whose entry dies underneath it simply fails its in-flight
   * request, which is the correct outcome for a status read (the caller renders
   * unknown; it never renders failure).
   *
   * It is counted rather than ignored so a borrow can be revoked at `release()`
   * and so a leak is observable to a test.
   */
  borrowCount: number;
  /** Armed while the entry lingers at refCount 0; null while consumers hold it. */
  lingerTimer: TimerHandle | null;
  /**
   * Set once this entry's identity has been SUPERSEDED - the host re-keyed or
   * moved, or the auth context (credential lease or signed-in user) that built
   * it was retired, and a newer identity for the same host has been acquired
   * since (whatever recovery policy that acquire wanted; see
   * {@link closeSupersededIdentities}). Sticky:
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
  /**
   * Tears down this entry's readiness wiring (its `onClosed` and
   * `subscribeAvailabilityRecovered` subscriptions). Held per entry because
   * an entry can be dropped from four different places.
   */
  disposeReadinessWiring: () => void;
}

/**
 * PUSH REPLACES POLL (redesign P4.1 / connection-registry §6).
 *
 * `hasReadyRemoteSession` used to be read by two 1s `setInterval`s - one
 * per-host, one fleet-shaped - because this cache is a plain map with no
 * change events, so a React consumer had no way to learn that a session had
 * become ready except by asking again. Two app-wide timers, running for the
 * life of the window, to observe a value that changes a handful of times a
 * session.
 *
 * The cache now says so instead. Every transition that can change any host's
 * answer notifies: a session reaching a ready boundary (which
 * `subscribeAvailabilityRecovered` reports for the clean FIRST open too, not
 * only for recoveries - see `maybeReachReadyBoundary`), a session closing,
 * an entry being superseded or retired, and the keep-warm linger expiring.
 *
 * Delivery is coalesced onto a microtask, and that is load-bearing rather
 * than tidy: `close()` fires `onClosed` listeners SYNCHRONOUSLY from inside
 * this module's own mutation paths, so a synchronous notify would re-enter
 * the cache mid-mutation - the same hazard the insert-before-sweep ordering
 * in `acquireRemoteSession` exists for. Coalescing also collapses the burst
 * a single sweep produces (one supersede can close several entries) into one
 * wake.
 */
const readinessListeners = new Set<() => void>();
let readinessNotifyScheduled = false;

function notifyReadinessChanged(): void {
  if (readinessNotifyScheduled) {
    return;
  }
  readinessNotifyScheduled = true;
  queueMicrotask(() => {
    readinessNotifyScheduled = false;
    for (const listener of [...readinessListeners]) {
      listener();
    }
  });
}

/**
 * Subscribes to "some host's ready-session answer may have changed". Coarse
 * on purpose: consumers ask about specific hosts through
 * {@link hasReadyRemoteSession} at read time, and the alternative - per-host
 * subscriptions into a cache keyed by full session identity, where one host
 * can hold several entries under different policies - would key the
 * subscription on something other than what the consumer asks about.
 */
export function subscribeRemoteSessionReadiness(
  listener: () => void,
): () => void {
  readinessListeners.add(listener);
  return () => {
    readinessListeners.delete(listener);
  };
}

/** Test-only: drops every readiness subscriber (suites share the module). */
export function resetRemoteSessionReadinessListenersForTest(): void {
  readinessListeners.clear();
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
/**
 * What the acquiring consumer promises the cache about the session it is
 * claiming - facts the cache needs when it later acts on HELD entries without
 * any consumer in the call stack (the process-wide wake sweep).
 */
export interface RemoteSessionAcquirePolicy {
  /** See {@link CacheEntry.proactiveWakeEligible}. */
  readonly proactiveWakeEligible: boolean;
}

export function acquireRemoteSession<
  RpcRegistry extends VersionedRpcRegistry,
  StreamRegistry extends VersionedStreamRpcRegistry,
>(
  identity: RemoteSessionIdentity,
  policy: RemoteSessionAcquirePolicy,
  createSession: () => IRemoteSession<RpcRegistry, StreamRegistry>,
): IRemoteSession<RpcRegistry, StreamRegistry> {
  const key = remoteSessionCacheKey(identity);
  let entry = entriesByKey.get(key);
  if (entry !== undefined && (entry.session.isClosed() || entry.superseded)) {
    // Two states a NEW acquirer must never adopt:
    //
    // Closed: a terminally-closed session (a session-level fatal closes it in
    // place, underneath every consumer - or while lingering with none) can
    // never carry traffic again (`start()` no-ops once closed).
    //
    // Superseded: the sweep's verdict on this entry is sticky - it closes at
    // its first free moment. Adopting it would extend its refCount, deferring
    // that moment indefinitely and carrying new work on the very connection
    // the verdict retired. This acquire is instead a fresh claim that the
    // identity is CURRENT (the same acquirer-is-newest premise the sweep
    // itself rests on - e.g. the host's key rotated back, or a retired
    // context's acquire was already refused upstream by the bearer gate), so
    // it gets a fresh session under a fresh entry.
    //
    // Either way: evict. The displaced entry's remaining views release
    // against the entry captured at THEIR acquire time, closing it when the
    // last one lets go (see `release`), so a late release can never touch
    // the successor's refCount, and the evicted entry's still-pending linger
    // timer (if any) finds itself superseded and does nothing.
    if (entry.lingerTimer !== null) {
      clearTimeout(entry.lingerTimer);
    }
    entry.disposeReadinessWiring();
    entriesByKey.delete(key);
    entry = undefined;
    notifyReadinessChanged();
  }
  if (entry === undefined) {
    const session = createSession();
    const created: CacheEntry = {
      session,
      identity,
      proactiveWakeEligible: policy.proactiveWakeEligible,
      refCount: 0,
      borrowCount: 0,
      lingerTimer: null,
      superseded: false,
      disposeReadinessWiring: () => undefined,
    };
    // This session's two readiness edges, wired ONCE per entry rather than
    // once per consumer: a ready boundary (which `maybeReachReadyBoundary`
    // emits for the clean FIRST open, not only for recoveries) and the
    // terminal close. Wired BEFORE the sweep below, whose `close()` calls
    // fire listeners synchronously - an entry that could be closed before it
    // was wired would never report its own death.
    const offRecovered = session.subscribeAvailabilityRecovered(
      notifyReadinessChanged,
    );
    const offClosed = session.onClosed(notifyReadinessChanged);
    // The DOWN edge, and the reason this trio is not a pair. Both wirings
    // above point UP - a session becoming ready, and a session dying - so a
    // relay `host_detached` or a drop into `reconnecting` flipped
    // `isReady()` false with nobody told, and every subscriber held its
    // previous `true` for the whole outage. If the reconnect then succeeded
    // they never observed the loss at all.
    //
    // The general form, because the diff that caused it showed no deletion:
    // this wiring REPLACED two 1-second polls (see the note above), and a
    // poll has no direction - it answered "did this stop being ready" by
    // asking again. A poll-to-event migration has to enumerate transitions in
    // BOTH directions, and nothing in the diff will tell you which one was
    // dropped.
    const offReadinessLost = session.subscribeReadinessLost(
      notifyReadinessChanged,
    );
    created.disposeReadinessWiring = () => {
      offRecovered();
      offClosed();
      offReadinessLost();
    };
    entry = created;
    // Insert BEFORE sweeping. The sweep's `close()` calls fire `onClosed`
    // listeners synchronously; a listener that re-entered this function for
    // the same identity must find this entry (a hit) rather than build a
    // second session the outer frame would then overwrite - orphaning a
    // live, never-closable socket. The sweep already excludes `currentKey`,
    // so it never closes the entry it is sweeping on behalf of.
    entriesByKey.set(key, entry);
    closeSupersededIdentities(identity, key);
  }
  if (entry.lingerTimer !== null) {
    // Warm hit: the entry was lingering at refCount 0. Adopting it cancels
    // the pending teardown - this consumer now owns a live, possibly
    // already-ready session with no new mint/dial/handshake.
    clearTimeout(entry.lingerTimer);
    entry.lingerTimer = null;
  }
  entry.refCount += 1;
  if (entry.refCount === 1) {
    // BORROWABILITY changed (0 -> 1 consumers, and any linger just cancelled):
    // this entry has just gained a live non-poller owner, which is the whole
    // admission test for {@link tryAcquireReadyRemoteSession}. The pre-existing
    // wirings all report readiness of the SESSION; this one reports a change in
    // who holds it, which `hasReadyRemoteSession` does not care about and the
    // borrowable predicate does.
    //
    // Adding a notify is safe by construction: delivery is coalesced onto a
    // microtask and every subscriber compares a derived stamp with `Object.is`,
    // so a wake that moves no host's answer re-renders nothing (the same
    // property the push-replaces-poll note above relies on).
    notifyReadinessChanged();
  }

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
    // Always the CAPTURED entry's refCount, never a key-string relookup: if a
    // fresh entry has been re-created under the same key, a late release
    // (a discarded render's view, or a holder of an entry the superseded
    // eviction above displaced) must never touch the successor's refCount.
    entry.refCount -= 1;
    if (entry.refCount > 0) {
      return;
    }
    if (entriesByKey.get(key) !== entry) {
      // Displaced from the map while still held (the eviction branch in
      // `acquireRemoteSession` - closed or superseded - is the only path
      // that removes a held entry). Nothing will ever hand this entry out
      // again and no sweep or timer can see it, so the last holder closes
      // it here. Idempotent when the session was already closed.
      entry.disposeReadinessWiring();
      entry.session.close();
      notifyReadinessChanged();
      return;
    }
    if (entry.superseded || entry.session.isClosed()) {
      // Superseded: marked while this consumer still held it - the host
      // re-keyed or moved underneath a live reference, so
      // `closeSupersededIdentities` could not take it then and nothing sweeps
      // again now. Close it HERE, at the only other moment it is free.
      // Lingering would buy nothing that keep-warm exists for - a re-acquire
      // of this key refuses to adopt a superseded entry and builds a fresh
      // one - and would cost the two things that motivated closing superseded
      // identities in the first place: an authenticated relay socket held
      // open for the rest of the window, and a ready session answering
      // `hasReadyRemoteSession` for a host whose CURRENT identity may still
      // be dialing or already failing.
      //
      // Closed: the session went terminally dead (a session-level fatal)
      // while held. Arming a linger on the corpse would keep a dead entry
      // occupying the key for the window for no possible adopter - the next
      // acquire evicts closed entries anyway, so drop it now. (`close()` on
      // an already-closed session is an idempotent no-op.)
      entriesByKey.delete(key);
      entry.disposeReadinessWiring();
      entry.session.close();
      notifyReadinessChanged();
      return;
    }
    // Keep-warm: defer the real teardown by the linger window. The entry
    // stays in the map (so `hasReadyRemoteSession` keeps reporting honest
    // liveness and a re-acquire adopts it), and the session keeps its own
    // reconnect/re-auth machinery running - bounded by the window, so an
    // abandoned session cannot dial forever.
    //
    // NOTE the ordering below: the linger is armed from THIS release, and an
    // outstanding status-poll borrow (`borrowCount`) is deliberately not
    // consulted. The teardown clock therefore starts when the last real
    // consumer let go, never when a poller did.
    entry.lingerTimer = setTimeout(() => {
      entry.lingerTimer = null;
      // Superseded (evicted after a fatal, then re-created) or re-acquired
      // entries are not this timer's to tear down.
      if (entriesByKey.get(key) !== entry || entry.refCount > 0) {
        return;
      }
      entriesByKey.delete(key);
      entry.disposeReadinessWiring();
      entry.session.close();
      notifyReadinessChanged();
    }, REMOTE_SESSION_LINGER_MS);
    // BORROWABILITY changed (1 -> 0 consumers, linger now armed): this entry
    // has just become a zero-consumer lingering session, which
    // {@link tryAcquireReadyRemoteSession} refuses. `hasReadyRemoteSession`
    // still answers true for it - it is a live attached connection - so the two
    // predicates genuinely diverge here and only the borrowable one moved.
    notifyReadinessChanged();
  };

  return {
    start: () => session.start(),
    isClosed: () => session.isClosed(),
    isReady: () => session.isReady(),
    terminalFatal: () => session.terminalFatal(),
    sendUnary: (method, params, abortSignal, responseTimeoutMs) =>
      session.sendUnary(method, params, abortSignal, responseTimeoutMs),
    subscribe: (method, params) => session.subscribe(method, params),
    subscribeWithParamsProvider: (method, paramsProvider) =>
      session.subscribeWithParamsProvider(method, paramsProvider),
    notifyBearerRotated: () => session.notifyBearerRotated(),
    wake: (reason, probe) => {
      // Only a LIVE reference may accelerate a session. A view whose `close()`
      // already ran is a stale callback - a discarded render, a disposed
      // binding - and honouring it would redial a session this consumer no
      // longer holds, including one sitting at refCount 0 in its keep-warm
      // linger with nobody waiting on it at all. A superseded or closed entry
      // is worse: its key embeds a public key, relay URL or auth epoch the
      // world has moved off, so it can never re-handshake or re-mint, and
      // hurrying it only spends grants against a retired identity.
      if (released || entry.superseded || session.isClosed()) {
        return;
      }
      session.wake(reason, probe);
    },
    forceReconnect: (reason) => {
      // Same ownership guard as `wake`, for the same reasons - a forced
      // redial is strictly MORE session activity than an accelerated one, so
      // a stale reference may command it even less.
      if (released || entry.superseded || session.isClosed()) {
        return;
      }
      session.forceReconnect(reason);
    },
    onClosed: (listener) => session.onClosed(listener),
    subscribeAvailabilityRecovered: (listener) =>
      session.subscribeAvailabilityRecovered(listener),
    subscribeReadinessLost: (listener) =>
      session.subscribeReadinessLost(listener),
    close: release,
  };
}

/**
 * Closes any zero-reference entry this acquire SUPERSEDES: same host, but a
 * different host public key or relay attach URL (the host re-keyed or its
 * endpoint moved), a retired auth epoch, or a previous signed-in user - i.e.
 * the render layer has just rebuilt its transport onto the new identity or
 * auth context.
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
    if (entry.identity.hostId !== identity.hostId) {
      // A different host: an independent session, and not ours to judge.
      continue;
    }
    if (
      entry.identity.userId === identity.userId &&
      entry.identity.hostPublicKey === identity.hostPublicKey &&
      entry.identity.relayAttachUrl === identity.relayAttachUrl &&
      entry.identity.authEpoch === identity.authEpoch
    ) {
      // Same user, same physical identity AND the same auth context.
      // `key !== currentKey` therefore means it differs ONLY in `authRecovery`
      // - the deliberate one-shot/durable split, both current, neither
      // superseding the other.
      //
      // Every one of those equalities has to hold for that reasoning to apply.
      // Two entries from DIFFERENT auth contexts are not parallel: the older
      // one belongs to a signed-out session whose credential lease is gone.
      // Leaving it current would reproduce, through the auth dimension,
      // exactly what supersession fixes for a rotated key -
      // `hasReadyRemoteSession` matches on `hostId` alone, so the retired
      // entry would report the host Online and pass its scope gate while the
      // live context is still dialing or has already failed, and would hold
      // an obsolete authenticated connection open for the rest of the window.
      //
      // A different USER is that same retirement one dimension over. This
      // process has a single signed-in user at a time, so an entry under
      // another `userId` was necessarily built by a sign-in that has since
      // ended - never a live parallel context. `userId` sits in THIS guard
      // rather than the skip above so the verdict does not ride on the epoch
      // label alone: even if two contexts' epoch labels ever read equal, the
      // user mismatch still retires the entry.
      continue;
    }
    // The MARK alone changes this host's answer: a superseded entry stops
    // counting for `hasReadyRemoteSession` whether or not it can be closed
    // yet, so the notify belongs here and not only on the close path below.
    entry.superseded = true;
    notifyReadinessChanged();
    if (entry.refCount > 0) {
      // Still held. `release` closes it the moment its last consumer lets go.
      continue;
    }
    if (entry.lingerTimer !== null) {
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = null;
    }
    entry.disposeReadinessWiring();
    entriesByKey.delete(key);
    entry.session.close();
  }
}

/**
 * Retires EVERY cached session: marks each entry superseded, closing the free
 * ones outright and leaving held ones to close at their release (the sticky
 * `superseded` mark carries the verdict, exactly as in
 * {@link closeSupersededIdentities}).
 *
 * For the auth boundary. Supersession is otherwise detected only at ACQUIRE
 * time, which leaves a hole on sign-out: every consumer releases, the entries
 * enter the keep-warm linger un-marked, and until someone acquires for a
 * given host - which a read-only surface never does - a retired user's
 * still-attached session keeps answering {@link hasReadyRemoteSession} for up
 * to the full window, rendering the host Online to whoever signs in next off
 * the signed-out user's connection. The sign-out transition releases the
 * credential lease, so none of these sessions can mint again anyway; retiring
 * them at the boundary just makes the cache say so immediately.
 */
export function retireAllRemoteSessions(): void {
  for (const [key, entry] of [...entriesByKey]) {
    // The MARK alone changes this host's answer: a superseded entry stops
    // counting for `hasReadyRemoteSession` whether or not it can be closed
    // yet, so the notify belongs here and not only on the close path below.
    entry.superseded = true;
    notifyReadinessChanged();
    if (entry.refCount > 0) {
      // Still held. `release` closes it the moment its last consumer lets go.
      continue;
    }
    if (entry.lingerTimer !== null) {
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = null;
    }
    entry.disposeReadinessWiring();
    entriesByKey.delete(key);
    entry.session.close();
  }
}

/**
 * Wakes every session a consumer currently HOLDS - see
 * {@link IRemoteSession.wake}. The single seam for runtime-resume coverage, and
 * deliberately not per-consumer.
 *
 * A resume is a fact about the RUNTIME, not about one binding: the whole
 * JavaScript context froze, so every held session is equally suspect, including
 * ones no React component is subscribed to. Sweeping from here is what covers
 * the sessions that have no wake wiring of their own - a messenger-only binding
 * with no stream client, and a pinned non-active asset client whose hook defers
 * `close()` until the final unpin. It also means N consumers of one physical
 * session cannot install N listeners against it; the sweep is idempotent, and
 * each session's own one-collapse-per-armed-timer rule makes duplicate calls
 * free.
 *
 * `refCount > 0` is the ownership test, and the reason a zero-ref keep-warm
 * entry is skipped: keep-warm exists so a prompt RE-acquire is free, not so an
 * abandoned session keeps dialing on wakes nobody asked for. It gets its wake
 * from the consumer that adopts it. Superseded and closed entries are skipped
 * for the same reason the per-consumer view refuses them.
 *
 * `options` is the caller's verdict on the sockets this resume left behind,
 * in the same vocabulary as `IHostStreamClient.reconnectAll` (the per-client
 * half of the same wake): probe-first with the caller's probe sizing, or
 * forced drop-and-redial when the runtime was demonstrably suspended long
 * enough that no socket survived it.
 *
 * Replay-unsafe entries are skipped in BOTH modes, and this is the one gate
 * standing between the sweep and a re-executed side effect: a session
 * reconnect replays every retained logical subscribe at the next `openAck`,
 * and for a one-shot destructive stream (`worktree.deleteByPath`) that replay
 * RE-RUNS the operation. A forced drop of a healthy mux would manufacture
 * exactly that replay, and even a probe only hastens a loss the entry's own
 * keepalive would surface - so an entry that declared itself ineligible at
 * acquire gets neither. Its passive reconnect after a genuine loss keeps its
 * own contract; the phase of its streams is deliberately NOT consulted here,
 * because by the time a loss has happened the destructive subscribe is
 * already retained for replay.
 */
export function wakeHeldRemoteSessions(
  reason: string,
  options: ReconnectAllOptions,
): void {
  for (const entry of entriesByKey.values()) {
    if (
      entry.refCount <= 0 ||
      entry.superseded ||
      entry.session.isClosed() ||
      !entry.proactiveWakeEligible
    ) {
      continue;
    }
    if (options.probeFirst) {
      entry.session.wake(reason, options.wakeProbe);
    } else {
      entry.session.forceReconnect(reason);
    }
  }
}

/**
 * True if the cached session for `hostId` (any signed-in user) is currently
 * ready. A lingering keep-warm session (refCount 0, window not yet expired)
 * counts: it is a live, attached connection, so it is honest evidence.
 *
 * NOT a readiness read for a surface that speaks for ONE session: this matches
 * on `hostId` across every entry, so a ready one-shot or a lingering keep-warm
 * session answers for a durable session that is down. Ask the client itself
 * (`IHostStreamClient.isReady`) when the question is about a particular
 * session.
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

/**
 * A status-poll BORROW of an already-established session: the narrow surface a
 * fleet-status poller gets, and deliberately not an {@link IRemoteSession}.
 *
 * Three things are absent, each on purpose:
 *
 *  - **no `close()`** - a borrower must not be able to tear down a connection
 *    it does not own. `release()` gives back the borrow, nothing more.
 *  - **no `subscribe()` / `subscribeWithParamsProvider()`** - those open
 *    server-side streams on the host, which is work created *by observation*.
 *    A status projection reads; it does not subscribe.
 *  - **no `start()`** - there is nothing to start. The only entries this hands
 *    out are already ready.
 */
export interface BorrowedRemoteSession<
  RpcRegistry extends VersionedRpcRegistry,
> {
  /**
   * The exact identity this borrow is bound to - full physical identity AND
   * auth epoch, not just `hostId`. A caller that cares which connection
   * answered (a projection stamping its observation's source) reads it here
   * rather than assuming the host has only one.
   */
  readonly identity: RemoteSessionIdentity;
  sendUnary<Method extends keyof RpcRegistry & string>(
    method: Method,
    params: RequestOfMethod<RpcRegistry, Method>,
    abortSignal: AbortSignal | null,
    responseTimeoutMs: number | undefined,
  ): Promise<ResponseOfMethod<RpcRegistry, Method>>;
  /** Idempotent. Gives the borrow back; never closes or schedules anything. */
  release(): void;
}

/**
 * Atomically borrows an ALREADY-READY, ALREADY-OWNED session for `hostId`, or
 * returns `null` - never dialing, never constructing, never extending a
 * lifetime.
 *
 * This exists because `hasReadyRemoteSession(hostId)` followed by
 * `acquireRemoteSession(identity, factory)` is not a safe way to reach the same
 * place, in two independent ways:
 *
 *  1. The two calls are not atomic. The entry can be closed, superseded, or
 *     swept between them, and the acquire then runs the FACTORY - minting a
 *     grant, dialing the relay, and standing up a Noise session that exists
 *     only because something wanted to draw a badge.
 *  2. `hasReadyRemoteSession` deliberately counts a zero-consumer LINGERING
 *     entry as honest liveness (it is a live attached connection). Adopting one
 *     is exactly what a status poller must not do: `acquireRemoteSession`
 *     cancels the pending teardown, so observing the host would keep it alive.
 *
 * So this takes **no factory parameter at all**. "Fleet observation creates
 * zero sessions" is then a property of the signature rather than a promise
 * about the body - there is nothing here that could construct one, however the
 * function is later edited.
 *
 * Admission is one synchronous pass over the map, so no state can move
 * underneath a partially-made decision. An entry qualifies only if it is:
 *
 *  - this host's, and NOT superseded (a superseded entry is pinned to a public
 *    key, relay URL or auth context the host has moved off - see
 *    {@link hasReadyRemoteSession}, which refuses them for the same reason);
 *  - open (`!isClosed()`) and at its ready boundary (`isReady()`);
 *  - held by a **live non-poller owner** (`refCount > 0`) with **no linger
 *    armed** (`lingerTimer === null`). Together these are the "not a
 *    zero-consumer lingering entry" rule, checked as state rather than
 *    inferred: they are equivalent today, and asserting both means a future
 *    change to one cannot quietly admit the case the other was guarding.
 *
 * The borrow does not touch `refCount`, so it can neither arm nor postpone the
 * keep-warm teardown - see {@link CacheEntry.borrowCount} for why that has to
 * be a separate counter and not care at the call site.
 *
 * A borrowed entry may still die underneath the borrower (its owner releases
 * and the window expires, sign-out retires it, a session fatal closes it). That
 * is not an error to prevent: the in-flight request rejects, and a status read
 * that cannot complete renders **unknown** - never failure, and never a stale
 * value presented as live.
 */
export function tryAcquireReadyRemoteSession<
  RpcRegistry extends VersionedRpcRegistry,
>(hostId: string): BorrowedRemoteSession<RpcRegistry> | null {
  const entry = findBorrowableEntry(hostId);
  if (entry === null) {
    return null;
  }
  entry.borrowCount += 1;
  // Sound for the same reason `acquireRemoteSession` re-specializes: a cache
  // key is only ever populated by callers building the session from this app's
  // one production registry pair, so narrowing the wide entry to this call's
  // registry cannot observe a different shape.
  const session = entry.session as IRemoteSession<
    RpcRegistry,
    VersionedStreamRpcRegistry
  >;
  let released = false;
  return {
    identity: entry.identity,
    sendUnary: (method, params, abortSignal, responseTimeoutMs) => {
      if (released) {
        // A released handle is dead, not merely discouraged. Letting a late
        // call through would let an abandoned poll keep issuing requests on a
        // connection its owner has stopped accounting for.
        return Promise.reject(
          new Error("borrowed remote session was already released"),
        );
      }
      // SUPERSESSION IS RE-READ ON EVERY SEND, not sampled when the borrow was
      // taken. `findBorrowableEntry` bars a marked entry from being borrowed,
      // but an entry can be marked AFTER a borrow is outstanding, and this
      // closure had no other way to notice.
      //
      // Usually that resolves itself: `closeSupersededIdentities` closes the
      // entries that are free at that moment, and a closed session fails the
      // request — the designed outcome for a status read. The gap is the entry
      // that is NOT free, because a real consumer still holds it. That one is
      // marked and deliberately left open, carrying the verdict forward until
      // its consumer releases. Its `refCount` guard belongs to that consumer;
      // the borrower had none, so it kept polling over a session whose identity
      // was retired — which, when the supersession came from a retired
      // credential lease or a signed-out user, means requests under a retired
      // credential for as long as the real consumer holds on.
      //
      // Refusing is the safe answer rather than a degradation: this handle's
      // one caller is a status poll, and a status read that cannot complete
      // renders `unknown` — never failure, and never a stale value presented as
      // live. That is the same contract the doc comment above already relies on
      // for a borrowed entry that dies underneath its borrower.
      if (entry.superseded) {
        return Promise.reject(
          new Error("borrowed remote session identity was superseded"),
        );
      }
      // The check above is a SNAPSHOT, and on its own it only narrows the
      // window rather than closing it. Sign-out, an auth-epoch change, or a
      // host-key/relay rotation can supersede this entry while the unary is
      // already in flight; the pre-send check has passed by then, so the
      // retired session's response comes back and
      // `readUpdateStatusOverBorrowedSession` timestamps it as a fresh current
      // observation — the stale-value-presented-as-live outcome the pre-send
      // arm exists to prevent, arriving through the one path it cannot see.
      //
      // Recheck the CAPTURED entry on resolution, never a key relookup, for the
      // same reason `release` captures it: a successor may already occupy the
      // key, and this response's identity is the one it was sent under.
      // Refusing matches the pre-send arm exactly — the caller is a status
      // poll, so a refused read renders `unknown`, never failure and never a
      // retired value shown as live.
      return session
        .sendUnary(method, params, abortSignal, responseTimeoutMs)
        .then((result) => {
          if (entry.superseded) {
            throw new Error("borrowed remote session identity was superseded");
          }
          return result;
        });
    },
    release: () => {
      if (released) {
        return;
      }
      released = true;
      // The CAPTURED entry, never a key relookup - identical to `release` in
      // `acquireRemoteSession`, and for the identical reason: a fresh entry may
      // have been created under the same key, and a late give-back must not
      // decrement the successor's books.
      entry.borrowCount -= 1;
      // Deliberately nothing else. No close, no linger, no notify: giving a
      // borrow back changes no host's readiness and schedules no teardown,
      // because taking it scheduled none either.
    },
  };
}

/**
 * Whether {@link tryAcquireReadyRemoteSession} would currently succeed for
 * `hostId` - the predicate a surface reads to decide whether it can show live
 * state for a row WITHOUT causing a connection.
 *
 * Strictly narrower than {@link hasReadyRemoteSession}, and the gap is the
 * point: that one answers "is this host reachable right now", which a
 * zero-consumer lingering session honestly satisfies. This one answers "can a
 * poller read this host without keeping anything alive", which the same session
 * does not. Both are correct for their own question; using the wrong one is how
 * observation turns into lifetime extension.
 *
 * Changes to this answer are reported through
 * {@link subscribeRemoteSessionReadiness}, which now also fires on the
 * consumer-count and linger transitions that move only this predicate.
 */
export function hasBorrowableRemoteSession(hostId: string): boolean {
  return findBorrowableEntry(hostId) !== null;
}

/** The single admission test, shared so the predicate cannot drift from the borrow. */
function findBorrowableEntry(hostId: string): CacheEntry | null {
  for (const entry of entriesByKey.values()) {
    if (
      entry.identity.hostId === hostId &&
      // Only durable, auth-revalidating sessions may serve borrowed reads. A
      // ready `"terminal"` one-shot shares the hostId and can precede the
      // durable entry in map order, but it runs with `auth: null`, so the
      // first UNAUTHORIZED goes terminal-fatal — closing that owner's stream
      // subscriptions and rejecting its pending calls because a status poll
      // happened to pick it. Observation must never spend a one-shot's life.
      entry.identity.authRecovery === "revalidate" &&
      !entry.superseded &&
      entry.lingerTimer === null &&
      entry.refCount > 0 &&
      !entry.session.isClosed() &&
      entry.session.isReady()
    ) {
      return entry;
    }
  }
  return null;
}

/** Test-only: the number of live consumer references held for `identity`. */
export function remoteSessionRefCountForTest(
  identity: RemoteSessionIdentity,
): number {
  return entriesByKey.get(remoteSessionCacheKey(identity))?.refCount ?? 0;
}

/**
 * Test-only: outstanding status-poll borrows for `identity`.
 *
 * Exposed so a suite can assert borrows are BALANCED - the coordinator's
 * teardown, a sign-out mid-poll, and a superseding acquire must all leave this
 * at zero. A leak here would be invisible in `refCount` by design.
 */
export function remoteSessionBorrowCountForTest(
  identity: RemoteSessionIdentity,
): number {
  return entriesByKey.get(remoteSessionCacheKey(identity))?.borrowCount ?? 0;
}

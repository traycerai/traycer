import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { TimerHandle } from "../timer-handle";
import type { RequestOfMethod, ResponseOfMethod } from "../host-messenger";
import type { ReconnectAllOptions } from "../host-stream-client";
import {
  PLAN_RESTRICTED_FATAL_CODE,
  PLAN_RESTRICTED_REPROBE_MS,
  REMOTE_SESSION_LINGER_MS,
} from "./config";
import type { IRemoteSession } from "./remote-session";

/**
 * Get-or-create cache for the client's persistent remote (E2E) session, keyed by the session's full identity (Architecture §4, fix #4 / S1 - replaces the prior passive live-session-evidence registry).
 */

export interface RemoteSessionIdentity {
  readonly hostId: string;
  readonly userId: string;
  readonly hostPublicKey: string;
  readonly relayAttachUrl: string;
  /**
   * What this consumer needs a session to do with an `unauthorized` fatal.
   * So the two never share a physical connection.
   */
  readonly authRecovery: "revalidate" | "terminal";
  /**
   * Which auth context the session's creator was wired to - see `createRemoteHostTransport`, which derives it from the bearer source.
   * The factory captures its creator's bearer provider, grant provider and auth revalidator, and a cache hit never re-runs it.
   */
  readonly authEpoch: string;
}

interface CacheEntry {
  readonly session: IRemoteSession<
    VersionedRpcRegistry,
    VersionedStreamRpcRegistry
  >;
  /** The identity this entry was built for, kept as fields rather than re-parsed out of the map key. */
  readonly identity: RemoteSessionIdentity;
  /**
   * Whether the process-wide proactive sweep may touch this entry at all - poke its socket on a wake, or force-drop it after a long background.
   * Stable per cached identity in practice: replay-unsafe consumers never share an identity with durable ones (their `authRecovery` differs, which is part of the cache key), so a cache hit cannot flip this.
   */
  readonly proactiveWakeEligible: boolean;
  refCount: number;
  /**
   * A borrow that incremented `refCount` would be indistinguishable from a consumer, and the keep-warm teardown is scheduled from whoever brings the count to zero.
   * A borrow whose entry dies underneath it simply fails its in-flight request, which is the correct outcome for a status read (the caller renders unknown; it never renders failure).
   */
  borrowCount: number;
  /** Armed while the entry lingers at refCount 0; null while consumers hold it. */
  lingerTimer: TimerHandle | null;
  /**
   * Until this instant, a terminal `PLAN_RESTRICTED` session remains a
   * negative cache entry instead of being replaced by every new consumer.
   */
  planRestrictedUntil: number | null;
  /** Drops an unheld negative-cache entry when its controlled probe is due. */
  planRestrictedTimer: TimerHandle | null;
  /**
   * A marked entry is barred from both things the cache does for a live entry: it never lingers (see `release`) and it never answers {@link hasReadyRemoteSession} for its host.
   */
  superseded: boolean;
  /**
   * Tears down this entry's readiness wiring (its `onClosed` and `subscribeAvailabilityRecovered` subscriptions).
   */
  disposeReadinessWiring: () => void;
}

/**
 * Push replaces poll (redesign P4.1 / connection-registry §6).
 * Coalescing also collapses the burst a single sweep produces (one supersede can close several entries) into one wake.
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

export function subscribeRemoteSessionReadiness(
  listener: () => void,
): () => void {
  readinessListeners.add(listener);
  return () => {
    readinessListeners.delete(listener);
  };
}

export function resetRemoteSessionReadinessListenersForTest(): void {
  readinessListeners.clear();
}

const KEY_SEPARATOR = "\u0000";

const entriesByKey = new Map<string, CacheEntry>();

function isPlanRestricted(entry: CacheEntry): boolean {
  return entry.session.terminalFatal()?.code === PLAN_RESTRICTED_FATAL_CODE;
}

function isPlanRestrictedSuppressed(entry: CacheEntry): boolean {
  return (
    isPlanRestricted(entry) &&
    entry.planRestrictedUntil !== null &&
    Date.now() < entry.planRestrictedUntil
  );
}

export function planRestrictedReprobeAt(
  identity: RemoteSessionIdentity,
): number | null {
  const entry = entriesByKey.get(remoteSessionCacheKey(identity));
  return entry !== undefined && isPlanRestrictedSuppressed(entry)
    ? entry.planRestrictedUntil
    : null;
}

export function planRestrictedReprobeAtForHost(hostId: string): number | null {
  let latest: number | null = null;
  for (const entry of entriesByKey.values()) {
    if (
      entry.identity.hostId !== hostId ||
      !isPlanRestrictedSuppressed(entry)
    ) {
      continue;
    }
    const until = entry.planRestrictedUntil;
    if (until !== null && (latest === null || until > latest)) latest = until;
  }
  return latest;
}

function armPlanRestrictedSuppression(entry: CacheEntry, key: string): void {
  if (!isPlanRestricted(entry) || entry.planRestrictedUntil !== null) {
    return;
  }
  // A consumer may have released while the attach grant was still in flight, arming the ordinary keep-warm teardown before the fatal arrived.
  // The entitlement verdict has its own, longer lifetime; leaving that timer armed would evict this entry after REMOTE_SESSION_LINGER_MS and reopen the cross-session mint/dial loop long before the controlled reprobe is due.
  if (entry.lingerTimer !== null) {
    clearTimeout(entry.lingerTimer);
    entry.lingerTimer = null;
  }
  entry.planRestrictedUntil = Date.now() + PLAN_RESTRICTED_REPROBE_MS;
  entry.planRestrictedTimer = setTimeout(() => {
    entry.planRestrictedTimer = null;
    if (entriesByKey.get(key) !== entry || entry.refCount > 0) {
      return;
    }
    entriesByKey.delete(key);
    entry.disposeReadinessWiring();
    entry.session.close();
    notifyReadinessChanged();
  }, PLAN_RESTRICTED_REPROBE_MS);
}

/**
 * The map key, and nothing else: every consumer that needs an identity field back reads `CacheEntry.identity` instead of parsing this string, so fields may be added here without any positional reader to keep in step.
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
 * Returns the live session cached for `identity`, incrementing its ref-count and handing back a fresh per-consumer view onto it.
 * `createSession` runs at most once per cache miss - a cache hit never calls it.
 */
/**
 * What the acquiring consumer promises the cache about the session it is claiming - facts the cache needs when it later acts on held entries without any consumer in the call stack (the process-wide wake sweep).
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
  if (
    entry !== undefined &&
    (entry.superseded ||
      (entry.session.isClosed() && !isPlanRestrictedSuppressed(entry)))
  ) {
    // Superseded: the sweep's verdict on this entry is sticky - it closes at its first free moment.
    if (entry.lingerTimer !== null) {
      clearTimeout(entry.lingerTimer);
    }
    if (entry.planRestrictedTimer !== null) {
      clearTimeout(entry.planRestrictedTimer);
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
      planRestrictedUntil: null,
      planRestrictedTimer: null,
      superseded: false,
      disposeReadinessWiring: () => undefined,
    };
    // This session's two readiness edges, wired once per entry rather than once per consumer: a ready boundary (which `maybeReachReadyBoundary` emits for the clean first open, not only for recoveries) and the terminal close.
    // Wired before the sweep below, whose `close()` calls fire listeners synchronously - an entry that could be closed before it was wired would never report its own death.
    const offRecovered = session.subscribeAvailabilityRecovered(
      notifyReadinessChanged,
    );
    const offClosed = session.onClosed(() => {
      armPlanRestrictedSuppression(created, key);
      notifyReadinessChanged();
    });
    // The down edge, and the reason this trio is not a pair.
    // If the reconnect then succeeded they never observed the loss at all.
    const offReadinessLost = session.subscribeReadinessLost(
      notifyReadinessChanged,
    );
    created.disposeReadinessWiring = () => {
      offRecovered();
      offClosed();
      offReadinessLost();
    };
    entry = created;
    // Insert before sweeping.
    // The sweep already excludes `currentKey`, so it never closes the entry it is sweeping on behalf of.
    entriesByKey.set(key, entry);
    closeSupersededIdentities(identity, key);
  }
  if (entry.lingerTimer !== null) {
    // Warm hit: the entry was lingering at refCount 0.
    clearTimeout(entry.lingerTimer);
    entry.lingerTimer = null;
  }
  entry.refCount += 1;
  if (entry.refCount === 1) {
    // Borrowability changed (0 -> 1 consumers, and any linger just cancelled): this entry has just gained a live non-poller owner, which is the whole admission test for {@link tryAcquireReadyRemoteSession}.
    notifyReadinessChanged();
  }

  const session = entry.session as IRemoteSession<RpcRegistry, StreamRegistry>;

  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    entry.refCount -= 1;
    if (entry.refCount > 0) {
      return;
    }
    if (entriesByKey.get(key) !== entry) {
      // Displaced from the map while still held (the eviction branch in `acquireRemoteSession` - closed or superseded - is the only path that removes a held entry).
      // Idempotent when the session was already closed.
      entry.disposeReadinessWiring();
      entry.session.close();
      notifyReadinessChanged();
      return;
    }
    if (entry.superseded || entry.session.isClosed()) {
      armPlanRestrictedSuppression(entry, key);
      if (isPlanRestrictedSuppressed(entry)) {
        // Keep the terminal verdict addressable at refCount zero.
        // A new consumer receives it immediately without constructing a successor; the suppression timer removes it when one controlled probe is due.
        notifyReadinessChanged();
        return;
      }
      // Superseded: marked while this consumer still held it - the host re-keyed or moved underneath a live reference, so `closeSupersededIdentities` could not take it then and nothing sweeps again now.
      // Close it here, at the only other moment it is free.
      entriesByKey.delete(key);
      if (entry.planRestrictedTimer !== null) {
        clearTimeout(entry.planRestrictedTimer);
      }
      entry.disposeReadinessWiring();
      entry.session.close();
      notifyReadinessChanged();
      return;
    }
    // Keep-warm: defer the real teardown by the linger window.
    // The teardown clock therefore starts when the last real consumer let go, never when a poller did.
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
    // Borrowability changed (1 -> 0 consumers, linger now armed): this entry has just become a zero-consumer lingering session, which {@link tryAcquireReadyRemoteSession} refuses.
    // `hasReadyRemoteSession` still answers true for it - it is a live attached connection - so the two predicates genuinely diverge here and only the borrowable one moved.
    notifyReadinessChanged();
  };

  return {
    start: () => session.start(),
    isClosed: () => session.isClosed(),
    isReady: () => session.isReady(),
    terminalFatal: () => session.terminalFatal(),
    sendUnary: (
      method,
      params,
      idempotencyKey,
      abortSignal,
      responseTimeoutMs,
      replayMustBeKeyed,
    ) =>
      session.sendUnary(
        method,
        params,
        idempotencyKey,
        abortSignal,
        responseTimeoutMs,
        replayMustBeKeyed,
      ),
    subscribe: (method, params) => session.subscribe(method, params),
    subscribeAtVersion: (method, schemaVersion, params) =>
      session.subscribeAtVersion(method, schemaVersion, params),
    subscribeWithParamsProvider: (method, paramsProvider) =>
      session.subscribeWithParamsProvider(method, paramsProvider),
    notifyBearerRotated: () => session.notifyBearerRotated(),
    wake: (reason, probe) => {
      // Only a live reference may accelerate a session.
      // A superseded or closed entry is worse: its key embeds a public key, relay URL or auth epoch the world has moved off, so it can never re-handshake or re-mint, and hurrying it only spends grants against a retired identity.
      if (released || entry.superseded || session.isClosed()) {
        return;
      }
      session.wake(reason, probe);
    },
    forceReconnect: (reason) => {
      // Same ownership guard as `wake`, for the same reasons - a forced redial is strictly more session activity than an accelerated one, so a stale reference may command it even less.
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
 * Supersession is a property of the physical identity (`hostPublicKey` + `relayAttachUrl`) and is judged independently of `authRecovery`.
 * The one-shot and durable sessions deliberately do not share a connection, and both are current.
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
      // Same user, same physical identity and the same auth context.
      // `key !== currentKey` therefore means it differs only in `authRecovery` - the deliberate one-shot/durable split, both current, neither superseding the other.
      continue;
    }
    // The mark alone changes this host's answer: a superseded entry stops counting for `hasReadyRemoteSession` whether or not it can be closed yet, so the notify belongs here and not only on the close path below.
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
    if (entry.planRestrictedTimer !== null) {
      clearTimeout(entry.planRestrictedTimer);
      entry.planRestrictedTimer = null;
    }
    entry.disposeReadinessWiring();
    entriesByKey.delete(key);
    entry.session.close();
  }
}

export function retireAllRemoteSessions(): void {
  for (const [key, entry] of [...entriesByKey]) {
    // The mark alone changes this host's answer: a superseded entry stops counting for `hasReadyRemoteSession` whether or not it can be closed yet, so the notify belongs here and not only on the close path below.
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
    if (entry.planRestrictedTimer !== null) {
      clearTimeout(entry.planRestrictedTimer);
      entry.planRestrictedTimer = null;
    }
    entry.disposeReadinessWiring();
    entriesByKey.delete(key);
    entry.session.close();
  }
}

/**
 * Wakes every session a consumer currently holds - see {@link IRemoteSession.wake}.
 * It also means N consumers of one physical session cannot install N listeners against it; the sweep is idempotent, and each session's own one-collapse-per-armed-timer rule makes duplicate calls free.
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
 * True if the cached session for `hostId` (any signed-in user) is currently ready.
 * Not a readiness read for a surface that speaks for one session: this matches on `hostId` across every entry, so a ready one-shot or a lingering keep-warm session answers for a durable session that is down.
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
 * A status-poll borrow of an already-established session: the narrow surface a fleet-status poller gets, and deliberately not an {@link IRemoteSession}.
 * Three things are absent, each on purpose: - **no `close()`** - a borrower must not be able to tear down a connection it does not own.
 */
export interface BorrowedRemoteSession<
  RpcRegistry extends VersionedRpcRegistry,
> {
  /**
   * The exact identity this borrow is bound to - full physical identity and auth epoch, not just `hostId`.
   * A caller that cares which connection answered (a projection stamping its observation's source) reads it here rather than assuming the host has only one.
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
 * Atomically borrows an already-ready, already-owned session for `hostId`, or returns `null` - never dialing, never constructing, never extending a lifetime.
 * This exists because `hasReadyRemoteSession(hostId)` followed by `acquireRemoteSession(identity, factory)` is not a safe way to reach the same place, in two independent ways: 1.
 */
export function tryAcquireReadyRemoteSession<
  RpcRegistry extends VersionedRpcRegistry,
>(hostId: string): BorrowedRemoteSession<RpcRegistry> | null {
  const entry = findBorrowableEntry(hostId);
  if (entry === null) {
    return null;
  }
  entry.borrowCount += 1;
  const session = entry.session as IRemoteSession<
    RpcRegistry,
    VersionedStreamRpcRegistry
  >;
  let released = false;
  return {
    identity: entry.identity,
    sendUnary: (method, params, abortSignal, responseTimeoutMs) => {
      if (released) {
        // A released handle is dead, not merely discouraged.
        return Promise.reject(
          new Error("borrowed remote session was already released"),
        );
      }
      // Supersession IS RE-read ON every send, not sampled when the borrow was taken.
      // `findBorrowableEntry` bars a marked entry from being borrowed, but an entry can be marked after a borrow is outstanding, and this closure had no other way to notice.
      if (entry.superseded) {
        return Promise.reject(
          new Error("borrowed remote session identity was superseded"),
        );
      }
      // The check above is a snapshot, and on its own it only narrows the window rather than closing it.
      // Recheck the captured entry on resolution, never a key relookup, for the same reason `release` captures it: a successor may already occupy the key, and this response's identity is the one it was sent under.
      return session
        .sendUnary(
          method,
          params,
          null,
          abortSignal,
          responseTimeoutMs,
          // A borrowed status poll carries no key and is never a replay: the
          // caller re-polls on the next tick rather than retrying this one.
          false,
        )
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
      entry.borrowCount -= 1;
      // Deliberately nothing else.
    },
  };
}

/**
 * Whether {@link tryAcquireReadyRemoteSession} would currently succeed for `hostId` - the predicate a surface reads to decide whether it can show live state for a row without causing a connection.
 * This one answers "can a poller read this host without keeping anything alive", which the same session does not.
 */
export function hasBorrowableRemoteSession(hostId: string): boolean {
  return findBorrowableEntry(hostId) !== null;
}

/** The single admission test, shared so the predicate cannot drift from the borrow. */
function findBorrowableEntry(hostId: string): CacheEntry | null {
  for (const entry of entriesByKey.values()) {
    if (
      entry.identity.hostId === hostId &&
      // Only durable, auth-revalidating sessions may serve borrowed reads.
      // Observation must never spend a one-shot's life.
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

export function remoteSessionRefCountForTest(
  identity: RemoteSessionIdentity,
): number {
  return entriesByKey.get(remoteSessionCacheKey(identity))?.refCount ?? 0;
}

/**
 * Test-only: outstanding status-poll borrows for `identity`.
 * Exposed so a suite can assert borrows are balanced - the coordinator's teardown, a sign-out mid-poll, and a superseding acquire must all leave this at zero.
 */
export function remoteSessionBorrowCountForTest(
  identity: RemoteSessionIdentity,
): number {
  return entriesByKey.get(remoteSessionCacheKey(identity))?.borrowCount ?? 0;
}

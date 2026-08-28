import {
  useCallback,
  useEffect,
  useReducer,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * The ref-counted session-sharing machinery behind the `pr.*` subscription
 * hooks.
 *
 * Both hooks need the same non-obvious lifecycle - one transport session per
 * key however many components mount against it, terminal-entry replacement on
 * retry, consumer migration off a session that is being torn down, and
 * immediate teardown at zero (ADR-0003, no grace period). That lifecycle
 * carries the feature's concurrency rules, so it lives here ONCE: two copies
 * would mean every fix has to be found and applied twice, and a copy that
 * missed one would fail only under the interleaving it was written for.
 *
 * What stays with each hook is what is genuinely per-stream: the method and
 * its params, the frame schema, the cache key, the frame-to-data projection,
 * and the wording of a close.
 */
export interface SharedStreamSubscription<TFrame> {
  refCount: number;
  unsubscribeFromStream: () => void;
  sendRefresh: () => void;
  lastEvent: TFrame | null;
  /**
   * Set once the stream reaches a terminal state (a fatal frame or an
   * unexpected close). A terminal session's `sendRefresh` is inert, so the
   * entry must be REPLACED, not reused, on retry.
   */
  isTerminal: boolean;
  consumers: Map<symbol, () => void>;
}

/** Module-level registry of live sessions, keyed by their session key. */
export type SharedStreamSubscriptionRegistry<TFrame> = Map<
  string,
  SharedStreamSubscription<TFrame>
>;

/** Test helper: tear every session down and empty the registry. */
export function resetSharedStreamSubscriptions<TFrame>(
  registry: SharedStreamSubscriptionRegistry<TFrame>,
): void {
  for (const subscription of registry.values()) {
    subscription.unsubscribeFromStream();
  }
  registry.clear();
}

/**
 * Render-side change channel, keyed by registry and session key.
 *
 * The entry a consumer renders from is mutable module state: the subscribe
 * effect creates it AFTER the first commit, and the session factories mutate
 * `lastEvent` / `isTerminal` in place and fan out through `consumers`. The
 * desktop renderer runs the React Compiler, which memoizes an imperative
 * `registry.get(key)` (and a `entry.lastEvent` read) during render on the
 * identity of its inputs - registry, key, entry - none of which change when
 * the entry appears or its frame moves. A plain render-time read therefore
 * froze at `undefined`: error frames never surfaced and `sendRefresh` was
 * inert. `useSyncExternalStore` owns the value, so the compiler caching its
 * callbacks is harmless.
 *
 * Keyed outside the entry so a consumer can subscribe before its entry exists
 * and so a DISABLED instance (one reading a sibling's live session) is
 * notified by the sibling's fan-out.
 */
const entryListenersByRegistry = new WeakMap<
  object,
  Map<string, Set<() => void>>
>();

function entryListenersFor<TFrame>(
  registry: SharedStreamSubscriptionRegistry<TFrame>,
): Map<string, Set<() => void>> {
  // The channel never reads the registry's values - it only keys listeners by
  // the registry object - so the frame type is irrelevant here.
  let listeners = entryListenersByRegistry.get(registry);
  if (listeners === undefined) {
    listeners = new Map();
    entryListenersByRegistry.set(registry, listeners);
  }
  return listeners;
}

function subscribeToEntry<TFrame>(
  registry: SharedStreamSubscriptionRegistry<TFrame>,
  key: string | null,
): (listener: () => void) => () => void {
  return (onStoreChange) => {
    if (key === null) return () => undefined;
    const byKey = entryListenersFor(registry);
    let listeners = byKey.get(key);
    if (listeners === undefined) {
      listeners = new Set();
      byKey.set(key, listeners);
    }
    listeners.add(onStoreChange);
    return () => {
      const current = byKey.get(key);
      if (current === undefined) return;
      current.delete(onStoreChange);
      if (current.size === 0) byKey.delete(key);
    };
  };
}

function notifyEntryChanged<TFrame>(
  registry: SharedStreamSubscriptionRegistry<TFrame>,
  key: string,
): void {
  const listeners = entryListenersFor(registry).get(key);
  if (listeners === undefined) return;
  for (const listener of [...listeners]) listener();
}

export interface SharedStreamSubscriptionResult<TFrame> {
  /**
   * The last frame the session at this hook's key delivered, or `null` when
   * there is no entry or no frame yet. Present even while this hook instance
   * is DISABLED: another consumer may hold a live session for the same key,
   * and its last frame is still the truth about that stream. Read through
   * the store (see `entryListenersByRegistry`), never off the entry.
   */
  readonly lastEvent: TFrame | null;
  /**
   * Refreshes on this hook's own session. After a terminal error the session
   * is dead and its `sendRefresh` is a no-op, so a user "refresh"/"Try again"
   * there means RECONNECT: re-run the subscribe effect, which replaces the
   * terminal entry. A NONFATAL error leaves the session live, so it must
   * still get an actual refresh frame rather than being treated as dead.
   */
  readonly sendRefresh: () => void;
}

export function useSharedStreamSubscription<TFrame>(args: {
  readonly registry: SharedStreamSubscriptionRegistry<TFrame>;
  /**
   * `null` while the key is unknowable - no transport client, no resolved
   * host. Distinct from `enabled`: a key with `enabled: false` still reads a
   * sibling's live session, it just does not open one of its own.
   */
  readonly sessionKey: string | null;
  readonly enabled: boolean;
  /** Symbol description for this hook's consumer id, for debugging. */
  readonly consumerLabel: string;
  /** Opens a fresh transport session. Must be referentially stable per key. */
  readonly createSession: () => SharedStreamSubscription<TFrame>;
  /**
   * Runs when this consumer attaches to an entry. A second consumer joining
   * an ALREADY-LIVE session gets no fresh hydration snapshot from the host -
   * the session never dropped to zero - so this is where a cache slot that
   * was GC'd while unobserved gets refilled.
   */
  readonly onConsumerJoined: (
    subscription: SharedStreamSubscription<TFrame>,
  ) => void;
}): SharedStreamSubscriptionResult<TFrame> {
  const { registry, sessionKey, enabled, createSession, onConsumerJoined } =
    args;

  const { consumerLabel } = args;
  const [consumerId] = useState(() => Symbol(consumerLabel));
  // Bumped by `retry()` to force this consumer's subscribe effect to re-run so
  // a TERMINAL shared session is torn down and replaced with a fresh one.
  const [retryNonce, retry] = useReducer(
    (count: number): number => count + 1,
    0,
  );

  useEffect(() => {
    if (!enabled || sessionKey === null) return;
    void retryNonce;

    let shared = registry.get(sessionKey);

    // Create a fresh session when there is none OR when the cached one is
    // terminal (its stream is dead and its `sendRefresh` is inert). Replacing
    // a terminal entry is what makes "Try again" actually reconnect instead
    // of spinning against a closed session.
    if (shared === undefined || shared.isTerminal) {
      // A terminal entry can still carry OTHER mounted consumers - this
      // effect's own cleanup already removed THIS consumer if it was
      // previously attached, so anything left in `staleConsumers` belongs to
      // a different hook instance. Migrate them onto the fresh session
      // instead of leaving them ref-counted against the one we are about to
      // close, which would silently drop their subscription the next time
      // only THIS (retrying) consumer unmounts.
      const staleConsumers = shared?.consumers;
      shared?.unsubscribeFromStream();
      shared = createSession();
      registry.set(sessionKey, shared);
      if (staleConsumers !== undefined) {
        for (const [id, notify] of staleConsumers) {
          shared.consumers.set(id, notify);
          shared.refCount += 1;
          notify();
        }
      }
    }

    shared.refCount += 1;
    // The session factories fan every frame / terminal close out through
    // `consumers`; this consumer forwards that onto the render-side channel
    // for every hook instance at this key (including disabled readers).
    shared.consumers.set(consumerId, () =>
      notifyEntryChanged(registry, sessionKey),
    );
    onConsumerJoined(shared);
    // The render that scheduled this effect read the channel before the entry
    // existed (or saw a terminal one about to be replaced); re-read it now.
    notifyEntryChanged(registry, sessionKey);

    return () => {
      // Look up the CURRENT entry at this key rather than closing over the
      // one captured above: a sibling consumer's retry may have replaced a
      // terminal entry with a fresh session in the meantime and migrated
      // THIS consumer onto it (see the migration above), so releasing the
      // stale captured `shared` would decrement/delete the wrong entry and
      // leak this consumer's hold on the session that is actually live.
      const current = registry.get(sessionKey);
      if (current === undefined || !current.consumers.has(consumerId)) return;
      current.refCount -= 1;
      current.consumers.delete(consumerId);

      // ADR-0003: no grace period - tear down immediately when ref count
      // reaches 0.
      if (current.refCount === 0) {
        current.unsubscribeFromStream();
        if (registry.get(sessionKey) === current) registry.delete(sessionKey);
        notifyEntryChanged(registry, sessionKey);
      }
    };
  }, [
    registry,
    sessionKey,
    enabled,
    createSession,
    onConsumerJoined,
    consumerId,
    retryNonce,
  ]);

  // Memoized on its inputs because `useSyncExternalStore` compares the
  // subscriber by reference: a fresh closure per render would tear the
  // listener down and re-add it every time.
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeToEntry(registry, sessionKey)(onStoreChange),
    [registry, sessionKey],
  );
  const lastEvent = useSyncExternalStore(
    subscribe,
    () =>
      sessionKey === null
        ? null
        : (registry.get(sessionKey)?.lastEvent ?? null),
    () => null,
  );

  const sendRefresh = useCallback(() => {
    // Resolved at CALL time, never captured at render: the entry is mutable
    // module state and a render-time capture is exactly what the compiler
    // would freeze (see `entryListenersByRegistry`).
    const current = sessionKey === null ? undefined : registry.get(sessionKey);
    // Branching on the last ERROR frame instead would swallow the refresh
    // entirely after a NONFATAL error: that leaves the session live and
    // `isTerminal` false, so `retry()` would only bump the nonce, the
    // subscribe effect would reuse the very same entry, and no frame would
    // ever be sent.
    if (current?.isTerminal === true) {
      retry();
      return;
    }
    current?.sendRefresh();
  }, [registry, sessionKey, retry]);

  return { lastEvent, sendRefresh };
}

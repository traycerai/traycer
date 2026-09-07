/**
 * One warm-pool registry, parameterised, replacing three.
 * What is parameterised is policy (the ttl, the cap, what "busy" means, what happens instead of disposal).
 */
import type { RuntimeEnvironment } from "./runtime-environment";
import { createMonotonicSequence } from "./runtime-environment";

export type SessionKey = string;

/**
 * Length-prefixed, not joined on a separator: each part is written as its length in UTF-16 code units, a `:`, then the part itself.
 * This replaced a nul join whose doc argued "no id can contain a nul" - which is the same unenforced claim that doc rejects, one paragraph earlier, for a printable `:`.
 */
const SESSION_KEY_LENGTH_SEPARATOR = ":";

export function sessionKeyOf(parts: readonly string[]): SessionKey {
  return parts
    .map((part) => `${part.length}${SESSION_KEY_LENGTH_SEPARATOR}${part}`)
    .join("");
}

/**
 * The parts a key was built from, in order.
 * Answers `[]` for a malformed key rather than throwing: the callers use the parts to filter (which sessions belong to this host), and a filter that throws would take down a sweep over unrelated entries.
 */
export function sessionKeyPartsOf(key: SessionKey): readonly string[] {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < key.length) {
    const separator = key.indexOf(SESSION_KEY_LENGTH_SEPARATOR, cursor);
    if (separator === -1) return [];
    const length = Number(key.slice(cursor, separator));
    if (!Number.isSafeInteger(length) || length < 0) return [];
    const start = separator + 1;
    const end = start + length;
    if (end > key.length) return [];
    parts.push(key.slice(start, end));
    cursor = end;
  }
  return parts;
}
export type SessionDisposeCause =
  /** Demand reached zero and the warm window elapsed. */
  | "idle-expired"
  /** The warm cap pushed it out. */
  | "warm-overflow"
  /** The caller ended it explicitly (tab closed). */
  | "released"
  /**
   * The same identity was re-acquired under a different scope - a changed user, transport dialability, or owner identity - so the session must be rebuilt in place.
   */
  | "scope-mismatch"
  /** A replacement handle took this key over (a host re-point). */
  | "replaced"
  /**
   * The session became unusable where it stands - a terminal that exited, or one whose stream closed for good.
   */
  | "unusable"
  /** Sign-out, user switch, token expiry. Nothing survives. */
  | "dispose-all";

  /**
   * What the owning plane wants done with a session the registry would dispose.
   * Modelling it as a verdict keeps the retention rules (which are genuinely epic-specific, down to a three-axis identity match) out of the shared mechanism without letting the shared mechanism destroy work.
   */
export type SessionDisposeVerdict = "dispose" | "retain";

/**
 * Which sessions the warm cap counts.
 * A mounted epic counts against the cap; it just is not a candidate for eviction.
 */
export type WarmCapScope = "demand-free" | "all-entries";

/**
 * What the last unit of demand leaving should do, as the releasing caller sees it.
 * Required at every call site rather than defaulted, so a caller with a reason to destroy a session states it where the reason is.
 */
export type ReleaseDisposition = "warm" | "dispose";

export interface SessionRegistryPolicy<TSession> {
  /**
   * How long a demand-free session stays warm.
   * `null` means the plane has no time-based expiry at all and its warm set is bounded only by {@link maxWarm} - the open-epic registry, which prunes on acquire and never on a clock.
   */
  readonly idleTtlMs: number | null;
  /**
   * Ceiling on the population {@link warmCapScope} names, so cycling through many sessions inside one ttl window cannot pin an unbounded set of open sockets.
   */
  readonly maxWarm: number;
  /** Which sessions {@link maxWarm} counts. */
  readonly warmCapScope: WarmCapScope;
  /** Whether a busy demand-free session counts toward {@link maxWarm}. */
  readonly busyCountsTowardWarmCap: boolean;
  /**
   * Ceiling on how long a busy demand-free session may defer its own eviction.
   * Without it, a session whose work never settles is retained forever.
   */
  readonly maxActiveDeferMs: number | null;
  /**
   * Whether losing the last unit of demand refreshes a session's eviction order.
   * - epics `false` - `releaseMounted` decrements and prunes without touching `lastUsedAt`, so the epic evicted is the least recently used, not the least recently released.
   */
  readonly refreshOrderOnRelease: boolean;

  /** Whether a session that has just lost its last unit of demand should be kept warm at all. */
  retainWhenIdle(session: TSession): boolean;

  /** Whether this session is doing something that must not be interrupted. */
  hasActiveWork(session: TSession): boolean;

  /**
   * Whether this session is safe to drop at all - the epic plane's `isClean()` (no unsynced edits, no unflushed writes).
   */
  isEvictable(session: TSession): boolean;

  /**
   * Last call before teardown. Returning `"retain"` removes the entry from the
   * registry without disposing the session; the plane has taken ownership.
   */
  onBeforeDispose(
    session: TSession,
    cause: SessionDisposeCause,
  ): SessionDisposeVerdict;

  /** Tear down the session. Called only after a `"dispose"` verdict. */
  dispose(session: TSession): void;

  /**
   * A session has just been parked warm (demand reached zero, and {@link retainWhenIdle} kept it).
   * The terminal plane retags its subscription `cache` here, because "attachment intent follows lease state, not session kind: a lease-free running terminal-agent or lingering plain terminal must not claim attention".
   */
  onParked(session: TSession): void;

  /**
   * A warm session has just been re-acquired. The terminal plane retags it
   * `presentation` - "a tile looking again is presentation".
   */
  onRevived(session: TSession): void;
}

export interface SessionRegistry<TSession> {
  /** Take demand on a session, constructing it if absent. */
  acquire(key: SessionKey, scopeKey: string, factory: () => TSession): TSession;

  /** Ensure a session exists and refresh its recency, taking NO demand. */
  materialize(
    key: SessionKey,
    scopeKey: string,
    factory: () => TSession,
  ): TSession;

  /** Drop one unit of demand. The last one starts the warm clock. */
  release(key: SessionKey, disposition: ReleaseDisposition): void;

  /**
   * Drop demand held under a specific handle.
   * Guards the release against a session that was already rebuilt underneath the caller: a late unmount must not decrement demand on the replacement.
   */
  releaseHandle(
    key: SessionKey,
    session: TSession,
    disposition: ReleaseDisposition,
  ): void;

  /** Read and refresh recency. For a caller actively opening/interacting. */
  get(key: SessionKey): TSession | null;

  /**
   * Read without touching recency.
   * The distinction is not cosmetic: passive projections (a header strip reading a live title, a sidebar progress icon) must not keep a session alive just because React rendered.
   */
  peek(key: SessionKey): TSession | null;

  /**
   * The entry at `key` without touching recency.
   * The read a scope-aware caller needs: the chat registry answers `null` for a scope mismatch without disposing anything, which is a different decision from `acquire`'s rebuild and has to be made before recency moves.
   */
  peekEntry(key: SessionKey): SessionEntryView<TSession> | null;

  /** Every live session, for aggregate reads. */
  list(): readonly TSession[];

  /** Every live key, for callers that address sessions rather than read them. */
  keys(): readonly SessionKey[];

  /**
   * Every live entry, for a caller that needs the key and the session together - the two registries that answer "which sessions belong to host X" read an acquire-time identity that lives in the key, not in the session.
   */
  entries(): readonly SessionEntryView<TSession>[];

  /** End a session now regardless of demand. */
  forceRelease(key: SessionKey): void;

  /** End a session now, naming why. {@link forceRelease} is `"released"`. */
  discard(key: SessionKey, cause: SessionDisposeCause): void;

  /** Move a demand-free session to a different key, re-parking it. */
  rekey(previousKey: SessionKey, nextKey: SessionKey): boolean;

  /**
   * Atomically swap the session behind a key, inheriting its demand count.
   * A re-point has not unmounted anything - it has only changed which host supplies the data - so the demand count must carry over or the replacement is immediately evictable.
   */
  replace(key: SessionKey, previous: TSession, next: TSession): boolean;

  /** Enforce the warm cap now. */
  pruneWarm(): void;

  size(): number;

  /** Fires on membership changes and on demand transitions. */
  subscribe(listener: () => void): () => void;

  /**
   * Announce a change the registry cannot see.
   * Coalesced with whatever the current {@link transact} is doing, so a plane that emits for its own reasons still costs its subscribers one wake-up per operation rather than one per step.
   */
  notify(): void;

  /**
   * Run several registry operations as one observable step, returning whatever `operation` returns.
   * Without it, a plane method that releases and then prunes wakes every subscriber twice for one user gesture.
   */
  transact<T>(operation: () => T): T;

  /** Sign-out semantics: dispose everything, notify once. */
  disposeAll(): void;
}

export interface SessionEntryView<TSession> {
  readonly key: SessionKey;
  readonly scopeKey: string;
  readonly session: TSession;
  /** Units of demand held. `0` is a warm session. */
  readonly demand: number;
}

export interface SessionRegistryOptions<TSession> {
  readonly environment: RuntimeEnvironment;
  readonly policy: SessionRegistryPolicy<TSession>;
}

interface RegistryEntry<TSession> {
  key: SessionKey;
  readonly scopeKey: string;
  readonly session: TSession;
  demand: number;
  /** Eviction order. */
  order: number;
  /**
   * When this entry became demand-free, by the wall clock, or `null` while it is held.
   * The ttl is checked against this rather than against the timer having fired, because a timer may fire late (a throttled background tab) and firing is not proof that the window elapsed.
   */
  parkedAtMs: number | null;
  /** Pending expiry, set only while parked and only when the plane has a TTL. */
  idleTimer: { cancel(): void } | null;
}

export function createSessionRegistry<TSession>(
  options: SessionRegistryOptions<TSession>,
): SessionRegistry<TSession> {
  const { environment, policy } = options;
  const entries = new Map<SessionKey, RegistryEntry<TSession>>();
  const listeners = new Set<() => void>();
  const order = createMonotonicSequence();
  let transactionDepth = 0;
  let notifyPending = false;

  function emit(): void {
    for (const listener of Array.from(listeners)) {
      listener();
    }
  }

  function requestNotify(): void {
    if (transactionDepth > 0) {
      notifyPending = true;
      return;
    }
    emit();
  }

  function transact<T>(operation: () => T): T {
    transactionDepth += 1;
    try {
      return operation();
    } finally {
      transactionDepth -= 1;
      if (transactionDepth === 0 && notifyPending) {
        notifyPending = false;
        emit();
      }
    }
  }

  function cancelIdleTimer(entry: RegistryEntry<TSession>): void {
    if (entry.idleTimer === null) return;
    entry.idleTimer.cancel();
    entry.idleTimer = null;
  }

  /**
   * Whether a parked session gets an expiry timer.
   * A plane with no ttl never schedules one.
   */
  function shouldArmIdleTimer(entry: RegistryEntry<TSession>): boolean {
    if (policy.idleTtlMs === null) return false;
    if (policy.maxActiveDeferMs !== null) return true;
    return !policy.hasActiveWork(entry.session);
  }

  /**
   * Arm the expiry timer for `delayMs`.
   * The delay is an argument rather than always {@link SessionRegistryPolicy.idleTtlMs}, because the one caller that re-arms an already-running window has to schedule what is left of it.
   */
  function armIdleTimer(entry: RegistryEntry<TSession>, delayMs: number): void {
    cancelIdleTimer(entry);
    if (policy.idleTtlMs === null) return;
    if (!shouldArmIdleTimer(entry)) return;
    entry.idleTimer = environment.scheduler.schedule(delayMs, () => {
      entry.idleTimer = null;
      expireIfIdle(entry.key);
    });
  }

  function armFreshIdleWindow(entry: RegistryEntry<TSession>): void {
    const ttlMs = policy.idleTtlMs;
    if (ttlMs === null) return;
    armIdleTimer(entry, ttlMs);
  }

  function expireIfIdle(key: SessionKey): void {
    const entry = entries.get(key);
    if (entry === undefined) return;
    if (entry.demand > 0) return;
    const ttlMs = policy.idleTtlMs;
    if (ttlMs === null) return;
    const checkedAt = environment.clock.now();
    const parkedAtMs = entry.parkedAtMs;
    // A timer that fired is not proof the window elapsed - re-check the clock, and re-arm for what is left of the window if it has not.
    // The remainder, not a fresh `ttlMs`: a full re-arm would turn every early fire into an almost-doubled warm window, and a clock that steps backward would do it repeatedly.
    const elapsedMs = parkedAtMs === null ? ttlMs : checkedAt - parkedAtMs;
    if (elapsedMs < ttlMs) {
      armIdleTimer(entry, ttlMs - Math.max(0, elapsedMs));
      return;
    }
    if (policy.hasActiveWork(entry.session)) {
      const deferMs = policy.maxActiveDeferMs;
      // No cap on deferral means the plane keeps busy sessions warm for as long as they are busy; nothing more is scheduled, and the plane's own observation of the work finishing is what collects it.
      if (deferMs === null) return;
      const deferredForMs = parkedAtMs === null ? null : checkedAt - parkedAtMs;
      if (deferredForMs !== null && deferredForMs < deferMs) {
        // The deferral is measured from when the session went demand-free, not from this check, so a session whose work never settles goes AT the cap - and the re-arm is capped at what is left of it for that claim to be true.
        if (policy.refreshOrderOnRelease) entry.order = order.next();
        armIdleTimer(
          entry,
          Math.min(ttlMs, Math.max(0, deferMs - deferredForMs)),
        );
        return;
      }
    }
    transact(() => {
      teardown(entry, "idle-expired");
    });
  }

  /**
   * The one removal path.
   * Every caller goes through it so a plane's `"retain"` verdict cannot be bypassed by whichever route happened to reach the entry.
   */
  function teardown(
    entry: RegistryEntry<TSession>,
    cause: SessionDisposeCause,
  ): void {
    cancelIdleTimer(entry);
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    const verdict = policy.onBeforeDispose(entry.session, cause);
    if (verdict === "dispose") policy.dispose(entry.session);
    requestNotify();
  }

  function park(
    entry: RegistryEntry<TSession>,
    disposition: ReleaseDisposition,
  ): void {
    if (disposition === "dispose" || !policy.retainWhenIdle(entry.session)) {
      teardown(entry, "released");
      return;
    }
    entry.parkedAtMs = environment.clock.now();
    if (policy.refreshOrderOnRelease) entry.order = order.next();
    try {
      policy.onParked(entry.session);
    } catch (error) {
      // Fail toward disposal: the plane could not put the session into its warm state, and a warm entry whose stream is already closed would be revived later as a permanently dead one.
      environment.logger.error(
        "[session-registry] parking a released session failed",
        { key: entry.key },
        error,
      );
      teardown(entry, "released");
      return;
    }
    armFreshIdleWindow(entry);
    enforceWarmCap();
  }

  function warmPopulation(): RegistryEntry<TSession>[] {
    const population: RegistryEntry<TSession>[] = [];
    for (const entry of entries.values()) {
      if (policy.warmCapScope === "all-entries") {
        population.push(entry);
        continue;
      }
      if (entry.demand > 0) continue;
      if (
        !policy.busyCountsTowardWarmCap &&
        policy.hasActiveWork(entry.session)
      )
        continue;
      population.push(entry);
    }
    return population;
  }

  function enforceWarmCap(): void {
    // The cheap short-circuit every release takes: the counted population can
    // never exceed the total, so an under-cap registry skips the walk.
    if (entries.size <= policy.maxWarm) return;
    const overflow = warmPopulation().length - policy.maxWarm;
    if (overflow <= 0) return;
    const candidates: RegistryEntry<TSession>[] = [];
    for (const entry of entries.values()) {
      if (entry.demand > 0) continue;
      if (policy.hasActiveWork(entry.session)) continue;
      if (!policy.isEvictable(entry.session)) continue;
      candidates.push(entry);
    }
    candidates.sort((a, b) => a.order - b.order);
    transact(() => {
      for (const entry of candidates.slice(0, overflow)) {
        teardown(entry, "warm-overflow");
      }
    });
  }

  function createEntry(
    key: SessionKey,
    scopeKey: string,
    session: TSession,
    demand: number,
  ): RegistryEntry<TSession> {
    const entry: RegistryEntry<TSession> = {
      key,
      scopeKey,
      session,
      demand,
      order: order.next(),
      parkedAtMs: demand > 0 ? null : environment.clock.now(),
      idleTimer: null,
    };
    entries.set(key, entry);
    requestNotify();
    return entry;
  }

  function attach(
    key: SessionKey,
    scopeKey: string,
    factory: () => TSession,
    demand: number,
  ): TSession {
    return transact<TSession>(() => {
      const existing = entries.get(key);
      if (existing !== undefined && existing.scopeKey !== scopeKey) {
        // Same key, but the session was opened against an older user/transport/owner-identity scope.
        // Close it before creating the replacement so callers never get a store backed by a stale client.
        teardown(existing, "scope-mismatch");
      } else if (existing !== undefined) {
        const wasWarm = existing.demand === 0;
        existing.demand += demand;
        existing.order = order.next();
        if (wasWarm && existing.demand > 0) {
          existing.parkedAtMs = null;
          cancelIdleTimer(existing);
          try {
            policy.onRevived(existing.session);
          } catch (error) {
            // Fail toward disposal, the same answer `park` gives a failed `onParked`, and for a sharper reason.
            // Torn down and rethrown, not swallowed: the caller's acquire failed either way, and this only changes what is left behind.
            environment.logger.error(
              "[session-registry] reviving a warm session failed",
              { key: existing.key },
              error,
            );
            teardown(existing, "released");
            throw error;
          }
        } else if (wasWarm) {
          // Still demand-free: a read that refreshes recency also restarts the eviction window, which is what stops a passive reader from being the only thing keeping the window open and the only thing closing it.
          existing.parkedAtMs = environment.clock.now();
          armFreshIdleWindow(existing);
        }
        return existing.session;
      }
      const created = createEntry(key, scopeKey, factory(), demand);
      if (created.demand === 0) armFreshIdleWindow(created);
      return created.session;
    });
  }

  function dropDemand(
    entry: RegistryEntry<TSession>,
    disposition: ReleaseDisposition,
  ): void {
    // Refcount underflow guard: a stray double-release must not drive demand negative, which a later acquire would revive only to 0 - leaving an in-use session tracked as warm and eligible for eviction.
    if (entry.demand <= 0) return;
    entry.demand -= 1;
    if (entry.demand > 0) return;
    transact(() => {
      park(entry, disposition);
    });
  }

  return {
    acquire: (key, scopeKey, factory) => attach(key, scopeKey, factory, 1),
    materialize: (key, scopeKey, factory) => attach(key, scopeKey, factory, 0),

    release(key, disposition) {
      const entry = entries.get(key);
      if (entry === undefined) return;
      dropDemand(entry, disposition);
    },

    releaseHandle(key, session, disposition) {
      const entry = entries.get(key);
      if (entry === undefined || entry.session !== session) return;
      dropDemand(entry, disposition);
    },

    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      entry.order = order.next();
      if (entry.demand === 0) {
        entry.parkedAtMs = environment.clock.now();
        armFreshIdleWindow(entry);
      }
      return entry.session;
    },

    peek: (key) => entries.get(key)?.session ?? null,

    peekEntry(key) {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      return {
        key: entry.key,
        scopeKey: entry.scopeKey,
        session: entry.session,
        demand: entry.demand,
      };
    },

    list: () => Array.from(entries.values(), (entry) => entry.session),

    keys: () => Array.from(entries.keys()),

    entries: () =>
      Array.from(entries.values(), (entry) => ({
        key: entry.key,
        scopeKey: entry.scopeKey,
        session: entry.session,
        demand: entry.demand,
      })),

    forceRelease(key) {
      const entry = entries.get(key);
      if (entry === undefined) return;
      transact(() => {
        teardown(entry, "released");
      });
    },

    discard(key, cause) {
      const entry = entries.get(key);
      if (entry === undefined) return;
      transact(() => {
        teardown(entry, cause);
      });
    },

    rekey(previousKey, nextKey) {
      const entry = entries.get(previousKey);
      if (entry === undefined) return false;
      if (entry.demand > 0) return false;
      if (entries.has(nextKey)) return false;
      transact(() => {
        cancelIdleTimer(entry);
        entries.delete(previousKey);
        entry.key = nextKey;
        entries.set(nextKey, entry);
        // Re-parked rather than carried over: an adoption whose acquire never lands (a tile that errored before the handle enabled) would otherwise leave the entry warm forever.
        park(entry, "warm");
        requestNotify();
      });
      return true;
    },

    replace(key, previous, next) {
      const existing = entries.get(key);
      if (existing === undefined || existing.session !== previous) return false;
      transact(() => {
        cancelIdleTimer(existing);
        entries.delete(key);
        // The replacement is freshly used, not a continuation of the outgoing entry's recency: `OpenEpicSessionRegistry.replaceMounted` builds its entry through the same constructor an acquire uses, which takes a new tick.
        const replacement = createEntry(
          key,
          existing.scopeKey,
          next,
          existing.demand,
        );
        const verdict = policy.onBeforeDispose(existing.session, "replaced");
        if (verdict === "dispose") policy.dispose(existing.session);
        // A replacement that inherits no demand is warm from the moment it
        // lands, so its window starts here rather than at the next release.
        if (replacement.demand === 0) armFreshIdleWindow(replacement);
      });
      return true;
    },

    pruneWarm: () => enforceWarmCap(),

    size: () => entries.size,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    notify: () => requestNotify(),

    transact,

    disposeAll() {
      if (entries.size === 0) return;
      transact(() => {
        for (const entry of Array.from(entries.values())) {
          teardown(entry, "dispose-all");
        }
        entries.clear();
      });
    },
  };
}

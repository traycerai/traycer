/**
 * One warm-pool registry, parameterised, replacing three.
 *
 * There are currently three independent implementations of this idea - chats
 * (388 lines), terminals ("the terminal twin", 434 lines), and the registry
 * core inside the open-epic registry (982 lines) - with three eviction policies
 * for one problem. They differ in vocabulary, not in mechanism: every one of
 * them counts demand, keeps a released session warm for a while, bounds the
 * warm set, and refuses to evict a session that is still doing something.
 *
 * What is parameterised is POLICY (the TTL, the cap, what "busy" means, what
 * happens instead of disposal). What is not parameterised is the mechanism, and
 * that is deliberate: each plane keeps its own policy VALUES, so unifying is a
 * deletion rather than a behaviour change.
 *
 * That last sentence is a constraint on this file, not a hope. Every member of
 * {@link SessionRegistryPolicy} names the incumbent code its value comes from,
 * so that "unifying changed nothing" is checkable knob by knob rather than
 * argued. Where the three planes genuinely disagreed - and they disagree on
 * more than the original five members could express - the disagreement is a
 * named member here rather than a branch, an averaged value, or a plane
 * quietly adopting another's answer.
 */
import type { RuntimeEnvironment } from "./runtime-environment";
import { createMonotonicSequence } from "./runtime-environment";

/**
 * A registry key built from its parts.
 *
 * Always construct it with {@link sessionKeyOf} and read it back with
 * {@link sessionKeyPartsOf}. The parts are opaque user/host-minted ids, so ANY
 * separator lets a part contain that separator and collide two distinct tuples
 * onto a single entry - which for the chat registry meant one tile's `acquire`
 * disposing another's live websocket. The encoding is length-prefixed for that
 * reason: it reserves no character, so there is no "but nothing can contain
 * THIS one" left to be wrong about.
 */
export type SessionKey = string;

/**
 * LENGTH-PREFIXED, not joined on a separator: each part is written as its
 * length in UTF-16 code units, a `:`, then the part itself.
 *
 * This replaced a NUL join whose doc argued "no id can contain a NUL" - which
 * is the same unenforced claim that doc rejects, one paragraph earlier, for a
 * printable `:`. Nothing excludes U+0000 anywhere on the path: the protocol
 * fields are bare `z.string()`, JSON carries a NUL fine, and a `hostId` is
 * adopted VERBATIM from `~/.traycer/host-id` with only a `trim()`, which does
 * not strip NUL because NUL is not whitespace. So `["a\u0000b","c"]` and
 * `["a","b\u0000c"]` folded onto one key, and per this file's own incident
 * that means one tile's `acquire` disposing another tile's live websocket.
 *
 * A length prefix is injective for EVERY part, with no character reserved and
 * so no next character to be argued about: the decoder never has to search for
 * a delimiter, it is told how far to read. `.length` and `.slice()` both count
 * UTF-16 code units, so a part holding a surrogate pair round-trips too.
 */
const SESSION_KEY_LENGTH_SEPARATOR = ":";

export function sessionKeyOf(parts: readonly string[]): SessionKey {
  return parts
    .map((part) => `${part.length}${SESSION_KEY_LENGTH_SEPARATOR}${part}`)
    .join("");
}

/**
 * The parts a key was built from, in order.
 *
 * Exported beside the encoder because a key's readers must not re-derive its
 * format: the chat registry kept its own copy of the separator and split on
 * it, so re-encoding here would have left that parser reading a shape nobody
 * writes - a silent mismatch rather than a type error.
 *
 * Answers `[]` for a malformed key rather than throwing: the callers use the
 * parts to FILTER (which sessions belong to this host), and a filter that
 * throws would take down a sweep over unrelated entries.
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
/**
 * Why a session is about to be torn down.
 *
 * Passed to {@link SessionRegistryPolicy.onBeforeDispose} because the three
 * planes answer differently per cause, and folding them into one boolean is
 * what let an involuntary teardown destroy unsynced edits the user was never
 * asked about.
 */
export type SessionDisposeCause =
  /** Demand reached zero and the warm window elapsed. */
  | "idle-expired"
  /** The warm cap pushed it out. */
  | "warm-overflow"
  /** The caller ended it explicitly (tab closed). */
  | "released"
  /**
   * The same identity was re-acquired under a different scope - a changed
   * user, transport dialability, or owner identity - so the session must be
   * rebuilt in place.
   */
  | "scope-mismatch"
  /** A replacement handle took this key over (a host re-point). */
  | "replaced"
  /**
   * The session became unusable where it stands - a terminal that exited, or
   * one whose stream closed for good. Distinct from `"released"` because
   * nobody asked for it: the terminal registry drops such an entry the moment
   * it is demand-free, and a plane that treats an involuntary teardown like a
   * requested one is how work gets destroyed without a decision.
   */
  | "unusable"
  /** Sign-out, user switch, token expiry. Nothing survives. */
  | "dispose-all";

/**
 * What the owning plane wants done with a session the registry would dispose.
 *
 * `"retain"` is the escape hatch that keeps this interface honest for the epic
 * plane, whose sessions can hold unsynced edits with no local persistence
 * anywhere behind them. That plane moves the handle into its own retention
 * store instead - the registry stops tracking it, and the plane owns its fate
 * from then on. Modelling it as a verdict keeps the retention rules (which are
 * genuinely epic-specific, down to a three-axis identity match) out of the
 * shared mechanism without letting the shared mechanism destroy work.
 */
export type SessionDisposeVerdict = "dispose" | "retain";

/**
 * Which sessions the warm cap counts.
 *
 * The three planes cap three different populations, and every one of them has
 * a recorded reason, so this is a fact about the plane rather than a tuning
 * choice:
 *
 *  - `"demand-free"` - the chat and terminal registries bound the WARM pool.
 *    "Leased sessions are outside the warm pool" is stated in both, and it is
 *    why a window with many open tiles keeps them all.
 *  - `"all-entries"` - the open-epic registry bounds the RESIDENT set
 *    (`DEFAULT_MAX_LIVE_EPICS`, `entries.size <= maxLive`). A mounted epic
 *    counts against the cap; it just is not a candidate for eviction.
 */
export type WarmCapScope = "demand-free" | "all-entries";

/**
 * What the LAST unit of demand leaving should do, as the releasing caller sees
 * it.
 *
 * Separate from {@link SessionRegistryPolicy.retainWhenIdle} because the two
 * answer different questions: that one is about the session (is this worth
 * keeping), this one is about the moment (can it even be kept). The terminal
 * registry's `transportAlive` is the live case - the acquire effect's readiness
 * at cleanup time - and it "fails toward disposal" because the captured factory
 * throws once the directory or user is gone, and a throw from effect cleanup
 * would leave a demand-free entry whose stream is already closed.
 *
 * Required at every call site rather than defaulted, so a caller with a reason
 * to destroy a session states it where the reason is.
 */
export type ReleaseDisposition = "warm" | "dispose";

export interface SessionRegistryPolicy<TSession> {
  /**
   * How long a demand-free session stays warm. Its websocket stays open and
   * its snapshot is retained, so switching back paints instantly.
   *
   * `null` means the plane has no time-based expiry at all and its warm set is
   * bounded only by {@link maxWarm} - the open-epic registry, which prunes on
   * acquire and never on a clock. It is `null` rather than a very large number
   * because `setTimeout(fn, Infinity)` fires immediately in a browser, so a
   * sentinel would be the eviction it is trying to suppress.
   *
   * Incumbent values: chats `DEFAULT_CHAT_IDLE_TTL_MS` (10 min); terminals
   * `PLAIN_TERMINAL_RELEASE_LINGER_MS` (10 min, explicitly "matches
   * `DEFAULT_CHAT_IDLE_TTL_MS` so a tab switch treats the chats and the
   * terminals it hides identically"); epics none.
   */
  readonly idleTtlMs: number | null;
  /**
   * Ceiling on the population {@link warmCapScope} names, so cycling through
   * many sessions inside one TTL window cannot pin an unbounded set of open
   * sockets. Oldest-released go first.
   *
   * Incumbent values: chats `DEFAULT_MAX_WARM_CHAT_SESSIONS` (6); terminals
   * `MAX_LINGERING_PLAIN_TERMINALS` (6, "mirrors
   * `DEFAULT_MAX_WARM_CHAT_SESSIONS`"); epics `DEFAULT_MAX_LIVE_EPICS` (5).
   */
  readonly maxWarm: number;
  /** Which sessions {@link maxWarm} counts. */
  readonly warmCapScope: WarmCapScope;
  /**
   * Whether a busy demand-free session counts toward {@link maxWarm}.
   *
   * The two planes that bound a warm pool answer this oppositely, both with a
   * reason on the record, so it cannot be settled either way in the mechanism:
   *
   *  - chats `true` - "Lease-free sessions with active chat work are never
   *    evicted by the cap, but they still contribute to overflow and can crowd
   *    out older inactive warm sessions."
   *  - terminals `false` - the linger cap counts lingering plain terminals
   *    only, because "counting them would let N running agents flush every
   *    lingering shell immediately".
   *
   * Under `"all-entries"` this is not consulted: that scope counts everything
   * already.
   */
  readonly busyCountsTowardWarmCap: boolean;
  /**
   * Ceiling on how long a busy demand-free session may defer its own eviction.
   * Without it, a session whose work never settles is retained forever.
   *
   * `null` is that forever, chosen deliberately by the terminal plane: a
   * running terminal-agent "is kept warm indefinitely (its tab may reopen any
   * time while the agent works)". A plane that defers indefinitely arms no
   * expiry timer for a busy session at all, so `null` is not a very large
   * timeout - it is the absence of one.
   *
   * Incumbent values: chats `MAX_ACTIVE_CHAT_IDLE_DEFER_MS` (60 min);
   * terminals none; epics not applicable (no TTL).
   */
  readonly maxActiveDeferMs: number | null;
  /**
   * Whether losing the last unit of demand refreshes a session's eviction
   * order.
   *
   * Not cosmetic, and the planes split on it:
   *
   *  - chats and terminals `true` - a released session goes to the BACK of the
   *    eviction queue. Chats set `entry.lastUsedAt = releasedAt` on release;
   *    terminals stamp `releaseSequence` at park time and sort on it.
   *  - epics `false` - `releaseMounted` decrements and prunes without touching
   *    `lastUsedAt`, so the epic evicted is the least recently USED, not the
   *    least recently released. Refreshing here would change which epic a
   *    prune picks.
   */
  readonly refreshOrderOnRelease: boolean;

  /**
   * Whether a session that has just lost its last unit of demand should be
   * kept warm at all.
   *
   * `false` disposes it immediately instead of parking it, which is the
   * terminal plane's rule for a session that can no longer serve a reattach:
   * an exited session is disposed "as soon as the last lease releases", and a
   * plain terminal whose stream is `lost` or `reaped` must not be revived
   * because reviving it "would shadow the fresh create-then-acquire bootstrap
   * after recovery".
   *
   * Distinct from {@link isEvictable}, which asks whether a session may be
   * destroyed. This asks whether it is worth keeping. Chats and epics answer
   * `true` unconditionally.
   */
  retainWhenIdle(session: TSession): boolean;

  /**
   * Whether this session is doing something that must not be interrupted.
   *
   * Injected because it means something different per plane and every meaning
   * is load-bearing: a chat parked on a human approval gate is IN PROGRESS (the
   * turn is blocked on the user, and the host holds its session alive in the
   * same situation), and an epic with an agent working in it must stop being
   * prunable without waiting for an unrelated store write.
   *
   * A busy session is deferred, not exempt - whether it still counts toward
   * {@link maxWarm} is {@link busyCountsTowardWarmCap}.
   */
  hasActiveWork(session: TSession): boolean;

  /**
   * Whether this session is safe to drop at all - the epic plane's `isClean()`
   * (no unsynced edits, no unflushed writes). Independent of
   * {@link hasActiveWork}: one is about work in flight, the other about work
   * that would be LOST.
   */
  isEvictable(session: TSession): boolean;

  /**
   * Last call before teardown. Returning `"retain"` removes the entry from the
   * registry WITHOUT disposing the session; the plane has taken ownership.
   */
  onBeforeDispose(
    session: TSession,
    cause: SessionDisposeCause,
  ): SessionDisposeVerdict;

  /** Tear down the session. Called only after a `"dispose"` verdict. */
  dispose(session: TSession): void;

  /**
   * A session has just been parked warm (demand reached zero, and
   * {@link retainWhenIdle} kept it).
   *
   * The terminal plane retags its subscription `cache` here, because
   * "attachment intent follows lease state, not session kind: a lease-free
   * running terminal-agent or lingering plain terminal must not claim
   * attention". A THROW is meaningful and not swallowed: that plane's
   * `setViewer` can fail when the transport is already gone, and it "fails
   * toward disposal" rather than leaving a warm entry whose stream is closed.
   */
  onParked(session: TSession): void;

  /**
   * A warm session has just been re-acquired. The terminal plane retags it
   * `presentation` - "a tile looking again is presentation".
   */
  onRevived(session: TSession): void;
}

export interface SessionRegistry<TSession> {
  /**
   * Take demand on a session, constructing it if absent.
   *
   * `scopeKey` discriminates rebuilds WITHIN one identity (a changed user,
   * transport, or owner identity). A mismatch disposes and rebuilds; it is not
   * part of the key, because a different scope is the same session rebuilt
   * while a different key is a different session. Getting that backwards is
   * what made two hosts' same-id chats one entry.
   */
  acquire(key: SessionKey, scopeKey: string, factory: () => TSession): TSession;

  /**
   * Ensure a session exists and refresh its recency, taking NO demand.
   *
   * A distinct operation rather than an oversight, and the open-epic registry
   * is the plane that needs it: its cap bounds the resident set, so "this epic
   * exists and is the most recently used" is a meaningful state that nothing is
   * currently holding. A session materialized this way is immediately eligible
   * for the cap, which is exactly what `OpenEpicSessionRegistry.acquire` (as
   * opposed to `acquireMounted`) has always meant.
   */
  materialize(
    key: SessionKey,
    scopeKey: string,
    factory: () => TSession,
  ): TSession;

  /** Drop one unit of demand. The last one starts the warm clock. */
  release(key: SessionKey, disposition: ReleaseDisposition): void;

  /**
   * Drop demand held under a specific handle.
   *
   * Guards the release against a session that was already rebuilt underneath
   * the caller: a late unmount must not decrement demand on the replacement.
   */
  releaseHandle(
    key: SessionKey,
    session: TSession,
    disposition: ReleaseDisposition,
  ): void;

  /** Read and refresh recency. For a caller actively opening/interacting. */
  get(key: SessionKey): TSession | null;

  /**
   * Read WITHOUT touching recency.
   *
   * The distinction is not cosmetic: passive projections (a header strip
   * reading a live title, a sidebar progress icon) must not keep a session
   * alive just because React rendered.
   */
  peek(key: SessionKey): TSession | null;

  /**
   * The entry at `key` without touching recency.
   *
   * The read a scope-aware caller needs: the chat registry answers `null` for a
   * SCOPE mismatch without disposing anything, which is a different decision
   * from `acquire`'s rebuild and has to be made before recency moves.
   */
  peekEntry(key: SessionKey): SessionEntryView<TSession> | null;

  /** Every live session, for aggregate reads. */
  list(): readonly TSession[];

  /** Every live key, for callers that address sessions rather than read them. */
  keys(): readonly SessionKey[];

  /**
   * Every live entry, for a caller that needs the key and the session
   * together - the two registries that answer "which sessions belong to host
   * X" read an acquire-time identity that lives in the key, not in the
   * session.
   */
  entries(): readonly SessionEntryView<TSession>[];

  /** End a session now regardless of demand. */
  forceRelease(key: SessionKey): void;

  /** End a session now, naming why. {@link forceRelease} is `"released"`. */
  discard(key: SessionKey, cause: SessionDisposeCause): void;

  /**
   * Move a demand-free session to a different key, re-parking it.
   *
   * The terminal plane's tab-reopen adoption: closing a tab keeps a running
   * session warm, but reopening mints a fresh tab instance id, and without
   * this the reopened tile builds a SECOND subscription while the warm one
   * lingers as an unreachable zombie. Refuses when the entry is held, absent,
   * or the target key is taken, so a losing race is a no-op.
   */
  rekey(previousKey: SessionKey, nextKey: SessionKey): boolean;

  /**
   * Atomically swap the session behind a key, inheriting its demand count.
   *
   * A re-point has not unmounted anything - it has only changed which host
   * supplies the data - so the demand count must carry over or the replacement
   * is immediately evictable. Returns `false` when `previous` is no longer the
   * session at `key`, so a losing race is a no-op rather than a silent
   * overwrite.
   */
  replace(key: SessionKey, previous: TSession, next: TSession): boolean;

  /**
   * Enforce the warm cap now.
   *
   * Public because eligibility is not only the registry's to observe: the epic
   * plane learns that a session became clean, or that its agents stopped
   * working, from subscriptions the registry does not own, and an entry that
   * became evictable while over the cap has to be collected then rather than
   * at the next acquire.
   */
  pruneWarm(): void;

  size(): number;

  /** Fires on membership changes and on demand transitions. */
  subscribe(listener: () => void): () => void;

  /**
   * Announce a change the registry cannot see.
   *
   * Coalesced with whatever the current {@link transact} is doing, so a plane
   * that emits for its own reasons still costs its subscribers one wake-up per
   * operation rather than one per step.
   */
  notify(): void;

  /**
   * Run several registry operations as ONE observable step, returning whatever
   * `operation` returns.
   *
   * Without it, a plane method that releases and then prunes wakes every
   * subscriber twice for one user gesture. The incumbent registries all emit
   * exactly once per public method, and this is what preserves that while
   * their internals become calls into here.
   *
   * The return type is a parameter, not `void`, because a plane method that
   * batches is usually also a method that ANSWERS - `acquire` hands back the
   * handle it attached, `replaceMounted` hands back whether it won the race.
   * Declaring `void` here still accepts a value-returning callback (a
   * `() => T` is assignable to a `() => void`), so the value is simply
   * swallowed at the boundary and the caller's own `return` becomes `void` -
   * which is a type error at the caller and NOTHING at all under a test
   * runner that transpiles instead of type-checking.
   */
  transact<T>(operation: () => T): T;

  /** Sign-out semantics: dispose everything, notify once. */
  disposeAll(): void;
}

/** One live entry, as a reader sees it. */
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
  /**
   * Eviction order. A monotonic counter rather than a clock read: two releases
   * in one synchronous batch (`closeAllTabs`) land on the same millisecond and
   * make a `Date.now()`-ordered sort ambiguous - the terminal registry says so
   * in as many words, and the room tier records the same reason.
   */
  order: number;
  /**
   * When this entry became demand-free, by the wall clock, or `null` while it
   * is held. The TTL is checked against this rather than against the timer
   * having fired, because a timer may fire late (a throttled background tab)
   * and firing is not proof that the window elapsed.
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
   *
   * A plane with no TTL never schedules one. A plane that defers busy sessions
   * indefinitely schedules none for a session that is busy at park time -
   * arming a timer that can only ever re-arm itself is not the same as the
   * terminal plane's "kept warm indefinitely", it is that plus a wake-up every
   * ten minutes for the life of the agent.
   */
  function shouldArmIdleTimer(entry: RegistryEntry<TSession>): boolean {
    if (policy.idleTtlMs === null) return false;
    if (policy.maxActiveDeferMs !== null) return true;
    return !policy.hasActiveWork(entry.session);
  }

  /**
   * Arm the expiry timer for `delayMs`.
   *
   * The delay is an ARGUMENT rather than always {@link
   * SessionRegistryPolicy.idleTtlMs}, because the one caller that re-arms an
   * already-running window has to schedule what is LEFT of it. Passing the full
   * TTL there extends the warm window by almost a whole second window every
   * time a timer fires early, which is the thing the early-fire re-check exists
   * to prevent - it would replace "evicts too soon" with "evicts twice as
   * late", and the clock re-check would read as a guard while doing the
   * opposite of what it says.
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

  /**
   * Start a session's warm window from now.
   *
   * What every caller that is STARTING a window wants. The two inside
   * {@link expireIfIdle} are not: the early-fire re-check wants what is left of
   * the window, and the active-work deferral wants what is left of the CAP -
   * both arm {@link armIdleTimer} with a computed remainder and say why.
   */
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
    // A timer that fired is not proof the window elapsed - re-check the clock,
    // and re-arm for what is LEFT of the window if it has not.
    //
    // The remainder, not a fresh `ttlMs`: a full re-arm would turn every early
    // fire into an almost-doubled warm window, and a clock that steps BACKWARD
    // would do it repeatedly. `Math.max(0, …)` on the elapsed term is what
    // bounds that case - a backward step makes the elapsed time negative, and
    // without the clamp the remainder would exceed the window the session was
    // promised. The re-arm can therefore shorten the wait but never lengthen
    // it past one full window.
    const elapsedMs = parkedAtMs === null ? ttlMs : checkedAt - parkedAtMs;
    if (elapsedMs < ttlMs) {
      armIdleTimer(entry, ttlMs - Math.max(0, elapsedMs));
      return;
    }
    if (policy.hasActiveWork(entry.session)) {
      const deferMs = policy.maxActiveDeferMs;
      // No cap on deferral means the plane keeps busy sessions warm for as
      // long as they are busy; nothing more is scheduled, and the plane's own
      // observation of the work finishing is what collects it.
      if (deferMs === null) return;
      const deferredForMs = parkedAtMs === null ? null : checkedAt - parkedAtMs;
      if (deferredForMs !== null && deferredForMs < deferMs) {
        // The deferral is measured from when the session went demand-free, not
        // from this check, so a session whose work never settles goes AT the
        // cap - and the re-arm is capped at what is left of it for that claim
        // to be true. A fresh `ttlMs` here overshoots by up to one full window
        // and does it on the ordinary path, not a pathological one: the check
        // that lands just inside the cap arms another whole TTL beyond it, and
        // a callback delayed by browser timer throttling puts every later
        // check off the cap's grid as well. Production's 10-minute TTL under a
        // 60-minute cap ran nine minutes long from one callback that fired at
        // minute 19.
        //
        // `Math.max(0, …)` guards the same backward clock step the early-fire
        // re-arm above guards, from the other side: a backward step makes
        // `deferredForMs` small, never negative here (the branch requires it
        // below `deferMs`), but a forward step past the cap would make the
        // remainder negative and arm a timer in the past.
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
   * The ONE removal path. Every caller goes through it so a plane's
   * `"retain"` verdict cannot be bypassed by whichever route happened to
   * reach the entry.
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
      // Fail toward disposal: the plane could not put the session into its
      // warm state, and a warm entry whose stream is already closed would be
      // revived later as a permanently dead one.
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

  /** The population {@link SessionRegistryPolicy.maxWarm} counts. */
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
        // Same key, but the session was opened against an older
        // user/transport/owner-identity scope. Close it before creating the
        // replacement so callers never get a store backed by a stale client.
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
            // FAIL TOWARD DISPOSAL, the same answer `park` gives a failed
            // `onParked`, and for a sharper reason. The terminal plane's
            // `onRevived` retags the session `presentation`, and that
            // `setViewer` reconstructs the stream synchronously - which throws
            // when the captured transport or directory has since disappeared.
            //
            // By then the demand transition has already happened: demand is
            // incremented, `parkedAtMs` is cleared and the idle timer is
            // cancelled. So the throw escaped `attach` with no handle
            // returned, meaning no caller owes a release - and the registry
            // kept an unreachable entry with POSITIVE demand, which can
            // neither expire (no idle timer, not parked) nor be pruned (the
            // warm population excludes anything with demand). One failed
            // revival leaked a session for the life of the process.
            //
            // Torn down and rethrown, not swallowed: the caller's acquire
            // failed either way, and this only changes what is left behind.
            environment.logger.error(
              "[session-registry] reviving a warm session failed",
              { key: existing.key },
              error,
            );
            teardown(existing, "released");
            throw error;
          }
        } else if (wasWarm) {
          // Still demand-free: a read that refreshes recency also restarts the
          // eviction window, which is what stops a passive reader from being
          // the only thing keeping the window open AND the only thing closing
          // it.
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
    // Refcount underflow guard: a stray double-release must not drive demand
    // negative, which a later acquire would revive only to 0 - leaving an
    // in-use session tracked as warm and eligible for eviction.
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
        // Re-parked rather than carried over: an adoption whose acquire never
        // lands (a tile that errored before the handle enabled) would
        // otherwise leave the entry warm forever.
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
        // The replacement is freshly used, not a continuation of the outgoing
        // entry's recency: `OpenEpicSessionRegistry.replaceMounted` builds its
        // entry through the same constructor an acquire uses, which takes a new
        // tick.
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

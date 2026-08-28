/**
 * One warm-pool registry, parameterised, replacing three.
 *
 * There are currently three independent implementations of this idea - chats
 * (388 lines), terminals ("the terminal twin", 344 lines), and the registry
 * core inside the open-epic registry (982 lines) - with three eviction policies
 * for one problem. They differ in vocabulary, not in mechanism: every one of
 * them counts demand, keeps a released session warm for a while, bounds the
 * warm set, and refuses to evict a session that is still doing something.
 *
 * What is parameterised is POLICY (the TTL, the cap, what "busy" means, what
 * happens instead of disposal). What is not parameterised is the mechanism, and
 * that is deliberate: each plane keeps its own policy VALUES, so unifying is a
 * deletion rather than a behaviour change.
 */
import type { RuntimeEnvironment } from "./runtime-environment";

/**
 * A registry key built from its parts.
 *
 * Always construct it with {@link sessionKeyOf}. The parts are opaque
 * user/host-minted ids, so a printable separator lets one part contain the
 * separator and collide two distinct tuples onto a single entry - which for the
 * chat registry meant one tile's `acquire` disposing another's live websocket.
 */
export type SessionKey = string;

/**
 * NUL-joined, because no id can contain a NUL. A `:`-joined key is forgeable by
 * any part that may contain a `:`, and "may contain" is not a property anyone
 * can hold true across a schema change.
 */
const SESSION_KEY_SEPARATOR = "\u0000";

export function sessionKeyOf(parts: readonly string[]): SessionKey {
  return parts.join(SESSION_KEY_SEPARATOR);
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

export interface SessionRegistryPolicy<TSession> {
  /**
   * How long a demand-free session stays warm. Its websocket stays open and
   * its snapshot is retained, so switching back paints instantly.
   */
  readonly idleTtlMs: number;
  /**
   * Ceiling on demand-free sessions, so cycling through many inside one TTL
   * window cannot pin an unbounded set of open sockets. Oldest-released go
   * first. Leased sessions are outside this pool.
   */
  readonly maxWarm: number;
  /**
   * Ceiling on how long a busy demand-free session may defer its own eviction.
   * Without it, a session whose work never settles is retained forever.
   */
  readonly maxActiveDeferMs: number;

  /**
   * Whether this session is doing something that must not be interrupted.
   *
   * Injected because it means something different per plane and every meaning
   * is load-bearing: a chat parked on a human approval gate is IN PROGRESS (the
   * turn is blocked on the user, and the host holds its session alive in the
   * same situation), and an epic with an agent working in it must stop being
   * prunable without waiting for an unrelated store write.
   *
   * A busy session is deferred, not exempt - it still counts toward
   * {@link maxWarm} and can crowd out older idle sessions.
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
  acquire(
    key: SessionKey,
    scopeKey: string,
    factory: () => TSession,
  ): TSession;

  /** Drop one unit of demand. The last one starts the warm clock. */
  release(key: SessionKey): void;

  /**
   * Drop demand held under a specific handle.
   *
   * Guards the release against a session that was already rebuilt underneath
   * the caller: a late unmount must not decrement demand on the replacement.
   */
  releaseHandle(key: SessionKey, session: TSession): void;

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

  /** Every live session, for aggregate reads. */
  list(): readonly TSession[];

  /** Sessions matching a caller-supplied predicate, without touching recency. */
  filter(predicate: (session: TSession) => boolean): readonly TSession[];

  /** End a session now regardless of demand. */
  forceRelease(key: SessionKey): void;

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

  size(): number;

  /** Fires on membership changes and on demand transitions. */
  subscribe(listener: () => void): () => void;

  /** Sign-out semantics: dispose everything, notify once. */
  disposeAll(): void;
}

export interface SessionRegistryOptions<TSession> {
  readonly environment: RuntimeEnvironment;
  readonly policy: SessionRegistryPolicy<TSession>;
}

/**
 * The selection authority's engine (host-lifecycle redesign, D16 / P1.1) - the
 * per-app singleton that owns the connection-evidence kernel and broadcasts
 * the selection tuple plus per-host lease snapshots.
 *
 * The wire/type contract it implements is
 * `./selection-authority-contract.ts` (settled by the P1.0 design review,
 * revision 9); every rule cited as "module header rule N" or "mechanism N"
 * below lives there. This module is the transport-agnostic implementation:
 * plain TS, no Electron, no IPC, no DOM. Desktop mounts it in the main
 * process behind the IPC binding; browser/dev mounts it in the single window
 * behind the in-process adapter.
 *
 * ## What this ticket implements, and what it deliberately does not
 *
 * P1.1 lands the authority skeleton and the whole evidence kernel: attach
 * rotation and retirement, unique-revision emission, dial/session/compat/
 * restart-intent aggregation, lease derivation, identity transitions and the
 * fleet port's race rules. Three surfaces carry a NAMED interim backing until
 * their own ticket lands - each is marked `INTERIM BACKING` at its site:
 *
 *  - `preferredHostId` has no writer (P1.2 owns `activate`, persistence and
 *    identity scoping), so it is `null` for the engine's whole life here.
 *  - `effectiveHostId` is `null`: deriving it is the failover engine's job
 *    (P1.3 - candidate enumeration, damping, `LocalHostEnsurePort`).
 *  - `activate` refuses every well-formed request with `unrecognized` (P1.2).
 *
 * `targetHostId` is NOT interim: `preferred ?? localHostId` is the settled M5
 * rule and is implemented here, so the `fleet-shift` cause has a real
 * producer from day one (the local host id appearing at startup is the
 * contract's own example).
 *
 * ## Evidence hierarchy (invariant 5) is structural here
 *
 * The engine has no cloud-DTO input at all: {@link HostFleetSnapshot} carries
 * identity and membership, never a status word. A DTO flip therefore cannot
 * reach a lease verdict even by accident - the type system has no channel for
 * it. Death is only ever reached through
 * {@link CONFIRMED_DEATH_REFUSAL_STREAK} consecutive transport-confirmed
 * refusals/timeouts across THE APP's attempts, and any live session for a
 * host suppresses that accumulation entirely.
 */
import {
  SELECTION_AUTHORITY_CONTRACT_VERSION,
  leaseEquals,
  type ActivateResult,
  type AuthorityIdentitySource,
  type HostFleetSnapshot,
  type HostFleetSource,
  type HostLeaseSnapshot,
  type LiveSessionAnnouncement,
  type LocalHostEnsurePort,
  type LocalHostOutageSignal,
  type SelectionAttachRequest,
  type SelectionAttachResult,
  type SelectionAuthorityEngine,
  type SelectionAuthoritySnapshot,
  type SelectionChange,
  type SelectionChangeCause,
  type SelectionEvidenceReport,
  type SelectionIncompatibility,
  type SelectionReattachRequired,
  type SelectionRevisioned,
  type SelectionSubscription,
  type SelectionTransportKind,
} from "./selection-authority-contract";

/**
 * How many CONSECUTIVE transport-confirmed refusals/timeouts - counted across
 * every window's attempts, deduplicated per (incarnation, attemptId) - make a
 * host `dead` (connection registry §2).
 *
 * Three, not one: the registry's target is "confirmation within ~5-10 s of
 * real death, not one failed probe". The transports pace their own redials
 * (backoff), so three consecutive refusals land inside that window in
 * practice while a single unlucky refusal never does. There is deliberately
 * NO elapsed-time floor on top of the count: an app-wide streak is exactly
 * what the registry defines as evidence ("two windows each seeing one refusal
 * is the same evidence as one window seeing two"), and a time floor would
 * re-introduce a per-window notion of "too fast".
 */
export const CONFIRMED_DEATH_REFUSAL_STREAK = 3;

/**
 * The fixed window a restart-intent tombstone holds its host in
 * `restarting-expected` (connection registry §3, mechanism 7).
 *
 * The registry says to reuse the existing 60 s quiet / 15 min max host
 * budgets. The QUIET budget is the one that fits a tombstone episode:
 * duplicate observations never extend an episode (mechanism 7), so the
 * episode has no progress signal to keep extending against, and 60 s covers
 * the restart/apply cycle the exemption exists for (the download half of an
 * update happens with the host still up). When it lapses, ordinary evidence
 * resumes and a host that never came back reaches `dead` normally.
 */
export const RESTART_INTENT_EPISODE_MS = 60_000;

/**
 * The ceiling on the LOCAL expected-outage hold (D5's HostController mutation
 * lane, {@link LocalHostOutageSignal}).
 *
 * This arm does have a progress signal - the lane is in flight or it is not -
 * so it takes the MAX budget rather than the quiet one, and the cap exists
 * only so a lane that never reports completion cannot hold a lease forever.
 */
export const LOCAL_EXPECTED_OUTAGE_CEILING_MS = 15 * 60_000;

/**
 * How many recent dial attempt ids one incarnation remembers for dedup.
 *
 * The set exists ONLY to collapse duplicate deliveries of the SAME attempt
 * (an IPC redelivery, a reporter retry); nothing legitimately re-delivers an
 * attempt from hundreds of dials ago. Forgetting an ancient id is bounded in
 * harm by construction - the worst case is counting one duplicate twice,
 * which can only inflate a streak that any success clears - whereas an
 * unbounded set in a process that lives for weeks is not bounded in anything.
 */
export const ATTEMPT_DEDUP_WINDOW = 256;

/**
 * How many lost-before-established session ids one incarnation tombstones.
 * A tombstone only has to outlive the reordered `established` racing it,
 * which is a same-second window.
 */
export const SESSION_TOMBSTONE_WINDOW = 256;

/**
 * How many session observation ordinals one incarnation keeps PER HOST. Only
 * the ordering of recent sessions can matter to compat freshness: a verdict
 * anchored to a session this incarnation no longer tracks is stale by
 * definition (see `rankForCompatAnchor`).
 */
export const SESSION_ORDINAL_WINDOW = 64;

/**
 * How long a reporter's CURRENT attachment is held once a newer generation
 * has been ISSUED but not yet CLAIMED (the handover of module header rule 4).
 *
 * Allocation deliberately does not retire the current attachment: the new
 * instance's claim does, atomically with installing its own inventory, which
 * is what keeps a reload from opening an empty-session window that concurrent
 * refusals could count against. But a claim is not guaranteed to arrive. A
 * renderer whose bootstrap fails AFTER its preload allocated (a script error,
 * a bundle that never loads) stays alive, so neither `render-process-gone`
 * nor window destruction ever reports it as detached - and the retired
 * document's session inventory would keep suppressing the death counter for
 * its host indefinitely (invariant 5): a host nobody can reach held `ready`
 * in every window by a page that no longer exists. This is the authority's
 * own bound on that handover (mechanism 7): an issuance left unclaimed this
 * long retires the held attachment exactly as a detach would.
 *
 * Generous by an order of magnitude - preload allocation to the kernel's
 * attach is one bootstrap, seconds at the outside - and benign when it does
 * fire early: the late claim still installs its own inventory the moment it
 * lands, and death still needs the full refusal streak in between.
 */
export const ATTACH_HANDOVER_CEILING_MS = 30_000;

/**
 * An insertion-ordered id set with a hard cap, evicting the oldest entry when
 * it overflows. JS `Set` iterates in insertion order, which is the only
 * property this needs - dedup is a one-shot test per id, so there is nothing
 * to refresh on a hit and no LRU bookkeeping to pay for.
 */
class BoundedIdSet {
  private readonly ids = new Set<string>();
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    this.ids.add(id);
    if (this.ids.size <= this.capacity) return;
    for (const oldest of this.ids) {
      this.ids.delete(oldest);
      break;
    }
  }
}

/**
 * How long the TARGET must have been continuously usable before the engine
 * returns to it (connection registry §4's "~15-30 s of confirmed stability").
 *
 * Measured as a DURATION THE HOST HAS ALREADY SERVED, not as a delay counted
 * from the moment the move becomes attractive. That distinction is the whole
 * damping design: a fallback that has been healthy for ten minutes satisfies
 * every window instantly, so the engine never sits on a dead host waiting out
 * a timer, while a host that flaps back up for a second satisfies none.
 */
export const RETURN_TO_TARGET_STABILITY_MS = 20_000;

/**
 * The minimal window on a candidate switch made WHILE already failed over
 * (M6). Short by design - it is not protecting a working arrangement, only
 * bounding a hop cascade: when a network drop makes several remotes report
 * death within the same second, this keeps the engine from walking A -> B ->
 * C -> ∅, emitting a toast and re-pointing every tab at each step, instead of
 * making one move once the dust settles.
 *
 * It costs nothing in the common case, because a warm fallback has already
 * been usable for far longer than this.
 */
export const FAILOVER_CANDIDATE_STABILITY_MS = 5_000;

/**
 * How long a FAILED local `ensure` holds the local lease `dead` before the
 * engine may ask again.
 *
 * It is doing two jobs, and they are the same job: it is the retry cooldown
 * that stops a provisioning failure from becoming a request storm, AND it is
 * how "the ensure path has failed" surfaces as lease state (registry §5) so
 * the ∅ modal can honestly say nothing is available. When it lapses the lease
 * returns to ordinary evidence and the next derivation may try again.
 */
export const LOCAL_ENSURE_RETRY_COOLDOWN_MS = 30_000;

/**
 * Ceiling on ONE in-flight local `ensureReady()` before the engine stops
 * treating it as a reason to keep the local lease usable (B2).
 *
 * `nextDeadline()` had an arm for the cooldown after a FAILED ensure and none
 * for an ensure still running, while the in-flight arm of `deriveLease`
 * reports `connecting` - which is usable. So a `convergeReady()` that never
 * settled held the local lease selectable with no bound at all and made ∅
 * unreachable, which is invariant 6's exact prohibition. Measured: still
 * usable after 30 minutes of clock.
 *
 * Deliberately the same span as {@link LOCAL_EXPECTED_OUTAGE_CEILING_MS}, and
 * not shorter. The two describe the SAME physical event - the local mutation
 * lane is busy, because this engine's own ensure is what busies it - so a
 * second, tighter number here would contradict the ceiling already chosen for
 * that state. It would also fight a documented trade: the in-flight arm is
 * ranked ahead of the outage arm precisely so a user whose host is being
 * started FOR them is never shown ∅, and a short ceiling would put ∅ in
 * front of exactly those users mid-install. The bound exists to make ∅
 * REACHABLE, not to make it prompt.
 */
export const LOCAL_ENSURE_IN_FLIGHT_CEILING_MS =
  LOCAL_EXPECTED_OUTAGE_CEILING_MS;

/**
 * How long the host the app is ACTUALLY POINTED AT may sit with no session
 * and no new evidence before the authority calls it dead on its own (B1/C6).
 *
 * B1's corpse path: a host stops answering, its session drops, and then
 * nothing dials it again - because nothing is trying to reach a host the app
 * already believes it is connected to. `refusalStreak` needs a producer, and
 * on that path there is none, so the death predicate never fires and the
 * lease falls through to `connecting`, which is usable. Measured: no failover
 * after 30 minutes.
 *
 * This is the authority-owned exit C6 requires, and it is deliberately NOT a
 * narrowing of the `ingestDial` suppression guard, which C4 established as
 * load-bearing (three suppressed refusals on a HEALTHY host, exactly the
 * death threshold). Nothing here touches that guard.
 *
 * 90s: the measured symptom was 48s of zero updates, an ordinary reconnect is
 * seconds, and a DELIBERATE restart never reaches this arm at all - the
 * expected-outage arm outranks it and holds the lease for its own episode.
 * Long enough that only a genuine corpse reaches it, short enough that the
 * user is not staring at a healthy-looking dead app.
 */
export const EFFECTIVE_HOST_POST_SESSION_CEILING_MS = 90_000;

/**
 * The engine's own clock and timer source (mechanism 7: "authority deadlines
 * come from its own ceilings, never renderer or host clocks"). A composition
 * input, not wire surface - tests inject a fake.
 */
export interface AuthorityClock {
  now(): number;
  /** Returns a canceller; calling it twice is safe. */
  schedule(delayMs: number, run: () => void): () => void;
}

/** Real-time {@link AuthorityClock}. */
export const systemAuthorityClock: AuthorityClock = {
  now: () => Date.now(),
  schedule: (delayMs: number, run: () => void) => {
    const timer = setTimeout(run, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
};

/**
 * Diagnostic sink. The engine never throws for bad input - a report that does
 * not belong to a live incarnation, a stale fleet snapshot, or a listener
 * that throws is logged and dropped.
 */
export interface AuthorityLog {
  debug(message: string, detail: Record<string, unknown>): void;
  warn(message: string, detail: Record<string, unknown>): void;
}

/** No-op {@link AuthorityLog} for tests and shells without a logger. */
export const silentAuthorityLog: AuthorityLog = {
  debug: () => undefined,
  warn: () => undefined,
};

/**
 * Incarnation ids identify a client instance to the engine that minted them;
 * they never cross a trust boundary and are never persisted, so a process
 * -local counter is sufficient and keeps tests deterministic.
 */
export function createIncrementingIncarnationIds(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `incarnation-${counter}`;
  };
}

/**
 * Where `preferredHostId` survives an app restart, IDENTITY-SCOPED (G1).
 *
 * Reads are synchronous because the engine loads the preference inside the
 * identity transaction that establishes the identity - a later async
 * completion would derive once against the wrong preference and correct
 * itself with a visible move. The file is tiny and written only on Activate
 * or a deregister-clear, so the cost is a rare small write, not a hot path.
 *
 * `identityKey: null` (signed out) has no bucket to read or write: there is
 * no account whose choice could be remembered.
 */
export type PreferredHostSaveResult =
  { ok: true } | { ok: false; reason: string };

export interface PreferredHostStore {
  /**
   * A failed READ is genuinely "no preference": derivation degrades to the
   * local host, which is the same safe answer a first run gets, and a read
   * cannot corrupt anything. So this stays total.
   */
  load(identityKey: string | null): string | null;
  /**
   * A DISCRIMINATED result rather than a throw, because the identity
   * transition must complete regardless of disk state - unwinding a
   * half-applied account switch because a file would not write is worse than
   * carrying a stale file. Callers that CAN refuse (Activate) do; the
   * transition proceeds and lets the store own durable honesty.
   */
  save(
    identityKey: string | null,
    hostId: string | null,
  ): PreferredHostSaveResult;
}

export interface SelectionAuthorityEngineOptions {
  readonly fleet: HostFleetSource;
  readonly identity: AuthorityIdentitySource;
  /**
   * The engine's one sanctioned process action (D14). Composed here so P1.3
   * can invoke it without re-plumbing; P1.1 never calls it.
   */
  readonly localHostEnsure: LocalHostEnsurePort;
  readonly localOutage: LocalHostOutageSignal;
  readonly preferredStore: PreferredHostStore;
  readonly clock: AuthorityClock;
  readonly newIncarnationId: () => string;
  readonly log: AuthorityLog;
}

/** One live transport session as the authority holds it. */
interface LiveSessionRecord {
  readonly hostId: string;
  readonly transportKind: SelectionTransportKind;
}

/**
 * One accepted attach. Everything scoped to a client INSTANCE lives here, so
 * retiring an attachment drops the instance's whole evidence footprint in one
 * step (mechanism 3).
 */
interface AttachmentRecord {
  readonly incarnationId: string;
  readonly attachSeq: number;
  readonly sessions: Map<string, LiveSessionRecord>;
  /**
   * `lost` observed before `established` for these ids: the session never
   * counts as live and the later `established` is dropped. BOUNDED - see
   * {@link SESSION_TOMBSTONE_WINDOW}.
   */
  readonly tombstonedSessionIds: BoundedIdSet;
  /**
   * Dial dedup within the incarnation (mechanism 5). BOUNDED - see
   * {@link ATTEMPT_DEDUP_WINDOW}.
   */
  readonly seenAttemptIds: BoundedIdSet;
  /**
   * hostId -> sessionId -> the authority's observation ordinal, scoped to
   * THIS incarnation because that is the scope in which `sessionId` is unique.
   * The ordinals are drawn from one global counter, so ranks remain
   * comparable across incarnations.
   */
  readonly sessionOrdinals: Map<string, Map<string, number>>;
  /**
   * Per host, the highest ordinal evicted from `sessionOrdinals`. A verdict
   * anchored to a forgotten session ranks HERE - never as something new -
   * which is what keeps eviction from turning an ancient verdict into the
   * freshest one.
   */
  readonly evictedOrdinalFloor: Map<string, number>;
}

/**
 * Per-reporter attach generation state. `latestIssuedSeq` IS the supersession
 * fence (module header rule 4): allocation advances it, and only that seq -
 * while unconsumed - can be claimed.
 *
 * The fence survives retirement, identity transitions AND `reporterDetached`.
 * Surviving detach is not decoration: reporter ids are reused in practice
 * (the in-process adapter's constant id; the single-window bridge's
 * `"primary"`), so dropping the fence on detach would let a reload restart
 * the sequence and make a stale in-flight claim acceptable again.
 */
interface ReporterRecord {
  nextSeq: number;
  latestIssuedSeq: number;
  latestSeqConsumed: boolean;
  attachment: AttachmentRecord | null;
  /**
   * Cancels the {@link ATTACH_HANDOVER_CEILING_MS} timer armed by the latest
   * issuance while an attachment was held; `null` when nothing is armed.
   */
  cancelHandoverTimer: (() => void) | null;
}

/** The freshest compat verdict for one host (mechanism 6). */
interface CompatRecord {
  readonly verdict: "compatible" | "incompatible";
  readonly incompatibility: SelectionIncompatibility | null;
  /**
   * The authority's own observation ordinal for `probedOnSessionId`, or
   * `null` when the verdict named no session at all. Version strings are
   * never an ordering key.
   *
   * `null` means UNORDERABLE, not "lowest". It is deliberately not a numeric
   * floor: the relay that supplies the anchor documents `null` as "I have no
   * name to give you", explicitly NOT as a statement about the host, so a
   * sentinel number here would feed a name-only absence into a `<` and
   * silently rank it beneath every anchored verdict. It did exactly that -
   * see {@link SelectionAuthorityEngineImpl.ingestCompat}.
   */
  readonly rank: number | null;
}

/** Per-host aggregated evidence. Pruned when the host leaves the fleet. */
interface HostEvidence {
  refusalStreak: number;
  lastCountedRefusalDetail: "plan-restricted" | null;
  compat: CompatRecord | null;
  /** Authority-local deadline of the current tombstone episode, if any. */
  restartEpisodeEndsAt: number | null;
  /**
   * When this host's last live session ended WHILE IT WAS THE EFFECTIVE HOST,
   * or null (B1/C6). Only armed for the host the app is actually pointed at:
   * an idle host nobody is talking to produces no evidence either, and
   * `connecting` - "no evidence yet", neither usable-by-proof nor dead - is
   * the honest answer there. Calling it dead from silence would manufacture
   * exactly the false-Offline verdict C4 exists to prevent, from a second
   * direction.
   */
  effectiveSessionLostAt: number | null;
}

function emptyHostEvidence(): HostEvidence {
  return {
    refusalStreak: 0,
    lastCountedRefusalDetail: null,
    compat: null,
    restartEpisodeEndsAt: null,
    effectiveSessionLostAt: null,
  };
}

/** One staged event, awaiting delivery in the engine's FIFO drain. */
type QueuedAuthorityEvent =
  | {
      readonly kind: "selection";
      readonly event: SelectionRevisioned<SelectionChange>;
    }
  | {
      readonly kind: "leases";
      readonly event: SelectionRevisioned<readonly HostLeaseSnapshot[]>;
    }
  | { readonly kind: "reattach"; readonly event: SelectionReattachRequired };

/**
 * One in-flight {@link LocalHostEnsurePort} request. Matched by OBJECT
 * IDENTITY, so a completion can never be mistaken for a newer request's.
 */
interface LocalEnsureToken {
  readonly generation: number;
  readonly hostId: string;
  /**
   * The local proof-of-life counter as it stood when this request was minted.
   * A completion whose counter no longer matches ran ACROSS a proof of life,
   * so its failure describes a host that has since answered - see
   * `completeLocalEnsure`.
   */
  readonly proofGeneration: number;
}

/** The selection tuple the engine currently holds. */
interface SelectionState {
  readonly preferredHostId: string | null;
  /**
   * The fleet-wide selection target: preferred, or the local host when preferred
   * is null (M5), or null when neither exists. Canonical wording lives on
   * `SelectionChange.targetHostId` in `selection-authority-contract.ts`.
   *
   * ⚠ NOT the epic-session `targetHostId`, which is a different concept two
   * layers away: the host a single epic session is being established on, paired
   * there with `originalHostId` (`lib/registries/epic-session-registry.ts`,
   * `providers/epic-session-provider.tsx`). Nine declarations share this
   * identifier across the two meanings, and two careful readers reached a wrong
   * shared conclusion from it inside a day - which is why every declaration of
   * this one now says which it is at the point of declaration, rather than
   * relying on the reader knowing the layer they are in.
   */
  readonly targetHostId: string | null;
  readonly effectiveHostId: string | null;
}

const EMPTY_SELECTION: SelectionState = {
  preferredHostId: null,
  targetHostId: null,
  effectiveHostId: null,
};

/**
 * Generation sentinel for "the engine has not adopted an identity yet". Below
 * every real generation, so the first identity - whether it arrives from
 * `current()` or from a callback that raced it - is adopted as a SEED (no
 * wipe, no `reattachRequired`) rather than as a transition.
 */
const UNSET_IDENTITY_GENERATION = -1;

/**
 * The contract's `usable()` predicate (connection registry §4/§5, mechanism
 * 7, D13). Exported for P1.3's candidate enumeration and ∅ detection - it is
 * private to the AUTHORITY, never part of the client/IPC surface, so no
 * window can derive its own verdict from it.
 *
 * A host is usable when its lease is neither `dead` (which includes the
 * `incompatible` arm - C4: an incompatible host may hold a live socket and is
 * still never a candidate) nor `restarting-expected` (a HOLD, not
 * eligibility: the engine keeps pointing at a cycling host but must not newly
 * select one).
 */
export function isUsableForSelection(lease: HostLeaseSnapshot): boolean {
  return lease.status !== "dead" && lease.status !== "restarting-expected";
}

function attemptKey(incarnationId: string, attemptId: string): string {
  return `${incarnationId}#${attemptId}`;
}

function selectionEquals(a: SelectionState, b: SelectionState): boolean {
  return (
    a.preferredHostId === b.preferredHostId &&
    a.targetHostId === b.targetHostId &&
    a.effectiveHostId === b.effectiveHostId
  );
}

function leasesEqual(
  a: readonly HostLeaseSnapshot[],
  b: readonly HostLeaseSnapshot[],
): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (!leaseEquals(a[index], b[index])) return false;
  }
  return true;
}

/**
 * Refines the cause of a DERIVED move. Explicit causes (`activate`,
 * `deregister-clear`, `fleet-shift`) are facts the caller knows and pass
 * through untouched; `failover` is the marker every evidence-driven path
 * passes, and only here - with the new tuple in hand - can it be told apart
 * from its mirror: landing ON the target is a recovery, leaving it is a
 * failover. P1.3 refines nothing about this; it adds the damping that decides
 * WHEN a move is allowed, not what to call it.
 */
function resolveCause(
  requested: SelectionChangeCause,
  selection: SelectionState,
): SelectionChangeCause {
  if (requested !== "failover") return requested;
  if (selection.effectiveHostId === null) return "failover";
  return selection.effectiveHostId === selection.targetHostId
    ? "recovery"
    : "failover";
}

/** The empty fleet an identity transition swaps to when no matching snapshot exists. */
function emptyFleet(identityGeneration: number): HostFleetSnapshot {
  return {
    revision: -1,
    identityGeneration,
    localHostId: null,
    hosts: [],
  };
}

/**
 * The per-app selection authority.
 *
 * Concurrency model: every method is synchronous and runs to completion on
 * one thread (Electron main, or the single window in browser/dev). "One
 * transaction" in the contract therefore means "one method call": state
 * mutates, then {@link SelectionAuthorityEngineImpl.commit} derives and emits.
 * Nothing interleaves between a parse and a guarded call, which is what makes
 * the attach claim race-free without a lock (module header rule 6).
 */
export class SelectionAuthorityEngineImpl implements SelectionAuthorityEngine {
  private readonly options: SelectionAuthorityEngineOptions;

  /**
   * The ONE revision counter (mechanism 1). Incremented per EMITTED event, so
   * no two events ever share a revision and one client high-water mark
   * totally orders all three event kinds. Process-lifetime monotonic: it
   * never resets, including across sign-out/account replacement.
   */
  private revision = 0;

  /**
   * The user's intent (D1), and the ONLY persisted half of the selection.
   * Written by exactly two paths: `activate` (the single UI writer) and the
   * deregister-clear below (the single sanctioned system write).
   */
  private preferredHostId: string | null = null;
  /**
   * Hosts that have BEEN effective, most recent first - the "most-recently
   * -effective usable remote" the derivation's third arm names (registry §4).
   * Runtime state: it describes this process's own observation order, and a
   * persisted copy would let a machine the user has not seen in weeks
   * outrank one they used an hour ago on another device.
   */
  private readonly mruEffectiveHostIds: string[] = [];
  private selection: SelectionState = EMPTY_SELECTION;
  private leases: readonly HostLeaseSnapshot[] = [];

  private fleet: HostFleetSnapshot = emptyFleet(UNSET_IDENTITY_GENERATION);
  private appliedFleetRevision = Number.NEGATIVE_INFINITY;
  /**
   * Whether the fleet port has given a genuine MEMBERSHIP ANSWER for the
   * current identity - the distinction `hosts.length === 0` cannot draw.
   *
   * A PUBLISHED SNAPSHOT IS ALWAYS AN ANSWER, EVEN AN EMPTY ONE; A SEED OR
   * ADOPTED FLEET IS AN ANSWER ONLY IF IT ALREADY NAMES HOSTS. That is the
   * whole semantics, stated here because it lives as three separate
   * assignments and will not survive as three.
   *
   * An empty fleet means two incompatible things: "the registry answered, and
   * this account has no hosts" (how a single-host account deregisters) and
   * "the registry has not answered yet" (the seed, and the window after an
   * identity transition). {@link clearPreferredOutsideFleet} resolves that
   * ambiguity toward UNKNOWN because destroying a preference on a
   * non-answer is unrecoverable; `pruneEvidenceOutsideFleet` resolves it
   * toward EMPTY because an answered `[]` is exactly when a deregistered
   * host's evidence must go. Both are right for their own concern - so the
   * ambiguity has to be resolved with a real signal rather than by picking a
   * side, which is what this flag is.
   *
   * Scoped to the identity, not the process: a new account has answered
   * nothing, so `runIdentityTransition` puts it back.
   */
  private hasFleetAnswer = false;
  private identityKey: string | null = null;
  private identityGeneration = UNSET_IDENTITY_GENERATION;

  private readonly reporters = new Map<string, ReporterRecord>();
  private readonly evidence = new Map<string, HostEvidence>();
  /**
   * The next observation ordinal to hand out. The ordinals themselves live on
   * the ATTACHMENT that observed them (see {@link AttachmentRecord}); this
   * counter is global so ranks stay comparable across incarnations, which is
   * what lets a newer window's verdict supersede an older window's.
   */
  private nextSessionOrdinal = 0;
  /**
   * Every (hostId, tombstoneId) ever observed, retained for the authority
   * PROCESS LIFETIME (decision 9): pruned only on the host's fleet removal or
   * an identity transition. No eviction horizon exists, so no replay can
   * outlive one and re-open a closed episode.
   */
  private readonly seenTombstoneIds = new Map<string, Set<string>>();

  /** Start of the current local expected outage, or null when the lane is idle. */
  private localOutageStartedAt: number | null = null;
  /**
   * Per host, when its lease became CONTINUOUSLY usable, or absent while it is
   * not. This is the "confirmed stability" the damping windows measure
   * against; it is cleared the instant a host stops being usable, so a flap
   * restarts the clock rather than accumulating credit.
   */
  private readonly usableSince = new Map<string, number>();
  /**
   * When a damped move would become admissible with no new evidence, or null
   * when nothing is being held back. Recorded at derivation time (where the
   * candidate is already known) rather than recomputed by the timer, so the
   * two can never disagree about which move is waiting.
   */
  private pendingDampingDeadline: number | null = null;
  /**
   * The in-flight local `ensure`, or null (D14).
   *
   * A TOKEN rather than a boolean, because a boolean cannot say WHOSE ensure is
   * running. It crossed identity generations: account A's in-flight request
   * suppressed B's (the flag was still set, so B's derivation refrained from
   * asking), rendered B's local host `connecting` on the strength of
   * provisioning nobody had asked for on B's behalf, and then A's completion -
   * arriving under a mismatched generation - cleared the flag and returned
   * WITHOUT re-deriving, stranding B with a lease that no longer described
   * anything. Object identity is the match: only the exact request the engine
   * is still waiting on may mutate state or commit.
   */
  private localEnsureToken: LocalEnsureToken | null = null;
  /**
   * When the in-flight ensure stops holding the local lease usable, or null
   * when none is running (B2). Paired with `localEnsureToken` at every site -
   * a deadline outliving its token would expire an ensure nobody is waiting
   * on, and a token outliving its deadline is the unbounded state itself.
   */
  private localEnsureExpiresAt: number | null = null;
  /**
   * End of the cooldown after a FAILED ensure, or null. While it runs the
   * local lease is `dead` - which is exactly what registry §5 means by "the
   * ensure path is unavailable or has failed".
   */
  private localEnsureFailedUntil: number | null = null;
  /**
   * End of the request-pacing hold after a DEFERRED ensure, or null. A
   * deferral (the lifecycle lane or its CLI lock was busy - another launch
   * actor mid-work) learned nothing about the host, so unlike
   * `localEnsureFailedUntil` this holds back the NEXT request only and never
   * deadens the lease: `deriveLease` does not read it. Without the split, a
   * lock lost to the desktop's own launch converge rendered a healthy host
   * `dead: offline` for 30s and put the ∅ modal over a working machine.
   */
  private localEnsureRetryHoldUntil: number | null = null;
  /**
   * Monotonic count of proofs of life for the host that is LOCAL at the time
   * each one lands. Stamped onto every ensure token at mint, and the only
   * thing that lets a completion tell "my failure is the newest word on this
   * host" from "the host answered while I was still running".
   *
   * A counter rather than a timestamp deliberately: the question is ordering
   * against one specific request, not elapsed time, so there is no clock to
   * read and no window to tune.
   */
  private localProofGeneration = 0;
  private cancelDeadlineTimer: (() => void) | null = null;
  private scheduledDeadline: number | null = null;

  private readonly selectionListeners = new Set<
    (event: SelectionRevisioned<SelectionChange>) => void
  >();
  private readonly leaseListeners = new Set<
    (event: SelectionRevisioned<readonly HostLeaseSnapshot[]>) => void
  >();
  private readonly reattachListeners = new Set<
    (event: SelectionReattachRequired) => void
  >();

  private readonly portSubscriptions: SelectionSubscription[] = [];
  /**
   * Staged-but-undelivered events, in revision order. Listeners run consumer
   * code synchronously and may re-enter the engine, so delivery is a separate
   * FIFO drain rather than an inline call - see {@link commit}.
   */
  private readonly eventQueue: QueuedAuthorityEvent[] = [];
  private draining = false;
  private disposed = false;

  constructor(options: SelectionAuthorityEngineOptions) {
    this.options = options;

    // SUBSCRIBE BEFORE READ on both ports (mechanism 8, §3b): the callback
    // carries the new value itself, so a change landing between the
    // subscription and the read cannot be lost - the seed read is then
    // rejected as stale by the monotonic guards below.
    this.portSubscriptions.push(
      options.identity.onChanged((identity) => {
        this.applyIdentity(identity);
      }),
    );
    this.applyIdentity(options.identity.current());
    // AFTER the identity seed: the preference is scoped to whoever is signed
    // in, so it cannot be read before that is known.
    this.preferredHostId = options.preferredStore.load(this.identityKey);

    this.portSubscriptions.push(
      options.fleet.onChanged((snapshot) => {
        this.applyFleetSnapshot(snapshot, "published");
      }),
    );
    // THE SEED READ IS NOT AN ANSWER unless it already names hosts. It is
    // whatever the port happens to be holding at construction, which for a
    // registry that has not answered yet is an empty placeholder
    // indistinguishable from a real "this account has no hosts". A PUBLISHED
    // snapshot is an event and therefore always an answer, empty or not.
    this.applyFleetSnapshot(options.fleet.snapshot(), "seed");

    this.portSubscriptions.push(
      options.localOutage.onChanged((inExpectedOutage) => {
        this.applyLocalOutage(inExpectedOutage);
      }),
    );
    this.applyLocalOutage(options.localOutage.inExpectedOutage());
  }

  // ---------------------------------------------------------------- attach

  allocateAttachSeq(reporterId: string): number {
    const record = this.reporterRecord(reporterId);
    record.nextSeq += 1;
    record.latestIssuedSeq = record.nextSeq;
    // ALLOCATION ADVANCES THE FENCE (module header rule 4): every older
    // generation's attach is superseded from this moment, whether or not the
    // new instance ever attaches. The CURRENT attachment is deliberately NOT
    // retired here - it keeps reporting until the new claim lands, which is
    // what makes the handover free of an empty-session window - but the wait
    // for that claim is BOUNDED (ATTACH_HANDOVER_CEILING_MS), because a
    // renderer that never reaches attach is not a detach anyone reports.
    record.latestSeqConsumed = false;
    this.armHandoverCeiling(reporterId, record);
    return record.latestIssuedSeq;
  }

  attach(
    reporterId: string,
    request: SelectionAttachRequest,
  ): SelectionAttachResult {
    const record = this.reporters.get(reporterId) ?? null;
    if (record === null || !this.claimSeq(record, request.attachSeq)) {
      return { ok: false, kind: "superseded" };
    }
    // The claim is consumed; the previous attachment is retired inside the
    // same synchronous call, and (on success) replaced before anything is
    // emitted - so no observer ever sees the reporter session-less.
    this.retireAttachment(record);
    if (
      request.callerContractVersion !== SELECTION_AUTHORITY_CONTRACT_VERSION
    ) {
      // Terminal for that renderer load: retired, seq consumed, no replay.
      this.commit("failover");
      return {
        ok: false,
        kind: "version-mismatch",
        authorityVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
        callerVersion: request.callerContractVersion,
      };
    }
    const incarnationId = this.options.newIncarnationId();
    const attachment: AttachmentRecord = {
      incarnationId,
      attachSeq: request.attachSeq,
      sessions: new Map<string, LiveSessionRecord>(),
      tombstonedSessionIds: new BoundedIdSet(SESSION_TOMBSTONE_WINDOW),
      seenAttemptIds: new BoundedIdSet(ATTEMPT_DEDUP_WINDOW),
      sessionOrdinals: new Map<string, Map<string, number>>(),
      evictedOrdinalFloor: new Map<string, number>(),
    };
    record.attachment = attachment;
    this.installInventory(attachment, request.liveSessions);
    // SEAL BEFORE DELIVERY. The result is captured between staging and
    // draining, so a listener that re-enters (an identity transition driven
    // from a lease callback, say) mints its `reattachRequired` at a revision
    // ABOVE this snapshot - which is what lets the client keep the trigger
    // instead of discarding it as already covered.
    this.stage("failover");
    const result: SelectionAttachResult = {
      ok: true,
      incarnationId,
      snapshot: this.snapshot(),
    };
    this.drain();
    return result;
  }

  refuseMalformedAttach(reporterId: string, attachSeq: number): boolean {
    const record = this.reporters.get(reporterId) ?? null;
    if (record === null || !this.claimSeq(record, attachSeq)) {
      return false;
    }
    record.attachment = null;
    this.commit("failover");
    return true;
  }

  reporterDetached(reporterId: string): void {
    const record = this.reporters.get(reporterId) ?? null;
    if (record === null) return;
    // A hard detach ends any handover in flight: there is no attachment left
    // for the ceiling to retire.
    this.clearHandoverTimer(record);
    if (record.attachment === null) return;
    this.retireAttachment(record);
    this.commit("failover");
  }

  // -------------------------------------------------------------- evidence

  ingestEvidence(
    reporterId: string,
    incarnationId: string,
    report: SelectionEvidenceReport,
  ): void {
    const attachment = this.reporters.get(reporterId)?.attachment ?? null;
    if (attachment === null || attachment.incarnationId !== incarnationId) {
      // A stale renderer generation (reload, HMR) or a report that raced a
      // retirement. Dropped, never an error (mechanism 3).
      this.options.log.debug("[selection-authority] stale evidence dropped", {
        reporterId,
        incarnationId,
        kind: report.kind,
      });
      return;
    }
    switch (report.kind) {
      case "dial":
        this.ingestDial(attachment, report);
        break;
      case "session":
        this.ingestSession(attachment, report);
        break;
      case "compat":
        this.ingestCompat(attachment, report);
        break;
      case "restart-intent":
        this.ingestRestartIntent(report);
        break;
    }
    this.commit("failover");
  }

  activate(
    reporterId: string,
    incarnationId: string,
    hostId: string,
  ): Promise<ActivateResult> {
    const attachment = this.reporters.get(reporterId)?.attachment ?? null;
    if (attachment === null || attachment.incarnationId !== incarnationId) {
      return Promise.resolve({ ok: false, reason: "not-attached" });
    }
    // F14: the write is DIRECTORY-VALIDATED. Refusing an id the fleet does not
    // hold is what stops any path - a stale picker row, a replayed gesture -
    // from re-asserting a host that was deregistered.
    if (!this.fleet.hosts.some((entry) => entry.hostId === hostId)) {
      return Promise.resolve({ ok: false, reason: "unknown-host" });
    }
    // D13/C4: an incompatible host is never selectable. Settings offers
    // Update instead. A host that becomes incompatible AFTER being preferred
    // keeps the preference and fails over until it is updated - that is a
    // derivation outcome, not a refusal, and it is why this checks the
    // CURRENT verdict rather than remembering one.
    const lease = this.leases.find((entry) => entry.hostId === hostId) ?? null;
    if (
      lease !== null &&
      lease.status === "dead" &&
      lease.dead.reason === "incompatible"
    ) {
      return Promise.resolve({ ok: false, reason: "incompatible" });
    }
    // Deliberately NOT refused: a registered host that is merely offline.
    // Preferred is intent, not liveness (D1/D5).
    if (this.preferredHostId !== hostId) {
      // PERSIST FIRST, and only then touch state or emit. The contract
      // promises `ok: true` only after validate, persist AND re-derivation -
      // so a durable write that failed must not have moved the app: reporting
      // success there tells the user their choice is remembered, and the next
      // launch quietly contradicts it. Ordering makes a partial commit
      // impossible rather than merely unlikely.
      const persisted = this.options.preferredStore.save(
        this.identityKey,
        hostId,
      );
      if (!persisted.ok) {
        this.options.log.warn("[selection-authority] preference write failed", {
          hostId,
          reason: persisted.reason,
        });
        return Promise.resolve({ ok: false, reason: "persist-failed" });
      }
      this.preferredHostId = hostId;
      this.commit("activate");
    }
    return Promise.resolve({ ok: true });
  }

  // ----------------------------------------------------------- subscription

  onSelectionChanged(
    listener: (event: SelectionRevisioned<SelectionChange>) => void,
  ): SelectionSubscription {
    this.selectionListeners.add(listener);
    return {
      dispose: () => {
        this.selectionListeners.delete(listener);
      },
    };
  }

  onLeasesChanged(
    listener: (
      event: SelectionRevisioned<readonly HostLeaseSnapshot[]>,
    ) => void,
  ): SelectionSubscription {
    this.leaseListeners.add(listener);
    return {
      dispose: () => {
        this.leaseListeners.delete(listener);
      },
    };
  }

  onReattachRequired(
    listener: (event: SelectionReattachRequired) => void,
  ): SelectionSubscription {
    this.reattachListeners.add(listener);
    return {
      dispose: () => {
        this.reattachListeners.delete(listener);
      },
    };
  }

  /**
   * Releases the port subscriptions and any armed deadline. Not part of the
   * contract's engine interface - it is the composition root's obligation
   * (the desktop bridge's `disposeFns`, the adapter's teardown).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.portSubscriptions) {
      subscription.dispose();
    }
    this.portSubscriptions.length = 0;
    this.clearDeadlineTimer();
    for (const record of this.reporters.values()) {
      this.clearHandoverTimer(record);
    }
    this.selectionListeners.clear();
    this.leaseListeners.clear();
    this.reattachListeners.clear();
  }

  /**
   * The full state at the current revision. Captured AFTER a transaction's
   * emissions, so `revision` is the maximum committed event revision and a
   * client that installs it can discard every buffered event at or below it.
   */
  snapshot(): SelectionAuthoritySnapshot {
    return {
      contractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
      revision: this.revision,
      preferredHostId: this.selection.preferredHostId,
      targetHostId: this.selection.targetHostId,
      effectiveHostId: this.selection.effectiveHostId,
      leases: this.leases,
    };
  }

  // ------------------------------------------------------------- internals

  private reporterRecord(reporterId: string): ReporterRecord {
    const existing = this.reporters.get(reporterId);
    if (existing !== undefined) return existing;
    const created: ReporterRecord = {
      nextSeq: 0,
      latestIssuedSeq: 0,
      latestSeqConsumed: true,
      attachment: null,
      cancelHandoverTimer: null,
    };
    this.reporters.set(reporterId, created);
    return created;
  }

  /**
   * Arms {@link ATTACH_HANDOVER_CEILING_MS} for the generation just issued.
   * Re-armed on every issuance (the NEWEST generation is the one whose claim
   * the held attachment waits for), cleared by the claim itself
   * ({@link claimSeq}), by {@link reporterDetached} and by {@link dispose}.
   * Nothing to bound when the reporter holds no attachment.
   */
  private armHandoverCeiling(reporterId: string, record: ReporterRecord): void {
    this.clearHandoverTimer(record);
    if (record.attachment === null) return;
    record.cancelHandoverTimer = this.options.clock.schedule(
      ATTACH_HANDOVER_CEILING_MS,
      () => {
        record.cancelHandoverTimer = null;
        // Every path that consumes or ends the generation clears this timer
        // synchronously, so firing means the issuance is STILL unclaimed; the
        // attachment check covers an identity transition that already
        // retired it in between.
        if (this.disposed || record.attachment === null) return;
        this.options.log.warn(
          "[selection-authority] attach handover expired; retiring the held attachment",
          { reporterId, attachSeq: record.latestIssuedSeq },
        );
        this.retireAttachment(record);
        this.commit("failover");
      },
    );
  }

  private clearHandoverTimer(record: ReporterRecord): void {
    if (record.cancelHandoverTimer === null) return;
    record.cancelHandoverTimer();
    record.cancelHandoverTimer = null;
  }

  /**
   * The guard both attach paths share (module header rule 6). A non-latest or
   * already-consumed seq is STATE-NEUTRAL - it never touches the live
   * attachment. The latest unconsumed seq is consumed HERE, so whichever
   * guarded call it reached terminates that generation: the same seq can
   * never be replayed with a corrected envelope.
   */
  private claimSeq(record: ReporterRecord, attachSeq: number): boolean {
    if (attachSeq !== record.latestIssuedSeq) return false;
    if (record.latestSeqConsumed) return false;
    record.latestSeqConsumed = true;
    // The claim the handover was waiting for has landed (accepted, version-
    // mismatched or malformed - each retires the held attachment itself).
    this.clearHandoverTimer(record);
    return true;
  }

  private installInventory(
    attachment: AttachmentRecord,
    liveSessions: readonly LiveSessionAnnouncement[],
  ): void {
    for (const announcement of liveSessions) {
      attachment.sessions.set(announcement.sessionId, {
        hostId: announcement.hostId,
        transportKind: announcement.transportKind,
      });
      this.observeSession(
        attachment,
        announcement.hostId,
        announcement.sessionId,
      );
      this.onHostProvedAlive(announcement.hostId);
    }
  }

  /**
   * Assigns a host's session its observation ordinal the first time the
   * REPORTING INCARNATION names it - from an attach inventory, a session
   * transition, or a compat verdict naming it. This ordering, not any version
   * string, is what makes compat freshness survive downgrades and
   * same-version restarts (mechanism 6).
   *
   * Scoped to the attachment because `sessionId` is only unique WITHIN an
   * incarnation (contract, {@link SelectionSessionEvidence}). Keyed globally,
   * two windows that both call their connection `"s1"` shared one ordinal, so
   * a delayed incompatibility probed on window A's long-dead `s1` tied window
   * B's verdict on its own live `s1` and - latest-received wins on a tie -
   * flipped B's lease to dead. Nesting the map also removes the last place a
   * delimiter inside an id could forge a collision.
   */
  private observeSession(
    attachment: AttachmentRecord,
    hostId: string,
    sessionId: string,
  ): number {
    const perHost =
      attachment.sessionOrdinals.get(hostId) ?? new Map<string, number>();
    attachment.sessionOrdinals.set(hostId, perHost);
    const existing = perHost.get(sessionId);
    if (existing !== undefined) return existing;
    const ordinal = this.nextSessionOrdinal;
    this.nextSessionOrdinal += 1;
    perHost.set(sessionId, ordinal);
    if (perHost.size > SESSION_ORDINAL_WINDOW) {
      for (const [oldestSessionId, oldestOrdinal] of perHost) {
        perHost.delete(oldestSessionId);
        attachment.evictedOrdinalFloor.set(hostId, oldestOrdinal);
        break;
      }
    }
    return ordinal;
  }

  /**
   * The rank a compat verdict's anchor earns.
   *
   * A KNOWN session keeps its ordinal. An unknown one is only minted as
   * current when the reporter still holds that session live - otherwise it is
   * a verdict for a session this incarnation no longer tracks, and it ranks at
   * the evicted floor. Minting it as newest (the pre-bound behaviour) would
   * let eviction promote an ancient verdict over a live one, which is exactly
   * the flip the incarnation scoping was introduced to stop.
   */
  private rankForCompatAnchor(
    attachment: AttachmentRecord,
    hostId: string,
    sessionId: string,
  ): number {
    const known = attachment.sessionOrdinals.get(hostId)?.get(sessionId);
    if (known !== undefined) return known;
    if (attachment.sessions.get(sessionId)?.hostId === hostId) {
      return this.observeSession(attachment, hostId, sessionId);
    }
    return attachment.evictedOrdinalFloor.get(hostId) ?? -1;
  }

  private hostEvidence(hostId: string): HostEvidence {
    const existing = this.evidence.get(hostId);
    if (existing !== undefined) return existing;
    const created = emptyHostEvidence();
    this.evidence.set(hostId, created);
    return created;
  }

  /** Whether ANY window currently holds a live session for the host. */
  private hasLiveSession(hostId: string): boolean {
    for (const record of this.reporters.values()) {
      const attachment = record.attachment;
      if (attachment === null) continue;
      for (const session of attachment.sessions.values()) {
        if (session.hostId === hostId) return true;
      }
    }
    return false;
  }

  /**
   * Arms B1's corpse ceiling when the host the app is POINTED AT just lost its
   * last session (C6).
   *
   * Two conditions, both load-bearing, and both about not manufacturing a
   * death from silence:
   *
   * - **Effective only.** An idle host nobody is talking to also produces no
   *   evidence, and `connecting` - "no evidence yet" - is the honest answer
   *   there. B1's harm is specifically *"the app looks healthy while pointed
   *   at a machine that is not answering"*, which only the effective host can
   *   do. Arming everywhere would invent the false-Offline verdict C4 exists
   *   to prevent, from a second direction.
   * - **No session left anywhere.** Sessions are per-attachment; another
   *   window may still hold one, and that is firsthand proof of life
   *   (invariant 5) which outranks this entirely.
   *
   * Never extended once armed: the ceiling measures time since the app last
   * had a session with this host, and re-arming on a second loss would let a
   * host that flaps between brief sessions outrun it for ever.
   */
  private armPostSessionCeilingIfPointedAt(hostId: string): void {
    if (this.selection.effectiveHostId !== hostId) return;
    if (this.hasLiveSession(hostId)) return;
    const evidence = this.hostEvidence(hostId);
    if (evidence.effectiveSessionLostAt !== null) return;
    evidence.effectiveSessionLostAt = this.options.clock.now();
  }

  /**
   * Retires a reporter's attachment and arms the corpse ceiling for every host
   * whose sessions it was holding - the same arming `ingestSession`'s `lost`
   * transition performs, for the paths that drop sessions WITHOUT one.
   *
   * There are four: a hard detach (`render-process-gone`, no `sessionLost`
   * ever sent), an attach rotation, the handover ceiling, and the identity
   * transition. Before this, only the `lost` transition armed the ceiling, so
   * two windows both holding sessions to the effective remote H, one
   * reporting `lost` (suppressed - the other still had one) and the other
   * hard-destroyed, left `hasLiveSession(H)` false, `effectiveSessionLostAt`
   * null, and the lease at `connecting` - usable - with no authority-owned
   * exit until the redial lane happened to accumulate refusals.
   *
   * Arming after the attachment is nulled, so `hasLiveSession` reflects the
   * loss. Safe for the rotation path too: the re-attach re-announces the
   * inventory and a session appearing is proof of life, which clears the
   * ceiling at once (see `onHostProvedAlive`); only a genuine loss lets it run.
   */
  private retireAttachment(record: ReporterRecord): void {
    const attachment = record.attachment;
    if (attachment === null) return;
    const hostIds = new Set<string>();
    for (const session of attachment.sessions.values()) {
      hostIds.add(session.hostId);
    }
    record.attachment = null;
    for (const hostId of hostIds) {
      this.armPostSessionCeilingIfPointedAt(hostId);
    }
  }

  /**
   * Firsthand proof of life (a dial success, or a session appearing) clears
   * the host's death streak and closes any restart episode: the outage the
   * episode was holding for is over.
   *
   * For the LOCAL host it also drops the failed-ensure cooldown, which is the
   * one piece of death evidence that had no proof-of-life clear and so
   * outlived the thing it described: a host that answers a dial is not a host
   * whose ensure path is unavailable, and registry §5 is what the cooldown
   * claims. Ingestion calls this BEFORE it commits, so the same transaction
   * that records the proof re-derives with the cooldown already gone.
   *
   * GUARDED TO LOCAL, both directions. The cooldown describes the local ensure
   * path specifically, so a REMOTE host proving alive says nothing about it -
   * and the comparison covers a null `localHostId` for free, because no real
   * host id equals it. Every one of the four proof kinds is honoured
   * uniformly: an announcement or a session is strictly stronger evidence than
   * the dial this was first written for, and a fleet whose local host is the
   * one announcing is exactly the case the clear exists to serve.
   */
  private onHostProvedAlive(hostId: string): void {
    const evidence = this.hostEvidence(hostId);
    evidence.refusalStreak = 0;
    evidence.lastCountedRefusalDetail = null;
    evidence.restartEpisodeEndsAt = null;
    // Proof of life is proof of life: it retires the corpse deadline for the
    // same reason it clears the streak. This is the ONLY producer that needs
    // to know about the deadline, because every kind of proof already funnels
    // through here - a dial success, a session appearing, an announcement,
    // and a successful ensure.
    evidence.effectiveSessionLostAt = null;
    if (hostId !== this.fleet.localHostId) return;
    // Bumped BEFORE the clear so an ensure still in flight can tell that its
    // own failure - whenever it lands - post-dates this moment.
    this.localProofGeneration += 1;
    this.localEnsureFailedUntil = null;
    // The pacing hold goes with it: a host that just proved alive has no
    // pending need the hold was protecting, and if it dies again the next
    // request should not inherit a wait armed against a lock long released.
    this.localEnsureRetryHoldUntil = null;
  }

  private ingestDial(
    attachment: AttachmentRecord,
    report: Extract<SelectionEvidenceReport, { kind: "dial" }>,
  ): void {
    const hostId = report.hostId;
    if (this.dropsAsOutsideFleet(hostId, report.kind)) return;
    const key = attemptKey(attachment.incarnationId, report.attemptId);
    if (attachment.seenAttemptIds.has(key)) return;
    attachment.seenAttemptIds.add(key);
    if (report.outcome === "success") {
      this.onHostProvedAlive(hostId);
      return;
    }
    // `indeterminate` is inert by contract: a liveness-read failure or an
    // attempt abandoned for unrelated reasons is not evidence about the host.
    if (report.outcome === "indeterminate") return;
    if (this.hasLiveSession(hostId)) {
      // Recorded for diagnostics, never accumulated: a live session anywhere
      // in the app outranks every other evidence class (invariant 5). The
      // streak resumes only once the session set for this host empties.
      this.options.log.debug(
        "[selection-authority] dial failure suppressed by live session",
        { hostId, outcome: report.outcome },
      );
      return;
    }
    const evidence = this.hostEvidence(hostId);
    evidence.refusalStreak += 1;
    evidence.lastCountedRefusalDetail =
      report.outcome === "confirmed-refusal" ? report.refusalDetail : null;
  }

  private ingestSession(
    attachment: AttachmentRecord,
    report: Extract<SelectionEvidenceReport, { kind: "session" }>,
  ): void {
    if (report.transition === "lost") {
      if (attachment.sessions.delete(report.sessionId)) {
        this.armPostSessionCeilingIfPointedAt(report.hostId);
        return;
      }
      // `lost` before `established` (reordered delivery): tombstone the id so
      // the late `established` cannot resurrect a session that is already
      // gone. Both are dropped; the session never counts as live.
      attachment.tombstonedSessionIds.add(report.sessionId);
      return;
    }
    if (attachment.tombstonedSessionIds.has(report.sessionId)) return;
    if (attachment.sessions.has(report.sessionId)) return;
    attachment.sessions.set(report.sessionId, {
      hostId: report.hostId,
      transportKind: report.transportKind,
    });
    this.observeSession(attachment, report.hostId, report.sessionId);
    this.onHostProvedAlive(report.hostId);
  }

  private ingestCompat(
    attachment: AttachmentRecord,
    report: Extract<SelectionEvidenceReport, { kind: "compat" }>,
  ): void {
    if (this.dropsAsOutsideFleet(report.hostId, report.kind)) return;
    const rank =
      report.probedOnSessionId === null
        ? null
        : this.rankForCompatAnchor(
            attachment,
            report.hostId,
            report.probedOnSessionId,
          );
    const evidence = this.hostEvidence(report.hostId);
    const current = evidence.compat;
    // A verdict probed on a session the authority observed later supersedes
    // every earlier one; equal rank means the same session, where
    // latest-received wins.
    //
    // ORDER ONLY WHEN BOTH SIDES NAME A SESSION. An unanchored verdict is
    // UNORDERABLE against an anchored one, not beneath it, and the difference
    // is a D13 hole: a `null` anchor means the relay had no NAME to give -
    // its own contract says so in capitals - and never that the host is
    // healthier or staler. Ranking absence at a numeric floor tested that
    // value anyway, and a rejected handshake is exactly where it bit. Such a
    // handshake fails BEFORE the transport ready boundary, so it can never
    // announce the session it would need to out-rank anything; its
    // `incompatible` verdict therefore arrived unanchored and was dropped
    // behind a held `compatible` from the session that just died. The host
    // kept a `compatible` lease against a fresh incompatible answer, and
    // because the same rejection recurs identically on every retry, nothing
    // in the compat path could ever dislodge it.
    //
    // WHAT REPLACES THE ORDERING WHEN IT CANNOT RUN, as one rule rather than
    // a truth table: AN UNANCHORED VERDICT MAY NEVER RELAX A GATE, AND MAY
    // NEVER OUTRANK REAL EVIDENCE. Anchored evidence names a real session
    // generation, so it always supersedes an unanchored verdict; an
    // unanchored verdict is admissible only when it is MORE restrictive than
    // what it meets.
    //
    // Both halves are load-bearing and each has its own failure if dropped:
    //
    //  - Drop "never relax a gate" and a null-anchored COMPATIBLE clears a
    //    session-anchored INCOMPATIBLE - relaxing a compatibility gate on a
    //    verdict that names no session, the one move D13 must never make.
    //  - Drop "never outrank real evidence" and the mirror strands hosts
    //    permanently. An outdated host rejected at cold boot stores
    //    `incompatible` UNANCHORED as its first verdict; the user then
    //    updates it, it reconnects, and its `compatible` verdict IS anchored
    //    - so a rule that merely said "the restrictive verdict wins" would
    //    refuse it, every time, forever. `evidence.compat` is written in
    //    exactly one place and reset nowhere, so nothing else could clear it:
    //    escape would be fleet pruning or an app restart.
    //
    // The second failure is why the arm below tests `rank === null` (the
    // INCOMING side) rather than "exactly one side is null". Pinned by T5d,
    // and the D13 fix above widens its precondition rather than narrowing it,
    // since that fix deliberately stores unanchored incompatible verdicts.
    if (
      current !== null &&
      rank !== null &&
      current.rank !== null &&
      rank < current.rank
    ) {
      return;
    }
    if (
      current !== null &&
      rank === null &&
      current.rank !== null &&
      report.verdict === "compatible" &&
      current.verdict === "incompatible"
    ) {
      return;
    }
    evidence.compat = {
      verdict: report.verdict,
      incompatibility: report.incompatibility,
      rank,
    };
  }

  private ingestRestartIntent(
    report: Extract<SelectionEvidenceReport, { kind: "restart-intent" }>,
  ): void {
    if (this.dropsAsOutsideFleet(report.hostId, report.kind)) return;
    // FIRST receipt anchors ONE fixed episode; every duplicate - another
    // window observing the same tombstone, a liveness-plane replay - is
    // ignored outright and can never extend it (mechanism 7).
    const seen = this.seenTombstoneIds.get(report.hostId) ?? new Set<string>();
    if (seen.has(report.tombstoneId)) return;
    seen.add(report.tombstoneId);
    this.seenTombstoneIds.set(report.hostId, seen);
    const evidence = this.hostEvidence(report.hostId);
    // `expiresAt` on the report is the HOST's clock and is display-only; the
    // deadline is the authority's own ceiling.
    evidence.restartEpisodeEndsAt =
      this.options.clock.now() + RESTART_INTENT_EPISODE_MS;
  }

  // ------------------------------------------------------------------ ports

  private applyFleetSnapshot(
    snapshot: HostFleetSnapshot,
    /**
     * REQUIRED, AND DELIBERATELY NOT DEFAULTED. The constructor seeds THROUGH
     * this method - `appliedFleetRevision` starts at `NEGATIVE_INFINITY`, so a
     * revision-0 seed really is applied - which means a `hasFleetAnswer` set
     * unconditionally here would mark the port's empty PLACEHOLDER as a
     * membership answer and start dropping evidence during the one window that
     * must accept it. Making every caller say which it is stops the next one
     * from inheriting a meaning it never chose.
     */
    source: "seed" | "published",
  ): void {
    if (snapshot.identityGeneration !== this.identityGeneration) {
      // Revision orders observations; the generation establishes MEMBERSHIP.
      // A late account-A fetch completing after account B became current is
      // rejected here no matter how high its revision is (§3b).
      this.options.log.debug(
        "[selection-authority] stale-identity fleet drop",
        {
          snapshotGeneration: snapshot.identityGeneration,
          currentGeneration: this.identityGeneration,
        },
      );
      return;
    }
    if (snapshot.revision <= this.appliedFleetRevision) return;
    this.appliedFleetRevision = snapshot.revision;
    this.fleet = snapshot;
    if (source === "published" || snapshot.hosts.length > 0) {
      this.hasFleetAnswer = true;
    }
    this.pruneEvidenceOutsideFleet();
    this.commit(
      this.clearPreferredOutsideFleet() ? "deregister-clear" : "fleet-shift",
    );
  }

  /**
   * The single sanctioned SYSTEM write to preferred (invariant 1), and F14's
   * load-time degradation - one rule, because they are the same fact observed
   * at different times: the preferred host is no longer in the account's
   * fleet. Deregistering it while the app runs and finding it already gone at
   * startup both land here, and both clear to null so nothing can re-assert a
   * stale id.
   *
   * An EMPTY fleet never triggers it. "No hosts" is what this port publishes
   * before its first genuine registry answer and while an identity transition
   * is in flight, and a preference must not be destroyed by the absence of an
   * answer - the same distinction the directory drew between "the registry
   * omitted the host" and "the registry was never reached". Holding a stale
   * preference costs nothing meanwhile: with no lease it is not usable, so
   * derivation ignores it, and the next non-empty snapshot settles it.
   */
  private clearPreferredOutsideFleet(): boolean {
    const preferredHostId = this.preferredHostId;
    if (preferredHostId === null) return false;
    if (this.fleet.hosts.length === 0) return false;
    if (this.fleet.hosts.some((entry) => entry.hostId === preferredHostId)) {
      return false;
    }
    this.preferredHostId = null;
    this.options.preferredStore.save(this.identityKey, null);
    return true;
  }

  /**
   * Compat verdicts and tombstone ids are cleared on fleet removal.
   *
   * NO EMPTY-FLEET GUARD, DELIBERATELY - the asymmetry with
   * {@link clearPreferredOutsideFleet} four lines below is the considered
   * answer rather than an oversight, and it has been filed as a defect once
   * already. Both react to "a host is not in the fleet" and they resolve that
   * phrase's ambiguity toward OPPOSITE readings, each correct for its own
   * concern: destroying a preference on a non-answer is unrecoverable, so that
   * one reads empty as UNKNOWN; an answered `[]` is precisely when a
   * deregistered host's evidence must go, so this one reads it as EMPTY.
   * {@link dropsAsOutsideFleet} is where the two are reconciled, by asking
   * whether the port has ANSWERED at all rather than whether the fleet is
   * empty.
   */
  private pruneEvidenceOutsideFleet(): void {
    const present = new Set(this.fleet.hosts.map((entry) => entry.hostId));
    for (const hostId of Array.from(this.evidence.keys())) {
      if (!present.has(hostId)) this.evidence.delete(hostId);
    }
    for (const hostId of Array.from(this.seenTombstoneIds.keys())) {
      if (!present.has(hostId)) this.seenTombstoneIds.delete(hostId);
    }
  }

  /**
   * THE OTHER HALF OF {@link pruneEvidenceOutsideFleet}, and it is not
   * optional: the prune alone cannot hold, because the clear is a moment and
   * the probes it clears after are still in flight.
   *
   * A compatibility probe or a restart notification issued while a host was a
   * member lands after it is deregistered. Ingestion writes through
   * `hostEvidence`, which CREATES the entry the prune just deleted, so the
   * removal is silently undone. The next snapshot does not repair it - that is
   * the part that looks safe and is not: if the same durable host id is
   * registered again, the prune runs, finds it a member, and deletes nothing.
   * The host inherits its pre-removal state with no evidence whatsoever from
   * the new registration. For a `compatible`/`incompatible` verdict that is
   * permanent rather than transient: `evidence.compat` is written in exactly
   * one place and reset nowhere, so an inherited `incompatible` derives `dead`
   * forever. A restart episode inherits the same way, and worse in one detail
   * - the prune took `seenTombstoneIds` with it, so a REPLAY of the very
   * tombstone already seen reads as a first receipt and anchors a fresh
   * episode (mechanism 7's duplicate rule cannot fire on a memory that was
   * erased).
   *
   * GATED ON {@link hasFleetAnswer}, NOT ON `hosts.length === 0`, and the
   * difference is a hole rather than a nicety. Membership is UNKNOWN before
   * the port answers, and dropping then would discard real evidence during
   * startup permanently - ingestion has no second chance, unlike the prune,
   * which re-runs on every snapshot. But an ANSWERED `[]` is knowledge, and it
   * is how a single-host account deregisters: keying on emptiness would let
   * exactly that account walk a late verdict back in through this gate, which
   * is the very defect the gate exists to close.
   *
   * SESSION EVIDENCE IS DELIBERATELY EXEMPT (invariant 5): a live session
   * outranks every other evidence class, and `onHostProvedAlive` only ever
   * CLEARS state, so the inheritance it could cause runs in the permissive
   * direction that a live session already justifies.
   *
   * NOT C4, and must not be read as narrowing it. C4's guard is the
   * live-session suppression INSIDE `ingestDial`, which decides whether a
   * refusal is counted for a host the engine still has. This gate sits earlier
   * and asks a different question - is this host in the fleet at all - and
   * because it only ever drops more, it cannot narrow a suppression.
   */
  private dropsAsOutsideFleet(
    hostId: string,
    kind: SelectionEvidenceReport["kind"],
  ): boolean {
    if (!this.hasFleetAnswer) return false;
    if (this.fleet.hosts.some((entry) => entry.hostId === hostId)) return false;
    this.options.log.debug(
      "[selection-authority] evidence outside the fleet dropped",
      { hostId, kind },
    );
    return true;
  }

  private applyIdentity(identity: {
    identityKey: string | null;
    generation: number;
  }): void {
    // Monotonic acceptance: a delayed or coalesced old callback can never
    // transition the authority backward (§3b).
    if (identity.generation <= this.identityGeneration) return;
    const isSeed = this.identityGeneration === UNSET_IDENTITY_GENERATION;
    const outgoingIdentityKey = this.identityKey;
    this.identityGeneration = identity.generation;
    this.identityKey = identity.identityKey;
    if (isSeed) {
      // Nothing to wipe and no client can exist yet, so the first identity is
      // adopted without a transition (and without a re-attach trigger).
      return;
    }
    this.runIdentityTransition(outgoingIdentityKey);
  }

  /**
   * ONE transaction (§3b): void every incarnation, clear ALL evidence, reset
   * leases, swap to the new-generation fleet if one is already available or
   * the EMPTY fleet otherwise, emit - and only after that commit, emit
   * `reattachRequired` at its OWN fresh unique revision.
   */
  private runIdentityTransition(outgoingIdentityKey: string | null): void {
    // G1: sign-out WIPES the preference rather than merely scoping it, so a
    // shared machine cannot show the previous user's host choice back to
    // them, and the incoming account inherits nothing. Persistence exists to
    // survive a restart, not a user switch.
    this.options.preferredStore.save(outgoingIdentityKey, null);
    this.preferredHostId = this.options.preferredStore.load(this.identityKey);
    this.mruEffectiveHostIds.length = 0;
    for (const record of this.reporters.values()) {
      // Generation high-waters survive (rule 4); only the attachment dies -
      // and with it any handover ceiling that was waiting to retire it. Plain
      // null here, not `retireAttachment`: the evidence map is cleared two
      // lines below, so a ceiling armed now would be wiped anyway, and the
      // outgoing identity's hosts are not this identity's to judge.
      record.attachment = null;
      this.clearHandoverTimer(record);
    }
    this.evidence.clear();
    this.seenTombstoneIds.clear();
    this.nextSessionOrdinal = 0;
    // The local expected-outage hold is PORT STATE, not evidence: the
    // HostController mutation lane does not stop being in flight because the
    // signed-in user changed. Clearing it blindly used to drop the hold with
    // no edge left to restore it, so a deliberate local restart spanning a
    // sign-out would derive as connecting/dead and P1.3 would fail over off a
    // host that is coming back. Re-sample instead, keeping the original start
    // so the ceiling still counts from when the lane actually went busy.
    this.localOutageStartedAt = this.options.localOutage.inExpectedOutage()
      ? (this.localOutageStartedAt ?? this.options.clock.now())
      : null;
    const available = this.options.fleet.snapshot();
    this.fleet =
      available.identityGeneration === this.identityGeneration
        ? available
        : emptyFleet(this.identityGeneration);
    // THE ANSWER DOES NOT SURVIVE THE ACCOUNT. What the port told us about A's
    // hosts says nothing about B's, so B starts having answered nothing and
    // the adopted fleet is read on the same rule as the construction seed: it
    // is an answer only if it already names hosts. Dropping this reset does
    // not fail loudly - it makes the first post-transition window DISCARD
    // evidence it should accept, which looks exactly like a quiet host.
    this.hasFleetAnswer = this.fleet.hosts.length > 0;
    // The matching snapshot, when it arrives, must still be applicable: the
    // adapter's revision is process-lifetime monotonic, so leaving the
    // high-water where it is only rejects observations we already applied.
    if (this.fleet.revision > this.appliedFleetRevision) {
      this.appliedFleetRevision = this.fleet.revision;
    }
    // F14 ALSO APPLIES HERE, and used to be missed. The clear rule only ran on
    // the fleet-callback path, so a transition that adopted an ALREADY
    // -AVAILABLE matching-generation fleet loaded the incoming account's
    // persisted preference and staged without ever validating it against that
    // fleet: account B with a stale persisted id and a fleet snapshot already
    // in hand kept a removed host as preferred and target indefinitely, since
    // no later fleet event was owed. The rule is one rule - "the preferred
    // host is not in the account's fleet" - so it runs wherever the fleet is
    // adopted.
    const cleared = this.clearPreferredOutsideFleet();
    // The engine's damping state describes the OUTGOING account's hosts.
    this.usableSince.clear();
    this.pendingDampingDeadline = null;
    this.localEnsureFailedUntil = null;
    this.localEnsureRetryHoldUntil = null;
    // Retire the outgoing account's in-flight ensure so the incoming identity
    // may ask for its own. Its completion is now state-neutral by token
    // mismatch, so nothing it does can reach B.
    this.localEnsureToken = null;
    this.localEnsureExpiresAt = null;
    // THE OUTGOING SELECTION IS NOT AN INCUMBENT FOR THE INCOMING IDENTITY.
    //
    // Everything else here is wiped, but `this.selection` was not - and it is
    // read by BOTH halves of derivation. Damping treats a non-null
    // `effectiveHostId` as "something is serving, protect it", so with account
    // A's host still sitting there, B's first derivation looked like a
    // FailedOver window: A's host is not B's target, B's target has no
    // accumulated stability, and the move is therefore HELD - publishing an
    // account-A host as account B's effective host for up to the full
    // return-to-target window. The HOLD rule reads the same field and would
    // hold on A's lease just as happily.
    //
    // Clearing it says the true thing: a new identity has no incumbent. The
    // first derivation is then an ordinary NoHost adoption (immediate, no
    // window), and `previousEffectiveHostId` on the event is null - which is
    // also what makes the first-provision toast suppression correct across a
    // sign-in rather than announcing a "switch" from a stranger's host.
    this.selection = EMPTY_SELECTION;
    // One transaction: the state batch is staged first and the trigger after
    // it, so the trigger's revision is strictly above every event of the
    // commit it follows - then both are delivered in that order.
    this.stage(cleared ? "deregister-clear" : "fleet-shift");
    this.stageReattachRequired();
    this.drain();
  }

  private applyLocalOutage(inExpectedOutage: boolean): void {
    const startedAt = this.localOutageStartedAt;
    if (inExpectedOutage) {
      if (startedAt !== null) return;
      this.localOutageStartedAt = this.options.clock.now();
    } else {
      if (startedAt === null) return;
      this.localOutageStartedAt = null;
    }
    this.commit("failover");
  }

  // ------------------------------------------------------------ derivation

  /**
   * `derive(preferred, fleet)` from selection model §1, as a PURE function of
   * the preference, the fleet and the leases just computed:
   *
   *   usable(preferred) → preferred
   *   usable(local)     → local
   *   any usable remote → most-recently-effective one
   *   otherwise         → null  (∅ → the global modal)
   *
   * P1.3 owns the failover MACHINE on top of this - death streaks driving
   * candidate switches, the local `ensure` request, and the damping windows.
   * Nothing here waits, retries or debounces: it answers "given what is known
   * right now, which host serves this app".
   */
  private deriveSelection(
    leases: readonly HostLeaseSnapshot[],
    cause: SelectionChangeCause,
    now: number,
  ): SelectionState {
    const preferredHostId = this.preferredHostId;
    // M5: the target is the preference, or the local host when there is none.
    const localHostId = this.fleet.localHostId;
    const targetHostId = preferredHostId ?? localHostId;
    const desired = this.deriveDesiredEffective(
      targetHostId,
      localHostId,
      leases,
    );
    return {
      preferredHostId,
      targetHostId,
      effectiveHostId: this.applyDamping(
        desired,
        targetHostId,
        leases,
        cause,
        now,
      ),
    };
  }

  /**
   * Where derivation WANTS to be, before damping decides whether it may move
   * there yet. Candidate order is D8's: the target, then the local host, then
   * the most-recently-effective usable remote.
   */
  private deriveDesiredEffective(
    targetHostId: string | null,
    localHostId: string | null,
    leases: readonly HostLeaseSnapshot[],
  ): string | null {
    // THE D5/M6 HOLD, and the reason derivation is no longer a pure function
    // of the leases alone. A host that is deliberately cycling keeps serving:
    // `usable()` excludes `restarting-expected` so such a host is never newly
    // SELECTED, but the engine must not move OFF one either, or a user
    // restarting whichever host is currently effective would be thrown onto a
    // third machine and dragged back 15-30s later. The exemption is a property
    // of the CURRENT EFFECTIVE lease, not of the preferred host - that is
    // exactly what M6 corrected.
    const effectiveHostId = this.selection.effectiveHostId;
    if (
      effectiveHostId !== null &&
      this.leaseFor(effectiveHostId, leases)?.status === "restarting-expected"
    ) {
      return effectiveHostId;
    }
    if (targetHostId !== null && this.isUsable(targetHostId, leases)) {
      return targetHostId;
    }
    if (localHostId !== null && this.isUsable(localHostId, leases)) {
      return localHostId;
    }
    return this.mostRecentlyEffectiveUsableRemote(localHostId, leases);
  }

  /**
   * M6. Whether the engine may adopt `desired` now, or must keep serving what
   * it has until that candidate has proved itself.
   *
   * Which window applies is decided by the phase the engine is IN when the
   * switch comes up, which is what the registry's "every candidate switch
   * while `FailedOver`" means:
   *
   *  - OnTarget -> anything: NO window. This is failover itself, and it is
   *    supposed to be fast - the target is confirmed dead and the user wants
   *    to keep working.
   *  - NoHost -> anything: NO window. There is nothing to protect, and making
   *    a user sit in the ∅ modal for a further 20s to prove a host is really
   *    back would be damping for its own sake.
   *  - FailedOver -> ∅: NO window. ∅ is not a stability judgement; it is the
   *    honest answer when nothing is usable.
   *  - FailedOver -> the target: the full return window.
   *  - FailedOver -> another fallback: the minimal window.
   *  - Any phase whose INCUMBENT can no longer serve: NO window. The window
   *    exists to keep serving what the engine has until the candidate proves
   *    itself; an incumbent the fleet has published as dead is nothing to
   *    keep serving. Without this arm the local host dying three seconds into
   *    a return-to-target hold left every window pinned to a host the
   *    authority itself called dead for the remaining seventeen - the
   *    enumeration above asks only about the destination, and this is the one
   *    question about the origin.
   *  - An incumbent held usable ONLY by the engine's own in-flight ensure: NO
   *    window either. The in-flight arm reports the local host `connecting`
   *    so that ∅ never shows for a host the engine is starting FOR the user -
   *    a claim about candidacy, not about service. Since the ensure fires for
   *    a down local host whichever host is the target (2026-08-19), the arm
   *    now also fires for a dead INCUMBENT: the window failed over onto the
   *    local host, the target came back, and then the local host died - the
   *    same pass that publishes it dead starts booting it and would otherwise
   *    hand the return window a `connecting` incumbent that cannot serve
   *    anyone for the remaining seventeen seconds. A live session is the one
   *    thing that makes an in-flight ensure's host genuinely serving (the
   *    lease arm says so too), so it is the one thing that keeps the window.
   *
   * Explicit writes bypass all of it. Activate is valid from any state (M5)
   * and must land immediately - a user who picks a host in Settings and waits
   * 20s for the app to obey has been told a window is a bug. Same for the
   * deregister-clear: the old target is gone from the fleet for good, so
   * waiting cannot improve the answer.
   */
  private applyDamping(
    desired: string | null,
    targetHostId: string | null,
    leases: readonly HostLeaseSnapshot[],
    cause: SelectionChangeCause,
    now: number,
  ): string | null {
    const effectiveHostId = this.selection.effectiveHostId;
    if (desired === effectiveHostId) {
      this.pendingDampingDeadline = null;
      return desired;
    }
    if (
      cause === "activate" ||
      cause === "deregister-clear" ||
      effectiveHostId === null ||
      effectiveHostId === targetHostId ||
      desired === null ||
      !this.isUsable(effectiveHostId, leases) ||
      this.isHeldOnlyByOwnEnsure(effectiveHostId)
    ) {
      this.pendingDampingDeadline = null;
      return desired;
    }
    // `desired` came out of candidate enumeration over USABLE hosts, so it has
    // a stability mark; `now` only stands in for the impossible case, where it
    // reads as "became usable this instant" and holds the move.
    const usableSince = this.usableSince.get(desired) ?? now;
    const window =
      desired === targetHostId
        ? RETURN_TO_TARGET_STABILITY_MS
        : FAILOVER_CANDIDATE_STABILITY_MS;
    const admissibleAt = usableSince + window;
    if (now >= admissibleAt) {
      this.pendingDampingDeadline = null;
      return desired;
    }
    // Held back. Recorded so the deadline timer can bring the move in with no
    // further evidence - without it a target that came back and then went
    // quiet would never be returned to.
    this.pendingDampingDeadline = admissibleAt;
    return effectiveHostId;
  }

  private leaseFor(
    hostId: string,
    leases: readonly HostLeaseSnapshot[],
  ): HostLeaseSnapshot | null {
    return leases.find((entry) => entry.hostId === hostId) ?? null;
  }

  /**
   * Maintains {@link usableSince}. Called on every transaction, before
   * derivation reads it.
   */
  private trackUsability(
    leases: readonly HostLeaseSnapshot[],
    now: number,
  ): void {
    const usable = new Set<string>();
    for (const lease of leases) {
      if (!isUsableForSelection(lease)) continue;
      usable.add(lease.hostId);
      if (this.localEnsureToken?.hostId === lease.hostId) {
        // The local host reads `connecting` right now BECAUSE the engine asked
        // for it, not because anything observed it - so it accrues no
        // stability while that request is outstanding. Keeping the mark at
        // `now` is what makes "ensure never blocks serving a usable candidate"
        // true: a window already serving a remote cannot have its return
        // window elapse against a host that is still booting, however long the
        // boot takes. The clock starts when the provisioning answer does.
        this.usableSince.set(lease.hostId, now);
        continue;
      }
      if (!this.usableSince.has(lease.hostId)) {
        this.usableSince.set(lease.hostId, now);
      }
    }
    for (const hostId of Array.from(this.usableSince.keys())) {
      if (!usable.has(hostId)) this.usableSince.delete(hostId);
    }
  }

  /** A host is usable only if the fleet holds it AND its lease says so. */
  private isUsable(
    hostId: string,
    leases: readonly HostLeaseSnapshot[],
  ): boolean {
    const lease = leases.find((entry) => entry.hostId === hostId);
    return lease !== undefined && isUsableForSelection(lease);
  }

  /**
   * Whether this host reads usable ONLY because the engine's own ensure for it
   * is in flight - the in-flight arm of `deriveLease`, minus its live-session
   * exception. Read by the damping's incumbent check: such a host is a
   * candidate (so ∅ never shows while it boots) but not something to keep
   * SERVING a window from against a target that can.
   */
  private isHeldOnlyByOwnEnsure(hostId: string): boolean {
    return (
      this.localEnsureToken !== null &&
      this.localEnsureToken.hostId === hostId &&
      !this.hasLiveSession(hostId)
    );
  }

  /**
   * The third arm. MRU order first; when this process has never had an
   * effective remote (a cold start that cannot reach the local host), fall
   * back to the fleet's own order - which the fleet port sorts by hostId, so
   * the answer is deterministic rather than dependent on registry ordering.
   */
  private mostRecentlyEffectiveUsableRemote(
    localHostId: string | null,
    leases: readonly HostLeaseSnapshot[],
  ): string | null {
    // B3's eligibility half. `isUsableForSelection` answers on lease status
    // alone, so it cannot tell "proved compatible" from "never asked" - both
    // derive as `connecting`, which is usable. Taking the first usable host in
    // MRU-then-fleet order therefore fails over onto an UNPROVEN machine while
    // a proven one sits in the same fleet, which is what D13's "never a
    // candidate" is protecting against.
    //
    // A rank, not a gate. Making unknown INELIGIBLE would be the obvious
    // reading and it is wrong: a compat verdict is produced BY connecting, so
    // on a cold start nothing has one, and a gate would make every host
    // ineligible and ∅ universal. Unknown stays selectable - it just stops
    // outranking evidence. When nothing is proved, every host is equally
    // unknown and the second pass reproduces the previous order exactly.
    //
    // Deliberately NOT applied to the preferred-host arm: preference is the
    // user's intent (D1/D5), and intent outranks the engine's ranking of
    // hosts it picked for them. This is only the arm where the engine chooses.
    const proved = this.firstUsableRemote(localHostId, leases, (hostId) =>
      this.hasProvedCompatible(hostId),
    );
    if (proved !== null) return proved;
    return this.firstUsableRemote(localHostId, leases, () => true);
  }

  /** MRU order first, then the fleet's own (hostId-sorted) order. */
  private firstUsableRemote(
    localHostId: string | null,
    leases: readonly HostLeaseSnapshot[],
    admits: (hostId: string) => boolean,
  ): string | null {
    for (const hostId of this.mruEffectiveHostIds) {
      if (hostId === localHostId) continue;
      if (!admits(hostId)) continue;
      if (this.isUsable(hostId, leases)) return hostId;
    }
    for (const lease of leases) {
      if (lease.hostId === localHostId) continue;
      if (!admits(lease.hostId)) continue;
      if (isUsableForSelection(lease)) return lease.hostId;
    }
    return null;
  }

  /**
   * Whether this host has ever returned a `compatible` verdict.
   *
   * Absence means "never asked", never "assumed fine" - which is the whole
   * distinction B3 turns on. An `incompatible` verdict does not need to be
   * excluded here: it already derives as `dead`, so `isUsable` refuses it a
   * second time below.
   */
  private hasProvedCompatible(hostId: string): boolean {
    return this.evidence.get(hostId)?.compat?.verdict === "compatible";
  }

  /** Records an effective host at the head of the MRU order. */
  private noteEffective(hostId: string | null): void {
    if (hostId === null) return;
    const at = this.mruEffectiveHostIds.indexOf(hostId);
    if (at === 0) return;
    if (at > 0) this.mruEffectiveHostIds.splice(at, 1);
    this.mruEffectiveHostIds.unshift(hostId);
  }

  /**
   * B1/C6, the RESELECTION half of the corpse ceiling.
   *
   * The ceiling is judged against effectiveness at DERIVATION time (see
   * `deriveLease`), so a host that lost its last session while pointed at,
   * was left for a recovered target before its ceiling lapsed, and is later
   * selected AGAIN derives as usable `connecting` in the very pass that
   * selects it: its deadline is already in the past, `nextDeadline` (rightly)
   * never wakes the engine for a lapsed instant, and no report is coming -
   * nothing dials a host the app believes it is connected to. The
   * authority-owned exit the ceiling exists to provide would never fire, and
   * the app would sit on that host with no bound at all.
   *
   * So a host that becomes effective sessionless WITH A LOSS ON RECORD
   * restarts its clock from this moment: a fresh window in which the
   * renderers' first dial either proves it alive (`onHostProvedAlive` clears
   * the record) or it dies on its own. Restarting rather than keeping the old
   * instant is what makes the exit BOUNDED without killing the host on
   * arrival - the "not dead on arrival" pin stands. And ONLY for a host that
   * had a loss recorded: a host that never dropped a session while pointed
   * at is not a corpse candidate, and arming it here would be the "arm
   * everywhere" the ceiling's own doc rules out.
   */
  private restartPostSessionCeilingOnReselect(
    effectiveHostId: string | null,
    now: number,
  ): void {
    if (effectiveHostId === null) return;
    const evidence = this.evidence.get(effectiveHostId) ?? null;
    if (evidence === null || evidence.effectiveSessionLostAt === null) return;
    if (this.hasLiveSession(effectiveHostId)) return;
    evidence.effectiveSessionLostAt = now;
  }

  private deriveLeases(now: number): readonly HostLeaseSnapshot[] {
    return this.fleet.hosts.map((entry) =>
      this.deriveLease(entry.hostId, entry.kind === "local", now),
    );
  }

  /**
   * THE ONE SANCTIONED PROCESS ACTION (D14/C5), and the causal fix for the
   * audit's F4.
   *
   * Local provisioning used to be gated on the local host being the SELECTED
   * target (`canProvision`, `resolveLocalBootIntent`), so with a remote
   * preferred the local host was deliberately never booted - which made D8's
   * "local first" candidate systematically absent at exactly the moment
   * failover needed it. Nothing in the app would boot a deselected local host,
   * so ∅ was reachable with a perfectly working machine sitting idle. The
   * engine may ask for it, and only it may: the registry still never drives
   * processes.
   *
   * INDEPENDENT OF THE TARGET, by decision (2026-08-19). This landed with a
   * narrower rule - request only when derivation WANTED the local host (it was
   * the target, or the target could not serve), so a healthy preferred remote
   * left the local host alone and a deliberate-remote user never paid for an
   * idle local boot. That rule was reversed: the local host's lifecycle is the
   * same whichever host a window is pointed at - down means bring it back, as
   * the released desktop always did for the machine it runs on - and only the
   * NARRATION is target-scoped (a window serving a remote says nothing about
   * a local boot). So there is no want-local conjunct here any more. What
   * survives of the C5 argument is where the action lives: this engine, once,
   * paced by the same cooldowns whichever host is effective.
   *
   * DOWN means `dead` OR NEVER-DIALED. The dead-only reading was too narrow in
   * exactly one case and it was the commonest one: a cold boot has no evidence
   * at all, so the local lease reads `connecting` - which is *usable* - and the
   * engine would refrain until three confirmed refusals accumulated against a
   * socket that does not exist yet. Never-dialed is not "up"; and since the
   * ensure is what makes the socket dialable in the first place, waiting for
   * dial evidence to justify it is circular. A host that HAS been dialed is
   * excluded either way: mid-streak it is still connecting, and once it reaches
   * `dead` the first arm takes it. A never-dialed local host that is up (a
   * remote is serving the window, nothing has reason to dial it) draws exactly
   * ONE ensure: the converge answers `ok`, that is proof of life, and proof of
   * life creates the evidence record that ends never-dialed.
   *
   * Returns whether a request was started, because the caller must re-derive:
   * the request itself changes the local lease.
   */
  private requestLocalEnsureIfDown(
    leases: readonly HostLeaseSnapshot[],
    now: number,
  ): boolean {
    if (this.localEnsureToken !== null) return false;
    const localHostId = this.fleet.localHostId;
    if (localHostId === null) return false;
    const local = this.leaseFor(localHostId, leases);
    if (local === null) return false;
    if (local.status === "dead") {
      // Provisioning cannot fix a version mismatch; D13 says update, not boot.
      if (local.dead.reason === "incompatible") return false;
    } else if (
      local.status === "restarting-expected" ||
      !this.isLocalNeverDialed(localHostId) ||
      this.localOutageStartedAt !== null
    ) {
      // The THIRD conjunct is the never-dialed arm's guard (F3(c)): a
      // never-dialed host draws an ensure only while the outage signal is
      // FALSE at request time.
      //
      // Widening to never-dialed made two arms overlap that never could
      // before. The in-flight-ensure lease arm deliberately outranks the
      // expected-outage arm - the engine must not render as unusable the very
      // host it is starting, or provisioning shows the ∅ modal - and that was
      // safe while the trigger was `dead`-only, because a deliberately cycling
      // host is never dead. A first-boot host under a deliberate restart has
      // no dial evidence either, so it read as never-dialed, drew an ensure,
      // and the in-flight arm then reported `connecting` for a host that was
      // deliberately down: the D5 hold, defeated.
      //
      // Closing it at the SOURCE rather than by re-ranking the arms: a user
      // restart implies a host that exists and comes back, so never-dialed
      // plus a deliberate outage needs no provisioning at all - comeback
      // detection owns that case. Re-ranking would have re-opened
      // ∅-during-provisioning, and correlating "is this lane mine?" is not
      // possible: the engine's own ensure busies the same lane, so every test
      // of "did the outage begin after my request" is true of itself.
      //
      // KNOWN BOUNDED RACE, accepted: a user restart that races an ensure
      // ALREADY in flight keeps the lane signal continuous, so the in-flight
      // arm reports `connecting` until the token resolves. Self-healing at
      // completion, and one boolean cannot carry the provenance that would fix
      // it properly - revisit only if the lane ever reports which actor busied
      // it.
      return false;
    }

    // Deliberately NO "is the target serving?" gate here - see the doc above.
    const cooldownUntil = this.localEnsureFailedUntil;
    if (cooldownUntil !== null && now < cooldownUntil) return false;
    const retryHoldUntil = this.localEnsureRetryHoldUntil;
    if (retryHoldUntil !== null && now < retryHoldUntil) return false;
    this.localEnsureFailedUntil = null;
    this.localEnsureRetryHoldUntil = null;
    // Stamped with the identity AND host that wanted it: a completion arriving
    // after an account switch describes a fleet this engine no longer has, and
    // must not be able to speak for whatever is running now.
    const token: LocalEnsureToken = {
      generation: this.identityGeneration,
      hostId: localHostId,
      proofGeneration: this.localProofGeneration,
    };
    this.localEnsureToken = token;
    this.localEnsureExpiresAt = now + LOCAL_ENSURE_IN_FLIGHT_CEILING_MS;
    void this.options.localHostEnsure.ensureReady().then(
      (outcome) => {
        if (outcome.ok) {
          this.completeLocalEnsure(token, true, "", false);
          return;
        }
        this.completeLocalEnsure(
          token,
          false,
          outcome.reason,
          outcome.deferred,
        );
      },
      (error: unknown) => {
        this.completeLocalEnsure(token, false, String(error), false);
      },
    );
    return true;
  }

  /**
   * The ensure outcome, surfaced ONLY as the local lease's state (registry
   * §5) - the port itself carries no state anyone can read, so no surface can
   * grow a second opinion about provisioning.
   */
  private completeLocalEnsure(
    token: LocalEnsureToken,
    ok: boolean,
    reason: string,
    deferred: boolean,
  ): void {
    if (this.disposed) return;
    if (this.localEnsureToken !== token) {
      // Not the request the engine is waiting on - the account changed and the
      // transition retired it, or a newer request superseded it. State-neutral
      // by construction: it must not clear a LIVE token (which would let a
      // second ensure start while the first is still running) and it must not
      // commit (which would publish an answer about a fleet that is gone).
      this.options.log.debug("[selection-authority] stale ensure dropped", {
        hostId: token.hostId,
        generation: token.generation,
      });
      return;
    }
    if (token.hostId !== this.fleet.localHostId) {
      // THE LOCAL HOST CHANGED UNDER THE REQUEST (A -> B), WITHIN ONE
      // IDENTITY. Re-enrolment or a PID-metadata change republishes the fleet
      // at the SAME `identityGeneration`, so `applyFleetSnapshot` swaps
      // `localHostId` and the generation stamped on this token still matches -
      // the token's own fencing cannot see this transition, and neither can
      // the object-identity check above, because nothing retired the token.
      //
      // Both outcomes misattribute, in opposite directions:
      //
      //  - SUCCESS would credit A with `onHostProvedAlive`, clearing the very
      //    refusal streak that killed it and RE-CREATING the evidence entry
      //    `pruneEvidenceOutsideFleet` just deleted. With A's registry row
      //    still present as a remote, derivation can then select it.
      //  - FAILURE would arm `localEnsureFailedUntil`, so a provisioning run
      //    that was about A gates B - which derives B `dead` and puts ∅ in
      //    front of a user whose new local host was never asked for at all.
      //
      // The `hostId !== this.fleet.localHostId` guard inside
      // `onHostProvedAlive` is NOT this rule: it withholds the
      // `localProofGeneration` bump, but only after the credit has already
      // been applied - a guard one step downstream of the damage.
      //
      // Clearing the token is part of the fix, not bookkeeping: while it
      // stands, `requestLocalEnsureIfDown` refuses to start anything, so B
      // could not ask for its own ensure until A's ceiling lapsed. No
      // cooldown is armed - the failure describes a host this engine is no
      // longer pointed at - and the commit re-derives so B may ask at once.
      this.localEnsureToken = null;
      this.localEnsureExpiresAt = null;
      this.options.log.warn(
        "[selection-authority] ensure completed for a superseded local host",
        { tokenHostId: token.hostId, localHostId: this.fleet.localHostId, ok },
      );
      this.commit("failover");
      return;
    }
    this.localEnsureToken = null;
    this.localEnsureExpiresAt = null;
    if (ok) {
      // FIRSTHAND proof of life, and legitimately so under invariant 5: this
      // is not a cloud DTO but the desktop's own provisioning controller
      // reporting that it converged the host to ready, in-process. Without it
      // the stale refusal streak would keep the lease `dead` until something
      // happened to dial the host - and while a remote is serving, nothing
      // would.
      this.onHostProvedAlive(token.hostId);
      // F5: STABILITY STARTS AT PROOF OF LIFE, not at the request.
      // `trackUsability` refreshes the mark on every transaction while the
      // ensure is in flight, so the last refresh sits at whichever transaction
      // happened to run last - typically the one that STARTED the request. Left
      // alone, a 10s provisioning run would have already banked 10s of the
      // 20s return window against a host that had not yet proved anything,
      // which is precisely the credit the in-flight refresh exists to deny.
      // Dropping the mark makes the next `trackUsability` re-stamp it at
      // completion time.
      this.usableSince.delete(token.hostId);
    } else if (this.localProofGeneration !== token.proofGeneration) {
      // The host proved alive WHILE this request was running (a dial answered
      // at t+3s, this failure landing at t+5s). Arming the cooldown here would
      // undo `onHostProvedAlive`'s clear and re-deaden a host that has since
      // answered - a completion is the newest word only about a world nothing
      // else has spoken about since.
      //
      // Not merely the clear repeated: the clear runs at proof time and cannot
      // reach forward to a failure that has not happened yet. This is the
      // other half, and one without the other leaves the race open in
      // whichever direction it is missing from.
      this.options.log.debug(
        "[selection-authority] ensure failure post-dates proof of life",
        { hostId: token.hostId, reason },
      );
    } else if (deferred) {
      // Nothing ran, so nothing was learned about the host: pace the next
      // request (the lane's current owner is typically doing this very
      // converge) but leave the lease alone. Only a failure that actually
      // provisioned and lost may arm the dead-verdict cooldown below.
      this.localEnsureRetryHoldUntil =
        this.options.clock.now() + LOCAL_ENSURE_RETRY_COOLDOWN_MS;
      this.options.log.debug("[selection-authority] local ensure deferred", {
        reason,
      });
    } else {
      this.localEnsureFailedUntil =
        this.options.clock.now() + LOCAL_ENSURE_RETRY_COOLDOWN_MS;
      this.options.log.warn("[selection-authority] local ensure failed", {
        reason,
      });
    }
    this.commit("failover");
  }

  /**
   * One host's verdict. The order of these arms IS the evidence hierarchy:
   *
   * 1. `incompatible` first (C4/D13): compatibility is a handshake verdict,
   *    not a transport property - such a host dials and may hold a live
   *    socket, and is still unusable for selection.
   * 2. an expected outage (restart tombstone, or the local mutation lane)
   *    HOLDS the lease: the whole point of D5 is not to move off a host that
   *    is deliberately cycling, so this outranks both the live-session arm
   *    (which would flash `ready` a moment before the socket dies) and the
   *    death arm.
   * 3. a live session anywhere in the app is firsthand proof of life.
   * 4. the confirmed-death streak. `plan-restricted` is reachable ONLY from a
   *    refusal whose transport error carried it - never from a DTO.
   * 5. otherwise `connecting`: no evidence yet, or a streak still short of
   *    the threshold. Deliberately non-committal - neither usable-by-proof
   *    nor dead.
   *
   * `degraded` has no producer in P1.1: it belongs to the reconnect engine
   * that Phase 4 folds into this module. `dead("removed")` likewise - a
   * deregistered host leaves the fleet, and P1.2's deregister-clear owns the
   * selection consequence.
   */
  private deriveLease(
    hostId: string,
    isLocal: boolean,
    now: number,
  ): HostLeaseSnapshot {
    const evidence = this.evidence.get(hostId) ?? null;
    const compat = evidence?.compat ?? null;
    if (compat !== null && compat.incompatibility !== null) {
      return {
        hostId,
        status: "dead",
        dead: { reason: "incompatible", detail: compat.incompatibility },
      };
    }
    if (isLocal && this.localEnsureToken?.hostId === hostId) {
      // A LIVE SESSION ANSWERS FROM INSIDE THIS ARM, and it answers `ready`.
      // The launch-time ensure fires on every cold boot (never-dialed is
      // trivially true at t=0), and on a machine whose host is already up the
      // converge is a 30-45s CLI run - lock waits, a registry probe -
      // that says nothing about the host's ability to serve. Holding the
      // lease at `connecting` for that whole run held the window narrator's
      // "Setting up Traycer" over a fully mounted, fully working app, which
      // is the measured 30-60s "startup" this arm used to cost. A session is
      // firsthand proof of service (invariant 5) and outranks the engine's
      // own busywork; when the converge later stops the host for a swap, the
      // session drops and this arm's non-committal answer below resumes.
      //
      // Deliberately INSIDE the arm rather than re-ranking it below the
      // live-session arm at :2219: both branches here still preempt the
      // expected-outage arm, which is the F3(c) property the COMPOSITION pin
      // stands guard over - see the next paragraph.
      if (this.hasLiveSession(hostId)) {
        return { hostId, status: "ready", dead: null };
      }
      // The engine's own provisioning request is in flight (D14). It outranks
      // the expected-outage arm below deliberately: that arm's signal is the
      // HostController mutation lane, which THIS request drives, so deferring
      // to it would render the local host `restarting-expected` - unusable -
      // and put the ∅ modal in front of a user whose host is being started
      // for them. `connecting` is the honest non-committal answer, and it is
      // what registry §5 names. A restart the engine did NOT ask for still
      // reaches the arm below and still holds.
      //
      // WHY NOTHING STAMPED ON THE TOKEN CAN REFINE THIS (F3 completion, and
      // a refuted design - do not rebuild it). The obvious refinement is to
      // record the outage signal at mint and yield here when the outage
      // PREDATED the request, on the grounds that such an outage cannot be
      // ours. That stamp is provably always false: an ensure is minted from
      // exactly two arms, and both guarantee a false signal at mint - the
      // never-dialed arm is guarded on it explicitly (see
      // `requestLocalEnsureIfDown`), and `dead` is unreachable while
      // `inExpectedOutage` is true because THIS ORDER puts the outage arm
      // above every dead arm. The one residue - a ceiling-lapsed outage whose
      // start is still recorded - has `inExpectedOutage` answering false
      // anyway, so a yield would change nothing there either.
      //
      // The remaining case, an outage that begins AFTER the mint, is the one
      // the signal genuinely cannot attribute: our own `convergeReady` busies
      // that lane, so "it started after I asked" is true of ourselves. Ranking
      // the outage arm first instead resolves it in the direction that hurts,
      // and it passes every OTHER test in the suite - measured, not assumed.
      // The engine suite's `COMPOSITION: an ensure the ENGINE started
      // outranks the outage signal it busies` pin is what stands between that
      // green re-rank and shipping ∅ during provisioning.
      return { hostId, status: "connecting", dead: null };
    }
    if (this.inExpectedOutage(hostId, isLocal, now)) {
      return { hostId, status: "restarting-expected", dead: null };
    }
    if (this.hasLiveSession(hostId)) {
      return { hostId, status: "ready", dead: null };
    }
    if (isLocal && this.localEnsureFailedAt(now)) {
      // "The ensure path is unavailable or has failed" (registry §5), as lease
      // state - which is what makes the ∅ definitions one. Below the
      // live-session arm on purpose: if a session exists the host is alive
      // whatever an earlier provisioning attempt concluded.
      //
      // THE NARROWNESS THIS ORDER BUYS, and what it does NOT buy. Because this
      // arm sits below the live-session one, a proof of life that LEAVES A
      // SESSION STANDING (an attach announcement, a session established)
      // already masks a stale cooldown here for as long as that session lives
      // - so `onHostProvedAlive`'s clear and `completeLocalEnsure`'s
      // re-arm suppression are not what rescue those two kinds. They are what
      // rescue the proof kinds that leave NO session behind: a successful dial
      // and a successful ensure, where nothing above this arm intervenes and
      // the cooldown would otherwise render an answering host `dead`.
      //
      // Arm order alone was never sufficient, in two places it cannot reach:
      // `requestLocalEnsureIfDown` reads the cooldown DIRECTLY, under no arm
      // ordering at all (it is separately declined under a live session, by
      // the never-dialed conjunct), and the masking lapses the moment the
      // session drops, resurfacing a cooldown whose premise the host has since
      // refuted. Hence the clear, rather than a rule about which arm wins.
      return { hostId, status: "dead", dead: { reason: "offline" } };
    }
    if (
      evidence !== null &&
      evidence.effectiveSessionLostAt !== null &&
      now >=
        evidence.effectiveSessionLostAt +
          EFFECTIVE_HOST_POST_SESSION_CEILING_MS &&
      this.selection.effectiveHostId === hostId
    ) {
      // B1/C6. Below the expected-outage and live-session arms by position, so
      // a deliberate restart still holds the lease and any session anywhere
      // still wins. Effectiveness is re-checked HERE and not only at arm time:
      // if the app moved off this host for some other reason, the deadline
      // stops being a statement anyone needs, and a stale one must not be able
      // to kill a host the moment it is selected again.
      return { hostId, status: "dead", dead: { reason: "offline" } };
    }
    if (
      evidence !== null &&
      evidence.refusalStreak >= CONFIRMED_DEATH_REFUSAL_STREAK
    ) {
      return {
        hostId,
        status: "dead",
        dead: {
          reason:
            evidence.lastCountedRefusalDetail === "plan-restricted"
              ? "plan-restricted"
              : "offline",
        },
      };
    }
    return { hostId, status: "connecting", dead: null };
  }

  /**
   * No evidence has ever been reported for this host - nothing dialed it, no
   * session announced, no compat verdict. Distinct from "reported nothing
   * bad": a successful dial creates a record with a zero streak, so a host
   * that once answered is never never-dialed again.
   */
  private isLocalNeverDialed(hostId: string): boolean {
    return !this.evidence.has(hostId) && !this.hasLiveSession(hostId);
  }

  /** Whether a failed ensure is still holding the local lease dead. */
  private localEnsureFailedAt(now: number): boolean {
    const until = this.localEnsureFailedUntil;
    return until !== null && now < until;
  }

  private inExpectedOutage(
    hostId: string,
    isLocal: boolean,
    now: number,
  ): boolean {
    const episodeEndsAt = this.evidence.get(hostId)?.restartEpisodeEndsAt;
    if (episodeEndsAt !== undefined && episodeEndsAt !== null) {
      if (now < episodeEndsAt) return true;
    }
    if (!isLocal) return false;
    const startedAt = this.localOutageStartedAt;
    if (startedAt === null) return false;
    return now < startedAt + LOCAL_EXPECTED_OUTAGE_CEILING_MS;
  }

  /**
   * The next moment a lease would change with no new evidence - an episode or
   * the local ceiling lapsing. Without this the lease would stay
   * `restarting-expected` until something else happened to arrive.
   */
  /**
   * Retires an in-flight ensure that passed its ceiling (B2), landing it in
   * the same terminal state a FAILED ensure reaches.
   *
   * The cooldown rather than a bare clear, because a bare clear would let the
   * very next derivation ask again immediately - a hung provisioning lane
   * would be re-requested every pass forever, and the lease would flip back to
   * `connecting` before any surface could show ∅. The cooldown is also already
   * what registry §5 means by "the ensure path is unavailable or has failed",
   * so ∅ can say so honestly, and its lapse is what lets the engine try again.
   *
   * C7 is satisfied by construction rather than by a second guard: nulling the
   * token is what makes the eventual completion state-neutral, because
   * `completeLocalEnsure` already drops any callback whose token is no longer
   * the one being waited on. There is deliberately no separate "expired" flag
   * for it to consult - a late completion cannot tell, and must not need to.
   */
  private expireLocalEnsureIfLapsed(now: number): void {
    const expiresAt = this.localEnsureExpiresAt;
    if (expiresAt === null) return;
    if (now < expiresAt) return;
    const token = this.localEnsureToken;
    this.localEnsureToken = null;
    this.localEnsureExpiresAt = null;
    this.localEnsureFailedUntil = now + LOCAL_ENSURE_RETRY_COOLDOWN_MS;
    this.options.log.warn(
      "[selection-authority] local ensure exceeded its ceiling",
      { hostId: token === null ? null : token.hostId },
    );
  }

  private nextDeadline(now: number): number | null {
    let earliest: number | null = null;
    const consider = (deadline: number): void => {
      if (deadline <= now) return;
      if (earliest === null || deadline < earliest) earliest = deadline;
    };
    for (const entry of this.fleet.hosts) {
      const endsAt = this.evidence.get(entry.hostId)?.restartEpisodeEndsAt;
      if (endsAt !== undefined && endsAt !== null) consider(endsAt);
      if (entry.kind === "local" && this.localOutageStartedAt !== null) {
        consider(this.localOutageStartedAt + LOCAL_EXPECTED_OUTAGE_CEILING_MS);
      }
    }
    // A damped move completes on TIME, not on evidence: the target came back
    // and then went quiet, which is the normal shape of a recovery. Without
    // this the return-to-target window would only ever be checked when some
    // unrelated report happened to arrive.
    const damping = this.pendingDampingDeadline;
    if (damping !== null) consider(damping);
    // A failed ensure holds the local lease dead for a cooldown; the lapse is
    // a lease change with no new evidence behind it, and it is what lets the
    // engine ask again.
    const ensureCooldown = this.localEnsureFailedUntil;
    if (ensureCooldown !== null) consider(ensureCooldown);
    // A deferred ensure's pacing hold changes no lease, but its lapse
    // re-enables the request the next derivation would make - and on a quiet
    // engine nothing else wakes that derivation up.
    const ensureRetryHold = this.localEnsureRetryHoldUntil;
    if (ensureRetryHold !== null) consider(ensureRetryHold);
    // An ensure still running holds the local lease usable, so its ceiling is
    // a lease change with no new evidence behind it - the same shape as the
    // cooldown above, and the arm whose absence was B2.
    const ensureCeiling = this.localEnsureExpiresAt;
    if (ensureCeiling !== null) consider(ensureCeiling);
    // B1/C6's corpse ceiling. Without this arm nothing wakes the engine after
    // the session drops - which is the whole defect: the path has no producer,
    // so there is no incoming report to derive from either.
    for (const entry of this.fleet.hosts) {
      const lostAt = this.evidence.get(entry.hostId)?.effectiveSessionLostAt;
      if (lostAt !== undefined && lostAt !== null) {
        consider(lostAt + EFFECTIVE_HOST_POST_SESSION_CEILING_MS);
      }
    }
    return earliest;
  }

  private clearDeadlineTimer(): void {
    if (this.cancelDeadlineTimer !== null) {
      this.cancelDeadlineTimer();
      this.cancelDeadlineTimer = null;
    }
    this.scheduledDeadline = null;
  }

  private armDeadlineTimer(now: number): void {
    const deadline = this.nextDeadline(now);
    if (deadline === null) {
      this.clearDeadlineTimer();
      return;
    }
    if (this.scheduledDeadline === deadline) return;
    this.clearDeadlineTimer();
    this.scheduledDeadline = deadline;
    this.cancelDeadlineTimer = this.options.clock.schedule(
      Math.max(0, deadline - now),
      () => {
        this.cancelDeadlineTimer = null;
        this.scheduledDeadline = null;
        if (this.disposed) return;
        this.commit("failover");
      },
    );
  }

  // -------------------------------------------------------------- emission

  /**
   * Stages one transaction and then delivers whatever is queued.
   *
   * COMMIT AND DELIVERY ARE SEPARATE STEPS, and that separation is
   * load-bearing rather than stylistic. Listeners run arbitrary consumer code
   * synchronously - in the browser/dev topology the in-process client hands
   * events straight to the renderer - so a listener can re-enter the engine
   * (drive the identity source, publish a fleet snapshot) in the middle of a
   * delivery. When emission happened inline, that re-entrancy could:
   *
   *  - interleave a nested transaction's revisions BETWEEN the parent's
   *    selection and leases events, breaking the contract's consecutive
   *    sibling pair; and
   *  - mint the identity transition's `reattachRequired` BEFORE `attach`
   *    captured its result snapshot, so the snapshot's revision already
   *    covered the trigger and the buffering client discarded it as
   *    stale - leaving that client holding a voided incarnation with no
   *    re-attach ever to follow.
   *
   * Staging allocates every revision for the transaction up front and appends
   * the events to one FIFO queue; the drain delivers them in that order, and a
   * nested commit appends AFTER the batch in flight instead of splitting it.
   */
  private commit(cause: SelectionChangeCause): void {
    this.stage(cause);
    this.drain();
  }

  /**
   * Mutates state and QUEUES the transaction's events. Delivers nothing, so a
   * caller that must seal a result against re-entrancy (see `attach`) can read
   * its snapshot between staging and draining.
   */
  private stage(cause: SelectionChangeCause): void {
    // Leases FIRST: derivation is a function of them, so computing the
    // selection off the previously-emitted set would answer one transaction
    // late. Emission order is still selection-then-leases (consecutive
    // revisions), so a client never sees leases for a selection it has not
    // been told about.
    const now = this.options.clock.now();
    // Before ANY derivation this pass: an ensure past its ceiling must not
    // still be reporting `connecting` into the leases computed below (B2).
    this.expireLocalEnsureIfLapsed(now);
    // TWO PASSES, because the two answers depend on each other: the ensure
    // decision needs the leases to know whether the local host is down, and
    // the leases then need to reflect that a request is in flight. Deriving twice is cheap (a map over the fleet) and
    // keeps both answers from the same instant; the alternative - deciding
    // ensure from raw evidence - would duplicate the arm order that IS the
    // evidence hierarchy.
    const initialLeases = this.deriveLeases(now);
    const leases = this.requestLocalEnsureIfDown(initialLeases, now)
      ? this.deriveLeases(now)
      : initialLeases;
    this.trackUsability(leases, now);
    const selection = this.deriveSelection(leases, cause, now);
    if (!selectionEquals(selection, this.selection)) {
      const previousEffectiveHostId = this.selection.effectiveHostId;
      this.selection = selection;
      this.noteEffective(selection.effectiveHostId);
      if (selection.effectiveHostId !== previousEffectiveHostId) {
        this.restartPostSessionCeilingOnReselect(
          selection.effectiveHostId,
          now,
        );
      }
      this.eventQueue.push({
        kind: "selection",
        event: {
          revision: this.nextRevision(),
          change: {
            preferredHostId: selection.preferredHostId,
            targetHostId: selection.targetHostId,
            effectiveHostId: selection.effectiveHostId,
            previousEffectiveHostId,
            cause: resolveCause(cause, selection),
          },
        },
      });
    }
    if (!leasesEqual(leases, this.leases)) {
      this.leases = leases;
      this.eventQueue.push({
        kind: "leases",
        event: { revision: this.nextRevision(), change: leases },
      });
    }
    this.armDeadlineTimer(now);
  }

  /**
   * The MANDATORY post-transition re-attach trigger, staged at its OWN fresh
   * unique revision after its transaction's state events (§3b) so one client
   * high-water mark still orders all three event kinds and no state sibling
   * can shadow it.
   */
  private stageReattachRequired(): void {
    this.eventQueue.push({
      kind: "reattach",
      event: { revision: this.nextRevision() },
    });
  }

  /** Delivers the queue in FIFO order; re-entrant calls are absorbed. */
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const queued = this.eventQueue.shift();
        if (queued === undefined) return;
        this.deliverQueued(queued);
      }
    } finally {
      this.draining = false;
    }
  }

  private deliverQueued(queued: QueuedAuthorityEvent): void {
    if (queued.kind === "selection") {
      for (const listener of Array.from(this.selectionListeners)) {
        this.deliver(() => listener(queued.event), "selectionChanged");
      }
      return;
    }
    if (queued.kind === "leases") {
      for (const listener of Array.from(this.leaseListeners)) {
        this.deliver(() => listener(queued.event), "leasesChanged");
      }
      return;
    }
    for (const listener of Array.from(this.reattachListeners)) {
      this.deliver(() => listener(queued.event), "reattachRequired");
    }
  }

  private nextRevision(): number {
    this.revision += 1;
    return this.revision;
  }

  /** One window's throwing listener must not cost another window its event. */
  private deliver(run: () => void, channel: string): void {
    try {
      run();
    } catch (error: unknown) {
      this.options.log.warn("[selection-authority] listener threw", {
        channel,
        error: String(error),
      });
    }
  }

  /**
   * The identity the persisted preference is scoped to (P1.2). Held here
   * because the transition transaction is the only place it changes.
   */
  currentIdentityKey(): string | null {
    return this.identityKey;
  }
}

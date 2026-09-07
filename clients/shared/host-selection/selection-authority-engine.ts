/** This module is the transport-agnostic implementation: plain TS, no Electron, no IPC, no DOM. */
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
import { PLAN_RESTRICTED_REPROBE_MS } from "../host-transport/remote/config";

/**
 * How many consecutive ordinary transport-confirmed refusals/timeouts - counted across every window's attempts, deduplicated per (incarnation, attemptId) - make a host `dead` (connection registry §2).
 * The transports pace their own redials (backoff), so three consecutive refusals land inside that window in practice while a single unlucky refusal never does.
 */
export const CONFIRMED_DEATH_REFUSAL_STREAK = 3;

/**
 * The fixed window a restart-intent tombstone holds its host in `restarting-expected` (connection registry §3, mechanism 7).
 * When it lapses, ordinary evidence resumes and a host that never came back reaches `dead` normally.
 */
export const RESTART_INTENT_EPISODE_MS = 60_000;

export const LOCAL_EXPECTED_OUTAGE_CEILING_MS = 15 * 60_000;

/**
 * How many recent dial attempt ids one incarnation remembers for dedup.
 * The set exists only to collapse duplicate deliveries of the same attempt (an IPC redelivery, a reporter retry); nothing legitimately re-delivers an attempt from hundreds of dials ago.
 */
export const ATTEMPT_DEDUP_WINDOW = 256;

/**
 * How many lost-before-established session ids one incarnation tombstones.
 * A tombstone only has to outlive the reordered `established` racing it, which is a same-second window.
 */
export const SESSION_TOMBSTONE_WINDOW = 256;

/**
 * How many session observation ordinals one incarnation keeps per host.
 * Only the ordering of recent sessions can matter to compat freshness: a verdict anchored to a session this incarnation no longer tracks is stale by definition (see `rankForCompatAnchor`).
 */
export const SESSION_ORDINAL_WINDOW = 64;

/**
 * How long a reporter's current attachment is held once a newer generation has been issued but not yet claimed (the handover of module header rule 4).
 * But a claim is not guaranteed to arrive.
 */
export const ATTACH_HANDOVER_CEILING_MS = 30_000;

/**
 * An insertion-ordered id set with a hard cap, evicting the oldest entry when it overflows.
 * JS `Set` iterates in insertion order, which is the only property this needs - dedup is a one-shot test per id, so there is nothing to refresh on a hit and no lru bookkeeping to pay for.
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
 * How long the target must have been continuously usable before the engine returns to it (connection registry §4's "~15-30 s of confirmed stability").
 */
export const RETURN_TO_TARGET_STABILITY_MS = 20_000;

/**
 * Ceiling on the cold-start hold (see `deriveDesiredEffective`): how long a process that has never served may answer ∅ for a `restarting-expected` local target before falling through to a usable fallback.
 * Past the ceiling the fallback is adopted exactly as before the hold existed.
 */
export const COLD_START_LOCAL_RESTART_HOLD_CEILING_MS =
  RETURN_TO_TARGET_STABILITY_MS;

export const FAILOVER_CANDIDATE_STABILITY_MS = 5_000;

/** How long a failed local `ensure` holds the local lease `dead` before the engine may ask again. */
export const LOCAL_ENSURE_RETRY_COOLDOWN_MS = 30_000;

/**
 * Ceiling on one in-flight local `ensureReady()` before the engine stops treating it as a reason to keep the local lease usable (B2).
 * `nextDeadline()` had an arm for the cooldown after a failed ensure and none for an ensure still running, while the in-flight arm of `deriveLease` reports `connecting` - which is usable.
 */
export const LOCAL_ENSURE_IN_FLIGHT_CEILING_MS =
  LOCAL_EXPECTED_OUTAGE_CEILING_MS;

  /**
   * How long the host the app is actually pointed AT may sit with no session and no new evidence before the authority calls it dead on its own (B1/C6).
   * `refusalStreak` needs a producer, and on that path there is none, so the death predicate never fires and the lease falls through to `connecting`, which is usable.
   */
export const EFFECTIVE_HOST_POST_SESSION_CEILING_MS = 90_000;

/**
 * The engine's own clock and timer source (mechanism 7: "authority deadlines come from its own ceilings, never renderer or host clocks").
 */
export interface AuthorityClock {
  now(): number;
  /** Returns a canceller; calling it twice is safe. */
  schedule(delayMs: number, run: () => void): () => void;
}

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
 * Diagnostic sink.
 * The engine never throws for bad input - a report that does not belong to a live incarnation, a stale fleet snapshot, or a listener that throws is logged and dropped.
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
 * What the authority did with one dial report - the complete, closed set of exits from {@link SelectionAuthorityEngineImpl.ingestDial}.
 * It exists because "the refusal streak never reached the threshold" was not answerable from a production log.
 */
export type DialDisposition =
  /** Streak advanced. The only disposition that can ever reach death. */
  | "counted"
  /** Streak advanced AND crossed {@link CONFIRMED_DEATH_REFUSAL_STREAK}. */
  | "counted-reached-death"
  /** A dial succeeded: proof of life, streak reset to zero. */
  | "cleared-by-success"
  /** `indeterminate` - inert by contract, advances nothing. */
  | "inert-indeterminate"
  /** A live session for this host outranks the failure (invariant 5). */
  | "suppressed-live-session"
  /** A deterministic plan denial already owns the verdict and reprobe clock. */
  | "suppressed-plan-restriction"
  /** The host is not in the answered fleet. */
  | "dropped-outside-fleet"
  /** This (incarnation, attemptId) was already ingested. */
  | "dropped-duplicate-attempt";

function dispositionCounts(disposition: DialDisposition): boolean {
  return disposition === "counted" || disposition === "counted-reached-death";
}

/**
 * Incarnation ids identify a client instance to the engine that minted them; they never cross a trust boundary and are never persisted, so a process -local counter is sufficient and keeps tests deterministic.
 */
export function createIncrementingIncarnationIds(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `incarnation-${counter}`;
  };
}

/**
 * Where `preferredHostId` survives an app restart, identity-scoped (G1).
 * The file is tiny and written only on Activate or a deregister-clear, so the cost is a rare small write, not a hot path.
 */
export type PreferredHostSaveResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface PreferredHostStore {
  /**
   * A failed read is genuinely "no preference": derivation degrades to the local host, which is the same safe answer a first run gets, and a read cannot corrupt anything.
   */
  load(identityKey: string | null): string | null;
  /**
   * Callers that can refuse (Activate) do; the transition proceeds and lets the store own durable honesty.
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

interface LiveSessionRecord {
  readonly hostId: string;
  readonly transportKind: SelectionTransportKind;
}

interface AttachmentRecord {
  readonly incarnationId: string;
  readonly attachSeq: number;
  readonly sessions: Map<string, LiveSessionRecord>;
  /**
   * `lost` observed before `established` for these ids: the session never counts as live and the later `established` is dropped.
   */
  readonly tombstonedSessionIds: BoundedIdSet;
  /**
   * Dial dedup within the incarnation (mechanism 5). Bounded - see
   * {@link ATTEMPT_DEDUP_WINDOW}.
   */
  readonly seenAttemptIds: BoundedIdSet;
  /**
   * hostId -> sessionId -> the authority's observation ordinal, scoped to this incarnation because that is the scope in which `sessionId` is unique.
   */
  readonly sessionOrdinals: Map<string, Map<string, number>>;
  /**
   * Per host, the highest ordinal evicted from `sessionOrdinals`.
   * A verdict anchored to a forgotten session ranks here - never as something new - which is what keeps eviction from turning an ancient verdict into the freshest one.
   */
  readonly evictedOrdinalFloor: Map<string, number>;
}

/**
 * Per-reporter attach generation state.
 * `latestIssuedSeq` IS the supersession fence (module header rule 4): allocation advances it, and only that seq - while unconsumed - can be claimed.
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

interface CompatRecord {
  readonly verdict: "compatible" | "incompatible";
  readonly incompatibility: SelectionIncompatibility | null;
  /**
   * The authority's own observation ordinal for `probedOnSessionId`, or `null` when the verdict named no session at all.
   * Version strings are never an ordering key.
   */
  readonly rank: number | null;
}

interface HostEvidence {
  refusalStreak: number;
  planRestrictedRefusalObserved: boolean;
  planRestrictedUntil: number | null;
  compat: CompatRecord | null;
  /** Authority-local deadline of the current tombstone episode, if any. */
  restartEpisodeEndsAt: number | null;
  /** The D5/M6 restart hold is unbounded only for the former; see `deriveDesiredEffective`. */
  provedAliveAtLeastOnce: boolean;
  /**
   * When this host's last live session ended while IT was the effective host, or null (B1/C6).
   * Only armed for the host the app is actually pointed at: an idle host nobody is talking to produces no evidence either, and `connecting` - "no evidence yet", neither usable-by-proof nor dead - is the honest answer there.
   */
  effectiveSessionLostAt: number | null;
}

function emptyHostEvidence(): HostEvidence {
  return {
    refusalStreak: 0,
    planRestrictedRefusalObserved: false,
    planRestrictedUntil: null,
    compat: null,
    restartEpisodeEndsAt: null,
    provedAliveAtLeastOnce: false,
    effectiveSessionLostAt: null,
  };
}

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
   * One in-flight {@link LocalHostEnsurePort} request. Matched by object
   * identity, so a completion can never be mistaken for a newer request's.
   */
interface LocalEnsureToken {
  readonly generation: number;
  readonly hostId: string;
  /** The local proof-of-life counter as it stood when this request was minted. */
  readonly proofGeneration: number;
}

interface SelectionState {
  readonly preferredHostId: string | null;
  /**
   * The fleet-wide selection target: preferred, or the local host when preferred is null (M5), or null when neither exists.
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
 * Generation sentinel for "the engine has not adopted an identity yet".
 * Below every real generation, so the first identity - whether it arrives from `current()` or from a callback that raced it - is adopted as a seed (no wipe, no `reattachRequired`) rather than as a transition.
 */
const UNSET_IDENTITY_GENERATION = -1;

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
 * Nothing interleaves between a parse and a guarded call, which is what makes the attach claim race-free without a lock (module header rule 6).
 */
export class SelectionAuthorityEngineImpl implements SelectionAuthorityEngine {
  private readonly options: SelectionAuthorityEngineOptions;

  /**
   * The one revision counter (mechanism 1).
   * Process-lifetime monotonic: it never resets, including across sign-out/account replacement.
   */
  private revision = 0;

  /** The user's intent (D1), and the only persisted half of the selection. */
  private preferredHostId: string | null = null;
  /**
   * Hosts that have been effective, most recent first - the "most-recently -effective usable remote" the derivation's third arm names (registry §4).
   */
  private readonly mruEffectiveHostIds: string[] = [];
  private selection: SelectionState = EMPTY_SELECTION;
  private leases: readonly HostLeaseSnapshot[] = [];

  private fleet: HostFleetSnapshot = emptyFleet(UNSET_IDENTITY_GENERATION);
  private appliedFleetRevision = Number.NEGATIVE_INFINITY;
  /**
   * Whether the fleet port has given a genuine membership answer for the current identity - the distinction `hosts.length === 0` cannot draw.
   * A published snapshot IS always AN answer, even AN empty one; A seed OR adopted fleet IS AN answer only IF IT already names hosts.
   */
  private hasFleetAnswer = false;
  private identityKey: string | null = null;
  private identityGeneration = UNSET_IDENTITY_GENERATION;

  private readonly reporters = new Map<string, ReporterRecord>();
  private readonly evidence = new Map<string, HostEvidence>();
  /**
   * Per host, consecutive dial reports that taught the authority nothing - a drop, a dedup, an inert `indeterminate`, or a live-session suppression.
   */
  private readonly dialStalls = new Map<string, number>();
  /** The next observation ordinal to hand out. */
  private nextSessionOrdinal = 0;
  /**
   * Every (hostId, tombstoneId) ever observed, retained for the authority process lifetime (decision 9): pruned only on the host's fleet removal or an identity transition.
   */
  private readonly seenTombstoneIds = new Map<string, Set<string>>();

  /** Start of the current local expected outage, or null when the lane is idle. */
  private localOutageStartedAt: number | null = null;
  /**
   * Per host, when its lease became continuously usable, or absent while it is not.
   * This is the "confirmed stability" the damping windows measure against; it is cleared the instant a host stops being usable, so a flap restarts the clock rather than accumulating credit.
   */
  private readonly usableSince = new Map<string, number>();
  /**
   * When a damped move would become admissible with no new evidence, or null when nothing is being held back.
   * Recorded at derivation time (where the candidate is already known) rather than recomputed by the timer, so the two can never disagree about which move is waiting.
   */
  private pendingDampingDeadline: number | null = null;
  /**
   * The host the cold-start hold is waiting on and when that wait began, or null while the hold is not engaged (see `deriveDesiredEffective`).
   * Cleared whenever the premise stops holding, so a later episode measures its own window; kept across a lapsed ceiling, so the same boot cannot re-arm a fresh one.
   */
  private coldStartHold: { hostId: string; startedAt: number } | null = null;
  /**
   * The in-flight local `ensure`, or null (D14).
   * A token rather than a boolean, because a boolean cannot say whose ensure is running.
   */
  private localEnsureToken: LocalEnsureToken | null = null;
  /** When the in-flight ensure stops holding the local lease usable, or null when none is running (B2). */
  private localEnsureExpiresAt: number | null = null;
  /** End of the cooldown after a failed ensure, or null. */
  private localEnsureFailedUntil: number | null = null;
  /**
   * End of the request-pacing hold after a deferred ensure, or null.
   * Without the split, a lock lost to the desktop's own launch converge rendered a healthy host `dead: offline` for 30s and put the ∅ modal over a working machine.
   */
  private localEnsureRetryHoldUntil: number | null = null;
  /**
   * Monotonic count of proofs of life for the host that is local at the time each one lands.
   * Stamped onto every ensure token at mint, and the only thing that lets a completion tell "my failure is the newest word on this host" from "the host answered while I was still running".
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
   * Staged-but-undelivered events, in revision order.
   * Listeners run consumer code synchronously and may re-enter the engine, so delivery is a separate FIFO drain rather than an inline call - see {@link commit}.
   */
  private readonly eventQueue: QueuedAuthorityEvent[] = [];
  private draining = false;
  private disposed = false;

  constructor(options: SelectionAuthorityEngineOptions) {
    this.options = options;

    this.portSubscriptions.push(
      options.identity.onChanged((identity) => {
        this.applyIdentity(identity);
      }),
    );
    this.applyIdentity(options.identity.current());
    // after the identity seed: the preference is scoped to whoever is signed
    // in, so it cannot be read before that is known.
    this.preferredHostId = options.preferredStore.load(this.identityKey);

    this.portSubscriptions.push(
      options.fleet.onChanged((snapshot) => {
        this.applyFleetSnapshot(snapshot, "published");
      }),
    );
    // The seed read IS not AN answer unless it already names hosts.
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
    // Allocation advances the fence (module header rule 4): every older generation's attach is superseded from this moment, whether or not the new instance ever attaches.
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
    // The claim is consumed; the previous attachment is retired inside the same synchronous call, and (on success) replaced before anything is emitted - so no observer ever sees the reporter session-less.
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
    // Seal before delivery.
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
    // F14: the write is directory-validated.
    if (!this.fleet.hosts.some((entry) => entry.hostId === hostId)) {
      return Promise.resolve({ ok: false, reason: "unknown-host" });
    }
    // D13/C4: an incompatible host is never selectable.
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
      // Persist first, and only then touch state or emit.
      // Ordering makes a partial commit impossible rather than merely unlikely.
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

  /** Releases the port subscriptions and any armed deadline. */
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
   * The full state at the current revision.
   * Captured after a transaction's emissions, so `revision` is the maximum committed event revision and a client that installs it can discard every buffered event at or below it.
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
   * Re-armed on every issuance (the newest generation is the one whose claim the held attachment waits for), cleared by the claim itself ({@link claimSeq}), by {@link reporterDetached} and by {@link dispose}.
   */
  private armHandoverCeiling(reporterId: string, record: ReporterRecord): void {
    this.clearHandoverTimer(record);
    if (record.attachment === null) return;
    record.cancelHandoverTimer = this.options.clock.schedule(
      ATTACH_HANDOVER_CEILING_MS,
      () => {
        record.cancelHandoverTimer = null;
        // Every path that consumes or ends the generation clears this timer synchronously, so firing means the issuance is still unclaimed; the attachment check covers an identity transition that already retired it in between.
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
   * The guard both attach paths share (module header rule 6).
   * A non-latest or already-consumed seq is state-neutral - it never touches the live attachment.
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
   * Assigns a host's session its observation ordinal the first time the reporting incarnation names it - from an attach inventory, a session transition, or a compat verdict naming it.
   * Scoped to the attachment because `sessionId` is only unique within an incarnation (contract, {@link SelectionSessionEvidence}).
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
   * An unknown one is only minted as current when the reporter still holds that session live - otherwise it is a verdict for a session this incarnation no longer tracks, and it ranks at the evicted floor.
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

  /** Whether any window currently holds a live session for the host. */
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
   * Arms B1's corpse ceiling when the host the app is pointed AT just lost its last session (C6).
   * B1's harm is specifically *"the app looks healthy while pointed at a machine that is not answering"*, which only the effective host can do.
   */
  private armPostSessionCeilingIfPointedAt(hostId: string): void {
    if (this.selection.effectiveHostId !== hostId) return;
    if (this.hasLiveSession(hostId)) return;
    const evidence = this.hostEvidence(hostId);
    if (evidence.effectiveSessionLostAt !== null) return;
    evidence.effectiveSessionLostAt = this.options.clock.now();
  }

  /**
   * Retires a reporter's attachment and arms the corpse ceiling for every host whose sessions it was holding - the same arming `ingestSession`'s `lost` transition performs, for the paths that drop sessions without one.
   * Arming after the attachment is nulled, so `hasLiveSession` reflects the loss.
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
   * Firsthand proof of life (a dial success, or a session appearing) clears the host's death streak and closes any restart episode: the outage the episode was holding for is over.
   * Ingestion calls this before it commits, so the same transaction that records the proof re-derives with the cooldown already gone.
   */
  private onHostProvedAlive(hostId: string): void {
    const evidence = this.hostEvidence(hostId);
    // The latch, set at the one funnel every proof kind already passes
    // through, so no producer has to remember it separately.
    evidence.provedAliveAtLeastOnce = true;
    evidence.refusalStreak = 0;
    evidence.planRestrictedRefusalObserved = false;
    evidence.planRestrictedUntil = null;
    evidence.restartEpisodeEndsAt = null;
    // The dial-stall counter retires with the streak, and here rather than only on a dial success, because this is the single funnel every kind of proof already passes through.
    this.dialStalls.delete(hostId);
    // Proof of life is proof of life: it retires the corpse deadline for the same reason it clears the streak.
    // This is the only producer that needs to know about the deadline, because every kind of proof already funnels through here - a dial success, a session appearing, an announcement, and a successful ensure.
    evidence.effectiveSessionLostAt = null;
    if (hostId !== this.fleet.localHostId) return;
    // Bumped before the clear so an ensure still in flight can tell that its
    // own failure - whenever it lands - post-dates this moment.
    this.localProofGeneration += 1;
    this.localEnsureFailedUntil = null;
    // The pacing hold goes with it: a host that just proved alive has no pending need the hold was protecting, and if it dies again the next request should not inherit a wait armed against a lock long released.
    this.localEnsureRetryHoldUntil = null;
  }

  private ingestDial(
    attachment: AttachmentRecord,
    report: Extract<SelectionEvidenceReport, { kind: "dial" }>,
  ): void {
    const hostId = report.hostId;
    if (this.dropsAsOutsideFleet(hostId, report.kind)) {
      this.recordDialDisposition(report, "dropped-outside-fleet");
      return;
    }
    const key = attemptKey(attachment.incarnationId, report.attemptId);
    if (attachment.seenAttemptIds.has(key)) {
      this.recordDialDisposition(report, "dropped-duplicate-attempt");
      return;
    }
    attachment.seenAttemptIds.add(key);
    if (report.outcome === "success") {
      this.onHostProvedAlive(hostId);
      this.recordDialDisposition(report, "cleared-by-success");
      return;
    }
    // `indeterminate` is inert by contract: a liveness-read failure or an
    // attempt abandoned for unrelated reasons is not evidence about the host.
    if (report.outcome === "indeterminate") {
      this.recordDialDisposition(report, "inert-indeterminate");
      return;
    }
    const evidence = this.hostEvidence(hostId);
    const now = this.options.clock.now();
    if (
      report.outcome === "confirmed-refusal" &&
      report.refusalDetail === "plan-restricted"
    ) {
      evidence.planRestrictedRefusalObserved = true;
      evidence.refusalStreak = 0;
      // Every non-duplicate refusal is fresh authenticated evidence from the physical session that just failed.
      // Replace the prior deadline even while it is active so authority, negative cache and owner rebuild all describe the latest denial rather than an older identity's window.
      evidence.planRestrictedUntil = now + PLAN_RESTRICTED_REPROBE_MS;
    }
    if (this.hasLiveSession(hostId)) {
      // Recorded for diagnostics, never accumulated: a live session anywhere in the app outranks every other evidence class (invariant 5).
      // The streak resumes only once the session set for this host empties.
      this.recordDialDisposition(report, "suppressed-live-session");
      return;
    }
    const planRestrictionActive =
      evidence.planRestrictedRefusalObserved &&
      evidence.planRestrictedUntil !== null &&
      now < evidence.planRestrictedUntil;
    if (
      report.outcome === "confirmed-refusal" &&
      report.refusalDetail === "plan-restricted"
    ) {
      this.recordDialDisposition(report, "suppressed-plan-restriction");
      return;
    }
    if (planRestrictionActive) {
      this.recordDialDisposition(report, "suppressed-plan-restriction");
      return;
    }
    evidence.refusalStreak += 1;
    this.recordDialDisposition(
      report,
      // Equality, not `>=`: this names the one report that crossed, which is what a reader is looking for.
      evidence.refusalStreak === CONFIRMED_DEATH_REFUSAL_STREAK
        ? "counted-reached-death"
        : "counted",
    );
  }

  /** The single exit every dial report leaves by, and the whole instrumentation of this path. */
  private recordDialDisposition(
    report: Extract<SelectionEvidenceReport, { kind: "dial" }>,
    disposition: DialDisposition,
  ): void {
    const hostId = report.hostId;
    const streakAfter = this.evidence.get(hostId)?.refusalStreak ?? 0;
    this.options.log.debug("[selection-authority] dial evidence", {
      hostId,
      disposition,
      outcome: report.outcome,
      transportKind: report.transportKind,
      attemptId: report.attemptId,
      refusalStreak: streakAfter,
      deathThreshold: CONFIRMED_DEATH_REFUSAL_STREAK,
    });
    // Evidence for a host outside the fleet is dropped, so there is no stall to track: this host has no lease to strand a surface on.
    // The re-registered host would then inherit a stall it never earned and warn early.
    if (disposition === "dropped-outside-fleet") {
      this.dialStalls.delete(hostId);
      return;
    }
    // A success is proof of life and a counted refusal is progress toward a verdict; either way the authority learned something, so the stall ends.
    // Keyed off the report's outcome rather than the disposition alone, because a success that arrives twice is classified `dropped-duplicate-attempt` before its outcome is ever examined.
    if (
      report.outcome === "success" ||
      dispositionCounts(disposition) ||
      disposition === "suppressed-plan-restriction"
    ) {
      this.dialStalls.delete(hostId);
      return;
    }
    const stalled = (this.dialStalls.get(hostId) ?? 0) + 1;
    this.dialStalls.set(hostId, stalled);
    // Exactly at the crossing, not `>=`.
    if (stalled !== CONFIRMED_DEATH_REFUSAL_STREAK) return;
    this.options.log.warn(
      "[selection-authority] dial failures are not advancing the death streak",
      {
        hostId,
        disposition,
        outcome: report.outcome,
        transportKind: report.transportKind,
        consecutiveNonCounting: stalled,
        refusalStreak: streakAfter,
        deathThreshold: CONFIRMED_DEATH_REFUSAL_STREAK,
      },
    );
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
      // `lost` before `established` (reordered delivery): tombstone the id so the late `established` cannot resurrect a session that is already gone.
      // Both are dropped; the session never counts as live.
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
    // A verdict probed on a session the authority observed later supersedes every earlier one; equal rank means the same session, where latest-received wins.
    // Order only when both sides name A session.
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
    // First receipt anchors one fixed episode; every duplicate - another window observing the same tombstone, a liveness-plane replay - is ignored outright and can never extend it (mechanism 7).
    const seen = this.seenTombstoneIds.get(report.hostId) ?? new Set<string>();
    if (seen.has(report.tombstoneId)) return;
    seen.add(report.tombstoneId);
    this.seenTombstoneIds.set(report.hostId, seen);
    const evidence = this.hostEvidence(report.hostId);
    // `expiresAt` on the report is the host's clock and is display-only; the
    // deadline is the authority's own ceiling.
    evidence.restartEpisodeEndsAt =
      this.options.clock.now() + RESTART_INTENT_EPISODE_MS;
  }

  // ------------------------------------------------------------------ ports

  private applyFleetSnapshot(
    snapshot: HostFleetSnapshot,
    /**
     * Required, and deliberately not defaulted.
     * Making every caller say which it is stops the next one from inheriting a meaning it never chose.
     */
    source: "seed" | "published",
  ): void {
    if (snapshot.identityGeneration !== this.identityGeneration) {
      // Revision orders observations; the generation establishes membership.
      // A late account-A fetch completing after account B became current is rejected here no matter how high its revision is (§3b).
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
   * Deregistering it while the app runs and finding it already gone at startup both land here, and both clear to null so nothing can re-assert a stale id.
   * An empty fleet never triggers it.
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
   * NO empty-fleet guard, deliberately - the asymmetry with {@link clearPreferredOutsideFleet} four lines below is the considered answer rather than an oversight, and it has been filed as a defect once already.
   */
  private pruneEvidenceOutsideFleet(): void {
    const present = new Set(this.fleet.hosts.map((entry) => entry.hostId));
    for (const hostId of Array.from(this.evidence.keys())) {
      if (!present.has(hostId)) this.evidence.delete(hostId);
    }
    for (const hostId of Array.from(this.seenTombstoneIds.keys())) {
      if (!present.has(hostId)) this.seenTombstoneIds.delete(hostId);
    }
    for (const hostId of Array.from(this.dialStalls.keys())) {
      if (!present.has(hostId)) this.dialStalls.delete(hostId);
    }
  }

  /**
   * The other half OF {@link pruneEvidenceOutsideFleet}, and it is not optional: the prune alone cannot hold, because the clear is a moment and the probes it clears after are still in flight.
   * A compatibility probe or a restart notification issued while a host was a member lands after it is deregistered.
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

  private runIdentityTransition(outgoingIdentityKey: string | null): void {
    // G1: sign-out wipes the preference rather than merely scoping it, so a shared machine cannot show the previous user's host choice back to them, and the incoming account inherits nothing.
    // Persistence exists to survive a restart, not a user switch.
    this.options.preferredStore.save(outgoingIdentityKey, null);
    this.preferredHostId = this.options.preferredStore.load(this.identityKey);
    this.mruEffectiveHostIds.length = 0;
    // The cold-start hold's window belongs to the identity that armed it; the incoming account's first boot measures its own.
    this.coldStartHold = null;
    for (const record of this.reporters.values()) {
      // Generation high-waters survive (rule 4); only the attachment dies - and with it any handover ceiling that was waiting to retire it.
      record.attachment = null;
      this.clearHandoverTimer(record);
    }
    this.evidence.clear();
    this.seenTombstoneIds.clear();
    this.dialStalls.clear();
    this.nextSessionOrdinal = 0;
    // The local expected-outage hold is port state, not evidence: the HostController mutation lane does not stop being in flight because the signed-in user changed.
    this.localOutageStartedAt = this.options.localOutage.inExpectedOutage()
      ? (this.localOutageStartedAt ?? this.options.clock.now())
      : null;
    const available = this.options.fleet.snapshot();
    this.fleet =
      available.identityGeneration === this.identityGeneration
        ? available
        : emptyFleet(this.identityGeneration);
    // The answer does not survive the account.
    // What the port told us about A's hosts says nothing about B's, so B starts having answered nothing and the adopted fleet is read on the same rule as the construction seed: it is an answer only if it already names hosts.
    this.hasFleetAnswer = this.fleet.hosts.length > 0;
    // The matching snapshot, when it arrives, must still be applicable: the adapter's revision is process-lifetime monotonic, so leaving the high-water where it is only rejects observations we already applied.
    if (this.fleet.revision > this.appliedFleetRevision) {
      this.appliedFleetRevision = this.fleet.revision;
    }
    // F14 also applies here, and used to be missed.
    const cleared = this.clearPreferredOutsideFleet();
    // The engine's damping state describes the outgoing account's hosts.
    this.usableSince.clear();
    this.pendingDampingDeadline = null;
    this.localEnsureFailedUntil = null;
    this.localEnsureRetryHoldUntil = null;
    // Retire the outgoing account's in-flight ensure so the incoming identity may ask for its own.
    this.localEnsureToken = null;
    this.localEnsureExpiresAt = null;
    // The outgoing selection IS not AN incumbent for the incoming identity.
    this.selection = EMPTY_SELECTION;
    // One transaction: the state batch is staged first and the trigger after it, so the trigger's revision is strictly above every event of the commit it follows - then both are delivered in that order.
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
   * Nothing here waits, retries or debounces: it answers "given what is known right now, which host serves this app".
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
      now,
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

  /** Where derivation wants to be, before damping decides whether it may move there yet. */
  private deriveDesiredEffective(
    targetHostId: string | null,
    localHostId: string | null,
    leases: readonly HostLeaseSnapshot[],
    now: number,
  ): string | null {
    // The D5/M6 hold, and the reason derivation is no longer a pure function of the leases alone.
    // AT full (unbounded) strength only for A host this process has actually reached.
    const effectiveHostId = this.selection.effectiveHostId;
    const restartingIncumbentHostId =
      effectiveHostId !== null &&
      this.leaseFor(effectiveHostId, leases)?.status === "restarting-expected"
        ? effectiveHostId
        : null;
    if (
      restartingIncumbentHostId !== null &&
      this.hasProvedAliveAtLeastOnce(restartingIncumbentHostId)
    ) {
      this.coldStartHold = null;
      return restartingIncumbentHostId;
    }
    // The cold-start hold: a restarting host worth waiting for, but only for a bounded window, because nothing has proved it can serve anyone.
    // It narrates as cold-start too (an effective host that has never served this window).
    const targetAwaitedHostId =
      targetHostId !== null &&
      targetHostId === localHostId &&
      this.leaseFor(targetHostId, leases)?.status === "restarting-expected"
        ? targetHostId
        : null;
    const awaitedHostId = restartingIncumbentHostId ?? targetAwaitedHostId;
    if (awaitedHostId === null) {
      this.coldStartHold = null;
    } else if (
      this.coldStartArmApplies(restartingIncumbentHostId) &&
      this.holdsForColdStart(awaitedHostId, now)
    ) {
      // An incumbent keeps serving as itself; the target arm can only have been reached from ∅, so its null stays at ∅ rather than taking anything away, and the startup card narrates the boot.
      return restartingIncumbentHostId !== null ? awaitedHostId : null;
    }
    // Ceiling lapsed: the boot is no longer something to wait for, and the
    // arms below pick a fallback exactly as they did before this hold existed.
    if (targetHostId !== null && this.isUsable(targetHostId, leases)) {
      return targetHostId;
    }
    if (localHostId !== null && this.isUsable(localHostId, leases)) {
      return localHostId;
    }
    return this.mostRecentlyEffectiveUsableRemote(localHostId, leases);
  }

  /**
   * M6.
   * Whether the engine may adopt `desired` now, or must keep serving what it has until that candidate has proved itself.
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
    // `desired` came out of candidate enumeration over usable hosts, so it has a stability mark; `now` only stands in for the impossible case, where it reads as "became usable this instant" and holds the move.
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
    // Held back.
    // Recorded so the deadline timer can bring the move in with no further evidence - without it a target that came back and then went quiet would never be returned to.
    this.pendingDampingDeadline = admissibleAt;
    return effectiveHostId;
  }

  /** Whether this host has ever answered this process. */
  private hasProvedAliveAtLeastOnce(hostId: string): boolean {
    return this.evidence.get(hostId)?.provedAliveAtLeastOnce === true;
  }

  /**
   * Whether this pass may wait at all - the policy half, kept apart from the "who is cycling" half so the hold record can outlive a pass that declines.
   * - never after derivation has named one, because ∅ is not narrated the same way twice.
   */
  private coldStartArmApplies(
    restartingIncumbentHostId: string | null,
  ): boolean {
    if (restartingIncumbentHostId !== null) return true;
    return (
      this.selection.effectiveHostId === null &&
      this.mruEffectiveHostIds.length === 0
    );
  }

  /**
   * Whether the cold-start hold may still wait on `hostId`, arming or re-keying its window as a side effect.
   */
  private holdsForColdStart(hostId: string, now: number): boolean {
    const hold = this.coldStartHold;
    const startedAt =
      hold !== null && hold.hostId === hostId ? hold.startedAt : now;
    this.coldStartHold = { hostId, startedAt };
    return now < startedAt + COLD_START_LOCAL_RESTART_HOLD_CEILING_MS;
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
        // The local host reads `connecting` right now because the engine asked for it, not because anything observed it - so it accrues no stability while that request is outstanding.
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
   * Whether this host reads usable only because the engine's own ensure for it is in flight - the in-flight arm of `deriveLease`, minus its live-session exception.
   * Read by the damping's incumbent check: such a host is a candidate (so ∅ never shows while it boots) but not something to keep serving a window from against a target that can.
   */
  private isHeldOnlyByOwnEnsure(hostId: string): boolean {
    return (
      this.localEnsureToken !== null &&
      this.localEnsureToken.hostId === hostId &&
      !this.hasLiveSession(hostId)
    );
  }

  /** The third arm. */
  private mostRecentlyEffectiveUsableRemote(
    localHostId: string | null,
    leases: readonly HostLeaseSnapshot[],
  ): string | null {
    // B3's eligibility half.
    // `isUsableForSelection` answers on lease status alone, so it cannot tell "proved compatible" from "never asked" - both derive as `connecting`, which is usable.
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
   * Absence means "never asked", never "assumed fine" - which is the whole distinction B3 turns on.
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
   * B1/C6, the reselection half of the corpse ceiling.
   * The authority-owned exit the ceiling exists to provide would never fire, and the app would sit on that host with no bound at all.
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
   * The one sanctioned process action (D14/C5), and the causal fix for the audit's F4.
   * The engine may ask for it, and only it may: the registry still never drives processes.
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
      // The third conjunct is the never-dialed arm's guard (F3(c)): a never-dialed host draws an ensure only while the outage signal is false at request time.
      // Widening to never-dialed made two arms overlap that never could before.
      return false;
    }

    // Deliberately NO "is the target serving?" gate here - see the doc above.
    const cooldownUntil = this.localEnsureFailedUntil;
    if (cooldownUntil !== null && now < cooldownUntil) return false;
    const retryHoldUntil = this.localEnsureRetryHoldUntil;
    if (retryHoldUntil !== null && now < retryHoldUntil) return false;
    this.localEnsureFailedUntil = null;
    this.localEnsureRetryHoldUntil = null;
    // Stamped with the identity and host that wanted it: a completion arriving after an account switch describes a fleet this engine no longer has, and must not be able to speak for whatever is running now.
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
   * The ensure outcome, surfaced only as the local lease's state (registry §5) - the port itself carries no state anyone can read, so no surface can grow a second opinion about provisioning.
   */
  private completeLocalEnsure(
    token: LocalEnsureToken,
    ok: boolean,
    reason: string,
    deferred: boolean,
  ): void {
    if (this.disposed) return;
    if (this.localEnsureToken !== token) {
      // Not the request the engine is waiting on - the account changed and the transition retired it, or a newer request superseded it.
      // State-neutral by construction: it must not clear a live token (which would let a second ensure start while the first is still running) and it must not commit (which would publish an answer about a fleet that is gone).
      this.options.log.debug("[selection-authority] stale ensure dropped", {
        hostId: token.hostId,
        generation: token.generation,
      });
      return;
    }
    if (token.hostId !== this.fleet.localHostId) {
      // The local host changed under the request (A -> B), within one identity.
      // - failure would arm `localEnsureFailedUntil`, so a provisioning run that was about A gates B - which derives B `dead` and puts ∅ in front of a user whose new local host was never asked for at all.
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
      // Firsthand proof of life, and legitimately so under invariant 5: this is not a cloud DTO but the desktop's own provisioning controller reporting that it converged the host to ready, in-process.
      // Without it the stale refusal streak would keep the lease `dead` until something happened to dial the host - and while a remote is serving, nothing would.
      this.onHostProvedAlive(token.hostId);
      // F5: stability starts AT proof OF life, not at the request.
      this.usableSince.delete(token.hostId);
    } else if (this.localProofGeneration !== token.proofGeneration) {
      // The host proved alive while this request was running (a dial answered at t+3s, this failure landing at t+5s).
      // Arming the cooldown here would undo `onHostProvedAlive`'s clear and re-deaden a host that has since answered - a completion is the newest word only about a world nothing else has spoken about since.
      this.options.log.debug(
        "[selection-authority] ensure failure post-dates proof of life",
        { hostId: token.hostId, reason },
      );
    } else if (deferred) {
      // Nothing ran, so nothing was learned about the host: pace the next request (the lane's current owner is typically doing this very converge) but leave the lease alone.
      // Only a failure that actually provisioned and lost may arm the dead-verdict cooldown below.
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
   * One host's verdict.
   * `incompatible` first (C4/D13): compatibility is a handshake verdict, not a transport property - such a host dials and may hold a live socket, and is still unusable for selection.
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
      // A live session answers from inside this arm, and it answers `ready`.
      // A session is firsthand proof of service (invariant 5) and outranks the engine's own busywork; when the converge later stops the host for a swap, the session drops and this arm's non-committal answer below resumes.
      if (this.hasLiveSession(hostId)) {
        return { hostId, status: "ready", dead: null };
      }
      // The engine's own provisioning request is in flight (D14).
      // Why nothing stamped ON the token can refine this (F3 completion, and a refuted design - do not rebuild it).
      return { hostId, status: "connecting", dead: null };
    }
    if (this.inExpectedOutage(hostId, isLocal, now)) {
      return { hostId, status: "restarting-expected", dead: null };
    }
    if (this.hasLiveSession(hostId)) {
      return { hostId, status: "ready", dead: null };
    }
    if (isLocal && this.localEnsureFailedAt(now)) {
      // "The ensure path is unavailable or has failed" (registry §5), as lease state - which is what makes the ∅ definitions one.
      // Hence the clear, rather than a rule about which arm wins.
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
      // B1/C6.
      return { hostId, status: "dead", dead: { reason: "offline" } };
    }
    if (
      evidence !== null &&
      ((evidence.planRestrictedRefusalObserved &&
        evidence.planRestrictedUntil !== null &&
        now < evidence.planRestrictedUntil) ||
        evidence.refusalStreak >= CONFIRMED_DEATH_REFUSAL_STREAK)
    ) {
      return {
        hostId,
        status: "dead",
        dead: {
          reason:
            evidence.planRestrictedRefusalObserved &&
            evidence.planRestrictedUntil !== null &&
            now < evidence.planRestrictedUntil
              ? "plan-restricted"
              : "offline",
        },
      };
    }
    return { hostId, status: "connecting", dead: null };
  }

  /**
   * No evidence has ever been reported for this host - nothing dialed it, no session announced, no compat verdict.
   * Distinct from "reported nothing bad": a successful dial creates a record with a zero streak, so a host that once answered is never never-dialed again.
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

  /** Next moment a lease would change with no new evidence - without this it would stay `restarting-expected` until something else arrived. */
  /** Retire an in-flight ensure that passed its ceiling into the same terminal state a failed ensure reaches. No separate expired flag - a late completion cannot tell. */
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
      const evidence = this.evidence.get(entry.hostId);
      const endsAt = evidence?.restartEpisodeEndsAt;
      if (endsAt !== undefined && endsAt !== null) consider(endsAt);
      const planRestrictedUntil = evidence?.planRestrictedUntil;
      if (planRestrictedUntil !== undefined && planRestrictedUntil !== null) {
        consider(planRestrictedUntil);
      }
      if (entry.kind === "local" && this.localOutageStartedAt !== null) {
        consider(this.localOutageStartedAt + LOCAL_EXPECTED_OUTAGE_CEILING_MS);
      }
    }
    // A damped move completes on time, not on evidence: the target came back and then went quiet, which is the normal shape of a recovery.
    // Without this the return-to-target window would only ever be checked when some unrelated report happened to arrive.
    const damping = this.pendingDampingDeadline;
    if (damping !== null) consider(damping);
    // The cold-start hold's own ceiling: its lapse is what un-sticks the startup screen when the boot outlives the wait, and on a quiet engine no report is coming to re-derive it - the same shape as the damping deadline above.
    const coldStartHold = this.coldStartHold;
    if (coldStartHold !== null) {
      consider(
        coldStartHold.startedAt + COLD_START_LOCAL_RESTART_HOLD_CEILING_MS,
      );
    }
    // A failed ensure holds the local lease dead for a cooldown; the lapse is a lease change with no new evidence behind it, and it is what lets the engine ask again.
    const ensureCooldown = this.localEnsureFailedUntil;
    if (ensureCooldown !== null) consider(ensureCooldown);
    // A deferred ensure's pacing hold changes no lease, but its lapse re-enables the request the next derivation would make - and on a quiet engine nothing else wakes that derivation up.
    const ensureRetryHold = this.localEnsureRetryHoldUntil;
    if (ensureRetryHold !== null) consider(ensureRetryHold);
    // An ensure still running holds the local lease usable, so its ceiling is a lease change with no new evidence behind it - the same shape as the cooldown above, and the arm whose absence was B2.
    const ensureCeiling = this.localEnsureExpiresAt;
    if (ensureCeiling !== null) consider(ensureCeiling);
    // B1/C6's corpse ceiling.
    // Without this arm nothing wakes the engine after the session drops - which is the whole defect: the path has no producer, so there is no incoming report to derive from either.
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
   * Commit and delivery are separate steps, and that separation is load-bearing rather than stylistic.
   */
  private commit(cause: SelectionChangeCause): void {
    this.stage(cause);
    this.drain();
  }

  /**
   * Mutates state and queues the transaction's events.
   * Delivers nothing, so a caller that must seal a result against re-entrancy (see `attach`) can read its snapshot between staging and draining.
   */
  private stage(cause: SelectionChangeCause): void {
    // Leases first: derivation is a function of them, so computing the selection off the previously-emitted set would answer one transaction late.
    // Emission order is still selection-then-leases (consecutive revisions), so a client never sees leases for a selection it has not been told about.
    const now = this.options.clock.now();
    // Before any derivation this pass: an ensure past its ceiling must not
    // still be reporting `connecting` into the leases computed below (B2).
    this.expireLocalEnsureIfLapsed(now);
    // Two passes, because the two answers depend on each other: the ensure decision needs the leases to know whether the local host is down, and the leases then need to reflect that a request is in flight.
    // Deriving twice is cheap (a map over the fleet) and keeps both answers from the same instant; the alternative - deciding ensure from raw evidence - would duplicate the arm order that IS the evidence hierarchy.
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

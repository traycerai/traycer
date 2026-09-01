import type {
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  imageResolutionEntriesEqual,
  type ImageWitnessStore,
} from "@/stores/chats/image-witness-store";
import type {
  ChatIndexChange,
  ChatRangeResponse,
  ChatSkeletonChunk,
  ChatTranscriptWindow,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import { recordByteLength } from "@traycer/protocol/persistence/chat-transcript/record-bytes";
import {
  assistantRowId,
  assistantRowTurnKey,
  chatTranscriptEventRowId,
  forkedChatLinkRowId,
  isTurnDecoratingEvent,
  projectTranscriptRows,
  queueSteerRowId,
  type TranscriptRowDescriptor,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import { rowRecordIds } from "@traycer/protocol/persistence/chat-transcript/read-range";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { TranscriptRowContext } from "@traycer/protocol/persistence/chat-transcript/row-context";
import { utf8ByteLength } from "@traycer/protocol/utils/text/utf8";
import { assistantTurnKey } from "@traycer/protocol/persistence/chat-transcript/fork-boundary";
import { isTransientLiveAssistantMessageId } from "@/lib/chat/transient-live-assistant-message-id";

/**
 * # The client half of the windowed transcript
 *
 * The host serves a chat as a bounded snapshot, a row SKELETON streamed in
 * chunks, and RANGES of bodies fetched on demand. This module is what holds
 * that on the client: the skeleton for the whole session, whichever spans of
 * bodies are currently hydrated, and the arithmetic that decides what to
 * request and what to throw away.
 *
 * Deliberately a pure module rather than a zustand store. Every operation is a
 * `(window, frame) -> window` fold, so the interesting behaviour - identity
 * checks, eviction order, what a `reindexed` costs - is testable without a
 * renderer, and the session store holds one of these in state like any other
 * value. A store here would put React in the way of the part that needs the
 * most testing.
 *
 * ## The coordinate is `(epoch, ordinal)`, and the row id is the check
 *
 * An ordinal is an index into the projection the host published. It is stable
 * only under one epoch, and it is never trusted on its own: every hydration
 * response carries the ROW IDS it served, and those are matched against the
 * skeleton before a body is seated. That check is what makes a missed
 * invalidation cost a wasted round trip instead of bodies rendered under the
 * wrong rows - a failure that looks like a subtly shuffled chat and is silent.
 *
 * ## What this module does NOT do
 *
 * It does not fold rows. The renderer's `useRenderedMessages` does that, from
 * the records this hands it, and `row-projection-equivalence.test.tsx` is what
 * pins the two enumerations to the same list. Adding a second fold here would
 * be a third implementation of the same rules.
 */

/**
 * A contiguous run of hydrated rows.
 *
 * `messageIds`/`eventIds` are REFERENCES into the window's record ledger
 * ({@link RecordLedger}), the deduplicated union of the records these rows
 * render from - not a parallel array to `rowIds`: one folded assistant turn is
 * many rows and one record set, and the steer bubbles between its slices share
 * it. The span holds ids rather than record objects because the same record
 * routinely sits in several spans ({@link SPAN_MERGE_MAX_BYTES} means a turn's
 * slices are not always merged), and every defect class that motivated the
 * ledger - double-charged bytes, per-holder rewrites, position-vs-body dedupe -
 * came from those copies being allowed to diverge. Single ownership makes
 * divergence unrepresentable.
 *
 * A span carries NO byte figure and NO clocks of its own. Its charge and its
 * warmth are DERIVED from the ledger records it references (see
 * {@link derivedSpanBytes} and {@link spanDraws}), so a streaming rewrite
 * touches one ledger entry and every span referencing it reads the new truth -
 * no per-holder re-measure, and no retained figure to go stale.
 */
export interface HydratedSpan {
  readonly fromOrdinal: number;
  /** One row id per row served, in order. Its length is the span's extent. */
  readonly rowIds: readonly string[];
  /**
   * What these rows render WITH, by row id - the host's answer to derivations
   * this client cannot make from a bounded subset (`row-context.ts`).
   *
   * Held per SPAN rather than per window so it is evicted with the rows it
   * describes: a window-level map would outlive them and grow for the life of
   * the tab, which is the shape of a bug this file already carries one of.
   *
   * Sparse by construction - only rows with something to say appear.
   */
  readonly rowContext: Readonly<Record<string, TranscriptRowContext>>;
  /** Ledger references, in transcript order. See the interface doc. */
  readonly messageIds: readonly string[];
  readonly eventIds: readonly string[];
  /**
   * What {@link rowContext} alone costs, measured once.
   *
   * The one byte figure that stays PER SPAN, deliberately: two spans sharing a
   * turn's records legitimately hold different context maps, so the structural
   * charge is not aliased and needs no dedupe. It is immutable for a span's
   * life - written only where a span is BUILT (a range response, the snapshot
   * tail) or MERGED, never by record rewrites - so retaining it cannot go
   * stale the way a retained record figure could.
   */
  readonly contextBytes: number;
}

/**
 * One record's ledger entry: the single owned copy plus its clocks and charge.
 *
 * `bytes` is the SETTLED measure. A streaming rewrite may leave it stale by
 * design - {@link TranscriptWindow.unsettledByteMessageIds} records the debt,
 * and {@link settleWindowBytes} re-measures here, once, instead of once per
 * holding span as the retired `resettledSpanBytes` did.
 *
 * `servedAt` is the window `clock` at which the HOST last served this body;
 * `touchedAt` is the clock of its last read or write. Both are per-RECORD
 * rather than per-span because every span-level copy of them was an aggregate
 * over records that a viewport report and a streamed rewrite both wrote to -
 * the tie factory the warmth findings kept rediscovering. A span's warmth and
 * serve recency are now derived (max over the records it DRAWS), so bumping a
 * record once warms every span drawing it identically, and a span holding a
 * record only as a rider inherits nothing from it.
 */
interface LedgerRecordEntry<T> {
  readonly record: T;
  readonly bytes: number;
  readonly servedAt: number;
  readonly touchedAt: number;
}

/**
 * The window's single-ownership record store - class E's spine.
 *
 * Spans reference records by id; this holds the one copy of each. An entry
 * exists exactly while some span (fresh or stale) references it - live records
 * stay in {@link TranscriptWindow.liveMessages}/`liveEvents`, which predate
 * placement and are not aliased - and {@link pruneUnreferencedRecords} is the
 * reference-counted release: evicting a span never un-charges a record another
 * span still references.
 *
 * `revision` is the cache-key half the spans array cannot carry: it moves on
 * MEMBERSHIP changes and on serve stamps (both structural moments), and
 * deliberately NOT on in-place content rewrites or warmth bumps - so a memo
 * keyed on (spans array, revision) survives every streaming token, which is
 * the per-token protection `transcript-list-rows.ts` is arranged around, while
 * a merge that changes what a span's records can back still invalidates.
 */
export interface RecordLedger {
  readonly messages: ReadonlyMap<string, LedgerRecordEntry<Message>>;
  readonly events: ReadonlyMap<string, LedgerRecordEntry<ChatEvent>>;
  readonly revision: number;
}

export interface TranscriptWindow {
  readonly epoch: number;
  readonly rowCount: number;
  /**
   * Skeleton entries by ordinal, SPARSE while chunks are still streaming.
   *
   * A hole is "not delivered yet", never "no such row" - `rowCount` is the
   * authority on length. Consumers must treat a hole as an unknown row rather
   * than as the end of the transcript.
   */
  readonly skeleton: readonly (RowSkeletonEntry | undefined)[];
  /** Set by the chunk carrying `isFinal`, once its length agrees with `rowCount`. */
  readonly skeletonComplete: boolean;
  /**
   * Exclusive end of the contiguous prefix the CURRENT skeleton stream has
   * delivered, counted from ordinal 0.
   *
   * Completeness has to be answered per STREAM, and the merged `skeleton` array
   * cannot answer it. A rebuild re-streams the whole skeleton into the array
   * the previous one left, so a dropped chunk of the REPLACEMENT stream is
   * filled by the entries already sitting at those ordinals: the array has no
   * holes, `coversEveryOrdinal` succeeds, and the client declares a delivery
   * complete whose missing chunk carried the very `updated` metadata it needed.
   * The stale entries - and the bodies they vouch for - then survive the whole
   * connection.
   *
   * A contiguous prefix is sufficient because the producer chunks the whole
   * skeleton from ordinal 0 in order (`chunkRowSkeleton` over `view.skeleton`),
   * so "the stream reached `rowCount` without a gap" is exactly the question,
   * and it costs one comparison per chunk rather than a scan.
   *
   * Reset to 0 wherever a new stream begins: a rebase, a void index, and the
   * `indexRevision === null` rebuild boundary.
   */
  readonly skeletonStreamCoveredThrough: number;
  /**
   * The host index revision this window's skeleton reflects, within its epoch.
   *
   * The ONLY signal that an `updated`-only index delta was lost. That frame
   * moves neither the epoch (an update renumbers nothing) nor `rowCount` (it
   * adds no row), so the append-count detector below cannot see it and a
   * later same-epoch snapshot retains the skeleton rather than restreaming it.
   * The result was a superseded body rendered indefinitely - and a VISIBLE
   * row's span is protected from eviction, so nothing refetched it either.
   */
  readonly indexRevision: number;
  /**
   * Whether the next CONCRETE revision may legitimately be lower than the held
   * one - i.e. whether a rebuild boundary has been crossed since it was set.
   *
   * ## Why the direction of a revision is not self-describing
   *
   * `indexRevision` is continuous within one host-side index, and the client
   * leans on that twice: a revision that skips means a delta was lost, and a
   * revision at or below the held one means a duplicate or a straggler
   * (`applyIndexChange`). Both readings assume the counter this client holds
   * and the counter the host is sending from are the SAME counter.
   *
   * A rebuild is exactly where they stop being the same. The counter is
   * per-VIEW - `TranscriptViewCache` starts `epoch = 0, indexRevision = 0` and
   * advances the epoch only when `rowIdsPreserveOrdinals` fails BETWEEN TWO
   * READS of one instance, so a fresh instance's first read never advances it.
   * A host restart therefore hands a chat that has never been reindexed a fresh
   * counter at the SAME epoch, which is not a rebase: the client keeps its
   * window (it resets one only for a fresh store or the windowed->legacy
   * downgrade) and the host's revision is genuinely below the one held.
   *
   * Without this flag one assignment has to serve two opposite cases, and it
   * gets one of them wrong whichever way it is written:
   *
   * - adopt the lower number, and a REORDERED older snapshot rewinds a valid
   *   index, so the host's next delta is misclassified as a gap and voids it;
   * - refuse it, and after a restart every delta the fresh host sends is at or
   *   below the held revision, so `applyIndexChange` discards each one until
   *   the host's counter climbs past a number it knows nothing about.
   *
   * ## The boundary is announced, and the host guarantees it
   *
   * `chat-session-manager.ts:34710-34717` stamps a snapshot's revision as
   * `subscriber.windowedIndex.state.kind === "held" ? state.indexRevision
   * : null`. A restart necessarily meets a FRESH subscriber, whose state is not
   * `held` - so every full-skeleton restream is announced by `null` before any
   * concrete revision, and a concrete revision only ever rides a frame to a
   * subscriber the host already believes is in sync. That makes `null` a sound
   * discriminator rather than a heuristic: armed here, the first concrete
   * revision from EITHER applier is adopted as the new baseline whatever its
   * direction, and disarms the flag.
   *
   * Armed at construction, at every rebase, and at every void, because each of
   * those is a client with no counter it can trust yet.
   *
   * ## What this does NOT defend
   *
   * A reordered snapshot is only reachable because the snapshot's byte bound is
   * unenforced: `windowedSnapshotFitsFrame` exists and no producer calls it, so
   * an oversized snapshot can cross `BULK_QOS_BODY_THRESHOLD_BYTES` and be
   * reclassified onto the bulk lane, where it can pass an interactive delta.
   * Enforcing that bound is the host's job. This guard is not belt-and-braces
   * for it: a client talks to hosts older than any such fix, so the skew
   * defense has to live here regardless.
   */
  readonly indexRevisionRebuilding: boolean;
  /**
   * The single owned copy of every span-referenced record. See
   * {@link RecordLedger}; spans hold ids into it.
   */
  readonly records: RecordLedger;
  /** Disjoint and sorted by `fromOrdinal`. */
  readonly spans: readonly HydratedSpan[];
  /**
   * Spans a rebase or index void discarded, retained for DISPLAY ONLY.
   *
   * A completion rebase renumbers ordinals but barely changes row IDENTITY:
   * nearly every row of the old space exists in the new one under the same row
   * id. Dropping the bodies outright therefore repaints the whole transcript
   * as placeholders for the length of a resnapshot round trip - the completion
   * "flash" - when the client is holding perfectly renderable bodies for rows
   * the replacement index is about to name again.
   *
   * These spans keep their PREVIOUS coordinates. They answer no hydration
   * question: {@link transcriptHydrationGaps} and every planner read the fresh
   * spans only, so everything a stale span covers is still refetched. The row
   * merger alone consumes them, by row id against the replacement skeleton
   * where one exists and by old ordinal into entry-less holes where it does
   * not - so a mispositioned guess can survive at most until the entry for
   * that ordinal arrives.
   *
   * Retired by authority, never by trust: a freshly served span covering all
   * of a stale span's rows replaces it; a complete replacement skeleton
   * retires every stale span it does not name, and settles the rows it does
   * not name inside a span it keeps, so a span mixing survivors with deleted
   * rows leaves once its survivors land; a zero-row authority clears them
   * outright.
   *
   * Shares ONE {@link TRANSCRIPT_WINDOW_MAX_BYTES} with the fresh tier, and
   * the share is re-applied wherever either side moves: at the carry, at every
   * seat that grows the fresh tier, and - because a streamed copy can be held
   * only here - wherever a rewrite grows a stale span
   * ({@link boundStaleTierToBudget}).
   */
  readonly staleSpans: readonly HydratedSpan[];
  /**
   * Records the client holds that the INDEX has not placed yet.
   *
   * The client-side mirror of an asymmetry the host cannot avoid: a
   * body-bearing frame (`messageAccepted`, `eventAppended`) carries a record
   * and no ordinal, while an index frame carries an ordinal and no body. The
   * host emits the first as soon as the append commits and moves the index only
   * on its next snapshot, so between those two moments a record exists on the
   * client with nowhere in the ordinal space to live.
   *
   * They are held HERE rather than appended to the tail span because a span
   * entry claims an ordinal and carries a row id, and the client can compute
   * neither - row ids are the host's projection, and inventing one to satisfy
   * the identity check is the same as deleting the check. "I have this record
   * and I do not know where it goes" is the honest statement, and it is what
   * this field says.
   *
   * Superseded rather than merged: once the same record id arrives inside a
   * span, the authoritative copy wins and this one is pruned. A transient
   * frozen assistant and an accepted user may cross a rebase provisionally,
   * because neither is bound to an ordinal and either interactive frame can
   * overtake the bulk snapshot. Other live records clear.
   */
  readonly liveMessages: readonly Message[];
  readonly liveEvents: readonly ChatEvent[];
  /**
   * Live messages carried across the latest snapshot boundary.
   *
   * A bulk snapshot can be overtaken by the interactive record frame, so the
   * replacement skeleton may not use absence to retire these immediately.
   * Once that skeleton completes, the NEXT snapshot is later authority: it
   * may retire only these recorded ids while preserving messages appended
   * after the boundary.
   */
  readonly snapshotProvisionalMessageIds: readonly string[];
  /** Row-producing live events carried across the latest snapshot boundary. */
  readonly snapshotProvisionalEventIds: readonly string[];
  /** Rows the current authority declared incomplete; do not hot-loop them. */
  readonly unavailableRowIds: readonly string[];
  /** Ordinals paired with unavailable row ids, including pre-skeleton serves. */
  readonly unavailableRowOrdinals: readonly number[];
  /**
   * The FRESH tier's charge: every ledger record a fresh span references
   * (fresh-exclusive AND shared with stale, counted once) plus the fresh
   * spans' structural bytes. See {@link freshTierBytes}. Sharing with the
   * stale tier keeps the over-count in the tier that caused it: evicting a
   * fresh span demotes its shared records to stale-exclusive and this figure
   * genuinely drops, which is what lets eviction make progress post-rebase
   * when the carry holds every fresh span's records too.
   */
  readonly hydratedBytes: number;
  /**
   * How the last eviction pass ended - `"none"` until one runs over budget.
   *
   * `"over-budget-accepted"` is the soft-budget concession protected spans
   * (tail, viewport, required) already get; `"alias-group-unbreakable"` means
   * a zero-marginal alias closure containing a protected member was skipped.
   * The two are different states and only a mislabeled second one hides a
   * leak - the steered-turn shape accumulates closures across a session, so
   * this distinction is what makes drift observable rather than silent.
   */
  readonly evictionTerminal:
    | "none"
    | "over-budget-accepted"
    | "alias-group-unbreakable";
  /**
   * MESSAGE ids whose latest rewrite is not yet reflected in
   * {@link hydratedBytes}.
   *
   * Message ids, not row ids, and the distinction is worth the longer name:
   * everywhere else in this module an identity is the host's PROJECTION id,
   * and this one is matched against `span.messages[].messageId` because a
   * rewrite names a record. The two spaces are not interchangeable - one
   * folded assistant turn is many rows over one record set.
   *
   * The streaming path's answer to a cost that has no cheap exact form.
   * `recordByteLength` serializes a whole record, and the active turn's row is
   * rewritten on every buffered delta while GROWING - so charging it per write
   * is O(row) per delta, quadratic across a turn, and precisely the per-token
   * O(history) work this feature exists to delete.
   *
   * Deferring is sound because the byte figure has exactly one consumer:
   * {@link evictTranscriptWindowToBudget}. Nothing renders it and nothing else
   * branches on it, so it does not need to be right continuously - it needs to
   * be right when it is READ, which is what {@link settleWindowBytes} makes it.
   * The cost lands once per eviction instead of once per delta.
   *
   * Deliberately not "skip the streaming row's bytes entirely": the tail span
   * is exempt from eviction, so an under-count would not protect the live turn
   * (it is already protected) - it would only stop a genuinely huge turn from
   * evicting the cold scrollback it is competing with, which is the one moment
   * that budget is for.
   */
  readonly unsettledByteMessageIds: readonly string[];
  /**
   * The index is void and only a `resnapshot` repairs it.
   *
   * Set by a `reindexed` change; by a final skeleton chunk whose assembled
   * length disagrees with `rowCount` (chunks were lost); and by a `range`
   * response whose row ids contradict the skeleton under the CURRENT epoch.
   * All three are cases where continuing to serve ordinals would be serving a
   * coordinate the client knows is wrong.
   *
   * The third is also the only one that would otherwise SPIN rather than
   * merely be wrong - see {@link applyRangeResponse}.
   */
  readonly invalidated: boolean;
  /**
   * The ordinals the reader last reported looking at, or `null` before any
   * report.
   *
   * Retained because the STALE tier is bounded from places the viewport is not
   * a parameter of. The fresh tier's eviction takes `visible` and `required`
   * from its caller and exempts what they name; `boundedStaleSpans` runs from
   * a rebase, a seat and a rewrite, none of which carry a range - so before
   * this the carry had no protection except warmth, and warmth is a scalar two
   * different claims write to. A viewport report and a streamed rewrite both
   * moved it, so every fix that made one of them legible made the other less
   * so, and the span the reader was looking at could still be the one a
   * squeeze dropped.
   *
   * Recording the range makes visibility a PROTECTION rather than a bid for
   * warmth, which is the same shape the fresh tier already has and leaves
   * `touchedAt` to mean recency alone.
   *
   * In CURRENT coordinates. A carry keeps its previous ones, and
   * {@link staleSpanVisibleIn} is what bridges the two - so this is compared
   * through that predicate and never against a stale span's own ordinals.
   * Carried across a rebase and a void because the reader has not moved; the
   * next report corrects it either way, and an over-broad range costs budget
   * where a missing one costs the placeholder flash the tier exists to prevent.
   */
  readonly visibleOrdinals: OrdinalRange | null;
  /** Monotonic counter backing `touchedAt`. */
  readonly clock: number;
}

export interface OrdinalRange {
  readonly fromOrdinal: number;
  /** Exclusive. */
  readonly toOrdinal: number;
}

/**
 * How many bodies to keep hydrated before evicting the coldest span.
 *
 * The point of the whole feature is that a client never holds a whole 20-40 MB
 * transcript, so this has to be well under that while still being large enough
 * that ordinary scrolling does not thrash: a reader paging back through a long
 * chat should find the rows they just left still hydrated.
 */
export const TRANSCRIPT_WINDOW_MAX_BYTES = 8 * 1024 * 1024;

/**
 * How large a span may grow by absorbing the span NEXT to it.
 *
 * Eviction drops whole spans, so a span is the smallest thing the budget can
 * reclaim - and merging is what decides how big that unit is. Without a cap,
 * the ordinary way to read a long chat defeats the budget completely: scroll
 * up from the tail and every response is adjacent to the last, so the whole
 * transcript coalesces into ONE span whose end touches `rowCount`. That span
 * is the tail span, the tail is exempt from eviction, and the exemption then
 * covers every row the reader has ever visited. The window grows without
 * bound while `hydratedBytes` says it is over budget and eviction finds
 * nothing it is allowed to drop.
 *
 * Capping adjacency keeps contiguous coverage represented as SEVERAL touching
 * spans, so the exemption lands on a bounded tail rather than on everything
 * behind it. Overlapping spans are always merged whatever their size - two
 * spans claiming the same ordinal is a correctness problem, not a size one.
 *
 * Sized against the host's own range ceiling (`TRANSCRIPT_RANGE_MAX_BYTES`),
 * so a single response stays one span and the budget divides into enough
 * spans to have an eviction ORDER at all.
 */
export const SPAN_MERGE_MAX_BYTES = 1024 * 1024;

/**
 * How many rows to hydrate when a snapshot arrives with an EMPTY tail.
 *
 * The host's tail is bounded by `TRANSCRIPT_TAIL_MAX_BYTES` and it walks
 * backwards with a hard ceiling and no always-serve-one exception - so a chat
 * whose last row is a 1.27 MB tool result ships a tail of zero rows, which is
 * the correct answer to "what fits". The client must notice that and ask,
 * rather than render an empty chat that has rows in it.
 */
export const EAGER_TAIL_ROW_COUNT = 20;

/**
 * How many row-less live events the window keeps.
 *
 * Generous, because these are small and the cap is a leak backstop rather than
 * a working limit: a chat would have to run hundreds of sends and queue changes
 * on one connection to reach it, and everything a row needs is re-served by
 * that row's hydration regardless.
 */
export const MAX_LIVE_EVENTS = 512;

export function emptyTranscriptWindow(): TranscriptWindow {
  return {
    epoch: 0,
    rowCount: 0,
    skeleton: [],
    skeletonComplete: false,
    skeletonStreamCoveredThrough: 0,
    indexRevision: 0,
    // ARMED, not clear. A window with no counter behind it must adopt the first
    // concrete revision it is given rather than compare against a zero it never
    // received. A fresh subscription meets a fresh subscriber and is announced
    // by `null` anyway, so this is the robust default rather than a second
    // mechanism.
    indexRevisionRebuilding: true,
    records: { messages: new Map(), events: new Map(), revision: 0 },
    spans: [],
    staleSpans: [],
    liveMessages: [],
    liveEvents: [],
    snapshotProvisionalMessageIds: [],
    snapshotProvisionalEventIds: [],
    unavailableRowIds: [],
    unavailableRowOrdinals: [],
    hydratedBytes: 0,
    evictionTerminal: "none",
    unsettledByteMessageIds: [],
    invalidated: false,
    visibleOrdinals: null,
    clock: 0,
  };
}

/**
 * A span's message records, resolved through the ledger, in span order.
 *
 * A reference with no entry is a defect (the ledger invariant is "entry exists
 * while referenced"), and it is skipped rather than crashed on: rendering the
 * rest of the span beats taking the transcript down, and the missing body
 * surfaces as the placeholder its row falls back to.
 */
export function spanMessages(
  window: TranscriptWindow,
  span: HydratedSpan,
): readonly Message[] {
  const out: Message[] = [];
  for (const id of span.messageIds) {
    const entry = window.records.messages.get(id);
    if (entry !== undefined) out.push(entry.record);
  }
  return out;
}

/** The event half of {@link spanMessages}. */
export function spanEvents(
  window: TranscriptWindow,
  span: HydratedSpan,
): readonly ChatEvent[] {
  const out: ChatEvent[] = [];
  for (const id of span.eventIds) {
    const entry = window.records.events.get(id);
    if (entry !== undefined) out.push(entry.record);
  }
  return out;
}

/**
 * Seat served records into the ledger: each gets the one owned copy, a fresh
 * measure, and `servedAt`/`touchedAt` at the seating clock.
 *
 * A record already present is REPLACED - the seat's body is the chosen winner
 * (the held-copy preference has already run by the time this is called), and a
 * re-serve is a serve, so its stamp moves even when the body did not. Both
 * spans referencing a shared record then read the identical record-level
 * figure, which is what makes the stale tier's contested-row award and
 * `seatStaleRows`' draw agree by construction.
 *
 * `revision` bumps here because a seat is a structural moment (membership or
 * serve identity moved) - unlike the in-place rewrites, which must NOT move it
 * or every (spans, revision)-keyed memo would recompute per streaming token.
 */
function seatLedgerRecords(
  ledger: RecordLedger,
  messages: readonly Message[],
  events: readonly ChatEvent[],
  clock: number,
): RecordLedger {
  if (messages.length === 0 && events.length === 0) return ledger;
  const nextMessages = new Map(ledger.messages);
  for (const message of messages) {
    nextMessages.set(message.messageId, {
      record: message,
      bytes: recordByteLength(message),
      servedAt: clock,
      touchedAt: clock,
    });
  }
  const nextEvents = new Map(ledger.events);
  for (const event of events) {
    nextEvents.set(event.eventId, {
      record: event,
      bytes: recordByteLength(event),
      servedAt: clock,
      touchedAt: clock,
    });
  }
  return {
    messages: nextMessages,
    events: nextEvents,
    revision: ledger.revision + 1,
  };
}

/** Every record id referenced by any span in `tiers`, both id spaces. */
function referencedRecordIds(tiers: readonly (readonly HydratedSpan[])[]): {
  readonly messageIds: Set<string>;
  readonly eventIds: Set<string>;
} {
  const messageIds = new Set<string>();
  const eventIds = new Set<string>();
  for (const spans of tiers) {
    for (const span of spans) {
      for (const id of span.messageIds) messageIds.add(id);
      for (const id of span.eventIds) eventIds.add(id);
    }
  }
  return { messageIds, eventIds };
}

/**
 * The reference-counted release: drop every ledger entry no span references.
 *
 * Run at the end of every fold that can shrink a tier. Evicting a span never
 * un-charges a record another span references, because the charge is derived
 * from the surviving references - this only reclaims the memory of records
 * nothing references at all. Identity-stable when nothing is unreferenced, so
 * the per-token path (where drops are rare) does not churn the ledger.
 */
function pruneUnreferencedRecords(window: TranscriptWindow): TranscriptWindow {
  const referenced = referencedRecordIds([window.spans, window.staleSpans]);
  if (
    referenced.messageIds.size === window.records.messages.size &&
    referenced.eventIds.size === window.records.events.size
  ) {
    return window;
  }
  const messages = new Map(
    [...window.records.messages].filter(([id]) =>
      referenced.messageIds.has(id),
    ),
  );
  const events = new Map(
    [...window.records.events].filter(([id]) => referenced.eventIds.has(id)),
  );
  return {
    ...window,
    records: {
      messages,
      events,
      revision: window.records.revision + 1,
    },
  };
}

/**
 * The ledger a carry takes into a rebased or voided window: exactly the
 * entries the carried spans reference. Deferred debt rides along - the caller
 * carries `unsettledByteMessageIds` beside this (filtered by the same
 * retention), so a completed long turn's true measure is still owed and
 * {@link settleWindowBytes} still collects it, which is what retired the
 * settle-before-carry pass.
 */
function retainLedgerForSpans(
  ledger: RecordLedger,
  spans: readonly HydratedSpan[],
): RecordLedger {
  const referenced = referencedRecordIds([spans]);
  return {
    messages: new Map(
      [...ledger.messages].filter(([id]) => referenced.messageIds.has(id)),
    ),
    events: new Map(
      [...ledger.events].filter(([id]) => referenced.eventIds.has(id)),
    ),
    revision: ledger.revision + 1,
  };
}

/**
 * The stale tier a snapshot carries across an index boundary, with the ledger
 * cut down to what it references. Off the boundary (`crossing` false) nothing
 * is carried and the ledger passes through untouched; a zero `rowCount` means
 * the replacement transcript is empty, so there is nothing the carry could be
 * drawn under and it is dropped rather than retained.
 */
function carriedStaleTier(
  window: TranscriptWindow,
  crossing: boolean,
  rowCount: number,
): {
  readonly spans: readonly HydratedSpan[];
  readonly ledger: RecordLedger;
} {
  if (!crossing) return { spans: [], ledger: window.records };
  const spans = rowCount > 0 ? staleCarrySpans(window) : [];
  return { spans, ledger: retainLedgerForSpans(window.records, spans) };
}

/**
 * The fresh tier's charge - see {@link TranscriptWindow.hydratedBytes}.
 *
 * Deduplicated across spans by construction: each referenced record is one
 * ledger entry, summed once however many fresh spans reference it. The
 * structural bytes stay per-span (context maps are not aliased).
 */
function freshTierBytes(
  ledger: RecordLedger,
  spans: readonly HydratedSpan[],
): number {
  const referenced = referencedRecordIds([spans]);
  let bytes = 0;
  for (const id of referenced.messageIds) {
    bytes += ledger.messages.get(id)?.bytes ?? 0;
  }
  for (const id of referenced.eventIds) {
    bytes += ledger.events.get(id)?.bytes ?? 0;
  }
  for (const span of spans) bytes += span.contextBytes;
  return bytes;
}

/**
 * The stale tier's charge against remaining headroom: stale-EXCLUSIVE record
 * bytes (a record the fresh tier also references is already inside
 * {@link TranscriptWindow.hydratedBytes} - charging it here would bill the
 * alias twice, the exact over-count the ledger exists to remove) plus the
 * stale spans' structural bytes.
 */
function staleTierBytes(window: TranscriptWindow): number {
  if (window.staleSpans.length === 0) return 0;
  const fresh = referencedRecordIds([window.spans]);
  const stale = referencedRecordIds([window.staleSpans]);
  let bytes = 0;
  for (const id of stale.messageIds) {
    if (fresh.messageIds.has(id)) continue;
    bytes += window.records.messages.get(id)?.bytes ?? 0;
  }
  for (const id of stale.eventIds) {
    if (fresh.eventIds.has(id)) continue;
    bytes += window.records.events.get(id)?.bytes ?? 0;
  }
  for (const span of window.staleSpans) bytes += span.contextBytes;
  return bytes;
}

/**
 * One span's charge-inclusive figure: every referenced record at full size
 * (aliases NOT deduped - a deduped ceiling would let spans sharing a turn's
 * records merge into the unbounded tail the cap exists to prevent) plus its
 * structural bytes.
 *
 * Derived from the ledger at the moment it is needed and NEVER retained - a
 * retained figure is stored-at-insert with a different source, and a streaming
 * rewrite between merges makes it stale again. Records whose charge is
 * deferred (`unsettled`) are re-measured here so a tail that grew 900 KB while
 * streaming cannot absorb a neighbour the cap should refuse.
 */
function derivedSpanBytes(
  ledger: RecordLedger,
  span: HydratedSpan,
  unsettled: ReadonlySet<string>,
): number {
  let bytes = span.contextBytes;
  for (const id of span.messageIds) {
    const entry = ledger.messages.get(id);
    if (entry === undefined) continue;
    bytes += unsettled.has(id) ? recordByteLength(entry.record) : entry.bytes;
  }
  for (const id of span.eventIds) {
    bytes += ledger.events.get(id)?.bytes ?? 0;
  }
  return bytes;
}

/** The record ids a span DRAWS - they back at least one of its rows. */
interface SpanDraws {
  readonly messageIds: ReadonlySet<string>;
  readonly eventIds: ReadonlySet<string>;
}

/**
 * Cached per span object at a ledger revision: span identity survives every
 * in-place rewrite (spans hold ids), and a rewrite changes no membership and
 * no row id, so the drawn SET is stable across tokens - only the stamps read
 * through it move. Structural changes replace the span object or bump the
 * revision, and either invalidates.
 */
const spanDrawsCache = new WeakMap<
  HydratedSpan,
  { readonly revision: number; readonly draws: SpanDraws }
>();

/**
 * Which of a span's records it DRAWS, as opposed to merely holds.
 *
 * The draws relation is the row->record backing shapes the tier-parameterized
 * registry uses ({@link addRecordBackedRowIds}), intersected with the span's
 * own `rowIds` - plus the turn-key linkage, because an assistant record backs
 * its turn's `assistant:` slice rows whose ids never name the record. A record
 * riding along to render a sibling row a DIFFERENT span draws is a hold, not a
 * draw, and inherits no warmth from it - the holds-vs-draws conflation was the
 * tie factory behind the warmth findings.
 */
function spanDraws(window: TranscriptWindow, span: HydratedSpan): SpanDraws {
  const cached = spanDrawsCache.get(span);
  if (cached !== undefined && cached.revision === window.records.revision) {
    return cached.draws;
  }
  const rowIds = new Set<string>();
  const rowTurnKeys = new Set<string>();
  for (const rowId of span.rowIds) {
    if (rowId === "") continue;
    rowIds.add(rowId);
    const turnKey = assistantRowTurnKey(rowId);
    if (turnKey !== null) rowTurnKeys.add(turnKey);
  }
  const draws = spanDrawsForRows(window, span, rowIds, rowTurnKeys);
  spanDrawsCache.set(span, { revision: window.records.revision, draws });
  return draws;
}

/**
 * The row->record half of {@link spanDraws}, over a caller-chosen subset of
 * the span's rows. {@link touchTranscriptRange} passes only the rows the span
 * is actually drawing IN the touched range - the same per-row refusals
 * {@link staleRowDrawnIn} makes - so a record backing a row the fresh tier
 * draws, or one outside the viewport, earns no bump through this span even
 * though the span structurally lists it. Under the shared ledger that
 * precision is load-bearing: bumping a shared record warms EVERY span drawing
 * it, so a span-grain bump would launder one span's viewport warmth into
 * another tier's rider.
 */
function spanDrawsForRows(
  window: TranscriptWindow,
  span: HydratedSpan,
  rowIds: ReadonlySet<string>,
  rowTurnKeys: ReadonlySet<string>,
): SpanDraws {
  const messageIds = new Set<string>();
  for (const id of span.messageIds) {
    if (rowIds.has(id)) {
      messageIds.add(id);
      continue;
    }
    const entry = window.records.messages.get(id);
    if (
      entry !== undefined &&
      entry.record.role === "assistant" &&
      rowTurnKeys.has(assistantTurnKey(entry.record))
    ) {
      messageIds.add(id);
    }
  }
  const eventIds = new Set<string>();
  for (const id of span.eventIds) {
    const entry = window.records.events.get(id);
    if (entry === undefined) continue;
    const backed = new Set<string>();
    addRecordBackedRowIds(backed, [], [entry.record]);
    for (const backedId of backed) {
      if (rowIds.has(backedId)) {
        eventIds.add(id);
        break;
      }
    }
  }
  return { messageIds, eventIds };
}

/**
 * A span's derived warmth: the greatest `touchedAt` among the records it
 * draws. A span drawing nothing (all riders - reachable only through a defect,
 * since every row is backed by something) falls back to its held records so it
 * still has an eviction order at all.
 */
export function spanTouchStamp(
  window: TranscriptWindow,
  span: HydratedSpan,
): number {
  const draws = spanDraws(window, span);
  let stamp = 0;
  let sawDraw = false;
  for (const id of draws.messageIds) {
    const entry = window.records.messages.get(id);
    if (entry === undefined) continue;
    sawDraw = true;
    if (entry.touchedAt > stamp) stamp = entry.touchedAt;
  }
  for (const id of draws.eventIds) {
    const entry = window.records.events.get(id);
    if (entry === undefined) continue;
    sawDraw = true;
    if (entry.touchedAt > stamp) stamp = entry.touchedAt;
  }
  if (sawDraw) return stamp;
  for (const id of span.messageIds) {
    const entry = window.records.messages.get(id);
    if (entry !== undefined && entry.touchedAt > stamp) stamp = entry.touchedAt;
  }
  for (const id of span.eventIds) {
    const entry = window.records.events.get(id);
    if (entry !== undefined && entry.touchedAt > stamp) stamp = entry.touchedAt;
  }
  return stamp;
}

/** The serve half of {@link spanTouchStamp}: greatest `servedAt` over draws. */
export function spanServeStamp(
  window: TranscriptWindow,
  span: HydratedSpan,
): number {
  const draws = spanDraws(window, span);
  let stamp = 0;
  let sawDraw = false;
  for (const id of draws.messageIds) {
    const entry = window.records.messages.get(id);
    if (entry === undefined) continue;
    sawDraw = true;
    if (entry.servedAt > stamp) stamp = entry.servedAt;
  }
  for (const id of draws.eventIds) {
    const entry = window.records.events.get(id);
    if (entry === undefined) continue;
    sawDraw = true;
    if (entry.servedAt > stamp) stamp = entry.servedAt;
  }
  if (sawDraw) return stamp;
  for (const id of span.messageIds) {
    const entry = window.records.messages.get(id);
    if (entry !== undefined && entry.servedAt > stamp) stamp = entry.servedAt;
  }
  for (const id of span.eventIds) {
    const entry = window.records.events.get(id);
    if (entry !== undefined && entry.servedAt > stamp) stamp = entry.servedAt;
  }
  return stamp;
}

/**
 * One span's charge-inclusive figure, derived on demand - the metric the
 * merge ceiling reads ({@link derivedSpanBytes}), exported so a test can pin
 * the ceiling against the ledger without any retained per-span field
 * existing to read.
 */
export function spanChargeBytes(
  window: TranscriptWindow,
  span: HydratedSpan,
): number {
  return derivedSpanBytes(
    window.records,
    span,
    new Set(window.unsettledByteMessageIds),
  );
}

/**
 * Fold one record set's BACKABLE identities into `into` - the derived id
 * shapes every tier produces the same way: a message backs the row carrying
 * its id, an event backs both its transcript row and its forked-chat-link
 * row, and a stopped turn's event backs that turn's assistant row.
 *
 * Lives HERE (not in `transcript-list-rows.ts`, which imports it) because the
 * draws relation above and both tiers' backing channels consume the same fold
 * - a derived shape landing in one consumer and not the others is the drift
 * the shared fold exists to prevent.
 */
export function addRecordBackedRowIds(
  into: Set<string>,
  messages: readonly Message[],
  events: readonly ChatEvent[],
): void {
  for (const message of messages) into.add(message.messageId);
  for (const event of events) {
    into.add(chatTranscriptEventRowId(event.eventId));
    into.add(forkedChatLinkRowId(event.eventId));
    if (event.type === "turn.stopped" && event.turnId !== null) {
      into.add(assistantRowId(event.turnId));
    }
  }
}

/**
 * Take a record the client received with no ordinal.
 *
 * The write-through half of the decision that `state.messages` is DERIVED on
 * this line. An applier that wrote to the published array instead would have
 * its work erased by the next windowed frame of any kind - a skeleton chunk, an
 * index delta, a range - because that array is rebuilt from this window every
 * time. Nothing else in the store has that property, which is exactly why it
 * was easy to miss.
 *
 * Already-known records are dropped rather than duplicated, checking BOTH the
 * live set and the spans: the host re-sends `messageAccepted` for a duplicate
 * user-message id (a reconnect retransmitting an accepted send), and the
 * hydrated copy of a record is the one to keep.
 */
export function appendLiveRecords(
  window: TranscriptWindow,
  input: {
    readonly messages: readonly Message[];
    readonly events: readonly ChatEvent[];
  },
): TranscriptWindow {
  const knownMessages = new Set<string>(
    window.liveMessages.map((message) => message.messageId),
  );
  const knownEvents = new Set<string>(
    window.liveEvents.map((event) => event.eventId),
  );
  // The ledger IS the span tiers' membership - fresh and the stale carry
  // alike. The carry counting as known is load-bearing: a reconnect can
  // retransmit an accepted record whose only copy rode a span into
  // `staleSpans`, and re-admitting it as live would draw it a second time as
  // an unplaced tail row wherever its stale row cannot occupy its old ordinal.
  for (const id of window.records.messages.keys()) knownMessages.add(id);
  for (const id of window.records.events.keys()) knownEvents.add(id);
  const messages = input.messages.filter(
    (message) => !knownMessages.has(message.messageId),
  );
  const events = input.events.filter(
    (event) => !knownEvents.has(event.eventId),
  );
  if (messages.length === 0 && events.length === 0) return window;
  // Capped here as well as in `pruneSupersededLiveRecords`, because that runs
  // after a SPAN mutation and this path does not need one: a session that only
  // sends - no scrolling, no eviction, no range - never seats a span, so the
  // prune never runs and the row-less events would still accumulate unbounded.
  // This is the append the cap actually has to hold.
  const appendedEvents = [...window.liveEvents, ...events];
  return {
    ...window,
    liveMessages: [...window.liveMessages, ...messages],
    liveEvents:
      appendedEvents.length > MAX_LIVE_EVENTS
        ? appendedEvents.slice(appendedEvents.length - MAX_LIVE_EVENTS)
        : appendedEvents,
    clock: window.clock + 1,
  };
}

/**
 * Drop live records the spans now carry authoritatively.
 *
 * Runs after every span mutation. Without it the live set would grow for the
 * life of the session, and - worse - a record the host later REWROTE would
 * still have its original sitting here, ready to reappear the moment its span
 * is evicted.
 */
function pruneSupersededLiveRecords(
  window: TranscriptWindow,
  freshlyServedAssistantTurns: ReadonlyMap<
    string,
    Extract<Message, { role: "assistant" }>
  >,
): TranscriptWindow {
  if (window.liveMessages.length === 0 && window.liveEvents.length === 0) {
    return window;
  }
  const freshReferenced = referencedRecordIds([window.spans]);
  const spanHeldMessages = freshReferenced.messageIds;
  const spanHeldEvents = freshReferenced.eventIds;
  const liveMessages = window.liveMessages.filter((message) => {
    if (spanHeldMessages.has(message.messageId)) return false;
    if (
      message.role !== "assistant" ||
      !isTransientLiveAssistantMessageId(message.messageId)
    ) {
      return true;
    }
    const served = freshlyServedAssistantTurns.get(assistantTurnKey(message));
    return (
      served === undefined ||
      served.timestamp < message.timestamp ||
      (served.timestamp === message.timestamp &&
        !assistantRenderBodyEqual(served, message))
    );
  });
  const supersededEvents = window.liveEvents.filter(
    (event) => !spanHeldEvents.has(event.eventId),
  );
  // Span-supersession alone cannot bound this set, and that is not a tuning
  // matter - it is a whole CLASS of event the rule can never reach.
  //
  // A live record leaves via a span carrying it, which requires the record to
  // belong to a row. Plenty do not: `send.accepted`, the `queue.*` family and
  // their siblings are transcript-level signals that materialize no row, so no
  // span will ever name them and no amount of scrolling will evict them. On a
  // tab left connected across many sends they accumulate for the life of the
  // session - and, because `hydratedBytes` is `totalBytes(spans)`, they are
  // not charged to the window budget either, so nothing else notices.
  //
  // The tail is what has any chance of being live-relevant, so the cap keeps
  // the NEWEST. Dropping an older one is safe rather than lossy: anything that
  // genuinely belongs to a row is re-served by that row's hydration, which is
  // the same reason the supersession rule above can discard on sight.
  const liveEvents =
    supersededEvents.length > MAX_LIVE_EVENTS
      ? supersededEvents.slice(supersededEvents.length - MAX_LIVE_EVENTS)
      : supersededEvents;
  if (
    liveMessages.length === window.liveMessages.length &&
    liveEvents.length === window.liveEvents.length
  ) {
    return window;
  }
  return { ...window, liveMessages, liveEvents };
}

function assistantRenderBodyEqual(
  left: Extract<Message, { role: "assistant" }>,
  right: Extract<Message, { role: "assistant" }>,
): boolean {
  return (
    stableJsonStringify([
      left.blocks,
      left.usage,
      left.imageResolutions,
      left.reasoningEffort,
      left.serviceTier,
    ]) ===
    stableJsonStringify([
      right.blocks,
      right.usage,
      right.imageResolutions,
      right.reasoningEffort,
      right.serviceTier,
    ])
  );
}

/** Canonical JSON encoding for structural comparisons across record sources. */
function stableJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (
      nested === null ||
      Array.isArray(nested) ||
      typeof nested !== "object"
    ) {
      return nested;
    }
    return Object.fromEntries(
      Object.entries(nested).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  });
}

function servedAssistantTurns(
  rowIds: readonly string[],
  messages: readonly Message[],
  events: readonly ChatEvent[],
): ReadonlyMap<string, Extract<Message, { role: "assistant" }>> {
  const assistantMessages = new Map<
    string,
    Extract<Message, { role: "assistant" }>
  >();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const turnKey = assistantTurnKey(message);
    const current = assistantMessages.get(turnKey);
    if (current === undefined) {
      assistantMessages.set(turnKey, message);
      continue;
    }
    let startedAt = current.startedAt;
    if (
      startedAt === null ||
      (message.startedAt !== null && message.startedAt < startedAt)
    ) {
      startedAt = message.startedAt;
    }
    assistantMessages.set(turnKey, {
      ...current,
      messageId: message.messageId,
      blocks: [...current.blocks, ...message.blocks],
      startedAt,
      timestamp: Math.max(current.timestamp, message.timestamp),
      usage: message.usage ?? current.usage,
      reasoningEffort: current.reasoningEffort ?? message.reasoningEffort,
      serviceTier: current.serviceTier ?? message.serviceTier,
      imageResolutions: [
        ...current.imageResolutions,
        ...message.imageResolutions,
      ],
    });
  }
  const turns = new Map<string, Extract<Message, { role: "assistant" }>>();
  for (const turnKey of assistantTurnKeysForServedRows(
    rowIds,
    messages,
    events,
  )) {
    const message = assistantMessages.get(turnKey);
    if (message !== undefined) turns.set(turnKey, message);
  }
  return turns;
}

function assistantTurnKeysForServedRows(
  rowIds: readonly string[],
  messages: readonly Message[],
  events: readonly ChatEvent[],
): ReadonlySet<string> {
  const turnKeys = new Set<string>();
  const projectedRows = new Map(
    projectTranscriptRows({
      messages,
      events,
      activeTurnId: null,
      chatId: "",
    }).map((row) => [row.rowId, row]),
  );
  const messageById = new Map(
    messages.map((message) => [message.messageId, message]),
  );
  for (const rowId of rowIds) {
    const turnKey = assistantRowTurnKey(rowId);
    if (turnKey !== null) {
      turnKeys.add(turnKey);
      continue;
    }
    const projected = projectedRows.get(rowId);
    if (projected === undefined) continue;
    for (const messageId of rowRecordIds(projected.source).messageIds) {
      const message = messageById.get(messageId);
      if (message?.role !== "assistant") continue;
      turnKeys.add(assistantTurnKey(message));
    }
  }
  return turnKeys;
}

function incompleteRowIdsToWithhold(
  incompleteRowIds: readonly string[] | undefined,
): ReadonlySet<string> {
  return new Set(incompleteRowIds ?? []);
}

function withUnavailableRows(
  window: TranscriptWindow,
  rowIds: readonly string[],
  fromOrdinal: number,
  unavailableRowIds: ReadonlySet<string>,
): TranscriptWindow {
  const unavailableByOrdinal = new Map<number, string>();
  for (
    let index = 0;
    index < window.unavailableRowOrdinals.length;
    index += 1
  ) {
    unavailableByOrdinal.set(
      window.unavailableRowOrdinals[index],
      window.unavailableRowIds[index],
    );
  }
  for (let index = 0; index < rowIds.length; index += 1) {
    if (!unavailableRowIds.has(rowIds[index])) continue;
    unavailableByOrdinal.set(fromOrdinal + index, rowIds[index]);
  }
  const unavailableRows = [...unavailableByOrdinal.entries()];
  return {
    ...window,
    unavailableRowIds: unavailableRows.map(([, rowId]) => rowId),
    unavailableRowOrdinals: unavailableRows.map(([ordinal]) => ordinal),
  };
}

function withoutUnavailableRows(
  window: TranscriptWindow,
  rowIds: readonly string[],
  fromOrdinal: number,
): TranscriptWindow {
  if (window.unavailableRowIds.length === 0) return window;
  const completed = new Set(rowIds);
  const completedOrdinals = new Set(
    rowIds.map((_rowId, index) => fromOrdinal + index),
  );
  const keptIndexes = window.unavailableRowOrdinals.flatMap((ordinal, index) =>
    completedOrdinals.has(ordinal) ||
    completed.has(window.unavailableRowIds[index])
      ? []
      : [index],
  );
  const unavailableRowIds = keptIndexes.map(
    (index) => window.unavailableRowIds[index],
  );
  const unavailableRowOrdinals = keptIndexes.map(
    (index) => window.unavailableRowOrdinals[index],
  );
  return unavailableRowIds.length === window.unavailableRowIds.length &&
    unavailableRowOrdinals.length === window.unavailableRowOrdinals.length
    ? window
    : { ...window, unavailableRowIds, unavailableRowOrdinals };
}

function completeServedRowIds(
  rowIds: readonly string[],
  incompleteRowIds: readonly string[] | undefined,
): readonly string[] {
  // Field absence is an already-deployed 1.8 host: retain its pre-change
  // behavior rather than keeping a transient duplicate forever.
  if (incompleteRowIds === undefined) return rowIds;
  if (incompleteRowIds.length === 0) return rowIds;
  const incomplete = new Set(incompleteRowIds);
  return rowIds.filter((rowId) => !incomplete.has(rowId));
}

function recordsForRowIds(
  messages: readonly Message[],
  events: readonly ChatEvent[],
  rowIds: ReadonlySet<string>,
  setupRowOffset: number,
): {
  readonly messages: Message[];
  readonly events: ChatEvent[];
} {
  const setupRowIds = [...rowIds].filter((rowId) =>
    rowId.startsWith("setup-card:"),
  );
  const chatId =
    (setupRowIds.at(0) ?? "").match(/^setup-card:(.*):\d+:\d+$/)?.[1] ?? "";
  const messageIds = new Set<string>();
  const eventIds = new Set<string>();
  const projectedRows = projectTranscriptRows({
    messages,
    events,
    activeTurnId: null,
    chatId,
  });
  const projectedSetupRows = projectedRows.filter(
    (row) => row.source.kind === "setup-card",
  );
  const fallbackSetupRows = new Set(
    projectedSetupRows.slice(
      setupRowOffset,
      setupRowOffset + setupRowIds.length,
    ),
  );
  for (const row of projectedRows) {
    if (
      row.source.kind === "setup-card"
        ? !fallbackSetupRows.has(row)
        : !rowIds.has(row.rowId)
    ) {
      continue;
    }
    const recordIds = rowRecordIds(row.source);
    for (const id of recordIds.messageIds) messageIds.add(id);
    for (const id of recordIds.eventIds) eventIds.add(id);
  }
  return {
    messages: messages.filter((message) => messageIds.has(message.messageId)),
    events: events.filter((event) => eventIds.has(event.eventId)),
  };
}

function declaredCompleteTailRowIds(
  tail: ChatTranscriptWindow,
): readonly string[] {
  // A legacy tail with no declared identities is seated positionally from the
  // retained skeleton. During a rebuild that skeleton may be stale, so those
  // fallback ids cannot prove which row the fresh records completed.
  if (tail.rowIds === undefined) return [];
  return completeServedRowIds(tail.rowIds, tail.incompleteRowIds);
}

/**
 * Replace a message wherever the window holds it, live or hydrated.
 *
 * The in-place half: an image resolving, a steer split moving blocks, a
 * detached-subagent event attaching to its owner. `held: false` means the row
 * is outside the window, which is NOT an error - it is the case the caller
 * answers by dropping the change and letting the eventual hydration serve the
 * host's own version.
 */
export function updateWindowMessage(
  window: TranscriptWindow,
  messageId: string,
  update: (message: Message) => Message,
  witnesses: ImageWitnessStore | null,
): { readonly window: TranscriptWindow; readonly held: boolean } {
  return rewriteWindowMessage(window, messageId, update, {
    charge: "now",
    witnesses,
  });
}

/**
 * The same rewrite, for the ACTIVE TURN's row.
 *
 * Identical in every respect except when the bytes are charged: this one defers
 * (see {@link TranscriptWindow.unsettledByteMessageIds}). Separate from
 * {@link updateWindowMessage} rather than a flag on it, because the choice is
 * not a caller preference - it follows from how often the caller runs, and a
 * row-targeted applier that started deferring would be a silent regression in
 * the accuracy of the budget rather than a visible one.
 */
export function streamWindowMessage(
  window: TranscriptWindow,
  messageId: string,
  update: (message: Message) => Message,
  witnesses: ImageWitnessStore | null,
): { readonly window: TranscriptWindow; readonly held: boolean } {
  return rewriteWindowMessage(window, messageId, update, {
    charge: "deferred",
    witnesses,
  });
}

/**
 * Rewrite EVERY message the window holds, live and hydrated.
 *
 * For a projection whose subject is a property rather than an id - the
 * steer-restart turn remap, which renames a `turnId` across however many rows
 * carry it. {@link updateWindowMessage} cannot express that: the caller does
 * not know which ids match until it has looked at each row.
 *
 * Returns the window unchanged, by reference, when `update` was identity for
 * every record - so a caller that runs on a frequent path does not force a
 * republish for a frame that changed nothing.
 *
 * Deliberately NOT for the streaming path. This re-measures every span it
 * touches, which is the cost {@link streamWindowMessage}'s deferred charge
 * exists to avoid; the callers here run at turn boundaries.
 */
export function mapWindowMessages(
  window: TranscriptWindow,
  update: (message: Message) => Message,
  witnesses: ImageWitnessStore | null,
): TranscriptWindow {
  // ONE pass over the ledger, because the ledger holds the one copy of every
  // span-referenced record - the per-tier walks this replaced were the same
  // records visited once per holder. Re-measured on the spot: a remap is
  // explicitly off the streaming path, so it can afford what the deferred
  // charge exists to avoid.
  let ledgerChanged = false;
  const nextEntries = new Map<string, LedgerRecordEntry<Message>>();
  for (const [id, entry] of window.records.messages) {
    const record = update(entry.record);
    if (record === entry.record) {
      nextEntries.set(id, entry);
      continue;
    }
    // The rewritten object descends from the held one - its image evidence
    // (stamps, capture moment) follows it, or rule 2 goes silent for every
    // source the next witnessed write does not re-stamp.
    witnesses?.carryRewrittenCopy(entry.record, record);
    ledgerChanged = true;
    nextEntries.set(id, {
      record,
      bytes: recordByteLength(record),
      servedAt: entry.servedAt,
      touchedAt: entry.touchedAt,
    });
  }
  const liveMessages = window.liveMessages.map((message) => {
    const next = update(message);
    if (next !== message) witnesses?.carryRewrittenCopy(message, next);
    return next;
  });
  const liveChanged = liveMessages.some(
    (message, index) => message !== window.liveMessages[index],
  );
  if (!ledgerChanged && !liveChanged) return window;
  // The revision moves: a remap can rename `turnId`s, which the draws
  // relation reads through the record contents - unlike a streaming block
  // delta, which never touches an identity. This runs at turn boundaries, so
  // invalidating the (spans, revision)-keyed memos here costs nothing on the
  // per-token path.
  const records = ledgerChanged
    ? {
        messages: nextEntries,
        events: window.records.events,
        revision: window.records.revision + 1,
      }
    : window.records;
  return boundStaleTierToBudget({
    ...window,
    records,
    liveMessages: liveChanged ? liveMessages : window.liveMessages,
    hydratedBytes: ledgerChanged
      ? freshTierBytes(records, window.spans)
      : window.hydratedBytes,
  });
}

/**
 * Bring the byte figures back in line with what the ledger actually holds.
 *
 * Re-measures only the UNSETTLED records - once each, in the ledger - not once
 * per holding span as the retired `resettledSpanBytes` did: single ownership
 * is what makes the cost proportional to what was deferred rather than to how
 * many spans reference it. Called wherever a figure is about to be READ, and
 * the deferred debt now survives a carry (the ledger and the unsettled list
 * both ride the void), so the carry no longer has to settle eagerly.
 */
export function settleWindowBytes(window: TranscriptWindow): TranscriptWindow {
  if (window.unsettledByteMessageIds.length === 0) return window;
  let changed = false;
  const nextEntries = new Map(window.records.messages);
  for (const id of window.unsettledByteMessageIds) {
    const entry = nextEntries.get(id);
    if (entry === undefined) continue;
    const bytes = recordByteLength(entry.record);
    if (bytes === entry.bytes) continue;
    changed = true;
    nextEntries.set(id, { ...entry, bytes });
  }
  // No revision bump: a settle changes charges, never membership, serve
  // identity, or anything a (spans, revision)-keyed memo reads.
  const records = changed
    ? {
        messages: nextEntries,
        events: window.records.events,
        revision: window.records.revision,
      }
    : window.records;
  // Bounded here rather than only where the tier is BUILT: settling is the
  // moment a deferred stale figure becomes true, so it is the first moment
  // the shared budget can be judged at all.
  return boundStaleTierToBudget({
    ...window,
    records,
    hydratedBytes: changed
      ? freshTierBytes(records, window.spans)
      : window.hydratedBytes,
    unsettledByteMessageIds: [],
  });
}

/**
 * Re-apply the shared budget to the stale tier, but only when it is breached.
 *
 * The tier is bounded where it is BUILT ({@link staleCarrySpans},
 * {@link retireCoveredStaleSpans}), and that holds only for as long as its
 * spans do not change size. They do: while a turn streams, its row can be held
 * ONLY by a stale copy, and {@link rewriteWindowMessage} grows that copy on
 * every delta. Nothing else re-bounds it in between -
 * {@link evictTranscriptWindowToBudget} judges `hydratedBytes`, which is the
 * FRESH tier - so a long turn would otherwise hold the carry over budget for
 * the rest of the turn.
 *
 * The cheap guard is the point. `boundedStaleSpans` scans every carried row id
 * to build its coverage set, which is proportional to the CARRY rather than to
 * the handful of records a rewrite touches; `staleTierBytes` is proportional
 * to the records the carry references - the ledger-dedup shape every other
 * byte figure here already pays. So the scan is paid at the crossing that
 * needs it and nowhere else.
 */
function boundStaleTierToBudget(window: TranscriptWindow): TranscriptWindow {
  if (window.staleSpans.length === 0) return window;
  if (
    window.hydratedBytes + staleTierBytes(window) <=
    TRANSCRIPT_WINDOW_MAX_BYTES
  ) {
    return window;
  }
  const staleSpans = boundedStaleSpans(
    window,
    window.staleSpans,
    window.hydratedBytes,
  );
  return staleSpans.length === window.staleSpans.length
    ? window
    : pruneUnreferencedRecords({ ...window, staleSpans });
}

function rewriteWindowMessage(
  window: TranscriptWindow,
  messageId: string,
  update: (message: Message) => Message,
  apply: {
    readonly charge: "now" | "deferred";
    readonly witnesses: ImageWitnessStore | null;
  },
): { readonly window: TranscriptWindow; readonly held: boolean } {
  const { charge, witnesses } = apply;
  // ONE ledger entry, wherever it is referenced from - the per-holder walk
  // this replaced was the same record rewritten once per span. A record held
  // ONLY by a stale span still counts as held, and rewriting it is
  // load-bearing rather than tidy: while a turn streams, its row can be
  // demoted to stale (a rebase, a genuine rewrite of a sibling), and if the
  // deltas stopped reaching that copy the display would freeze - or worse,
  // the applier would restart an empty live accumulator and the turn would
  // render as TWO blocks, the frozen prefix and the post-demotion remainder,
  // with an in-progress block (a compaction bar) duplicated across both.
  const entry = window.records.messages.get(messageId);
  const liveIndex = window.liveMessages.findIndex(
    (message) => message.messageId === messageId,
  );
  const held = entry !== undefined || liveIndex >= 0;
  if (!held) return { window, held: false };
  const clock = window.clock + 1;
  let records = window.records;
  let hydratedBytes = window.hydratedBytes;
  if (entry !== undefined) {
    const next = update(entry.record);
    // The rewritten object descends from the held one - its image evidence
    // (stamps, capture moment) follows it. On the image-apply path the
    // caller's `stampRewrittenCopies` then MERGES the applied source's stamp
    // into the carried set; without the carry it would seed from nothing and
    // strand every other source's stamp on the discarded object.
    witnesses?.carryRewrittenCopy(entry.record, next);
    // A `now` charge measures the NEW body once and lets the entry's held
    // figure supply the old one - no serialization of the previous copy, and
    // any residual staleness in the held figure self-corrects. `deferred`
    // skips even that one measure - see `unsettledByteMessageIds` for why the
    // streaming path cannot afford a serialization of a growing row per
    // delta.
    const bytes = charge === "deferred" ? entry.bytes : recordByteLength(next);
    const nextEntries = new Map(window.records.messages);
    nextEntries.set(messageId, {
      record: next,
      bytes,
      servedAt: entry.servedAt,
      // A write, which is what `touchedAt` records - bumped ONCE, on the
      // record, so every span DRAWING it warms identically and a span merely
      // holding it as a rider inherits nothing. Warmth is the only thing
      // protecting a stale carry, so this bump is what keeps the squeeze from
      // dropping the very copy the reader is watching stream.
      touchedAt: clock,
    });
    // No revision bump: a block delta touches record contents, never
    // membership, serve identity, or an id the backing folds read - this is
    // exactly the stability the (spans, revision)-keyed memos are built on.
    records = {
      messages: nextEntries,
      events: window.records.events,
      revision: window.records.revision,
    };
    if (charge === "now" && bytes !== entry.bytes) {
      // The fresh term moves only when a FRESH span references the record; a
      // stale-exclusive rewrite is the stale tier's business and the bound
      // below re-judges it.
      const freshReferenced = window.spans.some((span) =>
        span.messageIds.includes(messageId),
      );
      if (freshReferenced) hydratedBytes += bytes - entry.bytes;
    }
  }
  const liveMessages =
    liveIndex < 0
      ? window.liveMessages
      : window.liveMessages.map((message, index) => {
          if (index !== liveIndex) return message;
          const next = update(message);
          if (next !== message) witnesses?.carryRewrittenCopy(message, next);
          return next;
        });
  const next: TranscriptWindow = {
    ...window,
    records,
    liveMessages,
    hydratedBytes,
    unsettledByteMessageIds:
      charge === "now" ||
      entry === undefined ||
      window.unsettledByteMessageIds.includes(messageId)
        ? window.unsettledByteMessageIds
        : [...window.unsettledByteMessageIds, messageId],
    clock,
  };
  return {
    // A `now` charge lands immediately, so the budget can be judged
    // immediately. A `deferred` one leaves every byte figure untouched BY
    // CONSTRUCTION, so the bound's answer cannot have changed since the last
    // structural moment - it is skipped outright rather than re-derived per
    // token, and {@link settleWindowBytes} is where the streaming path's
    // bound lives.
    window: charge === "now" ? boundStaleTierToBudget(next) : next,
    held: true,
  };
}

function spanExtent(span: HydratedSpan): number {
  return span.rowIds.length;
}

function spanEnd(span: HydratedSpan): number {
  return span.fromOrdinal + spanExtent(span);
}

/**
 * What a span's row context costs on the wire it arrived on.
 *
 * The whole map in one encode rather than a per-entry sum, because that is the
 * shape the host actually sent and the shape this span actually holds; summing
 * the values would quietly drop the row ids, which are the larger half of a map
 * whose values are often a single scalar.
 *
 * An EMPTY map is 0, not the two bytes `{}` encodes to. Sparse-by-construction
 * means most spans have no context at all, and charging them for the empty
 * object would put a constant on every span that says nothing about what it
 * retains.
 */
function contextByteLength(
  rowContext: Readonly<Record<string, TranscriptRowContext>>,
): number {
  if (Object.keys(rowContext).length === 0) return 0;
  return utf8ByteLength(JSON.stringify(rowContext));
}

/**
 * Whether the skeleton contradicts these row ids at this placement.
 *
 * Only entries the client actually HOLDS are compared. A hole is not a
 * mismatch: the tail rides the snapshot and the eager tail request goes out
 * before any skeleton chunk has landed, so requiring a full skeleton here
 * would reject exactly the hydration that has to work first. The chunk that
 * later fills the hole re-runs this check and drops the body then - see
 * {@link applySkeletonChunk}.
 */
function skeletonContradicts(
  window: TranscriptWindow,
  fromOrdinal: number,
  rowIds: readonly string[],
): boolean {
  for (let index = 0; index < rowIds.length; index += 1) {
    const known = window.skeleton[fromOrdinal + index];
    if (known !== undefined && known.rowId !== rowIds[index]) {
      return true;
    }
  }
  return false;
}

/**
 * Concatenate groups of record ids, keeping each ONCE at its first occurrence.
 *
 * POSITION comes from the first occurrence, because the groups arrive in
 * ordinal order and that ordering is what makes the result transcript-ordered.
 * The BODY question the pre-ledger merge had to answer here - which member's
 * copy wins when they disagree - no longer exists: the ids resolve through
 * the ledger, whose one entry per record was already replaced by the incoming
 * serve at the seat. Single ownership is the stronger form of the old
 * incoming-copy-wins rule: keeping a superseded body is unrepresentable.
 */
function dedupeIdsInOrder(
  groups: readonly (readonly string[])[],
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const id of group) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Does this span hold any of `recordIds`?
 *
 * One set for both id spaces, because every caller asks the same question of
 * both halves - "does this span still hold a copy of that record" - and the two
 * do not collide in any way this module depends on.
 */
function spanSharesRecord(
  span: HydratedSpan,
  recordIds: ReadonlySet<string>,
): boolean {
  if (recordIds.size === 0) return false;
  return (
    span.messageIds.some((id) => recordIds.has(id)) ||
    span.eventIds.some((id) => recordIds.has(id))
  );
}

/**
 * Insert one span, merging it with every span it touches or overlaps.
 *
 * Merging matters for more than tidiness: a reader scrolling upward produces a
 * run of abutting ranges, and left unmerged they would each keep their own
 * copy of a turn that straddles their boundary. Records are concatenated in
 * ordinal order and deduped by id, which is what preserves transcript order.
 *
 * Where two spans overlap, the INCOMING copy wins - both the row ids and the
 * record bodies (see {@link dedupePreferringIncoming}). They came from a later
 * response under the same epoch, so where the two disagree the newer one is
 * the host's current answer.
 *
 * ## One record, several spans - resolved by FRESHNESS, not by dropping a span
 *
 * A steered turn is MANY rows over ONE record set, so its slices can sit in
 * several spans that never merge: `SPAN_MERGE_MAX_BYTES` refuses to absorb a
 * touching neighbour past the cap, and a gap in the middle of a turn - `[10,14]`
 * held, `[15,17]` evicted, `[18,20]` re-fetched - leaves two that do not even
 * touch. Each carries that turn's whole record set, so the same record id lives
 * in both.
 *
 * That is only a problem if something picks between the copies by POSITION, and
 * for a while something did: {@link hydratedRecords} deduped in ordinal order,
 * so the EARLIEST span's copy won however old it was, and a turn re-served with
 * a new body kept rendering the previous one. The ledger closes that class
 * outright: the id resolves to ONE body, replaced at the seat, so position and
 * body cannot disagree.
 *
 * It must not be fixed HERE, by dropping the sharing span, and the reason is
 * worth stating because that is what this function used to do. Sharing is
 * symmetric: `[10,14]` and `[18,20]` hold each other's records, so seating
 * either one evicts the other. If both are on screen - which is precisely what
 * a steered turn looks like, an assistant slice, a steer bubble, another slice
 * - the planner re-requests whichever was just dropped, and its answer drops
 * the other. Nothing converges, no row ever finishes rendering, and the client
 * asks the host for the same two ranges for as long as the reader looks at that
 * turn. Row coverage is what makes a span worth keeping; the body it happens to
 * hold is not, because another span holding a fresher copy of that body renders
 * these rows perfectly well.
 *
 * The converse - keeping the rows and STRIPPING the shared records - is the
 * other tempting shape and is unsound for a reason this file makes easy to
 * miss: {@link evictTranscriptWindowToBudget} drops whole spans by LRU with no
 * notion of sharing, so the stripped span can outlive the one it borrowed from.
 * Its rows are then covered (the planner sees no gap) and bodyless (nothing can
 * render them), which is a silent blank with no route back.
 */
function insertSpan(
  /**
   * The ledger the spans' references resolve through, POST-seat - the merge
   * ceiling is derived from it at this moment and never retained (see
   * {@link derivedSpanBytes}): a retained figure is stored-at-insert with a
   * different source, and a streaming rewrite between merges would make it
   * stale again - the 900-KB-tail-absorbs-a-neighbour hazard the cap exists
   * to refuse.
   */
  ledger: RecordLedger,
  unsettled: ReadonlySet<string>,
  spans: readonly HydratedSpan[],
  incoming: HydratedSpan,
): readonly HydratedSpan[] {
  const untouched: HydratedSpan[] = [];
  const overlapping: HydratedSpan[] = [];
  // Adjacency is absorbed only while the result stays a unit eviction can
  // reclaim (see SPAN_MERGE_MAX_BYTES). Overlap is not optional: two spans
  // covering one ordinal would place that row twice.
  //
  // The ceiling metric is per-span and CHARGE-INCLUSIVE - each member's
  // records at full size, aliases not deduped. A deduped ceiling would let
  // spans sharing a turn's records merge into the unbounded tail the cap
  // exists to prevent.
  let mergedBytes = derivedSpanBytes(ledger, incoming, unsettled);
  for (const span of spans) {
    const disjoint =
      spanEnd(span) < incoming.fromOrdinal ||
      span.fromOrdinal > spanEnd(incoming);
    if (disjoint) {
      untouched.push(span);
      continue;
    }
    const touchesOnly =
      spanEnd(span) === incoming.fromOrdinal ||
      spanEnd(incoming) === span.fromOrdinal;
    const spanBytes = derivedSpanBytes(ledger, span, unsettled);
    if (touchesOnly && mergedBytes + spanBytes > SPAN_MERGE_MAX_BYTES) {
      untouched.push(span);
      continue;
    }
    mergedBytes += spanBytes;
    overlapping.push(span);
  }
  if (overlapping.length === 0) {
    return [...untouched, incoming].sort(
      (left, right) => left.fromOrdinal - right.fromOrdinal,
    );
  }

  const members = [...overlapping, incoming].sort(
    (left, right) => left.fromOrdinal - right.fromOrdinal,
  );
  const fromOrdinal = Math.min(...members.map((span) => span.fromOrdinal));
  const toOrdinal = Math.max(...members.map(spanEnd));
  // Row ids are seated by ORDINAL rather than concatenated: the members
  // overlap, so appending would double-count the shared rows. Incoming last so
  // it overwrites where it disagrees.
  const rowIds: string[] = new Array<string>(toOrdinal - fromOrdinal).fill("");
  for (const span of [...overlapping, incoming]) {
    for (let index = 0; index < span.rowIds.length; index += 1) {
      rowIds[span.fromOrdinal + index - fromOrdinal] = span.rowIds[index];
    }
  }
  const messageIds = dedupeIdsInOrder(members.map((span) => span.messageIds));
  const eventIds = dedupeIdsInOrder(members.map((span) => span.eventIds));
  // Incoming last, so a re-served row's context supersedes the held copy for
  // the same reason its row id does.
  const rowContext = Object.assign(
    {},
    ...overlapping.map((span) => span.rowContext),
    incoming.rowContext,
  ) as Readonly<Record<string, TranscriptRowContext>>;
  // Re-measured rather than summed from the members: the merge DEDUPES the
  // context map, so adding the members' charges would bill every row a
  // re-served span shares with the one it superseded.
  const contextBytes = contextByteLength(rowContext);
  const merged: HydratedSpan = {
    fromOrdinal,
    rowIds,
    rowContext,
    messageIds,
    eventIds,
    contextBytes,
  };
  return [...untouched, merged].sort(
    (left, right) => left.fromOrdinal - right.fromOrdinal,
  );
}

/**
 * How a snapshot's revision relates to the one this window holds.
 *
 * Extracted so {@link applyWindowedSnapshot} states the three outcomes once
 * rather than re-deriving each from the same four conjuncts; the reasoning for
 * each is at the call site and on
 * {@link TranscriptWindow.indexRevisionRebuilding}.
 */
type SnapshotRevisionVerdict = "straggler" | "gap" | "current";

function classifySnapshotRevision(
  window: TranscriptWindow,
  indexRevision: number | null,
  rebased: boolean,
): SnapshotRevisionVerdict {
  // A rebase replaces the coordinate space outright, and `null` announces a
  // rebuild - neither is a comparison against the held counter.
  if (rebased || indexRevision === null) return "current";
  // One frame's exemption after a rebuild boundary: the counter behind this
  // frame may not be the counter the window holds.
  if (window.indexRevisionRebuilding) return "current";
  if (indexRevision < window.indexRevision) return "straggler";
  return indexRevision > window.indexRevision ? "gap" : "current";
}

function provisionalLiveMessagesForSnapshot(input: {
  readonly window: TranscriptWindow;
  readonly missedDeltas: boolean;
  readonly rebased: boolean;
  readonly rebuilding: boolean;
}): readonly Message[] {
  return input.window.liveMessages.filter(
    (message) =>
      (message.role === "assistant" &&
        isTransientLiveAssistantMessageId(message.messageId)) ||
      ((input.rebased ||
        input.missedDeltas ||
        input.window.invalidated ||
        input.rebuilding) &&
        message.role === "user"),
  );
}

function provisionalLiveEventsForSnapshot(input: {
  readonly window: TranscriptWindow;
  readonly missedDeltas: boolean;
  readonly rebased: boolean;
  readonly rebuilding: boolean;
}): readonly ChatEvent[] {
  return input.rebased ||
    input.missedDeltas ||
    input.window.invalidated ||
    input.rebuilding
    ? input.window.liveEvents
    : [];
}

function namedLiveEventIds(
  window: TranscriptWindow,
  skeletonRowIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const projectedRows = projectTranscriptRows({
    messages: window.liveMessages,
    events: window.liveEvents,
    activeTurnId: null,
    chatId: "",
  });
  const named = setupEventIdsNamedBySkeleton(projectedRows, skeletonRowIds);
  const namedAssistantTurnKeys = new Set(
    [...skeletonRowIds]
      .map(assistantRowTurnKey)
      .filter((turnKey): turnKey is string => turnKey !== null),
  );
  // A decorating event can survive a rebase after the old span carrying its
  // assistant dependency is discarded. Its turn key still provides the exact
  // link to the replacement skeleton row, so do not require local projection
  // to reconstruct an association the skeleton already names.
  for (const event of window.liveEvents) {
    if (
      isTurnDecoratingEvent(event) &&
      typeof event.turnId === "string" &&
      namedAssistantTurnKeys.has(event.turnId)
    ) {
      named.add(event.eventId);
    }
  }
  for (const row of projectedRows) {
    if (row.source.kind === "setup-card") continue;
    if (!skeletonRowIds.has(row.rowId)) continue;
    for (const eventId of rowRecordIds(row.source).eventIds) {
      named.add(eventId);
    }
  }
  return named;
}

function setupEventIdsNamedBySkeleton(
  projectedRows: readonly TranscriptRowDescriptor[],
  skeletonRowIds: ReadonlySet<string>,
): Set<string> {
  const setupCountByCreatedAt = new Map<string, number>();
  for (const rowId of skeletonRowIds) {
    if (!rowId.startsWith("setup-card:")) continue;
    const createdAt = rowId.slice(rowId.lastIndexOf(":") + 1);
    setupCountByCreatedAt.set(
      createdAt,
      (setupCountByCreatedAt.get(createdAt) ?? 0) + 1,
    );
  }
  const named = new Set<string>();
  const setupRowsByCreatedAt = new Map<string, TranscriptRowDescriptor[]>();
  for (const row of projectedRows) {
    if (row.source.kind !== "setup-card") continue;
    const createdAt = String(row.createdAt);
    const rows = setupRowsByCreatedAt.get(createdAt) ?? [];
    rows.push(row);
    setupRowsByCreatedAt.set(createdAt, rows);
  }
  for (const [createdAt, rows] of setupRowsByCreatedAt) {
    const count = setupCountByCreatedAt.get(createdAt) ?? 0;
    if (count === 0) continue;
    for (const row of rows.slice(-count)) {
      if (row.source.kind !== "setup-card") continue;
      for (const eventId of rowRecordIds(row.source).eventIds) {
        named.add(eventId);
      }
    }
  }
  return named;
}

function rowProducingEventIds(
  messages: readonly Message[],
  events: readonly ChatEvent[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const row of projectTranscriptRows({
    messages,
    events,
    activeTurnId: null,
    chatId: "",
  })) {
    for (const eventId of rowRecordIds(row.source).eventIds) ids.add(eventId);
  }
  return ids;
}

function reconcileSnapshotProvisionalRecords(
  window: TranscriptWindow,
): TranscriptWindow {
  if (
    !window.skeletonComplete ||
    (window.snapshotProvisionalMessageIds.length === 0 &&
      window.snapshotProvisionalEventIds.length === 0)
  ) {
    return window;
  }
  const provisionalIds = new Set(window.snapshotProvisionalMessageIds);
  const skeletonRowIds = new Set(
    window.skeleton.flatMap((entry) =>
      entry === undefined ? [] : [entry.rowId],
    ),
  );
  const skeletonAssistantTurnKeys = new Set(
    [...skeletonRowIds]
      .map(assistantRowTurnKey)
      .filter((turnKey): turnKey is string => turnKey !== null),
  );
  const liveMessages = window.liveMessages.filter((message) => {
    if (!provisionalIds.has(message.messageId)) return true;
    switch (message.role) {
      case "user":
        // The shared row projection keys a durable user row directly by its
        // message id (`row-projection.ts`), so these identity spaces coincide.
        return skeletonRowIds.has(message.messageId);
      case "assistant":
        return skeletonAssistantTurnKeys.has(assistantTurnKey(message));
    }
  });
  const provisionalEventIds = new Set(window.snapshotProvisionalEventIds);
  const namedEventIds = namedLiveEventIds(window, skeletonRowIds);
  const liveEvents = window.liveEvents.filter(
    (event) =>
      !provisionalEventIds.has(event.eventId) ||
      namedEventIds.has(event.eventId),
  );
  return {
    ...window,
    liveMessages,
    liveEvents,
    snapshotProvisionalMessageIds: [],
    snapshotProvisionalEventIds: [],
  };
}

function selectSnapshotLiveRecords<T>(
  current: readonly T[],
  provisional: readonly T[],
  replace: boolean,
): readonly T[] {
  return replace ? provisional : current;
}

/**
 * Seat a windowed snapshot.
 *
 * A snapshot is authoritative about the epoch, the row count and the tail, and
 * about nothing else: the skeleton arrives separately, and the spans already
 * held stay held when the epoch is unchanged. That is what makes an aux-only
 * re-broadcast (a queue change, an approval) cheap - it must not throw away a
 * scrollback the reader is looking at.
 *
 * A CHANGED epoch is the opposite case and drops everything: ordinals under
 * the new epoch name different rows, so every held body is unaddressable and
 * every skeleton entry is stale.
 */
export function applyWindowedSnapshot(
  window: TranscriptWindow,
  input: {
    readonly epoch: number;
    readonly rowCount: number;
    /**
     * The revision the HOST believes this client's index is at, or `null` when
     * it is about to restream the whole skeleton and there is nothing to
     * compare. See the field's doc on the wire schema.
     */
    readonly indexRevision: number | null;
    readonly tail: ChatTranscriptWindow;
  },
  /**
   * The streaming turn, if any. A bulk snapshot serialized before newer block
   * deltas can arrive after they were applied, and its tail seat must not let
   * the older served copy displace the delta-rewritten one - the same
   * held-copy preference the range seat applies. See
   * {@link preferFresherHeldMessages}.
   */
  activeTurnId: string | null,
  /**
   * The session's witness store, or `null` where none exists. An accepted
   * concrete snapshot RESETS lineage for the records it serves - it is the
   * authoritative-replacement member of the boundary, where a range seat
   * merely stamps.
   */
  witnesses: ImageWitnessStore | null,
): TranscriptWindow {
  // A snapshot from an epoch this window has already LEFT describes a
  // coordinate space whose ordinals were renumbered by the very change that
  // moved this window on. Taken as a rebase - which `!==` does - it replaces
  // the skeleton, the spans and the epoch with obsolete coordinates, and on an
  // idle chat nothing later repairs that. `applyIndexChange` has compared the
  // epoch DIRECTIONALLY since the delta path was fixed; this path had not.
  //
  // But only for a CONCRETE revision, and that qualifier is the whole guard.
  // The host stamps `transcriptEpoch: view.epoch` - always its current epoch -
  // while `indexRevision` comes from the subscriber's index state
  // (`chat-session-manager.ts:34710-34717`). For a snapshot's epoch to be BELOW
  // this client's, the host's own epoch must have gone backwards, which happens
  // only on a fresh `TranscriptViewCache` - and a fresh cache means a fresh
  // subscriber, whose state is not `held`, so that frame necessarily carries
  // `indexRevision: null`.
  //
  // So: older epoch + non-null revision is unreachable except by reordering,
  // and is discarded. Older epoch + null revision is a host restart announcing
  // itself, and discarding THAT strands the client at a dead epoch for the life
  // of the connection - the same failure refusing a lower revision would cause,
  // one field over. See {@link TranscriptWindow.indexRevisionRebuilding}.
  if (input.indexRevision !== null && input.epoch < window.epoch) return window;
  const rebased = input.epoch !== window.epoch;
  const clock = window.clock + 1;
  // A same-epoch snapshot whose revision RAN AHEAD of this client's is proof
  // that index deltas were emitted against the skeleton it is holding and never
  // arrived. An aux-only snapshot restreams no skeleton, so nothing in this
  // frame would repair it; declaring the index void is what gets it
  // re-requested. Without this, a lost `updated`-only frame survives every
  // subsequent auxiliary snapshot and the stale body is permanent.
  //
  // `null` is the host saying it holds no index for this subscriber and a full
  // skeleton is on its way - a bootstrap or a post-resnapshot rebuild. Treating
  // that as a gap would invalidate the window the incoming chunks are about to
  // fill and request another resnapshot for it, which is a loop.
  //
  // And only AHEAD: a snapshot serialized before a delta this client already
  // applied is a straggler, not a gap.
  //
  // ## What `indexRevision === null` means to each counter, in one place
  //
  // Five readings hang off this one signal, and three of them move different
  // counters in different directions AT THE SAME BOUNDARY. That looks like
  // inconsistency and is not - each counter is scoped differently on the HOST -
  // so the set is stated together, because a reviewer who saw one of them alone
  // proposed "fixing" it to match the others, and that proposal was a livelock.
  //
  // 1. NOT a gap (here). `missedDeltas` requires a non-null revision: null is
  //    the host announcing a rebuild, and treating it as loss would invalidate
  //    the window the incoming chunks are about to fill.
  // 2. The REVISION is RETAINED (below). The host's counter is per-VIEW -
  //    `TranscriptViewCache` holds one per chat session and restarts it only on
  //    an epoch change - so the deltas after a rebuild carry it forward. A
  //    client that reset to 0 would read the next delta as a gap, invalidate,
  //    resnapshot, be told null again, and reset again: an unbounded loop.
  // 3. The SKELETON COVERAGE is RESET (below). Completeness is a per-STREAM
  //    fact, and the replacement stream merges into the array the previous one
  //    left - so coverage inherited from the old stream would vouch for a
  //    replacement chunk that never arrived.
  // 4. The SUMMARY GENERATION is RESET (`chat-session-store.ts`). That counter
  //    is per-SUBSCRIBER on the host, so a rebuild really can restart it at 1
  //    and collide with the value this client holds.
  // 5. The WATCHDOG DEADLINE restarts (`chat-session-store.ts`). A rebuild is a
  //    fresh stream arriving; an aux-only snapshot is not, and must not
  //    postpone a stall already being measured.
  // 6. The IN-FLIGHT RANGE SLOT is RELEASED (`chat-session-store.ts`). It names
  //    a request sent on THIS connection, so it is per-subscriber like the
  //    summary generation: a reconnect mints a fresh subscriber, its state is
  //    `none`, and the request really did die with the old connection.
  //    Releasing it on an aux-only snapshot instead re-asks for a range already
  //    being answered, once per aux frame, and the resulting requests evict the
  //    original's ledger entry at the cap - so the answer it was waiting for
  //    arrives untracked and is discarded.
  //
  // Per-view retains. Per-subscriber and per-stream reset. That is the whole
  // rule, and it is a fact about the host rather than a convention here.
  // A same-epoch snapshot BEHIND the revision this client has already applied,
  // with no rebuild between them, is describing an index the host has since
  // moved past - it can only have arrived late. Its TRANSCRIPT half is refused
  // whole: taking the revision rewinds a valid index, so the host's next delta
  // reads as a gap and voids it, and the same branch would adopt the older
  // `rowCount` and seat an older tail at the newest `servedAt`, outranking the
  // copy the client correctly holds.
  //
  // Its AUXILIARY half is still applied, by the caller, and that asymmetry is
  // the point rather than an oversight: the aux fields are last-write-wins and
  // every subsequent broadcast rewrites them, so an old one costs a frame of
  // staleness. The index has no such self-correction - that is the whole reason
  // this revision exists - so a rewind there is permanent.
  //
  // Two aux paths were checked against that claim rather than assumed to fit
  // it. `accumulatedFileChangeSummaries` is ACCUMULATED from chunks rather than
  // carried on the snapshot, and its generation reset is keyed on a `null`
  // revision, so a straggler cannot touch either. The one that does regress is
  // `clearResnapshotRequest()`, which the caller runs unconditionally on the
  // reasoning that "a fresh snapshot IS the answer an invalidated window was
  // waiting for" - untrue of a late one. It self-corrects: refusing this frame
  // leaves `invalidated` standing, so the caller's `requestPlannedHydration()`
  // asks again, and the cost is one redundant resnapshot rather than a stall.
  const verdict = classifySnapshotRevision(
    window,
    input.indexRevision,
    rebased,
  );
  if (verdict === "straggler") return window;
  const reconciledWindow = reconcileSnapshotProvisionalRecords(window);
  const missedDeltas = verdict === "gap";
  const provisionalLiveMessages = provisionalLiveMessagesForSnapshot({
    window: reconciledWindow,
    missedDeltas,
    rebased,
    rebuilding: input.indexRevision === null,
  });
  const provisionalLiveEvents = provisionalLiveEventsForSnapshot({
    window: reconciledWindow,
    missedDeltas,
    rebased,
    rebuilding: input.indexRevision === null,
  });
  const replaceLiveRecords = reconciledWindow.invalidated;
  // Snapshots travel on the bulk lane and can be overtaken by interactive live
  // records even when they announce a new epoch. Their later skeleton may
  // prove where a record belongs, but absence from it cannot prove that a live
  // record already held by this client was deleted.
  const { spans: carriedStaleSpans, ledger: carriedLedger } = carriedStaleTier(
    reconciledWindow,
    rebased || missedDeltas,
    input.rowCount,
  );
  const base: TranscriptWindow =
    rebased || missedDeltas
      ? {
          ...emptyTranscriptWindow(),
          // A settling turn is frozen into an unplaced live record before the
          // host assigns its durable row an ordinal. That stand-in is not tied
          // to the old coordinate space, so carry it across a rebase. This is
          // load-bearing when the new tail row exceeds the inline snapshot
          // budget: without it the transcript is empty until loadRange returns.
          // Accepted users are equally ordinal-less and arrive on the same
          // interactive lane, so a bulk snapshot cannot use an epoch change to
          // distinguish deletion from an acceptance that overtook it.
          // The transient assistant retires when a freshly served span carries
          // the same turn (see pruneSupersededLiveRecords), despite its
          // intentionally different id.
          liveMessages: provisionalLiveMessages,
          liveEvents: provisionalLiveEvents,
          epoch: input.epoch,
          rowCount: input.rowCount,
          indexRevision: input.indexRevision ?? 0,
          // A concrete revision here IS the new baseline, so the flag the
          // spread armed is spent. `null` leaves it armed for the restream.
          indexRevisionRebuilding: input.indexRevision === null,
          // The discarded bodies stay renderable while the replacement
          // skeleton streams in - the completion rebase renames almost no row
          // id, so repainting the whole chat as placeholders for the length
          // of the restream trades held content for a flash. See
          // {@link TranscriptWindow.staleSpans}. The ledger entries the carry
          // references travel with it, deferred debt included.
          staleSpans: carriedStaleSpans,
          records: carriedLedger,
          unsettledByteMessageIds:
            reconciledWindow.unsettledByteMessageIds.filter((id) =>
              carriedLedger.messages.has(id),
            ),
          invalidated: missedDeltas,
          // Carried for the same reason the void carries it: the reader has
          // not moved because the index was replaced, and the carry they are
          // looking at is bounded above before any new report can arrive.
          visibleOrdinals: reconciledWindow.visibleOrdinals,
          clock,
        }
      : {
          ...reconciledWindow,
          liveMessages: selectSnapshotLiveRecords(
            reconciledWindow.liveMessages,
            provisionalLiveMessages,
            replaceLiveRecords,
          ),
          liveEvents: selectSnapshotLiveRecords(
            reconciledWindow.liveEvents,
            provisionalLiveEvents,
            replaceLiveRecords,
          ),
          rowCount: input.rowCount,
          // A restreaming snapshot (`null`) leaves the held revision alone: the
          // skeleton chunks that follow do not carry one, so overwriting it here
          // would lose the client's place in the delta sequence.
          //
          // And the revision must NOT be reset to 0 here, which looks like the
          // symmetric thing to do and is a livelock. The host's counter is
          // per-VIEW, not per-subscriber - `TranscriptViewCache` holds one per
          // chat session and restarts it only on an epoch change - so the
          // deltas after a rebuild carry it forward from wherever it was. A
          // client that reset to 0 would read the very next delta as a gap
          // (`revision !== held + 1`), invalidate, resnapshot, receive `null`
          // again, and reset again, forever.
          //
          // While REBUILDING this adopts whatever the host sends, including a
          // lower number: the boundary said the counter may have restarted, and
          // this frame is the first authority on where it restarted at.
          indexRevision: input.indexRevision ?? window.indexRevision,
          // Spent by a concrete revision, re-armed by another rebuild. Exactly
          // one concrete frame is exempt from the direction rules, so the
          // suppression cannot outlive the boundary that granted it.
          indexRevisionRebuilding: input.indexRevision === null,
          // RE-DERIVED, never carried, and FALSE outright at a rebuild.
          //
          // Two different losses, one field. A same-epoch snapshot can raise
          // `rowCount` - an `indexChanged` append frame dropped while the
          // stream survived is exactly that - and spreading `...window` carried
          // `skeletonComplete: true` across the change, so the client declared
          // a SHORT skeleton complete and never repaired it.
          //
          // The other is the rebuild. `indexRevision === null` says a full
          // replacement skeleton is coming, and it streams into the array this
          // window already holds - so completeness assembled from the PREVIOUS
          // stream would vouch for a replacement chunk that never arrived. The
          // entries stay (an invalidated host emits no skeleton at all, and
          // blanking the transcript to detect a maybe-dropped chunk is a worse
          // trade); what goes is the CLAIM that they are a complete delivery.
          // `skeletonStreamCoveredThrough` below is what re-establishes it, and
          // the completion watchdog is what recovers a stream that never comes.
          skeletonComplete:
            input.indexRevision !== null &&
            reconciledWindow.skeletonComplete &&
            coversEveryOrdinal(reconciledWindow.skeleton, input.rowCount),
          skeletonStreamCoveredThrough:
            input.indexRevision === null
              ? 0
              : reconciledWindow.skeletonStreamCoveredThrough,
          invalidated: false,
          clock,
        };
  const heldRecords = hydratedRecords(reconciledWindow);
  const provisionalRowProducingEventIds = rowProducingEventIds(
    heldRecords.messages,
    heldRecords.events,
  );
  const snapshotProvisionalMessageIds = new Set([
    ...reconciledWindow.snapshotProvisionalMessageIds,
    ...provisionalLiveMessages.map((message) => message.messageId),
  ]);
  const snapshotProvisionalEventIds = new Set([
    ...reconciledWindow.snapshotProvisionalEventIds,
    ...provisionalLiveEvents
      .filter((event) => provisionalRowProducingEventIds.has(event.eventId))
      .map((event) => event.eventId),
  ]);
  const heldProvisionalMessageIds = new Set(
    base.liveMessages.map((message) => message.messageId),
  );
  const heldProvisionalEventIds = new Set(
    base.liveEvents.map((event) => event.eventId),
  );
  const snapshotBase = {
    ...base,
    snapshotProvisionalMessageIds: [...snapshotProvisionalMessageIds].filter(
      (messageId) => heldProvisionalMessageIds.has(messageId),
    ),
    snapshotProvisionalEventIds: [...snapshotProvisionalEventIds].filter(
      (eventId) => heldProvisionalEventIds.has(eventId),
    ),
    unavailableRowIds: [],
    unavailableRowOrdinals: [],
  };

  // `rowCount` is authoritative even when a same-epoch `null` revision merely
  // announces a replacement skeleton stream. A fresh host/view cache can
  // restart at the same numeric epoch, so neither `rebased` nor `missedDeltas`
  // necessarily fires. Bound the retained coordinate data now: otherwise old
  // ordinals beyond the new end make final-skeleton completeness impossible,
  // and a deleted transient can survive every rebuild.
  const boundedBase = boundWindowToRowCount(snapshotBase, input.rowCount);
  const tailRowIds = tailRowIdsFor(boundedBase, input);
  if (tailRowIds === null) {
    // Two different "no tail" answers, and only one of them is inert.
    //
    // `fromOrdinal >= rowCount` is a transcript with no tail rows at all -
    // nothing to seat and nothing held that could be stale.
    //
    // A tail that EXISTS and arrived empty is the other one: the snapshot
    // legitimately omitted it because its last row exceeds the inline budget.
    // A same-epoch reconnect gets here holding the PREVIOUS tail span, and
    // keeping it is what makes `isTailHydrated()` answer true - so no range is
    // ever planned and the client shows a pre-reconnect, possibly half-written
    // row for as long as the session lives. Drop what overlaps the omitted
    // region so the planner sees the gap and fetches the authoritative body.
    return input.rowCount - input.tail.fromOrdinal > 0
      ? dropSpansOverlappingFrom(boundedBase, input.tail.fromOrdinal)
      : boundedBase;
  }
  // Keyed by row id exactly as a range's is, so a tail seated on the
  // positional ids `tailRowIdsFor` falls back to simply misses every lookup
  // rather than seating context under the wrong row.
  const tailRowContext = input.tail.rowContext ?? {};
  return seatSnapshotTailSpan({
    base: boundedBase,
    tail: input.tail,
    rowIds: tailRowIds,
    rowContext: tailRowContext,
    clock,
    activeTurnId,
    witnesses,
  });
}

/**
 * Stamp what a seat just landed: a served copy infers its per-source stamps
 * by unique content match, a held substitute already carries its own (the
 * stamping is idempotent per object). Shared by both seat leaves so neither
 * can drift to stamping a different set than it seated.
 */
function stampSeatedMessages(
  witnesses: ImageWitnessStore | null,
  messages: readonly Message[],
): void {
  if (witnesses === null) return;
  for (const message of messages) witnesses.stampSeatedCopy(message);
}

function seatSnapshotTailSpan(input: {
  readonly base: TranscriptWindow;
  readonly tail: ChatTranscriptWindow;
  readonly rowIds: readonly string[];
  readonly rowContext: Readonly<Record<string, TranscriptRowContext>>;
  readonly clock: number;
  readonly activeTurnId: string | null;
  readonly witnesses: ImageWitnessStore | null;
}): TranscriptWindow {
  const { base, tail, rowIds, rowContext, clock, witnesses } = input;
  const conflictingRowIds = incompleteRowIdsToWithhold(tail.incompleteRowIds);
  if (conflictingRowIds.size > 0) {
    return seatNonConflictingTailRuns(
      {
        ...input,
        base: dropSpansOverlappingFrom(base, tail.fromOrdinal),
      },
      conflictingRowIds,
    );
  }
  const completeBase = withoutUnavailableRows(
    base,
    declaredCompleteTailRowIds(tail),
    tail.fromOrdinal,
  );
  const contextBytes = contextByteLength(rowContext);
  // An accepted concrete snapshot is the authoritative-replacement member of
  // the lineage boundary: it RESETS witnesses and lineage for exactly the
  // records it seats here - conflicting/withheld records never reach this
  // leaf, so a record the snapshot did not actually serve keeps its evidence.
  // Reset BEFORE the comparison below, deliberately: a response already in
  // flight for a just-served record forfeits rule-2 protection (the corner
  // the design accepts knowingly - it sits inside the rule-4 residual).
  if (witnesses !== null) {
    for (const message of tail.messages) {
      if (message.role === "assistant") {
        witnesses.resetServedRecord(message.messageId);
      }
    }
  }
  // The same held-copy preference the range seat applies: a bulk snapshot
  // can be serialized before block deltas that arrive ahead of it, and its
  // tail must not displace the delta-rewritten copy of the streaming body.
  const messages = preferFresherHeldMessages(
    completeBase,
    tail.messages,
    input.activeTurnId,
    witnesses,
  );
  // Captures land post-reset: a snapshot-seated copy stamps against the
  // record's cleared occurrence list, which is the fresh-lineage floor rule 3
  // reads.
  stampSeatedMessages(witnesses, messages);
  // Records into the LEDGER first, so the span's references resolve and the
  // merge ceiling below derives from post-seat truth.
  const records = seatLedgerRecords(
    completeBase.records,
    messages,
    tail.events,
    clock,
  );
  const tailSpan: HydratedSpan = {
    fromOrdinal: tail.fromOrdinal,
    rowIds,
    rowContext,
    messageIds: messages.map((message) => message.messageId),
    eventIds: tail.events.map((event) => event.eventId),
    contextBytes,
  };
  const spans = insertSpan(
    records,
    new Set(completeBase.unsettledByteMessageIds),
    completeBase.spans,
    tailSpan,
  );
  return retireCoveredStaleSpans(
    pruneSupersededLiveRecords(
      {
        ...completeBase,
        records,
        spans,
        hydratedBytes: freshTierBytes(records, spans),
      },
      servedAssistantTurns(
        declaredCompleteTailRowIds(tail),
        messages,
        tail.events,
      ),
    ),
  );
}

function seatNonConflictingTailRuns(
  input: {
    readonly base: TranscriptWindow;
    readonly tail: ChatTranscriptWindow;
    readonly rowIds: readonly string[];
    readonly rowContext: Readonly<Record<string, TranscriptRowContext>>;
    readonly clock: number;
    readonly activeTurnId: string | null;
    readonly witnesses: ImageWitnessStore | null;
  },
  conflictingRowIds: ReadonlySet<string>,
): TranscriptWindow {
  const conflictingTurnKeys = new Set(
    [...conflictingRowIds]
      .map(assistantRowTurnKey)
      .filter((turnKey): turnKey is string => turnKey !== null),
  );
  const messages = input.tail.messages.filter(
    (message) =>
      message.role !== "assistant" ||
      !conflictingTurnKeys.has(assistantTurnKey(message)),
  );
  const events = input.tail.events.filter(
    (event) =>
      !("turnId" in event) ||
      typeof event.turnId !== "string" ||
      !conflictingTurnKeys.has(event.turnId),
  );
  let next = input.base;
  let runStart = -1;
  let setupRowsBeforeRun = 0;
  for (let index = 0; index <= input.rowIds.length; index += 1) {
    const atEnd = index === input.rowIds.length;
    if (!atEnd && !conflictingRowIds.has(input.rowIds[index])) {
      if (runStart < 0) runStart = index;
      continue;
    }
    if (runStart >= 0) {
      const rowIds = input.rowIds.slice(runStart, index);
      const rowIdSet = new Set(rowIds);
      const records = recordsForRowIds(
        messages,
        events,
        rowIdSet,
        setupRowsBeforeRun,
      );
      const rowContext = Object.fromEntries(
        Object.entries(input.rowContext).filter(([id]) => rowIdSet.has(id)),
      );
      next = seatSnapshotTailSpan({
        base: next,
        tail: {
          ...input.tail,
          fromOrdinal: input.tail.fromOrdinal + runStart,
          rowIds,
          incompleteRowIds: input.tail.incompleteRowIds?.filter((id) =>
            rowIdSet.has(id),
          ),
          messages: records.messages,
          events: records.events,
          rowContext,
        },
        rowIds,
        rowContext,
        clock: input.clock,
        activeTurnId: input.activeTurnId,
        witnesses: input.witnesses,
      });
      setupRowsBeforeRun += rowIds.filter((rowId) =>
        rowId.startsWith("setup-card:"),
      ).length;
      runStart = -1;
    }
    if (!atEnd && input.rowIds[index].startsWith("setup-card:")) {
      setupRowsBeforeRun += 1;
    }
  }
  return withUnavailableRows(
    next,
    input.rowIds,
    input.tail.fromOrdinal,
    conflictingRowIds,
  );
}

/** Apply a snapshot's authoritative row-space boundary to retained state. */
function boundWindowToRowCount(
  window: TranscriptWindow,
  rowCount: number,
): TranscriptWindow {
  const skeleton = window.skeleton.slice(0, rowCount);
  const spans = window.spans.filter((span) => spanEnd(span) <= rowCount);
  // Zero rows is authority about the ROWS, not the coordinates: nothing the
  // stale bodies describe exists any more, whatever ordinals they carried.
  // A nonzero shrink keeps them - their rows may simply have been renumbered,
  // and the row merger already clamps display to the announced space.
  const staleSpans = rowCount === 0 ? [] : window.staleSpans;
  const changed =
    skeleton.length !== window.skeleton.length ||
    spans.length !== window.spans.length ||
    staleSpans.length !== window.staleSpans.length;
  if (!changed) return window;
  return pruneUnreferencedRecords({
    ...window,
    skeleton,
    spans,
    staleSpans,
    hydratedBytes: freshTierBytes(window.records, spans),
    skeletonStreamCoveredThrough: Math.min(
      window.skeletonStreamCoveredThrough,
      rowCount,
    ),
    skeletonComplete:
      window.skeletonComplete && coversEveryOrdinal(skeleton, rowCount),
  });
}

/**
 * Drop every span reaching at or past `fromOrdinal`.
 *
 * Whole spans, including one that only PARTIALLY overlaps. A span is the
 * smallest unit this module adds or reclaims - eviction drops whole spans, and
 * so does the skeleton's contradiction check - and splitting one here would
 * make this the only operation in the file that can produce a span the host
 * never sent. The rows below the boundary are re-fetched, which costs a round
 * trip; keeping a stale row costs a body that never corrects itself.
 */
function dropSpansOverlappingFrom(
  window: TranscriptWindow,
  fromOrdinal: number,
): TranscriptWindow {
  const kept = window.spans.filter((span) => spanEnd(span) <= fromOrdinal);
  if (kept.length === window.spans.length) return window;
  return pruneUnreferencedRecords({
    ...window,
    spans: kept,
    hydratedBytes: freshTierBytes(window.records, kept),
  });
}

/**
 * Row ids for the tail the snapshot shipped inline.
 *
 * The tail names its own rows when the host says so, exactly as a range does.
 * A host that sends none falls back to the POSITIONAL read this path used
 * before the field existed: the extent is `fromOrdinal` to `rowCount`, and the
 * ids are filled from the skeleton where the client already has it - the empty
 * string wherever it does not, which {@link reconcileSpansWithSkeleton} later
 * adopts.
 *
 * `null` means "no tail to seat": an empty tail is a real answer (a last row
 * too large for the tail budget), and it is the case
 * {@link planTranscriptHydration} exists to notice.
 */
function tailRowIdsFor(
  base: TranscriptWindow,
  input: {
    readonly rowCount: number;
    readonly tail: ChatTranscriptWindow;
  },
): readonly string[] | null {
  const extent = input.rowCount - input.tail.fromOrdinal;
  if (extent <= 0) return null;
  if (input.tail.messages.length === 0 && input.tail.events.length === 0) {
    return null;
  }
  const declared = input.tail.rowIds;
  // A host that named its rows is believed, including when it named NONE - a
  // zero-extent span would claim an ordinal range it does not cover, and the
  // planner is the thing that answers "the tail served nothing".
  if (declared !== undefined) return declared.length === 0 ? null : declared;
  const rowIds: string[] = [];
  for (let index = 0; index < extent; index += 1) {
    rowIds.push(base.skeleton[input.tail.fromOrdinal + index]?.rowId ?? "");
  }
  return rowIds;
}

/**
 * Place one chunk of the skeleton.
 *
 * Also the DELAYED identity resolution for anything hydrated before the
 * skeleton reached it: a chunk that lands on an ordinal whose held body claims
 * a different row id drops that body, and one that lands on a row seated with
 * no id at all supplies it. Both halves exist for the eager tail, which rides
 * the snapshot and is therefore always seated before any id is available to
 * check it against - see {@link reconcileSpansWithSkeleton}.
 */
export function applySkeletonChunk(
  window: TranscriptWindow,
  chunk: ChatSkeletonChunk,
): TranscriptWindow {
  if (chunk.epoch !== window.epoch) return window;
  const skeleton = [...window.skeleton];
  for (let index = 0; index < chunk.entries.length; index += 1) {
    skeleton[chunk.fromOrdinal + index] = chunk.entries[index];
  }
  const complete = chunk.isFinal;
  // How far THIS stream has reached, contiguously from ordinal 0.
  //
  // A chunk that does not begin exactly where the stream left off means its
  // predecessor was dropped, and the prefix stops advancing there for the rest
  // of the stream - which is the whole point: nothing a later chunk delivers
  // can repair a hole behind it.
  const coveredThrough =
    chunk.fromOrdinal === window.skeletonStreamCoveredThrough
      ? chunk.fromOrdinal + chunk.entries.length
      : window.skeletonStreamCoveredThrough;
  // Chunks were lost. Serving ordinals off an index the client KNOWS is
  // incomplete is the one thing the coordinate cannot survive, so declare it
  // void and let the caller re-request rather than render a transcript that is
  // silently missing rows.
  //
  // Length alone does not detect it. The skeleton is a SPARSE array, so its
  // length is one past the highest ordinal ever assigned - a dropped INTERIOR
  // chunk followed by the final one still ends at `rowCount`, and the holes in
  // between read as complete. Only every ordinal being present is completeness.
  //
  // And on a REBUILD not even that is enough, which is why the prefix above
  // exists. The replacement stream merges into the array the previous one left,
  // so a dropped chunk's ordinals are already occupied: there are no holes to
  // find, and `coversEveryOrdinal` vouches for entries this stream never sent.
  // Both conditions are kept because they catch different losses - the prefix
  // catches a chunk the current stream dropped, the scan catches an array that
  // has a hole for any other reason.
  const lost =
    complete &&
    (coveredThrough < window.rowCount ||
      !coversEveryOrdinal(skeleton, window.rowCount));
  const next: TranscriptWindow = {
    ...window,
    skeleton,
    skeletonComplete: complete && !lost,
    skeletonStreamCoveredThrough: coveredThrough,
    invalidated: window.invalidated || lost,
    clock: window.clock + 1,
  };
  const unavailableReconciled = reconcileUnavailableRowsWithSkeleton(
    next,
    chunk.fromOrdinal,
    chunk.fromOrdinal + chunk.entries.length,
  );
  return retireUnnamedStaleSpans(
    reconcileSpansWithSkeleton(
      unavailableReconciled,
      chunk.fromOrdinal,
      chunk.fromOrdinal + chunk.entries.length,
    ),
  );
}

/**
 * Once a replacement skeleton is COMPLETE, it is authority on which rows
 * exist: a stale span none of whose rows it names describes history that is
 * gone, and keeping it would let a deleted row render forever.
 *
 * Only on a complete skeleton - absence from a partial stream proves nothing -
 * and only from the skeleton-chunk path, which is where every post-rebase
 * restream ends. Whole spans: a kept span may still hold the odd unnamed row,
 * which the row merger simply never draws (it places by skeleton name or into
 * an entry-less hole, and a complete skeleton has no holes).
 *
 * That leniency is what makes {@link retireCoveredStaleSpans} the other half
 * of the rule rather than a duplicate of it: this pass keeps a span for its
 * survivors, and that one stops treating the unnamed rows beside them as
 * coverage still owed, so the span leaves once the survivors are served
 * instead of outliving the session.
 */
function retireUnnamedStaleSpans(window: TranscriptWindow): TranscriptWindow {
  if (!window.skeletonComplete || window.staleSpans.length === 0) {
    return window;
  }
  const named = skeletonOrdinalByRowId(window.skeleton);
  const kept = window.staleSpans.filter((span) =>
    span.rowIds.some((rowId) => named.has(rowId)),
  );
  return kept.length === window.staleSpans.length
    ? window
    : pruneUnreferencedRecords({ ...window, staleSpans: kept });
}

/**
 * Where the skeleton currently names each row id.
 *
 * ONE index, because four questions across two modules are the same question:
 * {@link retireUnnamedStaleSpans} asks whether a span names any surviving row,
 * {@link retireCoveredStaleSpans} asks it per row, `transcript-list-rows.ts`
 * asks WHERE so it can seat a live record the index has just started naming,
 * and {@link staleSpanVisibleIn} asks WHERE so it can reproduce that seat's
 * placement without re-deriving it. A second fold would be one edit away from
 * answering them differently, and the ordinal costs nothing over the
 * membership.
 *
 * Cached on the array IDENTITY, which changes exactly when the skeleton does -
 * a chunk landing or the index moving - while `transcriptListRows` re-runs on
 * every streaming token and `touchTranscriptRange` on every viewport report.
 * Built inline it would be an O(rowCount) Map per token, 20k entries on a long
 * chat, which is precisely the per-token O(history) work the windowed line
 * exists to delete. Safe to populate from a render - the value is a pure
 * function of the array it is keyed on, so a discarded render can only ever
 * write the same answer.
 */
const skeletonOrdinalCache = new WeakMap<
  readonly (RowSkeletonEntry | undefined)[],
  ReadonlyMap<string, number>
>();

export function skeletonOrdinalByRowId(
  skeleton: readonly (RowSkeletonEntry | undefined)[],
): ReadonlyMap<string, number> {
  const cached = skeletonOrdinalCache.get(skeleton);
  if (cached !== undefined) return cached;
  const ordinals = new Map<string, number>();
  skeleton.forEach((entry, ordinal) => {
    if (entry !== undefined) ordinals.set(entry.rowId, ordinal);
  });
  skeletonOrdinalCache.set(skeleton, ordinals);
  return ordinals;
}

/**
 * The row ids the FRESH tier DRAWS - one per row served, markers excluded.
 *
 * Two questions want it and both are about the stale tier losing to a fresh
 * copy: {@link retireCoveredStaleSpans} retires a carry the fresh tier has
 * replaced, and {@link staleSpanVisibleIn} refuses to warm a carry for a row
 * the fresh tier is the one putting on screen. Cached on the spans array for
 * the second of those, which runs on every viewport report.
 *
 * The marker is dropped rather than folded in, for the reason
 * {@link boundedStaleSpans} keeps two spaces: it is "identity unverified", not
 * an id, so one span's marker must never read as covering another's.
 */
const freshDrawnRowIdCache = new WeakMap<
  readonly HydratedSpan[],
  ReadonlySet<string>
>();

function freshDrawnRowIds(spans: readonly HydratedSpan[]): ReadonlySet<string> {
  const cached = freshDrawnRowIdCache.get(spans);
  if (cached !== undefined) return cached;
  const drawn = new Set<string>();
  for (const span of spans) {
    for (const rowId of span.rowIds) {
      if (rowId !== "") drawn.add(rowId);
    }
  }
  freshDrawnRowIdCache.set(spans, drawn);
  return drawn;
}

/**
 * Which carry the row merger would DRAW each row from, when two hold it.
 *
 * `seatStaleRows` walks the tier by descending derived serve stamp and places
 * a row at first encounter, so the freshest serve owns it and a staler
 * duplicate draws nothing. This reproduces that winner exactly rather than
 * approximating it: a forward scan of the STORED order taking `>` picks the
 * greatest stamp and, on a tie, the earliest span - which is what a stable
 * descending sort followed by first-match arrives at.
 *
 * The stamp is the record-grain derivation ({@link spanServeStamp}), so a
 * contested row resolves from the identical record-level figure both passes
 * read - two spans sharing the record tie by construction, and a span holding
 * a strictly fresher record for the turn outranks one holding only the older
 * slice. Cached on the array AND the ledger revision: a re-serve can move a
 * shared record's stamp without replacing the stale array, and revision is
 * bumped at exactly those structural moments.
 */
const staleRowOwnerCache = new WeakMap<
  readonly HydratedSpan[],
  {
    readonly revision: number;
    readonly owners: ReadonlyMap<string, HydratedSpan>;
  }
>();

/**
 * The stale tier by descending derived serve stamp - the walk order
 * `seatStaleRows` places rows in, exported so the row merger and
 * {@link staleRowOwners} cannot drift onto different orderings of the same
 * record-level figure. Stable, so a tie (two carries sharing the one ledger
 * copy) falls back to the stored ordinal order.
 */
export function staleSpansByFreshestServe(
  window: TranscriptWindow,
): readonly HydratedSpan[] {
  const stamps = new Map(
    window.staleSpans.map((span) => [span, spanServeStamp(window, span)]),
  );
  return [...window.staleSpans].sort(
    (left, right) => (stamps.get(right) ?? 0) - (stamps.get(left) ?? 0),
  );
}

function staleRowOwners(
  window: TranscriptWindow,
  spans: readonly HydratedSpan[],
): ReadonlyMap<string, HydratedSpan> {
  const cached = staleRowOwnerCache.get(spans);
  if (cached !== undefined && cached.revision === window.records.revision) {
    return cached.owners;
  }
  const stamps = new Map(
    spans.map((span) => [span, spanServeStamp(window, span)]),
  );
  const owners = new Map<string, HydratedSpan>();
  for (const span of spans) {
    const stamp = stamps.get(span) ?? 0;
    for (const rowId of span.rowIds) {
      if (rowId === "") continue;
      const seen = owners.get(rowId);
      if (seen === undefined || stamp > (stamps.get(seen) ?? 0)) {
        owners.set(rowId, span);
      }
    }
  }
  staleRowOwnerCache.set(spans, {
    revision: window.records.revision,
    owners,
  });
  return owners;
}

function reconcileUnavailableRowsWithSkeleton(
  window: TranscriptWindow,
  fromOrdinal: number,
  toOrdinal: number,
): TranscriptWindow {
  const keptIndexes = window.unavailableRowOrdinals.flatMap(
    (ordinal, index) => {
      if (ordinal < fromOrdinal || ordinal >= toOrdinal) return [index];
      return window.skeleton[ordinal]?.rowId === window.unavailableRowIds[index]
        ? [index]
        : [];
    },
  );
  if (keptIndexes.length === window.unavailableRowOrdinals.length)
    return window;
  return {
    ...window,
    unavailableRowIds: keptIndexes.map(
      (index) => window.unavailableRowIds[index],
    ),
    unavailableRowOrdinals: keptIndexes.map(
      (index) => window.unavailableRowOrdinals[index],
    ),
  };
}

/**
 * Whether every ordinal below `rowCount` has an entry.
 *
 * One O(rowCount) pass, paid once per skeleton stream on the final chunk only
 * - not per chunk, and never on the streaming path.
 */
function coversEveryOrdinal(
  skeleton: readonly (RowSkeletonEntry | undefined)[],
  rowCount: number,
): boolean {
  if (skeleton.length !== rowCount) return false;
  for (let ordinal = 0; ordinal < rowCount; ordinal += 1) {
    if (skeleton[ordinal] === undefined) return false;
  }
  return true;
}

/**
 * Reconcile the spans an index delivery now has authority over, across
 * `[fromOrdinal, toOrdinal)`.
 *
 * Two things, because the delivery answers both at once for the same rows. A
 * span whose held ids CONTRADICT the skeleton is dropped - that body belongs to
 * a different row. A span holding UNVERIFIED ids (the empty string, which only
 * the inline tail produces) adopts them.
 *
 * The adopt half is not cosmetic. The tail is seated by the snapshot, which is
 * emitted BEFORE the skeleton streams, so on a fresh session every tail row's
 * id is empty; this delivery is the first authority to reach them. Left empty,
 * `transcriptListRows` cannot match those ordinals to their rendered models,
 * suppresses the ordinals, and re-emits the models as ordinal-less live rows -
 * so the inline tail never participates in viewport reporting or row-height
 * memory, on every windowed session, for exactly the rows the reader starts on.
 *
 * Both callers owe this, and by ordinal range rather than by frame shape: the
 * skeleton stream reaches a fresh session's tail ({@link applySkeletonChunk}),
 * and an `appended` delta reaches the rows that arrive AFTER that stream
 * finished ({@link applyIndexChange}) - which no chunk will ever revisit.
 */
function reconcileSpansWithSkeleton(
  window: TranscriptWindow,
  fromOrdinal: number,
  toOrdinal: number,
): TranscriptWindow {
  let changed = false;
  const kept: HydratedSpan[] = [];
  const adoptedAssistantTurns = new Map<
    string,
    Extract<Message, { role: "assistant" }>
  >();
  for (const span of window.spans) {
    const disjoint =
      spanEnd(span) <= fromOrdinal || span.fromOrdinal >= toOrdinal;
    if (disjoint) {
      kept.push(span);
      continue;
    }
    if (spanContradictsSkeleton(window, span)) {
      changed = true;
      continue;
    }
    const adopted = adoptSkeletonRowIds(window, span);
    if (adopted !== span) {
      changed = true;
      for (const [turnKey, message] of servedAssistantTurns(
        adopted.rowIds,
        spanMessages(window, adopted),
        spanEvents(window, adopted),
      )) {
        adoptedAssistantTurns.set(turnKey, message);
      }
    }
    kept.push(adopted);
  }
  if (!changed) return window;
  return pruneSupersededLiveRecords(
    pruneUnreferencedRecords({
      ...window,
      spans: kept,
      hydratedBytes: freshTierBytes(window.records, kept),
    }),
    adoptedAssistantTurns,
  );
}

/**
 * Fill a span's unverified row ids from the skeleton, or return it unchanged.
 *
 * Only the empty string is filled: a non-empty held id was checked against the
 * skeleton by {@link spanContradictsSkeleton} before this runs, so it either
 * agrees already or the span is gone.
 */
function adoptSkeletonRowIds(
  window: TranscriptWindow,
  span: HydratedSpan,
): HydratedSpan {
  const rowIds = span.rowIds.map((held, index) =>
    held === ""
      ? (window.skeleton[span.fromOrdinal + index]?.rowId ?? held)
      : held,
  );
  // Compared rather than flagged, for the narrowing reason in
  // {@link mapWindowMessages}.
  return rowIds.some((rowId, index) => rowId !== span.rowIds[index])
    ? { ...span, rowIds }
    : span;
}

function spanContradictsSkeleton(
  window: TranscriptWindow,
  span: HydratedSpan,
): boolean {
  for (let index = 0; index < span.rowIds.length; index += 1) {
    const known = window.skeleton[span.fromOrdinal + index];
    const held = span.rowIds[index];
    // An empty held id is an unverified tail row, not a claim - the skeleton
    // is the first authority to reach it, so adopt rather than contradict.
    if (known === undefined || held === "") continue;
    if (known.rowId !== held) return true;
  }
  return false;
}

/**
 * The ordinals whose BODIES a delta invalidates, or `"all"`.
 *
 * Exported because two readers have to reach the same answer and a second copy
 * of the rule would drift: {@link applyIndexChange} uses it to decide which
 * spans to drop, and the session store uses it to decide whether a range
 * request already in flight is about to be answered with bodies this very
 * frame superseded.
 *
 * `updated` is the only member that stales a body without renumbering it -
 * `appended` shifts nothing, and `reindexed` voids the coordinate space
 * itself, which is `"all"` rather than a list of ordinals in a space that no
 * longer means anything.
 */
export function bodyInvalidatingOrdinals(
  changes: readonly ChatIndexChange[],
): readonly number[] | "all" {
  if (changes.some((change) => change.type === "reindexed")) return "all";
  const ordinals: number[] = [];
  for (const change of changes) {
    if (change.type !== "updated") continue;
    for (const entry of change.entries) ordinals.push(entry.ordinal);
  }
  return ordinals;
}

/** The `steer:` row-id prefix, taken from the builder rather than restated. */
const STEER_ROW_ID_PREFIX = queueSteerRowId("");

/**
 * Is this `updated` frame the index's own echo of the turn the client is
 * already streaming?
 *
 * While a turn streams, the host emits `blockDelta` frames per token batch and,
 * on the same ordered stream, an `updated` index frame naming the growing
 * assistant slice. By the time that `updated` arrives, every delta that
 * produced it has already been applied in place ({@link streamWindowMessage}
 * rewrites the record wherever the window holds it, live or span), so the
 * client's copy of the turn's records is at least as fresh as the body the
 * index frame describes. Dropping spans and superseding in-flight hydration
 * for such a frame buys nothing - and on a chat dominated by one long-running
 * turn it is a starvation loop: the per-token-batch `updated` widens to the
 * whole turn, so every hydration answer for the turn's rows is discarded on
 * arrival and every span that does seat is destroyed before the next frame,
 * leaving the entire mid-transcript as placeholders (and a continuous
 * request/discard traffic loop) for as long as the turn streams.
 *
 * The judgement is deliberately strict: every `updated` entry must name a row
 * of the ACTIVE turn, matched through the same canonical row-turn identity the
 * rest of this module uses. A frame naming any other row - a steer body, an
 * event row, a historical turn - keeps today's drop-and-refetch, because those
 * rewrites are not mirrored by the delta stream. A `reindexed` in the frame
 * disqualifies it outright; that path voids the window before this question is
 * ever asked, and answering `true` for it here would be a lie waiting for a
 * reordering.
 */
export function isActiveTurnStreamingEcho(
  changes: readonly ChatIndexChange[],
  activeTurnId: string | null,
): boolean {
  if (activeTurnId === null) return false;
  let sawUpdated = false;
  for (const change of changes) {
    if (change.type === "reindexed") return false;
    if (change.type !== "updated") continue;
    for (const { entry } of change.entries) {
      sawUpdated = true;
      if (assistantRowTurnKey(entry.rowId) !== activeTurnId) return false;
    }
  }
  return sawUpdated;
}

/** The turn an ordinal's row belongs to, or `null` if the skeleton cannot say. */
function turnKeyAt(window: TranscriptWindow, ordinal: number): string | null {
  const entry = window.skeleton[ordinal];
  return entry === undefined ? null : assistantRowTurnKey(entry.rowId);
}

/**
 * Widen an `updated`'s ordinals to every row its rewritten RECORDS can reach.
 *
 * ## Why an ordinal is the wrong unit here, in both readers
 *
 * A row is served from its TURN's shared records (`rowRecordIds` hands an
 * assistant slice the whole turn's `messageIds`, and a steer row the turn's
 * records plus its own steered message). So a record rewritten under ordinal 12
 * is held by every row of that turn - and `updated` names only the rows whose
 * skeleton ENTRY moved, which is the rows whose own blocks changed. The other
 * slices of the same turn hold a stale copy of the same record while looking
 * untouched.
 *
 * {@link dropSpansForUpdatedOrdinals} already computes a record reach, but it
 * seeds that reach from the spans CONTAINING an updated ordinal - so when the
 * rewritten row is not hydrated there is no containing span, the seed set is
 * empty, and a sibling span holding the same turn's records is kept. The store's
 * in-flight ledger has the same shape one step earlier: it intersects on the
 * ordinals a request ASKED for, so a request for a sibling slice is not
 * superseded and its answer seats pre-update records that nothing refetches.
 *
 * Both readers therefore widen through here, for the reason
 * {@link bodyInvalidatingOrdinals} is shared: a second copy of "which rows does
 * this frame stale" would drift from the one deciding which spans to drop.
 *
 * ## The walk is bounded by the TURN, not by the transcript
 *
 * A turn's rows are contiguous, so this expands outward from each updated
 * ordinal while the row belongs to the same turn - never a scan of the
 * skeleton. That bound is load-bearing rather than incidental: an `updated`
 * arrives for the streaming row on every token batch, so an O(rowCount) reach
 * here would be O(history) work per token on a 20k-row chat, which is the cost
 * this whole line exists to delete.
 *
 * A steer row is crossed because it carries the turn's records too, and its row
 * id (`steer:<queueItemId>`) does not name the turn - so it cannot be matched,
 * only walked through. Crossing one costs at most a redundant refetch of rows
 * belonging to a neighbouring turn; refusing to cross one costs a stale body
 * with no gap behind it, which nothing repairs. The walk still terminates at
 * the user row that separates two turns.
 *
 * A row whose entry has not been delivered yet answers `null` and widens
 * nothing - the client has no way to know its turn, and inventing one would be
 * a guess about rows it has never seen.
 */
export function recordSharingOrdinals(
  window: TranscriptWindow,
  ordinals: readonly number[],
): readonly number[] {
  if (ordinals.length === 0) return ordinals;
  const widened = new Set<number>(ordinals);
  for (const ordinal of ordinals) {
    const turnKey = turnKeyAt(window, ordinal);
    if (turnKey === null) continue;
    for (const step of [-1, 1]) {
      for (
        let probe = ordinal + step;
        probe >= 0 && probe < window.rowCount;
        probe += step
      ) {
        const entry = window.skeleton[probe];
        if (entry === undefined) break;
        const sameTurn = assistantRowTurnKey(entry.rowId) === turnKey;
        if (!sameTurn && !entry.rowId.startsWith(STEER_ROW_ID_PREFIX)) break;
        widened.add(probe);
      }
    }
  }
  return [...widened];
}

/**
 * What a rebase or void carries into {@link TranscriptWindow.staleSpans}.
 *
 * The freshly discarded spans plus whatever was already stale (a second rebase
 * before the first one's replacement landed), deduplicated by row coverage -
 * a span earns its place only by contributing at least one row id nothing
 * warmer already covers - and bounded by the window budget, warmest first, so
 * the rows the reader was just looking at are the ones that survive.
 */
function staleCarrySpans(window: TranscriptWindow): readonly HydratedSpan[] {
  const candidates = [...window.spans, ...window.staleSpans];
  // Zero live bytes: a rebase or void discards the fresh spans, so the whole
  // window budget is headroom for the carry.
  //
  // No settle-first pass any more: the deferred debt RIDES the carry - the
  // ledger entries and the filtered `unsettledByteMessageIds` both survive
  // into the voided window - so {@link settleWindowBytes} still collects the
  // true measure later and {@link boundStaleTierToBudget} re-judges the tier
  // then. The pre-ledger carry had to settle eagerly because the per-span
  // figures were about to become uncorrectable; a ledger figure never is.
  return boundedStaleSpans(
    // A rebase or void discards every fresh span, so nothing is drawn by that
    // tier any more and the candidates are exactly what remains on screen.
    { ...window, spans: [] },
    candidates,
    0,
  );
}

/**
 * The dedupe-and-bound shared by every path that demotes spans to stale:
 * warmest first and freshest-served within that, a span earns its place only by
 * contributing an uncovered row id, and the total stays within the window
 * budget.
 *
 * `liveBytes` is what the FRESH spans still hold, so stale and fresh share
 * ONE budget rather than each claiming `TRANSCRIPT_WINDOW_MAX_BYTES` -
 * without it a fully hydrated window that rebases retains roughly twice the
 * budget until authority retires the carry.
 *
 * That budget is SOFT against the warmest contributing span, for the same
 * reason {@link evictTranscriptWindowToBudget}'s is soft against the spans a
 * reader is looking at. `liveBytes` can arrive already over the limit - the
 * fresh tier is over budget between a seat and the eviction that answers it,
 * and eviction leaves it over budget for as long as protected spans alone
 * exceed the limit - and a hard test then fails for EVERY candidate and
 * discards the whole tier. What that costs is precise: the carry is the only
 * copy of rows whose replacement is still in flight, and warmth is arranged so
 * the warmest is the one being read or streamed (the viewport bump in
 * {@link touchTranscriptRange}, the write bump in
 * {@link rewriteWindowMessage}), so the span dropped first to make room for
 * cold fresh spans is the one on screen. Admitting one span cannot unbound the
 * window either, by the same argument the tail exemption rests on: a span is
 * itself bounded, and authority retires this one as soon as a replacement is
 * served.
 */
function boundedStaleSpans(
  /**
   * The window as it will be AFTER this bound - specifically its `spans`, the
   * fresh tier that survives. A carry loses a row the fresh tier draws, so
   * judging visibility against the tier being DISCARDED would find every
   * candidate invisible at a rebase, where the candidates are that tier.
   */
  after: TranscriptWindow,
  candidates: readonly HydratedSpan[],
  liveBytes: number,
): readonly HydratedSpan[] {
  // Warmth first, then the FRESHEST SERVE - and the second key is not a
  // tidiness preference, it is the only thing deciding which of two carries
  // holding one row survives.
  //
  // Coverage below is first-come, so the span that sorts earlier keeps the row
  // and the other is dropped for contributing nothing. `seatStaleRows` draws
  // that row from the greatest derived serve stamp, so ordering by anything
  // else can discard the copy the renderer had selected and regress the row's
  // body to an older serve - the loss this tier exists to prevent, reached
  // with no budget pressure at all.
  //
  // Both keys are the record-grain derivations over what each span DRAWS
  // ({@link spanTouchStamp}, {@link spanServeStamp}). Per-record clocks are
  // what closed the tie factory the per-span scalars were: a viewport report
  // and a streamed rewrite bump the RECORD once, so every span drawing it
  // moves identically and a span holding it only as a rider inherits nothing.
  // Duplicates sharing a record still tie - the same ledger entry answers for
  // both - and the stable sort then falls back to input order, which is
  // ordinal for the callers that pass the stored array and freshest-first for
  // the ones that prepend the spans they are demoting; the two passes
  // therefore keep answering "which copy of this row" from the identical
  // record-level figure, which is the by-construction agreement the record
  // grain exists to preserve.
  const touchStamps = new Map(
    candidates.map((span) => [span, spanTouchStamp(after, span)]),
  );
  const serveStamps = new Map(
    candidates.map((span) => [span, spanServeStamp(after, span)]),
  );
  const sorted = [...candidates].sort(
    (left, right) =>
      (touchStamps.get(right) ?? 0) - (touchStamps.get(left) ?? 0) ||
      (serveStamps.get(right) ?? 0) - (serveStamps.get(left) ?? 0),
  );
  // By row ID only, and a MARKER never counts as covered.
  //
  // The empty string is a positionally seated tail's "identity unverified"
  // marker rather than a row id (see {@link tailRowIdsFor}), so folding it
  // into the id set would make every unresolved row in the window the same
  // row - the warmest positional span would cover the lot, however disjoint
  // the ordinals the others hold.
  //
  // Its old ORDINAL cannot stand in for the identity either, and that is a
  // fact about these inputs rather than a preference. Spans are disjoint
  // within a coordinate space (see {@link TranscriptWindow.spans}), and the
  // stale tier's own dedupe keeps it so; every candidate list here is one
  // space, or a space mixed with an OLDER carry. Two candidates can therefore
  // share an ordinal ONLY when they come from different spaces, where the same
  // number names different rows - so an ordinal dedupe could never fire except
  // on that coincidence, and firing it discarded a held body whose replacement
  // had not arrived, which is the loss this tier exists to prevent.
  //
  // So a marker always contributes. That is already how
  // {@link retireCoveredStaleSpans} reads the same value - nothing has spoken
  // about the row until the replacement skeleton completes - and it cannot
  // unbound anything: the budget below still applies, and
  // {@link staleSpanVisibleIn} gives a marker no viewport warmth, so a
  // duplicated carry is the coldest thing here and the first a squeeze drops.
  //
  // Which is still not enough on its own, because the sort's PRIMARY key can
  // separate two duplicates before the serve stamp is ever consulted. A mixed
  // carry holding one still-uncovered row beside a freshly covered one earns
  // warmth from the row the reader is looking at, so it can legitimately
  // outrank the newer span holding the other - and then claims both ids and
  // eliminates its own fresher owner. Warmth earned by a DIFFERENT row is not
  // evidence about this one.
  //
  // So ownership is read per row, and as a reason to CONTRIBUTE rather than as
  // a veto. The distinction is the whole safety argument: a veto ("skip a span
  // that owns nothing freshest") would drop the staler copy of a row whose
  // owner is then squeezed out by the budget below, losing the row outright,
  // where today it survives. Contributing only ever admits more, and the
  // budget still bounds the total.
  const ownerOf = staleRowOwners(after, candidates);
  const drawsViewport =
    after.visibleOrdinals === null
      ? (): boolean => false
      : staleSpanVisibleIn(after, candidates, after.visibleOrdinals);
  const coveredRowIds = new Set<string>();
  const carried: HydratedSpan[] = [];
  // The stale charge is stale-EXCLUSIVE: a record the surviving fresh tier
  // references is already inside `liveBytes` (the fresh term), and a record an
  // already-admitted carry charged is one ledger entry however many carries
  // reference it - the aliasing double-charge is resolved here by the same
  // dedupe the ledger gives everything else. Structural bytes stay per span.
  const chargedIds = referencedRecordIds([after.spans]);
  const incrementalCharge = (span: HydratedSpan): number => {
    let increment = span.contextBytes;
    for (const id of span.messageIds) {
      if (chargedIds.messageIds.has(id)) continue;
      increment += after.records.messages.get(id)?.bytes ?? 0;
    }
    for (const id of span.eventIds) {
      if (chargedIds.eventIds.has(id)) continue;
      increment += after.records.events.get(id)?.bytes ?? 0;
    }
    return increment;
  };
  const commitCharge = (span: HydratedSpan): void => {
    for (const id of span.messageIds) chargedIds.messageIds.add(id);
    for (const id of span.eventIds) chargedIds.eventIds.add(id);
  };
  let bytes = liveBytes;
  for (const span of sorted) {
    const uncovered = (rowId: string): boolean =>
      rowId === "" || !coveredRowIds.has(rowId) || ownerOf.get(rowId) === span;
    // Coverage BEFORE the budget, so "the warmest contributing span" is the
    // one admitted below rather than whichever duplicate sorted first.
    //
    // A carry DRAWING the viewport contributes whatever the coverage test
    // says, because visibility protects against both ways a span is dropped
    // here and not only the budget one below. That matters for an UNNAMED row,
    // where ownership and seating can disagree: `staleRowOwners` names the
    // freshest serve, but `seatStaleRows` falls back to each carry's OWN old
    // ordinal, so the owner can be unable to seat (its hole already filled)
    // while an older duplicate at a different ordinal still draws. Rejecting
    // that older span on ownership discards the only copy on screen.
    // `staleSpanVisibleIn` already draws the distinction the right way - it
    // applies ownership on the named branch and not the unnamed one - so
    // deferring to it here is what keeps the two functions telling one story.
    if (!span.rowIds.some(uncovered) && !drawsViewport(span)) continue;
    // EVERY carry drawing the viewport is exempt, not just the first one
    // admitted. `carried.length > 0` alone made the exemption positional: a
    // reader whose viewport crosses two carries had the second dropped, and
    // because `applyRangeResponse` rebalances the tier BEFORE
    // `evictTranscriptWindowToBudget` frees the cold fresh spans, the drop was
    // decided against a fresh tier that was only transiently over budget and
    // was never reconsidered once capacity returned. Its rows flash back to
    // placeholders until a refetch lands, which is the loss this tier exists
    // to prevent.
    //
    // Explicit, not warmth. Warmth is one scalar that a viewport report and a
    // streamed rewrite both write, so it cannot say which of those it is
    // recording - see {@link TranscriptWindow.visibleOrdinals}.
    const increment = incrementalCharge(span);
    if (
      carried.length > 0 &&
      bytes + increment > TRANSCRIPT_WINDOW_MAX_BYTES &&
      !drawsViewport(span)
    ) {
      continue;
    }
    for (const rowId of span.rowIds) {
      if (rowId !== "") coveredRowIds.add(rowId);
    }
    carried.push(span);
    commitCharge(span);
    bytes += increment;
  }
  // Selected by warmth, STORED in ordinal order. `staleSpans` is read on the
  // per-token path (`hydratedRecords` merges it with the fresh tier in
  // transcript order), so the ordering cost is paid once here - at a rebase,
  // void, or demotion - never per delta.
  return carried.sort((left, right) => left.fromOrdinal - right.fromOrdinal);
}

/**
 * Drop every stale span whose rows a FRESH span now fully covers.
 *
 * Runs after each seat. Coverage is judged by row id rather than ordinal
 * because that is the axis a stale span is consumed on - an ordinal
 * comparison would compare two different coordinate spaces.
 *
 * "Covered" therefore means SERVED or PROVEN GONE, not served alone. A
 * complete replacement skeleton is authority on which rows exist, so a stale
 * row it does not name is deleted rather than pending, and no future serve can
 * ever cover it. Counting it as uncovered pins a mixed span - one naming both
 * surviving and deleted rows, which {@link retireUnnamedStaleSpans} keeps
 * precisely because it names a survivor - in the tier permanently: it holds
 * shared budget and keeps obsolete records in {@link hydratedRecords} while
 * the row merger never draws them.
 *
 * A row still carrying the unverified-identity marker settles on the same
 * axis, and only there: until the replacement skeleton completes nothing has
 * spoken about it, so it keeps its span; once the skeleton completes it can
 * never be named, so it is gone like any other unnamed row. Both halves are
 * load-bearing. The snapshot tail is where the marker comes from (see
 * {@link tailRowIdsFor}) AND where the ACTIVE turn's row lives, so retiring on
 * absence alone would destroy the only copy of a streaming body at the next
 * seat - the loss this tier exists to prevent. Treating it as permanently
 * unproven instead would pin any span that mixes a marker with a survivor for
 * the rest of the session, which is the very defect the paragraph above fixes.
 */
function retireCoveredStaleSpans(window: TranscriptWindow): TranscriptWindow {
  if (window.staleSpans.length === 0) return window;
  const fresh = freshDrawnRowIds(window.spans);
  const named = window.skeletonComplete
    ? skeletonOrdinalByRowId(window.skeleton)
    : null;
  const uncovered = window.staleSpans.filter((span) =>
    span.rowIds.some((rowId) =>
      rowId === ""
        ? named === null
        : !fresh.has(rowId) && (named === null || named.has(rowId)),
    ),
  );
  // Rebalanced against the bytes the fresh spans NOW hold, not only bounded
  // at the carry: every seat that grows the fresh tier shrinks the stale
  // tier's headroom, so the shared budget keeps holding as hydration
  // proceeds rather than only at the rebase that created the carry.
  const bounded = boundedStaleSpans(window, uncovered, window.hydratedBytes);
  const unchanged =
    bounded.length === window.staleSpans.length &&
    bounded.every((span) => window.staleSpans.includes(span));
  return unchanged
    ? window
    : pruneUnreferencedRecords({ ...window, staleSpans: bounded });
}

/**
 * The window a frame has just proved unusable: void, at the frame's own
 * coordinates.
 *
 * Every caller has established the same thing by a different route - the host
 * declared the index invalid, or the client detected a loss the host does not
 * know about - and the remedy is identical, because there is only one: a
 * `resnapshot`. The frame's `epoch`, `rowCount` and `indexRevision` are adopted
 * rather than the held ones so the recovery ledger's resnapshot entry is keyed
 * on the space the client is being moved INTO, which is the space its next
 * request has to be framed against.
 */
function voidedTranscriptWindow(
  window: TranscriptWindow,
  input: {
    readonly epoch: number;
    readonly rowCount: number;
    readonly indexRevision: number;
  },
): TranscriptWindow {
  const liveMessages = window.liveMessages.filter(
    (message) =>
      input.rowCount > 0 &&
      ((message.role === "user" && input.epoch === window.epoch) ||
        (message.role === "assistant" &&
          isTransientLiveAssistantMessageId(message.messageId))),
  );
  const carriedStaleSpans = input.rowCount > 0 ? staleCarrySpans(window) : [];
  const records = retainLedgerForSpans(window.records, carriedStaleSpans);
  return {
    ...emptyTranscriptWindow(),
    epoch: input.epoch,
    rowCount: input.rowCount,
    indexRevision: input.indexRevision,
    // `reindexed` is the middle frame of the held-subscriber completion
    // handoff: the rebasing snapshot has already frozen the assistant, while
    // the replacement skeleton/range have not arrived yet. The stand-in owns
    // no ordinal, so retain it across this void just as the snapshot rebase
    // does. A zero-row authority drops it immediately; otherwise the complete
    // replacement skeleton or durable range retires it.
    liveMessages,
    // Live EVENTS travel with them, under the rule
    // {@link provisionalLiveEventsForSnapshot} already states for this same
    // question: an INVALIDATING transition retains what the client holds live.
    // A void is the most invalidating one there is - it sets `invalidated`
    // itself - and it was the only path answering differently, so a setup
    // card, a forked-chat link or a stopped-turn row that had arrived live and
    // owned no ordinal yet was discarded here and stayed gone until the
    // replacement index named it. Gated on `rowCount` for the same reason the
    // records are: a zero-row authority says those rows no longer exist.
    liveEvents: input.rowCount > 0 ? window.liveEvents : [],
    // The discarded bodies stay renderable while the replacement index
    // streams in - see {@link TranscriptWindow.staleSpans}. A zero-row
    // authority means the rows themselves are gone, so nothing is carried.
    // The ledger entries the carry references travel with it, deferred debt
    // included - see {@link retainLedgerForSpans}.
    staleSpans: carriedStaleSpans,
    records,
    unsettledByteMessageIds: window.unsettledByteMessageIds.filter((id) =>
      records.messages.has(id),
    ),
    invalidated: true,
    // The reader has not moved because the index was replaced, and the carry
    // they are looking at is bounded before any new report can arrive. See the
    // field.
    visibleOrdinals: window.visibleOrdinals,
    clock: window.clock + 1,
  };
}

/**
 * The all-invalidating fold: void at the frame's coordinates - or, for a
 * frame that merely REPEATS the void this window already is, the same window
 * by identity.
 *
 * Voiding an already-void window is IDEMPOTENT, never frame-dropping. A
 * same-epoch `reindexed` at an unchanged `rowCount` is legitimate repeat
 * authority - `withholdOversizedWindowedSnapshot` emits up to three per epoch
 * and the oversized-delta fallback and aux-only rebroadcast both re-announce
 * at the current epoch - so dropping such a frame would wedge the client (the
 * host records the index as held and suppresses further deltas), while
 * re-voiding rebuilds the carry and discards every cache keyed on window
 * identity once per repeat. Returning the SAME window is the whole point:
 * `projectedRowCache` and the backing lookups survive, and the bounded stale
 * carry is not re-bounded.
 *
 * Two exclusions, each load-bearing. A moved `rowCount` is ADVANCED
 * authority, not a repeat - the void must adopt it. And a NEWER epoch is never
 * a repeat, whatever else matches. The frame's `indexRevision` is deliberately
 * not compared - the first void armed `indexRevisionRebuilding`, in which
 * state the two counters may not be the same counter, and every consumer
 * refuses that comparison. Pending byte measurements USED to be a third
 * exclusion, when the full void's carry settled eagerly and a no-op would
 * silently skip that work; the ledger carries the debt through the void
 * intact (`unsettledByteMessageIds` and the entries both survive), so a
 * repeat with pending measurements skips nothing and is safely idempotent.
 *
 * Scoped to the all-invalidating frame deliberately: the revision-gap and
 * append-base voids stay unconditional - those frames are loss EVIDENCE, not
 * repeat authority, and their adopted coordinates are the news.
 */
function idempotentlyVoidedTranscriptWindow(
  window: TranscriptWindow,
  input: {
    readonly epoch: number;
    readonly rowCount: number;
    readonly indexRevision: number;
  },
): TranscriptWindow {
  const repeat =
    window.invalidated &&
    input.epoch === window.epoch &&
    input.rowCount === window.rowCount;
  return repeat ? window : voidedTranscriptWindow(window, input);
}

/**
 * Apply an `indexChanged` delta.
 *
 * The three cases are what the client can actually do to its row set, and each
 * costs something different:
 *
 * - `appended` shifts no existing ordinal, so nothing held is invalidated.
 * - `updated` rewrites rows in place. The named rows' bodies are stale and
 *   must go - see {@link dropSpansForUpdatedOrdinals} for why the whole
 *   containing span goes with them.
 * - `reindexed` moves rows, so every ordinal after the change names a
 *   different row. The client cannot repair that from a delta and must
 *   re-request; this only marks it.
 *
 * Applied as ONE atomic frame. Within a frame the members' ordinals are
 * disjoint by construction, so order between them does not matter - but
 * splitting a frame's changes across two applications would leave a skeleton
 * whose LENGTH already equals `rowCount` and which is wrong at one entry.
 *
 * ## An epoch MISMATCH is two findings, and only one of them is a straggler
 *
 * `appended` and `updated` deliberately retain the epoch, because neither
 * renumbers an ordinal - so a frame whose epoch differs from this window's is
 * always evidence of something. Which thing depends on the DIRECTION, and
 * collapsing the two into one `!==` was a silent data-loss bug.
 *
 * An epoch BELOW this window's is a space the client has already left. Its
 * ordinals were renumbered by the very change that moved this window on, so
 * nothing in it can be applied and nothing about it is news. Dropped.
 *
 * An epoch ABOVE it is a space the client has never REACHED, which is only
 * possible if the frame that would have carried it here - the snapshot at the
 * head of that broadcast, or the `reindexed` beside it - was lost. The pump
 * keeps drop-and-continue for a flaky socket write, so that is an ordinary
 * outcome and not a broken stream. Dropping it silently is the worst available
 * answer: the host has already recorded this index as HELD by this client
 * (`reconcileWindowedIndex` updates its per-subscriber state on emit, not on
 * delivery), so it will send only deltas from here on, every one of them
 * stamped with an epoch this client discards. Nothing re-requests anything -
 * the skeleton is complete, so the completion watchdog is disarmed - and after
 * a history mutation the chat is typically IDLE, so there is no later broadcast
 * whose snapshot would repair it. The transcript then renders the superseded
 * coordinate space for the life of the connection.
 *
 * So a newer epoch is handled exactly as `reindexed` is: void the index and let
 * {@link voidedTranscriptWindow}'s adopted coordinates drive one resnapshot.
 * That is not a coincidence of implementation - a newer epoch means a
 * `reindexed` happened and this client did not see it, so it IS the reindexed
 * case, learned late.
 */
export function applyIndexChange(
  window: TranscriptWindow,
  input: {
    readonly epoch: number;
    readonly rowCount: number;
    readonly indexRevision: number;
    readonly changes: readonly ChatIndexChange[];
    /**
     * The turn currently streaming, if any - the store's `activeTurn`. An
     * `updated` frame that is purely that turn's streaming echo skips the
     * span drop (see {@link isActiveTurnStreamingEcho}); the skeleton entries
     * it carries are folded either way.
     */
    readonly activeTurnId: string | null;
  },
): TranscriptWindow {
  // Before the change kinds are even read: a straggler's `reindexed` describes
  // a space this window has left, and acting on it would wipe a live window and
  // rewind it onto dead coordinates.
  if (input.epoch < window.epoch) return window;
  const invalidated = bodyInvalidatingOrdinals(input.changes);
  if (invalidated === "all" || input.epoch > window.epoch) {
    return idempotentlyVoidedTranscriptWindow(window, input);
  }

  // Is this frame NEWS - and if so, is it the NEXT news? Revisions are
  // consecutive within an epoch, so anything but the immediate successor means
  // a frame this client never received - and for an `updated`-only frame that
  // is the difference between noticing and rendering a superseded body until
  // the connection drops.
  //
  // A revision that is not GREATER is a duplicate or a reordered straggler
  // rather than a gap: applying it again is what the atomic-frame rule already
  // forbids, so it is dropped rather than treated as loss.
  //
  // This runs BEFORE the append-count check below: the count is a consistency
  // claim ABOUT a frame's changes, so it is only asked of a frame this window
  // has not already seen - a duplicate or straggler is dropped on its
  // revision alone, never re-judged for loss.
  //
  // Both readings compare against a counter this window is assumed to share
  // with the sender, so both are suspended for exactly one frame after a
  // rebuild boundary - the delta path reaches that boundary whenever a delta
  // arrives before the next aux snapshot does, which is ordinary. See
  // {@link TranscriptWindow.indexRevisionRebuilding}. While suspended the count
  // check below is the only detector left, which is why it is not folded into
  // this block.
  if (!window.indexRevisionRebuilding) {
    if (input.indexRevision <= window.indexRevision) return window;
    if (input.indexRevision !== window.indexRevision + 1) {
      return voidedTranscriptWindow(window, input);
    }
  }

  // A frame can be LOST without the stream dying: the host's pump surfaces a
  // deterministic send failure as fatal, but keeps drop-and-continue for a
  // flaky socket write. So `rowCount` can grow by more than the entries that
  // reached this client.
  //
  // Seating the survivors from the stale `rowCount` would put them at the
  // MISSING frame's ordinals: the wrong entry lands at a real ordinal, the
  // ordinals those rows actually occupy stay holes, and nothing later repairs
  // either - every identity check against them rejects a valid range forever.
  // `skeletonComplete` merely goes false, which requests no repair.
  //
  // The count is the whole detector for that, because `appended` is the only
  // member that moves `rowCount` and it always appends contiguously at the end.
  //
  // The baseline is the FRAME's own pre-delta count, never this window's. The
  // two disagree on every append republish: the host's broadcast emits the
  // bounded snapshot FIRST - stamped with the post-append `rowCount` but the
  // subscriber's pre-delta `indexRevision` (see `applyWindowedSnapshot`'s
  // straggler doc for why that pair is the contract) - and the delta for that
  // same append lands on a window whose `rowCount` already includes it. Read
  // against `window.rowCount`, every such delta has the `0 !== appendedRows`
  // signature of a lost frame, so the whole transcript voids and resnapshots
  // once per append for the life of the turn. The frame is self-consistent:
  // its entries occupy exactly `[rowCount - appendedRows, rowCount)`, so a
  // genuine loss is a BASE the window has not reached - a hole no entry in
  // this frame fills - and an overlap is just the snapshot having run ahead,
  // re-seating entries the count already covers (idempotently: the entries are
  // the host's current truth for those ordinals either way).
  const appendedRows = input.changes.reduce(
    (total, change) =>
      change.type === "appended" ? total + change.entries.length : total,
    0,
  );
  const appendBase = input.rowCount - appendedRows;
  if (appendBase > window.rowCount) {
    return voidedTranscriptWindow(window, input);
  }

  const skeleton = [...window.skeleton];
  // Appended entries are seated at the ordinals they NAME - which begin at the
  // frame's own pre-delta `rowCount` (`appendBase`) - and never at
  // `skeleton.length`. The skeleton is deliberately sparse while its chunks
  // are still streaming: its length is then "one past the highest ordinal
  // delivered so far", which is BELOW `rowCount`. Appending by length in that
  // window seats the new tail rows over ordinals whose real entries have not
  // arrived yet, so every identity check against those ordinals rejects a
  // valid range or drops a held span, while the ordinals the rows actually
  // occupy stay holes forever. `window.rowCount` is wrong for the other
  // reason: on the snapshot-ran-ahead interleave above it already counts the
  // rows this delta delivers, and seating from it would shift every entry one
  // past its real ordinal.
  let appendCursor = appendBase;
  for (const change of input.changes) {
    if (change.type === "appended") {
      for (const entry of change.entries) {
        skeleton[appendCursor] = entry;
        appendCursor += 1;
      }
      continue;
    }
    if (change.type === "updated") {
      for (const { ordinal, entry } of change.entries) {
        skeleton[ordinal] = entry;
      }
    }
  }
  // How far the skeleton STREAM has contiguously reached once this frame is
  // folded in.
  //
  // An `appended` delta seats its entries at the end and is part of the same
  // delivery, so a prefix that had caught up to where this append BEGINS
  // follows `rowCount` rather than being left behind - otherwise the next
  // stream-completeness question would report a gap the delta itself just
  // filled. `appendCursor` is where the appends stopped.
  //
  // Measured against `appendBase` for the same reason the loss check above is.
  // On the append republish the snapshot has already carried `window.rowCount`
  // past this prefix, so an equality against it can never hold again and the
  // prefix freezes at the pre-append count for the rest of the epoch. The two
  // agree on every frame the snapshot has NOT run ahead of.
  const coveredThrough =
    window.skeletonStreamCoveredThrough === appendBase
      ? Math.max(appendCursor, input.rowCount)
      : window.skeletonStreamCoveredThrough;
  const next: TranscriptWindow = {
    ...window,
    skeleton,
    rowCount: input.rowCount,
    indexRevision: input.indexRevision,
    // Spent: this delta's revision is now the baseline the next one is
    // compared against, whether it was adopted under the boundary or earned by
    // being the immediate successor.
    indexRevisionRebuilding: false,
    unavailableRowIds: [],
    unavailableRowOrdinals: [],
    // Whether the client holds a COMPLETE index once this frame is folded in,
    // re-derived from the two conditions {@link applySkeletonChunk} uses - and
    // deliberately NOT gated on the completeness this window arrived with.
    //
    // That gate was a third rule for the same question, and the append
    // republish is where it bites: the snapshot lands first at a `rowCount`
    // whose last ordinals only the delta behind it fills, so it correctly
    // declares the skeleton short - and a delta that then fills exactly those
    // ordinals could never say otherwise. Sticky-false completeness is not
    // inert: `chunkedDeliveryIncomplete()` reads it, so the completion
    // watchdog reads every healthy append as a stalled skeleton stream and
    // spends its whole per-epoch restream budget on resnapshots that repair
    // nothing.
    //
    // Both conditions are kept because they catch different losses. The PREFIX
    // catches a delivery that never arrived - a dropped chunk, or an append
    // frame the snapshot got ahead of - and is what still keeps a genuinely
    // short skeleton from reading as complete here. The SCAN catches a hole
    // from any other cause: the skeleton is sparse, so an append that seats
    // entries at `rowCount` can extend the array to exactly the new length
    // while an interior ordinal stays a hole, and a length test reads that as
    // complete.
    skeletonComplete:
      coveredThrough >= input.rowCount &&
      coversEveryOrdinal(skeleton, input.rowCount),
    skeletonStreamCoveredThrough: coveredThrough,
    clock: window.clock + 1,
  };
  // This delta is the first authority to name the ordinals it just appended, so
  // it owes them the identity resolution a skeleton chunk owes its own - and it
  // is the LAST authority that will ever reach them, because the skeleton
  // stream that would otherwise adopt them finished before these rows existed.
  //
  // A tail seated positionally holds the empty string at exactly those
  // ordinals (a host that sends no `tail.rowIds`; see {@link tailRowIdsFor}).
  // Left unadopted, `transcriptListRows` finds no model named `""`, suppresses
  // the ordinal, and then drops the real model as one the skeleton has already
  // placed - so a row this client HOLDS renders nowhere until the next
  // snapshot re-seats the tail.
  const reconciled =
    appendCursor > appendBase
      ? reconcileSpansWithSkeleton(next, appendBase, appendCursor)
      : next;
  return reconcileUpdatedBodies(reconciled, input, invalidated);
}

/**
 * The `updated` half of a delta's fold: drop the rewritten bodies' spans -
 * unless the frame is the ACTIVE turn's own streaming echo, whose deltas have
 * already rewritten the held records in place, in which case there is nothing
 * stale to drop and dropping anyway starves the turn's hydration for as long
 * as it streams. See {@link isActiveTurnStreamingEcho}.
 *
 * Widened to the turn BEFORE the reach is computed: the containing-span seed
 * inside the drop is exact only when the rewritten row is hydrated, and a
 * sibling slice holding the same turn's records is the case where it is not.
 * See {@link recordSharingOrdinals}.
 *
 * ## Why the echo test alone, when the store also asks whether the copy is HELD
 *
 * The store gates its half of this decision - whether to supersede in-flight
 * hydration - on {@link holdsActiveTurnAssistantMessage} as well, because an
 * unheld copy is not being rewritten by the deltas and an answer generated
 * before them carries blocks the client can never recover. That conjunct is
 * absent here, and the two still agree, for a reason worth stating rather than
 * rediscovering: this half is a NO-OP whenever the conjunct would differ.
 * {@link dropSpansForUpdatedOrdinals} drops by ordinal containment, every
 * ordinal it is given names an `assistant:` row of the active turn (the entry
 * test in {@link isActiveTurnStreamingEcho}, widened along the same axis by
 * {@link recordSharingOrdinals}), and a span covering such an ordinal was
 * served the records backing it - so "no span holds the turn's assistant
 * message" already implies "no span contains one of these ordinals", and there
 * is nothing for the skip to keep. Adding the scan here would buy no
 * behavioural change and would put an O(records held) walk on the per-token
 * path, which is exactly what the store's own `outstandingHydrationRequests`
 * gate exists to avoid.
 */
function reconcileUpdatedBodies(
  window: TranscriptWindow,
  input: {
    readonly changes: readonly ChatIndexChange[];
    readonly activeTurnId: string | null;
  },
  invalidated: readonly number[],
): TranscriptWindow {
  if (isActiveTurnStreamingEcho(input.changes, input.activeTurnId)) {
    return window;
  }
  return dropSpansForUpdatedOrdinals(
    window,
    recordSharingOrdinals(window, invalidated),
  );
}

/**
 * Drop every span containing a rewritten row - and every span holding a COPY of
 * what those spans held.
 *
 * The whole span, not the row - and that is forced, not lazy. A span's records
 * are a DEDUPLICATED union across its rows, so there is no client-side way to
 * say which records belong to the row that changed: the attribution lives in
 * the host's `rowRecordIds`, which needs the row's projection source. Keeping
 * the span and dropping "the row" would mean guessing, and a wrong guess
 * leaves a stale body rendered as current.
 *
 * ## Geometry alone is not enough, and this is where that is paid for
 *
 * A rewritten row's records are held by every span its TURN reaches, and one
 * turn's slices routinely sit in several spans that never merged (see
 * {@link insertSpan}). So the span CONTAINING the changed ordinal is not the
 * only one that can hold what changed: a reader parked on an earlier slice of
 * the same turn keeps a copy in a span this ordinal never touches. Left behind,
 * it is the only copy once the containing span goes - it renders the
 * pre-update body, and its rows are covered, so the planner sees no gap and
 * nothing ever re-requests them.
 *
 * The reach is therefore computed rather than assumed: the containing spans are
 * found by ordinal, their record ids are collected, and any span holding one of
 * those ids goes with them. It terminates, because the trigger is one `updated`
 * frame rather than a seat. Every dropped span's rows become gaps the planner
 * re-requests, which is the price every other invalidation here pays.
 *
 * ## That seed is exact only while the rewritten row is HYDRATED
 *
 * Read alone it is not enough, and the gap is silent. The record ids come from
 * the spans CONTAINING an updated ordinal - so when the rewritten row has no
 * span, the seed set is empty, nothing is found to share, and a sibling slice
 * of the same turn keeps its stale copy of the very records the host rewrote.
 * That is the case this function was written to fix, arriving by the one route
 * its own geometry cannot see.
 *
 * The caller closes it by widening the ordinals to the turn first
 * ({@link recordSharingOrdinals}), which is a question about the SKELETON and
 * therefore answerable for a row this client has never hydrated. The two steps
 * compose rather than overlap: the widening finds the rows that may share, the
 * seed below finds what they actually hold.
 *
 * The cost lands where it is cheapest: an `updated` almost always names the
 * streaming row at the tail, whose span the next snapshot re-seeds inline.
 */
function dropSpansForUpdatedOrdinals(
  window: TranscriptWindow,
  ordinals: readonly number[],
): TranscriptWindow {
  if (ordinals.length === 0) return window;
  const containsUpdated = (span: HydratedSpan): boolean =>
    ordinals.some(
      (ordinal) => ordinal >= span.fromOrdinal && ordinal < spanEnd(span),
    );
  const staleRecordIds = new Set<string>();
  for (const span of window.spans) {
    if (!containsUpdated(span)) continue;
    for (const id of span.messageIds) staleRecordIds.add(id);
    for (const id of span.eventIds) staleRecordIds.add(id);
  }
  const kept: HydratedSpan[] = [];
  const dropped: HydratedSpan[] = [];
  for (const span of window.spans) {
    if (!containsUpdated(span) && !spanSharesRecord(span, staleRecordIds)) {
      kept.push(span);
    } else {
      dropped.push(span);
    }
  }
  if (dropped.length === 0) return window;
  const hydratedBytes = freshTierBytes(window.records, kept);
  return pruneUnreferencedRecords({
    ...window,
    spans: kept,
    // The dropped bodies keep rendering while the refetch is in flight - a
    // rewrite's brief stale body beats a placeholder flash, and the gap the
    // drop opens still refetches either way. Bounded against the bytes the
    // KEPT spans still hold, so fresh and stale share one budget. See
    // {@link TranscriptWindow.staleSpans}.
    staleSpans: boundedStaleSpans(
      { ...window, spans: kept },
      [...dropped, ...window.staleSpans],
      hydratedBytes,
    ),
    hydratedBytes,
  });
}

/**
 * The window's own copy of a record - the one {@link hydratedRecords} RENDERS.
 *
 * Pre-ledger this had to MIRROR the freshest-span dedupe for a single key -
 * pick the greatest `servedAt` among however many span copies existed - and
 * the mirror was a contract two functions could drift apart on. Single
 * ownership makes the question trivial: the ledger holds the one copy, stale
 * and fresh tiers alike (a copy demoted to stale is the same entry, still
 * rewritten in place while its turn streams), so the render authority and this
 * lookup cannot disagree.
 *
 * Spans outrank live records wholesale - "a live copy never displaces a
 * span's" - so the live set answers only for an id the ledger does not hold.
 * It is a fallback, not a first look.
 */
function heldMessageCopy(
  window: TranscriptWindow,
  messageId: string,
): Message | null {
  const entry = window.records.messages.get(messageId);
  if (entry !== undefined) return entry.record;
  for (const message of window.liveMessages) {
    if (message.messageId === messageId) return message;
  }
  return null;
}

/**
 * Does the window hold the active turn's assistant message ANYWHERE - live,
 * fresh span, or stale span?
 *
 * The precondition for skipping the in-flight supersede on a streaming echo:
 * the skip is sound because the delta stream rewrites the held copy in place,
 * and a copy that is not held is not being rewritten - deltas for it are
 * dropped, so an answer generated before them carries blocks the client can
 * never recover and MUST be discarded and re-asked.
 *
 * O(records the window holds); the caller gates it on there being an
 * outstanding request at all, so it never runs on the bare per-token path.
 */
export function holdsActiveTurnAssistantMessage(
  window: TranscriptWindow,
  activeTurnId: string | null,
): boolean {
  if (activeTurnId === null) return false;
  const matches = (message: Message): boolean =>
    message.role === "assistant" && assistantTurnKey(message) === activeTurnId;
  if (window.liveMessages.some(matches)) return true;
  // The ledger IS the span tiers' holdings, fresh and stale alike.
  for (const entry of window.records.messages.values()) {
    if (matches(entry.record)) return true;
  }
  return false;
}

/**
 * While a turn streams, the held copy of its assistant message outranks any
 * served one.
 *
 * A range response is generated when the host slices it, and the BULK lane can
 * deliver it long after - during which the delta stream has kept rewriting the
 * client's copy in place. Seating the served copy verbatim would regress the
 * visible body, and worse: {@link pruneSupersededLiveRecords} drops a live
 * record the moment a span carries its id, so the older served copy would
 * *replace* the fresher one rather than sit beside it. The stream is the
 * authority on the active turn's body for as long as the turn is active, so
 * the served copy is substituted with the held one at the seat.
 *
 * Only the ACTIVE turn's assistant message: every other record is not being
 * rewritten client-side, so the served copy is the freshest thing the client
 * can hold.
 *
 * TWO rules, because authority differs by record. For the ACTIVE turn the
 * stream is the authority: the held copy wins unless demonstrably BEHIND (see
 * {@link heldCopyIsBehindServed}). For a SETTLED record the host is the
 * authority and the served copy wins unless the held one is demonstrably
 * AHEAD (see {@link heldCopyIsAheadOfServed}) - which it can be, because the
 * client rewrites a settled record in place for a detached subagent's card and
 * for an image resolving, and a range sliced before that write would otherwise
 * seat the older body under the newest `servedAt`.
 *
 * "The stream is the authority" is a statement about which copy is USUALLY
 * ahead, not a guarantee that it always is, so the active-turn substitution is
 * gated on the held copy not being demonstrably BEHIND. Holding a copy is not the same as having
 * applied every delta to it: a write can be lost while the stream stays open,
 * and then this preference would pin the incomplete body in place. Nothing
 * would repair it, either - the row is hydrated, so it leaves no gap for the
 * planner to re-request.
 *
 * That gate is only as good as the copy handed to it, so the copy is the one
 * {@link hydratedRecords} renders rather than the first one found - see
 * {@link heldMessageCopy}. Comparing the served body against some OTHER held
 * copy decides the seat on a record the reader is not looking at.
 */
function preferFresherHeldMessages(
  window: TranscriptWindow,
  messages: readonly Message[],
  activeTurnId: string | null,
  witnesses: ImageWitnessStore | null,
): readonly Message[] {
  // A Map rather than a copied-array-in-a-closure: an assignment inside a
  // callback is invisible to control-flow narrowing, which this module has
  // paid for before (see {@link rewriteWindowMessage}).
  const substitutions = new Map<number, Message>();
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    const active =
      activeTurnId !== null && assistantTurnKey(message) === activeTurnId;
    // The ARM decides which rules run: the active arm never consults the
    // settled evidence rules - the stream is its authority, and
    // `heldCopyIsBehindServed` alone displaces it. A SETTLED record is only
    // substituted on positive proof, so a serve with no version to compare is
    // not worth the held-copy scan (unchanged from before the evidence rules:
    // this guard bounds reachability, not the rules' semantics).
    if (!active && message.blocksVersion === undefined) return;
    const held = heldMessageCopy(window, message.messageId);
    if (held === null) return;
    if (
      active
        ? heldCopyIsBehindServed(held, message)
        : !heldCopyIsAheadOfServed(held, message, witnesses)
    ) {
      return;
    }
    substitutions.set(index, held);
  });
  if (substitutions.size === 0) return messages;
  return messages.map((message, index) => substitutions.get(index) ?? message);
}

/**
 * Can the held copy be PROVEN newer than the one the host just served?
 *
 * The opposite polarity to {@link heldCopyIsBehindServed}, and the asymmetry is
 * the point rather than an oversight. For the ACTIVE turn the stream is the
 * authority, so the held copy wins by default and only demonstrable staleness
 * displaces it. For a SETTLED record the host is the authority, so the served
 * copy wins by default - the client rewrites one in place only for a detached
 * subagent's card or an image resolving, and a delayed range sliced before that
 * write would otherwise seat the older body under the newest `servedAt` and
 * regress it with no gap left for the planner to repair.
 *
 * So this requires proof in the other direction: both versions present and the
 * held one strictly greater. An absent field keeps the host's copy, which is
 * the safe default for a record the client is not authoring.
 */
function heldCopyIsAheadOfServed(
  held: Message,
  served: Message,
  witnesses: ImageWitnessStore | null,
): boolean {
  if (held.role !== "assistant" || served.role !== "assistant") return false;
  // Behind on BLOCKS disqualifies it whatever the images say: substituting
  // would trade block content the host has for image state the client has, and
  // the two are not exchangeable.
  if (heldCopyIsBehindServed(held, served)) return false;
  const heldVersion = held.blocksVersion;
  const servedVersion = served.blocksVersion;
  if (
    heldVersion !== undefined &&
    servedVersion !== undefined &&
    heldVersion > servedVersion
  ) {
    return true;
  }
  // `blocksVersion` alone cannot answer this: `image_resolution.updated`
  // rewrites `imageResolutions` and the runtime accumulator advances that
  // counter only for BLOCK changes, so copies differing in image state tie on
  // version. At the tie, only DIRECTIONAL evidence substitutes - see
  // {@link imageEvidenceSaysHeldAhead}.
  return imageEvidenceSaysHeldAhead(held, served, witnesses);
}

/**
 * The sources on which the two copies genuinely disagree - present on one
 * side only, or present on both with different CONTENT. Keyed on
 * `canonicalSource` because that is the entry's stable identity, and compared
 * by content rather than presence because `applyImageResolutionDelta` UPSERTS
 * on that key: a later update to a source both copies already list replaces
 * the entry in place, and asking only whether the source appears would miss
 * exactly the update that moved it.
 */
function differingImageSources(
  held: Extract<Message, { role: "assistant" }>,
  served: Extract<Message, { role: "assistant" }>,
): readonly string[] {
  const heldBySource = new Map(
    held.imageResolutions.map((entry) => [entry.canonicalSource, entry]),
  );
  const servedBySource = new Map(
    served.imageResolutions.map((entry) => [entry.canonicalSource, entry]),
  );
  const differing: string[] = [];
  for (const source of new Set([
    ...heldBySource.keys(),
    ...servedBySource.keys(),
  ])) {
    const heldEntry = heldBySource.get(source);
    const servedEntry = servedBySource.get(source);
    if (
      heldEntry === undefined ||
      servedEntry === undefined ||
      !imageResolutionEntriesEqual(heldEntry, servedEntry)
    ) {
      differing.push(source);
    }
  }
  return differing;
}

/**
 * The settled arm's image tiebreak: does DIRECTIONAL evidence say the held
 * copy is ahead?
 *
 * The predecessor here treated ANY content difference as "held is newer",
 * reasoning the held copy accumulates every write after the slice - but
 * "different" is not "newer": a held copy seated from an older slice differs
 * from a fresher serve in exactly the same way, and the preference then pins
 * the STALE copy with the row hydrated and no gap left for the planner. So a
 * difference substitutes only on evidence with a direction, in order:
 *
 * 1. Witnessed-write ordering, per differing source (rule 2): both sides'
 *    stamps against the witness store ({@link ImageWitnessStore}), and the
 *    rule fires only when BOTH carry one - a copy with no stamp brings no
 *    evidence in either direction, and known-vs-unknown is not directional.
 * 2. Cross-source dominance: held wins only when EVERY differing source has a
 *    held-later verdict. A source that says served-later defeats it; a SILENT
 *    differing source breaks dominance too (it cannot be shown
 *    later-or-equal), and a dominance failure goes to rule 4 - NOT to the
 *    superset rule, whose tie precondition is "witness silent everywhere".
 * 3. With every source silent: source-set STRICT SUPERSET (entries are
 *    upsert-only on both sides, so a strictly larger key set is later) -
 *    but only within the record's current lineage: superset evidence
 *    captured before the record's last authoritative replacement
 *    ({@link ImageWitnessStore.lineageFloor}) is directionless, because a
 *    snapshot may legitimately re-establish the record with a smaller set.
 * 4. Otherwise directionless: no substitution, the served copy stands, and
 *    repair of a wrong serve rides the host's `updated` index entry or the
 *    next revision-gap void - never a guess.
 */
function imageEvidenceSaysHeldAhead(
  held: Extract<Message, { role: "assistant" }>,
  served: Extract<Message, { role: "assistant" }>,
  witnesses: ImageWitnessStore | null,
): boolean {
  const differing = differingImageSources(held, served);
  if (differing.length === 0 || witnesses === null) return false;
  const servedBySource = new Map(
    served.imageResolutions.map((entry) => [entry.canonicalSource, entry]),
  );
  let dominance = true;
  let anyVerdict = false;
  for (const source of differing) {
    const heldSeq = witnesses.heldStamp(held, source);
    const servedEntry = servedBySource.get(source);
    const servedSeq =
      servedEntry === undefined
        ? null
        : witnesses.servedStamp(held.messageId, servedEntry);
    if (heldSeq === 0 || servedSeq === null || heldSeq === servedSeq) {
      // Silent for this source - no stamp on one side, or stamps that agree
      // while contents differ, which is no direction either.
      dominance = false;
      continue;
    }
    anyVerdict = true;
    if (servedSeq > heldSeq) return false;
  }
  if (anyVerdict) return dominance;
  const heldSources = new Set(
    held.imageResolutions.map((entry) => entry.canonicalSource),
  );
  const strictSuperset =
    served.imageResolutions.every((entry) =>
      heldSources.has(entry.canonicalSource),
    ) && heldSources.size > servedBySource.size;
  if (!strictSuperset) return false;
  return witnesses.capturedAt(held) > witnesses.lineageFloor(held.messageId);
}

/**
 * Can the held copy be PROVEN older than the one the host just served?
 *
 * `blocksVersion` is the host's monotonic per-record write counter, carried on
 * the record itself and advanced by the same block writes the client mirrors -
 * so comparing it is an exact answer where one exists, and costs no
 * serialization on a path that seats whole ranges.
 *
 * Deliberately "proven behind" rather than "not proven ahead". Absence is
 * ordinary - the field is optional and pre-dates records still in storage -
 * and a comparison that cannot be made must not become a reason to discard
 * the streamed copy, which is the regression this preference exists to
 * prevent. So an unanswerable comparison keeps the previous behaviour and only
 * a strictly lower version overrides it.
 */
function heldCopyIsBehindServed(held: Message, served: Message): boolean {
  if (held.role !== "assistant" || served.role !== "assistant") return false;
  const heldVersion = held.blocksVersion;
  const servedVersion = served.blocksVersion;
  if (heldVersion === undefined || servedVersion === undefined) return false;
  return heldVersion < servedVersion;
}

/**
 * Seat one `range` response.
 *
 * Discarded on a stale epoch or a row-id mismatch - but those are NOT the same
 * judgement, and treating them as one was a defect.
 *
 * A stale epoch is self-healing: a newer epoch is by definition already on its
 * way, and the frame that carries it re-seats the coordinate space. Dropping
 * the response and waiting is correct.
 *
 * A row-id mismatch under the CURRENT epoch is not self-healing. Nothing is en
 * route to repair it: the planner sees the same still-missing span, asks for
 * the same ordinals, and the host answers with the same contradicting ids -
 * an unbounded request/response loop that never converges. The disagreement is
 * about the coordinate space itself, which is exactly what `invalidated` means,
 * so it is raised here and only a `resnapshot` clears it.
 *
 * `truncatedAtOrdinal` is not an error and is not handled here - the response
 * is seated for what it did serve, and asking for the remainder is the
 * caller's job (see {@link planTranscriptHydration}).
 */
export function applyRangeResponse(
  window: TranscriptWindow,
  response: ChatRangeResponse,
  /** The streaming turn, if any - see {@link preferFresherHeldMessages}. */
  activeTurnId: string | null,
  /**
   * The session's witness store, or `null` where none exists (the legacy
   * line). A range seat STAMPS the copies it lands - it never resets lineage;
   * destroying evidence at range seats is the delayed-bulk regression by
   * another route.
   */
  witnesses: ImageWitnessStore | null,
): TranscriptWindow {
  if (response.epoch !== window.epoch) return window;
  if (response.rowIds.length === 0) return window;
  if (skeletonContradicts(window, response.fromOrdinal, response.rowIds)) {
    return window.invalidated ? window : { ...window, invalidated: true };
  }
  const conflictingRowIds = incompleteRowIdsToWithhold(
    response.incompleteRowIds,
  );
  if (conflictingRowIds.size > 0) {
    const conflictingTurnKeys = new Set(
      [...conflictingRowIds]
        .map(assistantRowTurnKey)
        .filter((turnKey): turnKey is string => turnKey !== null),
    );
    const messages = response.messages.filter(
      (message) =>
        message.role !== "assistant" ||
        !conflictingTurnKeys.has(assistantTurnKey(message)),
    );
    const events = response.events.filter(
      (event) =>
        !("turnId" in event) ||
        typeof event.turnId !== "string" ||
        !conflictingTurnKeys.has(event.turnId),
    );
    let next = window;
    let runStart = -1;
    let setupRowsBeforeRun = 0;
    for (let index = 0; index <= response.rowIds.length; index += 1) {
      const atEnd = index === response.rowIds.length;
      if (!atEnd && !conflictingRowIds.has(response.rowIds[index])) {
        if (runStart < 0) runStart = index;
        continue;
      }
      if (runStart >= 0) {
        const rowIds = response.rowIds.slice(runStart, index);
        const rowIdSet = new Set(rowIds);
        const records = recordsForRowIds(
          messages,
          events,
          rowIdSet,
          setupRowsBeforeRun,
        );
        next = applyRangeResponse(
          next,
          {
            ...response,
            fromOrdinal: response.fromOrdinal + runStart,
            rowIds,
            messages: records.messages,
            events: records.events,
            incompleteRowIds: response.incompleteRowIds?.filter((id) =>
              rowIdSet.has(id),
            ),
            rowContext: Object.fromEntries(
              Object.entries(response.rowContext).filter(([id]) =>
                rowIdSet.has(id),
              ),
            ),
            reachedStart: response.reachedStart && runStart === 0,
            reachedEnd: response.reachedEnd && index === response.rowIds.length,
          },
          activeTurnId,
          witnesses,
        );
        setupRowsBeforeRun += rowIds.filter((rowId) =>
          rowId.startsWith("setup-card:"),
        ).length;
        runStart = -1;
      }
      if (!atEnd && response.rowIds[index].startsWith("setup-card:")) {
        setupRowsBeforeRun += 1;
      }
    }
    return withUnavailableRows(
      next,
      response.rowIds,
      response.fromOrdinal,
      conflictingRowIds,
    );
  }
  const completeWindow = withoutUnavailableRows(
    window,
    completeServedRowIds(response.rowIds, response.incompleteRowIds),
    response.fromOrdinal,
  );
  const clock = completeWindow.clock + 1;
  const contextBytes = contextByteLength(response.rowContext);
  const messages = preferFresherHeldMessages(
    completeWindow,
    response.messages,
    activeTurnId,
    witnesses,
  );
  // Range seats stamp; they never reset.
  stampSeatedMessages(witnesses, messages);
  // Records into the LEDGER first, so the span's references resolve and the
  // merge ceiling derives from post-seat truth.
  const records = seatLedgerRecords(
    completeWindow.records,
    messages,
    response.events,
    clock,
  );
  const span: HydratedSpan = {
    fromOrdinal: response.fromOrdinal,
    rowIds: response.rowIds,
    rowContext: response.rowContext,
    messageIds: messages.map((message) => message.messageId),
    eventIds: response.events.map((event) => event.eventId),
    contextBytes,
  };
  const spans = insertSpan(
    records,
    new Set(completeWindow.unsettledByteMessageIds),
    completeWindow.spans,
    span,
  );
  return retireCoveredStaleSpans(
    pruneSupersededLiveRecords(
      {
        ...completeWindow,
        records,
        spans,
        hydratedBytes: freshTierBytes(records, spans),
        clock,
      },
      servedAssistantTurns(
        completeServedRowIds(response.rowIds, response.incompleteRowIds),
        messages,
        response.events,
      ),
    ),
  );
}

/**
 * Everything the hydrated spans can say about how their rows render, by row id.
 *
 * Merged across spans rather than looked up per span, because the renderer asks
 * by row id and has no idea which span a row came from. Later spans win on the
 * rare duplicate, matching the merge rule inside a span.
 *
 * Rebuilt per publish rather than cached: it is proportional to the CONTEXT-
 * BEARING rows currently hydrated, which is a small fraction of a bounded
 * window, and a cache here would need invalidating on every span mutation.
 */
export function hydratedRowContext(
  window: TranscriptWindow,
): Readonly<Record<string, TranscriptRowContext>> {
  const out: Record<string, TranscriptRowContext> = {};
  // Stale first, so a fresh span's context overwrites a carried copy of the
  // same row - the map is keyed by row id, which is the axis stale spans are
  // consumed on. Within the stale tier the NEWEST serve wins a shared row
  // (overlapping carried spans exist after a partial refetch followed by
  // another rebase), matching how {@link dedupeByFreshestSpan} resolves the
  // row's body - tracked per row rather than by sorting, since this runs on
  // the per-token publish path.
  const staleServe = new Map<string, number>();
  for (const span of window.staleSpans) {
    const stamp = spanServeStamp(window, span);
    for (const rowId of Object.keys(span.rowContext)) {
      const seen = staleServe.get(rowId);
      if (seen !== undefined && seen >= stamp) continue;
      staleServe.set(rowId, stamp);
      out[rowId] = span.rowContext[rowId];
    }
  }
  for (const span of window.spans) {
    for (const rowId of Object.keys(span.rowContext)) {
      out[rowId] = span.rowContext[rowId];
    }
  }
  return out;
}

/**
 * Three-state because "not found" is not an answer on this line.
 *
 * The whole `state.messages` sweep is this distinction, and a boolean would
 * force every caller to pick a side of it silently.
 */
export type WindowRowPresence = "present" | "absent" | "unknown";

/**
 * Does this transcript hold a row that RENDERS as `user`?
 *
 * Answered from the SKELETON, which describes every row rather than the
 * hydrated ones - so it can say "yes" about a row whose body the client has
 * never held, which is exactly what a whole-transcript question needs.
 *
 * `role` is the row's RENDERED role, not a record's: a steer bubble renders as
 * `user` and so counts, while a setup card renders as `system` and does not.
 * That is the right reading here - "has a person already spoken in this chat"
 * is a question about rows.
 *
 * The three states, and why the order matters:
 *
 * - `rowCount === 0` is `absent` and must be checked FIRST. An empty
 *   transcript has an empty skeleton, and an empty skeleton is not `complete`
 *   (no chunk is ever sent for it) - so without this guard a brand-new chat
 *   would report `unknown` and never be answered.
 * - a delivered entry rendering as `user` is `present`, whatever else has yet
 *   to arrive. Chunks add entries; they never retract one.
 * - otherwise the answer turns on whether the skeleton is COMPLETE. A hole is
 *   "not delivered yet", never "no such row", so a partial skeleton with no
 *   user entry genuinely does not know.
 */
export function userRowPresence(window: TranscriptWindow): WindowRowPresence {
  if (window.rowCount === 0) return "absent";
  if (window.skeleton.some((entry) => entry?.role === "user")) return "present";
  return window.skeletonComplete ? "absent" : "unknown";
}

/**
 * Whether the LAST row's body is held.
 *
 * The gate the session store gates pending-send reconciliation on, and the
 * reason that gate exists: those reconcilers ask "did the transcript record
 * this message?" by looking in the records they were handed, and on a windowed
 * line "absent" means "not hydrated" rather than "never landed". A pending send
 * is recent by construction, so if it landed it is at the tail — which makes
 * the tail's presence exactly the condition under which their question is
 * answerable. Reconciling without it restores a sent message into the composer
 * and the user sends it twice.
 *
 * An empty transcript is trivially hydrated: there is no tail to wait for, and
 * blocking on one would strand a brand-new chat forever.
 */
export function isTailHydrated(window: TranscriptWindow): boolean {
  if (window.rowCount === 0) return true;
  const last = window.rowCount - 1;
  return window.spans.some(
    (span) => span.fromOrdinal <= last && spanEnd(span) > last,
  );
}

/**
 * Does the window hold EVERY record at or after the one carrying `messageId`?
 *
 * The precondition of a DOWNWARD scan - "is there an undoable edit below this
 * message", "how many artifacts would a revert from here touch". Those read
 * `messages`/`events` as if they were the whole transcript, and on this line
 * they are a window, so a record below the edit point that is merely cold
 * reads identically to one that does not exist.
 *
 * ## Why this is a question and not a fetch
 *
 * The obvious repair - hydrate `[thisRow, rowCount)` before scanning - cannot
 * be built. A range is addressed by ORDINAL, and nothing maps a message id to
 * one: the skeleton is keyed by row id and carries no record identity
 * (`row-skeleton.ts` says so, and says why), and a span's records are a
 * DEDUPLICATED union rather than a parallel array to its `rowIds`. Even given
 * an address the request is unbounded - editing the third message of a 20k-row
 * chat asks for the whole transcript - and it would evict itself while it
 * streamed, since {@link evictTranscriptWindowToBudget} protects only the tail.
 * So the scan cannot be made to always succeed; it can only be made to know
 * when it has succeeded.
 *
 * ## The condition
 *
 * "Everything after this record is held" is a question about ORDINAL COVERAGE
 * from the record's own position onward, and the span that holds it is how that
 * position is found.
 *
 * A record can sit in more than one span - one turn's record set reaches every
 * span its rows do, and `SPAN_MERGE_MAX_BYTES` means those are not always
 * merged (see {@link insertSpan}). So the FIRST holder is the one to measure
 * from, and `spans` is kept sorted by `fromOrdinal`, which makes `find` return
 * exactly that. Measuring from a later copy would answer a weaker question -
 * whether everything after the turn's SECOND slice is held - and answer `true`
 * for a window missing the rows in between.
 *
 * A live record (accepted, not yet placed by the index) is newer than every
 * placed row by construction, so nothing in the transcript follows it except
 * other live records, which are held. It still needs the tail: the rows
 * between the last placed row and it must be there for the span to be
 * continuous with it.
 */
export function holdsEveryRecordFrom(
  window: TranscriptWindow,
  messageId: string,
): boolean {
  if (!isTailHydrated(window)) return false;
  if (window.liveMessages.some((message) => message.messageId === messageId)) {
    return true;
  }
  const holder = window.spans.find((span) =>
    span.messageIds.includes(messageId),
  );
  if (holder === undefined) return false;
  // Coverage, not a single span. Adjacent spans are no longer always merged
  // (see SPAN_MERGE_MAX_BYTES), so "held all the way to the end" is a question
  // about the CHAIN from this span onward - asking whether one span reaches
  // `rowCount` would answer false for a transcript that is fully held but
  // represented as several touching spans.
  return coversThroughEnd(window, holder.fromOrdinal);
}

/** Is every ordinal from `fromOrdinal` to the end held, across touching spans? */
function coversThroughEnd(
  window: TranscriptWindow,
  fromOrdinal: number,
): boolean {
  let cursor = fromOrdinal;
  for (const span of [...window.spans].sort(
    (left, right) => left.fromOrdinal - right.fromOrdinal,
  )) {
    if (spanEnd(span) <= cursor) continue;
    if (span.fromOrdinal > cursor) return false;
    cursor = spanEnd(span);
    if (cursor >= window.rowCount) return true;
  }
  return cursor >= window.rowCount;
}

/**
 * Every hydrated record, in transcript order, WITHOUT touching anything.
 *
 * What feeds `ChatSessionState.messages` / `.events`. Deliberately not
 * {@link touchTranscriptRange}: that one advances the LRU for the spans a
 * VIEWPORT is showing, and this read covers the whole window — so touching
 * here would warm every span on every frame and flatten the LRU into no order
 * at all.
 */
export function hydratedRecords(window: TranscriptWindow): {
  readonly messages: readonly Message[];
  readonly events: readonly ChatEvent[];
  /**
   * What these rows render WITH - returned HERE rather than read separately so
   * a consumer cannot publish the records without the context that describes
   * them. Two `set`s would leave a frame rendering rows against the previous
   * hydration's context, which is the bug this whole channel exists to close.
   */
  readonly rowContext: Readonly<Record<string, TranscriptRowContext>>;
} {
  // Fresh and stale merged in TRANSCRIPT order, because this function's
  // contract is transcript order and `dedupeByFreshestSpan` fixes each
  // record's POSITION at first encounter (only the body follows `servedAt`).
  // Stale spans keep their previous-coordinate `fromOrdinal`, which is the
  // best transcript-position estimate the client has for them - a completion
  // rebase preserves prefix ordering. Fresh spans win ties so a re-served
  // row's position comes from the current coordinates. The bodies are
  // unaffected: `servedAt` rides the window clock, continuous across a
  // rebase, so every post-rebase serve outranks every carried copy.
  //
  // A LINEAR merge, not a sort: this runs per streaming token, and both
  // tiers are already ordinal-ordered - the fresh spans by invariant, the
  // stale tier because `boundedStaleSpans` orders it at the write.
  const spans =
    window.staleSpans.length === 0
      ? window.spans
      : mergeSpansByOrdinal(window.spans, window.staleSpans);
  return {
    messages: dedupeLedgerRecordsInOrder(
      spans,
      (span) => span.messageIds,
      window.records.messages,
      { items: window.liveMessages, keyOf: (message) => message.messageId },
    ),
    events: dedupeLedgerRecordsInOrder(
      spans,
      (span) => span.eventIds,
      window.records.events,
      { items: window.liveEvents, keyOf: (event) => event.eventId },
    ),
    rowContext: hydratedRowContext(window),
  };
}

/**
 * Merge two ordinal-ordered span tiers, the FIRST winning ties.
 *
 * O(fresh + stale), no allocation beyond the output array - written for the
 * per-token path {@link hydratedRecords} sits on.
 */
function mergeSpansByOrdinal(
  fresh: readonly HydratedSpan[],
  stale: readonly HydratedSpan[],
): readonly HydratedSpan[] {
  const merged: HydratedSpan[] = [];
  let freshIndex = 0;
  let staleIndex = 0;
  while (freshIndex < fresh.length || staleIndex < stale.length) {
    const nextFresh = freshIndex < fresh.length ? fresh[freshIndex] : null;
    const nextStale = staleIndex < stale.length ? stale[staleIndex] : null;
    if (
      nextStale === null ||
      (nextFresh !== null && nextFresh.fromOrdinal <= nextStale.fromOrdinal)
    ) {
      // `nextFresh` is non-null here: the loop condition guarantees at least
      // one side remains, and this branch is taken only when stale is
      // exhausted or fresh leads.
      if (nextFresh !== null) merged.push(nextFresh);
      freshIndex += 1;
      continue;
    }
    merged.push(nextStale);
    staleIndex += 1;
  }
  return merged;
}

/**
 * Every record the window holds, positioned by ORDINAL and bodied by the
 * LEDGER.
 *
 * Position comes from the first span encountered, which the ordinal-ordered
 * walk makes the earliest - the same rule as ever. The body question the
 * pre-ledger version answered with a serve-stamp competition ("the newest
 * SERVE wins, wherever it sits") no longer exists: however many spans
 * reference an id, they resolve to the ONE ledger entry, and a seat replaces
 * that entry - so the newest serve wins by construction rather than by
 * comparison, and the position/body split this function used to enforce is
 * now unrepresentable to get wrong.
 *
 * Spans FIRST, live records after, and both facts matter. Chronologically an
 * unplaced record is the newest thing the client has, so it sorts last anyway;
 * and a live copy never displaces a ledger one, so if the record has already
 * landed in a span the authoritative copy wins even in the window between its
 * arrival and the prune.
 *
 * ONE pass, deliberately: this runs on the streaming path (a block delta
 * republishes `messages`), so it is held to the same standard as everything
 * else there - a constant factor over the records the window holds, never a
 * second walk and never a sort.
 */
function dedupeLedgerRecordsInOrder<T>(
  spans: readonly HydratedSpan[],
  pickIds: (span: HydratedSpan) => readonly string[],
  ledger: ReadonlyMap<string, LedgerRecordEntry<T>>,
  live: {
    readonly items: readonly T[];
    readonly keyOf: (item: T) => string;
  },
): readonly T[] {
  const out: T[] = [];
  const placed = new Set<string>();
  for (const span of spans) {
    for (const id of pickIds(span)) {
      if (placed.has(id)) continue;
      const entry = ledger.get(id);
      if (entry === undefined) continue;
      placed.add(id);
      out.push(entry.record);
    }
  }
  for (const item of live.items) {
    const key = live.keyOf(item);
    if (placed.has(key)) continue;
    placed.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Advance `touchedAt` on every span overlapping `range`.
 *
 * The read half of the LRU. The viewport report calls this for the region the
 * reader is actually looking at, so a span the reader RETURNED to is warm
 * even though no fetch was ever planned for it - already hydrated means no
 * gap, no gap means no request, and without this call nothing else would ever
 * re-touch it. The failure that leaves is concrete: a fast scroll puts
 * several requests in flight, the reader settles back on an old span, and the
 * late responses push the cache over budget - evicting the span under the
 * reader as "coldest" while keeping scrollback they already left.
 *
 * The STALE tier needs it more, not less. Warmth is the only thing that
 * speaks for a carried span - it has no tail, viewport or required-ordinal
 * protection - so a stale span the reader is looking at and that nothing
 * re-touches is the first thing {@link boundedStaleSpans} discards when an
 * unrelated late range grows the fresh tier. The rows on screen would then
 * repaint as placeholders until their own request lands, which is the flash
 * the tier exists to prevent.
 *
 * Identity-stable when nothing overlaps AND the range is unchanged, so a
 * viewport RESTING on placeholders or the unplaced live tail does not churn
 * the store. Deliberately weaker than "stable whenever nothing overlaps": the
 * range itself is recorded (see {@link TranscriptWindow.visibleOrdinals}), so
 * scrolling across a region no span holds now costs one window identity per
 * distinct range. That is the case the stale tier's protection most needs -
 * the reader is over rows only a carry is drawing - and gating the record on a
 * non-empty tier would withhold it at exactly the moment a rebase creates the
 * carry, since the bound runs before any new report can arrive.
 */
export function touchTranscriptRange(
  window: TranscriptWindow,
  range: OrdinalRange | null,
): TranscriptWindow {
  // `null` is "no placed row is visible" - the reader is on the unplaced live
  // tail. It warms nothing, but it must still CLEAR the stored range: a
  // retained one goes on exempting carries the reader has scrolled away from,
  // and an exemption is exactly what the budget cannot argue with. This is the
  // one entry point for "the viewport moved", so the clear belongs here rather
  // than beside the caller's early return.
  if (range === null) {
    return window.visibleOrdinals === null
      ? window
      : { ...window, visibleOrdinals: null };
  }
  const overlaps = (span: HydratedSpan): boolean =>
    span.fromOrdinal < range.toOrdinal && spanEnd(span) > range.fromOrdinal;
  const staleDrawn = staleRowDrawnIn(window, window.staleSpans, range);
  const staleVisible = (span: HydratedSpan): boolean => {
    const rowDrawn = staleDrawn(span);
    return span.rowIds.some((rowId, offset) => rowDrawn(rowId, offset));
  };
  const touchedSpans = window.spans.some(overlaps);
  const touchedStale = window.staleSpans.some((span) => staleVisible(span));
  // The range is recorded even when nothing is warmed by it. The two answer
  // different questions: warmth is "which span did the reader just read", and
  // {@link TranscriptWindow.visibleOrdinals} is "where is the reader now" -
  // which the stale tier's budget needs precisely when the viewport is over
  // rows no span holds yet, since that is when a carry is drawing them.
  const sameRange =
    window.visibleOrdinals !== null &&
    window.visibleOrdinals.fromOrdinal === range.fromOrdinal &&
    window.visibleOrdinals.toOrdinal === range.toOrdinal;
  if (!touchedSpans && !touchedStale) {
    return sameRange ? window : { ...window, visibleOrdinals: range };
  }
  const clock = window.clock + 1;
  // The bump lands on the records backing the rows each span is drawing IN
  // the range - per row, not per span. A span is warm because its drawn
  // records are, and the max-derivation ({@link spanTouchStamp}) turns one
  // in-range row's bump into whole-span warmth for eviction, so scoping loses
  // nothing there. What it buys is containment: a ledger record is shared, so
  // bumping one a span merely HOLDS for the range (a row the fresh tier
  // draws, a duplicate a fresher owner draws, a row outside the viewport)
  // would warm every other span referencing it - rider warmth crossing tiers
  // through the alias, the tie factory reborn one level down. The span arrays
  // keep their identity, which is what lets every (spans, revision)-keyed
  // memo survive a viewport report.
  const touchedMessageIds = new Set<string>();
  const touchedEventIds = new Set<string>();
  const collect = (
    span: HydratedSpan,
    drawn: (rowId: string, offset: number) => boolean,
  ): void => {
    const rows = new Set<string>();
    const turnKeys = new Set<string>();
    span.rowIds.forEach((rowId, offset) => {
      if (rowId === "" || !drawn(rowId, offset)) return;
      rows.add(rowId);
      const turnKey = assistantRowTurnKey(rowId);
      if (turnKey !== null) turnKeys.add(turnKey);
    });
    if (rows.size === 0) return;
    const draws = spanDrawsForRows(window, span, rows, turnKeys);
    for (const id of draws.messageIds) touchedMessageIds.add(id);
    for (const id of draws.eventIds) touchedEventIds.add(id);
  };
  if (touchedSpans) {
    for (const span of window.spans) {
      if (!overlaps(span)) continue;
      // The fresh tier draws its rows at its own ordinals, so "in range" is
      // plain arithmetic here; the stale tier's per-row rule is the seat
      // truth ({@link staleRowDrawnIn}).
      collect(span, (_rowId, offset) => {
        const ordinal = span.fromOrdinal + offset;
        return ordinal >= range.fromOrdinal && ordinal < range.toOrdinal;
      });
    }
  }
  if (touchedStale) {
    for (const span of window.staleSpans) {
      collect(span, staleDrawn(span));
    }
  }
  return {
    ...window,
    visibleOrdinals: sameRange ? window.visibleOrdinals : range,
    // No revision bump: warmth is not something the structural memos read.
    records: {
      messages: withTouchStamp(
        window.records.messages,
        touchedMessageIds,
        clock,
      ),
      events: withTouchStamp(window.records.events, touchedEventIds, clock),
      revision: window.records.revision,
    },
    clock,
  };
}

/**
 * Copy a ledger map with `touchedAt` advanced to `clock` on the given ids.
 * Ids the ledger does not hold are skipped - the touch is a bump, not a seat.
 */
function withTouchStamp<T>(
  entries: ReadonlyMap<string, LedgerRecordEntry<T>>,
  ids: ReadonlySet<string>,
  clock: number,
): ReadonlyMap<string, LedgerRecordEntry<T>> {
  const next = new Map(entries);
  for (const id of ids) {
    const entry = next.get(id);
    if (entry !== undefined) next.set(id, { ...entry, touchedAt: clock });
  }
  return next;
}

/**
 * Is this carried span drawing any of the rows currently on screen?
 *
 * Not an ordinal overlap: a stale span keeps its PREVIOUS coordinates, so
 * comparing them against a range expressed in the replacement space compares
 * two different spaces. The honest question is where the row merger actually
 * draws it, which is `seatStaleRows`' rule - so this REPRODUCES that rule
 * rather than approximating it, and every refusal below is one of its own:
 *
 * - The marker is "identity unverified" rather than an id, and `seatStaleRows`
 *   returns on it before considering position, so it is never drawn at all -
 *   not even at its old ordinal. Warming a marker-only carry credits it with
 *   rows it does not put on screen.
 * - A row the FRESH tier draws is seated from that copy, and the carry loses.
 * - A NAMED row draws at its name and never falls back, so name is decided
 *   BEFORE the hole rather than beside it. Read as either-or, a row the
 *   replacement index names off-screen still reads as visible whenever its old
 *   ordinal happens to land in an unarrived hole in view.
 * - Of two carries holding one row, only the FRESHEST SERVE draws it
 *   ({@link staleRowOwners}), so the staler duplicate earns no warmth from it.
 *   Equalizing them instead would hand the tie to {@link boundedStaleSpans}'
 *   secondary key and make a squeeze's outcome turn on that, when the answer
 *   here is already known.
 *
 *   Only on the NAMED branch, and the restriction is the difference between
 *   the two branches rather than caution: a named row resolves to ONE ordinal
 *   whichever carry holds it, so every later refusal in the merger falls the
 *   same way for both and the owner's win is unconditional. An unnamed row
 *   falls back to each carry's OWN old ordinal, so an owner that cannot seat
 *   (its hole already filled) leaves a duplicate at a different ordinal that
 *   still can - and refusing that one warmth would be a missed bump, the
 *   direction this function must not err in.
 *
 * What it cannot reproduce is the pair of refusals that depend on RENDERED
 * models - an ordinal another model already took, and a row whose model the
 * renderer withheld. Those live in the row merger and nothing here can see
 * them, so this stays a slight over-estimate; the direction is deliberate,
 * since the cost of a missed bump (the on-screen carry evicted) is the failure
 * the bump exists to prevent and the cost of a spare one is a colder span
 * surviving a squeeze.
 */
function staleSpanVisibleIn(
  window: TranscriptWindow,
  carries: readonly HydratedSpan[],
  range: OrdinalRange,
): (span: HydratedSpan) => boolean {
  const drawn = staleRowDrawnIn(window, carries, range);
  return (span) => {
    const rowDrawn = drawn(span);
    return span.rowIds.some((rowId, offset) => rowDrawn(rowId, offset));
  };
}

/**
 * The per-ROW half of {@link staleSpanVisibleIn}: is this carry drawing THIS
 * row inside `range`? {@link touchTranscriptRange} needs the row-level answer
 * because its bump lands on records, and a record is shared - crediting it for
 * a row this carry does NOT draw (one the fresh tier or a fresher owner does)
 * warms every other span referencing the same ledger entry, which is exactly
 * the rider warmth the draws relation exists to refuse.
 */
function staleRowDrawnIn(
  window: TranscriptWindow,
  carries: readonly HydratedSpan[],
  range: OrdinalRange,
): (span: HydratedSpan) => (rowId: string, offset: number) => boolean {
  // Over the CANDIDATE set rather than `window.staleSpans`, because
  // `boundedStaleSpans` asks this about spans it has not seated yet - and
  // ownership is only meaningful within the set being weighed.
  //
  // No carry, no question - and this runs on every viewport report, so the
  // ordinary window must not pay for the lookups below.
  if (carries.length === 0) return () => () => false;
  const from = Math.max(0, range.fromOrdinal);
  const to = Math.min(range.toOrdinal, window.rowCount);
  if (from >= to) return () => () => false;
  const namedAt = skeletonOrdinalByRowId(window.skeleton);
  const drawnByFreshTier = freshDrawnRowIds(window.spans);
  const ownerOf = staleRowOwners(window, carries);
  return (span) => (rowId, offset) => {
    if (rowId === "" || drawnByFreshTier.has(rowId)) return false;
    const named = namedAt.get(rowId);
    if (named !== undefined) {
      if (ownerOf.get(rowId) !== span) return false;
      return named >= from && named < to;
    }
    const oldOrdinal = span.fromOrdinal + offset;
    return (
      oldOrdinal >= from &&
      oldOrdinal < to &&
      window.skeleton[oldOrdinal] === undefined
    );
  };
}

/**
 * The sub-ranges of `range` that are NOT hydrated, in ordinal order.
 *
 * Clamped to `rowCount`, so a caller that asks past the end of the transcript
 * gets no gap rather than a request the host would answer with nothing.
 */
function allTranscriptHydrationGaps(
  window: TranscriptWindow,
  range: OrdinalRange,
): readonly OrdinalRange[] {
  const from = Math.max(0, range.fromOrdinal);
  const to = Math.min(window.rowCount, range.toOrdinal);
  if (to <= from) return [];
  const covered = [...window.spans]
    .filter((span) => span.fromOrdinal < to && spanEnd(span) > from)
    .sort((left, right) => left.fromOrdinal - right.fromOrdinal);
  const gaps: OrdinalRange[] = [];
  let cursor = from;
  for (const span of covered) {
    if (span.fromOrdinal > cursor) {
      gaps.push({ fromOrdinal: cursor, toOrdinal: span.fromOrdinal });
    }
    cursor = Math.max(cursor, spanEnd(span));
    if (cursor >= to) break;
  }
  if (cursor < to) gaps.push({ fromOrdinal: cursor, toOrdinal: to });
  return gaps;
}

export function transcriptHydrationGaps(
  window: TranscriptWindow,
  range: OrdinalRange,
): readonly OrdinalRange[] {
  const gaps = allTranscriptHydrationGaps(window, range);
  if (
    window.unavailableRowIds.length === 0 &&
    window.unavailableRowOrdinals.length === 0
  ) {
    return gaps;
  }
  const unavailable = new Set(window.unavailableRowIds);
  const unavailableOrdinals = new Set(window.unavailableRowOrdinals);
  const retryable: OrdinalRange[] = [];
  for (const gap of gaps) {
    let runStart: number | null = null;
    for (let ordinal = gap.fromOrdinal; ordinal < gap.toOrdinal; ordinal += 1) {
      const rowId = window.skeleton[ordinal]?.rowId;
      if (
        unavailableOrdinals.has(ordinal) ||
        (rowId !== undefined && unavailable.has(rowId))
      ) {
        if (runStart !== null) {
          retryable.push({ fromOrdinal: runStart, toOrdinal: ordinal });
          runStart = null;
        }
        continue;
      }
      runStart ??= ordinal;
    }
    if (runStart !== null) {
      retryable.push({ fromOrdinal: runStart, toOrdinal: gap.toOrdinal });
    }
  }
  return retryable;
}

/**
 * How many rows no client-side scan can see.
 *
 * Find projects the records the window has HYDRATED, so on the windowed line
 * every count it reports is a count over a subset. A subset that presents
 * itself as a total is the failure this exists to make visible - the caller
 * turns it into the find bar's coverage caveat.
 *
 * Reuses {@link transcriptHydrationGaps} over the whole ordinal space rather
 * than summing span extents. Both would be correct today, and only one of them
 * stays correct if the definition of "covered" ever changes; this module has
 * already paid for a second implementation of a shared rule once.
 *
 * Zero on the legacy line, where the window is an inert empty value whose
 * `rowCount` is 0 and where the full transcript is materialized anyway.
 */
export function unhydratedRowCount(window: TranscriptWindow): number {
  return allTranscriptHydrationGaps(window, {
    fromOrdinal: 0,
    toOrdinal: window.rowCount,
  }).reduce((total, gap) => total + (gap.toOrdinal - gap.fromOrdinal), 0);
}

/**
 * What to fetch next, or `null` when the window is already sufficient.
 *
 * Three obligations, in priority order:
 *
 * 1. **The tail, when the LAST ROW is not hydrated.** A snapshot whose
 *    `rowCount` is positive and whose tail seated nothing means the host's tail
 *    budget could not fit even one row. The client must ask immediately and
 *    render a placeholder meanwhile - the alternative is a chat that has rows
 *    in it and displays as empty, with nothing on screen to suggest a retry.
 *
 *    Gated on {@link isTailHydrated} rather than on any gap inside the tail
 *    WINDOW, and the difference is not cosmetic: a chat whose inline tail
 *    covers its last five rows has no missing tail, and treating the fifteen
 *    rows above it as an outstanding obligation would prefetch scrollback the
 *    reader may never reach on every single snapshot. Once the tail is in,
 *    hydration is the viewport's business.
 * 2. **`required`** - rows something OTHER than the viewport is blocked on.
 *    Today that is exactly one thing: a row carrying a pending interview's
 *    question, which no scroll will ever bring into view because the card
 *    renders in the composer. A chat blocked on a question nobody can see is
 *    stuck, so this outranks scrollback the reader may never reach; it sits
 *    below the tail only because the tail is where the answer usually already
 *    is, and asking for it is the cheaper way to get there.
 * 3. **The visible span**, whichever part of it is not hydrated.
 *
 * An invalidated window returns `null`: no range can repair a void index, and
 * issuing one against a coordinate space the client has left would seat bodies
 * under the wrong rows. The caller owes a `resnapshot` instead, which is a
 * different frame and a different decision.
 *
 * @param required Ordinals that must be hydrated regardless of the viewport.
 * An ordinal outside the transcript selects itself out - see
 * {@link firstRequiredGap} - so a judgement carried across a `rowCount` change
 * cannot plan a request the host would answer with nothing.
 */
export function planTranscriptHydration(
  window: TranscriptWindow,
  visible: OrdinalRange | null,
  required: readonly number[],
): OrdinalRange | null {
  if (window.invalidated) return null;
  if (window.rowCount === 0) return null;
  if (!isTailHydrated(window)) {
    const tailGaps = transcriptHydrationGaps(window, {
      fromOrdinal: Math.max(0, window.rowCount - EAGER_TAIL_ROW_COUNT),
      toOrdinal: window.rowCount,
    });
    // The LAST gap: it is the one that reaches the end of the transcript, and
    // therefore the one that ends the wait.
    const lastTailGap = tailGaps.at(-1);
    if (lastTailGap !== undefined) return lastTailGap;
  }
  const requiredGap = firstRequiredGap(window, required);
  if (requiredGap !== null) return requiredGap;
  if (visible === null) return null;
  return transcriptHydrationGaps(window, visible)[0] ?? null;
}

/**
 * The lowest required ordinal this window does not hold, as a ONE-ROW range.
 *
 * One row rather than the gap around it because the caller wants that row and
 * nothing else: the host serves the first requested row whatever it costs
 * (`read-range.ts`), so a single-row ask always succeeds, while widening it to
 * the enclosing gap could spend the whole frame budget on scrollback nobody
 * asked for and still stop short of the row that matters.
 *
 * Lowest first so a chat blocked on several questions works through them in
 * transcript order, which is the order the notice lists them in.
 *
 * An ordinal outside the transcript needs no guard of its own, and deliberately
 * does not have one. {@link transcriptHydrationGaps} clamps to `[0, rowCount)`
 * and answers an empty range with no gap, so a row that does not exist reports
 * itself hydrated and is skipped by the same line that skips a row the window
 * already holds. A second bound here would be a restatement of that clamp -
 * correct today, and one more place to disagree with it later.
 */
function firstRequiredGap(
  window: TranscriptWindow,
  required: readonly number[],
): OrdinalRange | null {
  let lowest: number | null = null;
  for (const ordinal of required) {
    if (lowest !== null && ordinal >= lowest) continue;
    const range = { fromOrdinal: ordinal, toOrdinal: ordinal + 1 };
    if (transcriptHydrationGaps(window, range).length === 0) continue;
    lowest = ordinal;
  }
  return lowest === null
    ? null
    : { fromOrdinal: lowest, toOrdinal: lowest + 1 };
}

/**
 * Evict the coldest spans until the window fits its byte budget.
 *
 * The tail is never evicted, however cold it looks. It is where a live turn
 * happens and where every snapshot re-seats content, so evicting it would
 * trade a bounded cache for an unbounded re-fetch loop - and it is the one
 * span whose absence is visible immediately.
 *
 * That exemption is only safe because a span is BOUNDED: it protects the span
 * that reaches the end, so how much it protects is decided by how large that
 * span is allowed to grow. `SPAN_MERGE_MAX_BYTES` is what keeps it a tail
 * rather than the whole transcript - without the cap, reading a long chat
 * upward from the tail coalesces every visited row into the tail span and
 * this function is left with nothing it may drop.
 *
 * Spans overlapping `visible` are never evicted either, and the budget is
 * SOFT against them - the loop stops when only protected spans remain, even
 * over budget. That is not generosity; it is the same re-fetch-loop argument
 * as the tail. The host's range read always serves the first requested row
 * whatever it costs (see `read-range.ts`), so a single visible row larger
 * than the whole budget is a legal response - evicted here as "over budget",
 * its gap is still on screen, the planner re-requests it, and the client
 * hydrates/evicts/re-fetches that row forever while it never renders once.
 * Protecting what the reader is looking at bounds the overage by one
 * viewport's spans and ends when they scroll away.
 *
 * `required` is protected for the SAME reason and would otherwise reintroduce
 * that loop in its purest form. Those rows are re-planned unconditionally -
 * they are not gated on a viewport that could scroll away - so a required span
 * evicted as coldest is re-requested on the next plan, evicted again, and the
 * client fetches one row forever. It ends the way the viewport's does: when the
 * question settles and the ordinal stops being required.
 */
export function evictTranscriptWindowToBudget(
  input: TranscriptWindow,
  maxBytes: number,
  visible: OrdinalRange | null,
  required: readonly number[],
): TranscriptWindow {
  // The one place the byte figure is READ, and therefore the one place it has
  // to be true. Settling FIRST rather than after the early return is the whole
  // point: a window carrying a turn's worth of deferred growth would otherwise
  // read as under budget and evict nothing.
  const window = settleWindowBytes(input);
  if (window.hydratedBytes <= maxBytes) {
    return window.evictionTerminal === "none"
      ? window
      : { ...window, evictionTerminal: "none" };
  }
  const isProtected = (span: HydratedSpan): boolean => {
    if (spanEnd(span) >= window.rowCount && window.rowCount > 0) return true;
    if (
      required.some(
        (ordinal) => span.fromOrdinal <= ordinal && spanEnd(span) > ordinal,
      )
    ) {
      return true;
    }
    return (
      visible !== null &&
      span.fromOrdinal < visible.toOrdinal &&
      spanEnd(span) > visible.fromOrdinal
    );
  };
  // Coldest first, by the derived record-grain warmth - the eviction unit
  // stays the span, so the machinery's shape is unchanged; only where the
  // stamp COMES FROM moved (max over the records the span draws).
  const warmth = new Map(
    window.spans.map((span) => [span, spanTouchStamp(window, span)]),
  );
  const candidates = window.spans
    .filter((span) => !isProtected(span))
    .sort((left, right) => (warmth.get(left) ?? 0) - (warmth.get(right) ?? 0));
  // Reference counts over the SURVIVING fresh tier, maintained as spans drop:
  // savings are set-valued, not additive - a record two candidates share is
  // freed by neither alone - so each candidate's saving is its MARGINAL one
  // at this iteration, records no other surviving fresh span references plus
  // its structural bytes. A stale sharer neither joins nor blocks anything:
  // eviction demotes those bytes to stale-exclusive, and the fresh term
  // genuinely drops - which is what lets a post-rebase window (whose carry
  // holds every fresh span's records) make progress at all.
  const { messageRefs, eventRefs } = freshRecordRefCounts(window.spans);
  const marginalSaving = (span: HydratedSpan): number => {
    let saving = span.contextBytes;
    for (const id of span.messageIds) {
      if (messageRefs.get(id) !== 1) continue;
      saving += window.records.messages.get(id)?.bytes ?? 0;
    }
    for (const id of span.eventIds) {
      if (eventRefs.get(id) !== 1) continue;
      saving += window.records.events.get(id)?.bytes ?? 0;
    }
    return saving;
  };
  const dropped = new Set<HydratedSpan>();
  const evictSpan = (span: HydratedSpan): void => {
    dropped.add(span);
    for (const id of span.messageIds) {
      messageRefs.set(id, (messageRefs.get(id) ?? 1) - 1);
    }
    for (const id of span.eventIds) {
      eventRefs.set(id, (eventRefs.get(id) ?? 1) - 1);
    }
  };
  // A zero-marginal candidate's records are all shared, so the correct unit is
  // its ALIAS CLOSURE: the transitive connected component of the fresh
  // span<->record sharing graph - a chain across two adjacent turns would
  // otherwise read as unbreakable when evicting the whole chain frees it.
  const aliasClosure = (seed: HydratedSpan): ReadonlySet<HydratedSpan> => {
    const members = new Set<HydratedSpan>([seed]);
    const queue: HydratedSpan[] = [seed];
    while (queue.length > 0) {
      const member = queue.pop();
      if (member === undefined) break;
      const ids = new Set<string>([...member.messageIds, ...member.eventIds]);
      for (const other of window.spans) {
        if (members.has(other) || dropped.has(other)) continue;
        if (spanSharesRecord(other, ids)) {
          members.add(other);
          queue.push(other);
        }
      }
    }
    return members;
  };
  let bytes = window.hydratedBytes;
  let sawUnbreakableGroup = false;
  for (const span of candidates) {
    if (bytes <= maxBytes) break;
    if (dropped.has(span)) continue;
    const saving = marginalSaving(span);
    if (saving > 0) {
      evictSpan(span);
      bytes -= saving;
      continue;
    }
    const closure = aliasClosure(span);
    if ([...closure].some((member) => isProtected(member))) {
      // Genuinely unevictable: what it retains is bounded, not an open leak -
      // the protected anchor's charge is capped by the merge ceiling (tail)
      // or finite (viewport), and the chain part by sharing locality. If that
      // locality ever drifts, the growth lands in the terminal below,
      // observable rather than silent.
      sawUnbreakableGroup = true;
      continue;
    }
    // Every member unprotected: evict the closure as one unit and charge the
    // union saving.
    bytes -= evictClosureUnit(closure, window.records, evictSpan);
  }
  let evictionTerminal: TranscriptWindow["evictionTerminal"] = "none";
  if (bytes > maxBytes) {
    evictionTerminal = sawUnbreakableGroup
      ? "alias-group-unbreakable"
      : "over-budget-accepted";
  }
  if (dropped.size === 0) {
    return window.evictionTerminal === evictionTerminal
      ? window
      : { ...window, evictionTerminal };
  }
  const spans = window.spans.filter((span) => !dropped.has(span));
  return pruneUnreferencedRecords({
    ...window,
    spans,
    // Recomputed from the ledger rather than trusted from the loop's running
    // figure - the loop's arithmetic is control flow, the derivation is truth.
    hydratedBytes: freshTierBytes(window.records, spans),
    evictionTerminal,
  });
}

/**
 * Reference counts of every record over the fresh tier - the starting state
 * {@link evictTranscriptWindowToBudget} decrements as spans drop, which is
 * what makes each candidate's saving MARGINAL at its own iteration.
 */
function freshRecordRefCounts(spans: readonly HydratedSpan[]): {
  readonly messageRefs: Map<string, number>;
  readonly eventRefs: Map<string, number>;
} {
  const messageRefs = new Map<string, number>();
  const eventRefs = new Map<string, number>();
  for (const span of spans) {
    for (const id of span.messageIds) {
      messageRefs.set(id, (messageRefs.get(id) ?? 0) + 1);
    }
    for (const id of span.eventIds) {
      eventRefs.set(id, (eventRefs.get(id) ?? 0) + 1);
    }
  }
  return { messageRefs, eventRefs };
}

/**
 * Evict every member of an alias closure and return the union saving: each
 * member's structural bytes plus each of the closure's records charged ONCE -
 * all of their fresh references live inside the closure, by the definition of
 * a connected component.
 */
function evictClosureUnit(
  closure: ReadonlySet<HydratedSpan>,
  records: RecordLedger,
  evictSpan: (span: HydratedSpan) => void,
): number {
  let unionSaving = 0;
  const freedMessages = new Set<string>();
  const freedEvents = new Set<string>();
  for (const member of closure) {
    unionSaving += member.contextBytes;
    for (const id of member.messageIds) freedMessages.add(id);
    for (const id of member.eventIds) freedEvents.add(id);
    evictSpan(member);
  }
  for (const id of freedMessages) {
    unionSaving += records.messages.get(id)?.bytes ?? 0;
  }
  for (const id of freedEvents) {
    unionSaving += records.events.get(id)?.bytes ?? 0;
  }
  return unionSaving;
}

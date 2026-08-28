import type {
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatIndexChange,
  ChatRangeResponse,
  ChatSkeletonChunk,
  ChatTranscriptWindow,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import { recordByteLength } from "@traycer/protocol/persistence/chat-transcript/record-bytes";
import {
  assistantRowTurnKey,
  queueSteerRowId,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { TranscriptRowContext } from "@traycer/protocol/persistence/chat-transcript/row-context";
import { utf8ByteLength } from "@traycer/protocol/utils/text/utf8";

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
 * `messages`/`events` are the DEDUPLICATED union of the records these rows
 * render from, not a parallel array to `rowIds` - one folded assistant turn is
 * many rows and one record set, and the steer bubbles between its slices share
 * it. That is the same shape the host's range response uses, for the same
 * reason.
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
  readonly messages: readonly Message[];
  readonly events: readonly ChatEvent[];
  /**
   * Everything this span holds, in bytes: its records AND its
   * {@link rowContext}.
   *
   * The context is charged because the span RETAINS it for exactly as long as
   * it retains the records - eviction takes the whole span or none of it. A
   * budget measuring only the records lets a window reporting 8 MiB hold
   * materially more and never evict for the difference, which is the bounded
   * guarantee failing silently rather than loudly. Context-bearing assistant
   * rows repeat session anchors across thousands of rows, so the gap is
   * proportional to exactly the long chats this window exists for.
   */
  readonly bytes: number;
  /**
   * What {@link rowContext} alone costs, measured once.
   *
   * Held beside `bytes` rather than folded into every re-measure because the
   * context is immutable for a span's life: it is written only where a span is
   * BUILT (a range response, the snapshot tail) or MERGED, never by the record
   * rewrites that re-measure `bytes`. Re-deriving it there would put a JSON
   * encode of the whole context map on the streaming path - the cost
   * `unsettledByteMessageIds` exists to keep off it.
   */
  readonly contextBytes: number;
  /**
   * The window `clock` value at this span's last read or write, for eviction
   * order. A counter rather than a timestamp so a fold stays pure and a test
   * does not have to control the wall clock.
   */
  readonly touchedAt: number;
  /**
   * The window `clock` value at which the HOST served these record bodies.
   *
   * Distinct from {@link touchedAt}, which a viewport report bumps: reading a
   * span does not make its bodies newer, and conflating the two would let the
   * span a reader happens to be looking at outrank the one that was just
   * re-served. This one is written where a span is BUILT or MERGED and never
   * again.
   *
   * It exists because one turn's records reach every span its rows do, and
   * {@link SPAN_MERGE_MAX_BYTES} means those spans are not always merged into
   * one. Two spans can therefore hold the same record id, and something has to
   * decide which body the transcript renders. Ordinal order - which is what a
   * plain first-wins dedupe gives - decides it by POSITION, so the earliest
   * span's copy wins however old it is, and a turn re-served with a new body
   * keeps rendering the previous one. This is the answer to that: the newest
   * SERVE wins, wherever it sits.
   */
  readonly servedAt: number;
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
  /** Disjoint and sorted by `fromOrdinal`. */
  readonly spans: readonly HydratedSpan[];
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
   * span, the authoritative copy wins and this one is pruned. Cleared outright
   * on a rebase, because a coordinate space the client has left says nothing
   * about what is real.
   */
  readonly liveMessages: readonly Message[];
  readonly liveEvents: readonly ChatEvent[];
  readonly hydratedBytes: number;
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
    spans: [],
    liveMessages: [],
    liveEvents: [],
    hydratedBytes: 0,
    unsettledByteMessageIds: [],
    invalidated: false,
    clock: 0,
  };
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
  for (const span of window.spans) {
    for (const message of span.messages) knownMessages.add(message.messageId);
    for (const event of span.events) knownEvents.add(event.eventId);
  }
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
): TranscriptWindow {
  if (window.liveMessages.length === 0 && window.liveEvents.length === 0) {
    return window;
  }
  const spanMessages = new Set<string>();
  const spanEvents = new Set<string>();
  for (const span of window.spans) {
    for (const message of span.messages) spanMessages.add(message.messageId);
    for (const event of span.events) spanEvents.add(event.eventId);
  }
  const liveMessages = window.liveMessages.filter(
    (message) => !spanMessages.has(message.messageId),
  );
  const supersededEvents = window.liveEvents.filter(
    (event) => !spanEvents.has(event.eventId),
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
): { readonly window: TranscriptWindow; readonly held: boolean } {
  return rewriteWindowMessage(window, messageId, update, "now");
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
): { readonly window: TranscriptWindow; readonly held: boolean } {
  return rewriteWindowMessage(window, messageId, update, "deferred");
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
): TranscriptWindow {
  // "Did anything change" is COMPUTED by comparing identities, never
  // accumulated into a flag inside the `map` callbacks - see
  // {@link rewriteWindowMessage}, which pays for the same lesson: an
  // assignment made inside a callback is invisible to control-flow narrowing,
  // so a `let changed = false` read afterwards is typed `false` and the guard
  // that reads it is dead code the type-aware lint rejects.
  const changedFrom = (
    before: readonly Message[],
    after: readonly Message[],
  ): boolean => after.some((message, index) => message !== before[index]);

  const spans = window.spans.map((span) => {
    const messages = span.messages.map(update);
    // Unchanged spans keep their identity AND skip a re-measure, so a remap
    // touching one span does not re-serialize every other span's records.
    return changedFrom(span.messages, messages)
      ? {
          ...span,
          messages,
          // `contextBytes` carried, not re-derived: a remap rewrites records
          // and leaves the context map untouched.
          bytes: recordsByteLength(messages, span.events) + span.contextBytes,
        }
      : span;
  });
  const liveMessages = window.liveMessages.map(update);
  const touched =
    changedFrom(window.liveMessages, liveMessages) ||
    spans.some((span, index) => span !== window.spans[index]);
  if (!touched) return window;
  return {
    ...window,
    spans,
    liveMessages,
    hydratedBytes: totalBytes(spans),
  };
}

/**
 * Bring {@link TranscriptWindow.hydratedBytes} back in line with what the spans
 * actually hold.
 *
 * Re-measures only the spans holding an unsettled row - not the whole window -
 * so the cost is proportional to what was deferred, not to what is hydrated.
 * Called wherever the figure is about to be READ.
 */
export function settleWindowBytes(window: TranscriptWindow): TranscriptWindow {
  if (window.unsettledByteMessageIds.length === 0) return window;
  const unsettled = new Set(window.unsettledByteMessageIds);
  const spans = window.spans.map((span) =>
    span.messages.some((message) => unsettled.has(message.messageId))
      ? {
          ...span,
          // Same carry as the remap above: only records went unsettled, so
          // re-deriving the context charge here would buy nothing and put a
          // whole-map encode on the path this function exists to keep cheap.
          bytes:
            recordsByteLength(span.messages, span.events) + span.contextBytes,
        }
      : span,
  );
  return {
    ...window,
    spans,
    hydratedBytes: totalBytes(spans),
    unsettledByteMessageIds: [],
  };
}

function rewriteWindowMessage(
  window: TranscriptWindow,
  messageId: string,
  update: (message: Message) => Message,
  charge: "now" | "deferred",
): { readonly window: TranscriptWindow; readonly held: boolean } {
  const indexIn = (messages: readonly Message[]): number =>
    messages.findIndex((message) => message.messageId === messageId);
  // Located once and reused below, rather than re-scanned per span. The
  // positions are also what make `update` run exactly once - a `map` with an
  // id comparison would call it per matching element, and "the update is pure
  // so a second call is harmless" is a property of today's callers, not of the
  // signature.
  const spanIndexes = window.spans.map((span) => indexIn(span.messages));
  const liveIndex = indexIn(window.liveMessages);
  // Computed rather than accumulated in a flag: an assignment inside a `map`
  // callback is invisible to control-flow narrowing, so a `let held = false`
  // read afterwards is typed `false` and the guard below reads as dead code.
  const held = liveIndex >= 0 || spanIndexes.some((index) => index >= 0);
  if (!held) return { window, held: false };
  const spans = window.spans.map((span, spanIndex) => {
    const index = spanIndexes[spanIndex];
    if (index < 0) return span;
    const previous = span.messages[index];
    const next = update(previous);
    const messages = span.messages.slice();
    messages[index] = next;
    return {
      ...span,
      messages,
      // Charged as a DELTA, not by re-measuring the span: only one record
      // changed, so the two are identical and this one does not serialize
      // every record the span holds. `deferred` skips even that - see
      // `unsettledByteMessageIds` for why the streaming path cannot afford one
      // serialization of a growing row per delta.
      bytes:
        charge === "deferred"
          ? span.bytes
          : span.bytes + recordByteLength(next) - recordByteLength(previous),
    };
  });
  const liveMessages =
    liveIndex < 0
      ? window.liveMessages
      : window.liveMessages.map((message, index) =>
          index === liveIndex ? update(message) : message,
        );
  return {
    window: {
      ...window,
      spans,
      liveMessages,
      hydratedBytes: totalBytes(spans),
      unsettledByteMessageIds:
        charge === "now" || window.unsettledByteMessageIds.includes(messageId)
          ? window.unsettledByteMessageIds
          : [...window.unsettledByteMessageIds, messageId],
      clock: window.clock + 1,
    },
    held: true,
  };
}

function spanExtent(span: HydratedSpan): number {
  return span.rowIds.length;
}

function spanEnd(span: HydratedSpan): number {
  return span.fromOrdinal + spanExtent(span);
}

function recordsByteLength(
  messages: readonly Message[],
  events: readonly ChatEvent[],
): number {
  let bytes = 0;
  for (const message of messages) bytes += recordByteLength(message);
  for (const event of events) bytes += recordByteLength(event);
  return bytes;
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

function totalBytes(spans: readonly HydratedSpan[]): number {
  return spans.reduce((sum, span) => sum + span.bytes, 0);
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
 * Concatenate groups of records, keeping each record id ONCE.
 *
 * POSITION comes from the first occurrence, because the groups arrive in
 * ordinal order and that ordering is what makes the result transcript-ordered.
 * The BODY comes from `preferred` wherever it holds that id - so where two
 * copies of one record disagree, position decides where it renders and
 * `preferred` decides what it says.
 *
 * The two halves answer different questions and it matters that they are
 * decided separately. A span is only ever merged with a response that arrived
 * LATER under the same epoch, so where the two copies of a record disagree the
 * incoming one is the host's current answer - the same rule the row ids
 * already follow. Keeping the first BODY as well would let a span retained
 * across a reconnect outrank the authoritative tail that just replaced it: the
 * merge succeeds, the ids update, and the published transcript keeps rendering
 * the stale text with nothing to indicate it.
 *
 * {@link dedupeByFreshestSpan} makes the same judgement for spans that did NOT
 * merge, where "later" is a stamp rather than an argument position.
 */
function dedupePreferringIncoming<T>(
  groups: readonly (readonly T[])[],
  preferred: readonly T[],
  keyOf: (item: T) => string,
): readonly T[] {
  const override = new Map(preferred.map((item) => [keyOf(item), item]));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const group of groups) {
    for (const item of group) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(override.get(key) ?? item);
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
    span.messages.some((message) => recordIds.has(message.messageId)) ||
    span.events.some((event) => recordIds.has(event.eventId))
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
 * a new body kept rendering the previous one. The fix belongs there, and is
 * there - {@link HydratedSpan.servedAt} makes the newest SERVE win wherever it
 * sits.
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
  spans: readonly HydratedSpan[],
  incoming: HydratedSpan,
): readonly HydratedSpan[] {
  const untouched: HydratedSpan[] = [];
  const overlapping: HydratedSpan[] = [];
  // Adjacency is absorbed only while the result stays a unit eviction can
  // reclaim (see SPAN_MERGE_MAX_BYTES). Overlap is not optional: two spans
  // covering one ordinal would place that row twice.
  let mergedBytes = incoming.bytes;
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
    if (touchesOnly && mergedBytes + span.bytes > SPAN_MERGE_MAX_BYTES) {
      untouched.push(span);
      continue;
    }
    mergedBytes += span.bytes;
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
  const messages = dedupePreferringIncoming(
    members.map((span) => span.messages),
    incoming.messages,
    (message) => message.messageId,
  );
  const events = dedupePreferringIncoming(
    members.map((span) => span.events),
    incoming.events,
    (event) => event.eventId,
  );
  // Incoming last, so a re-served row's context supersedes the held copy for
  // the same reason its row id does.
  const rowContext = Object.assign(
    {},
    ...overlapping.map((span) => span.rowContext),
    incoming.rowContext,
  ) as Readonly<Record<string, TranscriptRowContext>>;
  // Re-measured rather than summed from the members: the merge DEDUPES both
  // the records and the context map, so adding the members' charges would bill
  // every row a re-served span shares with the one it superseded.
  const contextBytes = contextByteLength(rowContext);
  const merged: HydratedSpan = {
    fromOrdinal,
    rowIds,
    rowContext,
    messages,
    events,
    bytes: recordsByteLength(messages, events) + contextBytes,
    contextBytes,
    touchedAt: Math.max(...members.map((span) => span.touchedAt)),
    // The merged bodies are `dedupePreferringIncoming`'s answer, so the newest
    // serve among the members is what this span now holds. Taking the MAX is
    // therefore a statement of fact rather than a heuristic - and taking the
    // incoming span's stamp alone would be wrong for a member whose records the
    // incoming one does not carry at all.
    servedAt: Math.max(...members.map((span) => span.servedAt)),
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
  const missedDeltas = verdict === "gap";
  const base: TranscriptWindow =
    rebased || missedDeltas
      ? {
          ...emptyTranscriptWindow(),
          epoch: input.epoch,
          rowCount: input.rowCount,
          indexRevision: input.indexRevision ?? 0,
          // A concrete revision here IS the new baseline, so the flag the
          // spread armed is spent. `null` leaves it armed for the restream.
          indexRevisionRebuilding: input.indexRevision === null,
          invalidated: missedDeltas,
          clock,
        }
      : {
          ...window,
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
            window.skeletonComplete &&
            coversEveryOrdinal(window.skeleton, input.rowCount),
          skeletonStreamCoveredThrough:
            input.indexRevision === null
              ? 0
              : window.skeletonStreamCoveredThrough,
          invalidated: false,
          clock,
        };

  const tailRowIds = tailRowIdsFor(base, input);
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
      ? dropSpansOverlappingFrom(base, input.tail.fromOrdinal)
      : base;
  }
  // Keyed by row id exactly as a range's is, so a tail seated on the
  // positional ids `tailRowIdsFor` falls back to simply misses every lookup
  // rather than seating context under the wrong row.
  const tailRowContext = input.tail.rowContext ?? {};
  const tailContextBytes = contextByteLength(tailRowContext);
  const tailSpan: HydratedSpan = {
    fromOrdinal: input.tail.fromOrdinal,
    rowIds: tailRowIds,
    rowContext: tailRowContext,
    messages: input.tail.messages,
    events: input.tail.events,
    bytes:
      recordsByteLength(input.tail.messages, input.tail.events) +
      tailContextBytes,
    contextBytes: tailContextBytes,
    touchedAt: clock,
    // A snapshot's tail is the host's current answer for those rows, so it is a
    // serve and outranks any older span still holding a copy of the same turn.
    servedAt: clock,
  };
  const spans = insertSpan(base.spans, tailSpan);
  return pruneSupersededLiveRecords({
    ...base,
    spans,
    hydratedBytes: totalBytes(spans),
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
  return { ...window, spans: kept, hydratedBytes: totalBytes(kept) };
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
  return reconcileSpansWithSkeleton(next, chunk);
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
 * Reconcile the spans a skeleton chunk now has authority over.
 *
 * Two things, because the chunk answers both at once for the same rows. A span
 * whose held ids CONTRADICT the chunk is dropped - that body belongs to a
 * different row. A span holding UNVERIFIED ids (the empty string, which only
 * the inline tail produces) adopts them.
 *
 * The adopt half is not cosmetic. The tail is seated by the snapshot, which is
 * emitted BEFORE the skeleton streams, so on a fresh session every tail row's
 * id is empty; this chunk is the first authority to reach them. Left empty,
 * `transcriptListRows` cannot match those ordinals to their rendered models,
 * suppresses the ordinals, and re-emits the models as ordinal-less live rows -
 * so the inline tail never participates in viewport reporting or row-height
 * memory, on every windowed session, for exactly the rows the reader starts on.
 */
function reconcileSpansWithSkeleton(
  window: TranscriptWindow,
  chunk: ChatSkeletonChunk,
): TranscriptWindow {
  const chunkEnd = chunk.fromOrdinal + chunk.entries.length;
  let changed = false;
  const kept: HydratedSpan[] = [];
  for (const span of window.spans) {
    const disjoint =
      spanEnd(span) <= chunk.fromOrdinal || span.fromOrdinal >= chunkEnd;
    if (disjoint) {
      kept.push(span);
      continue;
    }
    if (spanContradictsSkeleton(window, span)) {
      changed = true;
      continue;
    }
    const adopted = adoptSkeletonRowIds(window, span);
    if (adopted !== span) changed = true;
    kept.push(adopted);
  }
  if (!changed) return window;
  return { ...window, spans: kept, hydratedBytes: totalBytes(kept) };
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
 * The window a frame has just proved unusable: void, at the frame's own
 * coordinates.
 *
 * Every caller has established the same thing by a different route - the host
 * declared the index invalid, or the client detected a loss the host does not
 * know about - and the remedy is identical, because there is only one: a
 * `resnapshot`. The frame's `epoch`, `rowCount` and `indexRevision` are adopted
 * rather than the held ones so the resnapshot latch
 * (`resnapshotRequestedForEpoch`) is keyed on the space the client is being
 * moved INTO, which is the space its next request has to be framed against.
 */
function voidedTranscriptWindow(
  window: TranscriptWindow,
  input: {
    readonly epoch: number;
    readonly rowCount: number;
    readonly indexRevision: number;
  },
): TranscriptWindow {
  return {
    ...emptyTranscriptWindow(),
    epoch: input.epoch,
    rowCount: input.rowCount,
    indexRevision: input.indexRevision,
    invalidated: true,
    clock: window.clock + 1,
  };
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
  },
): TranscriptWindow {
  // Before the change kinds are even read: a straggler's `reindexed` describes
  // a space this window has left, and acting on it would wipe a live window and
  // rewind it onto dead coordinates.
  if (input.epoch < window.epoch) return window;
  const invalidated = bodyInvalidatingOrdinals(input.changes);
  if (invalidated === "all" || input.epoch > window.epoch) {
    return voidedTranscriptWindow(window, input);
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
  // This runs BEFORE the append-count check below, and the order is the whole
  // point rather than a style choice. A duplicate carrying `appended` entries
  // was already applied here, so this window's `rowCount` already includes
  // those rows and the frame's own count equals it - which the count check
  // reads as `0 !== appendedRows`, the exact signature of a LOST frame. Ask
  // that question of a frame already known to be stale and the most harmless
  // thing a stream can do becomes a blanked transcript and a full refetch. The
  // count is a consistency claim ABOUT a frame's changes; it is only meaningful
  // once the frame is established as one this window has not seen.
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
  const appendedRows = input.changes.reduce(
    (total, change) =>
      change.type === "appended" ? total + change.entries.length : total,
    0,
  );
  if (input.rowCount - window.rowCount !== appendedRows) {
    return voidedTranscriptWindow(window, input);
  }

  const skeleton = [...window.skeleton];
  // Appended entries are seated at the ordinals they NAME - which begin at the
  // PRE-delta `rowCount` - and never at `skeleton.length`. The two are equal
  // only once the skeleton is complete, and the skeleton is deliberately
  // sparse while its chunks are still streaming: its length is then "one past
  // the highest ordinal delivered so far", which is BELOW `rowCount`.
  // Appending by length in that window seats the new tail rows over ordinals
  // whose real entries have not arrived yet, so every identity check against
  // those ordinals rejects a valid range or drops a held span, while the
  // ordinals the rows actually occupy stay holes forever.
  let appendCursor = window.rowCount;
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
  const next: TranscriptWindow = {
    ...window,
    skeleton,
    rowCount: input.rowCount,
    indexRevision: input.indexRevision,
    // Spent: this delta's revision is now the baseline the next one is
    // compared against, whether it was adopted under the boundary or earned by
    // being the immediate successor.
    indexRevisionRebuilding: false,
    // A delta that grew the index past what the client has assembled means the
    // skeleton is no longer complete, even though it was.
    //
    // By COVERAGE, not by length - the same distinction `applySkeletonChunk`
    // draws and for the same reason. The skeleton is sparse, so an append that
    // seats new entries at `rowCount` can extend the array to exactly the new
    // length while interior ordinals a dropped frame should have filled stay
    // holes, and a length test reads that as complete.
    skeletonComplete:
      window.skeletonComplete && coversEveryOrdinal(skeleton, input.rowCount),
    // An `appended` delta seats its entries at the end and is part of the same
    // delivery, so the prefix follows `rowCount` rather than being left behind
    // - otherwise the next stream-completeness question would report a gap the
    // delta itself just filled. `appendCursor` is where the appends stopped.
    skeletonStreamCoveredThrough:
      window.skeletonStreamCoveredThrough === window.rowCount
        ? Math.max(appendCursor, input.rowCount)
        : window.skeletonStreamCoveredThrough,
    clock: window.clock + 1,
  };
  // Widened to the turn BEFORE the reach is computed: the containing-span seed
  // below is exact only when the rewritten row is hydrated, and a sibling slice
  // holding the same turn's records is the case where it is not. See
  // {@link recordSharingOrdinals}.
  return dropSpansForUpdatedOrdinals(
    next,
    recordSharingOrdinals(next, invalidated),
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
    for (const message of span.messages) staleRecordIds.add(message.messageId);
    for (const event of span.events) staleRecordIds.add(event.eventId);
  }
  const kept = window.spans.filter(
    (span) => !containsUpdated(span) && !spanSharesRecord(span, staleRecordIds),
  );
  if (kept.length === window.spans.length) return window;
  return { ...window, spans: kept, hydratedBytes: totalBytes(kept) };
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
): TranscriptWindow {
  if (response.epoch !== window.epoch) return window;
  if (response.rowIds.length === 0) return window;
  if (skeletonContradicts(window, response.fromOrdinal, response.rowIds)) {
    return window.invalidated ? window : { ...window, invalidated: true };
  }
  const clock = window.clock + 1;
  const contextBytes = contextByteLength(response.rowContext);
  const span: HydratedSpan = {
    fromOrdinal: response.fromOrdinal,
    rowIds: response.rowIds,
    rowContext: response.rowContext,
    messages: response.messages,
    events: response.events,
    bytes: recordsByteLength(response.messages, response.events) + contextBytes,
    contextBytes,
    touchedAt: clock,
    servedAt: clock,
  };
  const spans = insertSpan(window.spans, span);
  return pruneSupersededLiveRecords({
    ...window,
    spans,
    hydratedBytes: totalBytes(spans),
    clock,
  });
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
    span.messages.some((message) => message.messageId === messageId),
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
  return {
    messages: dedupeByFreshestSpan(
      window.spans,
      (span) => span.messages,
      window.liveMessages,
      (message) => message.messageId,
    ),
    events: dedupeByFreshestSpan(
      window.spans,
      (span) => span.events,
      window.liveEvents,
      (event) => event.eventId,
    ),
    rowContext: hydratedRowContext(window),
  };
}

/**
 * Every record the window holds, positioned by ORDINAL and bodied by SERVE.
 *
 * The two axes are separate because the same record id can sit in two spans -
 * one turn's records reach every span its rows do, and `SPAN_MERGE_MAX_BYTES`
 * means those are not always merged (see {@link insertSpan}). Position has to
 * come from the earliest span, or the transcript is out of order; the body has
 * to come from the newest SERVE, or the earliest span's copy renders however
 * stale it is - which is the defect {@link HydratedSpan.servedAt} exists for.
 *
 * Spans FIRST, live records after, and both facts matter. Chronologically an
 * unplaced record is the newest thing the client has, so it sorts last anyway;
 * and a live copy never displaces a span's, so if the record has already landed
 * in a span the authoritative one wins even in the window between its arrival
 * and the prune. That is a POSITION question, which is why the live records do
 * not carry a serve stamp and do not compete on one.
 *
 * ONE pass and one map, deliberately: this runs on the streaming path (a block
 * delta republishes `messages`), so it is held to the same standard as
 * everything else there - a constant factor over the records the window holds,
 * never a second walk and never a sort.
 */
function dedupeByFreshestSpan<T>(
  spans: readonly HydratedSpan[],
  pick: (span: HydratedSpan) => readonly T[],
  live: readonly T[],
  keyOf: (item: T) => string,
): readonly T[] {
  const out: T[] = [];
  const placed = new Map<string, { index: number; servedAt: number }>();
  for (const span of spans) {
    for (const item of pick(span)) {
      const key = keyOf(item);
      const seen = placed.get(key);
      if (seen === undefined) {
        placed.set(key, { index: out.length, servedAt: span.servedAt });
        out.push(item);
        continue;
      }
      // The position it already has, the body this span serves. `>` and not
      // `>=` so an equal stamp keeps the earlier span's copy, which is the same
      // record either way and one less write.
      if (span.servedAt > seen.servedAt) {
        out[seen.index] = item;
        placed.set(key, { index: seen.index, servedAt: span.servedAt });
      }
    }
  }
  for (const item of live) {
    const key = keyOf(item);
    if (placed.has(key)) continue;
    placed.set(key, { index: out.length, servedAt: 0 });
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
 * Identity-stable when nothing overlaps, so a viewport resting on
 * placeholders or the unplaced live tail does not churn the store.
 */
export function touchTranscriptRange(
  window: TranscriptWindow,
  range: OrdinalRange,
): TranscriptWindow {
  const overlaps = (span: HydratedSpan): boolean =>
    span.fromOrdinal < range.toOrdinal && spanEnd(span) > range.fromOrdinal;
  if (!window.spans.some(overlaps)) return window;
  const clock = window.clock + 1;
  const spans = window.spans.map((span) =>
    overlaps(span) ? { ...span, touchedAt: clock } : span,
  );
  return { ...window, spans, clock };
}

/**
 * The sub-ranges of `range` that are NOT hydrated, in ordinal order.
 *
 * Clamped to `rowCount`, so a caller that asks past the end of the transcript
 * gets no gap rather than a request the host would answer with nothing.
 */
export function transcriptHydrationGaps(
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
  return transcriptHydrationGaps(window, {
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
  if (window.hydratedBytes <= maxBytes) return window;
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
  const evictable = window.spans
    .filter((span) => !isProtected(span))
    .sort((left, right) => left.touchedAt - right.touchedAt);
  const dropped = new Set<HydratedSpan>();
  let bytes = window.hydratedBytes;
  for (const span of evictable) {
    if (bytes <= maxBytes) break;
    dropped.add(span);
    bytes -= span.bytes;
  }
  if (dropped.size === 0) return window;
  const spans = window.spans.filter((span) => !dropped.has(span));
  return { ...window, spans, hydratedBytes: totalBytes(spans) };
}

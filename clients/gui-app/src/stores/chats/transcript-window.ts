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
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";

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
  readonly messages: readonly Message[];
  readonly events: readonly ChatEvent[];
  readonly bytes: number;
  /**
   * The window `clock` value at this span's last read or write, for eviction
   * order. A counter rather than a timestamp so a fold stays pure and a test
   * does not have to control the wall clock.
   */
  readonly touchedAt: number;
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
   * The index is void and only a `resnapshot` repairs it.
   *
   * Set by a `reindexed` change, and by a final skeleton chunk whose assembled
   * length disagrees with `rowCount` (chunks were lost). Both are cases where
   * continuing to serve ordinals would be serving a coordinate the client
   * knows is wrong.
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
 * How many rows to hydrate when a snapshot arrives with an EMPTY tail.
 *
 * The host's tail is bounded by `TRANSCRIPT_TAIL_MAX_BYTES` and it walks
 * backwards with a hard ceiling and no always-serve-one exception - so a chat
 * whose last row is a 1.27 MB tool result ships a tail of zero rows, which is
 * the correct answer to "what fits". The client must notice that and ask,
 * rather than render an empty chat that has rows in it.
 */
export const EAGER_TAIL_ROW_COUNT = 20;

export function emptyTranscriptWindow(): TranscriptWindow {
  return {
    epoch: 0,
    rowCount: 0,
    skeleton: [],
    skeletonComplete: false,
    spans: [],
    liveMessages: [],
    liveEvents: [],
    hydratedBytes: 0,
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
  return {
    ...window,
    liveMessages: [...window.liveMessages, ...messages],
    liveEvents: [...window.liveEvents, ...events],
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
  const liveEvents = window.liveEvents.filter(
    (event) => !spanEvents.has(event.eventId),
  );
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
  const holdsMessage = (messages: readonly Message[]): boolean =>
    messages.some((message) => message.messageId === messageId);
  // Computed rather than accumulated in a flag: an assignment inside a `map`
  // callback is invisible to control-flow narrowing, so a `let held = false`
  // read afterwards is typed `false` and the guard below reads as dead code.
  const held =
    window.spans.some((span) => holdsMessage(span.messages)) ||
    holdsMessage(window.liveMessages);
  if (!held) return { window, held: false };
  const spans = window.spans.map((span) => {
    if (!holdsMessage(span.messages)) return span;
    const messages = span.messages.map((message) =>
      message.messageId === messageId ? update(message) : message,
    );
    return {
      ...span,
      messages,
      bytes: recordsByteLength(messages, span.events),
    };
  });
  const liveMessages = window.liveMessages.map((message) =>
    message.messageId === messageId ? update(message) : message,
  );
  return {
    window: {
      ...window,
      spans,
      liveMessages,
      hydratedBytes: totalBytes(spans),
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

function dedupeMessages(
  groups: readonly (readonly Message[])[],
): readonly Message[] {
  const seen = new Set<string>();
  const out: Message[] = [];
  for (const group of groups) {
    for (const message of group) {
      if (seen.has(message.messageId)) continue;
      seen.add(message.messageId);
      out.push(message);
    }
  }
  return out;
}

function dedupeEvents(
  groups: readonly (readonly ChatEvent[])[],
): readonly ChatEvent[] {
  const seen = new Set<string>();
  const out: ChatEvent[] = [];
  for (const group of groups) {
    for (const event of group) {
      if (seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      out.push(event);
    }
  }
  return out;
}

/**
 * Insert one span, merging it with every span it touches or overlaps.
 *
 * Merging matters for more than tidiness: a reader scrolling upward produces a
 * run of abutting ranges, and left unmerged they would each keep their own
 * copy of a turn that straddles their boundary. The dedupe is by record id and
 * keeps the FIRST occurrence, which preserves transcript order because the
 * spans are concatenated in ordinal order.
 *
 * Where two spans overlap, the INCOMING row ids win. They came from a later
 * response under the same epoch, so where the two disagree the newer one is
 * the host's current answer.
 */
function insertSpan(
  spans: readonly HydratedSpan[],
  incoming: HydratedSpan,
): readonly HydratedSpan[] {
  const untouched: HydratedSpan[] = [];
  const overlapping: HydratedSpan[] = [];
  for (const span of spans) {
    const disjoint =
      spanEnd(span) < incoming.fromOrdinal ||
      span.fromOrdinal > spanEnd(incoming);
    if (disjoint) {
      untouched.push(span);
    } else {
      overlapping.push(span);
    }
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
  const messages = dedupeMessages(members.map((span) => span.messages));
  const events = dedupeEvents(members.map((span) => span.events));
  const merged: HydratedSpan = {
    fromOrdinal,
    rowIds,
    messages,
    events,
    bytes: recordsByteLength(messages, events),
    touchedAt: Math.max(...members.map((span) => span.touchedAt)),
  };
  return [...untouched, merged].sort(
    (left, right) => left.fromOrdinal - right.fromOrdinal,
  );
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
    readonly tail: ChatTranscriptWindow;
  },
): TranscriptWindow {
  const rebased = input.epoch !== window.epoch;
  const clock = window.clock + 1;
  const base: TranscriptWindow = rebased
    ? {
        ...emptyTranscriptWindow(),
        epoch: input.epoch,
        rowCount: input.rowCount,
        clock,
      }
    : {
        ...window,
        rowCount: input.rowCount,
        invalidated: false,
        clock,
      };

  const tailRowIds = tailRowIdsFor(base, input);
  if (tailRowIds === null) return base;
  const tailSpan: HydratedSpan = {
    fromOrdinal: input.tail.fromOrdinal,
    rowIds: tailRowIds,
    messages: input.tail.messages,
    events: input.tail.events,
    bytes: recordsByteLength(input.tail.messages, input.tail.events),
    touchedAt: clock,
  };
  const spans = insertSpan(base.spans, tailSpan);
  return pruneSupersededLiveRecords({
    ...base,
    spans,
    hydratedBytes: totalBytes(spans),
  });
}

/**
 * Row ids for the tail the snapshot shipped inline.
 *
 * The tail is the one hydration that arrives WITHOUT row ids - it rides the
 * snapshot, which is emitted before the skeleton is streamed, so there are no
 * ids to carry that the client could check. Its extent is therefore taken
 * positionally, from `fromOrdinal` to `rowCount`, and its ids are filled from
 * the skeleton where the client already has it.
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
  const rowIds: string[] = [];
  for (let index = 0; index < extent; index += 1) {
    rowIds.push(base.skeleton[input.tail.fromOrdinal + index]?.rowId ?? "");
  }
  return rowIds;
}

/**
 * Place one chunk of the skeleton.
 *
 * Also the DELAYED identity check for anything hydrated before the skeleton
 * reached it: a chunk that lands on an ordinal whose held body claims a
 * different row id drops that body. Without this the eager tail - which is
 * seated with no ids to check against - would be permanently unverified.
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
  // A short assembly means chunks were lost. Serving ordinals off an index the
  // client KNOWS is incomplete is the one thing the coordinate cannot survive,
  // so declare it void and let the caller re-request rather than render a
  // transcript that is silently missing rows.
  const lost = complete && skeleton.length !== window.rowCount;
  const next: TranscriptWindow = {
    ...window,
    skeleton,
    skeletonComplete: complete && !lost,
    invalidated: window.invalidated || lost,
    clock: window.clock + 1,
  };
  return dropSpansContradictedBySkeleton(next, chunk);
}

function dropSpansContradictedBySkeleton(
  window: TranscriptWindow,
  chunk: ChatSkeletonChunk,
): TranscriptWindow {
  const chunkEnd = chunk.fromOrdinal + chunk.entries.length;
  const kept = window.spans.filter((span) => {
    const disjoint =
      spanEnd(span) <= chunk.fromOrdinal || span.fromOrdinal >= chunkEnd;
    if (disjoint) return true;
    return !spanContradictsSkeleton(window, span);
  });
  if (kept.length === window.spans.length) return window;
  return { ...window, spans: kept, hydratedBytes: totalBytes(kept) };
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
 */
export function applyIndexChange(
  window: TranscriptWindow,
  input: {
    readonly epoch: number;
    readonly rowCount: number;
    readonly changes: readonly ChatIndexChange[];
  },
): TranscriptWindow {
  if (input.changes.some((change) => change.type === "reindexed")) {
    return {
      ...emptyTranscriptWindow(),
      epoch: input.epoch,
      rowCount: input.rowCount,
      invalidated: true,
      clock: window.clock + 1,
    };
  }
  // Not a rebase: `appended` and `updated` deliberately retain the epoch,
  // because neither renumbers an ordinal. An epoch that does not match here is
  // a frame from a coordinate space this client has already left.
  if (input.epoch !== window.epoch) return window;

  let skeleton = [...window.skeleton];
  const updatedOrdinals: number[] = [];
  for (const change of input.changes) {
    if (change.type === "appended") {
      skeleton = [...skeleton, ...change.entries];
      continue;
    }
    if (change.type === "updated") {
      for (const { ordinal, entry } of change.entries) {
        skeleton[ordinal] = entry;
        updatedOrdinals.push(ordinal);
      }
    }
  }
  const next: TranscriptWindow = {
    ...window,
    skeleton,
    rowCount: input.rowCount,
    // A delta that grew the index past what the client has assembled means the
    // skeleton is no longer complete, even though it was.
    skeletonComplete:
      window.skeletonComplete && skeleton.length === input.rowCount,
    clock: window.clock + 1,
  };
  return dropSpansForUpdatedOrdinals(next, updatedOrdinals);
}

/**
 * Drop every span containing a rewritten row.
 *
 * The whole span, not the row - and that is forced, not lazy. A span's records
 * are a DEDUPLICATED union across its rows, so there is no client-side way to
 * say which records belong to the row that changed: the attribution lives in
 * the host's `rowRecordIds`, which needs the row's projection source. Keeping
 * the span and dropping "the row" would mean guessing, and a wrong guess
 * leaves a stale body rendered as current.
 *
 * The cost lands where it is cheapest: an `updated` almost always names the
 * streaming row at the tail, whose span the next snapshot re-seeds inline.
 */
function dropSpansForUpdatedOrdinals(
  window: TranscriptWindow,
  ordinals: readonly number[],
): TranscriptWindow {
  if (ordinals.length === 0) return window;
  const kept = window.spans.filter(
    (span) =>
      !ordinals.some(
        (ordinal) => ordinal >= span.fromOrdinal && ordinal < spanEnd(span),
      ),
  );
  if (kept.length === window.spans.length) return window;
  return { ...window, spans: kept, hydratedBytes: totalBytes(kept) };
}

/**
 * Seat one `range` response.
 *
 * Discarded outright on a stale epoch or a row-id mismatch. Both are the same
 * judgement: the response is internally consistent but describes a coordinate
 * space the client is no longer in, and re-fetching is cheap where seating it
 * is unrecoverable.
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
    return window;
  }
  const clock = window.clock + 1;
  const span: HydratedSpan = {
    fromOrdinal: response.fromOrdinal,
    rowIds: response.rowIds,
    messages: response.messages,
    events: response.events,
    bytes: recordsByteLength(response.messages, response.events),
    touchedAt: clock,
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
 * Every hydrated record, in transcript order, WITHOUT touching anything.
 *
 * What feeds `ChatSessionState.messages` / `.events`. Deliberately not
 * {@link selectHydratedRecords}: that one touches the spans it draws from for
 * eviction order, and this read covers the whole window — so using it here
 * would touch every span on every frame and flatten the LRU into no order at
 * all. Touching belongs to a VIEWPORT read, which arrives with placeholder
 * rows; until then eviction orders by hydration recency, which is wrong for
 * nothing that currently exists.
 */
export function hydratedRecords(window: TranscriptWindow): {
  readonly messages: readonly Message[];
  readonly events: readonly ChatEvent[];
} {
  // Spans FIRST, live records after, and both facts matter. Chronologically an
  // unplaced record is the newest thing the client has, so it sorts last
  // anyway; and the dedupe keeps the first occurrence, so if a copy has already
  // landed in a span the authoritative one wins here even in the window between
  // its arrival and the prune.
  return {
    messages: dedupeMessages([
      ...window.spans.map((span) => span.messages),
      window.liveMessages,
    ]),
    events: dedupeEvents([
      ...window.spans.map((span) => span.events),
      window.liveEvents,
    ]),
  };
}

/**
 * The records the renderer folds, for one ordinal span.
 *
 * Returns whatever is hydrated and says nothing about what is not - the
 * caller pairs this with {@link transcriptHydrationGaps} to draw placeholders
 * for the rest. Reading also TOUCHES the spans it drew from, which is what
 * keeps the region a reader is actually looking at from being evicted under
 * them.
 */
export function selectHydratedRecords(
  window: TranscriptWindow,
  range: OrdinalRange,
): {
  readonly window: TranscriptWindow;
  readonly messages: readonly Message[];
  readonly events: readonly ChatEvent[];
} {
  const clock = window.clock + 1;
  const drawnFrom: HydratedSpan[] = [];
  const spans = window.spans.map((span) => {
    const overlaps =
      span.fromOrdinal < range.toOrdinal && spanEnd(span) > range.fromOrdinal;
    if (!overlaps) return span;
    const touched: HydratedSpan = { ...span, touchedAt: clock };
    drawnFrom.push(touched);
    return touched;
  });
  return {
    window: { ...window, spans, clock },
    messages: dedupeMessages(drawnFrom.map((span) => span.messages)),
    events: dedupeEvents(drawnFrom.map((span) => span.events)),
  };
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
 * What to fetch next, or `null` when the window is already sufficient.
 *
 * Two obligations, in priority order:
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
 * 2. **The visible span**, whichever part of it is not hydrated.
 *
 * An invalidated window returns `null`: no range can repair a void index, and
 * issuing one against a coordinate space the client has left would seat bodies
 * under the wrong rows. The caller owes a `resnapshot` instead, which is a
 * different frame and a different decision.
 */
export function planTranscriptHydration(
  window: TranscriptWindow,
  visible: OrdinalRange | null,
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
  if (visible === null) return null;
  return transcriptHydrationGaps(window, visible)[0] ?? null;
}

/**
 * Evict the coldest spans until the window fits its byte budget.
 *
 * The tail is never evicted, however cold it looks. It is where a live turn
 * happens and where every snapshot re-seats content, so evicting it would
 * trade a bounded cache for an unbounded re-fetch loop - and it is the one
 * span whose absence is visible immediately.
 */
export function evictTranscriptWindowToBudget(
  window: TranscriptWindow,
  maxBytes: number,
): TranscriptWindow {
  if (window.hydratedBytes <= maxBytes) return window;
  const protectedSpan = window.spans.find(
    (span) => spanEnd(span) >= window.rowCount && window.rowCount > 0,
  );
  const evictable = window.spans
    .filter((span) => span !== protectedSpan)
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

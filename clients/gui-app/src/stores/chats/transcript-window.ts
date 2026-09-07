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
  importedChatMarkerRowId,
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
import type {
  ProtectedBytes,
  ProtectedRegionKind,
} from "@traycer-clients/shared/replica-runtime";

/**
 * The host serves a chat as a bounded snapshot, a row SKELETON streamed in chunks, and RANGES of
 * bodies fetched on demand.
 */

/** A contiguous run of hydrated rows. */
export interface HydratedSpan {
  readonly fromOrdinal: number;
  /** One row id per row served, in order. Its length is the span's extent. */
  readonly rowIds: readonly string[];
  /**
   * What these rows render WITH, by row id - the host's answer to derivations this client cannot
   * make from a bounded subset (`row-context.ts`).
   */
  readonly rowContext: Readonly<Record<string, TranscriptRowContext>>;
  /** Ledger references, in transcript order. See the interface doc. */
  readonly messageIds: readonly string[];
  readonly eventIds: readonly string[];
  /** What {@link rowContext} alone costs, measured once. */
  readonly contextBytes: number;
}

/**
 * One record's ledger entry: the single owned copy plus its clocks and charge. `bytes` is the
 * SETTLED measure.
 */
interface LedgerRecordEntry<T> {
  readonly record: T;
  readonly bytes: number;
  readonly servedAt: number;
  readonly touchedAt: number;
}

/**
 * The window's single-ownership record store - class E's spine. Spans reference records by id;
 * this holds the one copy of each.
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
   * Skeleton entries by ordinal, SPARSE while chunks are still streaming. A hole is "not delivered
   * yet", never "no such row" - `rowCount` is the authority on length.
   */
  readonly skeleton: readonly (RowSkeletonEntry | undefined)[];
  /** Set by the chunk carrying `isFinal`, once its length agrees with `rowCount`. */
  readonly skeletonComplete: boolean;
  /**
   * Exclusive end of the contiguous prefix the CURRENT skeleton stream has delivered, counted from
   * ordinal 0.
   */
  readonly skeletonStreamCoveredThrough: number;
  /**
   * The host index revision this window's skeleton reflects, within its epoch. The ONLY signal that
   * an `updated`-only index delta was lost.
   */
  readonly indexRevision: number;
  /**
   * Whether the next CONCRETE revision may legitimately be lower than the held one - i.e. whether a
   * rebuild boundary has been crossed since it was set.
   */
  readonly indexRevisionRebuilding: boolean;
  /**
   * The single owned copy of every span-referenced record. See
   * {@link RecordLedger}; spans hold ids into it.
   */
  readonly records: RecordLedger;
  /** Disjoint and sorted by `fromOrdinal`. */
  readonly spans: readonly HydratedSpan[];
  /** Spans a rebase or index void discarded, retained for DISPLAY ONLY. */
  readonly staleSpans: readonly HydratedSpan[];
  readonly liveMessages: readonly Message[];
  readonly liveEvents: readonly ChatEvent[];
  /** Live messages carried across the latest snapshot boundary. */
  readonly snapshotProvisionalMessageIds: readonly string[];
  /** Row-producing live events carried across the latest snapshot boundary. */
  readonly snapshotProvisionalEventIds: readonly string[];
  /** Rows the current authority declared incomplete; do not hot-loop them. */
  readonly unavailableRowIds: readonly string[];
  /** Ordinals paired with unavailable row ids, including pre-skeleton serves. */
  readonly unavailableRowOrdinals: readonly number[];
  /**
   * The FRESH tier's charge: every ledger record a fresh span references (fresh-exclusive AND shared
   * with stale, counted once) plus the fresh spans' structural bytes. See {@link freshTierBytes}.
   */
  readonly hydratedBytes: number;
  /** How the last eviction pass ended - `"none"` until one runs over budget. */
  readonly evictionTerminal:
    | "none"
    | "over-budget-accepted"
    | "alias-group-unbreakable";
  /** MESSAGE ids whose latest rewrite is not yet reflected in {@link hydratedBytes}. */
  readonly unsettledByteMessageIds: readonly string[];
  /** The index is void and only a `resnapshot` repairs it. */
  readonly invalidated: boolean;
  /**
   * The ordinals the reader last reported looking at, or `null` before any report. Retained because
   * the STALE tier is bounded from places the viewport is not a parameter of.
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

/** How many bodies to keep hydrated before evicting the coldest span. */
export { TRANSCRIPT_WINDOW_MAX_BYTES } from "@/stores/replica-memory/budget-limits";
import { TRANSCRIPT_WINDOW_MAX_BYTES } from "@/stores/replica-memory/budget-limits";

/** How large a span may grow by absorbing the span NEXT to it. */
export const SPAN_MERGE_MAX_BYTES = 1024 * 1024;

/** How many rows to hydrate when a snapshot arrives with an EMPTY tail. */
export const EAGER_TAIL_ROW_COUNT = 20;

/** How many row-less live events the window keeps. */
export const MAX_LIVE_EVENTS = 512;

export function emptyTranscriptWindow(): TranscriptWindow {
  return {
    epoch: 0,
    rowCount: 0,
    skeleton: [],
    skeletonComplete: false,
    skeletonStreamCoveredThrough: 0,
    indexRevision: 0,
    // ARMED, not clear. A window with no counter behind it must adopt the first concrete revision it
    // is given rather than compare against a zero it never received.
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

/** A span's message records, resolved through the ledger, in span order. */
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
 * Seat served records into the ledger: each gets the one owned copy, a fresh measure, and
 * `servedAt`/`touchedAt` at the seating clock.
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
 * The reference-counted release: drop every ledger entry no span references. Run at the end of
 * every fold that can shrink a tier.
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
 * The ledger a carry takes into a rebased or voided window: exactly the entries the carried spans
 * reference.
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
 * The stale tier a snapshot carries across an index boundary, with the ledger cut down to what it
 * references.
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

/** The fresh tier's charge - see {@link TranscriptWindow.hydratedBytes}. */
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
 * How much an in-place rewrite moved the LIVE term of {@link TranscriptWindow.hydratedBytes} - the
 * symmetric half of `rewriteWindowMessage`'s `freshReferenced` adjustment, and the only thing that
 */
function liveRewriteByteDelta(
  charge: "now" | "deferred",
  before: readonly Message[],
  after: readonly Message[],
  index: number,
): number {
  if (charge !== "now" || index < 0) return 0;
  const previous = before[index];
  const next = after[index];
  if (next === previous) return 0;
  return recordByteLength(next) - recordByteLength(previous);
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
 * The window's full charge: the fresh tier PLUS the live tail. A plain sum, and it is the
 * disjointness that makes it one.
 */
function chargedWindowBytes(
  ledger: RecordLedger,
  spans: readonly HydratedSpan[],
  liveMessages: readonly Message[],
  liveEvents: readonly ChatEvent[],
): number {
  return (
    freshTierBytes(ledger, spans) + recordsByteLength(liveMessages, liveEvents)
  );
}

/**
 * What the window currently retains, in bytes - the figure {@link evictTranscriptWindowToBudget}
 * reads, and the one a process-wide accountant should settle.
 */
export function transcriptWindowChargedBytes(window: TranscriptWindow): number {
  return chargedWindowBytes(
    window.records,
    window.spans,
    window.liveMessages,
    window.liveEvents,
  );
}

/**
 * The stale tier's charge against remaining headroom: stale-EXCLUSIVE record bytes (a record the
 * fresh tier also references is already inside {@link TranscriptWindow.hydratedBytes} - charging
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
 * One span's charge-inclusive figure: every referenced record at full size (aliases NOT deduped -
 * a deduped ceiling would let spans sharing a turn's records merge into the unbounded tail the cap
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
 * Cached per span object at a ledger revision: span identity survives every in-place rewrite
 * (spans hold ids), and a rewrite changes no membership and no row id, so the drawn SET is stable
 */
const spanDrawsCache = new WeakMap<
  HydratedSpan,
  { readonly revision: number; readonly draws: SpanDraws }
>();

/** Which of a span's records it DRAWS, as opposed to merely holds. */
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

/** The row->record half of {@link spanDraws}, over a caller-chosen subset of the span's rows. */
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

/** A span's derived warmth: the greatest `touchedAt` among the records it draws. */
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
 * One span's charge-inclusive figure, derived on demand - the metric the merge ceiling reads
 * ({@link derivedSpanBytes}), exported so a test can pin the ceiling against the ledger without
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
 * Fold one record set's BACKABLE identities into `into` - the derived id shapes every tier
 * produces the same way: a message backs the row carrying its id, an event backs its transcript
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
    into.add(importedChatMarkerRowId(event.eventId));
    if (event.type === "turn.stopped" && event.turnId !== null) {
      into.add(assistantRowId(event.turnId));
    }
  }
}

/**
 * Take a record the client received with no ordinal. The write-through half of the decision that
 * `state.messages` is DERIVED on this line.
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
  // The ledger IS the span tiers' membership - fresh and the stale carry alike.
  for (const id of window.records.messages.keys()) knownMessages.add(id);
  for (const id of window.records.events.keys()) knownEvents.add(id);
  const messages = input.messages.filter(
    (message) => !knownMessages.has(message.messageId),
  );
  const events = input.events.filter(
    (event) => !knownEvents.has(event.eventId),
  );
  if (messages.length === 0 && events.length === 0) return window;
  // Capped here as well as in `pruneSupersededLiveRecords`, because that runs after a SPAN mutation
  // and this path does not need one: a session that only sends - no scrolling, no eviction, no range
  const appendedEvents = [...window.liveEvents, ...events];
  const overflow = appendedEvents.length - MAX_LIVE_EVENTS;
  const trimmed = overflow > 0 ? appendedEvents.slice(0, overflow) : [];
  const liveEvents =
    overflow > 0 ? appendedEvents.slice(overflow) : appendedEvents;
  const liveMessages = [...window.liveMessages, ...messages];
  return {
    ...window,
    liveMessages,
    liveEvents,
    // Delta of the NEW records minus any events the cap just dropped. Re-measuring the whole live set
    // here would stringify every retained event on each append - quadratic in the cap.
    hydratedBytes:
      window.hydratedBytes +
      recordsByteLength(messages, events) -
      recordsByteLength([], trimmed),
    clock: window.clock + 1,
  };
}

/** Drop live records the spans now carry authoritatively. Runs after every span mutation. */
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
  // Span-supersession alone cannot bound this set, and that is not a tuning matter - it is a whole
  // CLASS of event the rule can never reach.
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
  // THE disjointness seam.
  return {
    ...window,
    liveMessages,
    liveEvents,
    hydratedBytes: chargedWindowBytes(
      window.records,
      window.spans,
      liveMessages,
      liveEvents,
    ),
  };
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
  // A legacy tail with no declared identities is seated positionally from the retained skeleton.
  if (tail.rowIds === undefined) return [];
  return completeServedRowIds(tail.rowIds, tail.incompleteRowIds);
}

/**
 * Replace a message wherever the window holds it, live or hydrated. The in-place half: an image
 * resolving, a steer split moving blocks, a detached-subagent event attaching to its owner.
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
 * The same rewrite, for the ACTIVE TURN's row. Identical in every respect except when the bytes
 * are charged: this one defers (see {@link TranscriptWindow.unsettledByteMessageIds}).
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

/** Rewrite EVERY message the window holds, live and hydrated. */
export function mapWindowMessages(
  window: TranscriptWindow,
  update: (message: Message) => Message,
  witnesses: ImageWitnessStore | null,
): TranscriptWindow {
  // ONE pass over the ledger, because the ledger holds the one copy of every span-referenced record
  // - the per-tier walks this replaced were the same records visited once per holder.
  let ledgerChanged = false;
  const nextEntries = new Map<string, LedgerRecordEntry<Message>>();
  for (const [id, entry] of window.records.messages) {
    const record = update(entry.record);
    if (record === entry.record) {
      nextEntries.set(id, entry);
      continue;
    }
    // The rewritten object descends from the held one - its image evidence (stamps, capture moment)
    // follows it, or rule 2 goes silent for every source the next witnessed write does not re-stamp.
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
  // The revision moves: a remap can rename `turnId`s, which the draws relation reads through the
  // record contents - unlike a streaming block delta, which never touches an identity.
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
    // `liveChanged` counts here, not just `ledgerChanged`: the live tail is a TERM of this figure, so
    // a remap that rewrote only live rows still moved it.
    hydratedBytes:
      ledgerChanged || liveChanged
        ? chargedWindowBytes(
            records,
            window.spans,
            liveChanged ? liveMessages : window.liveMessages,
            window.liveEvents,
          )
        : window.hydratedBytes,
  });
}

/** Bring the byte figures back in line with what the ledger actually holds. */
export function settleWindowBytes(window: TranscriptWindow): TranscriptWindow {
  if (window.unsettledByteMessageIds.length === 0) return window;
  let ledgerChanged = false;
  let liveChanged = false;
  const nextEntries = new Map(window.records.messages);
  for (const id of window.unsettledByteMessageIds) {
    const entry = nextEntries.get(id);
    if (entry === undefined) {
      // A LIVE-only record. There is no ledger entry to re-measure into - the live term is derived at
      // the recompute below, never stored per record - so marking the window dirty IS its settle.
      if (window.liveMessages.some((message) => message.messageId === id)) {
        liveChanged = true;
      }
      continue;
    }
    const bytes = recordByteLength(entry.record);
    if (bytes === entry.bytes) continue;
    ledgerChanged = true;
    nextEntries.set(id, { ...entry, bytes });
  }
  // No revision bump: a settle changes charges, never membership, serve identity, or anything a
  // (spans, revision)-keyed memo reads.
  const records = ledgerChanged
    ? {
        messages: nextEntries,
        events: window.records.events,
        revision: window.records.revision,
      }
    : window.records;
  // Bounded here rather than only where the tier is BUILT: settling is the moment a deferred stale
  // figure becomes true, so it is the first moment the shared budget can be judged at all.
  return boundStaleTierToBudget({
    ...window,
    records,
    hydratedBytes:
      ledgerChanged || liveChanged
        ? chargedWindowBytes(
            records,
            window.spans,
            window.liveMessages,
            window.liveEvents,
          )
        : window.hydratedBytes,
    unsettledByteMessageIds: [],
  });
}

/** Re-apply the shared budget to the stale tier, but only when it is breached. */
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
  // ONE ledger entry, wherever it is referenced from - the per-holder walk this replaced was the
  // same record rewritten once per span.
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
    // The rewritten object descends from the held one - its image evidence (stamps, capture moment)
    // follows it.
    witnesses?.carryRewrittenCopy(entry.record, next);
    // `deferred` skips even that one measure - see `unsettledByteMessageIds` for why the streaming
    // path cannot afford a serialization of a growing row per delta.
    const bytes = charge === "deferred" ? entry.bytes : recordByteLength(next);
    const nextEntries = new Map(window.records.messages);
    nextEntries.set(messageId, {
      record: next,
      bytes,
      servedAt: entry.servedAt,
      // A write, which is what `touchedAt` records - bumped ONCE, on the record, so every span DRAWING
      // it warms identically and a span merely holding it as a rider inherits nothing.
      touchedAt: clock,
    });
    // No revision bump: a block delta touches record contents, never membership, serve identity, or an
    // id the backing folds read - this is exactly the stability the (spans, revision)-keyed memos are
    records = {
      messages: nextEntries,
      events: window.records.events,
      revision: window.records.revision,
    };
    if (charge === "now" && bytes !== entry.bytes) {
      // The fresh term moves only when a FRESH span references the record; a stale-exclusive rewrite is
      // the stale tier's business and the bound below re-judges it.
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
  hydratedBytes += liveRewriteByteDelta(
    charge,
    window.liveMessages,
    liveMessages,
    liveIndex,
  );
  const next: TranscriptWindow = {
    ...window,
    records,
    liveMessages,
    hydratedBytes,
    // A LIVE-only record (`entry === undefined`) is marked too.
    unsettledByteMessageIds:
      charge === "now" || window.unsettledByteMessageIds.includes(messageId)
        ? window.unsettledByteMessageIds
        : [...window.unsettledByteMessageIds, messageId],
    clock,
  };
  return {
    // A `now` charge lands immediately, so the budget can be judged immediately.
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

/** What a span's row context costs on the wire it arrived on. */
function contextByteLength(
  rowContext: Readonly<Record<string, TranscriptRowContext>>,
): number {
  if (Object.keys(rowContext).length === 0) return 0;
  return utf8ByteLength(JSON.stringify(rowContext));
}

/**
 * Whether the skeleton contradicts these row ids at this placement. Only entries the client
 * actually HOLDS are compared.
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

/** Concatenate groups of record ids, keeping each ONCE at its first occurrence. */
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

/** Does this span hold any of `recordIds`? */
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

/** Insert one span, merging it with every span it touches or overlaps. */
function insertSpan(
  ledger: RecordLedger,
  unsettled: ReadonlySet<string>,
  spans: readonly HydratedSpan[],
  incoming: HydratedSpan,
): readonly HydratedSpan[] {
  const untouched: HydratedSpan[] = [];
  const overlapping: HydratedSpan[] = [];
  // Adjacency is absorbed only while the result stays a unit eviction can reclaim (see
  // SPAN_MERGE_MAX_BYTES).
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
  // Row ids are seated by ORDINAL rather than concatenated: the members overlap, so appending would
  // double-count the shared rows. Incoming last so it overwrites where it disagrees.
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
  // Re-measured rather than summed from the members: the merge DEDUPES the context map, so adding
  // the members' charges would bill every row a re-served span shares with the one it superseded.
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

/** How a snapshot's revision relates to the one this window holds. */
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
  // Its turn key still provides the exact link to the replacement skeleton row, so do not require
  // local projection to reconstruct an association the skeleton already names.
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

/** Seat a windowed snapshot. */
export function applyWindowedSnapshot(
  window: TranscriptWindow,
  input: {
    readonly epoch: number;
    readonly rowCount: number;
    /**
     * The revision the HOST believes this client's index is at, or `null` when it is about to restream
     * the whole skeleton and there is nothing to compare. See the field's doc on the wire schema.
     */
    readonly indexRevision: number | null;
    readonly tail: ChatTranscriptWindow;
  },
  /** The streaming turn, if any. */
  activeTurnId: string | null,
  /** The session's witness store, or `null` where none exists. */
  witnesses: ImageWitnessStore | null,
): TranscriptWindow {
  // A snapshot from an epoch this window has already LEFT describes a coordinate space whose
  // ordinals were renumbered by the very change that moved this window on.
  if (input.indexRevision !== null && input.epoch < window.epoch) return window;
  const rebased = input.epoch !== window.epoch;
  const clock = window.clock + 1;
  // A same-epoch snapshot whose revision RAN AHEAD of this client's is proof that index deltas were
  // emitted against the skeleton it is holding and never arrived.
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
  // Snapshots travel on the bulk lane and can be overtaken by interactive live records even when
  // they announce a new epoch.
  const { spans: carriedStaleSpans, ledger: carriedLedger } = carriedStaleTier(
    reconciledWindow,
    rebased || missedDeltas,
    input.rowCount,
  );
  const base: TranscriptWindow =
    rebased || missedDeltas
      ? {
          ...emptyTranscriptWindow(),
          // A settling turn is frozen into an unplaced live record before the host assigns its durable row
          // an ordinal.
          liveMessages: provisionalLiveMessages,
          liveEvents: provisionalLiveEvents,
          epoch: input.epoch,
          rowCount: input.rowCount,
          indexRevision: input.indexRevision ?? 0,
          // A concrete revision here IS the new baseline, so the flag the
          // spread armed is spent. `null` leaves it armed for the restream.
          indexRevisionRebuilding: input.indexRevision === null,
          staleSpans: carriedStaleSpans,
          records: carriedLedger,
          unsettledByteMessageIds:
            reconciledWindow.unsettledByteMessageIds.filter((id) =>
              carriedLedger.messages.has(id),
            ),
          invalidated: missedDeltas,
          // Carried for the same reason the void carries it: the reader has not moved because the index was
          // replaced, and the carry they are looking at is bounded above before any new report can arrive.
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
          // A restreaming snapshot (`null`) leaves the held revision alone: the skeleton chunks that follow
          // do not carry one, so overwriting it here would lose the client's place in the delta sequence.
          indexRevision: input.indexRevision ?? window.indexRevision,
          // Spent by a concrete revision, re-armed by another rebuild. Exactly one concrete frame is exempt
          // from the direction rules, so the suppression cannot outlive the boundary that granted it.
          indexRevisionRebuilding: input.indexRevision === null,
          // RE-DERIVED, never carried, and FALSE outright at a rebuild. Two different losses, one field.
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

  // `rowCount` is authoritative even when a same-epoch `null` revision merely announces a
  // replacement skeleton stream.
  const boundedBase = boundWindowToRowCount(snapshotBase, input.rowCount);
  const tailRowIds = tailRowIdsFor(boundedBase, input);
  if (tailRowIds === null) {
    // Two different "no tail" answers, and only one of them is inert. `fromOrdinal >= rowCount` is a
    // transcript with no tail rows at all - nothing to seat and nothing held that could be stale.
    return input.rowCount - input.tail.fromOrdinal > 0
      ? dropSpansOverlappingFrom(boundedBase, input.tail.fromOrdinal)
      : boundedBase;
  }
  // Keyed by row id exactly as a range's is, so a tail seated on the positional ids `tailRowIdsFor`
  // falls back to simply misses every lookup rather than seating context under the wrong row.
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
 * Stamp what a seat just landed: a served copy infers its per-source stamps by unique content
 * match, a held substitute already carries its own (the stamping is idempotent per object).
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
  // An accepted concrete snapshot is the authoritative-replacement member of the lineage boundary:
  // it RESETS witnesses and lineage for exactly the records it seats here - conflicting/withheld
  if (witnesses !== null) {
    for (const message of tail.messages) {
      if (message.role === "assistant") {
        witnesses.resetServedRecord(message.messageId);
      }
    }
  }
  const messages = preferFresherHeldMessages(
    completeBase,
    tail.messages,
    input.activeTurnId,
    witnesses,
  );
  // Captures land post-reset: a snapshot-seated copy stamps against the record's cleared occurrence
  // list, which is the fresh-lineage floor rule 3 reads.
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
        hydratedBytes: chargedWindowBytes(
          records,
          spans,
          completeBase.liveMessages,
          completeBase.liveEvents,
        ),
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
  // Zero rows is authority about the ROWS, not the coordinates: nothing the stale bodies describe
  // exists any more, whatever ordinals they carried.
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
    hydratedBytes: chargedWindowBytes(
      window.records,
      spans,
      window.liveMessages,
      window.liveEvents,
    ),
    skeletonStreamCoveredThrough: Math.min(
      window.skeletonStreamCoveredThrough,
      rowCount,
    ),
    skeletonComplete:
      window.skeletonComplete && coversEveryOrdinal(skeleton, rowCount),
  });
}

/**
 * Drop every span reaching at or past `fromOrdinal`. Whole spans, including one that only
 * PARTIALLY overlaps.
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
    hydratedBytes: chargedWindowBytes(
      window.records,
      kept,
      window.liveMessages,
      window.liveEvents,
    ),
  });
}

/**
 * Row ids for the tail the snapshot shipped inline. The tail names its own rows when the host says
 * so, exactly as a range does.
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
  // A host that named its rows is believed, including when it named NONE - a zero-extent span would
  // claim an ordinal range it does not cover, and the planner is the thing that answers "the tail
  if (declared !== undefined) return declared.length === 0 ? null : declared;
  const rowIds: string[] = [];
  for (let index = 0; index < extent; index += 1) {
    rowIds.push(base.skeleton[input.tail.fromOrdinal + index]?.rowId ?? "");
  }
  return rowIds;
}

/** Place one chunk of the skeleton. */
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
  const coveredThrough =
    chunk.fromOrdinal === window.skeletonStreamCoveredThrough
      ? chunk.fromOrdinal + chunk.entries.length
      : window.skeletonStreamCoveredThrough;
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
 * Once a replacement skeleton is COMPLETE, it is authority on which rows exist: a stale span none
 * of whose rows it names describes history that is gone, and keeping it would let a deleted row
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

/** Where the skeleton currently names each row id. */
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

/** The row ids the FRESH tier DRAWS - one per row served, markers excluded. */
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

/** Which carry the row merger would DRAW each row from, when two hold it. */
const staleRowOwnerCache = new WeakMap<
  readonly HydratedSpan[],
  {
    readonly revision: number;
    readonly owners: ReadonlyMap<string, HydratedSpan>;
  }
>();

/**
 * The stale tier by descending derived serve stamp - the walk order `seatStaleRows` places rows
 * in, exported so the row merger and {@link staleRowOwners} cannot drift onto different orderings
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
 * Whether every ordinal below `rowCount` has an entry. One O(rowCount) pass, paid once per
 * skeleton stream on the final chunk only
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
 * Reconcile the spans an index delivery now has authority over, across `[fromOrdinal, toOrdinal)`.
 * Two things, because the delivery answers both at once for the same rows.
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
      hydratedBytes: chargedWindowBytes(
        window.records,
        kept,
        window.liveMessages,
        window.liveEvents,
      ),
    }),
    adoptedAssistantTurns,
  );
}

/** Fill a span's unverified row ids from the skeleton, or return it unchanged. */
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

/** The ordinals whose BODIES a delta invalidates, or `"all"`. */
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

/** Is this `updated` frame the index's own echo of the turn the client is already streaming? */
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

/** Widen an `updated`'s ordinals to every row its rewritten RECORDS can reach. */
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

/** What a rebase or void carries into {@link TranscriptWindow.staleSpans}. */
function staleCarrySpans(window: TranscriptWindow): readonly HydratedSpan[] {
  const candidates = [...window.spans, ...window.staleSpans];
  // Zero live bytes: a rebase or void discards the fresh spans, so the whole window budget is
  // headroom for the carry.
  return boundedStaleSpans(
    // A rebase or void discards every fresh span, so nothing is drawn by that
    // tier any more and the candidates are exactly what remains on screen.
    { ...window, spans: [] },
    candidates,
    0,
  );
}

function boundedStaleSpans(
  /**
   * The window as it will be AFTER this bound - specifically its `spans`, the fresh tier that
   * survives.
   */
  after: TranscriptWindow,
  candidates: readonly HydratedSpan[],
  liveBytes: number,
): readonly HydratedSpan[] {
  // Warmth first, then the FRESHEST SERVE - and the second key is not a tidiness preference, it is
  // the only thing deciding which of two carries holding one row survives.
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
  const ownerOf = staleRowOwners(after, candidates);
  const drawsViewport =
    after.visibleOrdinals === null
      ? (): boolean => false
      : staleSpanVisibleIn(after, candidates, after.visibleOrdinals);
  const coveredRowIds = new Set<string>();
  const carried: HydratedSpan[] = [];
  // The stale charge is stale-EXCLUSIVE: a record the surviving fresh tier references is already
  // inside `liveBytes` (the fresh term), and a record an already-admitted carry charged is one
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
    // Coverage BEFORE the budget, so "the warmest contributing span" is the one admitted below rather
    // than whichever duplicate sorted first.
    if (!span.rowIds.some(uncovered) && !drawsViewport(span)) continue;
    // EVERY carry drawing the viewport is exempt, not just the first one admitted.
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
  // Selected by warmth, STORED in ordinal order.
  return carried.sort((left, right) => left.fromOrdinal - right.fromOrdinal);
}

/** Drop every stale span whose rows a FRESH span now fully covers. Runs after each seat. */
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
  // Rebalanced against the bytes the fresh spans NOW hold, not only bounded at the carry: every seat
  // that grows the fresh tier shrinks the stale tier's headroom, so the shared budget keeps holding
  const bounded = boundedStaleSpans(window, uncovered, window.hydratedBytes);
  const unchanged =
    bounded.length === window.staleSpans.length &&
    bounded.every((span) => window.staleSpans.includes(span));
  return unchanged
    ? window
    : pruneUnreferencedRecords({ ...window, staleSpans: bounded });
}

/** The window a frame has just proved unusable: void, at the frame's own coordinates. */
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
    // `reindexed` is the middle frame of the held-subscriber completion handoff: the rebasing snapshot
    // has already frozen the assistant, while the replacement skeleton/range have not arrived yet.
    liveMessages,
    // Live EVENTS travel with them, under the rule {@link provisionalLiveEventsForSnapshot} already
    // states for this same question: an INVALIDATING transition retains what the client holds live.
    liveEvents: input.rowCount > 0 ? window.liveEvents : [],
    // The discarded bodies stay renderable while the replacement index streams in - see {@link
    // TranscriptWindow.staleSpans}.
    staleSpans: carriedStaleSpans,
    records,
    unsettledByteMessageIds: window.unsettledByteMessageIds.filter((id) =>
      records.messages.has(id),
    ),
    invalidated: true,
    // The reader has not moved because the index was replaced, and the carry they are looking at is
    // bounded before any new report can arrive. See the field.
    visibleOrdinals: window.visibleOrdinals,
    clock: window.clock + 1,
  };
}

/**
 * The all-invalidating fold: void at the frame's coordinates - or, for a frame that merely REPEATS
 * the void this window already is, the same window by identity.
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
 * Apply an `indexChanged` delta. The three cases are what the client can actually do to its row
 * set, and each costs something different:
 */
export function applyIndexChange(
  window: TranscriptWindow,
  input: {
    readonly epoch: number;
    readonly rowCount: number;
    readonly indexRevision: number;
    readonly changes: readonly ChatIndexChange[];
    /** The turn currently streaming, if any - the store's `activeTurn`. */
    readonly activeTurnId: string | null;
  },
): TranscriptWindow {
  // Before the change kinds are even read: a straggler's `reindexed` describes a space this window
  // has left, and acting on it would wipe a live window and rewind it onto dead coordinates.
  if (input.epoch < window.epoch) return window;
  const invalidated = bodyInvalidatingOrdinals(input.changes);
  if (invalidated === "all" || input.epoch > window.epoch) {
    return idempotentlyVoidedTranscriptWindow(window, input);
  }

  // Is this frame NEWS - and if so, is it the NEXT news?
  if (!window.indexRevisionRebuilding) {
    if (input.indexRevision <= window.indexRevision) return window;
    if (input.indexRevision !== window.indexRevision + 1) {
      return voidedTranscriptWindow(window, input);
    }
  }

  // A frame can be LOST without the stream dying: the host's pump surfaces a deterministic send
  // failure as fatal, but keeps drop-and-continue for a flaky socket write.
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
  // Appended entries are seated at the ordinals they NAME - which begin at the frame's own pre-delta
  // `rowCount` (`appendBase`) - and never at `skeleton.length`.
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
  // How far the skeleton STREAM has contiguously reached once this frame is folded in.
  const coveredThrough =
    window.skeletonStreamCoveredThrough === appendBase
      ? Math.max(appendCursor, input.rowCount)
      : window.skeletonStreamCoveredThrough;
  const next: TranscriptWindow = {
    ...window,
    skeleton,
    rowCount: input.rowCount,
    indexRevision: input.indexRevision,
    // Spent: this delta's revision is now the baseline the next one is compared against, whether it
    // was adopted under the boundary or earned by being the immediate successor.
    indexRevisionRebuilding: false,
    unavailableRowIds: [],
    unavailableRowOrdinals: [],
    // Whether the client holds a COMPLETE index once this frame is folded in, re-derived from the two
    // conditions {@link applySkeletonChunk} uses - and deliberately NOT gated on the completeness this
    skeletonComplete:
      coveredThrough >= input.rowCount &&
      coversEveryOrdinal(skeleton, input.rowCount),
    skeletonStreamCoveredThrough: coveredThrough,
    clock: window.clock + 1,
  };
  // This delta is the first authority to name the ordinals it just appended, so it owes them the
  // identity resolution a skeleton chunk owes its own - and it is the LAST authority that will ever
  const reconciled =
    appendCursor > appendBase
      ? reconcileSpansWithSkeleton(next, appendBase, appendCursor)
      : next;
  return reconcileUpdatedBodies(reconciled, input, invalidated);
}

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
 * Drop every span containing a rewritten row - and every span holding a COPY of what those spans
 * held. The whole span, not the row - and that is forced, not lazy.
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
  const hydratedBytes = chargedWindowBytes(
    window.records,
    kept,
    window.liveMessages,
    window.liveEvents,
  );
  return pruneUnreferencedRecords({
    ...window,
    spans: kept,
    // The dropped bodies keep rendering while the refetch is in flight - a rewrite's brief stale body
    // beats a placeholder flash, and the gap the drop opens still refetches either way.
    staleSpans: boundedStaleSpans(
      { ...window, spans: kept },
      [...dropped, ...window.staleSpans],
      hydratedBytes,
    ),
    hydratedBytes,
  });
}

/** The window's own copy of a record - the one {@link hydratedRecords} RENDERS. */
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
 * Does the window hold the active turn's assistant message ANYWHERE - live, fresh span, or stale
 * span?
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

/** While a turn streams, the held copy of its assistant message outranks any served one. */
function preferFresherHeldMessages(
  window: TranscriptWindow,
  messages: readonly Message[],
  activeTurnId: string | null,
  witnesses: ImageWitnessStore | null,
): readonly Message[] {
  // A Map rather than a copied-array-in-a-closure: an assignment inside a callback is invisible to
  // control-flow narrowing, which this module has paid for before (see {@link
  const substitutions = new Map<number, Message>();
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    const active =
      activeTurnId !== null && assistantTurnKey(message) === activeTurnId;
    // The ARM decides which rules run: the active arm never consults the settled evidence rules - the
    // stream is its authority, and `heldCopyIsBehindServed` alone displaces it.
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
 * Can the held copy be PROVEN newer than the one the host just served? The opposite polarity to
 * {@link heldCopyIsBehindServed}, and the asymmetry is the point rather than an oversight.
 */
function heldCopyIsAheadOfServed(
  held: Message,
  served: Message,
  witnesses: ImageWitnessStore | null,
): boolean {
  if (held.role !== "assistant" || served.role !== "assistant") return false;
  // Behind on BLOCKS disqualifies it whatever the images say: substituting would trade block content
  // the host has for image state the client has, and the two are not exchangeable.
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
  return imageEvidenceSaysHeldAhead(held, served, witnesses);
}

/**
 * The sources on which the two copies genuinely disagree - present on one side only, or present on
 * both with different CONTENT.
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

/** The settled arm's image tiebreak: does DIRECTIONAL evidence say the held copy is ahead? */
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

/** Can the held copy be PROVEN older than the one the host just served? */
function heldCopyIsBehindServed(held: Message, served: Message): boolean {
  if (held.role !== "assistant" || served.role !== "assistant") return false;
  const heldVersion = held.blocksVersion;
  const servedVersion = served.blocksVersion;
  if (heldVersion === undefined || servedVersion === undefined) return false;
  return heldVersion < servedVersion;
}

/**
 * Seat one `range` response. Discarded on a stale epoch or a row-id mismatch - but those are NOT
 * the same judgement, and treating them as one was a defect.
 */
export function applyRangeResponse(
  window: TranscriptWindow,
  response: ChatRangeResponse,
  /** The streaming turn, if any - see {@link preferFresherHeldMessages}. */
  activeTurnId: string | null,
  /** The session's witness store, or `null` where none exists (the legacy line). */
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
        hydratedBytes: chargedWindowBytes(
          records,
          spans,
          completeWindow.liveMessages,
          completeWindow.liveEvents,
        ),
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

/** Everything the hydrated spans can say about how their rows render, by row id. */
export function hydratedRowContext(
  window: TranscriptWindow,
): Readonly<Record<string, TranscriptRowContext>> {
  const out: Record<string, TranscriptRowContext> = {};
  // Stale first, so a fresh span's context overwrites a carried copy of the same row - the map is
  // keyed by row id, which is the axis stale spans are consumed on.
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
 * Three-state because "not found" is not an answer on this line. The whole `state.messages` sweep
 * is this distinction, and a boolean would force every caller to pick a side of it silently.
 */
export type WindowRowPresence = "present" | "absent" | "unknown";

/** Does this transcript hold a row that RENDERS as `user`? */
export function userRowPresence(window: TranscriptWindow): WindowRowPresence {
  if (window.rowCount === 0) return "absent";
  if (window.skeleton.some((entry) => entry?.role === "user")) return "present";
  return window.skeletonComplete ? "absent" : "unknown";
}

/** Whether the LAST row's body is held. */
export function isTailHydrated(window: TranscriptWindow): boolean {
  if (window.rowCount === 0) return true;
  const last = window.rowCount - 1;
  return window.spans.some(
    (span) => span.fromOrdinal <= last && spanEnd(span) > last,
  );
}

/** Does the window hold EVERY record at or after the one carrying `messageId`? */
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
  // Coverage, not a single span.
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
 * Every hydrated record, in transcript order, WITHOUT touching anything. What feeds
 * `ChatSessionState.messages` / `.events`.
 */
export function hydratedRecords(window: TranscriptWindow): {
  readonly messages: readonly Message[];
  readonly events: readonly ChatEvent[];
  /**
   * What these rows render WITH - returned HERE rather than read separately so a consumer cannot
   * publish the records without the context that describes them.
   */
  readonly rowContext: Readonly<Record<string, TranscriptRowContext>>;
} {
  // Fresh and stale merged in TRANSCRIPT order, because this function's contract is transcript order
  // and `dedupeByFreshestSpan` fixes each record's POSITION at first encounter (only the body
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
 * Merge two ordinal-ordered span tiers, the FIRST winning ties. O(fresh + stale), no allocation
 * beyond the output array - written for the per-token path {@link hydratedRecords} sits on.
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
      // `nextFresh` is non-null here: the loop condition guarantees at least one side remains, and this
      // branch is taken only when stale is exhausted or fresh leads.
      if (nextFresh !== null) merged.push(nextFresh);
      freshIndex += 1;
      continue;
    }
    merged.push(nextStale);
    staleIndex += 1;
  }
  return merged;
}

/** Every record the window holds, positioned by ORDINAL and bodied by the LEDGER. */
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

/** Advance `touchedAt` on every span overlapping `range`. The read half of the LRU. */
export function touchTranscriptRange(
  window: TranscriptWindow,
  range: OrdinalRange | null,
): TranscriptWindow {
  // `null` is "no placed row is visible" - the reader is on the unplaced live tail.
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
  // The range is recorded even when nothing is warmed by it.
  const sameRange =
    window.visibleOrdinals !== null &&
    window.visibleOrdinals.fromOrdinal === range.fromOrdinal &&
    window.visibleOrdinals.toOrdinal === range.toOrdinal;
  if (!touchedSpans && !touchedStale) {
    return sameRange ? window : { ...window, visibleOrdinals: range };
  }
  const clock = window.clock + 1;
  // The bump lands on the records backing the rows each span is drawing IN the range - per row, not
  // per span.
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
      // The fresh tier draws its rows at its own ordinals, so "in range" is plain arithmetic here; the
      // stale tier's per-row rule is the seat truth ({@link staleRowDrawnIn}).
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

/** Is this carried span drawing any of the rows currently on screen? */
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

/** The per-ROW half of {@link staleSpanVisibleIn}: is this carry drawing THIS row inside `range`? */
function staleRowDrawnIn(
  window: TranscriptWindow,
  carries: readonly HydratedSpan[],
  range: OrdinalRange,
): (span: HydratedSpan) => (rowId: string, offset: number) => boolean {
  // Over the CANDIDATE set rather than `window.staleSpans`, because `boundedStaleSpans` asks this
  // about spans it has not seated yet - and ownership is only meaningful within the set being
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

/** The sub-ranges of `range` that are NOT hydrated, in ordinal order. */
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
 * How many rows no client-side scan can see. Find projects the records the window has HYDRATED, so
 * on the windowed line every count it reports is a count over a subset.
 */
export function unhydratedRowCount(window: TranscriptWindow): number {
  return allTranscriptHydrationGaps(window, {
    fromOrdinal: 0,
    toOrdinal: window.rowCount,
  }).reduce((total, gap) => total + (gap.toOrdinal - gap.fromOrdinal), 0);
}

/**
 * What to fetch next, or `null` when the window is already sufficient. Three obligations, in
 * priority order:
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

/** The lowest required ordinal this window does not hold, as a ONE-ROW range. */
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
 * Evict the coldest spans until the window fits its byte budget. The tail is never evicted,
 * however cold it looks.
 */
export function evictTranscriptWindowToBudget(
  input: TranscriptWindow,
  maxBytes: number,
  visible: OrdinalRange | null,
  required: readonly number[],
): TranscriptWindow {
  // The one place the byte figure is READ, and therefore the one place it has to be true.
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
  const warmth = new Map(
    window.spans.map((span) => [span, spanTouchStamp(window, span)]),
  );
  const candidates = window.spans
    .filter((span) => !isProtected(span))
    .sort((left, right) => (warmth.get(left) ?? 0) - (warmth.get(right) ?? 0));
  // Reference counts over the SURVIVING fresh tier, maintained as spans drop: savings are
  // set-valued, not additive - a record two candidates share is freed by neither alone - so each
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
  // A zero-marginal candidate's records are all shared, so the correct unit is its ALIAS CLOSURE:
  // the transitive connected component of the fresh span<->record sharing graph - a chain across two
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
      // Genuinely unevictable: what it retains is bounded, not an open leak - the protected anchor's
      // charge is capped by the merge ceiling (tail) or finite (viewport), and the chain part by sharing
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
    hydratedBytes: chargedWindowBytes(
      window.records,
      spans,
      window.liveMessages,
      window.liveEvents,
    ),
    evictionTerminal,
  });
}

/**
 * Reference counts of every record over the fresh tier - the starting state {@link
 * evictTranscriptWindowToBudget} decrements as spans drop, which is what makes each candidate's
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
 * Evict every member of an alias closure and return the union saving: each member's structural
 * bytes plus each of the closure's records charged ONCE - all of their fresh references live
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

/** What a post-eviction window still holds that CANNOT be dropped, by kind. */
export function transcriptWindowProtectedBytes(
  window: TranscriptWindow,
  visible: OrdinalRange | null,
  required: readonly number[],
): readonly ProtectedBytes[] {
  const byKind = new Map<ProtectedRegionKind, HydratedSpan[]>();
  const classify = (span: HydratedSpan): ProtectedRegionKind | null => {
    if (spanEnd(span) >= window.rowCount && window.rowCount > 0) return "tail";
    if (
      required.some(
        (ordinal) => span.fromOrdinal <= ordinal && spanEnd(span) > ordinal,
      )
    ) {
      return "required";
    }
    if (
      visible !== null &&
      span.fromOrdinal < visible.toOrdinal &&
      spanEnd(span) > visible.fromOrdinal
    ) {
      return "visible";
    }
    return null;
  };
  for (const span of window.spans) {
    const kind = classify(span);
    if (kind === null) continue;
    const group = byKind.get(kind);
    if (group === undefined) byKind.set(kind, [span]);
    else group.push(span);
  }
  const reported: ProtectedBytes[] = [];
  for (const [kind, spans] of byKind) {
    const bytes = freshTierBytes(window.records, spans);
    if (bytes > 0) reported.push({ kind, bytes });
  }
  const liveBytes = recordsByteLength(window.liveMessages, window.liveEvents);
  if (liveBytes > 0) {
    const tail = reported.find((entry) => entry.kind === "tail");
    if (tail === undefined) reported.push({ kind: "tail", bytes: liveBytes });
    else {
      reported[reported.indexOf(tail)] = {
        kind: "tail",
        bytes: tail.bytes + liveBytes,
      };
    }
  }
  return reported;
}

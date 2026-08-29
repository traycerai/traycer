import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  hydratedRecords,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";
import {
  assistantRowId,
  chatTranscriptEventRowId,
  forkedChatLinkRowId,
  projectTranscriptRows,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import { assistantTurnKey } from "@traycer/protocol/persistence/chat-transcript/fork-boundary";
import { isTransientLiveAssistantMessageId } from "@/lib/chat/transient-live-assistant-message-id";

/**
 * # The list the transcript draws: hydrated rows and placeholders together
 *
 * On the windowed line the renderer holds bodies for only part of the
 * transcript, but the list has to be `rowCount` long anyway - otherwise
 * scrolling up reaches the top of what happens to be loaded rather than the top
 * of the chat, and the viewport can never ask for anything it does not already
 * have. This module is the merge that makes the list full length.
 *
 * ## A placeholder is its own row type, never a partial `ChatMessage`
 *
 * Overview decision D2, and it is load-bearing rather than tidy. A partial
 * `ChatMessage` would have to lie about `content`, `segments` and `createdAt`,
 * and every consumer that reads those would silently get the lie. Worse, the
 * renderer's row comparators are keyed on `ChatMessage` fields: a row that went
 * from "empty content" to "real content" without changing any compared field
 * would keep its stale rendering, which is the `CHAT_MESSAGE_FIELD_UNCHANGED`
 * freeze-stale-row class this feature has already been bitten by. A distinct
 * `kind` sidesteps the whole class - a hydration transition changes the row's
 * `kind`, which nothing can compare its way past.
 *
 * ## Placement comes from the SPANS, not from the skeleton
 *
 * The obvious implementation reads `skeleton[ordinal].rowId` to decide which
 * rendered row belongs where. That breaks while chunks are still streaming: the
 * skeleton is deliberately SPARSE, so a hydrated row whose ordinal is still a
 * hole would fail to place, fall through to the live tail, and appear twice -
 * once as content at the bottom and once as a placeholder in its real position.
 *
 * `HydratedSpan.rowIds` carries "one row id per row served, in order", so the
 * spans already know the ordinal of every row the client holds a body for, and
 * they know it independently of how much skeleton has arrived. The skeleton is
 * consulted only for rows that are NOT hydrated, which is exactly what it is
 * for.
 *
 * One exception, and it is narrow by construction: a LIVE RECORD - a record the
 * host pushed whole, which `pruneSupersededLiveRecords` keeps precisely until a
 * span carries it - is seated at the ordinal the skeleton names for it. Between
 * the `indexChanged` that first names such a record and the range that serves
 * its body there is otherwise a gap in which it is neither placed nor unplaced,
 * and it disappears behind a placeholder for the length of that round trip.
 * This does not reopen the sparse-skeleton hazard above: a row with no skeleton
 * entry simply has no ordinal to be seated at and still falls through to the
 * live tail. Projected assistant rows are eligible only when their
 * `persistentMessageId` names a live record; that includes split slices from
 * the same delivered assistant record without treating projection alone as
 * proof that a body is held.
 *
 * ## What lands after the last ordinal
 *
 * Pending sends, the live assistant row, and records the index has not placed
 * yet (`TranscriptWindow.liveMessages`) all render without owning an ordinal.
 * They go after every ordinal, which is also where they belong
 * chronologically - an unplaced record is the newest thing the client has.
 *
 * "Unplaced" is decided by the SKELETON, not by absence from the spans. A
 * partially-hydrated steer-split turn renders rows the range never served
 * (its records back the whole turn), and those rows do own ordinals - they are
 * simply not hydrated. Appending them here would draw them twice, out of
 * order, alongside the placeholders still holding their real positions. Those
 * rows stay PLACEHOLDERS rather than being seated at their ordinals: the
 * renderer inferred them from a sibling row's records, so their bodies are this
 * client's guesses at ordinals the host declined to serve.
 *
 * ## A hydrated row the renderer withheld is OMITTED, not placeholder'd
 *
 * `rendered` is post-filter: the pinned-todo pass drops an assistant row whose
 * only segments were lifted into the todo dock (`buildPinnedTodoRenderState`
 * returns `null` for it). For such a row the span proves the client HOLDS the
 * body - the model is missing because a renderer policy removed it, which is
 * the same removal the legacy line expresses by the row simply not being in
 * the list. Emitting a placeholder instead would draw a permanent skeleton
 * shimmer at an ordinal the reader is meant to see nothing at.
 */

export type TranscriptListRow =
  | {
      readonly kind: "hydrated";
      /** Stable React/LegendList key. The row id for a placed row. */
      readonly key: string;
      /**
       * Its place in the transcript, or `null` for a row that owns no ordinal -
       * a pending send, the live turn, or a record the index has not placed.
       * Also `null` on the legacy line, which has no ordinal space at all.
       */
      readonly ordinal: number | null;
      readonly model: ChatMessageModel;
    }
  | {
      readonly kind: "placeholder";
      readonly key: string;
      readonly ordinal: number;
      /**
       * The skeleton's description of the row, or `null` when that ordinal is
       * still a hole. `null` means "a row exists here and nothing about it has
       * arrived yet" - never "no such row", which `rowCount` alone decides.
       */
      readonly entry: RowSkeletonEntry | null;
    };

const UNPLACED_ROW_KEY_PREFIX = "unplaced-row:";

/** The key a placeholder takes before any skeleton entry describes it. */
export function unplacedRowKey(ordinal: number): string {
  return `${UNPLACED_ROW_KEY_PREFIX}${ordinal}`;
}

/**
 * Is this key a synthesized position rather than a row IDENTITY?
 *
 * The distinction matters to anything that PERSISTS a key. A real row key is
 * the row's id and names the same row forever; this one is an ordinal under an
 * epoch it does not carry, so after a reindex `unplaced-row:400` names whatever
 * row now sits at 400. A restore that treats it as an exact match therefore
 * lands on unrelated content and, because it believes it matched, never runs
 * the pending-hydration correction that would have noticed.
 */
export function isUnplacedRowKey(key: string): boolean {
  return key.startsWith(UNPLACED_ROW_KEY_PREFIX);
}

/**
 * Every row id the index names and the ordinal it names it at, keyed by the
 * skeleton array that produced it.
 *
 * Module-scope and keyed on array IDENTITY for the same reason
 * `chat-timeline.tsx`'s row caches are: `transcriptListRows` re-runs on every
 * streaming token (`messages` is rebuilt wholesale per token), while the
 * skeleton array is replaced only when a chunk lands or the index changes.
 * Building this inline would put an O(rowCount) Map on the per-token path -
 * 20k entries per token on a long chat - which is precisely the per-token
 * O(history) work the windowed line exists to delete.
 *
 * The ORDINAL and not merely membership, because both questions this answers
 * need it: "does the index name this row?" (so it is not an unplaced record)
 * and "where?" (so a live record the index has just started naming can be
 * seated there instead of dropped). One pass, one cache entry.
 *
 * Safe to publish from a render: the value is a pure function of the array it
 * is keyed on, so a discarded render can only ever populate the same answer.
 */
const skeletonOrdinalCache = new WeakMap<
  readonly (RowSkeletonEntry | undefined)[],
  ReadonlyMap<string, number>
>();

function skeletonOrdinalByRowId(
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
 * Every row identity backed by a hydrated span, keyed by the spans array.
 *
 * An invalidated transcript still re-renders on every streaming token while
 * its retained spans change only when hydration/index state changes. Keep the
 * O(window) membership fold off that token path, just like the skeleton map.
 */
const spanRowIdCache = new WeakMap<
  TranscriptWindow["spans"],
  ReadonlySet<string>
>();

function spanRowIds(spans: TranscriptWindow["spans"]): ReadonlySet<string> {
  const cached = spanRowIdCache.get(spans);
  if (cached !== undefined) return cached;
  const rowIds = new Set<string>();
  for (const span of spans) {
    for (const rowId of span.rowIds) rowIds.add(rowId);
  }
  spanRowIdCache.set(spans, rowIds);
  return rowIds;
}

/**
 * The row ids of the records this client holds LIVE - pushed whole by the host
 * and not yet superseded by a span.
 *
 * Rebuilt per call rather than cached, because it is proportional to the live
 * records and not to the transcript: `liveMessages` holds the handful of
 * records the index has not placed yet and `liveEvents` is capped outright, so
 * this is bounded work on the per-token path in a way a `rowCount` scan is not.
 *
 * Both event row-id shapes, because both are rows a live event can materialize
 * (`row-projection.ts` builds a forked-chat link and a notification anchor from
 * the event log, and the renderer mints the same two ids from the same
 * helpers). Reading only one would silently leave that kind of row behind a
 * placeholder.
 */
function liveRecordRowIds(window: TranscriptWindow): ReadonlySet<string> {
  const rowIds = new Set<string>();
  for (const message of window.liveMessages) rowIds.add(message.messageId);
  for (const event of window.liveEvents) {
    rowIds.add(chatTranscriptEventRowId(event.eventId));
    rowIds.add(forkedChatLinkRowId(event.eventId));
    if (event.type === "turn.stopped" && event.turnId !== null) {
      rowIds.add(assistantRowId(event.turnId));
    }
  }
  return rowIds;
}

function transientLiveSteerRowIds(
  window: TranscriptWindow,
): ReadonlySet<string> {
  const transientTurnKeys = new Set<string>();
  for (const message of window.liveMessages) {
    if (
      message.role === "assistant" &&
      isTransientLiveAssistantMessageId(message.messageId)
    ) {
      transientTurnKeys.add(assistantTurnKey(message));
    }
  }
  const records = hydratedRecords(window);
  return new Set(
    projectTranscriptRows({
      messages: records.messages,
      events: records.events,
      activeTurnId: null,
      chatId: "",
    })
      .filter(
        (row) =>
          row.source.kind === "steer" &&
          transientTurnKeys.has(row.source.turnKey),
      )
      .map((row) => row.rowId),
  );
}

function projectedLiveSetupRowIds(
  window: TranscriptWindow,
  rendered: readonly ChatMessageModel[],
): ReadonlySet<string> {
  if (!window.liveEvents.some((event) => event.type.startsWith("setup."))) {
    return new Set();
  }
  const liveCountByCreatedAt = new Map<string, number>();
  for (const createdAt of projectTranscriptRows({
    messages: window.liveMessages,
    events: window.liveEvents,
    activeTurnId: null,
    chatId: "",
  })
    .filter((row) => row.source.kind === "setup-card")
    .map((row) => row.rowId.slice(row.rowId.lastIndexOf(":") + 1))) {
    liveCountByCreatedAt.set(
      createdAt,
      (liveCountByCreatedAt.get(createdAt) ?? 0) + 1,
    );
  }
  const renderedByCreatedAt = new Map<
    string,
    { id: string; index: number }[]
  >();
  for (const model of rendered) {
    const match = model.id.match(/^setup-card:.*:(\d+):(\d+)$/);
    if (match === null || !liveCountByCreatedAt.has(match[2])) continue;
    const candidates = renderedByCreatedAt.get(match[2]) ?? [];
    candidates.push({ id: model.id, index: Number(match[1]) });
    renderedByCreatedAt.set(match[2], candidates);
  }
  const liveRowIds = new Set<string>();
  for (const [createdAt, count] of liveCountByCreatedAt) {
    const candidates = renderedByCreatedAt.get(createdAt) ?? [];
    candidates.sort((left, right) => right.index - left.index);
    for (const candidate of candidates.slice(0, count)) {
      liveRowIds.add(candidate.id);
    }
  }
  return liveRowIds;
}

function isExplicitlyPendingOrStreaming(model: ChatMessageModel): boolean {
  return model.statusLabel === "Pending" || model.statusLabel === "Streaming";
}

/**
 * Placeholder rows already built, keyed by the skeleton they were built from.
 *
 * This function reruns on every block delta - `transcriptWindow` is replaced
 * per token while a turn streams - and the `rowCount` loop below allocates a
 * row object for each of the (often thousands of) unhydrated ordinals every
 * time. That is work proportional to the WHOLE chat on the hottest path in the
 * app, in the structure introduced to make long chats cheap.
 *
 * A placeholder is a pure function of `(skeleton array, ordinal)`, and the
 * skeleton is safe to key on: `applySkeletonChunk` and `applyIndexChange` are
 * the only writers and both copy (`const skeleton = [...window.skeleton]`)
 * before mutating, so a given array identity never changes contents. Every
 * other window update spreads `{...window, spans}` and carries the same array
 * through - which is exactly the streaming case this exists for.
 *
 * A `WeakMap` so the cache dies with the skeleton it describes: it is scoped
 * per window rather than per chat, needs no invalidation, and cannot leak
 * across sessions.
 *
 * Reuse also makes the row objects referentially STABLE across deltas, which
 * matters beyond allocation: the stable-row pass and the minimap projection
 * both scan this array, and an unchanged placeholder now compares equal by
 * identity instead of by field.
 */
const placeholderRowsBySkeleton = new WeakMap<
  object,
  Map<number, TranscriptListRow>
>();

const MAX_INVALIDATED_PLACEHOLDER_SETS = 16;
const invalidatedPlaceholdersByRowCount = new Map<
  number,
  readonly TranscriptListRow[]
>();

function invalidatedPlaceholderRows(
  rowCount: number,
): readonly TranscriptListRow[] {
  const cached = invalidatedPlaceholdersByRowCount.get(rowCount);
  if (cached !== undefined) return cached;
  const rows = Array.from({ length: rowCount }, (_unused, ordinal) => ({
    kind: "placeholder" as const,
    key: unplacedRowKey(ordinal),
    ordinal,
    entry: null,
  }));
  invalidatedPlaceholdersByRowCount.set(rowCount, rows);
  if (
    invalidatedPlaceholdersByRowCount.size > MAX_INVALIDATED_PLACEHOLDER_SETS
  ) {
    const oldest = invalidatedPlaceholdersByRowCount.keys().next();
    if (!oldest.done) invalidatedPlaceholdersByRowCount.delete(oldest.value);
  }
  return rows;
}

/**
 * Seat the live records the index has started naming, in place.
 *
 * Extracted rather than inlined only because the merge below is already at the
 * lint's complexity ceiling; the reasoning for it lives at the call site.
 *
 * Writes into `modelByOrdinal` and `placedRowIds` - the same two structures the
 * span pass fills - so everything downstream reads one answer per ordinal
 * regardless of which pass produced it.
 */
function seatLiveRecords(input: {
  readonly window: TranscriptWindow;
  readonly rendered: readonly ChatMessageModel[];
  readonly skeletonOrdinals: ReadonlyMap<string, number>;
  readonly modelByOrdinal: Map<number, ChatMessageModel>;
  readonly placedRowIds: Set<string>;
  readonly suppressedOrdinals: ReadonlySet<number>;
}): void {
  const liveRowIds = liveRecordRowIds(input.window);
  if (liveRowIds.size === 0) return;
  for (const model of input.rendered) {
    const backedByLiveRecord =
      liveRowIds.has(model.id) ||
      (model.persistentMessageId !== null &&
        liveRowIds.has(model.persistentMessageId));
    if (!backedByLiveRecord) continue;
    if (input.placedRowIds.has(model.id)) continue;
    const ordinal = input.skeletonOrdinals.get(model.id);
    if (ordinal === undefined || ordinal >= input.window.rowCount) continue;
    if (
      input.modelByOrdinal.has(ordinal) ||
      input.suppressedOrdinals.has(ordinal)
    ) {
      continue;
    }
    input.modelByOrdinal.set(ordinal, model);
    input.placedRowIds.add(model.id);
  }
}

/**
 * Merge what the renderer produced with what the window says exists.
 *
 * @param window The transcript window, or `null` on the legacy line - where
 * every row is hydrated by construction and this is the identity mapping.
 * @param rendered `useRenderedMessages` output: hydrated bodies plus the live
 * and pending rows, in display order.
 */
export function transcriptListRows(input: {
  readonly window: TranscriptWindow | null;
  readonly rendered: readonly ChatMessageModel[];
}): readonly TranscriptListRow[] {
  const { window, rendered } = input;
  // The legacy line has no ordinal space at all.
  if (window === null) {
    return rendered.map((model) => ({
      kind: "hydrated",
      key: model.id,
      ordinal: null,
      model,
    }));
  }

  if (window.invalidated) {
    // The index identities are void, but the frame that voided them still
    // authoritatively announced how many rows exist in the replacement space.
    // Keep the virtualized list mounted with identity-free placeholders so a
    // known nonempty chat can never flash the brand-new-chat empty state or
    // lose LegendList's measurements/scroll position during the resnapshot.
    // Only genuinely unplaced rendered records remain after the ordinal
    // space. Bodies already backed by a retained span are represented by the
    // identity-free placeholders until the replacement index lands; appending
    // them too would draw the same history twice on skeleton-loss paths.
    const liveRowIds = liveRecordRowIds(window);
    const retainedSpanRowIds = spanRowIds(window.spans);
    const liveSetupRowIds = projectedLiveSetupRowIds(window, rendered);
    let liveTransientSteerRowIds: ReadonlySet<string> | null = null;
    const unplacedRendered = rendered.filter((model) => {
      const liveBacked =
        isExplicitlyPendingOrStreaming(model) ||
        liveRowIds.has(model.id) ||
        liveSetupRowIds.has(model.id) ||
        (model.persistentMessageId === null &&
          (liveTransientSteerRowIds ??= transientLiveSteerRowIds(window)).has(
            model.id,
          )) ||
        (model.persistentMessageId !== null &&
          liveRowIds.has(model.persistentMessageId));
      return !retainedSpanRowIds.has(model.id) && liveBacked;
    });
    return [
      ...invalidatedPlaceholderRows(window.rowCount),
      ...unplacedRendered.map((model) => ({
        kind: "hydrated" as const,
        key: model.id,
        ordinal: null,
        model,
      })),
    ];
  }

  const modelsById = new Map(rendered.map((model) => [model.id, model]));
  const modelByOrdinal = new Map<number, ChatMessageModel>();
  const suppressedOrdinals = new Set<number>();
  const placedRowIds = new Set<string>();
  for (const span of window.spans) {
    span.rowIds.forEach((rowId, offset) => {
      const ordinal = span.fromOrdinal + offset;
      // A span reaching past `rowCount` would be a host/client disagreement
      // about length. Dropping the row here rather than emitting it beyond the
      // list keeps the list exactly `rowCount` long; the identity echo is what
      // reports the disagreement.
      if (ordinal >= window.rowCount) return;
      const model = modelsById.get(rowId);
      if (model === undefined) {
        // The span proves the body is HELD; its absence from `rendered` means
        // a renderer policy withheld the row (see the module doc). Emit
        // nothing at this ordinal.
        suppressedOrdinals.add(ordinal);
        return;
      }
      modelByOrdinal.set(ordinal, model);
      placedRowIds.add(rowId);
    });
  }

  const skeletonOrdinals = skeletonOrdinalByRowId(window.skeleton);

  // A live record the index has just started naming, seated at the ordinal it
  // names rather than dropped.
  //
  // `placedRowIds` comes only from the SPANS, so between the `indexChanged`
  // that first names a live record's row id and the range response that
  // delivers its authoritative body there is a gap where the row is neither
  // placed (no span covers it) nor unplaced (the skeleton names it) - and the
  // trailing loop below, which drops every skeleton-named model, would drop the
  // one copy of the body this client has. What the user sees is a message they
  // just sent turning into a skeleton placeholder until the range lands.
  //
  // Restricted to models a LIVE RECORD backs, directly by row id or through
  // the projected model's persistent record id. A rendered model alone is not
  // evidence that the client holds the row:
  // hydrating one row of a steer-split assistant turn pulls the turn's shared
  // records, and rendering those projects EVERY row of that turn - including
  // ones the host never served, whose bodies here would be this client's
  // guesses at an ordinal it was refused. A live record is the opposite: the
  // host sent it, whole, and `pruneSupersededLiveRecords` keeps it exactly
  // until a span carries the same record. So this seats what was delivered and
  // leaves what was inferred as a placeholder.
  //
  // Written into `modelByOrdinal` rather than checked inside the `rowCount`
  // loop: that loop already runs per token over the whole chat, and this keeps
  // the addition proportional to the live records instead.
  //
  // A span always wins - it IS the authoritative copy - so an ordinal a span
  // already answered for is left alone, whether it placed a model or the
  // renderer withheld one.
  seatLiveRecords({
    window,
    rendered,
    skeletonOrdinals,
    modelByOrdinal,
    placedRowIds,
    suppressedOrdinals,
  });

  let placeholders = placeholderRowsBySkeleton.get(window.skeleton);
  if (placeholders === undefined) {
    placeholders = new Map<number, TranscriptListRow>();
    placeholderRowsBySkeleton.set(window.skeleton, placeholders);
  }

  const rows: TranscriptListRow[] = [];
  for (let ordinal = 0; ordinal < window.rowCount; ordinal += 1) {
    const model = modelByOrdinal.get(ordinal);
    if (model !== undefined) {
      rows.push({ kind: "hydrated", key: model.id, ordinal, model });
      continue;
    }
    if (suppressedOrdinals.has(ordinal)) continue;
    // Reused across deltas: see `placeholderRowsBySkeleton`. Nothing here reads
    // the spans or the rendered models, so a body arriving elsewhere in the
    // chat cannot change this row.
    const cached = placeholders.get(ordinal);
    if (cached !== undefined) {
      rows.push(cached);
      continue;
    }
    const entry = window.skeleton[ordinal] ?? null;
    const row: TranscriptListRow = {
      kind: "placeholder",
      key: entry === null ? unplacedRowKey(ordinal) : entry.rowId,
      ordinal,
      entry,
    };
    placeholders.set(ordinal, row);
    rows.push(row);
  }
  for (const model of rendered) {
    if (placedRowIds.has(model.id)) continue;
    // A row the SKELETON names owns an ordinal, so it is not an unplaced
    // record however it came to be rendered - see the note above the loop.
    // Two ways to reach here still naming one: the model is a PROJECTION the
    // renderer inferred from a sibling row's records rather than a record this
    // client holds (the steer-split turn), or a span already answered for its
    // ordinal. Either way the ordinal is accounted for, and appending a second,
    // ordinal-less copy would draw the row twice.
    if (skeletonOrdinals.has(model.id)) continue;
    rows.push({ kind: "hydrated", key: model.id, ordinal: null, model });
  }
  return rows;
}

/**
 * The ordinal span a rendered index range covers, for viewport hydration.
 *
 * Rows without an ordinal (the live tail) contribute nothing: asking to hydrate
 * them is meaningless, and letting them widen the range would request ordinals
 * the viewport is not actually showing. `null` when the visible slice holds no
 * placed row at all, which is what a chat scrolled to its pending tail looks
 * like.
 */
export function visibleOrdinalRange(
  rows: readonly TranscriptListRow[],
  fromIndex: number,
  toIndex: number,
): { readonly fromOrdinal: number; readonly toOrdinal: number } | null {
  let lowest: number | null = null;
  let highest: number | null = null;
  const start = Math.max(0, fromIndex);
  const end = Math.min(rows.length, toIndex);
  for (let index = start; index < end; index += 1) {
    // `number` on a placeholder, `number | null` on a hydrated row - the union
    // narrows to `number | null`, which is exactly the check below.
    const ordinal = rows[index].ordinal;
    if (ordinal === null) continue;
    if (lowest === null || ordinal < lowest) lowest = ordinal;
    if (highest === null || ordinal > highest) highest = ordinal;
  }
  if (lowest === null || highest === null) return null;
  return { fromOrdinal: lowest, toOrdinal: highest + 1 };
}

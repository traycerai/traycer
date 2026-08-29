import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  hydratedRecords,
  skeletonOrdinalByRowId,
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

/** Its own cache: a DIFFERENT set under the same key. */
const spanBackedRowIdCache = new WeakMap<
  TranscriptWindow["spans"],
  ReadonlySet<string>
>();

/**
 * Every id a tier's contents can be rendered FROM - the mirror of
 * {@link liveRecordRowIds} over a hydrated tier.
 *
 * Deliberately not {@link spanRowIds}, and the distinction is the point. Those
 * are the rows a span DRAWS. These are the identities its contents can back,
 * which is a larger set: one assistant record projects into every slice of its
 * turn while a partial range serves only some of them, and one event
 * materializes rows under two id shapes.
 *
 * Ask this only where the question is "what backs this model". Asking it where
 * the question is "is this row already drawn" over-suppresses - a record can
 * ride in `span.messages` to render a DIFFERENT row of the same turn without
 * the span drawing a row for it at all.
 *
 * Keep in step with {@link liveRecordRowIds}: the two answer one question
 * about two tiers, so a channel added to either belongs in both.
 */
function spanBackedRowIds(
  spans: TranscriptWindow["spans"],
): ReadonlySet<string> {
  const cached = spanBackedRowIdCache.get(spans);
  if (cached !== undefined) return cached;
  const rowIds = new Set<string>();
  for (const span of spans) {
    for (const rowId of span.rowIds) rowIds.add(rowId);
    for (const message of span.messages) rowIds.add(message.messageId);
    for (const event of span.events) {
      rowIds.add(chatTranscriptEventRowId(event.eventId));
      rowIds.add(forkedChatLinkRowId(event.eventId));
      if (event.type === "turn.stopped" && event.turnId !== null) {
        rowIds.add(assistantRowId(event.turnId));
      }
    }
  }
  spanBackedRowIdCache.set(spans, rowIds);
  return rowIds;
}

/**
 * "Does this tier back the model?" - the same hop {@link liveBackingLookup}
 * makes, for the same reason: a model carrying a `persistentMessageId` was
 * PROJECTED from a record, so that id is where its backing lives.
 */
function backedBySpanTier(
  rowIds: ReadonlySet<string>,
  model: ChatMessageModel,
): boolean {
  if (rowIds.has(model.id)) return true;
  return (
    model.persistentMessageId !== null && rowIds.has(model.persistentMessageId)
  );
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
 * "Is this rendered model backed by something the client holds LIVE?"
 *
 * One predicate, because two callers ask it about the same models for the same
 * reason and a second copy drifts: the invalidated merge asks it to decide
 * which unplaced records still belong at the tail, and
 * {@link appendUnplacedRenderedRows} asks it to decide whether a model the
 * STALE tier also backs is nonetheless the newest thing the client holds. A
 * narrower answer in either place hides an active row behind a placeholder
 * until replacement hydration arrives, which is the failure the stale tier
 * exists to prevent.
 *
 * The four backings are four different ways a live record reaches the
 * renderer: as a row id, as a persistent id the row was projected under, as a
 * setup card the event log materialized, and as a steer split inferred from a
 * transient assistant's blocks. The status label is a fifth and cheapest
 * answer - a model the renderer is itself calling Pending or Streaming is live
 * whatever the record plumbing says.
 *
 * Returned as a closure over lazily-built sets rather than computed per model:
 * `transientLiveSteerRowIds` projects the whole hydrated record set and
 * `projectedLiveSetupRowIds` projects the live one, and this runs on the
 * per-token path where most calls never get past the first two membership
 * tests.
 */
function liveBackingLookup(
  window: TranscriptWindow,
  rendered: readonly ChatMessageModel[],
): (model: ChatMessageModel) => boolean {
  let liveRowIds: ReadonlySet<string> | null = null;
  let setupRowIds: ReadonlySet<string> | null = null;
  let steerRowIds: ReadonlySet<string> | null = null;
  return (model) => {
    if (isExplicitlyPendingOrStreaming(model)) return true;
    liveRowIds ??= liveRecordRowIds(window);
    if (liveRowIds.has(model.id)) return true;
    setupRowIds ??= projectedLiveSetupRowIds(window, rendered);
    if (setupRowIds.has(model.id)) return true;
    // A model carrying a persistent id was projected FROM a record, so that id
    // is where its liveness lives; one without a persistent id can only be an
    // inference the renderer drew from a sibling's blocks, which is what the
    // steer projection answers for. Neither test says anything about the other
    // kind of model, so they are exclusive rather than a second disjunct.
    if (model.persistentMessageId !== null) {
      return liveRowIds.has(model.persistentMessageId);
    }
    steerRowIds ??= transientLiveSteerRowIds(window);
    return steerRowIds.has(model.id);
  };
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
 * Seat the carried stale bodies - the spans a rebase or void discarded, kept
 * for display while their replacement streams in.
 *
 * Placement is by REPLACEMENT-SKELETON name first: a stale row the new index
 * names renders at the ordinal it names, under the same key it had before the
 * rebase, which is what keeps LegendList's measurements and the reader's
 * position across a completion handoff. A row the skeleton has not named yet
 * falls back to its OLD ordinal, and only into an entry-less hole - the
 * moment an entry arrives for that ordinal, the guess yields to the
 * authority, so a mispositioned body can survive at most one skeleton chunk.
 *
 * Runs after the span and live passes and never displaces either: a fresh
 * body always outranks a carried one.
 *
 * A carry that holds the body while the renderer withholds the MODEL suppresses
 * its ordinal, as the fresh-span pass does - but only for a row the
 * replacement index still NAMES. Withholding is a renderer policy about the row
 * (an assistant row whose only segments were lifted into the pinned-todo dock
 * is the standing example), not a statement about which tier holds it, so the
 * row is meant to draw nothing and the skeleton placeholder would make a rebase
 * materialize a row that was deliberately absent before it and after it. The
 * restriction is what keeps that apart from a row the rebase merely RENAMED;
 * see the branch itself.
 */
function seatStaleRows(input: {
  readonly window: TranscriptWindow;
  readonly modelsById: ReadonlyMap<string, ChatMessageModel>;
  readonly skeletonOrdinals: ReadonlyMap<string, number>;
  readonly modelByOrdinal: Map<number, ChatMessageModel>;
  readonly placedRowIds: Set<string>;
  readonly suppressedOrdinals: Set<number>;
}): void {
  const { window } = input;
  for (const span of window.staleSpans) {
    span.rowIds.forEach((rowId, offset) => {
      // The empty string is a positionally-seated legacy tail's "identity
      // unverified" marker, not a row id - nothing can match it.
      if (rowId === "") return;
      if (input.placedRowIds.has(rowId)) return;
      let ordinal = input.skeletonOrdinals.get(rowId);
      // Whether the REPLACEMENT index still names this id, which is the only
      // evidence here that it is a current row id and not a pre-rebase one.
      // Read below, where a missing model has to be told apart from a
      // renamed row.
      const namedByIndex = ordinal !== undefined;
      if (ordinal === undefined) {
        const oldOrdinal = span.fromOrdinal + offset;
        if (window.skeleton[oldOrdinal] !== undefined) return;
        ordinal = oldOrdinal;
      }
      if (ordinal >= window.rowCount) return;
      if (
        input.modelByOrdinal.has(ordinal) ||
        input.suppressedOrdinals.has(ordinal)
      ) {
        return;
      }
      const model = input.modelsById.get(rowId);
      if (model === undefined) {
        // The fresh-span pass reads a missing model as the renderer WITHHOLDING
        // the row and emits nothing, and it is entitled to: its row ids are the
        // current ones by construction, so the renderer projects under exactly
        // those ids. A stale span's are not, and the difference is the whole
        // reason this pass exists - a rebase re-slices a turn (the `split`
        // suffix is sticky for every row of it), so the same record now
        // projects under ids this span never listed. Reading THAT as
        // withholding blanks the turn's whole ordinal range for the length of
        // the carry, which is worse than the placeholder it removes.
        //
        // So only where the replacement index still names the id, which is the
        // one piece of evidence available here that it is current. Absent that,
        // fall through to the placeholder - transiently, until the skeleton
        // reaches the row. `withholds a sibling slice of a stale-held record
        // from the live tail` is the case this narrowing protects.
        if (namedByIndex) input.suppressedOrdinals.add(ordinal);
        return;
      }
      input.modelByOrdinal.set(ordinal, model);
      input.placedRowIds.add(rowId);
    });
  }
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
 * The invalidated-window merge, extracted for the complexity ceiling.
 *
 * The index identities are void, but the frame that voided them still
 * authoritatively announced how many rows exist in the replacement space.
 * Keep the virtualized list mounted with identity-free placeholders so a
 * known nonempty chat can never flash the brand-new-chat empty state or lose
 * LegendList's measurements/scroll position during the resnapshot. Only
 * genuinely unplaced rendered records remain after the ordinal space. Bodies
 * already backed by a retained span are represented by the identity-free
 * placeholders until the replacement index lands; appending them too would
 * draw the same history twice on skeleton-loss paths.
 *
 * The carried STALE bodies do better than a placeholder: they render at
 * their old ordinals, under their real row-id keys, so the void is invisible
 * wherever the client still holds what was on screen.
 */
function invalidatedTranscriptListRows(
  window: TranscriptWindow,
  rendered: readonly ChatMessageModel[],
): readonly TranscriptListRow[] {
  const isLiveBacked = liveBackingLookup(window, rendered);
  // The rows a retained span DRAWS, not what its records could back. A row
  // already drawn as an identity-free placeholder must not also be appended;
  // a record merely riding in `span.messages` to render a sibling row is not
  // drawn at all, and suppressing on it would delete a live steer projection.
  const retainedSpanRowIds = spanRowIds(window.spans);
  const staleByOrdinal = new Map<number, ChatMessageModel>();
  const staleSeatedRowIds = new Set<string>();
  seatStaleRows({
    window,
    modelsById: new Map(rendered.map((model) => [model.id, model])),
    skeletonOrdinals: skeletonOrdinalByRowId(window.skeleton),
    modelByOrdinal: staleByOrdinal,
    placedRowIds: staleSeatedRowIds,
    // Collected and DISCARDED, deliberately. Suppression means "draw nothing
    // at this ordinal", which the ordinal space below cannot honour: its rows
    // are identity-free spacers whose whole job is to keep the list exactly
    // `rowCount` long so LegendList keeps its measurements and the chat cannot
    // flash the empty state. Dropping one would shorten the list to buy the
    // absence of a row the reader cannot tell from its neighbours anyway.
    suppressedOrdinals: new Set<number>(),
  });
  const unplacedRendered = rendered.filter((model) => {
    if (staleSeatedRowIds.has(model.id)) return false;
    return !retainedSpanRowIds.has(model.id) && isLiveBacked(model);
  });
  const placeholders = invalidatedPlaceholderRows(window.rowCount);
  const ordinalRows =
    staleByOrdinal.size === 0
      ? placeholders
      : placeholders.map((row, ordinal) => {
          const model = staleByOrdinal.get(ordinal);
          if (model === undefined) return row;
          return {
            kind: "hydrated" as const,
            key: model.id,
            ordinal,
            model,
          };
        });
  return [
    ...ordinalRows,
    ...unplacedRendered.map((model) => ({
      kind: "hydrated" as const,
      key: model.id,
      ordinal: null,
      model,
    })),
  ];
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
    return invalidatedTranscriptListRows(window, rendered);
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

  // Carried stale bodies fill whatever the fresh spans and live records did
  // not - by replacement-skeleton name, or into an entry-less hole at their
  // old ordinal. After the span and live passes so a fresh body always wins.
  if (window.staleSpans.length > 0) {
    seatStaleRows({
      window,
      modelsById,
      skeletonOrdinals,
      modelByOrdinal,
      placedRowIds,
      suppressedOrdinals,
    });
  }

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
  appendUnplacedRenderedRows({
    window,
    rendered,
    placedRowIds,
    skeletonOrdinals,
    rows,
  });
  return rows;
}

/**
 * Append the rendered models that own no ordinal - the live tail.
 *
 * A row the SKELETON names owns an ordinal, so it is not an unplaced record
 * however it came to be rendered. Two ways to reach the skeleton check while
 * still naming one: the model is a PROJECTION the renderer inferred from a
 * sibling row's records rather than a record this client holds (the
 * steer-split turn), or a span already answered for its ordinal. Either way
 * the ordinal is accounted for, and appending a second, ordinal-less copy
 * would draw the row twice.
 *
 * A model only a STALE span backs is pre-rebase history whose place in the
 * new space is not yet known - appending it to the tail would publish it at a
 * position it never had. It stays behind its placeholder unless it is also
 * LIVE-backed ({@link liveBackingLookup}), in which case it is the newest
 * thing the client holds and belongs at the tail exactly as any live record
 * does. "Also backed by stale" is extremely ordinary for an active row: the
 * turn that is streaming right now is the turn a rebase most recently
 * demoted, so the narrow reading of that test is how an active row disappears.
 */
function appendUnplacedRenderedRows(input: {
  readonly window: TranscriptWindow;
  readonly rendered: readonly ChatMessageModel[];
  readonly placedRowIds: ReadonlySet<string>;
  readonly skeletonOrdinals: ReadonlyMap<string, number>;
  readonly rows: TranscriptListRow[];
}): void {
  const { window } = input;
  let isLiveBacked: ((model: ChatMessageModel) => boolean) | null = null;
  const staleRowIds = spanBackedRowIds(window.staleSpans);
  for (const model of input.rendered) {
    if (input.placedRowIds.has(model.id)) continue;
    if (input.skeletonOrdinals.has(model.id)) continue;
    if (backedBySpanTier(staleRowIds, model)) {
      // The SAME live-backed question the invalidated merge asks, from the
      // same predicate. Asking a narrower one here - row ids only - suppresses
      // a streaming assistant, a projected setup card or a steer split whose
      // pre-rebase copy happens to sit in the stale tier, and the row vanishes
      // from the tail until replacement hydration arrives.
      isLiveBacked ??= liveBackingLookup(window, input.rendered);
      if (!isLiveBacked(model)) continue;
    }
    input.rows.push({ kind: "hydrated", key: model.id, ordinal: null, model });
  }
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

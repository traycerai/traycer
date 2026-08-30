import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  addRecordBackedRowIds,
  hydratedRecords,
  skeletonOrdinalByRowId,
  spanEvents,
  spanMessages,
  staleSpansByFreshestServe,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";
import {
  projectTranscriptRows,
  type TranscriptRowDescriptor,
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

/**
 * Its own cache: a DIFFERENT set under the same key. Composite-keyed on the
 * spans array AND the ledger revision, because the fold below reads record
 * contents through the ledger: two spans of one steered turn hold the same
 * records under different `rowIds`, so a merge changes the answer without
 * changing membership - the spans array moves there - while a re-serve can
 * change what the records back without replacing the array - the revision
 * moves there. Both key parts are stable across in-place token rewrites, so
 * the per-token protection this cache exists for holds. (The one content read
 * the fold makes - `event.turnId` for the `turn.stopped` shape - is safe
 * under the key because events are never rewritten in place.)
 */
const spanBackedRowIdCache = new WeakMap<
  TranscriptWindow["spans"],
  { readonly revision: number; readonly rowIds: ReadonlySet<string> }
>();

/**
 * Every id a tier's contents can be rendered FROM - the mirror of
 * {@link liveRecordRowIds} over a hydrated tier, sharing its fold
 * ({@link addRecordBackedRowIds}, which lives beside the draws relation in
 * `transcript-window.ts` so the two cannot drift).
 *
 * Deliberately not {@link spanRowIds}, and the distinction is the point. Those
 * are the rows a span DRAWS. These are the identities its contents can back,
 * which is a larger set: one assistant record projects into every slice of its
 * turn while a partial range serves only some of them, and one event
 * materializes rows under two id shapes.
 *
 * Ask this only where the question is "what backs this model". Asking it where
 * the question is "is this row already drawn" over-suppresses - a record can
 * ride in a span's record set to render a DIFFERENT row of the same turn
 * without the span drawing a row for it at all.
 */
function spanBackedRowIds(
  window: TranscriptWindow,
  spans: TranscriptWindow["spans"],
): ReadonlySet<string> {
  const cached = spanBackedRowIdCache.get(spans);
  if (cached !== undefined && cached.revision === window.records.revision) {
    return cached.rowIds;
  }
  const rowIds = new Set<string>();
  for (const span of spans) {
    for (const rowId of span.rowIds) rowIds.add(rowId);
    addRecordBackedRowIds(
      rowIds,
      spanMessages(window, span),
      spanEvents(window, span),
    );
  }
  spanBackedRowIdCache.set(spans, {
    revision: window.records.revision,
    rowIds,
  });
  return rowIds;
}

/**
 * Which tier a backing channel may serve. The two tiers ask ONE question -
 * "is this rendered model backed by something you hold?" - and previously
 * answered it through two hand-written lookups held in step by doc
 * convention. The registry below is that convention made structural.
 */
type BackingTier = "live" | "stale";

/**
 * One tier's lazily-built answer sources for the backing channels.
 *
 * Lazy because the folds are O(records) or O(history) while most models
 * answer on the first membership test, and the lookups run on the per-token
 * path. Each source memoizes on first read, per lookup instance.
 */
interface BackingTierSources {
  readonly tier: BackingTier;
  /**
   * True when the tier holds nothing at all - the cheap short-circuit. The
   * live tier never short-circuits: its status-label channel answers about
   * the MODEL, so it must run even when the window holds no live record.
   */
  readonly holdsNothing: () => boolean;
  /** The tier's row ids plus derived backable shapes, one fold. */
  readonly rowIds: () => ReadonlySet<string>;
  /**
   * Setup-card rows the tier's event log materializes. `null` for a tier the
   * setup channel does not serve - the absence is typed rather than an empty
   * answer, so an ineligible tier cannot be handed the channel by accident.
   */
  readonly setupRowIds: (() => ReadonlySet<string>) | null;
  /** Steer rows projected from this tier's turn set. */
  readonly steerRowIds: () => ReadonlySet<string>;
}

/**
 * One way a tier's contents reach the renderer.
 *
 * `servesTiers` is declared PER CHANNEL because eligibility is a property of
 * the channel, not the tier: the status-label shortcut is live-only BY
 * CONSTRUCTION (a model the renderer itself calls Pending or Streaming is
 * live whatever the record plumbing says - and precisely because it says
 * nothing about records, it can never place a row in the stale tier, which
 * drives SUPPRESSION; handing it there is the over-suppression defect this
 * pass has been bitten by twice). A channel added without a tier declaration
 * does not exist, which is the point.
 */
interface BackingChannel {
  readonly servesTiers: readonly BackingTier[];
  readonly isBacked: (
    model: ChatMessageModel,
    sources: BackingTierSources,
  ) => boolean;
}

/**
 * The backing channels, in answer order (cheapest first, and the live
 * lookup's historical order is preserved exactly; the stale lookup's is the
 * same list with the live-only members filtered out).
 *
 * Two KEY KINDS, deliberately distinct channels: `model.id` is a ROW identity
 * - synthetic projections included - while `persistentMessageId` is a
 * PERSISTED-RECORD key. The same fold answers both memberships today, but the
 * questions differ ("which row is this" vs "which record was this projected
 * from"), and collapsing them into one disjunct is how a record key ends up
 * compared against row ids elsewhere.
 *
 * The persistent-record and steer channels are EXCLUSIVE by
 * `persistentMessageId`: a model carrying one was projected FROM a record, so
 * that id is where its backing lives; a model without one can only be an
 * inference the renderer drew from a sibling's blocks - `planAssistantTurnRows`
 * emits a steer entry for any turn holding a steer block, and when the steered
 * user record is absent the row takes a synthesized `steer:<queueItemId>` id
 * that appears in no fold. Neither test says anything about the other kind of
 * model.
 */
const BACKING_CHANNELS: readonly BackingChannel[] = [
  {
    servesTiers: ["live"],
    isBacked: (model) => isExplicitlyPendingOrStreaming(model),
  },
  {
    servesTiers: ["live", "stale"],
    isBacked: (model, sources) => sources.rowIds().has(model.id),
  },
  {
    servesTiers: ["live"],
    isBacked: (model, sources) =>
      sources.setupRowIds !== null && sources.setupRowIds().has(model.id),
  },
  {
    servesTiers: ["live", "stale"],
    isBacked: (model, sources) =>
      model.persistentMessageId !== null &&
      sources.rowIds().has(model.persistentMessageId),
  },
  {
    servesTiers: ["live", "stale"],
    isBacked: (model, sources) =>
      model.persistentMessageId === null && sources.steerRowIds().has(model.id),
  },
];

/** The one lookup implementation both tiers instantiate. */
function backingLookup(
  sources: BackingTierSources,
): (model: ChatMessageModel) => boolean {
  const channels = BACKING_CHANNELS.filter((channel) =>
    channel.servesTiers.includes(sources.tier),
  );
  return (model) => {
    if (sources.holdsNothing()) return false;
    return channels.some((channel) => channel.isBacked(model, sources));
  };
}

/**
 * "Is this rendered model backed by the STALE tier?" - the same channel list
 * as {@link liveBackingLookup} with the live-only members filtered out,
 * because they are one question asked of two tiers.
 *
 * The steer source is scoped to turns the stale tier holds ALONE
 * ({@link staleOnlySteerRowIds}). A turn the live or fresh tier also holds is
 * not pre-rebase history, and suppressing its steer row would hide a current
 * one. The live gate downstream is a second guard, not the first.
 */
function staleBackingLookup(
  window: TranscriptWindow,
): (model: ChatMessageModel) => boolean {
  let rowIds: ReadonlySet<string> | null = null;
  let steerRowIds: ReadonlySet<string> | null = null;
  return backingLookup({
    tier: "stale",
    holdsNothing: () => window.staleSpans.length === 0,
    rowIds: () => (rowIds ??= spanBackedRowIds(window, window.staleSpans)),
    setupRowIds: null,
    steerRowIds: () => (steerRowIds ??= staleOnlySteerRowIds(window)),
  });
}

/**
 * The whole-history row projection, once per window.
 *
 * Both steer questions below want it, and `appendUnplacedRenderedRows` reaches
 * both for a single model - a synthesized steer row answers the stale question
 * through the projection, and is then asked the live one, which projects again.
 * So without sharing, one render pays this fold twice.
 *
 * That matters here specifically because this module runs per token (see
 * {@link placeholderRowsFor}) while `projectTranscriptRows` is O(history) - the
 * shape the rest of the module is arranged to keep off that path.
 *
 * Keyed on the WINDOW rather than on the records, because both inputs come out
 * of one {@link hydratedRecords} call and the window is what identifies the
 * pair. Every update spreads a new window object, so an identity's contents
 * never change and a hit can never be stale. Streaming replaces the window per
 * token, so this collapses the folds WITHIN a render rather than across them -
 * which is the duplication, the cross-render case being a genuinely different
 * projection each time.
 */
const projectedRowCache = new WeakMap<
  TranscriptWindow,
  readonly TranscriptRowDescriptor[]
>();

function projectedRowsFor(
  window: TranscriptWindow,
): readonly TranscriptRowDescriptor[] {
  const cached = projectedRowCache.get(window);
  if (cached !== undefined) return cached;
  const records = hydratedRecords(window);
  const rows = projectTranscriptRows({
    messages: records.messages,
    events: records.events,
    activeTurnId: null,
    chatId: "",
  });
  projectedRowCache.set(window, rows);
  return rows;
}

/**
 * The steer rows the projection draws for a given set of turns.
 *
 * The two tiers ask one question of one projection and differ only in the turn
 * set, so they share this rather than each carrying a copy of the filter.
 *
 * No turns, no fold: the filter could not match anything, so the answer is
 * empty without projecting. Worth stating because the caller cannot always tell
 * - {@link transientLiveSteerRowIds} builds a set that is empty whenever no
 * live assistant message is transient, which is most of the time.
 */
function steerRowIdsForTurnKeys(
  window: TranscriptWindow,
  turnKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  if (turnKeys.size === 0) return new Set();
  return new Set(
    projectedRowsFor(window)
      .filter(
        (row) =>
          row.source.kind === "steer" && turnKeys.has(row.source.turnKey),
      )
      .map((row) => row.rowId),
  );
}

/**
 * Steer rows projected from a turn ONLY the stale tier holds.
 *
 * The stale-tier counterpart of {@link transientLiveSteerRowIds}: same
 * projection and same filter, reached through {@link steerRowIdsForTurnKeys},
 * with only the turn set differing. Keep the two in step.
 */
function staleOnlySteerRowIds(window: TranscriptWindow): ReadonlySet<string> {
  const turnKeys = new Set<string>();
  for (const span of window.staleSpans) {
    for (const message of spanMessages(window, span)) {
      if (message.role === "assistant") turnKeys.add(assistantTurnKey(message));
    }
  }
  const alsoCurrent = (message: Message): void => {
    if (message.role === "assistant")
      turnKeys.delete(assistantTurnKey(message));
  };
  for (const message of window.liveMessages) alsoCurrent(message);
  for (const span of window.spans) {
    for (const message of spanMessages(window, span)) alsoCurrent(message);
  }
  return steerRowIdsForTurnKeys(window, turnKeys);
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
  addRecordBackedRowIds(rowIds, window.liveMessages, window.liveEvents);
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
  return steerRowIdsForTurnKeys(window, transientTurnKeys);
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
 * One predicate, because three callers ask it about the same models for the
 * same reason and a second copy drifts: the invalidated merge asks it to
 * decide which unplaced records still belong at the tail,
 * {@link appendUnplacedRenderedRows} asks it to decide whether a model the
 * STALE tier also backs is nonetheless the newest thing the client holds, and
 * {@link seatLiveRecords} asks it to decide which models seat at the ordinals
 * the index has started naming. A narrower answer in any of them hides an
 * active row behind a placeholder until replacement hydration arrives, which
 * is the failure the stale tier exists to prevent - and consuming a channel
 * SUBSET was exactly how `seatLiveRecords` lost setup cards and steer splits.
 *
 * The channels are the live rows of {@link BACKING_CHANNELS}, in that order.
 */
function liveBackingLookup(
  window: TranscriptWindow,
  rendered: readonly ChatMessageModel[],
): (model: ChatMessageModel) => boolean {
  let liveRowIds: ReadonlySet<string> | null = null;
  let setupRowIds: ReadonlySet<string> | null = null;
  let steerRowIds: ReadonlySet<string> | null = null;
  return backingLookup({
    tier: "live",
    holdsNothing: () => false,
    rowIds: () => (liveRowIds ??= liveRecordRowIds(window)),
    setupRowIds: () =>
      (setupRowIds ??= projectedLiveSetupRowIds(window, rendered)),
    steerRowIds: () => (steerRowIds ??= transientLiveSteerRowIds(window)),
  });
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
 * Within the tier, the FRESHEST SERVE wins a row two carries both hold - the
 * same rule {@link hydratedRecords} and `hydratedRowContext` resolve bodies and
 * context by, applied to position. `staleSpans` is stored in ordinal order, so
 * a first-match scan would hand the row to whichever carry sits earlier in the
 * OLD space, which after a second rebase is the older one: an insertion earlier
 * in the transcript would then render the row at its pre-insertion position
 * until the skeleton chunk naming it arrives. Two carries can hold one row
 * because {@link boundedStaleSpans} admits a span for any single uncovered row
 * it contributes, duplicates beside it included.
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
  // A sorted COPY (the STORED order is ordinal, which `hydratedRecords` relies
  // on for its linear merge), on the derived record-grain serve stamp - the
  // identical record-level figure `staleRowOwners` and the admission sort
  // read, which is what keeps the three passes awarding a contested row the
  // same way.
  const byFreshestServe = staleSpansByFreshestServe(window);
  for (const span of byFreshestServe) {
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
 * Consumes {@link liveBackingLookup}'s FULL channel set, not an id subset.
 * The two-channel version of this pass (row ids + persistent ids) left a
 * skeleton-named setup card, steer split, or Pending/Streaming model behind
 * its placeholder: not seated here, and not appended at the tail either,
 * because {@link appendUnplacedRenderedRows} skips every model the skeleton
 * names. Whether a model is live-backed is ONE question with one answer set;
 * which ordinal it seats at stays this pass's own judgement (the skeleton
 * gate below).
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
  const isLiveBacked = liveBackingLookup(input.window, input.rendered);
  for (const model of input.rendered) {
    if (!isLiveBacked(model)) continue;
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
  const isStaleBacked = staleBackingLookup(window);
  for (const model of input.rendered) {
    if (input.placedRowIds.has(model.id)) continue;
    if (input.skeletonOrdinals.has(model.id)) continue;
    if (isStaleBacked(model)) {
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

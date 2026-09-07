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
  assistantRowId,
  assistantRowTurnKey,
  projectTranscriptRows,
  type TranscriptRowDescriptor,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import { assistantTurnKey } from "@traycer/protocol/persistence/chat-transcript/fork-boundary";
import { isTransientLiveAssistantMessageId } from "@/lib/chat/transient-live-assistant-message-id";

const EMPTY_ROW_IDS: ReadonlySet<string> = new Set<string>();

/**
 * Place hydrated rows from spans, not the sparse skeleton.
 * Placeholders are their own row kind, never a partial ChatMessage.
 */

export type TranscriptListRow =
  | {
      readonly kind: "hydrated";
      /** Stable React/LegendList key. The row id for a placed row. */
      readonly key: string;
      /**
       * Its place in the transcript, or `null` for a row that owns no ordinal - a pending send, the live
       * turn, or a record the index has not placed.
       */
      readonly ordinal: number | null;
      readonly model: ChatMessageModel;
    }
  | {
      readonly kind: "placeholder";
      readonly key: string;
      readonly ordinal: number;
      /** The skeleton's description of the row, or `null` when that ordinal is still a hole. */
      readonly entry: RowSkeletonEntry | null;
    };

const UNPLACED_ROW_KEY_PREFIX = "unplaced-row:";

/** The key a placeholder takes before any skeleton entry describes it. */
export function unplacedRowKey(ordinal: number): string {
  return `${UNPLACED_ROW_KEY_PREFIX}${ordinal}`;
}

/**
 * Is this key a synthesized position rather than a row IDENTITY? The distinction matters to
 * anything that PERSISTS a key.
 */
export function isUnplacedRowKey(key: string): boolean {
  return key.startsWith(UNPLACED_ROW_KEY_PREFIX);
}

/** Every row identity backed by a hydrated span, keyed by the spans array. */
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
  { readonly revision: number; readonly rowIds: ReadonlySet<string> }
>();

/**
 * Every id a tier's contents can be rendered FROM - the mirror of {@link liveRecordRowIds} over a
 * hydrated tier, sharing its fold ({@link addRecordBackedRowIds}, which lives beside the draws
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

/** Which tier a backing channel may serve. */
type BackingTier = "live" | "stale";

/** One tier's lazily-built answer sources for the backing channels. */
interface BackingTierSources {
  readonly tier: BackingTier;
  /** True when the tier holds nothing at all - the cheap short-circuit. */
  readonly holdsNothing: () => boolean;
  /** The tier's row ids plus derived backable shapes, one fold. */
  readonly rowIds: () => ReadonlySet<string>;
  /** Setup-card rows the tier's event log materializes. */
  readonly setupRowIds: (() => ReadonlySet<string>) | null;
  /** Steer rows projected from this tier's turn set. */
  readonly steerRowIds: () => ReadonlySet<string>;
}

/** One way a tier's contents reach the renderer. */
interface BackingChannel {
  readonly servesTiers: readonly BackingTier[];
  readonly isBacked: (
    model: ChatMessageModel,
    sources: BackingTierSources,
  ) => boolean;
}

/**
 * The backing channels, in answer order (cheapest first, and the live lookup's historical order is
 * preserved exactly; the stale lookup's is the same list with the live-only members filtered out).
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
 * "Is this rendered model backed by the STALE tier?" - the same channel list as {@link
 * liveBackingLookup} with the live-only members filtered out, because they are one question asked
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

/** The whole-history row projection, once per window. */
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

/** The steer rows the projection draws for a given set of turns. */
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

/** Steer rows projected from a turn ONLY the stale tier holds. */
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
 * The row ids of the records this client holds LIVE - pushed whole by the host and not yet
 * superseded by a span.
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

/** Placeholder rows already built, keyed by the skeleton they were built from. */
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
 * Seat the carried stale bodies - the spans a rebase or void discarded, kept for display while
 * their replacement streams in.
 */
function seatStaleRows(input: {
  readonly window: TranscriptWindow;
  readonly modelsById: ReadonlyMap<string, ChatMessageModel>;
  readonly skeletonOrdinals: ReadonlyMap<string, number>;
  readonly modelByOrdinal: Map<number, ChatMessageModel>;
  readonly placedRowIds: Set<string>;
  readonly suppressedOrdinals: Set<number>;
  readonly excludedRowIds: ReadonlyMap<string, number> | ReadonlySet<string>;
}): void {
  const { window } = input;
  // A sorted COPY (the STORED order is ordinal, which `hydratedRecords` relies on for its linear
  // merge), on the derived record-grain serve stamp - the identical record-level figure
  const byFreshestServe = staleSpansByFreshestServe(window);
  for (const span of byFreshestServe) {
    span.rowIds.forEach((rowId, offset) => {
      // The empty string is a positionally-seated legacy tail's "identity
      // unverified" marker, not a row id - nothing can match it.
      if (rowId === "") return;
      if (input.placedRowIds.has(rowId)) return;
      let ordinal = input.skeletonOrdinals.get(rowId);
      // Whether the REPLACEMENT index still names this id, which is the only evidence here that it is a
      // current row id and not a pre-rebase one.
      const namedByIndex = ordinal !== undefined;
      if (ordinal === undefined) {
        const oldOrdinal = span.fromOrdinal + offset;
        if (window.skeleton[oldOrdinal] !== undefined) return;
        ordinal = oldOrdinal;
      }
      if (ordinal >= window.rowCount) return;
      if (input.excludedRowIds.has(rowId)) {
        input.suppressedOrdinals.add(ordinal);
        return;
      }
      if (
        input.modelByOrdinal.has(ordinal) ||
        input.suppressedOrdinals.has(ordinal)
      ) {
        return;
      }
      const model = input.modelsById.get(rowId);
      if (model === undefined) {
        // The fresh-span pass reads a missing model as the renderer WITHHOLDING the row and emits nothing,
        // and it is entitled to: its row ids are the current ones by construction, so the renderer
        if (namedByIndex) input.suppressedOrdinals.add(ordinal);
        return;
      }
      input.modelByOrdinal.set(ordinal, model);
      input.placedRowIds.add(rowId);
    });
  }
}

/**
 * The rows of a live split turn the skeleton still names in its UNSPLIT shape, held back from
 * one-by-one seating so they can replace the unsplit turn as a unit, in rendered order.
 */
function preSplitSkeletonTurnRows(input: {
  readonly rendered: readonly ChatMessageModel[];
  readonly isLiveBacked: (model: ChatMessageModel) => boolean;
  readonly skeletonOrdinals: ReadonlyMap<string, number>;
  readonly suppressedOrdinals: Set<number>;
}): ReadonlyMap<string, number> {
  const sliceRangeByTurnKey = new Map<
    string,
    { first: number; last: number }
  >();
  input.rendered.forEach((model, index) => {
    const turnKey = assistantRowTurnKey(model.id);
    // The bare `assistant:<key>` id is the unsplit row, not a slice.
    if (turnKey === null || model.id === assistantRowId(turnKey)) return;
    const range = sliceRangeByTurnKey.get(turnKey);
    if (range === undefined) {
      sliceRangeByTurnKey.set(turnKey, { first: index, last: index });
    } else {
      range.last = index;
    }
  });
  const held = new Map<string, number>();
  for (const [turnKey, range] of sliceRangeByTurnKey) {
    const unsplitOrdinal = input.skeletonOrdinals.get(assistantRowId(turnKey));
    if (unsplitOrdinal === undefined) continue;
    const unit = input.rendered.slice(range.first, range.last + 1);
    const skeletonNamesASlice = unit.some(
      (model) =>
        input.skeletonOrdinals.has(model.id) &&
        assistantRowTurnKey(model.id) === turnKey,
    );
    if (skeletonNamesASlice) continue;
    // The unit's first row is its first slice by construction (a non-empty
    // range); its backing is what says the split is the host's own.
    const first = unit.at(0);
    if (first === undefined || !input.isLiveBacked(first)) continue;
    input.suppressedOrdinals.add(unsplitOrdinal);
    for (const model of unit) {
      held.set(model.id, unsplitOrdinal);
      const ordinal = input.skeletonOrdinals.get(model.id);
      if (ordinal !== undefined) input.suppressedOrdinals.add(ordinal);
    }
  }
  return held;
}

/** Seat the live records the index has started naming, in place. */
function seatLiveRecords(input: {
  readonly window: TranscriptWindow;
  readonly rendered: readonly ChatMessageModel[];
  readonly isLiveBacked: (model: ChatMessageModel) => boolean;
  readonly skeletonOrdinals: ReadonlyMap<string, number>;
  readonly modelByOrdinal: Map<number, ChatMessageModel>;
  readonly placedRowIds: Set<string>;
  readonly suppressedOrdinals: ReadonlySet<number>;
  readonly heldPreSplitRows: ReadonlyMap<string, number>;
}): void {
  for (const model of input.rendered) {
    if (!input.isLiveBacked(model)) continue;
    if (input.placedRowIds.has(model.id)) continue;
    if (input.heldPreSplitRows.has(model.id)) continue;
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

/** The invalidated-window merge, extracted for the complexity ceiling. */
function invalidatedTranscriptListRows(
  window: TranscriptWindow,
  rendered: readonly ChatMessageModel[],
): readonly TranscriptListRow[] {
  const isLiveBacked = liveBackingLookup(window, rendered);
  // The rows a retained span DRAWS, not what its records could back.
  const retainedSpanRowIds = spanRowIds(window.spans);
  const staleByOrdinal = new Map<number, ChatMessageModel>();
  const staleSeatedRowIds = new Set<string>();
  seatStaleRows({
    window,
    modelsById: new Map(rendered.map((model) => [model.id, model])),
    skeletonOrdinals: skeletonOrdinalByRowId(window.skeleton),
    modelByOrdinal: staleByOrdinal,
    placedRowIds: staleSeatedRowIds,
    // Collected and DISCARDED, deliberately.
    suppressedOrdinals: new Set<number>(),
    excludedRowIds: EMPTY_ROW_IDS,
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
 * Merge what the renderer produced with what the window says exists. every row is hydrated by
 * construction and this is the identity mapping.
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
  const skeletonOrdinals = skeletonOrdinalByRowId(window.skeleton);
  const isLiveBacked = liveBackingLookup(window, rendered);
  // Decided BEFORE any seating, because it is a statement about which ordinals are stale rather than
  // about any one row - and because the span pass below would otherwise place a held row first.
  const heldPreSplitRows = preSplitSkeletonTurnRows({
    rendered,
    isLiveBacked,
    skeletonOrdinals,
    suppressedOrdinals,
  });
  for (const span of window.spans) {
    span.rowIds.forEach((rowId, offset) => {
      const ordinal = span.fromOrdinal + offset;
      // A span reaching past `rowCount` would be a host/client disagreement about length.
      if (ordinal >= window.rowCount) return;
      if (heldPreSplitRows.has(rowId)) {
        // The unit replaces these individual stale ordinals at the unsplit turn's position.
        suppressedOrdinals.add(ordinal);
        return;
      }
      const model = modelsById.get(rowId);
      if (model === undefined) {
        // The span proves the body is HELD; its absence from `rendered` means a renderer policy withheld
        // the row (see the module doc). Emit nothing at this ordinal.
        suppressedOrdinals.add(ordinal);
        return;
      }
      modelByOrdinal.set(ordinal, model);
      placedRowIds.add(rowId);
    });
  }

  // A live record the index has just started naming, seated at the ordinal it names rather than
  // dropped.
  seatLiveRecords({
    window,
    rendered,
    isLiveBacked,
    skeletonOrdinals,
    modelByOrdinal,
    placedRowIds,
    suppressedOrdinals,
    heldPreSplitRows,
  });

  // Carried stale bodies fill whatever the fresh spans and live records did not - by
  // replacement-skeleton name, or into an entry-less hole at their old ordinal.
  if (window.staleSpans.length > 0) {
    seatStaleRows({
      window,
      modelsById,
      skeletonOrdinals,
      modelByOrdinal,
      placedRowIds,
      suppressedOrdinals,
      excludedRowIds: heldPreSplitRows,
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
    // Reused across deltas: see `placeholderRowsBySkeleton`. Nothing here reads the spans or the
    // rendered models, so a body arriving elsewhere in the chat cannot change this row.
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
    isLiveBacked,
    placedRowIds,
    skeletonOrdinals,
    heldPreSplitRows,
    rows,
  });
  return rows;
}

/**
 * Append the rendered models that own no ordinal - the live tail. A row the SKELETON names owns an
 * ordinal, so it is not an unplaced record however it came to be rendered.
 */
function appendUnplacedRenderedRows(input: {
  readonly window: TranscriptWindow;
  readonly rendered: readonly ChatMessageModel[];
  readonly isLiveBacked: (model: ChatMessageModel) => boolean;
  readonly placedRowIds: ReadonlySet<string>;
  readonly skeletonOrdinals: ReadonlyMap<string, number>;
  readonly heldPreSplitRows: ReadonlyMap<string, number>;
  readonly rows: TranscriptListRow[];
}): void {
  const { window } = input;
  const isStaleBacked = staleBackingLookup(window);
  const heldByOrdinal = new Map<number, ChatMessageModel[]>();
  const unplaced: ChatMessageModel[] = [];
  for (const model of input.rendered) {
    if (input.placedRowIds.has(model.id)) continue;
    if (
      input.skeletonOrdinals.has(model.id) &&
      !input.heldPreSplitRows.has(model.id)
    ) {
      continue;
    }
    if (isStaleBacked(model)) {
      // The SAME live-backed question the invalidated merge asks, from the same predicate.
      if (!input.isLiveBacked(model)) continue;
    }
    const heldOrdinal = input.heldPreSplitRows.get(model.id);
    if (heldOrdinal !== undefined) {
      const unit = heldByOrdinal.get(heldOrdinal) ?? [];
      unit.push(model);
      heldByOrdinal.set(heldOrdinal, unit);
      continue;
    }
    unplaced.push(model);
  }
  const heldUnits = [...heldByOrdinal].sort(([left], [right]) => left - right);
  if (heldUnits.length > 0) {
    const merged: TranscriptListRow[] = [];
    let heldIndex = 0;
    function appendHeldThrough(ordinal: number): void {
      while (heldIndex < heldUnits.length) {
        const entry = heldUnits[heldIndex];
        if (entry[0] > ordinal) break;
        const [heldOrdinal, unit] = entry;
        for (const model of unit) {
          merged.push({
            kind: "hydrated" as const,
            key: model.id,
            // The unit is mid-transcript, not part of the live tail. Every member shares its stale unsplit
            // anchor so ANY virtualized slice of a tall unit protects and hydrates the surrounding range.
            ordinal: heldOrdinal,
            model,
          });
        }
        heldIndex += 1;
      }
    }
    for (const row of input.rows) {
      if (row.ordinal !== null) appendHeldThrough(row.ordinal);
      merged.push(row);
    }
    appendHeldThrough(Number.POSITIVE_INFINITY);
    input.rows.length = merged.length;
    let mergedIndex = 0;
    for (const row of merged) {
      input.rows[mergedIndex] = row;
      mergedIndex += 1;
    }
  }
  for (const model of unplaced) {
    input.rows.push({
      kind: "hydrated" as const,
      key: model.id,
      ordinal: null,
      model,
    });
  }
}

/** The ordinal span a rendered index range covers, for viewport hydration. */
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

/**
 * The OLDER half of chat find on the windowed line (`chat.subscribe@1.8`).
 *
 * The client scan (`chat-find-adapter.ts`) is exact over the rows the tile
 * holds, and it stays the only answer for them: live rows, and every rendered
 * unit - reasoning, subagent bodies, tool output included. The rows it cannot
 * see are the unhydrated ones, and for those the host's chat search index
 * answers instead: the chat-scoped `substring` query over the same text.
 *
 * A hybrid rather than a switch, because the index is a different corpus. It
 * holds user text, assistant prose, notices and card text (plans, interviews,
 * tool command lines) and excludes reasoning, subagent bodies, file changes,
 * artifact operations and tool output by design, so a pure switch would drop
 * matches the client scan finds today. The price of the hybrid is stated in
 * the caveat instead: an older match in excluded text is not found until its
 * row is hydrated.
 *
 * An index hit is only ever a MESSAGE-level claim ("this older message
 * contains the text"). Navigating to one hydrates the row, and from then on
 * the client scan owns it - which is what makes the highlight and the
 * within-message positions exact.
 */
import { assistantTurnKey } from "@traycer/protocol/persistence/chat-transcript/fork-boundary";
import { assistantRowTurnKey } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import { findTextMatches } from "@/lib/find-engine/find-text";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { TranscriptWindow } from "@/stores/chats/transcript-window";

/** The question the bar last searched, as the adapter ran it. */
export interface ChatFindSearch {
  readonly query: string;
  readonly matchCase: boolean;
}

/**
 * How much of the index one search may read.
 *
 * Pages are fetched on demand, never walked: every chat-scoped `substring` page
 * is three `LIKE` passes over the chat's documents on the host's shared pool,
 * and `OFFSET` re-scans every earlier match. So page 1 is asked per settled
 * query, and a further page only when the reader steps back from the OLDEST
 * stop - an older hit or, when none is loaded yet, a loaded match - while the
 * index has more (`pages` grows then).
 */
export interface ChatFindIndexDemand {
  readonly search: ChatFindSearch;
  readonly pages: number;
}

/** A bound on memory, not on cost: the cost bound is that pages are on demand. */
export const CHAT_FIND_INDEX_MAX_PAGES = 10;

/**
 * Where the adapter publishes what the index should be asked, and the index
 * query reads it.
 *
 * External to React on purpose: the adapter is created and replaced inside a
 * layout effect, while the query runs in a component that has to subscribe
 * before any adapter exists - so the channel between them is this object,
 * created once per transcript, not the adapter.
 */
export class ChatFindIndexDemandSource {
  private demand: ChatFindIndexDemand | null = null;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ChatFindIndexDemand | null => this.demand;

  /**
   * The bar's settled search, or `null` when it has none. A new question starts
   * over at page 1; the same one again keeps what the reader already paged to.
   * Clearing is what stops the index being asked at all - a closed bar reads
   * nothing.
   */
  setSearch(search: ChatFindSearch | null): void {
    const current = this.demand?.search ?? null;
    if (
      search === null
        ? current === null
        : current !== null &&
          current.query === search.query &&
          current.matchCase === search.matchCase
    ) {
      return;
    }
    this.demand = search === null ? null : { search, pages: 1 };
    this.notify();
  }

  /** Ask for the first `pages` pages of the current search; never fewer. */
  requestPages(pages: number): void {
    const current = this.demand;
    if (current === null) return;
    const next = Math.min(
      CHAT_FIND_INDEX_MAX_PAGES,
      Math.max(current.pages, pages),
    );
    if (next === current.pages) return;
    this.demand = { search: current.search, pages: next };
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}

/** One matching index document, reduced to what find reads. */
export interface ChatFindIndexHit {
  /** The persisted message id - a record id, not a row id. */
  readonly messageId: string;
  /** The message body's own timestamp. */
  readonly createdAt: number;
  /** The index's snippet around its first match. */
  readonly snippet: string;
}

export type ChatFindIndexAnswer =
  /**
   * Every way the index cannot answer: no query, nothing unhydrated, a host
   * without the index, a refused or failed request, or one still in flight.
   * One state on purpose - find then behaves exactly as it did without the
   * index, caveat included, and no error reaches the bar.
   */
  | { readonly kind: "absent" }
  | {
      readonly kind: "ready";
      /** The search these hits answer; any other search ignores them. */
      readonly search: ChatFindSearch;
      readonly hits: ReadonlyArray<ChatFindIndexHit>;
      /** Pages read so far. */
      readonly pages: number;
      /** The host has pages past the last one read. */
      readonly more: boolean;
      /** A further page is in flight. */
      readonly loadingMore: boolean;
    };

export const CHAT_FIND_INDEX_ABSENT: ChatFindIndexAnswer = { kind: "absent" };

/**
 * Where an index hit's record sits in the transcript the tile holds.
 *
 * - `loaded`: every row that renders the record is hydrated, so the client
 *   scan has already seen all of its text and the hit adds nothing.
 * - `unhydrated`: some of it is not on screen. Either the window does not hold
 *   the record at all, or it holds it through a row of the same turn while
 *   other rows of that turn are still placeholders - hydrating any slice of a
 *   turn brings all of the turn's records into the ledger, so "held" alone
 *   does not mean "scanned".
 */
export type ChatFindIndexHitPlacement =
  | { readonly kind: "loaded" }
  | {
      readonly kind: "unhydrated";
      /** Whether the window holds the record through some hydrated row. */
      readonly held: boolean;
      /**
       * Transcript position in skeleton ordinals. Exact when the record's row
       * id is its own id (user and steer rows) or its rows are known; for any
       * other record, estimated from its timestamp - see
       * {@link chatFindTranscriptPlacement}.
       */
      readonly sortKey: number;
      /**
       * What navigation jumps to, in order: the record's unhydrated rows by
       * ROW id, nearest the hydrated part first, when the window can name
       * them; otherwise the record id, which the tile's jump resolves.
       */
      readonly targets: ReadonlyArray<string>;
    };

/** What find reads about the transcript's shape: the window, on its line. */
export interface ChatFindTranscriptPlacement {
  placeHit(hit: ChatFindIndexHit): ChatFindIndexHitPlacement;
  /** A rendered row's skeleton ordinal; `null` for a row not placed yet. */
  rowSortKey(rowId: string): number | null;
}

/**
 * The legacy line (`messages` is the whole transcript): everything is
 * loaded, and nothing asks the index there anyway.
 */
export const FULLY_LOADED_TRANSCRIPT: ChatFindTranscriptPlacement = {
  placeHit: () => ({ kind: "loaded" }),
  rowSortKey: () => null,
};

interface SkeletonRow {
  readonly ordinal: number;
  readonly rowId: string;
}

interface WindowPlacementIndex {
  readonly ordinalByRowId: ReadonlyMap<string, number>;
  readonly hydrated: Uint8Array;
  /** Unhydrated assistant rows per turn key, in ordinal order. */
  readonly unhydratedByTurnKey: ReadonlyMap<string, ReadonlyArray<SkeletonRow>>;
  /** Running maximum of skeleton `createdAt`, per ordinal. */
  readonly createdAtCeiling: Float64Array;
}

function buildWindowPlacementIndex(
  window: TranscriptWindow,
): WindowPlacementIndex {
  const hydrated = new Uint8Array(window.rowCount);
  for (const span of window.spans) {
    const end = Math.min(
      window.rowCount,
      span.fromOrdinal + span.rowIds.length,
    );
    for (let ordinal = span.fromOrdinal; ordinal < end; ordinal += 1) {
      hydrated[ordinal] = 1;
    }
  }
  const ordinalByRowId = new Map<string, number>();
  const unhydratedByTurnKey = new Map<string, SkeletonRow[]>();
  const createdAtCeiling = new Float64Array(window.rowCount);
  let ceiling = Number.NEGATIVE_INFINITY;
  for (let ordinal = 0; ordinal < window.rowCount; ordinal += 1) {
    const entry = window.skeleton[ordinal];
    if (entry !== undefined) {
      ordinalByRowId.set(entry.rowId, ordinal);
      ceiling = Math.max(ceiling, entry.createdAt);
      const turnKey = assistantRowTurnKey(entry.rowId);
      if (turnKey !== null && hydrated[ordinal] === 0) {
        const row = { ordinal, rowId: entry.rowId };
        const rows = unhydratedByTurnKey.get(turnKey);
        if (rows === undefined) unhydratedByTurnKey.set(turnKey, [row]);
        else rows.push(row);
      }
    }
    createdAtCeiling[ordinal] = ceiling;
  }
  return { ordinalByRowId, hydrated, unhydratedByTurnKey, createdAtCeiling };
}

const placementByWindow = new WeakMap<
  TranscriptWindow,
  ChatFindTranscriptPlacement
>();

/**
 * {@link ChatFindTranscriptPlacement} over a windowed transcript. Built once
 * per window identity, and lazily: a window changes identity on every
 * hydration and live record, and only a find with index hits asks.
 *
 * ## Placing an older hit
 *
 * A user or steer record's row id IS its message id, so the skeleton places
 * it exactly. An assistant record has no row id of its own (its rows are
 * turn-keyed) and the hit carries no turn id, so an unheld one is placed by
 * timestamp: before the first row whose `createdAt` is later. That is right
 * for an ordinary turn, whose rows sit at its start and whose records are
 * stamped during it. It is not for a turn adopted from a notification, which
 * keeps the notification's early position while its records carry the run's
 * time: such a hit orders by its run time. Accepted - the hit is still
 * counted and still lands on its row; only its place in the walk differs.
 */
export function chatFindTranscriptPlacement(
  window: TranscriptWindow,
): ChatFindTranscriptPlacement {
  const cached = placementByWindow.get(window);
  if (cached !== undefined) return cached;
  let index: WindowPlacementIndex | null = null;
  const placement: ChatFindTranscriptPlacement = {
    placeHit: (hit) => {
      index ??= buildWindowPlacementIndex(window);
      return placeHitInWindow(window, index, hit);
    },
    rowSortKey: (rowId) => {
      index ??= buildWindowPlacementIndex(window);
      return index.ordinalByRowId.get(rowId) ?? null;
    },
  };
  placementByWindow.set(window, placement);
  return placement;
}

function heldRecord(
  window: TranscriptWindow,
  messageId: string,
): Message | null {
  return (
    window.records.messages.get(messageId)?.record ??
    window.liveMessages.find((message) => message.messageId === messageId) ??
    null
  );
}

function placeHitInWindow(
  window: TranscriptWindow,
  index: WindowPlacementIndex,
  hit: ChatFindIndexHit,
): ChatFindIndexHitPlacement {
  const record = heldRecord(window, hit.messageId);
  const ownOrdinal = index.ordinalByRowId.get(hit.messageId);
  if (record === null) {
    return {
      kind: "unhydrated",
      held: false,
      sortKey: ownOrdinal ?? timestampSortKey(index, hit.createdAt),
      targets: [hit.messageId],
    };
  }
  // Held: which of the rows that render it are still placeholders.
  const unhydrated = unhydratedRowsOfRecord(index, record);
  if (unhydrated.length === 0) return { kind: "loaded" };
  // Nearest the hydrated part first: the held record is held because a later
  // row of it is hydrated, which is where the reader already is.
  const nearestFirst = unhydrated.toReversed();
  return {
    kind: "unhydrated",
    held: true,
    sortKey: nearestFirst[0].ordinal,
    targets: nearestFirst.map((row) => row.rowId),
  };
}

/**
 * The rows that render `record` and are still placeholders, in ordinal order.
 * A user or steer record renders in the one row named after it; an assistant
 * record in every row of its turn, since slices fold the turn's records.
 */
function unhydratedRowsOfRecord(
  index: WindowPlacementIndex,
  record: Message,
): ReadonlyArray<SkeletonRow> {
  if (record.role === "assistant") {
    return index.unhydratedByTurnKey.get(assistantTurnKey(record)) ?? [];
  }
  const ordinal = index.ordinalByRowId.get(record.messageId);
  if (ordinal === undefined || index.hydrated[ordinal] === 1) return [];
  return [{ ordinal, rowId: record.messageId }];
}

/** Just before the first row whose `createdAt` is later than `createdAt`. */
function timestampSortKey(
  index: WindowPlacementIndex,
  createdAt: number,
): number {
  const ceiling = index.createdAtCeiling;
  let low = 0;
  let high = ceiling.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ceiling[middle] > createdAt) high = middle;
    else low = middle + 1;
  }
  return low - 0.5;
}

/** An older message the index says contains the query, placed. */
export interface ChatFindOlderHit {
  readonly messageId: string;
  readonly held: boolean;
  readonly sortKey: number;
  readonly targets: ReadonlyArray<string>;
}

/**
 * The index's hits that describe text the client scan could NOT see, one per
 * message, in transcript order.
 *
 * - A hit on a fully loaded record is dropped: the client scan counted it,
 *   exactly, so keeping it would count it twice. (A HELD record with rows
 *   still unhydrated is kept here; the adapter drops it only when the client
 *   scan found a match in the rows it does have.)
 * - One message can match in up to three documents (prose, notice, card text);
 *   it is one older match.
 * - A hit is kept only when the bar's own matcher finds the query in its
 *   snippet. The index folds ASCII case only and trims the query, so without
 *   this a match-case search, or a query with a leading or trailing space,
 *   would count messages the client scan will not match once they hydrate.
 *   The snippet is a window around the index's first occurrence, so a
 *   case-exact occurrence far from a differently-cased first one is lost -
 *   the conservative direction.
 */
export function olderChatFindIndexHits(input: {
  readonly answer: ChatFindIndexAnswer;
  readonly search: ChatFindSearch;
  readonly placement: ChatFindTranscriptPlacement;
}): ReadonlyArray<ChatFindOlderHit> {
  const { answer, placement, search } = input;
  if (answer.kind !== "ready") return [];
  if (
    answer.search.query !== search.query ||
    answer.search.matchCase !== search.matchCase
  ) {
    return [];
  }
  const byMessage = new Map<string, ChatFindOlderHit>();
  const seen = new Set<string>();
  for (const hit of answer.hits) {
    if (seen.has(hit.messageId)) continue;
    if (
      findTextMatches(hit.snippet, search.query, search.matchCase).length === 0
    ) {
      continue;
    }
    seen.add(hit.messageId);
    const placed = placement.placeHit(hit);
    if (placed.kind === "loaded") continue;
    byMessage.set(hit.messageId, {
      messageId: hit.messageId,
      held: placed.held,
      sortKey: placed.sortKey,
      targets: placed.targets,
    });
  }
  return [...byMessage.values()].sort(
    (left, right) =>
      left.sortKey - right.sortKey ||
      (left.messageId < right.messageId ? -1 : 1),
  );
}

/**
 * The bar's caveat once the index has named older matches. It replaces the
 * "not loaded" caveat, and it still has a job: the index does not hold every
 * kind of text, so "N older messages match" over the index is a count over a
 * narrower corpus than the loaded rows were scanned in.
 *
 * `more` is "the index has pages past the last one read": the count is then
 * a floor, and says so.
 */
export function chatFindIndexCoverageMessage(
  olderMessages: number,
  more: boolean,
): string {
  const count = olderMessages.toLocaleString();
  const noun = olderMessages === 1 ? "message matches" : "messages match";
  const lead = more ? `At least ${count}` : count;
  return `${lead} older ${noun}; older reasoning, subagent and tool output are not indexed.`;
}

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
import { findTextMatches } from "@/lib/find-engine/find-text";
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
 * query, and a further page only when the reader steps past the oldest older
 * hit already loaded (`pages` grows then).
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

/** An unhydrated message the index says contains the query. */
export interface ChatFindOlderHit {
  readonly messageId: string;
  readonly createdAt: number;
}

/**
 * The index's hits that describe rows the client scan could NOT see, one per
 * message, oldest first.
 *
 * - A hit whose record the window holds is dropped: the client scan already
 *   counted that row, exactly, so keeping it would count it twice.
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
  readonly isRecordHeld: (messageId: string) => boolean;
}): ReadonlyArray<ChatFindOlderHit> {
  const { answer, search } = input;
  if (answer.kind !== "ready") return [];
  if (
    answer.search.query !== search.query ||
    answer.search.matchCase !== search.matchCase
  ) {
    return [];
  }
  const byMessage = new Map<string, ChatFindOlderHit>();
  for (const hit of answer.hits) {
    if (byMessage.has(hit.messageId)) continue;
    if (input.isRecordHeld(hit.messageId)) continue;
    if (
      findTextMatches(hit.snippet, search.query, search.matchCase).length === 0
    ) {
      continue;
    }
    byMessage.set(hit.messageId, {
      messageId: hit.messageId,
      createdAt: hit.createdAt,
    });
  }
  return [...byMessage.values()].sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
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

/**
 * Whether the window holds this RECORD - in a span, fresh or carried, or live.
 *
 * Record identity rather than row identity because that is what an index hit
 * names, and because rows and records are not one-to-one: an assistant turn's
 * rows are keyed by turn and carry one record id between them. A held record
 * is rendered, so the client scan has seen it.
 */
export function transcriptWindowHoldsMessage(
  window: TranscriptWindow,
  messageId: string,
): boolean {
  if (window.records.messages.has(messageId)) return true;
  return window.liveMessages.some((message) => message.messageId === messageId);
}

/**
 * The `dateRange.to` for the older-rows query: the `createdAt` of the first row
 * of the hydrated suffix that reaches the end of the transcript, or `null`
 * (no bound) when the tail itself is not hydrated.
 *
 * Every row at or after that one is held, so its documents could only come
 * back to be dropped - and they would be the NEWEST documents, i.e. exactly
 * the ones that fill page 1 first. The bound is inclusive, which admits the
 * suffix's own first row; that is harmless, since it is held and dropped.
 *
 * Unhydrated gaps between older spans are all before this row, so they stay
 * inside the range. What the bound can miss: an assistant record stamped
 * later than the row it precedes (a steer re-anchored to its turn's start is
 * the known shape) - only when that suffix starts mid-turn.
 */
export function chatFindIndexOlderThan(
  window: TranscriptWindow,
): number | null {
  if (window.rowCount === 0) return null;
  let suffixStart = window.rowCount;
  const byStartDescending = [...window.spans].sort(
    (left, right) => right.fromOrdinal - left.fromOrdinal,
  );
  for (const span of byStartDescending) {
    const end = span.fromOrdinal + span.rowIds.length;
    if (end < suffixStart) break;
    suffixStart = Math.min(suffixStart, span.fromOrdinal);
  }
  if (suffixStart >= window.rowCount || suffixStart === 0) return null;
  return window.skeleton[suffixStart]?.createdAt ?? null;
}

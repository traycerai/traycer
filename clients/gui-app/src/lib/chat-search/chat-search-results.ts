/**
 * Pure shaping for the global chat search dialog: how the pages `chat.search`
 * answers fold into the two sections the dialog draws.
 *
 * The host already keeps a chat out of the message section when its title
 * matched, and pages each section independently. What the client adds is the
 * fold across pages: a "show more" page is a separate request, and the index
 * can move between two requests (a chat is renamed, a turn lands), so a chat
 * can come back on a later page of either section. The rule is the one the
 * host states for a single page - a chat is listed once, and a title match
 * wins over a message match - applied to everything on screen.
 */
import type {
  ChatSearchChatMatch,
  ChatSearchDateRange,
  ChatSearchMessageHit,
  ChatSearchMessageMatch,
  ChatSearchRange,
  ChatSearchResponse,
} from "@traycer/protocol/host/chat-search/schemas";
import { epicDisplayTitle } from "@/lib/display-title";
import type { ChatSearchDatePreset } from "@/stores/chat-search/chat-search-store";

/** Title-section rows per page. */
export const CHAT_SEARCH_CHAT_PAGE_SIZE = 5;
/** Message-section groups per page. */
export const CHAT_SEARCH_MESSAGE_PAGE_SIZE = 10;
/** Message rows per page inside one expanded chat. */
export const CHAT_SEARCH_EXPANSION_PAGE_SIZE = 20;
/** Quiet time after the last keystroke before a search is sent. */
export const CHAT_SEARCH_DEBOUNCE_MS = 200;
/** The host searches message text from this many characters; titles from one. */
export const CHAT_SEARCH_BODY_MIN_QUERY_CHARS = 2;

/** `(epicId, ownerUserId, chatId)` - the key the protocol groups results by. */
export function chatSearchGroupKey(group: {
  readonly epicId: string;
  readonly ownerUserId: string;
  readonly chatId: string;
}): string {
  return JSON.stringify([group.epicId, group.ownerUserId, group.chatId]);
}

export interface ChatSearchMergedResults {
  readonly chatMatches: ReadonlyArray<ChatSearchChatMatch>;
  readonly messageMatches: ReadonlyArray<ChatSearchMessageMatch>;
  /**
   * Cursor for the next title page, or `null` when there is none - or when a
   * page already asked for has not answered yet, since its answer is what
   * names the next cursor.
   */
  readonly chatNextCursor: string | null;
  readonly messageNextCursor: string | null;
  /** `partial` when any page on screen was answered by a still-building index. */
  readonly indexState: ChatSearchResponse["indexState"];
}

/**
 * Folds the first page and the "show more" pages of each section into what
 * the dialog renders.
 *
 * `moreChats` pages contribute only their title rows and `moreMessages` pages
 * only their message groups: each such request also answers a first page of
 * the other section, which is already on screen. A page still in flight is
 * `undefined`.
 */
export function mergeChatSearchPages(input: {
  readonly first: ChatSearchResponse;
  readonly moreChats: ReadonlyArray<ChatSearchResponse | undefined>;
  readonly moreMessages: ReadonlyArray<ChatSearchResponse | undefined>;
}): ChatSearchMergedResults {
  const { first, moreChats, moreMessages } = input;
  const chatPages = [first, ...moreChats];
  const messagePages = [first, ...moreMessages];

  const seen = new Set<string>();
  const chatMatches: ChatSearchChatMatch[] = [];
  for (const page of chatPages) {
    for (const match of page?.chatMatches ?? []) {
      const key = chatSearchGroupKey(match);
      if (seen.has(key)) continue;
      seen.add(key);
      chatMatches.push(match);
    }
  }
  // After every title row, not interleaved: a title match on a LATER page
  // still takes the chat out of the message section.
  const messageMatches: ChatSearchMessageMatch[] = [];
  for (const page of messagePages) {
    for (const match of page?.messageMatches ?? []) {
      const key = chatSearchGroupKey(match);
      if (seen.has(key)) continue;
      seen.add(key);
      messageMatches.push(match);
    }
  }

  const loaded = [first, ...moreChats, ...moreMessages].filter(
    (page): page is ChatSearchResponse => page !== undefined,
  );
  return {
    chatMatches,
    messageMatches,
    chatNextCursor: lastCursor(chatPages, (page) => page.chatNextCursor),
    messageNextCursor: lastCursor(
      messagePages,
      (page) => page.messageNextCursor,
    ),
    indexState: loaded.some((page) => page.indexState === "partial")
      ? "partial"
      : "complete",
  };
}

function lastCursor(
  pages: ReadonlyArray<ChatSearchResponse | undefined>,
  read: (page: ChatSearchResponse) => string | null,
): string | null {
  const last = pages.at(-1);
  return last === undefined ? null : read(last);
}

/**
 * Folds the pages of one expanded chat (`scope: chat`) into its rows. A row is
 * one document, so `(messageId, tier)` is its identity: a message with both
 * prose and a notice that match is two rows, and a row repeated by a later
 * page is dropped.
 */
export function mergeChatSearchExpansionPages(
  pages: ReadonlyArray<ChatSearchResponse | undefined>,
): {
  readonly messages: ReadonlyArray<ChatSearchMessageHit>;
  readonly nextCursor: string | null;
} {
  const seen = new Set<string>();
  const messages: ChatSearchMessageHit[] = [];
  for (const page of pages) {
    for (const group of page?.messageMatches ?? []) {
      for (const hit of group.messages) {
        const key = JSON.stringify([hit.messageId, hit.tier]);
        if (seen.has(key)) continue;
        seen.add(key);
        messages.push(hit);
      }
    }
  }
  return {
    messages,
    nextCursor: lastCursor(pages, (page) => page.messageNextCursor),
  };
}

export interface HighlightSegment {
  /** UTF-16 offset of this segment in the source text. */
  readonly start: number;
  readonly text: string;
  readonly highlighted: boolean;
}

/**
 * Splits `text` at the protocol's UTF-16 highlight ranges. Ranges are sorted
 * and clamped to the text; one that overlaps an earlier range keeps only its
 * uncovered tail, so a malformed answer never repeats or reorders text.
 */
export function highlightSegments(
  text: string,
  ranges: ReadonlyArray<ChatSearchRange>,
): ReadonlyArray<HighlightSegment> {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const range of sorted) {
    const start = Math.max(cursor, Math.min(range.start, text.length));
    const end = Math.min(range.end, text.length);
    if (end <= start) continue;
    if (start > cursor) {
      segments.push({
        start: cursor,
        text: text.slice(cursor, start),
        highlighted: false,
      });
    }
    segments.push({ start, text: text.slice(start, end), highlighted: true });
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({
      start: cursor,
      text: text.slice(cursor),
      highlighted: false,
    });
  }
  return segments;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const PRESET_SPAN_MS: Readonly<
  Record<Exclude<ChatSearchDatePreset, "any">, number>
> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  year: 365 * DAY_MS,
};

/** The request's `dateRange` for a preset, measured back from `anchorMs`. */
export function chatSearchDateRange(
  preset: ChatSearchDatePreset,
  anchorMs: number,
): ChatSearchDateRange | null {
  if (preset === "any") return null;
  return { from: anchorMs - PRESET_SPAN_MS[preset], to: null };
}

export function formatMatchCount(count: number): string {
  return count === 1 ? "1 match" : `${count} matches`;
}

/** Who wrote a row, in the words the result metadata uses. */
export function chatSearchTierLabel(hit: {
  readonly tier: ChatSearchMessageHit["tier"];
  readonly interAgent: boolean;
}): string {
  switch (hit.tier) {
    case "user":
      return hit.interAgent ? "agent message" : "you";
    case "assistant":
      return "assistant";
    case "notice":
      return "notice";
    case "card":
      return "action";
  }
}

/** The part of a task-list row (`TaskLight`) a task name is read from. */
export interface ChatSearchTitledTask {
  readonly epic?: {
    readonly light: {
      readonly id: string;
      readonly title: string;
      readonly initialUserPrompt: string;
    } | null;
  } | null;
}

/**
 * Task names by epic id from the account's task list, for results whose task
 * this window has not opened. A row with no epic contributes nothing; a listed
 * epic with an empty title gets the same derived name the task list shows.
 */
export function chatSearchTaskTitleIndex(
  tasks: ReadonlyArray<ChatSearchTitledTask>,
): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  for (const task of tasks) {
    const light = task.epic?.light;
    if (light === undefined || light === null) continue;
    titles.set(light.id, epicDisplayTitle(light));
  }
  return titles;
}

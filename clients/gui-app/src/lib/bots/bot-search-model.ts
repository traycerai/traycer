import {
  BOT_CONVERSATION_SEARCH_MAX_QUERY_CHARS,
  type BotConversationSearchHit,
  type BotConversationSearchRequest,
  type BotConversationSearchResponse,
  type BotConversationSearchUnreachable,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { CHAT_SEARCH_BODY_MIN_QUERY_CHARS } from "@/lib/chat-search/chat-search-results";
import type {
  BotSearchDate,
  BotSearchFilters,
  BotSearchScope,
} from "@/stores/bots/bot-search-store";

/** Results per page, per host asked. */
export const BOT_SEARCH_PAGE_SIZE = 20;

/** A request's scope with its filters: everything but where it pages from. */
export type BotSearchBaseRequest = Omit<
  BotConversationSearchRequest,
  "cursor" | "limit"
>;

/** A result's identity on a page: a message is one row wherever it is reached. */
export function botSearchHitKey(hit: BotConversationSearchHit): string {
  return JSON.stringify([hit.botId, hit.threadId, hit.messageId]);
}

/**
 * `text` in lower case, a character at a time, so an offset into the answer is
 * an offset into `text`: a character whose lower case is longer, as İ's is,
 * stays as it is.
 */
export function foldBotSearchText(text: string): string {
  return Array.from(text, (character) => {
    const lower = character.toLowerCase();
    return lower.length === character.length ? lower : character;
  }).join("");
}

/** The words the index matched, as the snippet's highlights name them. */
export function botSearchWordsOf(
  hit: BotConversationSearchHit,
): readonly string[] {
  const words = hit.snippet.highlights.map(({ start, end }) =>
    foldBotSearchText(hit.snippet.text.slice(start, end)),
  );
  return [...new Set(words)].filter((word) => word.length > 0);
}

/** The query as it is sent, within the host's limit; `null` while too short. */
export function botSearchableQuery(query: string): string | null {
  const trimmed = query
    .trim()
    .slice(0, BOT_CONVERSATION_SEARCH_MAX_QUERY_CHARS);
  return trimmed.length < CHAT_SEARCH_BODY_MIN_QUERY_CHARS ? null : trimmed;
}

const DAYS_BACK: Readonly<Record<Exclude<BotSearchDate, "any">, number>> = {
  today: 0,
  "7d": 7,
  "30d": 30,
};

/**
 * Where a date filter starts: a local midnight, so the request, and the
 * results cached under it, hold still through the day.
 */
export function botSearchSince(date: BotSearchDate, now: Date): number | null {
  if (date === "any") return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - DAYS_BACK[date]);
  return start.getTime();
}

export function botSearchBaseRequest(
  query: string,
  scope: BotSearchScope,
  filters: BotSearchFilters,
  now: Date,
): BotSearchBaseRequest {
  return {
    query,
    scope,
    mode: "ranked",
    sort: filters.sort,
    from: filters.from,
    since: botSearchSince(filters.date, now),
    where: filters.where,
  };
}

/** One host's place in a search: who is asked, for what, and from where. */
export interface BotSearchSource {
  /** A host named directly; `null` for the host serving the tab. */
  readonly hostId: string | null;
  readonly scope: BotConversationSearchRequest["scope"];
  /** Its next page; `null` before its first and past its last. */
  readonly cursor: string | null;
  readonly started: boolean;
  /** Its hits fetched and not on a page yet, best first. */
  readonly pending: ReadonlyArray<BotConversationSearchHit>;
}

/** One page of a search, from every host it reached. */
export interface BotSearchPage {
  readonly hits: ReadonlyArray<BotConversationSearchHit>;
  /** Where the next page starts; empty when none is left. */
  readonly next: ReadonlyArray<BotSearchSource>;
  readonly indexState: BotConversationSearchResponse["indexState"];
  /** The hits every host counted; `null` while one has not counted its own. */
  readonly total: number | null;
  readonly unreachable: ReadonlyArray<BotConversationSearchUnreachable>;
}

/**
 * Where a search starts: a bot's own host where this client can reach it,
 * which holds the index and serves a bot the tab's host cannot dial; else the
 * tab's host, which reaches every other bot itself.
 */
export function botSearchFirstSource(
  scope: BotSearchScope,
  reachableHostOf: (botId: string) => string | null,
): BotSearchSource {
  return {
    hostId: scope.kind === "bot" ? reachableHostOf(scope.botId) : null,
    scope,
    cursor: null,
    started: false,
    pending: [],
  };
}

/** What one source answered; `null` from a host asked directly that failed. */
interface BotSearchAnswer {
  readonly source: BotSearchSource;
  readonly answer: BotConversationSearchResponse | null;
}

function reportedUnreachable(
  answer: BotSearchAnswer,
): ReadonlyArray<BotConversationSearchUnreachable> {
  return answer.answer?.unreachable ?? [];
}

function unreachableOf(
  source: BotSearchSource,
  error: HostRpcError,
): ReadonlyArray<BotConversationSearchUnreachable> {
  if (source.scope.kind !== "bot") return [];
  return [
    {
      botId: source.scope.botId,
      reason: error.code === "E_HOST_UNSUPPORTED" ? "unsupported" : "offline",
    },
  ];
}

/**
 * A page of the sources' hits by rank, each asked for its next page once it
 * runs short, and what it has left carried to the page after, so the list
 * stays in rank order across pages and hosts. The tab's host cannot dial a host under
 * another owner and says so (`other-owner`), so a team's bot searched from a
 * person's host, or theirs from a team's, is asked of directly where this
 * client reaches it, and joins as a source. A host asked directly that does
 * not answer its first page costs its bot, named in `unreachable`. Every other
 * failure fails the page: the tab's host, any host on a later page, whose hits
 * are already on screen and which a retry can go on from, and a host that
 * refuses the request, which did answer. A cursor its host no longer holds is
 * one of these, and the search starts again.
 */
export async function fetchBotSearchPage(input: {
  readonly sources: ReadonlyArray<BotSearchSource>;
  readonly sort: BotConversationSearchRequest["sort"];
  readonly ask: (
    source: BotSearchSource,
  ) => Promise<BotConversationSearchResponse>;
  readonly reachableHostOf: (botId: string) => string | null;
}): Promise<BotSearchPage> {
  const { sources, sort, ask, reachableHostOf } = input;
  const firstPage = sources.every((source) => !source.started);
  const unreachable: Array<BotConversationSearchUnreachable> = [];
  const askOne = (source: BotSearchSource): Promise<BotSearchAnswer> =>
    ask(source).then(
      (answer) => ({ source, answer }),
      (error: HostRpcError) => {
        if (
          source.hostId === null ||
          source.cursor !== null ||
          error.code === "E_INVALID_ARGUMENT"
        ) {
          throw error;
        }
        unreachable.push(...unreachableOf(source, error));
        return { source, answer: null };
      },
    );
  // A source with hits on hand is not asked: its next page waits for them.
  const first = await Promise.all(sources.map(answerOf(askOne)));
  const followUps: BotSearchSource[] = [];
  for (const entry of first.flatMap(reportedUnreachable)) {
    const hostId =
      entry.reason === "other-owner" ? reachableHostOf(entry.botId) : null;
    if (hostId === null) {
      unreachable.push(entry);
    } else if (firstPage) {
      followUps.push({
        hostId,
        scope: { kind: "bot", botId: entry.botId },
        cursor: null,
        started: false,
        pending: [],
      });
    }
  }
  const followed = await Promise.all(followUps.map(askOne));
  unreachable.push(...followed.flatMap(reportedUnreachable));
  const answers = [...first, ...followed];
  const totals = answers.map(({ answer }) => answer?.total ?? null);
  const streams = answers.map(streamOf);
  const taken = merged(streams, sort);
  return {
    hits: taken.hits,
    next: streams.flatMap((stream, index) => {
      const pending = stream.hits.slice(taken.counts[index]);
      return pending.length === 0 && stream.cursor === null
        ? []
        : [
            {
              ...stream.source,
              cursor: stream.cursor,
              started: true,
              pending,
            },
          ];
    }),
    indexState: answers.some(({ answer }) => answer?.indexState === "partial")
      ? "partial"
      : "complete",
    total: totals.includes(null)
      ? null
      : totals.reduce<number>((sum, total) => sum + (total ?? 0), 0),
    unreachable,
  };
}

/** Asks a source that is short of a page, and passes over one that is not. */
function answerOf(
  askOne: (source: BotSearchSource) => Promise<BotSearchAnswer>,
): (source: BotSearchSource) => Promise<BotSearchAnswer> {
  return (source) =>
    !source.started ||
    (source.cursor !== null && source.pending.length < BOT_SEARCH_PAGE_SIZE)
      ? askOne(source)
      : Promise.resolve({
          source,
          answer: {
            hits: [],
            nextCursor: source.cursor,
            indexState: "complete",
            total: 0,
            unreachable: [],
          },
        });
}

/** One source's hits on hand, best first, and its page past them. */
interface BotSearchStream {
  readonly source: BotSearchSource;
  readonly hits: ReadonlyArray<BotConversationSearchHit>;
  readonly cursor: string | null;
}

function streamOf({ source, answer }: BotSearchAnswer): BotSearchStream {
  return {
    source,
    hits: [...source.pending, ...(answer?.hits ?? [])],
    cursor: answer === null ? null : answer.nextCursor,
  };
}

function rankOf(
  hit: BotConversationSearchHit,
  sort: BotConversationSearchRequest["sort"],
): number {
  return sort === "newest" ? hit.createdAt : hit.score;
}

/**
 * A page of the streams' best hits. Each stream is best first, and a hit is
 * only known to outrank a stream with a page to come while that stream has a
 * hit to compare, so a page stops where one runs out; the next page asks it.
 */
function merged(
  streams: ReadonlyArray<BotSearchStream>,
  sort: BotConversationSearchRequest["sort"],
): {
  readonly hits: ReadonlyArray<BotConversationSearchHit>;
  readonly counts: ReadonlyArray<number>;
} {
  const counts = streams.map(() => 0);
  const hits: BotConversationSearchHit[] = [];
  while (hits.length < BOT_SEARCH_PAGE_SIZE) {
    let best: number | null = null;
    for (const [index, stream] of streams.entries()) {
      const head = stream.hits.at(counts[index]);
      if (head === undefined) {
        if (stream.cursor !== null) return { hits, counts };
      } else if (
        best === null ||
        rankOf(head, sort) > rankOf(streams[best].hits[counts[best]], sort)
      ) {
        best = index;
      }
    }
    if (best === null) break;
    hits.push(streams[best].hits[counts[best]]);
    counts[best] += 1;
  }
  return { hits, counts };
}

/** The bots no page reached, each once. */
export function botSearchUnreachableOf(
  pages: ReadonlyArray<BotSearchPage>,
): ReadonlyArray<BotConversationSearchUnreachable> {
  const byBot = new Map(
    pages
      .flatMap((page) => page.unreachable)
      .map((entry) => [entry.botId, entry]),
  );
  return [...byBot.values()];
}

/** The pages on screen, as one list; a row an index move repeated shows once. */
export function botSearchHitsOf(
  pages: ReadonlyArray<BotSearchPage>,
): ReadonlyArray<BotConversationSearchHit> {
  const seen = new Set<string>();
  return pages
    .flatMap((page) => page.hits)
    .filter((hit) => {
      const key = botSearchHitKey(hit);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

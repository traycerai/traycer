import type {
  BotOpenThread,
  BotRail,
} from "@/stores/bots/bot-open-thread-store";

/** One of a channel's two views. */
export type TracyChannelView = "messages" | "activity";

export function isTracyChannelView(value: unknown): value is TracyChannelView {
  return value === "messages" || value === "activity";
}

/**
 * The thread a place names: what picks the panel and its box. The post a send
 * was accepted with (`BotOpenThread.sent`) is not part of a place: it is drawn
 * only until the lists catch up, and a place outlives that.
 */
export interface TracyPlaceThread {
  readonly anchorMessageId: string;
  readonly announcement: boolean;
  readonly anchorKind: string | null;
}

/** One of the bot's sessions shown in place of its channel. */
export interface TracyPlaceSession {
  readonly chatId: string;
  readonly threadId: string | null;
}

/**
 * Where a person is inside one bot's channel on the Tracy surface: what back
 * and forward step between. A search is not part of it: its results are a
 * tool over the place, and a thread one of them opened is the place's thread.
 *
 * `exchangePeerBotId` is the pair's log open in the rail, over the memory
 * (`memory`) or the thread (`thread`) it displaced; `memory` likewise sits
 * over `thread`.
 */
export interface TracyPlace {
  readonly view: TracyChannelView;
  /** Threads, from the column, shows in place of the channel. */
  readonly threadsShown: boolean;
  readonly session: TracyPlaceSession | null;
  readonly thread: TracyPlaceThread | null;
  readonly memory: boolean;
  readonly exchangePeerBotId: string | null;
}

/**
 * A place as `/bot` and `/bot/{botId}` carry it in their search. Every key is
 * optional, so an opener that names the channel alone passes no search.
 */
export interface TracyPlaceSearch {
  readonly view?: TracyChannelView;
  readonly threads?: true;
  readonly session?: string;
  readonly sessionThread?: string;
  readonly thread?: string;
  readonly threadAnnouncement?: true;
  readonly threadAnchor?: string;
  readonly memory?: true;
  readonly exchange?: string;
}

function stringOf(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function flagOf(raw: unknown): true | undefined {
  return raw === true ? true : undefined;
}

/** The route's `validateSearch`: every key it does not know is dropped. */
export function normalizeTracyPlaceSearch(
  search: Record<string, unknown>,
): TracyPlaceSearch {
  return {
    view: isTracyChannelView(search.view) ? search.view : undefined,
    threads: flagOf(search.threads),
    session: stringOf(search.session),
    sessionThread: stringOf(search.sessionThread),
    thread: stringOf(search.thread),
    threadAnnouncement: flagOf(search.threadAnnouncement),
    threadAnchor: stringOf(search.threadAnchor),
    memory: flagOf(search.memory),
    exchange: stringOf(search.exchange),
  };
}

/**
 * The place a location's search names, or `null` when it names none: an
 * entry written before places were recorded, or one an opener made for the
 * channel alone. `view` is what says a place is there, so every place written
 * carries it.
 */
export function tracyPlaceOfSearch(
  raw: Readonly<Record<string, unknown>> | TracyPlaceSearch,
): TracyPlace | null {
  const search = normalizeTracyPlaceSearch({ ...raw });
  if (search.view === undefined) return null;
  return {
    view: search.view,
    threadsShown: search.threads === true,
    session:
      search.session === undefined
        ? null
        : { chatId: search.session, threadId: search.sessionThread ?? null },
    thread:
      search.thread === undefined
        ? null
        : {
            anchorMessageId: search.thread,
            announcement: search.threadAnnouncement === true,
            anchorKind: search.threadAnchor ?? null,
          },
    memory: search.memory === true,
    exchangePeerBotId: search.exchange ?? null,
  };
}

export function tracyPlaceSearch(place: TracyPlace): TracyPlaceSearch {
  return {
    view: place.view,
    threads: place.threadsShown ? true : undefined,
    session: place.session?.chatId,
    sessionThread: place.session?.threadId ?? undefined,
    thread: place.thread?.anchorMessageId,
    threadAnnouncement: place.thread?.announcement === true ? true : undefined,
    threadAnchor: place.thread?.anchorKind ?? undefined,
    memory: place.memory ? true : undefined,
    exchange: place.exchangePeerBotId ?? undefined,
  };
}

/** One string per place: two places are the same place when theirs match. */
export function tracyPlaceKey(place: TracyPlace): string {
  return JSON.stringify([
    place.view,
    place.threadsShown,
    place.session?.chatId ?? null,
    place.session?.threadId ?? null,
    place.thread?.anchorMessageId ?? null,
    place.thread?.announcement ?? false,
    place.thread?.anchorKind ?? null,
    place.memory,
    place.exchangePeerBotId,
  ]);
}

function placeThreadOf(thread: BotOpenThread): TracyPlaceThread {
  return {
    anchorMessageId: thread.anchorMessageId,
    announcement: thread.announcement,
    anchorKind: thread.anchorKind,
  };
}

/** What a rail contributes to a place: its thread, memory and pair's log. */
export interface TracyPlaceRail {
  readonly thread: TracyPlaceThread | null;
  readonly memory: boolean;
  readonly exchangePeerBotId: string | null;
}

const EMPTY_PLACE_RAIL: TracyPlaceRail = {
  thread: null,
  memory: false,
  exchangePeerBotId: null,
};

/**
 * The rail as a place has it. A search contributes the thread one of its
 * results opened, else what it displaced: its results are not a place.
 */
export function tracyPlaceRailOf(rail: BotRail | null): TracyPlaceRail {
  if (rail === null) return EMPTY_PLACE_RAIL;
  switch (rail.kind) {
    case "thread":
      return { ...EMPTY_PLACE_RAIL, thread: placeThreadOf(rail) };
    case "memory":
      return {
        thread: rail.back === null ? null : placeThreadOf(rail.back),
        memory: true,
        exchangePeerBotId: null,
      };
    case "exchange":
      return {
        ...tracyPlaceRailOf(rail.back),
        exchangePeerBotId: rail.peerBotId,
      };
    case "search":
      return rail.showing.kind === "thread"
        ? { ...EMPTY_PLACE_RAIL, thread: placeThreadOf(rail.showing.thread) }
        : tracyPlaceRailOf(rail.back);
  }
}

/** The thread `rail` holds open or behind another panel, by its anchor. */
function heldThreadOf(
  rail: BotRail | null,
  anchorMessageId: string,
): BotOpenThread | null {
  if (rail === null) return null;
  switch (rail.kind) {
    case "thread":
      return rail.anchorMessageId === anchorMessageId ? rail : null;
    case "memory":
      return rail.back?.anchorMessageId === anchorMessageId ? rail.back : null;
    case "exchange":
      return heldThreadOf(rail.back, anchorMessageId);
    case "search":
      return rail.showing.kind === "thread" &&
        rail.showing.thread.anchorMessageId === anchorMessageId
        ? rail.showing.thread
        : heldThreadOf(rail.back, anchorMessageId);
  }
}

/**
 * The rail a place names, built over `current`: a thread the rail already
 * holds keeps the post its send was accepted with, and any other opens as
 * the lists have it.
 */
export function railOfTracyPlace(
  place: TracyPlaceRail,
  current: BotRail | null,
): BotRail | null {
  const thread: BotOpenThread | null =
    place.thread === null
      ? null
      : {
          ...place.thread,
          sent:
            heldThreadOf(current, place.thread.anchorMessageId)?.sent ?? null,
        };
  const under = underExchangeOf(place.memory, thread);
  return place.exchangePeerBotId === null
    ? under
    : { kind: "exchange", peerBotId: place.exchangePeerBotId, back: under };
}

function underExchangeOf(
  memory: boolean,
  thread: BotOpenThread | null,
): BotRail | null {
  if (memory) return { kind: "memory", back: thread };
  return thread === null ? null : { kind: "thread", ...thread };
}

export function tracyPlaceRailKey(rail: TracyPlaceRail): string {
  return JSON.stringify([
    rail.thread?.anchorMessageId ?? null,
    rail.thread?.announcement ?? false,
    rail.thread?.anchorKind ?? null,
    rail.memory,
    rail.exchangePeerBotId,
  ]);
}

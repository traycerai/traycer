import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import type { BotConversationSearchHit } from "@traycer/protocol/host/bot/conversation-schemas";
import {
  basePersistOptions,
  installCrossWindowRehydrate,
  persistKey,
  STORE_KEYS,
} from "@/lib/persist";
import {
  searchRailOver,
  useBotOpenThreadStore,
  type BotRail,
} from "@/stores/bots/bot-open-thread-store";
import { botSearchHitKey, botSearchWordsOf } from "@/lib/bots/bot-search-model";

export const BOT_SEARCH_RECENTS_LIMIT = 10;

/** One bot's channel and threads, or every bot's. */
export type BotSearchScope =
  | { readonly kind: "all" }
  | { readonly kind: "bot"; readonly botId: string };

export type BotSearchFrom =
  | "anyone"
  | "bot"
  | "me"
  | { readonly userId: string };
export type BotSearchDate = "any" | "today" | "7d" | "30d";
export type BotSearchWhere = "both" | "posts" | "threads";
export type BotSearchSort = "relevance" | "newest";

export interface BotSearchFilters {
  readonly from: BotSearchFrom;
  readonly date: BotSearchDate;
  readonly where: BotSearchWhere;
  readonly sort: BotSearchSort;
}

export const BOT_SEARCH_NO_FILTERS: BotSearchFilters = {
  from: "anyone",
  date: "any",
  where: "both",
  sort: "relevance",
};

/** A search run, as the list before typing offers it again. */
export interface BotSearchRecent {
  readonly query: string;
  readonly scope: BotSearchScope;
  /** The bot's title when it ran; `null` for all bots. */
  readonly scopeTitle: string | null;
}

/** A result on its way to the channel or thread it is in. */
export interface BotSearchJump {
  readonly botId: string;
  readonly threadId: string | null;
  readonly messageId: string;
}

/** The reply a result opened its thread at, by the post the thread hangs off. */
export interface BotSearchThreadLanding {
  readonly botId: string;
  readonly postId: string;
  readonly landing: {
    readonly messageId: string;
    readonly sendPostId: null;
    readonly visit: number;
  };
}

/** The words of a result to mark in the transcript that shows it. */
export interface BotSearchMarks {
  readonly chatId: string;
  readonly messageId: string;
  readonly words: readonly string[];
}

interface BotSearchState {
  readonly scope: BotSearchScope;
  readonly query: string;
  readonly filters: BotSearchFilters;
  /** The list's scroll while something else has the rail. */
  readonly scrollTop: number;
  /** The result ↑/↓ last reached or a click opened. */
  readonly selectedKey: string | null;
  /** How many times the panel was asked for; the surface shows Messages for each. */
  readonly opens: number;
  /** The newest request for the input's focus, and the one it has answered. */
  readonly focusAsked: number;
  readonly focusAnswered: number;
  readonly jump: BotSearchJump | null;
  readonly threadLanding: BotSearchThreadLanding | null;
  readonly marks: BotSearchMarks | null;
  /** A result whose thread the channel could not find. */
  readonly missedKey: string | null;
  readonly recents: ReadonlyArray<BotSearchRecent>;
  readonly present: (
    scope: BotSearchScope,
    query: string | null,
    fresh: boolean,
  ) => void;
  readonly setQuery: (query: string) => void;
  readonly setScope: (scope: BotSearchScope) => void;
  readonly setFilters: (filters: Partial<BotSearchFilters>) => void;
  readonly clearFilters: () => void;
  readonly setScrollTop: (scrollTop: number) => void;
  readonly reset: () => void;
  readonly answerFocus: () => void;
  readonly jumpTo: (hit: BotConversationSearchHit, keepFocus: boolean) => void;
  readonly spendJump: () => void;
  /** Spends the jump on the thread hanging off `postId`. */
  readonly landThread: (postId: string, jump: BotSearchJump) => void;
  readonly missThread: () => void;
  readonly clearMarks: () => void;
  readonly remember: (recent: BotSearchRecent) => void;
}

const SESSION = {
  scope: { kind: "all" },
  query: "",
  filters: BOT_SEARCH_NO_FILTERS,
  scrollTop: 0,
  selectedKey: null,
  jump: null,
  threadLanding: null,
  marks: null,
  missedKey: null,
} as const;

const BOT_SEARCH_RECENTS_PERSIST_KEY = persistKey(STORE_KEYS.botSearchRecents);

const persistedRecentsSchema = z.object({
  recents: z
    .array(
      z.object({
        query: z.string(),
        scope: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("all") }),
          z.object({ kind: z.literal("bot"), botId: z.string() }),
        ]),
        scopeTitle: z.string().nullable(),
      }),
    )
    .max(BOT_SEARCH_RECENTS_LIMIT),
});

function sameScope(left: BotSearchScope, right: BotSearchScope): boolean {
  return left.kind === "bot"
    ? right.kind === "bot" && left.botId === right.botId
    : right.kind === "all";
}

/**
 * The search of the Tracy surface: one at a time, held above the channels so
 * it outlives the move to another bot a result can make, and kept while a
 * thread or the channel takes the rail, for the way back. Closing the panel
 * drops it. Only the recent searches are kept across a restart, one list per
 * device, each with the scope it ran in.
 */
export const useBotSearchStore = create<BotSearchState>()(
  persist(
    (set) => ({
      ...SESSION,
      opens: 0,
      focusAsked: 0,
      focusAnswered: 0,
      recents: [],
      present: (scope, query, fresh) =>
        set((state) => ({
          ...(fresh ? SESSION : null),
          scope,
          query: query ?? (fresh ? "" : state.query),
          opens: state.opens + 1,
          focusAsked: state.focusAsked + 1,
        })),
      setQuery: (query) =>
        set({ query, selectedKey: null, scrollTop: 0, missedKey: null }),
      setScope: (scope) =>
        set({ scope, selectedKey: null, scrollTop: 0, missedKey: null }),
      setFilters: (filters) =>
        set((state) => ({
          filters: { ...state.filters, ...filters },
          selectedKey: null,
          scrollTop: 0,
          missedKey: null,
        })),
      clearFilters: () =>
        set({
          filters: BOT_SEARCH_NO_FILTERS,
          selectedKey: null,
          scrollTop: 0,
          missedKey: null,
        }),
      setScrollTop: (scrollTop) => set({ scrollTop }),
      reset: () => set(SESSION),
      answerFocus: () => set((state) => ({ focusAnswered: state.focusAsked })),
      jumpTo: (hit, keepFocus) =>
        set((state) => ({
          selectedKey: botSearchHitKey(hit),
          missedKey: null,
          jump: {
            botId: hit.botId,
            threadId: hit.threadId,
            messageId: hit.messageId,
          },
          marks: {
            chatId: hit.threadId ?? hit.conversationId,
            messageId: hit.messageId,
            words: botSearchWordsOf(hit),
          },
          focusAsked: state.focusAsked + (keepFocus ? 1 : 0),
        })),
      spendJump: () => set({ jump: null }),
      landThread: (postId, jump) =>
        set((state) => ({
          jump: null,
          threadLanding: {
            botId: jump.botId,
            postId,
            landing: {
              messageId: jump.messageId,
              sendPostId: null,
              visit: (state.threadLanding?.landing.visit ?? 0) + 1,
            },
          },
        })),
      missThread: () =>
        set((state) => ({
          jump: null,
          marks: null,
          missedKey: state.selectedKey,
        })),
      clearMarks: () => set({ marks: null }),
      remember: (recent) =>
        set((state) => ({
          recents: [
            recent,
            ...state.recents.filter(
              (entry) =>
                entry.query !== recent.query ||
                !sameScope(entry.scope, recent.scope),
            ),
          ].slice(0, BOT_SEARCH_RECENTS_LIMIT),
        })),
    }),
    {
      ...basePersistOptions(BOT_SEARCH_RECENTS_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ recents: state.recents }),
      // A record from another build, or hand-edited storage, reads as none.
      merge: (persistedState, currentState) => {
        const parsed = persistedRecentsSchema.safeParse(persistedState);
        return {
          ...currentState,
          recents: parsed.success ? parsed.data.recents : [],
        };
      },
    },
  ),
);

/** A search run in another window reaches this one's list live. */
installCrossWindowRehydrate(useBotSearchStore, BOT_SEARCH_RECENTS_PERSIST_KEY);

function railOf(botId: string): BotRail | null {
  const { byBotId } = useBotOpenThreadStore.getState();
  return Object.hasOwn(byBotId, botId) ? byBotId[botId] : null;
}

/**
 * Opens the search panel in `botId`'s rail, over whatever it holds, on
 * `scope`. A search already there stays with its query and filters unless
 * `query` names another; a new one starts empty.
 */
export function openBotSearch(
  botId: string,
  scope: BotSearchScope,
  query: string | null,
): void {
  const rail = railOf(botId);
  useBotSearchStore.getState().present(scope, query, rail?.kind !== "search");
  useBotOpenThreadStore.getState().setRail(botId, searchRailOver(rail));
}

/** Closes the panel and drops its search: the thread it displaced comes back. */
export function closeBotSearch(botId: string): void {
  const rail = railOf(botId);
  const back = rail?.kind === "search" ? rail.back : null;
  useBotOpenThreadStore
    .getState()
    .setRail(botId, back === null ? null : { kind: "thread", ...back });
  useBotSearchStore.getState().reset();
}

/** The results again, where a result's thread or the channel took their place. */
export function showBotSearchResults(botId: string): void {
  const rail = railOf(botId);
  if (rail?.kind !== "search") return;
  useBotOpenThreadStore
    .getState()
    .setRail(botId, { ...rail, showing: { kind: "results" } });
}

/**
 * Sends a result to the channel that shows it. `fromBotId` is the channel the
 * search is open on: a result in another bot moves the rail there with it, so
 * the results are beside the channel the person is taken to. Says whether the
 * surface has to change channel.
 */
export function jumpToBotSearchHit(
  fromBotId: string,
  hit: BotConversationSearchHit,
  keepFocus: boolean,
): boolean {
  useBotSearchStore.getState().jumpTo(hit, keepFocus);
  if (hit.botId === fromBotId) return false;
  const rail = railOf(fromBotId);
  const back = rail?.kind === "search" ? rail.back : null;
  const { setRail } = useBotOpenThreadStore.getState();
  setRail(fromBotId, back === null ? null : { kind: "thread", ...back });
  setRail(hit.botId, searchRailOver(null));
  return true;
}

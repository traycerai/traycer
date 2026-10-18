import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/**
 * The source store behind `kind: "bot"` tabs (Tracy Bots).
 *
 * A bot tab is bound to ONE host for its whole life - the host the bot was
 * bound to when the tab opened - exactly as a chat tab is bound to its tile's
 * host. That binding has to live somewhere a strip ref can be resolved from
 * (`tabSourceRefs`, `useHeaderTabForRef`, hydration), and a `TabRef` carries
 * only `{kind, id}`, so this store holds the record: bot id, host id, and the
 * title the strip shows. Opening the same bot again finds the existing record
 * (and its host) rather than minting a second tab.
 *
 * Only `hostId` is a binding. The title is a cache of the cloud row's title
 * for the strip, refreshed by whichever surface reads the row (the tab's own
 * `bot.subscribe` snapshot); it is never the authority on the bot's name.
 *
 * Persisted per window in localStorage, so a restart restores the tab bound
 * to the same host. A bot that no longer exists is found out by the tab's
 * own stream (`deleted`), which closes the tab; nothing here probes for it.
 */
export interface BotTabRecord {
  readonly botId: string;
  readonly hostId: string;
  readonly title: string;
  /** Strip order among bot tabs on a restore; the layout owns live order. */
  readonly openedAt: number;
}

interface BotTabsState {
  readonly tabs: Readonly<Record<string, BotTabRecord>>;
  /**
   * Opens a tab for `botId` bound to `hostId`, or keeps the existing one. The
   * existing record's host WINS: a tab's binding is for life, and a second
   * open naming another host is a request to view the bot through a tab that
   * already exists, not to rebind it (that is `bot.claimAuthority`'s job, and
   * it goes through `rebindBotTab`).
   */
  readonly openBotTab: (record: {
    readonly botId: string;
    readonly hostId: string;
    readonly title: string;
  }) => void;
  readonly closeBotTab: (botId: string) => void;
  readonly setBotTabTitle: (botId: string, title: string) => void;
  /**
   * The ONE way a tab's host moves: after `bot.claimAuthority` succeeded on
   * `hostId`, the bot now lives there and a tab bound to the previous host
   * would be bound to a machine that refuses its chats. The tab keeps its
   * strip slot and re-keys its surface on the new host.
   */
  readonly rebindBotTab: (botId: string, hostId: string) => void;
}

const BOT_TABS_PERSIST_KEY = persistKey(STORE_KEYS.botTabs);

export const useBotTabsStore = create<BotTabsState>()(
  persist(
    (set, get) => ({
      tabs: {},
      openBotTab: (record) => {
        const existing = lookupBotTab(get().tabs, record.botId);
        if (existing !== null) {
          if (existing.title === record.title) return;
          set({
            tabs: {
              ...get().tabs,
              [record.botId]: { ...existing, title: record.title },
            },
          });
          return;
        }
        set({
          tabs: {
            ...get().tabs,
            [record.botId]: { ...record, openedAt: Date.now() },
          },
        });
      },
      closeBotTab: (botId) => {
        if (lookupBotTab(get().tabs, botId) === null) return;
        const next = { ...get().tabs };
        delete next[botId];
        set({ tabs: next });
      },
      setBotTabTitle: (botId, title) => {
        const existing = lookupBotTab(get().tabs, botId);
        if (existing === null || existing.title === title) return;
        set({ tabs: { ...get().tabs, [botId]: { ...existing, title } } });
      },
      rebindBotTab: (botId, hostId) => {
        const existing = lookupBotTab(get().tabs, botId);
        if (existing === null || existing.hostId === hostId) return;
        set({ tabs: { ...get().tabs, [botId]: { ...existing, hostId } } });
      },
    }),
    {
      ...basePersistOptions(BOT_TABS_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ tabs: state.tabs }),
    },
  ),
);

/**
 * The record for `botId`, or `null`. An own-property check rather than an
 * index read: the tabs record is typed by its values, so a bare index reads
 * as always present, and a missing bot has to be asked for by key.
 */
export function lookupBotTab(
  tabs: Readonly<Record<string, BotTabRecord>>,
  botId: string,
): BotTabRecord | null {
  return Object.hasOwn(tabs, botId) ? tabs[botId] : null;
}

/** Every open bot tab, oldest first - the order a restore places them in. */
export function botTabRecords(
  tabs: Readonly<Record<string, BotTabRecord>>,
): ReadonlyArray<BotTabRecord> {
  return Object.values(tabs).sort((a, b) => a.openedAt - b.openedAt);
}

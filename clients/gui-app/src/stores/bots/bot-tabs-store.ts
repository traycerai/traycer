import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { useBotSurfaceActionsStore } from "@/stores/bots/bot-surface-actions-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useMobileTabOriginStore } from "@/stores/epics/mobile-tab-origin-store";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

/**
 * The source store behind `kind: "bot"` tabs (Tracy Bots).
 *
 * A bot tab is bound to ONE host at a time - the host that serves the bot,
 * as `bot.open` answered it - and reads everything through that host, as a
 * chat tab reads through its tile's host. That binding has to live somewhere a strip ref can be resolved from
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
   * The bot whose tab is the fixed Tracy entry: the personal main bot, drawn
   * beside Home, kept first in the strip and never closed or moved. `null`
   * with "Show Tracy" off or before the bot is known. Persisted with the
   * records so a restart draws the entry in place from the first frame.
   */
  readonly fixedBotId: string | null;
  readonly setFixedBotId: (botId: string | null) => void;
  /**
   * Opens a tab for `botId` bound to `hostId`, or keeps the existing one. The
   * existing record's host WINS: a tab's binding is for life, and a second
   * open naming another host is a request to view the bot through a tab that
   * already exists, not to rebind it (the tab's own `bot.open` does that,
   * through `rebindBotTab`).
   */
  readonly openBotTab: (record: {
    readonly botId: string;
    readonly hostId: string;
    readonly title: string;
  }) => void;
  readonly closeBotTab: (botId: string) => void;
  readonly setBotTabTitle: (botId: string, title: string) => void;
  /**
   * The ONE way a tab's host moves: `bot.open` answered that `hostId` serves
   * the bot (a tab bound elsewhere would read chats that host does not
   * serve), or Home reopened a tab whose host this client can no longer
   * dial. The tab keeps its strip slot and re-keys its surface on the new
   * host.
   */
  readonly rebindBotTab: (botId: string, hostId: string) => void;
}

const BOT_TABS_PERSIST_KEY = persistKey(STORE_KEYS.botTabs);

export const useBotTabsStore = create<BotTabsState>()(
  persist(
    (set, get) => ({
      tabs: {},
      fixedBotId: null,
      setFixedBotId: (botId) => {
        if (get().fixedBotId === botId) return;
        set({ fixedBotId: botId });
      },
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
        // Every close comes through here: a reopened tab starts with nothing
        // in its rail and no unsent drafts, and nothing follows the closed
        // one's session.
        useBotOpenThreadStore.getState().setRail(botId, null);
        useBotDraftsStore.getState().forgetBot(botId);
        useBotSurfaceActionsStore.getState().forgetBot(botId);
        useMobileTabOriginStore.getState().forgetBot(botId);
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
      partialize: (state) => ({
        tabs: state.tabs,
        fixedBotId: state.fixedBotId,
      }),
    },
  ),
);

// A build without bots (`unreleased-features.ts`) mounts no Tracy entry
// controller, which is what turns the setting off and releases the entry's
// locks. A pin a previous build persisted is released here instead, so the
// restored tab is an ordinary, closable one.
if (
  !UNRELEASED_FEATURES_ENABLED &&
  useBotTabsStore.getState().fixedBotId !== null
)
  useBotTabsStore.getState().setFixedBotId(null);

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

/**
 * Before a bot's tab is opened again from a list or a fixed entry: an open
 * tab keeps its host unless this client can no longer dial it (a restored
 * tab, a host gone since), and then it moves to `hostId`, this window's host,
 * which finds the one serving the bot. `isConnectable` is `null` while the
 * directory has not answered, which says nothing about the tab's host, so
 * the tab keeps it.
 */
export function rebindUnreachableBotTab(
  botId: string,
  hostId: string,
  isConnectable: ((hostId: string) => boolean) | null,
): void {
  const state = useBotTabsStore.getState();
  const existing = lookupBotTab(state.tabs, botId);
  if (existing !== null && isConnectable !== null) {
    if (!isConnectable(existing.hostId)) state.rebindBotTab(botId, hostId);
  }
}

/** Every open bot tab, oldest first - the order a restore places them in. */
export function botTabRecords(
  tabs: Readonly<Record<string, BotTabRecord>>,
): ReadonlyArray<BotTabRecord> {
  return Object.values(tabs).sort((a, b) => a.openedAt - b.openedAt);
}

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  basePersistOptions,
  installCrossWindowRehydrate,
  persistKey,
  STORE_KEYS,
} from "@/lib/persist";
import type { HomeBotsModel } from "@/lib/home-bots/bots-model";

/**
 * How the person arranged the channel column (Tracy Bots, decision 151): the
 * sections' order, each section's channels' order, and the sections put
 * away. One arrangement per device, shared by every bot tab, window and
 * Home's bots section; `arrangeBotsModel` reads the two orders.
 *
 * Every write takes the model the person arranged and keeps only the ids it
 * carries, so an environment the person left or a bot that was archived is
 * dropped the next time anything is moved or collapsed.
 */
export interface BotColumnLayoutState {
  /** Environment ids. */
  readonly sectionOrder: ReadonlyArray<string>;
  /** Bot ids, by environment id. */
  readonly channelOrder: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Environment ids. */
  readonly collapsed: ReadonlyArray<string>;
  /** The full order of the sections, as the column shows it after a drop. */
  readonly setSectionOrder: (
    order: ReadonlyArray<string>,
    model: HomeBotsModel,
  ) => void;
  /** The full order of one section's channels, as it shows after a drop. */
  readonly setChannelOrder: (
    environmentId: string,
    order: ReadonlyArray<string>,
    model: HomeBotsModel,
  ) => void;
  readonly setCollapsed: (
    environmentId: string,
    collapsed: boolean,
    model: HomeBotsModel,
  ) => void;
}

type BotColumnLayout = Pick<
  BotColumnLayoutState,
  "sectionOrder" | "channelOrder" | "collapsed"
>;

const BOT_COLUMN_LAYOUT_PERSIST_KEY = persistKey(STORE_KEYS.botColumnLayout);

const EMPTY_LAYOUT: BotColumnLayout = {
  sectionOrder: [],
  channelOrder: {},
  collapsed: [],
};

/** The layout with every id the model does not carry dropped. */
function pruneLayout(
  layout: BotColumnLayout,
  model: HomeBotsModel,
): BotColumnLayout {
  const botIdsByEnvironment = new Map(
    model.groups.map((group) => [
      group.environmentId,
      new Set(group.bots.map((bot) => bot.botId)),
    ]),
  );
  const channelOrder: Record<string, ReadonlyArray<string>> = {};
  for (const [environmentId, order] of Object.entries(layout.channelOrder)) {
    const botIds = botIdsByEnvironment.get(environmentId);
    if (botIds === undefined) continue;
    const kept = order.filter((botId) => botIds.has(botId));
    if (kept.length > 0) channelOrder[environmentId] = kept;
  }
  return {
    sectionOrder: layout.sectionOrder.filter((id) =>
      botIdsByEnvironment.has(id),
    ),
    channelOrder,
    collapsed: layout.collapsed.filter((id) => botIdsByEnvironment.has(id)),
  };
}

function stringList(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** A persisted record of any shape read as a layout; what is malformed is empty. */
function persistedLayout(persistedState: unknown): BotColumnLayout {
  if (persistedState === null || typeof persistedState !== "object") {
    return EMPTY_LAYOUT;
  }
  const channelOrder: Record<string, ReadonlyArray<string>> = {};
  const rawChannelOrder: unknown = Reflect.get(persistedState, "channelOrder");
  if (rawChannelOrder !== null && typeof rawChannelOrder === "object") {
    for (const [environmentId, order] of Object.entries(rawChannelOrder)) {
      channelOrder[environmentId] = stringList(order);
    }
  }
  return {
    sectionOrder: stringList(Reflect.get(persistedState, "sectionOrder")),
    channelOrder,
    collapsed: stringList(Reflect.get(persistedState, "collapsed")),
  };
}

export const useBotColumnLayoutStore = create<BotColumnLayoutState>()(
  persist(
    (set) => ({
      ...EMPTY_LAYOUT,
      setSectionOrder: (order, model) => {
        set((state) => pruneLayout({ ...state, sectionOrder: order }, model));
      },
      setChannelOrder: (environmentId, order, model) => {
        set((state) =>
          pruneLayout(
            {
              ...state,
              channelOrder: { ...state.channelOrder, [environmentId]: order },
            },
            model,
          ),
        );
      },
      setCollapsed: (environmentId, collapsed, model) => {
        set((state) => {
          const others = state.collapsed.filter((id) => id !== environmentId);
          return pruneLayout(
            {
              ...state,
              collapsed: collapsed ? [...others, environmentId] : others,
            },
            model,
          );
        });
      },
    }),
    {
      ...basePersistOptions(BOT_COLUMN_LAYOUT_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        sectionOrder: state.sectionOrder,
        channelOrder: state.channelOrder,
        collapsed: state.collapsed,
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...persistedLayout(persistedState),
      }),
    },
  ),
);

/** Another window's arrangement reaches this one live. */
installCrossWindowRehydrate(
  useBotColumnLayoutStore,
  BOT_COLUMN_LAYOUT_PERSIST_KEY,
);

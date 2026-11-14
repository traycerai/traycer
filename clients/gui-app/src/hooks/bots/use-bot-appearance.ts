import { createContext, use } from "react";
import type {
  BotAppearance,
  BotListResponse,
} from "@traycer/protocol/host/bot/schemas";
import type { HomeBotsModel } from "@/lib/home-bots/bots-model";
import { botColorAt } from "@/lib/providers/profile-accent-color";
import {
  NO_BOT_LOOK_SAVE,
  partsOf,
  useBotLookSaveStore,
} from "@/stores/bots/bot-look-save-store";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";

/**
 * What a surface's own `bot.list` read says of its bots' pictures: each
 * bot's look by id, and which bots are their environment's main bot.
 */
export interface BotLooks {
  readonly appearances: ReadonlyMap<string, BotAppearance>;
  /**
   * Whether each listed bot is its environment's main bot; `null` from a host
   * whose list names no main bots.
   */
  readonly main: ReadonlyMap<string, boolean> | null;
}

/**
 * The looks of the bots a surface lists through its own host. Outside one, a
 * bot's picture reads the app's directory instead.
 */
export const BotLooksContext = createContext<BotLooks | null>(null);

/**
 * The looks a list's rows carry, a row without an appearance left out, and
 * which of its bots are main.
 */
export function botLooksOf(
  list: Pick<BotListResponse, "bots" | "mainBotIds">,
): BotLooks {
  const appearances = new Map<string, BotAppearance>();
  for (const bot of list.bots) {
    const look = bot.appearance ?? null;
    if (look !== null) appearances.set(bot.botId, look);
  }
  const { mainBotIds } = list;
  if (mainBotIds === null) return { appearances, main: null };
  const mainIds = new Set(Object.values(mainBotIds));
  return {
    appearances,
    main: new Map(list.bots.map((bot) => [bot.botId, mainIds.has(bot.botId)])),
  };
}

const NO_LOOK: BotAppearance = {
  mark: null,
  color: null,
  background: null,
  eyewear: null,
  accessory: null,
};

/** The directory's own row, so an unchanged directory selects the same value. */
function directoryRow(
  model: HomeBotsModel,
  botId: string,
): BotListResponse["bots"][number] | null {
  for (const group of model.groups) {
    const bot = group.bots.find((row) => row.botId === botId);
    if (bot !== undefined) return bot;
  }
  return null;
}

/**
 * What a bot's picture is drawn from: the surface's list first, else the
 * app's directory. `null` when neither names its look, which draws every
 * choice at its default. A part chosen in the bot's settings and not yet
 * answered is drawn as chosen, over both.
 */
export function useBotLook(botId: string): BotAppearance | null {
  const surface = use(BotLooksContext)?.appearances.get(botId) ?? null;
  const row = useStandaloneBotsStore((state) =>
    directoryRow(state.directory.model, botId),
  );
  const chosen = useBotLookSaveStore(
    (state) => (state.saves[botId] ?? NO_BOT_LOOK_SAVE).chosen,
  );
  const held = surface ?? row?.appearance ?? null;
  if (partsOf(chosen).length === 0) return held;
  return { ...(held ?? NO_LOOK), ...chosen };
}

/**
 * Whether a bot is its environment's main bot: what the surface's own list
 * says of a bot it lists, else what the app's directory says, and `false`
 * while neither names it. The surface's answer wins because the two are read
 * through different hosts and the surface's is the one its settings change.
 * A main bot's picture starts plain.
 */
export function useBotIsMain(botId: string): boolean {
  const surface = use(BotLooksContext)?.main?.get(botId);
  const directory = useStandaloneBotsStore((state) =>
    state.directory.model.groups.some((group) => group.mainBotId === botId),
  );
  return surface ?? directory;
}

/**
 * The tint a channel's chosen background lays over the page: its colour at
 * one low opacity, in either theme.
 */
const CHANNEL_TINT_CLASS = "bg-(--channel-tint)/10";

/**
 * What a channel's tinted regions carry: the chosen background's colour (by
 * index), its class and its colour (as `--channel-tint`), each `undefined`
 * while the channel keeps the page's own.
 */
interface ChannelBackground {
  readonly index: number | undefined;
  readonly className: string | undefined;
  readonly color: string | undefined;
}

const NO_CHANNEL_BACKGROUND: ChannelBackground = {
  index: undefined,
  className: undefined,
  color: undefined,
};

/**
 * The background chosen for a bot's channel, which its header and message
 * area carry; one this client cannot read keeps the page's own.
 */
export function useChannelBackground(botId: string): ChannelBackground {
  const index = useBotLook(botId)?.background ?? null;
  if (typeof index !== "number") return NO_CHANNEL_BACKGROUND;
  return {
    index,
    className: CHANNEL_TINT_CLASS,
    color: botColorAt(index),
  };
}

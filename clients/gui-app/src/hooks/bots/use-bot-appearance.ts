import { createContext, use } from "react";
import type {
  BotAppearance,
  BotDirectoryRecord,
} from "@traycer/protocol/host/bot/schemas";
import type { HomeBotsModel } from "@/lib/home-bots/bots-model";
import { botSwatchAt } from "@/lib/providers/profile-accent-color";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";

/** Bots' looks by id, as a surface's own `bot.list` read names them. */
export type BotLooks = ReadonlyMap<string, BotAppearance>;

/**
 * The looks of the bots a surface lists through its own host. Outside one, a
 * bot's picture reads the app's directory instead.
 */
export const BotLooksContext = createContext<BotLooks | null>(null);

function lookOf(bot: BotDirectoryRecord): BotAppearance | null {
  return bot.appearance ?? null;
}

/** The looks a list's rows carry; a row without an appearance is left out. */
export function botLooksOf(bots: ReadonlyArray<BotDirectoryRecord>): BotLooks {
  const looks = new Map<string, BotAppearance>();
  for (const bot of bots) {
    const look = lookOf(bot);
    if (look !== null) looks.set(bot.botId, look);
  }
  return looks;
}

/** The directory's own row, so an unchanged directory selects the same value. */
function directoryRow(
  model: HomeBotsModel,
  botId: string,
): BotDirectoryRecord | null {
  for (const group of model.groups) {
    const bot = group.bots.find((row) => row.botId === botId);
    if (bot !== undefined) return bot;
  }
  return null;
}

/**
 * What a bot's picture is drawn from: the surface's list first, else the
 * app's directory. `null` when neither names its look, which draws every
 * choice at its default.
 */
export function useBotLook(botId: string): BotAppearance | null {
  const surface = use(BotLooksContext)?.get(botId) ?? null;
  const row = useStandaloneBotsStore((state) =>
    directoryRow(state.directory.model, botId),
  );
  if (surface !== null) return surface;
  return row === null ? null : lookOf(row);
}

/**
 * The tint a channel's chosen background lays over the page: its swatch at
 * one low opacity, in either theme.
 */
const CHANNEL_TINT_CLASS = "bg-(--channel-tint)/10";

/**
 * What a channel's tinted regions carry: the chosen background's swatch (by
 * index), its class and its colour (as `--channel-tint`), each `undefined`
 * while the channel keeps the page's own.
 */
export interface ChannelBackground {
  readonly swatch: number | undefined;
  readonly className: string | undefined;
  readonly color: string | undefined;
}

const NO_CHANNEL_BACKGROUND: ChannelBackground = {
  swatch: undefined,
  className: undefined,
  color: undefined,
};

/** The background chosen for a bot's channel, which its header and message area carry. */
export function useChannelBackground(botId: string): ChannelBackground {
  const swatch = useBotLook(botId)?.background ?? null;
  if (swatch === null) return NO_CHANNEL_BACKGROUND;
  return {
    swatch,
    className: CHANNEL_TINT_CLASS,
    color: botSwatchAt(swatch).color,
  };
}

import type { BotListResponse } from "@traycer/protocol/host/bot/schemas";

/** `bot.list`'s environment-to-main-bot map; `null` from a host that predates it. */
export type MainBotIds = BotListResponse["mainBotIds"];

/** The main bot of an environment, or `null` when the list names none. */
export function mainBotIdOf(
  mainBotIds: MainBotIds,
  environmentId: string,
): string | null {
  if (mainBotIds === null) return null;
  return Object.hasOwn(mainBotIds, environmentId)
    ? mainBotIds[environmentId]
    : null;
}

/**
 * Whether a bot is its environment's main bot (decision 30): `null` when it
 * is not known - the list has not answered, or its host predates the field -
 * so a surface draws neither the mark nor the action that would change it.
 */
export function isMainBot(
  mainBotIds: MainBotIds | undefined,
  bot: { readonly botId: string; readonly environmentId: string },
): boolean | null {
  if (mainBotIds === undefined || mainBotIds === null) return null;
  return mainBotIdOf(mainBotIds, bot.environmentId) === bot.botId;
}

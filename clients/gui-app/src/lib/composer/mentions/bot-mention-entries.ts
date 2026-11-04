import type { BotMentionEntry } from "@/lib/composer/types";
import {
  standaloneBotName,
  type StandaloneBotsDirectory,
} from "@/lib/home-bots/standalone-bot-name";

const EMPTY_BOT_ENTRIES: ReadonlyArray<BotMentionEntry> = [];

/**
 * The bots the agent composer's Tracy category lists: every live bot of the
 * standalone directory, named as Home names it standing alone, described by
 * its environment. A team's main bot still to be set up is left out: the
 * directory names no trunk agent for it, and the chip needs one.
 */
export function botMentionEntriesFromDirectory(
  directory: StandaloneBotsDirectory,
): ReadonlyArray<BotMentionEntry> {
  const entries = directory.model.groups.flatMap((group) =>
    group.bots.map((bot): BotMentionEntry => ({
      kind: "bot",
      id: `bot:${bot.botId}`,
      botId: bot.botId,
      trunkChatId: bot.trunkChatId,
      label: standaloneBotName(directory, bot.botId, bot.title),
      description: group.label,
      keywords: [bot.title, group.label, "tracy", "bot"],
    })),
  );
  return entries.length === 0 ? EMPTY_BOT_ENTRIES : entries;
}

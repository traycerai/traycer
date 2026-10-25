import type {
  BotActivity,
  BotSessionActivity,
} from "@traycer/protocol/host/bot/schemas";
import { useBotSubscriptionForHost } from "@/hooks/bots/use-bot-subscription";
import { lookupBotTab, useBotTabsStore } from "@/stores/bots/bot-tabs-store";

export type { BotActivity, BotSessionActivity };

/**
 * What the bot's sessions are doing - its trunk and its threads by thread
 * id - as `bot.subscribe` carries it from the host the bot's tab is bound
 * to. Every read of what a bot is doing goes through here: the channel's and
 * a thread's typing lines, the closed threads' lines, the Tracy entry and
 * the notice after a turn fails. It joins the bot's one subscription on that
 * host, so a reader outside the tab (the Tracy entry) sees what the tab
 * sees. `null` while the bot has no tab, before the first snapshot, while
 * that host is not the one the bot is bound to, and once the stream closed
 * for good: no frame will move a closed stream's last reading, so it reads
 * idle until a new subscription's snapshot (the bot tab says the stream
 * failed). A reconnect keeps it, as the turn may yet be running. A session
 * absent from it reads idle, as an `idle` entry does.
 */
export function useBotActivity(botId: string): BotActivity | null {
  const hostId = useBotTabsStore(
    (state) => lookupBotTab(state.tabs, botId)?.hostId ?? null,
  );
  const { snapshot, error, deleted } = useBotSubscriptionForHost({
    botId,
    hostId: hostId ?? "",
    enabled: hostId !== null,
  });
  if (hostId === null || error !== null || deleted) return null;
  return snapshot?.activity ?? null;
}

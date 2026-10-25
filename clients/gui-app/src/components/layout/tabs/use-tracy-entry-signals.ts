import { useMemo } from "react";
import { useBotActivity } from "@/hooks/bots/use-bot-activity";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";

const NO_CHAT_IDS: ReadonlyArray<string> = [];

/** What the Tracy entry says about its bot, in every strip placement. */
export interface TracyEntrySignals {
  /** The channel has a reply the person has not seen. */
  readonly unread: boolean;
  /** When the bot's running turn began, `null` while it is not replying. */
  readonly workingSince: number | null;
  /** What the running turn is doing now, when it says. */
  readonly step: string | null;
}

/**
 * Bold while the channel is unread and a timer while the bot runs a turn,
 * as a channel row in the sidebar carries them. The bot's id is its
 * container's, a shared cloud entity, so the notification host answers for
 * its unread state.
 */
export function useTracyEntrySignals(botId: string): TracyEntrySignals {
  const epicIds = useMemo(() => [botId], [botId]);
  const indicators = useNotificationIndicators({
    hostId: null,
    epicIds,
    chatIds: NO_CHAT_IDS,
    enabled: true,
  });
  const state = Object.hasOwn(indicators.epics, botId)
    ? indicators.epics[botId]
    : null;
  const trunk = useBotActivity(botId)?.trunk ?? null;
  const replying = trunk?.state === "replying";
  return {
    unread: state !== null && (state.unreadDone || state.unreadFailure),
    workingSince: replying ? (trunk.startedAt ?? null) : null,
    step: replying ? trunk.step : null,
  };
}

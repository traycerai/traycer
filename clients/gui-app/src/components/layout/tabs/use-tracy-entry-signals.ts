import { useMemo } from "react";
import {
  replyingSessionOf,
  useBotActivity,
} from "@/hooks/bots/use-bot-activity";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import { indicatorHasUnread } from "@/stores/notifications/notification-indicator-state";

const NO_CHAT_IDS: ReadonlyArray<string> = [];

/** What the Tracy entry says about its bot, in every strip placement. */
export interface TracyEntrySignals {
  /** The channel has a reply the person has not seen. */
  readonly unread: boolean;
  /**
   * How many of the bot's notifications the person has not read, its channel
   * answers and thread replies together; `null` where the notification host
   * does not count, and the entry is only bold.
   */
  readonly unreadCount: number | null;
  /** The bot is replying, in its channel or in a thread. */
  readonly working: boolean;
  /**
   * When the bot's running turn began, for its timer; `null` while it is
   * not replying anywhere, and while the host has not said when it began.
   */
  readonly workingSince: number | null;
  /** What the running turn is doing now, when it says. */
  readonly step: string | null;
  /**
   * The bot is known to be idle: its trunk is, and no thread is replying.
   * `false` while no host has written the trunk's state, or while the tab's
   * host cannot read it: unknown is not idle.
   */
  readonly idle: boolean;
}

/**
 * Bold and a count while the channel is unread and a timer while the bot runs a turn,
 * in its channel or in any of its threads, as a channel row in the sidebar
 * carries them. The bot's id is its
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
  const activity = useBotActivity(botId);
  const replying = replyingSessionOf(activity);
  return {
    unread: state !== null && indicatorHasUnread(state),
    unreadCount: state === null ? 0 : state.unreadCount,
    working: replying !== null,
    workingSince: replying?.startedAt ?? null,
    step: replying?.step ?? null,
    idle: replying === null && activity?.trunk?.state === "idle",
  };
}

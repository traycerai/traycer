import { useMemo } from "react";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import {
  replyingSessionOf,
  useBotActivity,
} from "@/hooks/bots/use-bot-activity";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import { useArrangedBotsModel } from "@/hooks/bots/use-arranged-bots-model";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { defaultTracyChannelOf } from "@/lib/bots/tracy-channel";
import { buildHomeBotsModel } from "@/lib/home-bots/bots-model";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useBotChannelMuted } from "@/hooks/bots/use-bot-notification-level";
import { useAnyBotChannelBold } from "@/hooks/bots/use-bot-read-cursor";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useOptionalHostClient } from "@/lib/host/runtime";
import { indicatorHasUnread } from "@/stores/notifications/notification-indicator-state";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

const NO_CHAT_IDS: ReadonlyArray<string> = [];
const NO_BOTS: ReadonlyArray<BotRecord> = [];

/** What the Tracy entry says about its channel, in every strip placement. */
export interface TracyEntrySignals {
  /**
   * Bold: a row past the person's read cursor in any of their bots'
   * channels, or, on a host without read cursors, a reply the person has
   * not seen in this bot's channel.
   */
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
  /** The person set the bot's channel to Nothing. */
  readonly muted: boolean;
  /** The channel's bot by its name; `null` while it is not known. */
  readonly channelTitle: string | null;
}

/**
 * The channel the Tracy surface shows: its selected one, else the default
 * (`defaultTracyChannelOf`) once the app's lists answer; `null` for none.
 */
function useTracyEntryChannel(
  client: HostClient<HostRpcRegistry> | null,
  listed: boolean,
): string | null {
  const botList = useBotListQuery(client, listed).data;
  const environments = useEnvironmentListQuery(client, listed).data;
  const selected = useTracySurfaceStore((state) => state.botId);
  // In the column's arranged order, as the surface picks it.
  const model = useArrangedBotsModel(
    useMemo(
      () =>
        buildHomeBotsModel({
          environments: environments?.environments ?? [],
          bots: botList?.bots ?? [],
          mainBotIds: botList?.mainBotIds ?? null,
        }),
      [botList, environments],
    ),
  );
  const fallback =
    botList === undefined || environments === undefined
      ? null
      : defaultTracyChannelOf(model.groups, null);
  return selected ?? fallback;
}

/** The person set the listed bot's channel to Nothing. */
function useChannelMuted(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  bot: BotRecord | null,
): boolean {
  return useBotChannelMuted(
    client,
    hostId,
    bot?.botId ?? "",
    bot?.appConversationChatId ?? null,
  );
}

/**
 * Whether the notification host has something unread for a bot's channel,
 * and how many; nothing for no bot.
 */
function useChannelUnread(botId: string | null): {
  readonly unread: boolean;
  readonly unreadCount: number | null;
} {
  const epicIds = useMemo(() => (botId === null ? [] : [botId]), [botId]);
  const indicators = useNotificationIndicators({
    hostId: null,
    epicIds,
    chatIds: NO_CHAT_IDS,
    enabled: botId !== null,
  });
  if (botId === null || !Object.hasOwn(indicators.epics, botId)) {
    return { unread: false, unreadCount: 0 };
  }
  const state = indicators.epics[botId];
  return { unread: indicatorHasUnread(state), unreadCount: state.unreadCount };
}

/**
 * What the entry says about the channel the Tracy surface shows - its
 * selected channel, else the default one (decision 150) - with bold and a
 * count while it is unread and a timer while the bot runs a turn, in its
 * channel or in any of its threads, as a channel row in the sidebar carries
 * them. The bot's id is its container's, a shared cloud entity, so the
 * notification host answers for its unread state. Nothing is said with no
 * channel to show.
 */
export function useTracyEntrySignals(): TracyEntrySignals {
  // The entry is app-wide, so its lists are read through the app's host.
  const client = useOptionalHostClient();
  const hostId = useEffectiveHostId();
  const listed = useHostMethodSupport(hostId, "bot.list") === true;
  const bots = useBotListQuery(client, listed).data?.bots ?? NO_BOTS;
  const botId = useTracyEntryChannel(client, listed);
  const channelUnread = useChannelUnread(botId);
  const activity = useBotActivity(botId);
  const replying = replyingSessionOf(activity);
  const bot = bots.find((row) => row.botId === botId) ?? null;
  const muted = useChannelMuted(client, hostId, bot);
  const channels = useMemo(
    () =>
      bots.map((bot) => ({
        botId: bot.botId,
        channelId: bot.appConversationChatId,
      })),
    [bots],
  );
  // Bold while any of the person's bots' channels is, where the host keeps
  // read cursors (decision 139); the entry's own indicator elsewhere.
  const bold = useAnyBotChannelBold(client, hostId, channels);
  return {
    unread: bold ?? channelUnread.unread,
    unreadCount: channelUnread.unreadCount,
    working: replying !== null,
    workingSince: replying?.startedAt ?? null,
    step: replying?.step ?? null,
    idle: replying === null && activity?.trunk?.state === "idle",
    muted,
    channelTitle: bot?.title ?? null,
  };
}

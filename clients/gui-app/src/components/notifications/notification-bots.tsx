import {
  createContext,
  use,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";
import { BotAvatar } from "@/components/bots/bot-avatars";
import {
  BotIdentityContext,
  type BotIdentity,
} from "@/components/bots/bot-identity-context";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useNotificationResolveHost } from "@/hooks/notifications/use-notification-host";
import type { NotificationPayload } from "@/lib/notifications/payload";
import { usePreviewFeature } from "@/hooks/auth/use-preview-feature";

const NO_BOTS: ReadonlyMap<string, string> = new Map();

/** The person's bots by id, with their titles, for the feed's rows. */
const NotificationBotsContext =
  createContext<ReadonlyMap<string, string>>(NO_BOTS);

/**
 * Names the person's bots to the feed below it, so a row about a bot (its
 * channel, a thread) shows the bot's picture where other rows show a glyph.
 * One `bot.list` read for the whole feed; the list is the same from any host,
 * so the host that serves the feed asks it.
 */
export function NotificationBotsProvider(props: {
  readonly children: ReactNode;
}): ReactElement {
  const { hostId, client } = useNotificationResolveHost();
  // Without bots (unread included) there are none to name.
  const offered = usePreviewFeature("bots") === "on";
  const supported = useHostMethodSupport(hostId, "bot.list") === true;
  const bots = useBotListQuery(client, supported && offered);
  const titles = useMemo(
    (): ReadonlyMap<string, string> =>
      bots.data === undefined
        ? NO_BOTS
        : new Map(bots.data.bots.map((bot) => [bot.botId, bot.title])),
    [bots.data],
  );
  return (
    <NotificationBotsContext value={titles}>
      {props.children}
    </NotificationBotsContext>
  );
}

/**
 * A bot's picture for a row whose destination is one of the person's bots'
 * conversations; any other row keeps its glyph (`fallback`).
 */
export function NotificationRowBotAvatar(props: {
  readonly payload: NotificationPayload | null;
  readonly fallback: ReactNode;
}): ReactNode {
  const titles = use(NotificationBotsContext);
  const botId = props.payload?.kind === "chat" ? props.payload.epicId : null;
  const title = botId === null ? undefined : titles.get(botId);
  const identity = useMemo(
    (): BotIdentity | null =>
      botId === null || title === undefined
        ? null
        : { botId, title, owner: null, openActivity: null },
    [botId, title],
  );
  if (identity === null) return props.fallback;
  return (
    <BotIdentityContext value={identity}>
      <BotAvatar size="sm" />
    </BotIdentityContext>
  );
}

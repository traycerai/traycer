import {
  createContext,
  use,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";
import { BotAvatar, PersonAvatar } from "@/components/bots/bot-avatars";
import {
  BotIdentityContext,
  type BotIdentity,
} from "@/components/bots/bot-identity-context";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useLoadedEnvironmentMembers } from "@/hooks/bots/use-environment-members-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import {
  PersonMembersContext,
  usePersonIdentity,
} from "@/hooks/identity/use-person-identity";
import { useNotificationResolveHost } from "@/hooks/notifications/use-notification-host";
import type { NotificationPayload } from "@/lib/notifications/payload";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

interface NotificationBot {
  readonly title: string;
  readonly environmentId: string;
}

const NO_BOTS: ReadonlyMap<string, NotificationBot> = new Map();

/** The person's bots by id, for the feed's rows. */
const NotificationBotsContext =
  createContext<ReadonlyMap<string, NotificationBot>>(NO_BOTS);

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
  const supported = useHostMethodSupport(hostId, "bot.list") === true;
  const bots = useBotListQuery(client, supported);
  const byId = useMemo(
    (): ReadonlyMap<string, NotificationBot> =>
      bots.data === undefined
        ? NO_BOTS
        : new Map(
            bots.data.bots.map((bot) => [
              bot.botId,
              { title: bot.title, environmentId: bot.environmentId },
            ]),
          ),
    [bots.data],
  );
  return (
    <NotificationBotsContext value={byId}>
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
  const bots = use(NotificationBotsContext);
  const botId = props.payload?.kind === "chat" ? props.payload.epicId : null;
  const title = botId === null ? undefined : bots.get(botId)?.title;
  const identity = useMemo(
    (): BotIdentity | null =>
      botId === null || title === undefined
        ? null
        : { botId, title, owner: null },
    [botId, title],
  );
  if (identity === null) return props.fallback;
  return (
    <BotIdentityContext value={identity}>
      <BotAvatar size="sm" />
    </BotIdentityContext>
  );
}

/**
 * A row's picture when a member wrote it, in a bot's conversation: that member
 * when we know them, else the row's kind glyph (`fallback`).
 *
 * The bell is outside every bot surface, so it reads the bot's environment's
 * members as far as Home, Tracy or voice has already loaded them, and asks for
 * nothing itself. A member not loaded yet is a member we do not know.
 */
export function NotificationRowAuthorAvatar(props: {
  readonly authorUserId: string;
  readonly payload: NotificationPayload | null;
  readonly fallback: ReactNode;
}): ReactNode {
  const bots = use(NotificationBotsContext);
  const botId = props.payload?.kind === "chat" ? props.payload.epicId : null;
  const environmentId =
    botId === null ? null : (bots.get(botId)?.environmentId ?? null);
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const resolveMember = useLoadedEnvironmentMembers(
    environmentId,
    cloudAuthorized,
  );
  return (
    <PersonMembersContext value={resolveMember}>
      <KnownPersonAvatar
        userId={props.authorUserId}
        fallback={props.fallback}
      />
    </PersonMembersContext>
  );
}

function KnownPersonAvatar(props: {
  readonly userId: string;
  readonly fallback: ReactNode;
}): ReactNode {
  const identity = usePersonIdentity(props.userId);
  // Known by id alone is not known: there is nothing to draw but the id.
  if (
    identity === null ||
    (identity.displayName === null && identity.avatarUrl === null)
  ) {
    return props.fallback;
  }
  return (
    <PersonAvatar
      userId={props.userId}
      name={identity.displayName ?? ""}
      avatarUrl={identity.avatarUrl}
      size="sm"
    />
  );
}

import { useMemo, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BotAvatar } from "@/components/bots/bot-avatars";
import {
  BotChatTranscript,
  type BotTranscriptLanding,
} from "@/components/bots/bot-chat-transcript";
import {
  BotSessionContext,
  type BotSessionAccess,
} from "@/components/bots/bot-session-context";
import { TileFindScope } from "@/components/epic-canvas/tile-find/tile-find-scope";
import {
  botMemberName,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import { sendQuestionStates } from "@/lib/bots/bot-send-tool";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

/**
 * One of the bot's own sessions shown in place of its channel: the trunk's
 * (`threadId` `null`) or a thread's, landed on one of its messages (`null`:
 * where it opens).
 */
export interface BotOpenSession {
  readonly chatId: string;
  readonly threadId: string | null;
  readonly landOn: BotTranscriptLanding | null;
}

/**
 * A bot's session, readable whole (Tracy Bots T93, decision 129): its trunk
 * or a thread's session as the agent chat renders it - every turn with its
 * activity, model and cost, and everything between turns (check-ins and
 * their results, model fallbacks and routing, background work, messages to
 * and from agents) in time order - with the agent chat's minimap, find and
 * jump, in place of the channel, which needs their width. Nothing in it acts
 * on the session: no box, and the footer says where the bot is spoken to.
 * The bot's sends read as sends (`BotSendCard`): where each went and what it
 * said, linked to where it landed.
 */
export function BotSessionView(props: {
  readonly botId: string;
  /** The host serving the tab: the session is read through it. */
  readonly hostId: string;
  readonly botTitle: string;
  readonly session: BotOpenSession;
  /** The bot's threads, as listed: a thread's session names its post; `null` while the list is not read. */
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
  readonly resolveMember: BotMemberResolver;
  /** Back to the view the session was opened from. */
  readonly onClose: () => void;
  /** Shows the channel, on `messageId` where one is named. */
  readonly onOpenChannel: (messageId: string | null) => void;
  /** Shows one of the bot's threads beside its channel, by the thread's id. */
  readonly onOpenThread: (threadId: string) => void;
}): ReactNode {
  const { botId, hostId, botTitle, session, threads, resolveMember } = props;
  const { onClose, onOpenChannel, onOpenThread } = props;
  const instanceId = `bot-session:${session.chatId}`;
  const title = `${botTitle} · ${session.threadId === null ? "trunk session" : "thread session"}`;
  const listed =
    session.threadId === null
      ? null
      : (threads?.find((thread) => thread.threadId === session.threadId) ??
        null);
  const anchor = listed?.anchor ?? null;
  const profile = useAuthStore((s) => s.profile);
  const access = useMemo((): BotSessionAccess => {
    const names = {
      botTitle,
      memberName: (userId: string) =>
        botMemberName(userId, profile, resolveMember),
      viewerUserId: profile?.userId ?? null,
    };
    return {
      ...names,
      botId,
      hostId,
      thread:
        session.threadId === null
          ? null
          : {
              threadId: session.threadId,
              post:
                listed === null || anchor === null
                  ? null
                  : {
                      conversationId: listed.conversationId,
                      messageId: anchor.messageId,
                    },
            },
      openChannel: onOpenChannel,
      openThread: onOpenThread,
      questionStatesOf: (receipt) =>
        sendQuestionStates(
          getChatSessionRegistry()
            .peek(botId, receipt.conversationId, hostId)
            ?.store.getState()
            .messages.find(
              (message) => message.messageId === receipt.messageId,
            ) ?? null,
          names,
        ),
    };
  }, [
    anchor,
    botId,
    botTitle,
    hostId,
    listed,
    onOpenChannel,
    onOpenThread,
    profile,
    resolveMember,
    session.threadId,
  ]);
  // Find is scoped to the session as it is to a chat tile.
  const tile = useMemo(
    (): Pick<EpicCanvasTileRef, "instanceId" | "id" | "type"> => ({
      instanceId,
      id: session.chatId,
      type: "chat",
    }),
    [instanceId, session.chatId],
  );
  return (
    <section
      aria-label={title}
      data-testid="bot-session-view"
      data-chat-id={session.chatId}
      className="flex min-h-0 min-w-0 flex-1 flex-col pb-safe-bottom"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          data-testid="bot-session-back"
          onClick={onClose}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <BotAvatar size="sm" />
        <h1
          className="min-w-0 truncate text-ui-md font-bold text-foreground"
          data-testid="bot-session-title"
        >
          {title}
        </h1>
        <Badge variant="muted" size="xs">
          Read-only
        </Badge>
      </header>
      <BotSessionContext value={access}>
        <TileFindScope
          node={tile}
          viewTabId={`bot:${botId}`}
          tileId={instanceId}
          epicId={botId}
          isActive
        >
          <BotChatTranscript
            botId={botId}
            chatId={session.chatId}
            hostId={hostId}
            title={botTitle}
            instanceId={instanceId}
            surface={null}
            resolveMember={resolveMember}
            showConnecting
            landOn={session.landOn}
          />
        </TileFindScope>
      </BotSessionContext>
      <footer
        className="flex shrink-0 flex-wrap items-center gap-x-1 border-t border-border/60 px-4 py-2 text-ui-xs text-muted-foreground"
        data-testid="bot-session-footer"
      >
        <span>{`Read-only. ${botTitle} is spoken to in`}</span>
        <Button
          type="button"
          variant="link"
          size="xs"
          data-testid="bot-session-channel"
          onClick={() => onOpenChannel(null)}
        >
          its channel
        </Button>
      </footer>
    </section>
  );
}

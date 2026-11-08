import { useCallback, type ReactNode } from "react";
import type { AutonomousResumeConversationMessage } from "@traycer/protocol/persistence/epic/content-blocks";
import { Button } from "@/components/ui/button";
import { ChannelPost } from "@/components/bots/bot-channel-post";
import { BotTranscriptImageScope } from "@/components/bots/bot-transcript-image-scope";
import type { BotSessionAccess } from "@/components/bots/bot-session-context";
import { ChatBotDeliveredPost } from "@/components/chat/chat-bot-message";
import { deliveredMessageRow } from "@/lib/bots/reply-row";

/**
 * The member's message a delivery brought into one of the bot's sessions
 * (Tracy Bots T159), drawn where the delivery landed, above the work it
 * prompted: the writer, the time, the text and the images, read from the
 * conversation's own row (fetched when it is not loaded), with a link to
 * where it was written that opens it there, landed on the message. Until the
 * row is read, the writer and the time the delivery recorded, over a
 * placeholder; where it cannot be read, that the message is unavailable.
 */
export function BotDeliveredMessage(props: {
  readonly delivered: AutonomousResumeConversationMessage;
  readonly access: BotSessionAccess;
  /** How the turn the message started ended when it drew no reply, under the link; `null` for none. */
  readonly foot: ReactNode | null;
}): ReactNode {
  const { delivered, access } = props;
  const { memberName, memberAvatarUrl, openChannel, openThread } = access;
  const thread = access.thread;
  const threadId =
    thread !== null && delivered.conversationId === thread.threadId
      ? thread.threadId
      : null;
  const senderLabel = useCallback(
    (senderUserId: string | null): string =>
      senderUserId === null ? "Member" : memberName(senderUserId),
    [memberName],
  );
  const open = () =>
    threadId === null
      ? openChannel(delivered.messageId)
      : openThread(threadId, delivered.messageId);
  const link = (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="self-start"
      data-testid="bot-delivered-open"
      onClick={open}
    >
      {threadId === null ? "in the channel" : "in the thread"}
    </Button>
  );
  const place =
    props.foot === null ? (
      link
    ) : (
      <>
        {link}
        <div
          className="text-ui-xs text-muted-foreground"
          data-testid="bot-delivered-ending"
        >
          {props.foot}
        </div>
      </>
    );
  return (
    <div
      data-testid="bot-delivered-message"
      data-message-id={delivered.messageId}
      className="w-full"
    >
      <BotTranscriptImageScope
        botId={access.botId}
        chatId={delivered.conversationId}
        hostId={access.hostId}
      >
        <ChannelPost
          botId={access.botId}
          hostId={access.hostId}
          conversationId={delivered.conversationId}
          messageId={delivered.messageId}
          fetchCold
        >
          {(post, missing) => (
            <ChatBotDeliveredPost
              message={deliveredMessageRow({
                delivered,
                post,
                senderLabel,
                senderAvatarUrl: memberAvatarUrl,
              })}
              body={deliveredBody(post !== null, missing)}
              place={place}
            />
          )}
        </ChannelPost>
      </BotTranscriptImageScope>
    </div>
  );
}

/** The row's text once read; else loading, until the fetch ends without it. */
function deliveredBody(
  read: boolean,
  missing: boolean,
): "message" | "loading" | "unavailable" {
  if (read) return "message";
  return missing ? "unavailable" : "loading";
}

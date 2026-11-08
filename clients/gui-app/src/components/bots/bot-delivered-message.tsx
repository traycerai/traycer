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
 * where it was written that opens it there, landed on the message. Where
 * the row cannot be read, the writer and the time the delivery recorded,
 * and that the message is unavailable.
 */
export function BotDeliveredMessage(props: {
  readonly delivered: AutonomousResumeConversationMessage;
  readonly access: BotSessionAccess;
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
  const place = (
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
              standIn={missing ? "Message unavailable" : null}
              place={place}
            />
          )}
        </ChannelPost>
      </BotTranscriptImageScope>
    </div>
  );
}

import { useContext, type ReactElement, type ReactNode } from "react";
import { Bot, MessageSquareText } from "lucide-react";
import type {
  BotAnnouncement,
  BotAnnouncementKind,
  ConversationRequest,
} from "@traycer/protocol/persistence/epic/messages";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useOpenLink } from "@/lib/links/open-link";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  ChatBotPresentationContext,
  type ChatBotPresentation,
  type ChatBotThreadLine,
} from "./chat-bot-presentation-context";
import { chatFindSegmentUnitId } from "./chat-find";
import { ChatMessageTimestamp } from "./chat-message-timestamp";
import { TextSegment } from "./segments/text-segment";

/**
 * One row of a bot's channel or thread, in Slack's message layout (Tracy
 * Bots, decision 41): the sender's picture, their name and the time, then
 * the text. A member's message carries the state of the request it opened
 * and, in the channel, the line that opens its thread; the bot's row carries
 * the "APP" tag Slack puts beside an app's name, and an announcement its
 * kind on a coloured bar, as Slack draws an app's attachment. A question or
 * a proposal carries the line that opens the thread a member answers it in,
 * and a thread reply that asks carries its options as buttons.
 */
export function ChatBotMessage(props: {
  readonly message: ChatMessageModel;
  readonly presentation: ChatBotPresentation;
}): ReactElement {
  const { message, presentation } = props;
  const sentAt = message.sentAt ?? message.createdAt;
  const body = <BotMessageText message={message} />;
  if (message.role === "assistant") {
    return (
      <BotRow
        message={message}
        presentation={presentation}
        sentAt={sentAt}
        body={body}
      />
    );
  }
  const name = message.senderLabel ?? "Member";
  const postId = message.persistentMessageId;
  const threadLine =
    postId === null || presentation.threadLine === null
      ? null
      : presentation.threadLine(postId);
  const openThread = presentation.openThread;
  return (
    <BotMessageFrame
      avatar={
        <MemberAvatar name={name} avatarUrl={message.senderAvatarUrl ?? null} />
      }
      name={name}
      app={false}
      sentAt={sentAt}
      instanceId={message.id}
      testId="bot-member-row"
    >
      {body}
      {message.conversationRequest === undefined ? null : (
        <ConversationRequestLine request={message.conversationRequest} />
      )}
      {postId === null || openThread === null ? null : (
        <ThreadLine line={threadLine} onOpen={() => openThread(postId)} />
      )}
    </BotMessageFrame>
  );
}

/**
 * The bot's own row: a reply, or an announcement on its coloured bar; a
 * reply's options, and the thread line under a question or proposal.
 */
function BotRow(props: {
  readonly message: ChatMessageModel;
  readonly presentation: ChatBotPresentation;
  readonly sentAt: number;
  readonly body: ReactNode;
}): ReactElement {
  const { message, presentation, sentAt, body } = props;
  const announcement = message.announcement ?? null;
  const announcementId = message.persistentMessageId;
  const openAnnouncementThread = presentation.openAnnouncementThread;
  const answerable =
    announcement !== null &&
    (announcement.kind === "question" || announcement.kind === "proposal") &&
    announcementId !== null &&
    openAnnouncementThread !== null;
  return (
    <BotMessageFrame
      avatar={<BotAvatar />}
      name={presentation.botTitle}
      app
      sentAt={sentAt}
      instanceId={message.id}
      testId={announcement === null ? "bot-reply-row" : "bot-announcement"}
    >
      {announcement === null ? (
        body
      ) : (
        <BotAnnouncementBody announcement={announcement}>
          {body}
        </BotAnnouncementBody>
      )}
      {message.options === undefined ? null : (
        <ReplyOptions
          options={message.options}
          onChoose={presentation.chooseOption}
        />
      )}
      {answerable ? (
        <ThreadLine
          line={presentation.threadLine?.(announcementId) ?? null}
          onOpen={() => openAnnouncementThread(announcementId)}
        />
      ) : null}
    </BotMessageFrame>
  );
}

/**
 * Slack's message frame: picture on the left, name, tag and time on the
 * first line, and whatever the row carries under it. Shared with the thread
 * panel, which draws the post a thread answers above its replies.
 */
export function BotMessageFrame(props: {
  readonly avatar: ReactNode;
  readonly name: string;
  /** The "APP" tag beside a bot's name. */
  readonly app: boolean;
  readonly sentAt: number;
  /** Names the time stamp for the layout editor; a message id. */
  readonly instanceId: string;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div
      data-testid={props.testId}
      className="group/message flex w-full gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-foreground/3"
    >
      {props.avatar}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-ui-xs">
          <span className="truncate text-ui-sm font-semibold text-foreground">
            {props.name}
          </span>
          {props.app ? (
            <Badge variant="muted" size="xs">
              APP
            </Badge>
          ) : null}
          <ChatMessageTimestamp
            timestamp={props.sentAt}
            separated={false}
            instanceId={props.instanceId}
          />
        </div>
        {props.children}
      </div>
    </div>
  );
}

export function BotAvatar(): ReactElement {
  return (
    <Avatar shape="square" size="lg" data-testid="bot-avatar">
      <AvatarFallback>
        <Bot className="size-5" aria-hidden="true" />
      </AvatarFallback>
    </Avatar>
  );
}

export function MemberAvatar(props: {
  readonly name: string;
  readonly avatarUrl: string | null;
}): ReactElement {
  return (
    <Avatar shape="square" size="lg" data-testid="chat-sender-avatar">
      {props.avatarUrl === null ? null : (
        <AvatarImage src={props.avatarUrl} alt="" />
      )}
      <AvatarFallback>{props.name.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

function BotMessageText(props: {
  readonly message: ChatMessageModel;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {props.message.segments.map((segment) =>
        segment.kind === "text" ? (
          <TextSegment
            key={segment.id}
            findUnitId={chatFindSegmentUnitId(segment.id)}
            markdown={segment.markdown}
            isStreaming={segment.isStreaming}
            nextStepActions={null}
          />
        ) : null,
      )}
    </div>
  );
}

const ANNOUNCEMENT_LABELS: Readonly<Record<BotAnnouncementKind, string>> = {
  proposal: "New proposal",
  automation: "Automation created",
  "bot-created": "New bot",
  policy: "Policy change",
  question: "Question",
};

const ANNOUNCEMENT_BARS: Readonly<Record<BotAnnouncementKind, string>> = {
  proposal: "border-l-info",
  automation: "border-l-success",
  "bot-created": "border-l-primary",
  policy: "border-l-warning",
  question: "border-l-chart-2",
};

function BotAnnouncementBody(props: {
  readonly announcement: BotAnnouncement;
  readonly children: ReactNode;
}): ReactElement {
  const { announcement } = props;
  return (
    <div
      data-announcement-kind={announcement.kind}
      className={cn(
        "mt-0.5 flex min-w-0 flex-col gap-1 border-l-4 py-0.5 pl-3",
        ANNOUNCEMENT_BARS[announcement.kind],
      )}
    >
      <span className="text-ui-sm font-semibold text-foreground">
        {ANNOUNCEMENT_LABELS[announcement.kind]}
      </span>
      {props.children}
      {announcement.link === null ? null : (
        <AnnouncementLink link={announcement.link} />
      )}
    </div>
  );
}

/**
 * The choices a bot's thread reply offers (decision 56), as Slack draws an
 * app's buttons: a click posts the choice as the person's next message in
 * the thread. Shown, but not clickable, where nothing can post it.
 */
function ReplyOptions(props: {
  readonly options: ReadonlyArray<string>;
  readonly onChoose: ((choice: string) => void) | null;
}): ReactElement {
  const { options, onChoose } = props;
  return (
    <div
      className="mt-1 flex flex-wrap gap-1.5"
      role="group"
      aria-label="Choices"
      data-testid="bot-reply-options"
    >
      {options.map((option) => (
        <Button
          key={option}
          type="button"
          variant="outline"
          size="xs"
          disabled={onChoose === null}
          data-testid="bot-reply-option"
          onClick={() => onChoose?.(option)}
        >
          {option}
        </Button>
      ))}
    </div>
  );
}

/** An http(s) link opens; an epic-relative path is shown as the path it is. */
function AnnouncementLink(props: { readonly link: string }): ReactElement {
  const openLink = useOpenLink();
  const isWebLink = /^https?:\/\//i.test(props.link);
  if (!isWebLink) {
    return (
      <code className="truncate text-ui-xs text-muted-foreground">
        {props.link}
      </code>
    );
  }
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="self-start"
      data-testid="bot-announcement-link"
      onClick={(event) => void openLink(props.link, "markdown", event)}
    >
      {props.link}
    </Button>
  );
}

/**
 * The state of the request a member's message opened: `Open` until the bot
 * resolves it, `Resolved` after, with a jump to the reply that resolved it
 * when that reply is in this list. Read off the member's row, which is where
 * the host keeps it; the reply row says nothing about the request.
 */
function ConversationRequestLine(props: {
  readonly request: ConversationRequest;
}): ReactElement {
  const { request } = props;
  const scrollToMessage =
    useContext(ChatBotPresentationContext)?.scrollToMessage ?? null;
  const open = request.resolvedAt === null;
  const replyId = request.resolvedByMessageId;
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-ui-xs text-muted-foreground"
      data-testid="conversation-request"
      data-request-id={request.requestId}
      data-request-state={open ? "open" : "resolved"}
    >
      <Badge variant={open ? "warning" : "success"} size="xs">
        {open ? "Open" : "Resolved"}
      </Badge>
      {open || replyId === null || scrollToMessage === null ? null : (
        <Button
          type="button"
          variant="link"
          size="xs"
          onClick={() => scrollToMessage(replyId)}
          data-testid="conversation-request-reply-link"
        >
          See reply
        </Button>
      )}
    </div>
  );
}

/**
 * Slack's line under a post: "N replies" and when the last one landed, the
 * way into the thread. A thread with no reply yet offers "Reply in thread",
 * the action Slack puts on a post. An unread reply in a thread the viewer
 * took part in shows as a dot and bold count.
 */
function ThreadLine(props: {
  readonly line: ChatBotThreadLine | null;
  readonly onOpen: () => void;
}): ReactElement {
  const { line, onOpen } = props;
  const replies = line?.replyCount ?? 0;
  const unread = line?.unread ?? false;
  return (
    <button
      type="button"
      data-testid="bot-thread-line"
      data-unread={unread ? "true" : "false"}
      onClick={onOpen}
      className="group/thread -ml-1 flex w-fit max-w-full items-center gap-2 rounded-md border border-transparent px-1 py-0.5 text-left text-ui-xs transition-colors hover:border-border/60 hover:bg-background focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
    >
      {replies === 0 ? (
        <span className="flex items-center gap-1 font-medium text-primary">
          <MessageSquareText className="size-3.5" aria-hidden="true" />
          Reply in thread
        </span>
      ) : (
        <>
          {unread ? (
            <span
              className="size-2 shrink-0 rounded-full bg-primary"
              data-testid="bot-thread-unread"
              aria-label="Unread replies"
              role="img"
            />
          ) : null}
          <span
            className={cn(
              "text-primary",
              unread ? "font-bold" : "font-semibold",
            )}
          >
            {replies === 1 ? "1 reply" : `${replies} replies`}
          </span>
          {line?.lastReplyAt === null || line === null ? null : (
            <LastReply at={line.lastReplyAt} />
          )}
        </>
      )}
    </button>
  );
}

/** "Last reply 5m ago", and "View thread" while the line is hovered, as Slack does. */
function LastReply(props: { readonly at: number }): ReactElement {
  const relative = useRelativeTimestamp(props.at);
  return (
    <span className="truncate text-muted-foreground">
      <span className="group-hover/thread:hidden">
        Last reply{" "}
        {relative === "Just now" || relative === "Yesterday"
          ? relative.toLowerCase()
          : relative}
      </span>
      <span className="hidden group-hover/thread:inline">View thread</span>
    </span>
  );
}

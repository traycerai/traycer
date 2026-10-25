import { useContext, type ReactElement, type ReactNode } from "react";
import { MessageSquareText } from "lucide-react";
import type {
  BotAnnouncement,
  BotAnnouncementKind,
  ConversationRequest,
} from "@traycer/protocol/persistence/epic/messages";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorkingShimmerText } from "@/components/ui/working-shimmer-text";
import { RetrospectiveSheetReview } from "@/components/settings/move/retrospective-sheet-link";
import { retrospectiveSheetLinkHostId } from "@/components/settings/move/retrospective-sheet-link-host";
import { SHARED_BY_EARLIER_VERSION_LINE } from "@/components/settings/move/overview-dated-lines";
import { useOpenLink } from "@/lib/links/open-link";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  AvatarStack,
  BotAvatar,
  MemberAvatar,
} from "@/components/bots/bot-avatars";
import {
  BotIdentityTrigger,
  BotOwnerLine,
} from "@/components/bots/bot-identity-popover";
import { useBotIdentity } from "@/components/bots/bot-identity-context";
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
 * and a reply that asks carries its options as buttons. A bot that answers
 * posts itself (reply mode `direct`) replies in the channel, its row naming
 * the post it answers; the post's line opens a thread under it on demand.
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
  // A direct post has no thread until a member replies under it: its line
  // opens the box whose first reply starts one, as under a question.
  const openThread =
    message.conversationRequest?.direct === true
      ? presentation.openAnnouncementThread
      : presentation.openThread;
  return (
    <BotMessageFrame
      avatar={
        <MemberAvatar
          userId={null}
          name={name}
          avatarUrl={message.senderAvatarUrl ?? null}
          size="lg"
        />
      }
      name={name}
      app={false}
      sentAt={sentAt}
      instanceId={message.id}
      testId="bot-member-row"
    >
      {body}
      {message.conversationRequest === undefined ? null : (
        <ConversationRequestLine
          request={message.conversationRequest}
          inChannel={presentation.threadLine !== null}
        />
      )}
      {postId === null || openThread === null ? null : (
        <ThreadLine
          line={threadLine}
          botTitle={presentation.botTitle}
          onOpen={() => openThread(postId)}
        />
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
  const repliesTo = message.repliesTo ?? null;
  const announcementId = message.persistentMessageId;
  const openAnnouncementThread = presentation.openAnnouncementThread;
  const answerable =
    announcement !== null &&
    (announcement.kind === "question" || announcement.kind === "proposal") &&
    announcementId !== null &&
    openAnnouncementThread !== null;
  return (
    <BotMessageFrame
      avatar={<BotAvatar size="lg" />}
      name={presentation.botTitle}
      app
      sentAt={sentAt}
      instanceId={message.id}
      testId={announcement === null ? "bot-reply-row" : "bot-announcement"}
    >
      {repliesTo === null ? null : (
        <RepliedPostLine postId={repliesTo} presentation={presentation} />
      )}
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
          botTitle={presentation.botTitle}
          onOpen={() => openAnnouncementThread(announcementId)}
        />
      ) : null}
    </BotMessageFrame>
  );
}

/**
 * Slack's message frame: picture on the left, name, tag and time on the
 * first line, and whatever the row carries under it. Shared with the thread
 * panel, which draws the post a thread answers above its replies. On a
 * bot's row the picture and the name open the bot's card, and "managed by"
 * names its owner.
 */
export function BotMessageFrame(props: {
  readonly avatar: ReactNode;
  readonly name: string;
  /** A bot's row: the "APP" tag beside its name, and its card and owner. */
  readonly app: boolean;
  readonly sentAt: number;
  /** Names the time stamp for the layout editor; a message id. */
  readonly instanceId: string;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactElement {
  const nameClassName = "truncate text-ui-sm font-semibold text-foreground";
  // A bot's card needs the surface's bot; outside one the row is plain.
  const identity = useBotIdentity();
  const carded = props.app && identity !== null;
  return (
    <div
      data-testid={props.testId}
      className="group/message flex w-full gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-foreground/3"
    >
      {carded ? (
        <BotIdentityTrigger>
          <button
            type="button"
            aria-label={props.name}
            className="self-start rounded-md focus-visible:outline-2 focus-visible:outline-ring"
          >
            {props.avatar}
          </button>
        </BotIdentityTrigger>
      ) : (
        props.avatar
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-ui-xs">
          {carded ? (
            <BotIdentityTrigger>
              <button
                type="button"
                className={cn(
                  nameClassName,
                  "rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring",
                )}
                data-testid="bot-row-name"
              >
                {props.name}
              </button>
            </BotIdentityTrigger>
          ) : (
            <span className={nameClassName}>{props.name}</span>
          )}
          {props.app ? (
            <Badge variant="muted" size="xs">
              APP
            </Badge>
          ) : null}
          {carded ? <BotOwnerLine /> : null}
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

/**
 * Tracy's message on a computer an earlier version shared is a record, not a
 * proposal: it carries the retrospective sheet's link, and is labelled with
 * the Overview's own line.
 */
function announcementLabel(announcement: BotAnnouncement): string {
  return announcement.link !== null &&
    retrospectiveSheetLinkHostId(announcement.link) !== null
    ? SHARED_BY_EARLIER_VERSION_LINE
    : ANNOUNCEMENT_LABELS[announcement.kind];
}

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
        {announcementLabel(announcement)}
      </span>
      {props.children}
      {announcement.link === null ? null : (
        <AnnouncementLink link={announcement.link} />
      )}
    </div>
  );
}

/**
 * The choices a bot reply offers (decision 56), as Slack draws an app's
 * buttons: a click posts the choice as the person's next message on this
 * surface. Shown, but not clickable, where nothing can post it.
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

/**
 * An http(s) link opens; a retrospective sheet link is the message's Review
 * action; any other epic-relative path is shown as the path it is.
 */
function AnnouncementLink(props: { readonly link: string }): ReactElement {
  const openLink = useOpenLink();
  const isWebLink = /^https?:\/\//i.test(props.link);
  const reviewHostId = isWebLink
    ? null
    : retrospectiveSheetLinkHostId(props.link);
  if (reviewHostId !== null) {
    return <RetrospectiveSheetReview hostId={reviewHostId} />;
  }
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
 * The post a bot's direct reply answers, above the reply: who wrote it and
 * its first line, a jump back to it. Nothing while the post is not in the
 * list the channel has read.
 */
function RepliedPostLine(props: {
  readonly postId: string;
  readonly presentation: ChatBotPresentation;
}): ReactNode {
  const { postId, presentation } = props;
  const post = presentation.repliedPost?.(postId) ?? null;
  const scrollToMessage = presentation.scrollToMessage;
  if (post === null) return null;
  const label = (
    <>
      <span className="font-medium">{post.senderLabel}</span>
      <span className="truncate">{post.excerpt}</span>
    </>
  );
  const className =
    "flex w-fit max-w-full min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground";
  return scrollToMessage === null ? (
    <div className={className} data-testid="bot-replied-post">
      {label}
    </div>
  ) : (
    <button
      type="button"
      className={cn(className, "rounded-sm hover:text-foreground")}
      data-testid="bot-replied-post"
      onClick={() => scrollToMessage(postId)}
    >
      {label}
    </button>
  );
}

/**
 * The state of the request a member's message opened: `Open` until the bot
 * resolves it, `Resolved` after, with a jump to the reply that resolved it
 * when that reply is in this list: in a thread, or in the channel for a
 * direct post, whose reply is in the channel. Read off the member's row,
 * which is where the host keeps it; the reply row says nothing about the
 * request.
 */
function ConversationRequestLine(props: {
  readonly request: ConversationRequest;
  readonly inChannel: boolean;
}): ReactElement {
  const { request, inChannel } = props;
  const presented =
    useContext(ChatBotPresentationContext)?.scrollToMessage ?? null;
  const scrollToMessage =
    inChannel && request.direct !== true ? null : presented;
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

const THREAD_LINE_STACK_MAX = 3;

/**
 * Slack's line under a post: who is in the thread, "N replies" and when the
 * last one landed, the way into the thread. A thread with no reply yet offers "Reply in thread",
 * the action Slack puts on a post. An unread reply in a thread the viewer
 * took part in shows as a dot and bold count. While the bot is answering in
 * the thread, the line says so in place of when the last reply landed.
 */
function ThreadLine(props: {
  readonly line: ChatBotThreadLine | null;
  readonly botTitle: string;
  readonly onOpen: () => void;
}): ReactElement {
  const { line, botTitle, onOpen } = props;
  const replies = line?.replyCount ?? 0;
  const unread = line?.unread ?? false;
  const replying = line?.replying ?? false;
  return (
    <button
      type="button"
      data-testid="bot-thread-line"
      data-unread={unread ? "true" : "false"}
      onClick={onOpen}
      className="group/thread -ml-1 flex w-fit max-w-full items-center gap-2 rounded-md border border-transparent px-1 py-0.5 text-left text-ui-xs transition-colors hover:border-border/60 hover:bg-background focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
    >
      {replies === 0 && !replying ? (
        <span className="flex items-center gap-1 font-medium text-primary">
          <MessageSquareText className="size-3.5" aria-hidden="true" />
          Reply in thread
        </span>
      ) : (
        <>
          <AvatarStack
            identities={line?.participants ?? []}
            max={THREAD_LINE_STACK_MAX}
            size="xs"
            label="In this thread"
            testId="bot-thread-participants"
          />
          <ThreadLineCount replies={replies} unread={unread} />
          <ThreadLineStatus
            lastReplyAt={line?.lastReplyAt ?? null}
            replying={replying}
            botTitle={botTitle}
          />
        </>
      )}
    </button>
  );
}

/** "N replies", bold behind a dot while one is unread. */
function ThreadLineCount(props: {
  readonly replies: number;
  readonly unread: boolean;
}): ReactNode {
  const { replies, unread } = props;
  return (
    <>
      {unread ? (
        <span
          className="size-2 shrink-0 rounded-full bg-primary"
          data-testid="bot-thread-unread"
          aria-label="Unread replies"
          role="img"
        />
      ) : null}
      {replies === 0 ? null : (
        <span
          className={cn("text-primary", unread ? "font-bold" : "font-semibold")}
        >
          {replies === 1 ? "1 reply" : `${replies} replies`}
        </span>
      )}
    </>
  );
}

/** The line's tail: the bot answering now, else when the last reply landed. */
function ThreadLineStatus(props: {
  readonly lastReplyAt: number | null;
  readonly replying: boolean;
  readonly botTitle: string;
}): ReactNode {
  if (props.replying) {
    return (
      <span
        data-testid="bot-thread-replying"
        className="min-w-0 truncate text-muted-foreground"
      >
        <WorkingShimmerText className={undefined}>
          {`${props.botTitle} is replying…`}
        </WorkingShimmerText>
      </span>
    );
  }
  return props.lastReplyAt === null ? null : (
    <LastReply at={props.lastReplyAt} />
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

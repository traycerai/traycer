import { Fragment, useContext, type ReactElement, type ReactNode } from "react";
import { MessageSquareText, Pencil, RotateCcw } from "lucide-react";
import {
  isConversationRequestMessageId,
  type BotAnnouncement,
  type BotAnnouncementKind,
  type ConversationRequest,
} from "@traycer/protocol/persistence/epic/messages";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { WorkingShimmerText } from "@/components/ui/working-shimmer-text";
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
  type ChatBotFailedRequest,
  type ChatBotPresentation,
  type ChatBotThreadLine,
} from "./chat-bot-presentation-context";
import { chatFindSegmentUnitId } from "./chat-find";
import { ChatMessageTimestamp } from "./chat-message-timestamp";
import { TextSegment } from "./segments/text-segment";

/**
 * One row of a bot's channel or thread, in Slack's message layout (Tracy
 * Bots, decision 41): the sender's picture, their name and the time, then
 * the text. A member's message carries a jump to the reply that answered it
 * where that reply is not right under it and, in the channel, the line of
 * its thread once the thread has a reply; an announcement carries its kind
 * on a coloured bar, as Slack draws an app's attachment. A question or a
 * proposal carries the line of the thread a member answers it in, and a
 * reply that asks carries its options as buttons. A bot that answers posts
 * itself (reply mode `direct`) replies in the channel, its row naming the
 * post it answers.
 *
 * In the channel, "Reply in thread" is among the row's hover actions, as
 * Slack offers it on every message: a member's post and a question or
 * proposal open their own thread, and a direct reply opens the thread under
 * the post it answers, since a thread hangs off a post or a question, not
 * off a reply. Any other announcement takes no thread. A member's message
 * the bot failed to answer adds Retry and Edit to them, and says under its
 * text that it was not answered and why, with the same actions inline.
 *
 * Without `hoverActions` the row is drawn as the post a thread opens on, at
 * the top of the thread panel: the same row, with nothing on hover.
 */
export function ChatBotMessage(props: {
  readonly message: ChatMessageModel;
  readonly presentation: ChatBotPresentation;
  readonly hoverActions: boolean;
}): ReactElement {
  const { message, presentation, hoverActions } = props;
  const sentAt = message.sentAt ?? message.createdAt;
  const body = <BotMessageText message={message} />;
  if (message.role === "assistant") {
    return (
      <BotRow
        message={message}
        presentation={presentation}
        sentAt={sentAt}
        body={body}
        hoverActions={hoverActions}
      />
    );
  }
  const name = message.senderLabel ?? "Member";
  const postId = message.persistentMessageId;
  const threadLine =
    postId === null || presentation.threadLine === null
      ? null
      : presentation.threadLine(postId);
  // A direct post has no thread until a member replies under it: its
  // action opens the box whose first reply starts one, as under a question.
  const openThread =
    message.conversationRequest?.direct === true
      ? presentation.openAnnouncementThread
      : presentation.openThread;
  const replyInThread =
    postId === null || openThread === null ? null : () => openThread(postId);
  const failed = failedActionsOf(message, presentation);
  return (
    <BotMessageFrame
      avatar={
        <MemberAvatar
          userId={message.senderUserId ?? null}
          name={name}
          avatarUrl={message.senderAvatarUrl ?? null}
          size="lg"
        />
      }
      name={name}
      bot={false}
      sentAt={sentAt}
      instanceId={message.id}
      testId="bot-member-row"
      hoverActions={hoverActions}
      replyInThread={replyInThread}
      failed={failed}
    >
      {body}
      {failed === null ? null : <UnansweredLine failed={failed} />}
      {message.conversationRequest === undefined ? null : (
        <AnsweredReplyLink
          request={message.conversationRequest}
          postId={postId}
          inChannel={presentation.threadLine !== null}
        />
      )}
      {replyInThread === null || !threadStarted(threadLine) ? null : (
        <ThreadLine
          line={threadLine}
          botTitle={presentation.botTitle}
          onOpen={replyInThread}
        />
      )}
    </BotMessageFrame>
  );
}

/**
 * Why a member's message the bot failed to answer was not answered, and its
 * Retry and Edit bound to the message's text; `null` on any other.
 */
function failedActionsOf(
  message: ChatMessageModel,
  presentation: ChatBotPresentation,
): FailedMessageActions | null {
  const request = message.conversationRequest;
  const failed =
    request === undefined || presentation.failedRequest === null
      ? null
      : presentation.failedRequest(
          request.requestId,
          message.senderUserId ?? null,
        );
  if (failed === null) return null;
  const { retry, edit } = failed;
  return {
    state: failed.state,
    summary: failed.summary,
    onSignIn: failed.signIn,
    onRetry: retry === null ? null : () => retry(message.content),
    retrying: failed.retrying,
    onEdit: edit === null ? null : () => edit(message.content),
  };
}

/**
 * The bot's own row: a reply, or an announcement on its coloured bar; a
 * reply's options, and the thread line under a question or proposal once
 * its thread has a reply.
 */
function BotRow(props: {
  readonly message: ChatMessageModel;
  readonly presentation: ChatBotPresentation;
  readonly sentAt: number;
  readonly body: ReactNode;
  readonly hoverActions: boolean;
}): ReactElement {
  const { message, presentation, sentAt, body, hoverActions } = props;
  const announcement = message.announcement ?? null;
  const repliesTo = message.repliesTo ?? null;
  const { replyInThread, threadLine } = botRowThread(message, presentation);
  return (
    <BotMessageFrame
      avatar={<BotAvatar size="lg" />}
      name={presentation.botTitle}
      bot
      sentAt={sentAt}
      instanceId={message.id}
      testId={announcement === null ? "bot-reply-row" : "bot-announcement"}
      hoverActions={hoverActions}
      replyInThread={replyInThread}
      failed={null}
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
      {replyInThread === null || !threadStarted(threadLine) ? null : (
        <ThreadLine
          line={threadLine}
          botTitle={presentation.botTitle}
          onOpen={replyInThread}
        />
      )}
    </BotMessageFrame>
  );
}

/**
 * The thread a bot's row opens from its hover actions, and the line of it
 * the row carries: a question or proposal's own thread, and for a direct
 * reply the thread under the post it answers, whose line is under that
 * post. Any other row of the bot takes none.
 */
function botRowThread(
  message: ChatMessageModel,
  presentation: ChatBotPresentation,
): {
  readonly replyInThread: (() => void) | null;
  readonly threadLine: ChatBotThreadLine | null;
} {
  const kind = message.announcement?.kind ?? null;
  const answerableId =
    kind === "question" || kind === "proposal"
      ? message.persistentMessageId
      : null;
  const anchorId = answerableId ?? message.repliesTo ?? null;
  const open = presentation.openAnnouncementThread;
  return {
    replyInThread:
      anchorId === null || open === null ? null : () => open(anchorId),
    threadLine:
      answerableId === null || presentation.threadLine === null
        ? null
        : presentation.threadLine(answerableId),
  };
}

/**
 * Slack's message frame: picture on the left, name and time on the first
 * line, and whatever the row carries under it. On a bot's row the picture
 * and the name open the bot's card, and "managed by" names its owner.
 */
function BotMessageFrame(props: {
  readonly avatar: ReactNode;
  readonly name: string;
  /** A bot's row: its card and its owner. */
  readonly bot: boolean;
  readonly sentAt: number;
  /** Names the time stamp for the layout editor; a message id. */
  readonly instanceId: string;
  readonly testId: string;
  /** Whether the row offers its actions on hover; the post a thread opens on does not. */
  readonly hoverActions: boolean;
  /** Opens the row's thread, from its hover actions; `null` for a row that takes none. */
  readonly replyInThread: (() => void) | null;
  /** Retry and Edit, among the hover actions of a message the bot failed to answer. */
  readonly failed: FailedMessageActions | null;
  readonly children: ReactNode;
}): ReactElement {
  const nameClassName = "truncate text-ui-sm font-semibold text-foreground";
  // A bot's card needs the surface's bot; outside one the row is plain.
  const identity = useBotIdentity();
  const carded = props.bot && identity !== null;
  return (
    <div
      data-testid={props.testId}
      className="group/message relative flex w-full gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-foreground/3"
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
          {carded ? <BotOwnerLine /> : null}
          <ChatMessageTimestamp
            timestamp={props.sentAt}
            separated={false}
            instanceId={props.instanceId}
          />
        </div>
        {props.children}
      </div>
      {!props.hoverActions ||
      (props.replyInThread === null &&
        (props.failed?.onRetry ?? null) === null) ? null : (
        <MessageActions
          onReplyInThread={props.replyInThread}
          failed={props.failed}
        />
      )}
    </div>
  );
}

/**
 * A failed message's state, why, and its actions, bound to the row; no Retry
 * or Edit where it cannot be sent again, no Edit on a teammate's, and Sign
 * in only where signing in is the fix.
 */
type FailedMessageActions = {
  readonly state: ChatBotFailedRequest["state"];
  readonly summary: string | null;
  readonly onSignIn: (() => void) | null;
  readonly onRetry: (() => void) | null;
  readonly retrying: boolean;
  readonly onEdit: (() => void) | null;
};

/**
 * The line under a message the bot failed to answer, as Slack marks a
 * message that did not send: "Not answered" and why, then what can be done
 * about it as text actions. A held answer reads the same way in the warning
 * colour, with Retry alone.
 */
function UnansweredLine(props: {
  readonly failed: FailedMessageActions;
}): ReactElement {
  const { failed } = props;
  const parked = failed.state === "parked";
  const actions: ReadonlyArray<{
    readonly label: string;
    readonly testId: string;
    readonly disabled: boolean;
    readonly onClick: () => void;
  }> = [
    ...(failed.onRetry === null
      ? []
      : [
          {
            label: "Retry",
            testId: "bot-message-unanswered-retry",
            disabled: failed.retrying,
            onClick: failed.onRetry,
          },
        ]),
    ...(parked || failed.onEdit === null
      ? []
      : [
          {
            label: "Edit",
            testId: "bot-message-unanswered-edit",
            disabled: false,
            onClick: failed.onEdit,
          },
        ]),
    ...(parked || failed.onSignIn === null
      ? []
      : [
          {
            label: "Sign in",
            testId: "bot-message-unanswered-sign-in",
            disabled: false,
            onClick: failed.onSignIn,
          },
        ]),
  ];
  return (
    <p
      data-testid="bot-message-unanswered"
      data-state={failed.state}
      className={cn(
        "text-ui-xs break-words whitespace-pre-wrap",
        parked ? "text-warning-foreground" : "text-destructive",
      )}
    >
      {failed.summary === null
        ? "Not answered"
        : `Not answered: ${failed.summary}`}
      {actions.map((action) => (
        <Fragment key={action.testId}>
          <span aria-hidden="true">{" · "}</span>
          <button
            type="button"
            data-testid={action.testId}
            disabled={action.disabled}
            onClick={action.onClick}
            className="rounded-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
          >
            {action.label}
          </button>
        </Fragment>
      ))}
    </p>
  );
}

/**
 * Slack's message actions, floating at the row's top right while it is
 * hovered or one of them has keyboard focus; always shown on a touch screen,
 * which has no hover.
 */
function MessageActions(props: {
  readonly onReplyInThread: (() => void) | null;
  readonly failed: FailedMessageActions | null;
}): ReactElement {
  const { onReplyInThread, failed } = props;
  return (
    <div
      data-testid="bot-message-actions"
      className="pointer-events-none absolute top-1 right-2 z-10 flex items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5 opacity-0 shadow-sm transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
    >
      {failed === null || failed.onRetry === null ? null : (
        <>
          <MessageAction
            label="Retry"
            testId="bot-message-retry"
            disabled={failed.retrying}
            onClick={failed.onRetry}
          >
            <RotateCcw aria-hidden="true" />
          </MessageAction>
          {failed.onEdit === null ? null : (
            <MessageAction
              label="Edit"
              testId="bot-message-edit"
              disabled={false}
              onClick={failed.onEdit}
            >
              <Pencil aria-hidden="true" />
            </MessageAction>
          )}
        </>
      )}
      {onReplyInThread === null ? null : (
        <MessageAction
          label="Reply in thread"
          testId="bot-message-reply-in-thread"
          disabled={false}
          onClick={onReplyInThread}
        >
          <MessageSquareText aria-hidden="true" />
        </MessageAction>
      )}
    </div>
  );
}

function MessageAction(props: {
  readonly label: string;
  readonly testId: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <TooltipWrapper
      label={props.label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={props.label}
        data-testid={props.testId}
        disabled={props.disabled}
        onClick={props.onClick}
      >
        {props.children}
      </Button>
    </TooltipWrapper>
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
 * Tracy's message on a host an earlier version shared is a record, not a
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
 * An http(s) link opens; any other epic-relative path is shown as the path
 * it is. A retrospective sheet link draws nothing: the record it labels is
 * history, and the sheet is reached from the host's Overview in Settings.
 */
function AnnouncementLink(props: { readonly link: string }): ReactNode {
  const openLink = useOpenLink();
  const isWebLink = /^https?:\/\//i.test(props.link);
  if (!isWebLink && retrospectiveSheetLinkHostId(props.link) !== null) {
    return null;
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
 * "See reply" under a member's message the bot has answered, a jump to the
 * reply when that reply is in this list (in a thread, or in the channel for
 * a direct post, whose reply is in the channel) and not the row right under
 * the message. Whether a message still waits for its answer is the bot's
 * own bookkeeping and is not drawn. Read off the member's row, which is
 * where the host keeps it; the reply row says nothing about the request.
 */
function AnsweredReplyLink(props: {
  readonly request: ConversationRequest;
  /** The member's message, by its message id; `null` before it is written. */
  readonly postId: string | null;
  readonly inChannel: boolean;
}): ReactNode {
  const { request, postId, inChannel } = props;
  const presentation = useContext(ChatBotPresentationContext);
  const scrollToMessage =
    inChannel && request.direct !== true
      ? null
      : (presentation?.scrollToMessage ?? null);
  const replyId =
    request.resolvedAt === null ? null : request.resolvedByMessageId;
  // A message the person replaced with an edit was not answered: the new
  // message carries the request now.
  if (
    replyId === null ||
    scrollToMessage === null ||
    isConversationRequestMessageId(replyId)
  ) {
    return null;
  }
  if (
    postId !== null &&
    presentation?.replyFollowsPost?.(postId, replyId) === true
  ) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="self-start"
      onClick={() => scrollToMessage(replyId)}
      data-testid="conversation-request-reply-link"
    >
      See reply
    </Button>
  );
}

const THREAD_LINE_STACK_MAX = 3;

/**
 * Whether a post's thread has something for its line to show: a reply, or
 * the bot answering in it now. Before that the thread is reached through
 * the row's "Reply in thread" action.
 */
function threadStarted(
  line: ChatBotThreadLine | null,
): line is ChatBotThreadLine {
  return line !== null && (line.replyCount > 0 || line.replying);
}

/**
 * Slack's line under a post: who is in the thread, "N replies" and when the
 * last one landed, the way into the thread. An unread reply in a thread the
 * viewer took part in shows as a dot and bold count. While the bot is
 * answering in the thread, the line says so in place of when the last reply
 * landed.
 */
function ThreadLine(props: {
  readonly line: ChatBotThreadLine;
  readonly botTitle: string;
  readonly onOpen: () => void;
}): ReactElement {
  const { line, botTitle, onOpen } = props;
  const replies = line.replyCount;
  const unread = line.unread;
  const replying = line.replying;
  return (
    <button
      type="button"
      data-testid="bot-thread-line"
      data-unread={unread ? "true" : "false"}
      onClick={onOpen}
      className="group/thread -ml-1 flex w-fit max-w-full items-center gap-2 rounded-md border border-transparent px-1 py-0.5 text-left text-ui-xs transition-colors hover:border-border/60 hover:bg-background focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
    >
      <AvatarStack
        identities={line.participants}
        max={THREAD_LINE_STACK_MAX}
        size="xs"
        label="In this thread"
        testId="bot-thread-participants"
      />
      <ThreadLineCount replies={replies} unread={unread} />
      <ThreadLineStatus
        lastReplyAt={line.lastReplyAt}
        replying={replying}
        botTitle={botTitle}
      />
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

import {
  Fragment,
  useContext,
  useEffect,
  type ReactElement,
  type ReactNode,
} from "react";
import { MessageSquareText, Pencil, RotateCcw } from "lucide-react";
import {
  isConversationRequestMessageId,
  type BotAnnouncement,
  type BotAnnouncementKind,
  type BotQuestion,
  type ConversationRequest,
} from "@traycer/protocol/persistence/epic/messages";
import { UnreadCountBadge } from "@/components/notifications/unread-count-badge";
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
import { BotIdentityTrigger } from "@/components/bots/bot-identity-popover";
import { useBotIdentity } from "@/components/bots/bot-identity-context";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  ChatBotPresentationContext,
  type ChatBotFailedRequest,
  type ChatBotPresentation,
  type ChatBotQuestions,
  type ChatBotThreadLine,
} from "./chat-bot-presentation-context";
import { chatFindSegmentUnitId } from "./chat-find";
import { ChatMessageTimestamp } from "./chat-message-timestamp";
import {
  answerDraftKey,
  useBotDraftsStore,
} from "@/stores/bots/bot-drafts-store";
import { QuestionCard, type QuestionCardQuestion } from "./question-card";
import {
  EMPTY_QUESTION_CARD_DRAFT,
  questionCardView,
  type QuestionCardSettlement,
} from "./question-card-view";
import { TextSegment } from "./segments/text-segment";

/**
 * One row of a bot's channel or thread, in Slack's message layout (Tracy
 * Bots, decision 41): the sender's picture, their name and the time, then
 * the text. A member's message carries a jump to the reply that answered it
 * where that reply is not right under it and, in the channel, the line of
 * its thread once the thread has a reply; an announcement carries its kind
 * on a coloured bar, as Slack draws an app's attachment. A question or a
 * proposal carries the line of the thread a member answers it in, and a
 * reply that asks carries its options as buttons. A row that asks without
 * waiting (decision 121) draws the question card in place of its text and
 * options, and carries its thread's line as a question does. A bot that
 * answers posts itself (reply mode `direct`) replies in the channel, as a
 * plain row.
 *
 * In the channel, "Reply in thread" is among the row's hover actions, as
 * Slack offers it on every message, and a thread roots on the row it is
 * opened from (decision 114): a member's post, a question or proposal, and
 * a direct reply each open their own thread, the reply's apart from the
 * post's, and each carries its own thread line. A direct reply opens the
 * thread under the post it answers instead, with no line of its own, where
 * the bot's host does not say it takes replies under one
 * (`answerThreads`). Any other announcement takes no thread. A member's
 * message
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
  const replyInThread =
    postId === null ? null : memberReplyInThread(message, postId, presentation);
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
 * Retry and Edit bound to the message's text; `null` on any other. A held
 * (parked) answer offers Retry alone, on the line and on hover alike.
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
  const parked = failed.state === "parked";
  return {
    state: failed.state,
    summary: failed.summary,
    onSignIn: parked ? null : failed.signIn,
    onRetry: retry === null ? null : () => retry(message.content),
    retrying: failed.retrying,
    onEdit: parked || edit === null ? null : () => edit(message.content),
  };
}

/**
 * The bot's own row: a reply, or an announcement on its coloured bar; a
 * reply's options, or the card of the questions it asks; and the thread line
 * under a question or proposal once its thread has a reply.
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
  const question = message.question ?? null;
  const questions = question === null ? null : presentation.questions;
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
      {question !== null && questions !== null ? (
        <BotQuestionCard
          messageId={message.persistentMessageId}
          question={question}
          botTitle={presentation.botTitle}
          questions={questions}
        />
      ) : (
        <BotRowBody announcement={announcement} body={body} />
      )}
      {message.options === undefined || questions !== null ? null : (
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

/** A bot row's text, on its announcement's coloured bar where it is one. */
function BotRowBody(props: {
  readonly announcement: BotAnnouncement | null;
  readonly body: ReactNode;
}): ReactNode {
  const { announcement, body } = props;
  if (announcement === null) return body;
  return (
    <BotAnnouncementBody announcement={announcement}>
      {body}
    </BotAnnouncementBody>
  );
}

/**
 * The card of the questions a bot's row asks, each settlement named as this
 * surface names its members, and the person's own answers kept under the bot
 * (`useBotDraftsStore`) so they outlive the view; without actions until the
 * row is written. A sent answer that the host does not take is given back to
 * edit; one whose question shows settled, or a draft with nothing of the
 * person's left in it, is spent. Discuss takes the draft off the card into
 * the discussion's box.
 */
function BotQuestionCard(props: {
  /** The row, by its message id; `null` before it is written. */
  readonly messageId: string | null;
  readonly question: BotQuestion;
  readonly botTitle: string;
  readonly questions: ChatBotQuestions;
}): ReactElement {
  const { messageId, question, botTitle, questions } = props;
  const { botId, viewerUserId, memberName, answer, discuss } = questions;
  const drafts = useBotDraftsStore((state) => state.answers[botId]);
  const setAnswer = useBotDraftsStore((state) => state.setAnswer);
  const cardQuestions = question.questions.map(
    (item, index): QuestionCardQuestion => ({
      index,
      text: item.text,
      options: item.options,
      allowFreeText: item.allowFreeText,
      settlement: cardSettlement(item.settlement, memberName, viewerUserId),
      draft:
        messageId === null
          ? EMPTY_QUESTION_CARD_DRAFT
          : (drafts?.[answerDraftKey(messageId, index)] ??
            EMPTY_QUESTION_CARD_DRAFT),
    }),
  );
  const spent =
    messageId === null
      ? ""
      : cardQuestions
          .filter(
            (item) =>
              drafts?.[answerDraftKey(messageId, item.index)] !== undefined &&
              questionCardView(item.settlement, item.draft).kind === "settled",
          )
          .map((item) => answerDraftKey(messageId, item.index))
          .join("\n");
  useEffect(() => {
    if (spent.length === 0) return;
    for (const key of spent.split("\n")) setAnswer(botId, key, null);
  }, [botId, setAnswer, spent]);
  const keyOf = (index: number): string | null =>
    messageId === null ? null : answerDraftKey(messageId, index);
  return (
    <QuestionCard
      asker={botTitle}
      questions={cardQuestions}
      onDraft={
        answer === null
          ? null
          : (index, draft) => {
              const key = keyOf(index);
              if (key !== null) setAnswer(botId, key, draft);
            }
      }
      onAnswer={(given) => {
        const key = keyOf(given.questionIndex);
        if (messageId === null || key === null || answer === null) return;
        answer(messageId, given).catch(() => {
          const latest = useBotDraftsStore.getState().answers[botId]?.[key];
          if (latest !== undefined) {
            setAnswer(botId, key, { ...latest, sent: null });
          }
        });
      }}
      onDiscuss={
        messageId === null || discuss === null
          ? null
          : (index, draft) => {
              discuss(messageId, draft);
              setAnswer(botId, answerDraftKey(messageId, index), null);
            }
      }
    />
  );
}

/** A question's settlement as the card names it. */
function cardSettlement(
  settlement: BotQuestion["questions"][number]["settlement"],
  memberName: (userId: string) => string,
  viewerUserId: string | null,
): QuestionCardSettlement | null {
  if (settlement === null) return null;
  return {
    answer: settlement.answer,
    skipped: settlement.skipped,
    by:
      settlement.by.kind === "bot"
        ? { kind: "asker" }
        : {
            kind: "person",
            name: memberName(settlement.by.userId),
            viewer: settlement.by.userId === viewerUserId,
          },
  };
}

/**
 * What a member's post opens from its hover actions: its own thread, or, for
 * a direct post, which has no thread until a member replies under it, the
 * box whose first reply starts one, as under a question. `null` in a thread.
 */
function memberReplyInThread(
  message: ChatMessageModel,
  postId: string,
  presentation: ChatBotPresentation,
): (() => void) | null {
  if (message.conversationRequest?.direct !== true) {
    const open = presentation.openThread;
    return open === null ? null : () => open(postId);
  }
  const open = presentation.openAnnouncementThread;
  return open === null ? null : () => open(postId, false);
}

/**
 * The thread a bot's row opens from its hover actions, and the line of it
 * the row carries: a question's, a proposal's, a row's that asks without
 * waiting, or a direct reply's own thread; for a direct reply where the bot's host does not take replies
 * under one, the thread under the post it answers, with no line here. Any
 * other row of the bot takes none.
 */
function botRowThread(
  message: ChatMessageModel,
  presentation: ChatBotPresentation,
): {
  readonly replyInThread: (() => void) | null;
  readonly threadLine: ChatBotThreadLine | null;
} {
  const kind = message.announcement?.kind ?? null;
  // A row that asks roots its own thread whatever post it follows, as a
  // question announcement does.
  const asks = message.question !== undefined;
  const answer =
    kind === null &&
    !asks &&
    message.repliesTo !== undefined &&
    presentation.answerThreads;
  const ownThread =
    kind === "question" || kind === "proposal" || asks || answer;
  const anchorId = ownThread
    ? message.persistentMessageId
    : (message.repliesTo ?? null);
  const open = presentation.openAnnouncementThread;
  return {
    replyInThread:
      anchorId === null || open === null ? null : () => open(anchorId, answer),
    threadLine:
      !ownThread || anchorId === null || presentation.threadLine === null
        ? null
        : presentation.threadLine(anchorId),
  };
}

/**
 * Slack's message frame: picture on the left, name and time on the first
 * line, and whatever the row carries under it. On a bot's row the picture
 * and the name open the bot's card.
 */
function BotMessageFrame(props: {
  readonly avatar: ReactNode;
  readonly name: string;
  /** A bot's row: its picture and name open its card. */
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
    ...(failed.onEdit === null
      ? []
      : [
          {
            label: "Edit",
            testId: "bot-message-unanswered-edit",
            disabled: false,
            onClick: failed.onEdit,
          },
        ]),
    ...(failed.onSignIn === null
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
 * last one landed, the way into the thread. Unread replies in a thread the
 * viewer took part in show as their count and a bold "N replies". While the bot is
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
      <ThreadLineCount
        replies={replies}
        unread={unread}
        unreadCount={line.unreadCount}
      />
      <ThreadLineStatus
        lastReplyAt={line.lastReplyAt}
        replying={replying}
        botTitle={botTitle}
      />
    </button>
  );
}

/**
 * "N replies", bold behind the unread count while one is unread (a 2 badge
 * before "5 replies" reads two unread of five), or behind a dot where the
 * host does not count.
 */
function ThreadLineCount(props: {
  readonly replies: number;
  readonly unread: boolean;
  readonly unreadCount: number | null;
}): ReactNode {
  const { replies, unread, unreadCount } = props;
  return (
    <>
      {unreadCount === null ? (
        unread && (
          <span
            className="size-2 shrink-0 rounded-full bg-primary"
            data-testid="bot-thread-unread"
            aria-label="Unread replies"
            role="img"
          />
        )
      ) : (
        <UnreadCountBadge
          count={unreadCount}
          size="xs"
          testId="bot-thread-unread-count"
        />
      )}
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

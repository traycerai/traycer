import {
  Fragment,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  ChevronRight,
  MessageSquareText,
  Pencil,
  RotateCcw,
} from "lucide-react";
import {
  BOT_QUESTION_SKIPPED_TEXT,
  botQuestionAnswersText,
  botQuestionsText,
  type BotAnnouncement,
  type BotAnnouncementKind,
  type BotQuestion,
  type BotQuestionAnswerSet,
} from "@traycer/protocol/persistence/epic/messages";
import { BOT_THREAD_ANCHOR_ANSWER } from "@traycer/protocol/host/bot/conversation-schemas";
import { UnreadCountBadge } from "@/components/notifications/unread-count-badge";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@/components/ui/drawer";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { WorkingShimmerText } from "@/components/ui/working-shimmer-text";
import { retrospectiveSheetLinkHostId } from "@/components/settings/move/retrospective-sheet-link-host";
import { SHARED_BY_EARLIER_VERSION_LINE } from "@/components/settings/move/overview-dated-lines";
import { useOpenLink } from "@/lib/links/open-link";
import { useMessageTime, useRelativeTimestamp } from "@/lib/relative-time";
import { formatClockDuration } from "@/lib/format-duration";
import {
  botRowThreadAnchorKind,
  firstLineOf,
} from "@/lib/bots/bot-trunk-model";
import { turnReceiptLabel } from "@/lib/bots/bot-turn-receipt";
import { collectAssistantReplyText } from "@/lib/chat/collect-assistant-reply-text";
import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds";
import { useLongPress, type LongPress } from "@/hooks/ui/use-long-press";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import { cn } from "@/lib/utils";
import {
  AvatarStack,
  BotAvatar,
  PersonAvatar,
} from "@/components/bots/bot-avatars";
import { BotIdentityTrigger } from "@/components/bots/bot-identity-popover";
import { BotSurfaceCard } from "@/components/bots/bot-surface-card";
import { useBotIdentity } from "@/components/bots/bot-identity-context";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type {
  ChatBotFailedRecovery,
  ChatBotFailedRequest,
  ChatBotPresentation,
  ChatBotQuestions,
  ChatBotThreadLine,
  ChatBotTurnReceipt,
} from "./chat-bot-presentation-context";
import { chatFindSegmentUnitId } from "./chat-find";
import { ChatMessageTimestamp } from "./chat-message-timestamp";
import { useTimestampDrawn } from "./use-timestamp-drawn";
import {
  answerDraftKey,
  useBotDraftsStore,
} from "@/stores/bots/bot-drafts-store";
import { QuestionCard, type QuestionCardQuestion } from "./question-card";
import { ChatReplyBadgeSlot } from "./chat-reply-badge";
import {
  EMPTY_QUESTION_CARD_DRAFT,
  botQuestionCardSettlement,
  draftText,
  questionCardView,
} from "./question-card-view";
import { mayHaveReachedHost } from "@traycer-clients/shared/host-transport/host-messenger";
import { NO_TRANSCRIPT_BASELINE } from "@/stores/chats/chat-announcements";
import { TextSegment } from "./segments/text-segment";
import { UserMessageAttachmentGallery } from "./user-message-attachment-gallery";

/**
 * One row of a bot's channel or thread, in Slack's message layout (Tracy
 * Bots, decision 41): the sender's picture, their name and the time, then
 * the text. A member's message carries, in the channel, the line of its
 * thread once the thread has a reply; an announcement carries its kind
 * on a coloured bar, as Slack draws an app's attachment. A question or a
 * proposal carries the line of the thread a member answers it in, and a
 * reply that asks carries its options as buttons. A row that asks without
 * waiting (decision 121) draws the question card in place of its options,
 * under any text beyond its questions' own, and carries its thread's line as a
 * question does. A post that
 * points into a task (T89) draws the surface's card under its text. A bot that
 * answers posts itself (reply mode `direct`) replies in the channel, as a
 * plain row.
 *
 * In the channel, "Reply in thread" is among the row's hover actions, as
 * Slack offers it on every message, and a thread roots on the row it is
 * opened from (decision 114): a member's post, a question or proposal, a
 * direct reply and any other row of the bot each open their own
 * thread, the reply's apart from the post's, and each carries its own
 * thread line. Where the bot's host does not say it takes replies under
 * such a row (`threadAnchorKinds`), a direct reply opens the thread under
 * the post it answers instead, with no line of its own, and any other row
 * of the bot takes no thread. A member's message the bot failed to answer adds Retry and Edit to them, and says under its
 * text that it was not answered and why, with the same actions inline: the
 * agent chat's reason and actions where the bot's session names the post's
 * turn as its last failed attempt, and the receipt of that turn under them.
 *
 * Under every row of the bot a turn wrote, a reply, a question or an
 * announcement, the receipt of that turn (Tracy Bots T86, decision 173):
 * what the turn did and how long it took, or while it runs how long it has
 * been running, always shown. It opens the turn's session, landed on the
 * turn. A row no turn wrote draws none. A touch screen has no hover, and its
 * rows show no actions until pressed: a long press on a row offers its
 * "Reply in thread", the receipt where the row has one, and on a message the
 * bot failed to answer its Retry and Edit, in a sheet instead.
 *
 * A bot's reply that answers a member's message (T165) draws that message's
 * badge above its header, unless the message is the row directly above; a
 * member's answers to a bot's card (T167) draw the card's badge, there too.
 *
 * Without `hoverActions` the row is drawn as the post a thread opens on, at
 * the top of the thread panel: the same row, with nothing on hover and no
 * badge, since the message it answers is in the channel and not above it.
 * `timeLink` makes its time a link that shows the post in its channel, as a
 * Threads card's post does (Tracy Bots T137); `null` leaves the time a label.
 */
export function ChatBotMessage(props: {
  readonly message: ChatMessageModel;
  readonly presentation: ChatBotPresentation;
  readonly hoverActions: boolean;
  readonly timeLink: (() => void) | null;
}): ReactElement {
  const { message, presentation, hoverActions, timeLink } = props;
  const sentAt = message.sentAt ?? message.createdAt;
  const body =
    message.questionAnswers === undefined ? (
      <BotMessageText message={message} />
    ) : (
      <QuestionAnswerList set={message.questionAnswers} />
    );
  if (message.role === "assistant") {
    return (
      <BotRow
        message={message}
        presentation={presentation}
        sentAt={sentAt}
        body={body}
        hoverActions={hoverActions}
        timeLink={timeLink}
      />
    );
  }
  return (
    <MemberRow
      message={message}
      presentation={presentation}
      sentAt={sentAt}
      body={body}
      hoverActions={hoverActions}
      timeLink={timeLink}
    />
  );
}

/**
 * A member's row: their message, why it went unanswered where it did, and
 * the line of its thread.
 */
function MemberRow(props: {
  readonly message: ChatMessageModel;
  readonly presentation: ChatBotPresentation;
  readonly sentAt: number;
  readonly body: ReactNode;
  readonly hoverActions: boolean;
  readonly timeLink: (() => void) | null;
}): ReactElement {
  const { message, presentation, sentAt, body, hoverActions, timeLink } = props;
  const name = message.senderLabel ?? "Member";
  const postId = message.persistentMessageId;
  const threadLine =
    postId === null || presentation.threadLine === null
      ? null
      : presentation.threadLine(postId);
  const replyInThread =
    postId === null ? null : memberReplyInThread(message, postId, presentation);
  const { failed, recovery, failedReceipt } = memberFailureOf(
    message,
    presentation,
  );
  const sheet = useRowSheet(
    hoverActions && memberRowHasAction(replyInThread, failed),
  );
  return (
    <BotMessageFrame
      replyBadge={replyBadgeOf(message, hoverActions)}
      avatar={
        <PersonAvatar
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
      longPress={sheet.longPress}
      timeLink={timeLink}
    >
      <UserMessageAttachmentGallery
        align="start"
        attachments={message.attachments}
        browserAnnotations={message.browserAnnotations}
      />
      {body}
      {failed === null ? null : (
        <UnansweredLine failed={failed} recovery={recovery} />
      )}
      {failedReceipt === null ? null : (
        <TurnReceiptLine receipt={failedReceipt} />
      )}
      {replyInThread === null || !threadStarted(threadLine) ? null : (
        <ThreadLine
          line={threadLine}
          botTitle={presentation.botTitle}
          onOpen={replyInThread}
        />
      )}
      {!sheet.shown ? null : (
        <RowSheet
          open={sheet.open}
          onOpenChange={sheet.setOpen}
          name={name}
          text={message.content}
          replyInThread={replyInThread}
          failed={failed}
          receipt={null}
          botTitle={presentation.botTitle}
        />
      )}
    </BotMessageFrame>
  );
}

/**
 * A member's message drawn outside its own channel or thread - the message a
 * delivery brought into one of the bot's sessions (Tracy Bots T159): the
 * member's row with nothing on hover and `place` under its text. Until the
 * message is read its text is a placeholder, and where it cannot be read the
 * row says so; the row is never empty.
 */
export function ChatBotDeliveredPost(props: {
  readonly message: ChatMessageModel;
  /** `message`: its text is read; `loading`: it is being read; `unavailable`: it cannot be. */
  readonly body: "message" | "loading" | "unavailable";
  /** Where the message was written, and how its turn ended, under it. */
  readonly place: ReactNode;
}): ReactElement {
  const { message, body, place } = props;
  const name = message.senderLabel ?? "Member";
  return (
    <BotMessageFrame
      replyBadge={null}
      avatar={
        <PersonAvatar
          userId={message.senderUserId ?? null}
          name={name}
          avatarUrl={message.senderAvatarUrl ?? null}
          size="lg"
        />
      }
      name={name}
      bot={false}
      sentAt={message.sentAt ?? message.createdAt}
      instanceId={message.id}
      testId="bot-delivered-post"
      hoverActions={false}
      replyInThread={null}
      failed={null}
      longPress={null}
      timeLink={null}
    >
      <UserMessageAttachmentGallery
        align="start"
        attachments={message.attachments}
        browserAnnotations={message.browserAnnotations}
      />
      <DeliveredPostBody message={message} body={body} />
      {place}
    </BotMessageFrame>
  );
}

/** The delivered row's text, or what stands in for it until or unless it is read. */
function DeliveredPostBody(props: {
  readonly message: ChatMessageModel;
  readonly body: "message" | "loading" | "unavailable";
}): ReactElement {
  if (props.body === "loading") {
    return (
      <div
        role="status"
        aria-label="Loading message"
        className="h-4 w-full max-w-64 animate-pulse rounded-sm bg-foreground/10"
        data-testid="bot-delivered-post-loading"
      />
    );
  }
  if (props.body === "unavailable") {
    return (
      <p
        className="text-ui-sm text-muted-foreground"
        data-testid="bot-delivered-post-stand-in"
      >
        Message unavailable
      </p>
    );
  }
  if (props.message.questionAnswers !== undefined) {
    return <QuestionAnswerList set={props.message.questionAnswers} />;
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {props.message.segments.map((segment) =>
        segment.kind === "text" ? (
          <TextSegment
            key={segment.id}
            findUnitId={null}
            markdown={segment.markdown}
            isStreaming={false}
            nextStepActions={null}
          />
        ) : null,
      )}
    </div>
  );
}

/**
 * A member's answers to a bot's card sent together (T167): each question as
 * the card asked it, and under it their answer, or Skipped.
 */
function QuestionAnswerList(props: {
  readonly set: BotQuestionAnswerSet;
}): ReactElement {
  return (
    <dl
      data-testid="bot-question-answers"
      className="flex min-w-0 flex-col gap-1.5"
    >
      {props.set.answers.map((entry) => (
        <div key={entry.questionIndex} className="flex min-w-0 flex-col">
          <dt className="text-ui-xs break-words whitespace-pre-wrap text-muted-foreground">
            {entry.question}
          </dt>
          <dd
            className={
              entry.answer === null
                ? "text-ui-sm text-muted-foreground"
                : "text-ui-sm break-words whitespace-pre-wrap text-foreground"
            }
          >
            {entry.answer ?? BOT_QUESTION_SKIPPED_TEXT}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The badge of the message a row answers (T165), drawn in a channel's or a
 * thread's list (`hoverActions`): a bot's reply names the member's message,
 * and hides it when that message is the row directly above; a member's
 * answers to a bot's card (T167) name the card, and show it there too, as a
 * reply the member chose does. `null` on any other row.
 */
function replyBadgeOf(
  message: ChatMessageModel,
  hoverActions: boolean,
): ReactNode {
  if (!hoverActions) return null;
  if (message.role === "assistant") {
    return message.repliesTo === undefined ? null : (
      <ChatReplyBadgeSlot
        rowMessageId={message.persistentMessageId}
        answeredId={message.repliesTo}
        adjacency="when-apart"
        questionCount={null}
      />
    );
  }
  const answers = message.questionAnswers;
  return answers === undefined ? null : (
    <ChatReplyBadgeSlot
      rowMessageId={message.persistentMessageId}
      answeredId={answers.questionMessageId}
      adjacency="always"
      questionCount={answers.answers.length}
    />
  );
}

/** Whether a member's row has anything for its long-press sheet to offer. */
function memberRowHasAction(
  replyInThread: (() => void) | null,
  failed: FailedMessageActions | null,
): boolean {
  if (replyInThread !== null) return true;
  return failed !== null && (failed.onRetry !== null || failed.onEdit !== null);
}

/**
 * A post the app draws in the bot's voice where the bot has written none (
 * in a team's channel before the team has a host): the bot's picture
 * and name, with no time and no actions, over `children`. It is not a message
 * of the channel: no member wrote it and nothing stores it.
 */
export function ChatBotAppPost(props: {
  readonly name: string;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <BotMessageFrame
      replyBadge={null}
      avatar={<MessageBotAvatar />}
      name={props.name}
      bot={false}
      sentAt={null}
      instanceId={props.testId}
      testId={props.testId}
      hoverActions={false}
      replyInThread={null}
      failed={null}
      longPress={null}
      timeLink={null}
    >
      {props.children}
    </BotMessageFrame>
  );
}

/**
 * A member's message the bot failed to answer: its actions, the agent chat's
 * recovery where the session names the post's turn, and that turn's receipt;
 * all `null` on any other message.
 */
function memberFailureOf(
  message: ChatMessageModel,
  presentation: ChatBotPresentation,
): {
  readonly failed: FailedMessageActions | null;
  readonly recovery: ChatBotFailedRecovery | null;
  readonly failedReceipt: ChatBotTurnReceipt | null;
} {
  const requestId = message.conversationRequest?.requestId ?? null;
  const recovery =
    requestId === null || presentation.failedRecovery === null
      ? null
      : presentation.failedRecovery(requestId);
  const failed = failedActionsOf(message, presentation, recovery);
  const failedReceipt =
    failed === null ||
    requestId === null ||
    presentation.requestReceipt === null
      ? null
      : presentation.requestReceipt(requestId);
  return { failed, recovery, failedReceipt };
}

/**
 * Why a member's message the bot failed to answer was not answered, and its
 * Retry and Edit bound to the message's text; `null` on any other. A held
 * (parked) answer offers Retry alone, on the line and on hover alike. Where
 * the agent chat's actions recover the turn (`recovery`), they stand in for
 * the bot's Retry and Sign in, and Edit stays.
 */
function failedActionsOf(
  message: ChatMessageModel,
  presentation: ChatBotPresentation,
  recovery: ChatBotFailedRecovery | null,
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
  const { retry } = failed;
  // Edit puts the text back in the box and its send replaces the row. The
  // box holds an image's bytes, the row only its hash, so a row with images
  // keeps Retry, which re-sends them, and offers no Edit that would drop them.
  const edit = message.attachments.length === 0 ? failed.edit : null;
  const parked = failed.state === "parked";
  if (recovery !== null) {
    return {
      state: failed.state,
      summary: recovery.label,
      onSignIn: null,
      onUpdate: null,
      updating: false,
      updateFailure: null,
      onRetry: null,
      retrying: false,
      onEdit: edit === null ? null : () => edit(message.content),
    };
  }
  return {
    state: failed.state,
    summary: failed.summary,
    onSignIn: parked ? null : failed.signIn,
    onUpdate: parked ? null : failed.update,
    updating: failed.updating,
    updateFailure: parked ? null : failed.updateFailure,
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
  readonly timeLink: (() => void) | null;
}): ReactElement {
  const { message, presentation, sentAt, body, hoverActions, timeLink } = props;
  const announcement = message.announcement ?? null;
  const question = message.question ?? null;
  const questions = question === null ? null : presentation.questions;
  const { replyInThread, threadLine } = botRowThread(message, presentation);
  const receipt = replyReceiptFor(message, presentation);
  const sheet = useRowSheet(
    hoverActions && (receipt !== null || replyInThread !== null),
  );
  return (
    <BotMessageFrame
      replyBadge={replyBadgeOf(message, hoverActions)}
      avatar={<MessageBotAvatar />}
      name={presentation.botTitle}
      bot
      sentAt={sentAt}
      instanceId={message.id}
      testId={announcement === null ? "bot-reply-row" : "bot-announcement"}
      hoverActions={hoverActions}
      replyInThread={replyInThread}
      failed={null}
      longPress={sheet.longPress}
      timeLink={timeLink}
    >
      {question !== null && questions !== null ? (
        <BotAskingBody
          message={message}
          question={question}
          questions={questions}
          botTitle={presentation.botTitle}
          text={<BotRowBody announcement={announcement} body={body} />}
        />
      ) : (
        <BotRowBody announcement={announcement} body={body} />
      )}
      {message.surface === undefined ? null : (
        <BotSurfaceCard
          messageId={message.persistentMessageId}
          surface={message.surface}
          postText={message.content}
        />
      )}
      {message.options === undefined || questions !== null ? null : (
        <ReplyOptions
          options={message.options}
          onChoose={presentation.chooseOption}
        />
      )}
      {receipt === null ? null : <TurnReceiptLine receipt={receipt} />}
      {replyInThread === null || !threadStarted(threadLine) ? null : (
        <ThreadLine
          line={threadLine}
          botTitle={presentation.botTitle}
          onOpen={replyInThread}
        />
      )}
      {!sheet.shown ? null : (
        <RowSheet
          open={sheet.open}
          onOpenChange={sheet.setOpen}
          name={presentation.botTitle}
          text={message.content}
          replyInThread={replyInThread}
          failed={null}
          receipt={receipt}
          botTitle={presentation.botTitle}
        />
      )}
    </BotMessageFrame>
  );
}

/**
 * A touch screen has no hover to reveal a row's actions with: a long press
 * of a finger or a pen on the row offers them in a sheet. `longPress` is `null` where the row
 * offers none (`enabled` false). `shown` holds from the first long press
 * on, so a channel mounts a sheet only for the rows someone pressed.
 */
function useRowSheet(enabled: boolean): {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly longPress: LongPress | null;
  readonly shown: boolean;
} {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const longPress = useLongPress({
    onLongPress: () => {
      setShown(true);
      setOpen(true);
    },
    disabled: !enabled,
    acceptsMouse: false,
    acceptsPen: true,
  });
  return {
    open,
    setOpen,
    longPress: enabled ? longPress : null,
    shown: enabled && shown,
  };
}

/** The receipt under a row of the bot, by the turn that wrote it; `null` where none did. */
function replyReceiptFor(
  message: ChatMessageModel,
  presentation: ChatBotPresentation,
): ChatBotTurnReceipt | null {
  if (presentation.replyReceipt === null) return null;
  return presentation.replyReceipt(replyMessageIdsOf(message));
}

/** The message ids a bot's row carries: its own, and every record of its turn. */
function replyMessageIdsOf(message: ChatMessageModel): ReadonlyArray<string> {
  const ids = message.turnMessageIds ?? [];
  const own = message.persistentMessageId;
  return own === null || ids.includes(own) ? ids : [own, ...ids];
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
 * A row that asks: the card, under its text when that says more than its
 * questions. The text is the row's whole text, as its segments carry it:
 * `content` is the list's short, whitespace-folded preview, which stops
 * matching the questions once they run long or over more than one line.
 */
function BotAskingBody(props: {
  readonly message: ChatMessageModel;
  readonly question: BotQuestion;
  readonly questions: ChatBotQuestions;
  readonly botTitle: string;
  readonly text: ReactNode;
}): ReactElement {
  const { message, question, questions, botTitle, text } = props;
  return (
    <>
      {collectAssistantReplyText(message.segments) ===
      botQuestionsText(question.questions).trim()
        ? null
        : text}
      <BotQuestionCard
        messageId={message.persistentMessageId}
        question={question}
        botTitle={botTitle}
        questions={questions}
      />
    </>
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
 *
 * On a card of two or more questions whose answers go together (`answerAll`,
 * T167), one Submit sends them all. A send the host refused gives them all
 * back. One that ended without saying whether it reached the host waits,
 * nothing sent again, for the transcript's next baseline, from this session
 * store or the one that replaced it: settled by then, the answers are spent;
 * still open, they are given back to edit as they were.
 */
function BotQuestionCard(props: {
  /** The row, by its message id; `null` before it is written. */
  readonly messageId: string | null;
  readonly question: BotQuestion;
  readonly botTitle: string;
  readonly questions: ChatBotQuestions;
}): ReactElement {
  const { messageId, question, botTitle, questions } = props;
  const {
    botId,
    viewerUserId,
    memberName,
    answer,
    answerAll,
    baseline,
    discuss,
  } = questions;
  const drafts = useBotDraftsStore((state) => state.answers[botId]);
  const setAnswer = useBotDraftsStore((state) => state.setAnswer);
  const cardQuestions = question.questions.map(
    (item, index): QuestionCardQuestion => ({
      index,
      text: item.text,
      options: item.options,
      allowFreeText: item.allowFreeText,
      // Absent from a host below `chat.subscribe@1.43`: one pick.
      several: item.multiSelect === true,
      settlement: botQuestionCardSettlement(
        item.settlement,
        memberName,
        viewerUserId,
      ),
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
              questionCardView(item.settlement, item.draft, item.several)
                .kind === "settled",
          )
          .map((item) => answerDraftKey(messageId, item.index))
          .join("\n");
  useEffect(() => {
    if (spent.length === 0) return;
    for (const key of spent.split("\n")) setAnswer(botId, key, null);
  }, [botId, setAnswer, spent]);
  // A baseline from another session store is a later one too: the registry
  // replaced the store, whose epochs start again, and its snapshot is new.
  const resynced =
    messageId === null ||
    baseline === null ||
    baseline.epoch === NO_TRANSCRIPT_BASELINE
      ? ""
      : cardQuestions
          .filter((item) => {
            const since =
              drafts?.[answerDraftKey(messageId, item.index)]?.unsureSince ??
              null;
            return (
              item.settlement === null &&
              since !== null &&
              (since.store !== baseline.store || since.epoch !== baseline.epoch)
            );
          })
          .map((item) => answerDraftKey(messageId, item.index))
          .join("\n");
  useEffect(() => {
    if (resynced.length === 0) return;
    for (const key of resynced.split("\n")) {
      const latest = useBotDraftsStore.getState().answers[botId]?.[key];
      if (latest !== undefined) {
        setAnswer(botId, key, { ...latest, sent: null, unsureSince: null });
      }
    }
  }, [botId, resynced, setAnswer]);
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
              if (key !== null) {
                setAnswer(botId, key, { ...draft, unsureSince: null });
              }
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
      onAnswerAll={
        // A card of one question keeps its own Submit and Skip, and `answer`.
        answerAll === null ||
        messageId === null ||
        baseline === null ||
        question.questions.length < 2
          ? null
          : (entries) => {
              const sentUnder = baseline;
              const text = botQuestionAnswersText(
                entries.map((entry) => {
                  const item = cardQuestions.find(
                    (candidate) => candidate.index === entry.questionIndex,
                  );
                  return {
                    questionIndex: entry.questionIndex,
                    question: item?.text ?? "",
                    answer:
                      entry.skipped || item === undefined
                        ? null
                        : draftText(item.draft, item.several),
                    skipped: entry.skipped,
                  };
                }),
              );
              answerAll(messageId, { entries, text }).catch(
                (error: unknown) => {
                  const unsure = mayHaveReachedHost(error);
                  const current =
                    useBotDraftsStore.getState().answers[botId] ?? {};
                  for (const entry of entries) {
                    const key = answerDraftKey(messageId, entry.questionIndex);
                    const latest = current[key];
                    if (latest === undefined) continue;
                    setAnswer(
                      botId,
                      key,
                      unsure
                        ? { ...latest, unsureSince: sentUnder }
                        : { ...latest, sent: null },
                    );
                  }
                },
              );
            }
      }
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
  return open === null ? null : () => open(postId, null);
}

/**
 * The thread a bot's row opens from its hover actions, and the line of it
 * the row carries: every row of the bot roots its own thread - a question,
 * a proposal and a row that asks without waiting on any host, a direct
 * reply and any other row where the bot's host names that row among
 * its thread anchors. A direct reply whose host does not opens the thread
 * under the post it answers, with no line here; any other row then takes
 * none.
 */
function botRowThread(
  message: ChatMessageModel,
  presentation: ChatBotPresentation,
): {
  readonly replyInThread: (() => void) | null;
  readonly threadLine: ChatBotThreadLine | null;
} {
  const anchorKind = botRowThreadAnchorKind({
    announcementKind: message.announcement?.kind ?? null,
    asksQuestion: message.question !== undefined,
    repliesToPost: message.repliesTo !== undefined,
  });
  const ownThread =
    anchorKind === null || presentation.threadAnchorKinds.includes(anchorKind);
  let anchorId: string | null = message.persistentMessageId;
  if (!ownThread) {
    anchorId =
      anchorKind === BOT_THREAD_ANCHOR_ANSWER
        ? (message.repliesTo ?? null)
        : null;
  }
  const open = presentation.openAnnouncementThread;
  return {
    replyInThread:
      anchorId === null || open === null
        ? null
        : () => open(anchorId, ownThread ? anchorKind : null),
    threadLine:
      !ownThread || anchorId === null || presentation.threadLine === null
        ? null
        : presentation.threadLine(anchorId),
  };
}

/**
 * The bot's picture beside its message: its mascot a size under a person's
 * picture, in the middle of the same box, so a bot's rows and a person's
 * keep one text column.
 */
function MessageBotAvatar(): ReactElement {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center">
      <BotAvatar size="default" />
    </span>
  );
}

/**
 * Slack's message frame: picture on the left, name and time on the first
 * line, and whatever the row carries under it; above them, the badge of the
 * message a reply answers (T165). On a bot's row the picture and the name
 * open the bot's card.
 */
function BotMessageFrame(props: {
  /** The answered message's badge, which may draw nothing; `null` for a row that answers none. */
  readonly replyBadge: ReactNode;
  readonly avatar: ReactNode;
  readonly name: string;
  /** A bot's row: its picture and name open its card. */
  readonly bot: boolean;
  /** When the message was sent; `null` for a post the app draws, which has no time. */
  readonly sentAt: number | null;
  /** Names the time stamp for the layout editor; a message id. */
  readonly instanceId: string;
  readonly testId: string;
  /** Whether the row offers its actions on hover; the post a thread opens on does not. */
  readonly hoverActions: boolean;
  /** Opens the row's thread, from its hover actions; `null` for a row that takes none. */
  readonly replyInThread: (() => void) | null;
  /** Retry and Edit, among the hover actions of a message the bot failed to answer. */
  readonly failed: FailedMessageActions | null;
  /** A long press that opens the row's sheet on a touch screen; `null` for a row with none. */
  readonly longPress: LongPress | null;
  /** Shows the row in its channel, from its time; `null` leaves the time a label. */
  readonly timeLink: (() => void) | null;
  readonly children: ReactNode;
}): ReactElement {
  const nameClassName = "truncate text-ui-sm font-semibold text-foreground";
  // A bot's card needs the surface's bot; outside one the row is plain.
  const identity = useBotIdentity();
  const carded = props.bot && identity !== null;
  const { longPress } = props;
  return (
    <div
      data-testid={props.testId}
      className="group/message relative flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 transition-colors hover:bg-foreground/3"
      {...longPress?.handlers}
      // The click a long press ends with opened the sheet already; it does
      // not also reach what was under the finger.
      onClickCapture={
        longPress === null
          ? undefined
          : (event) => {
              if (!longPress.consumedTap()) return;
              event.preventDefault();
              event.stopPropagation();
            }
      }
    >
      {props.replyBadge}
      <div className="flex w-full gap-2">
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
            {props.sentAt === null ? null : (
              <RowTime
                sentAt={props.sentAt}
                instanceId={props.instanceId}
                link={props.timeLink}
              />
            )}
          </div>
          {props.children}
        </div>
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
 * A row's time; a link where it shows the row in its channel (`link`), and
 * only while the time is drawn, so a hidden stamp leaves no empty tab stop.
 */
function RowTime(props: {
  readonly sentAt: number;
  readonly instanceId: string;
  readonly link: (() => void) | null;
}): ReactElement {
  const drawn = useTimestampDrawn(props.sentAt);
  const time = (
    <ChatMessageTimestamp
      timestamp={props.sentAt}
      separated={false}
      instanceId={props.instanceId}
    />
  );
  if (props.link === null || !drawn) return time;
  return (
    <RowTimeLink sentAt={props.sentAt} onClick={props.link}>
      {time}
    </RowTimeLink>
  );
}

/**
 * The time as a link, named for the time it shows and for what it does. Its
 * own leaf, as the stamp is, so the minute tick the name reads repaints only
 * this link.
 */
function RowTimeLink(props: {
  readonly sentAt: number;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactElement {
  const time = useMessageTime(props.sentAt);
  return (
    <button
      type="button"
      aria-label={`${time}, show in channel`}
      className="rounded-sm text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      data-testid="bot-row-time-link"
      onClick={props.onClick}
    >
      {props.children}
    </button>
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
  readonly onUpdate: (() => void) | null;
  readonly updating: boolean;
  readonly updateFailure: string | null;
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
  /** The agent chat's actions for the failed turn, drawn under the line; `null` for the bot's own. */
  readonly recovery: ChatBotFailedRecovery | null;
}): ReactElement {
  const { failed, recovery } = props;
  const parked = failed.state === "parked";
  const actions: ReadonlyArray<{
    readonly label: string;
    readonly testId: string;
    readonly disabled: boolean;
    /** Its work is running: the label stays and dots follow it. */
    readonly pending: boolean;
    readonly onClick: () => void;
  }> = [
    ...(failed.onRetry === null
      ? []
      : [
          {
            label: "Retry",
            testId: "bot-message-unanswered-retry",
            disabled: failed.retrying,
            pending: false,
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
            pending: false,
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
            pending: false,
            onClick: failed.onSignIn,
          },
        ]),
    ...(failed.onUpdate === null
      ? []
      : [
          {
            label: "Update",
            testId: "bot-message-unanswered-update",
            disabled: failed.updating,
            pending: failed.updating,
            onClick: failed.onUpdate,
          },
        ]),
  ];
  const line = (
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
            {action.pending ? (
              <AgentSpinningDots
                className={undefined}
                testId={`${action.testId}-pending`}
                variant={undefined}
              />
            ) : null}
          </button>
        </Fragment>
      ))}
    </p>
  );
  const updateFailure =
    failed.updateFailure === null ? null : (
      <p
        data-testid="bot-message-update-failure"
        role="alert"
        className="text-ui-xs break-words whitespace-pre-wrap text-destructive"
      >
        {failed.updateFailure}
      </p>
    );
  if (recovery === null && updateFailure === null) return line;
  return (
    <div data-testid="bot-message-recovery" className="flex flex-col">
      {line}
      {updateFailure}
      {recovery?.actions}
    </div>
  );
}

/**
 * The receipt under a row of the bot, or under a post the bot did not
 * answer: the turn's activity and how long it took, or while it runs how
 * long it has been running, in the muted style of the row's time, as a
 * Slack app's footer sits under its attachment; it opens the turn. Always
 * shown, at rest and on a touch screen alike.
 */
function TurnReceiptLine(props: {
  readonly receipt: ChatBotTurnReceipt;
}): ReactElement {
  const { receipt } = props;
  const label = turnReceiptLabel(receipt);
  return (
    <button
      type="button"
      data-testid="bot-turn-receipt"
      data-running={receipt.endedAt === null ? "true" : "false"}
      onClick={receipt.open}
      className="-ml-1 flex w-fit max-w-full items-center gap-1 rounded-md px-1 py-0.5 text-left text-ui-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="min-w-0 truncate">
        {label ?? <RunningFor startedAt={receipt.startedAt} />}
      </span>
      <ChevronRight aria-hidden="true" className="size-3 shrink-0" />
    </button>
  );
}

/** How long a running turn has been running, counting each second. */
export function RunningFor(props: {
  readonly startedAt: number;
}): ReactElement {
  const seconds = useElapsedSeconds(props.startedAt, 0, null);
  return <span className="tabular-nums">{formatClockDuration(seconds)}</span>;
}

/**
 * The sheet a long press on a row opens on a touch screen, which has no
 * hover to show the row's actions with: Retry and Edit on a message the bot
 * failed to answer, "Reply in thread" where the row takes one, and on a reply
 * "How Tracy answered", with the receipt's label.
 */
function RowSheet(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Who wrote the row. */
  readonly name: string;
  readonly text: string;
  readonly replyInThread: (() => void) | null;
  readonly failed: FailedMessageActions | null;
  readonly receipt: ChatBotTurnReceipt | null;
  readonly botTitle: string;
}): ReactElement {
  const { open, onOpenChange, botTitle, replyInThread, failed, receipt } =
    props;
  const onRetry = failed?.onRetry ?? null;
  const onEdit = failed?.onEdit ?? null;
  // The drawer portals to <body>; re-assert the theme there, as every sheet
  // does.
  const { resolvedTheme, themePreset } = useResolvedTheme();
  const label = receipt === null ? null : turnReceiptLabel(receipt);
  const itemClassName =
    "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-start text-ui-sm text-foreground transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-foreground/8";
  return (
    <Drawer direction="bottom" open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        data-testid="bot-reply-sheet"
        data-theme={themePreset}
        className={cn(resolvedTheme === "dark" && "dark")}
      >
        <div className="flex flex-col border-b border-canvas-border/70 p-4">
          <DrawerTitle>{props.name}</DrawerTitle>
          <DrawerDescription>{firstLineOf(props.text) ?? ""}</DrawerDescription>
        </div>
        <div className="flex flex-col px-2 pt-1 pb-safe-bottom-gutter">
          {onRetry === null ? null : (
            <button
              type="button"
              data-testid="bot-reply-sheet-retry"
              className={cn(itemClassName, "disabled:opacity-50")}
              disabled={failed?.retrying === true}
              onClick={() => {
                onOpenChange(false);
                onRetry();
              }}
            >
              <RotateCcw aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0 truncate">Retry</span>
            </button>
          )}
          {onEdit === null ? null : (
            <button
              type="button"
              data-testid="bot-reply-sheet-edit"
              className={itemClassName}
              onClick={() => {
                onOpenChange(false);
                onEdit();
              }}
            >
              <Pencil aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0 truncate">Edit</span>
            </button>
          )}
          {replyInThread === null ? null : (
            <button
              type="button"
              data-testid="bot-reply-sheet-reply-in-thread"
              className={itemClassName}
              onClick={() => {
                onOpenChange(false);
                replyInThread();
              }}
            >
              <MessageSquareText
                aria-hidden="true"
                className="size-4 shrink-0"
              />
              <span className="min-w-0 truncate">Reply in thread</span>
            </button>
          )}
          {receipt === null ? null : (
            <button
              type="button"
              data-testid="bot-reply-sheet-receipt"
              className={itemClassName}
              onClick={() => {
                onOpenChange(false);
                receipt.open();
              }}
            >
              <span className="min-w-0 truncate">
                {`How ${botTitle} answered · `}
                {label ?? <RunningFor startedAt={receipt.startedAt} />}
              </span>
            </button>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * Slack's message actions, floating at the row's top right while it is
 * hovered or one of them has keyboard focus. A touch screen has no hover,
 * so its rows show no actions at rest and offer them on a long press.
 */
function MessageActions(props: {
  readonly onReplyInThread: (() => void) | null;
  readonly failed: FailedMessageActions | null;
}): ReactElement {
  const { onReplyInThread, failed } = props;
  return (
    <div
      data-testid="bot-message-actions"
      className="pointer-events-none absolute top-1 right-2 z-10 flex items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5 opacity-0 shadow-sm transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
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
  // Rows a released host wrote before announcements stopped asking; no
  // current host writes one.
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
      data-new-replies={line.newReplies === true ? "true" : "false"}
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
        bold={line.newReplies ?? unread}
        unreadCount={line.unreadCount}
      />
      {line.newReplies === true ? (
        <span
          className="shrink-0 font-semibold text-foreground"
          data-testid="bot-thread-new-replies"
        >
          new replies
        </span>
      ) : null}
      {line.followedUnwritten ? (
        <span
          className="shrink-0 text-muted-foreground"
          data-testid="bot-thread-following-mark"
        >
          following
        </span>
      ) : null}
      <ThreadLineStatus
        lastReplyAt={line.lastReplyAt}
        replying={replying}
        botTitle={botTitle}
      />
    </button>
  );
}

/**
 * "N replies" behind the unread count while one is unread (a 2 badge before
 * "5 replies" reads two unread of five), or behind a dot where the host does
 * not count; bold while a followed thread has new replies, or, where the
 * host keeps no read cursors, while unread.
 */
function ThreadLineCount(props: {
  readonly replies: number;
  readonly unread: boolean;
  readonly bold: boolean;
  readonly unreadCount: number | null;
}): ReactNode {
  const { replies, unread, bold, unreadCount } = props;
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
          corner={null}
          noun="unread"
        />
      )}
      {replies === 0 ? null : (
        <span
          className={cn("text-primary", bold ? "font-bold" : "font-semibold")}
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

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ChatBotMessage } from "@/components/chat/chat-bot-message";
import { BotAvatar } from "@/components/bots/bot-avatars";
import { BotChatTranscript } from "@/components/bots/bot-chat-transcript";
import { useBotFailedRecovery } from "@/components/bots/bot-failed-recovery";
import { BotRoutingCard } from "@/components/bots/bot-routing-card";
import { useBotTurnLocateQuery } from "@/hooks/bots/use-bot-turn-locate-query";
import { botTurnIndexOf } from "@/lib/bots/bot-turn-receipt";
import {
  BotMessageComposer,
  type BotComposerEdit,
  type BotComposerSeed,
  type BotKeptDraft,
} from "@/components/bots/bot-message-composer";
import {
  useBotSendFailure,
  type BotSendFailure,
} from "@/hooks/bots/use-bot-send-failure";
import {
  BotQueuedNotice,
  BotSendFailedNotice,
} from "@/components/bots/bot-channel-notices";
import { BotReadFailure } from "@/components/bots/bot-read-failure";
import { BotReplyingStrip } from "@/components/bots/bot-replying-strip";
import { BotTaskList } from "@/components/bots/bot-task-list";
import { ChannelPost } from "@/components/bots/bot-channel-post";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useBotConversationSendMutation } from "@/hooks/bots/use-bot-mutations";
import { useBotSendTakesAnswers } from "@/hooks/bots/use-bot-send-version";
import {
  failedOn,
  failedOnRequest,
  useBotActivity,
} from "@/hooks/bots/use-bot-activity";
import { useBotFailedRequest } from "@/hooks/bots/use-bot-failed-request";
import type { QuestionAnswerSend } from "@/components/bots/bot-chat-transcript";
import type {
  ChatBotPresentation,
  ChatBotQuestions,
  ChatBotTurnReceipt,
} from "@/components/chat/chat-bot-presentation-context";
import { tasksOfThread } from "@/lib/bots/bot-trunk-model";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import { threadOriginRow } from "@/lib/bots/reply-row";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import type {
  BotSessionOpen,
  BotTurnOpen,
} from "@/stores/bots/bot-open-thread-store";
import type { BotSentPost } from "@/stores/bots/bot-open-thread-store";
import { cn } from "@/lib/utils";

/**
 * The open post's thread as the channel's thread list has it: listed; not
 * listed yet but known by its id, as a thread the person's post opened as it
 * was sent is until the next read; not listed yet, as a just-posted thread
 * opened from its row is; not opened yet, a question, proposal, direct post
 * or direct reply nobody has replied under; or unknown, because the read
 * failed.
 *
 * `sendable` says whether a thread with a box takes a send - a reply, a
 * picked option, a retry or an edit: `false` while its post is the bot's
 * direct reply and the bot's binding does not open a thread under one. The
 * box and its draft stay.
 */
export type BotThreadPanelThread =
  | {
      readonly kind: "listed";
      readonly thread: BotThreadSummary;
      /**
       * The list's last read failed, and this is what it returned before:
       * Retry reads it again. `null` while it has not failed.
       */
      readonly retry: (() => void) | null;
      readonly sendable: boolean;
    }
  | {
      readonly kind: "posted";
      readonly threadId: string;
      /** The list's read failed: Retry reads it again. `null` while it has not. */
      readonly retry: (() => void) | null;
      readonly sendable: boolean;
    }
  | { readonly kind: "pending" }
  | {
      readonly kind: "unopened";
      /** As for `posted`: the box and its draft stay through a failed read. */
      readonly retry: (() => void) | null;
      readonly sendable: boolean;
    }
  | { readonly kind: "failed"; readonly retry: () => void };

/**
 * A thread of a bot's channel, in Slack's thread panel (Tracy Bots): the
 * header names the thread and its channel, the post it opens on sits on top,
 * as the channel draws it, in every state (decision 90), then the replies -
 * the thread record in the ordinary message list - and a box that replies in
 * the thread. With no reply yet, the box follows the post.
 *
 * "Activity" opens the bot's Activity tab, where the thread's work is listed
 * with the rest of the bot's (decision 115).
 *
 * A message of the thread the bot failed to answer is retried as it is, or
 * edited in the thread's box; the post the thread opens on is edited in the
 * channel's box (`onEditPost`), since its replacement is a new post.
 *
 * A reply's receipt, and a failed post's, opens its turn's session in place
 * of the channel (`onOpenTurn`), and "Thread session" in the header opens the
 * thread's session there (`onOpenSession`), read-only (T93). The thread
 * session's routing card sits above the panel's box.
 *
 * A question card in the thread answers in the thread. A member whose answer
 * someone else's overtook takes it to the discussion: the thread's box, with
 * their draft in it unsent - a question's own thread for a question in the
 * channel, this thread for one asked here. What the box holds is kept under
 * the bot (`useBotDraftsStore`), so it outlives the panel, until it is sent.
 */
export function BotThreadPanel(props: {
  readonly botId: string;
  /** The host serving the tab: reads and sends go to it. */
  readonly hostId: string;
  /** The host that runs the bot, where a signed-out provider is signed in again; `null` when none does. */
  readonly boundHostId: string | null;
  readonly botTitle: string;
  /** The channel the thread's post is in. */
  readonly conversationId: string;
  /** The post the thread opens on, by its message id. */
  readonly originMessageId: string;
  /** That post as the person sent it, when its send opened the thread; `null` otherwise. */
  readonly sent: BotSentPost | null;
  readonly thread: BotThreadPanelThread;
  /** The bot's tasks: the panel lists the ones this thread set up. */
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  /** The viewer's own name for their posts, as the channel shows them. */
  readonly anchorSenderLabel: (senderUserId: string | null) => string;
  readonly resolveMember: BotMemberResolver;
  readonly onClose: () => void;
  readonly onOpenActivity: () => void;
  readonly onEditPost: (edit: BotComposerEdit) => void;
  /** Opens a turn of the bot: its session, in place of the channel. */
  readonly onOpenTurn: BotTurnOpen;
  /** Opens the thread's session in place of the channel. */
  readonly onOpenSession: BotSessionOpen;
}): ReactNode {
  const { botTitle, onClose, onOpenActivity, onOpenSession } = props;
  const thread = props.thread.kind === "listed" ? props.thread.thread : null;
  const threadId =
    props.thread.kind === "posted"
      ? props.thread.threadId
      : (thread?.threadId ?? null);
  // A send from the panel that fails, a retry of its post included, says so
  // in the panel's box.
  const sendFailure = useBotSendFailure();
  return (
    <section
      aria-label="Thread"
      data-testid="bot-thread-panel"
      data-thread-id={threadId ?? undefined}
      className="flex min-h-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="text-ui-md font-semibold text-foreground">Thread</h2>
          <span
            className="flex min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground"
            data-testid="bot-thread-channel"
          >
            <span aria-hidden="true">·</span>
            <BotAvatar size="xs" />
            <span className="truncate">{botTitle}</span>
          </span>
        </div>
        {thread === null ? null : (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="bot-thread-session"
            onClick={() =>
              onOpenSession({
                chatId: thread.sessionChatId,
                threadId: thread.threadId,
                messageId: null,
              })
            }
          >
            Thread session
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid="bot-thread-activity"
          onClick={onOpenActivity}
        >
          Activity
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close thread"
          data-testid="bot-thread-close"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      <ThreadOrigin {...props} sendFailure={sendFailure} />
      {threadId === null ? null : (
        <ThreadTasks
          botId={props.botId}
          hostId={props.hostId}
          threadId={threadId}
          thread={thread}
          tasks={props.tasks}
        />
      )}
      <ThreadPanelBody {...props} sendFailure={sendFailure} />
    </section>
  );
}

type ThreadPanelBodyProps = {
  readonly botId: string;
  readonly hostId: string;
  readonly boundHostId: string | null;
  readonly botTitle: string;
  readonly conversationId: string;
  readonly originMessageId: string;
  readonly sent: BotSentPost | null;
  readonly thread: BotThreadPanelThread;
  readonly anchorSenderLabel: (senderUserId: string | null) => string;
  readonly resolveMember: BotMemberResolver;
  readonly onEditPost: (edit: BotComposerEdit) => void;
  readonly onOpenTurn: BotTurnOpen;
  readonly sendFailure: BotSendFailure;
};

/**
 * The post the thread opens on, drawn by the row the channel draws it with,
 * nothing on hover: its writer, its time and its text, read from the
 * channel's row (fetched when the channel has not loaded it), and the line
 * under it while the bot failed to answer it, whose Retry posts it again in
 * the channel and whose Edit hands it to the channel's box. Until the
 * channel's row is there the post is drawn as the person sent it, or with no
 * text from the thread list, and the line says why with no Retry or Edit.
 * A send the host queued says so under the post until its row lands, which
 * is the bot's host taking it. Nothing while the post is neither loaded,
 * sent from here nor listed.
 */
function ThreadOrigin(props: ThreadPanelBodyProps): ReactNode {
  const {
    botId,
    hostId,
    boundHostId,
    botTitle,
    conversationId,
    originMessageId,
    sent,
    anchorSenderLabel,
    resolveMember,
    onEditPost,
    onOpenTurn,
    sendFailure,
  } = props;
  const client = useTabHostClient();
  const activity = useBotActivity(botId);
  const failedOnPost = useCallback(
    (requestId: string) => failedOnRequest(activity, requestId),
    [activity],
  );
  // The post's turn, while the bot failed to answer it: its receipt, and the
  // agent chat's reason and actions where the thread's session names it as
  // its last failed attempt.
  const listed = props.thread.kind === "listed" ? props.thread.thread : null;
  const originRequestId = listed?.anchor?.requestId ?? sent?.requestId ?? null;
  const failedOrigin =
    originRequestId !== null && failedOnPost(originRequestId) !== null
      ? [originRequestId]
      : NO_IDS;
  const located = useBotTurnLocateQuery({
    client,
    hostId,
    botId,
    messageIds: NO_IDS,
    requestIds: failedOrigin,
    turns: NO_TURN_KEYS,
  });
  const turnIndex = useMemo(
    () => botTurnIndexOf(located.data?.turns),
    [located.data],
  );
  const turnOfRequest = useCallback(
    (requestId: string) => turnIndex.byRequestId.get(requestId) ?? null,
    [turnIndex],
  );
  const failedRecovery = useBotFailedRecovery({
    botId,
    hostId,
    sessionChatId: listed?.sessionChatId ?? null,
    turnOfRequest,
  });
  const requestReceipt = useCallback(
    (requestId: string): ChatBotTurnReceipt | null => {
      const ref = turnOfRequest(requestId);
      if (ref === null) return null;
      return {
        summary: ref.summary,
        startedAt: ref.startedAt,
        endedAt: ref.endedAt,
        open: () => onOpenTurn(ref),
      };
    },
    [onOpenTurn, turnOfRequest],
  );
  const failedRequest = useBotFailedRequest({
    client,
    hostId,
    boundHostId,
    botId,
    conversationId,
    threadId: null,
    failedOn: failedOnPost,
    onEdit: onEditPost,
    failure: sendFailure,
  });
  const viewerUserId = useAuthStore((state) => state.profile?.userId ?? null);
  const questions = useMemo<ChatBotQuestions>(
    () => ({
      botId,
      viewerUserId,
      memberName: anchorSenderLabel,
      answer: null,
      discuss: null,
    }),
    [anchorSenderLabel, botId, viewerUserId],
  );
  const turns = useMemo(
    () => ({ failedRecovery, requestReceipt }),
    [failedRecovery, requestReceipt],
  );
  const loadedPresentation = useMemo(
    () => originPresentation(botTitle, questions, failedRequest, turns),
    [botTitle, failedRequest, questions, turns],
  );
  const unloadedPresentation = useMemo(
    () =>
      originPresentation(
        botTitle,
        questions,
        (requestId, senderUserId) => {
          const failed = failedRequest(requestId, senderUserId);
          return failed === null
            ? null
            : { ...failed, retry: null, edit: null };
        },
        { failedRecovery: null, requestReceipt: turns.requestReceipt },
      ),
    [botTitle, failedRequest, questions, turns],
  );
  const anchor =
    props.thread.kind === "listed" ? props.thread.thread.anchor : null;
  const senderAvatarUrl = useCallback(
    (senderUserId: string) => resolveMember(senderUserId)?.avatarUrl ?? null,
    [resolveMember],
  );
  return (
    <ChannelPost
      botId={botId}
      hostId={hostId}
      conversationId={conversationId}
      messageId={originMessageId}
      fetchCold
    >
      {(post) => {
        const origin = threadOriginRow({
          messageId: originMessageId,
          post,
          sent,
          anchor,
          senderLabel: anchorSenderLabel,
          senderAvatarUrl,
        });
        return origin === null ? null : (
          <div
            className="shrink-0 px-2 pt-2"
            data-testid="bot-thread-anchor"
            data-loaded={origin.loaded ? "true" : "false"}
          >
            <ChatBotMessage
              message={origin.row}
              presentation={
                origin.loaded ? loadedPresentation : unloadedPresentation
              }
              hoverActions={false}
            />
            {post === null && sent?.delivery === "queued" ? (
              <div className="px-3">
                <BotQueuedNotice testId="bot-thread-queued" />
              </div>
            ) : null}
          </div>
        );
      }}
    </ChannelPost>
  );
}

/**
 * The tasks the thread's session set up (Tracy Bots T82), each with where it
 * came from; nothing when it set up none. The list scrolls in a bounded band
 * and, in a short pane, gives way first, down to nothing, before the replies
 * give up their share, so the conversation stays readable and the box stays
 * in the pane. Collapsed, it is inert: its rows leave the tab order and the
 * accessibility tree until the band has room again.
 * An automation this thread set up on another bot is that bot's, and is
 * listed there, not here.
 */
function ThreadTasks(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly threadId: string;
  /** The thread as listed; `null` while the list has not returned it. */
  readonly thread: BotThreadSummary | null;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
}): ReactNode {
  const { botId, hostId, threadId, thread, tasks } = props;
  const own = useMemo(() => tasksOfThread(tasks, threadId), [tasks, threadId]);
  const threads = useMemo(() => (thread === null ? [] : [thread]), [thread]);
  const place = useMemo(
    () => ({ kind: "thread" as const, threadId }),
    [threadId],
  );
  const [band, setBand] = useState<HTMLDivElement | null>(null);
  const collapsed = useCollapsed(band);
  if (own.length === 0) return null;
  return (
    <section
      aria-label="Tasks"
      className="flex max-h-[min(30dvh,16rem)] min-h-0 shrink-100 flex-col gap-1 overflow-hidden px-4"
      data-testid="bot-thread-tasks"
      data-collapsed={collapsed ? "true" : "false"}
      inert={collapsed}
    >
      <h3 className="shrink-0 pt-2 text-ui-xs tracking-[0.08em] text-muted-foreground uppercase">
        Tasks
      </h3>
      <div
        ref={setBand}
        className="min-h-0 overflow-y-auto"
        data-testid="bot-thread-tasks-scroll"
      >
        <BotTaskList
          botId={botId}
          hostId={hostId}
          tasks={own}
          threads={threads}
          place={place}
        />
      </div>
    </section>
  );
}

/**
 * Whether a band the layout gave way has no height left, as its resize
 * observations report it; `false` until the first one, and where nothing
 * observes.
 */
function useCollapsed(element: HTMLElement | null): boolean {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry !== undefined) setCollapsed(entry.contentRect.height <= 0);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return collapsed;
}

/**
 * The origin's row: no thread to open, no jump, no options to pick, and a
 * question's card that says how each question was settled and is answered
 * in the channel.
 */
function originPresentation(
  botTitle: string,
  questions: ChatBotQuestions,
  failedRequest: ChatBotPresentation["failedRequest"],
  turns: Pick<ChatBotPresentation, "failedRecovery" | "requestReceipt">,
): ChatBotPresentation {
  return {
    botTitle,
    scrollToMessage: null,
    replyFollowsPost: null,
    threadLine: null,
    openThread: null,
    openAnnouncementThread: null,
    threadAnchorKinds: [],
    chooseOption: null,
    questions,
    failedRequest,
    failedRecovery: turns.failedRecovery,
    replyReceipt: null,
    requestReceipt: turns.requestReceipt,
  };
}

const NO_IDS: ReadonlyArray<string> = [];
const NO_TURN_KEYS: ReadonlyArray<{
  readonly chatId: string;
  readonly turnId: string;
}> = [];

/** A thread state that has a box under it. */
type BoxedThread = Exclude<
  BotThreadPanelThread,
  { readonly kind: "pending" | "failed" }
>;

/**
 * Under the post: the thread, a box that starts one, or why neither shows.
 * The box is one element in one place for a listed thread, one known by its
 * id and one nobody has started, so the list moving the thread between them
 * - a read that lists it, or one that drops it while the bot's binding moves
 * - keeps what the person typed and where they were typing.
 */
function ThreadPanelBody(props: ThreadPanelBodyProps): ReactNode {
  const { thread } = props;
  // A failed message of the thread, put back in the box by its Edit. It
  // stays the box's edit while the list drops the thread and lists it again,
  // so what is sent still replaces that message: the host takes the
  // replacement under the post as it does in the thread.
  const [edit, setEdit] = useState<BotComposerEdit | null>(null);
  const endEdit = useCallback(() => setEdit(null), []);
  // What the box holds unsent, kept under the bot: what the person typed,
  // or a draft Discuss put there, from the channel's card or this thread's.
  const { botId, originMessageId } = props;
  const kept = useBotDraftsStore(
    (state) => state.threadBoxes[botId]?.[originMessageId] ?? null,
  );
  const seedThreadBox = useBotDraftsStore((state) => state.seedThreadBox);
  const typeThreadBox = useBotDraftsStore((state) => state.typeThreadBox);
  const spendThreadBox = useBotDraftsStore((state) => state.spendThreadBox);
  const seed: BotComposerSeed | null =
    kept === null ? null : { id: kept.seedId, text: kept.text };
  // A draft Discuss puts in the box is a new message: an edit the box held
  // ends, so the draft replaces nothing.
  const [heldSeedId, setHeldSeedId] = useState(kept?.seedId ?? null);
  if ((kept?.seedId ?? null) !== heldSeedId) {
    setHeldSeedId(kept?.seedId ?? null);
    if (kept !== null) setEdit(null);
  }
  const keptDraft = useMemo<BotKeptDraft>(
    () => ({
      keep: (text) => typeThreadBox(botId, originMessageId, text),
      revision: () =>
        useBotDraftsStore.getState().threadBoxes[botId]?.[originMessageId]
          ?.revision ?? null,
      spend: (revision) => spendThreadBox(botId, originMessageId, revision),
    }),
    [botId, originMessageId, spendThreadBox, typeThreadBox],
  );
  const discuss = useCallback(
    (_questionMessageId: string, draft: string) =>
      seedThreadBox(botId, originMessageId, draft),
    [botId, originMessageId, seedThreadBox],
  );
  if (thread.kind === "pending" || thread.kind === "failed") {
    return <UnlistedThread thread={thread} sendFailure={props.sendFailure} />;
  }
  const box = boxOf(thread, props.originMessageId, props.conversationId);
  return (
    <>
      {box.threadId === null ? (
        <ThreadListReadFailure retry={thread.retry} />
      ) : (
        <KnownThread
          {...props}
          threadId={box.threadId}
          conversationId={box.conversationId}
          listed={thread.kind === "listed" ? thread.thread : null}
          retry={thread.retry}
          sendable={thread.sendable}
          onEdit={setEdit}
          onDiscuss={discuss}
        />
      )}
      <BotRoutingCard
        botId={props.botId}
        hostId={props.hostId}
        sessionChatId={
          thread.kind === "listed" ? thread.thread.sessionChatId : null
        }
      />
      <BotMessageComposer
        botId={props.botId}
        conversationId={box.conversationId}
        threadId={box.threadId}
        announcementId={box.announcementId}
        sendable={thread.sendable}
        placeholder="Reply…"
        label={edit === null ? box.label : IN_THREAD_LABEL}
        testId="bot-thread-composer"
        failure={props.sendFailure}
        edit={edit}
        onEditEnd={endEdit}
        seed={seed}
        keptDraft={keptDraft}
        onSent={keepOpenThread}
      />
    </>
  );
}

/**
 * The box's name where what it sends goes into the thread: a thread whose id
 * is known, and an edit, which replaces a message of the thread wherever the
 * list has the thread.
 */
const IN_THREAD_LABEL = "Reply in the thread";

/**
 * Where the box sends: into a thread whose id is known, or under a post
 * nobody has replied under, as the first reply that opens its thread.
 */
function boxOf(
  thread: BoxedThread,
  originMessageId: string,
  conversationId: string,
): {
  readonly conversationId: string;
  readonly threadId: string | null;
  readonly announcementId: string | null;
  readonly label: string;
} {
  if (thread.kind === "unopened") {
    return {
      conversationId,
      threadId: null,
      announcementId: originMessageId,
      label: "Reply in a new thread",
    };
  }
  if (thread.kind === "listed") {
    return {
      conversationId: thread.thread.conversationId,
      threadId: thread.thread.threadId,
      announcementId: null,
      label: IN_THREAD_LABEL,
    };
  }
  return {
    conversationId,
    threadId: thread.threadId,
    announcementId: null,
    label: IN_THREAD_LABEL,
  };
}

/**
 * A reply sent from the panel leaves open the thread it was sent in, and its
 * box says the reply's delivery.
 */
function keepOpenThread(): boolean {
  return false;
}

/**
 * The rule and reply count, the replies and the replying line of a thread
 * whose id is known, above the panel's box. A thread with no reply yet draws
 * neither the count nor room for replies, so the box follows the post; a
 * listed one's transcript stays subscribed with nothing drawn while it
 * connects, and takes the room once a reply is listed. A thread the list
 * has not returned yet (`listed: null`) has no replies to read, and still
 * says the bot is replying. A failed read of the list says so above the
 * replies, with Retry, and leaves what the list last returned in place.
 */
function KnownThread(
  props: Omit<ThreadPanelBodyProps, "thread"> & {
    readonly threadId: string;
    readonly listed: BotThreadSummary | null;
    readonly retry: (() => void) | null;
    readonly sendable: boolean;
    /** Edit on a failed message: its text goes in the panel's box. */
    readonly onEdit: (edit: BotComposerEdit) => void;
    /** Discuss on an overtaken answer to a question here: its draft goes in the panel's box. */
    readonly onDiscuss: (questionMessageId: string, draft: string) => void;
  },
): ReactNode {
  const {
    botId,
    hostId,
    boundHostId,
    botTitle,
    conversationId,
    threadId,
    listed,
    retry,
    sendable,
    resolveMember,
    sendFailure,
    onEdit,
    onDiscuss,
    onOpenTurn,
  } = props;
  const client = useTabHostClient();
  const {
    mutate: send,
    mutateAsync: sendAsync,
    isPending: sending,
  } = useBotConversationSendMutation(client);
  const { fail: failSend, clear: clearSendFailure } = sendFailure;
  // The thread's own session answers in it; its running turn is the
  // thread's typing line, and an answer it holds or fails is said on the
  // message, with Retry and Edit.
  const activity = useBotActivity(botId)?.threads[threadId] ?? null;
  const failedInThread = useCallback(
    (requestId: string) => failedOn(activity, requestId),
    [activity],
  );
  const failedRequest = useBotFailedRequest({
    client,
    hostId,
    boundHostId,
    botId,
    conversationId,
    threadId,
    failedOn: failedInThread,
    onEdit,
    failure: sendFailure,
  });
  // A thread that takes no send says a failed message with neither Retry nor
  // Edit, as a host that cannot re-deliver does.
  const failedRequestShown = useMemo(
    () =>
      sendable
        ? failedRequest
        : (requestId: string, senderUserId: string | null) => {
            const failed = failedRequest(requestId, senderUserId);
            return failed === null
              ? null
              : { ...failed, retry: null, edit: null };
          },
    [failedRequest, sendable],
  );
  // A question card's answer or Skip, on a question asked in the thread, is
  // the person's next message in it; a failed one says so where a failed
  // message does, and the card keeps the draft. A host that cannot take the
  // answer gets a card without actions.
  const answersTaken = useBotSendTakesAnswers(hostId);
  const answerQuestion = useCallback<QuestionAnswerSend>(
    async (questionMessageId, given) => {
      clearSendFailure();
      await sendAsync(
        {
          botId,
          conversationId,
          text: given.text,
          threadId,
          announcementId: null,
          redeliver: null,
          supersedes: null,
          answer: {
            questionMessageId,
            questionIndex: given.questionIndex,
            skipped: given.skipped,
          },
        },
        { onError: failSend },
      );
    },
    [botId, clearSendFailure, conversationId, failSend, sendAsync, threadId],
  );
  // A reply's option, clicked, is the person's next message in the thread:
  // offered only while no earlier pick is still being sent and the thread
  // takes a send, and a pick that fails says so where a failed message does.
  const surface = useMemo(
    () => ({
      kind: "thread" as const,
      chooseOption:
        sending || !sendable
          ? null
          : (choice: string) => {
              clearSendFailure();
              send(
                {
                  botId,
                  conversationId,
                  text: choice,
                  threadId,
                  announcementId: null,
                  redeliver: null,
                  supersedes: null,
                  answer: null,
                },
                { onError: failSend },
              );
            },
      answerQuestion: sendable && answersTaken ? answerQuestion : null,
      discussQuestion: onDiscuss,
      failedRequest: failedRequestShown,
      openTurn: onOpenTurn,
      sessionChatId: listed?.sessionChatId ?? null,
    }),
    [
      answerQuestion,
      answersTaken,
      botId,
      clearSendFailure,
      conversationId,
      failSend,
      failedRequestShown,
      listed?.sessionChatId,
      onDiscuss,
      onOpenTurn,
      send,
      sendable,
      sending,
      threadId,
    ],
  );
  const replyCount = listed?.replyCount ?? 0;
  const hasReplies = replyCount > 0;
  return (
    <>
      {hasReplies ? (
        <div
          className="flex shrink-0 items-center gap-3 px-4 pt-2 text-ui-xs text-muted-foreground"
          data-testid="bot-thread-reply-count"
        >
          <span className="shrink-0">
            {replyCount === 1 ? "1 reply" : `${replyCount} replies`}
          </span>
          <span className="h-px flex-1 bg-border/60" aria-hidden="true" />
        </div>
      ) : null}
      <ThreadListReadFailure retry={retry} />
      {listed === null ? null : (
        <div
          className={cn(
            "flex min-h-0 flex-col",
            hasReplies && "grow basis-[min(10rem,25dvh)]",
          )}
          data-testid="bot-thread-replies"
          data-has-replies={hasReplies ? "true" : "false"}
        >
          <BotChatTranscript
            botId={botId}
            chatId={threadId}
            hostId={hostId}
            title={botTitle}
            instanceId={`bot-thread:${threadId}`}
            surface={surface}
            resolveMember={resolveMember}
            showConnecting={hasReplies}
            landOn={null}
          />
        </div>
      )}
      <BotReplyingStrip
        botTitle={botTitle}
        activity={activity}
        testId="bot-thread-replying-strip"
      />
    </>
  );
}

/** A failed read of the thread list, with Retry; nothing while it has not failed. */
function ThreadListReadFailure(props: {
  readonly retry: (() => void) | null;
}): ReactNode {
  if (props.retry === null) return null;
  return (
    <div className="shrink-0 px-4 pt-2">
      <BotReadFailure
        message="Couldn't load this thread."
        onRetry={props.retry}
        testId="bot-thread-error"
      />
    </div>
  );
}

/**
 * A thread the list cannot show yet: waited for, or failed to read. With no
 * box here, a retry of the post above that the host refuses is said here.
 */
function UnlistedThread(props: {
  readonly thread: Extract<
    BotThreadPanelThread,
    { readonly kind: "pending" | "failed" }
  >;
  readonly sendFailure: BotSendFailure;
}): ReactNode {
  const sendFailed = props.sendFailure.failed ? (
    <div className="shrink-0 px-4 pt-2">
      <BotSendFailedNotice testId="bot-thread-send-failed" />
    </div>
  ) : null;
  if (props.thread.kind === "failed") {
    return (
      <>
        {sendFailed}
        <div className="p-4">
          <BotReadFailure
            message="Couldn't load this thread."
            onRetry={props.thread.retry}
            testId="bot-thread-error"
          />
        </div>
      </>
    );
  }
  return (
    <>
      {sendFailed}
      <div
        className="flex flex-1 items-center justify-center py-10 text-muted-foreground"
        aria-busy="true"
        data-testid="bot-thread-loading"
      >
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </div>
    </>
  );
}

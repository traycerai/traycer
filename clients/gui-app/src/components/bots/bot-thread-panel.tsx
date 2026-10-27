import { useCallback, useMemo, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ChatBotMessage } from "@/components/chat/chat-bot-message";
import { BotAvatar } from "@/components/bots/bot-avatars";
import { BotChatTranscript } from "@/components/bots/bot-chat-transcript";
import {
  BotMessageComposer,
  type BotComposerEdit,
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
import { ChannelPost } from "@/components/bots/bot-channel-post";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useBotConversationSendMutation } from "@/hooks/bots/use-bot-mutations";
import {
  failedOn,
  failedOnRequest,
  useBotActivity,
} from "@/hooks/bots/use-bot-activity";
import { useBotFailedRequest } from "@/hooks/bots/use-bot-failed-request";
import type { ChatBotPresentation } from "@/components/chat/chat-bot-presentation-context";
import { formatUsd } from "@/lib/usage-analytics/cost-format";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import { threadOriginRow } from "@/lib/bots/reply-row";
import type { BotSentPost } from "@/stores/bots/bot-open-thread-store";
import { cn } from "@/lib/utils";

/**
 * The open post's thread as the channel's thread list has it: listed; not
 * listed yet but known by its id, as a thread the person's post opened as it
 * was sent is until the next read; not listed yet, as a just-posted thread
 * opened from its row is; not opened yet, a question, proposal or direct
 * post nobody has replied under; or unknown, because the read failed.
 */
export type BotThreadPanelThread =
  | { readonly kind: "listed"; readonly thread: BotThreadSummary }
  | {
      readonly kind: "posted";
      readonly threadId: string;
      /** The list's read failed: Retry reads it again. `null` while it has not. */
      readonly retry: (() => void) | null;
    }
  | { readonly kind: "pending" }
  | { readonly kind: "unopened" }
  | { readonly kind: "failed"; readonly retry: () => void };

/**
 * A thread of a bot's channel, in Slack's thread panel (Tracy Bots): the
 * header names the thread and its channel and says what the thread has cost,
 * the post it opens on sits on top, as the channel draws it, in every state
 * (decision 90), then the replies - the thread record in the ordinary message
 * list - and a box that replies in the thread. With no reply yet, the box
 * follows the post.
 *
 * "Under the hood" opens the transcript of the bot's session that runs the
 * thread, read-only, in the bot's under-the-hood view.
 *
 * A message of the thread the bot failed to answer is retried as it is, or
 * edited in the thread's box; the post the thread opens on is edited in the
 * channel's box (`onEditPost`), since its replacement is a new post.
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
  /** The viewer's own name for their posts, as the channel shows them. */
  readonly anchorSenderLabel: (senderUserId: string | null) => string;
  readonly resolveMember: BotMemberResolver;
  readonly onClose: () => void;
  readonly onOpenUnderTheHood: (sessionChatId: string) => void;
  readonly onEditPost: (edit: BotComposerEdit) => void;
}): ReactNode {
  const { botTitle, onClose, onOpenUnderTheHood } = props;
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
        {thread === null || thread.costUsd === null ? null : (
          <span
            className="shrink-0 text-ui-xs tabular-nums text-muted-foreground"
            data-testid="bot-thread-cost"
          >
            {formatUsd(thread.costUsd)}
          </span>
        )}
        {thread === null ? null : (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="bot-thread-under-the-hood"
            onClick={() => onOpenUnderTheHood(thread.sessionChatId)}
          >
            Under the hood
          </Button>
        )}
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
 * A send the host queued says so under the post. Nothing while the post is
 * neither loaded, sent from here nor listed.
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
    sendFailure,
  } = props;
  const client = useTabHostClient();
  const activity = useBotActivity(botId);
  const failedOnPost = useCallback(
    (requestId: string) => failedOnRequest(activity, requestId),
    [activity],
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
  const loadedPresentation = useMemo(
    () => originPresentation(botTitle, failedRequest),
    [botTitle, failedRequest],
  );
  const unloadedPresentation = useMemo(
    () =>
      originPresentation(botTitle, (requestId, senderUserId) => {
        const failed = failedRequest(requestId, senderUserId);
        return failed === null ? null : { ...failed, retry: null, edit: null };
      }),
    [botTitle, failedRequest],
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
            {sent?.delivery === "queued" ? (
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

/** The origin's row: no thread to open, no jump, no options to pick. */
function originPresentation(
  botTitle: string,
  failedRequest: ChatBotPresentation["failedRequest"],
): ChatBotPresentation {
  return {
    botTitle,
    scrollToMessage: null,
    replyFollowsPost: null,
    repliedPost: null,
    threadLine: null,
    openThread: null,
    openAnnouncementThread: null,
    chooseOption: null,
    failedRequest,
  };
}

/** Under the post: the thread, a box that starts one, or why neither shows. */
function ThreadPanelBody(props: ThreadPanelBodyProps): ReactNode {
  const { thread } = props;
  // One element for both, so the list catching up remounts nothing.
  if (thread.kind === "listed") {
    return (
      <KnownThread
        {...props}
        threadId={thread.thread.threadId}
        conversationId={thread.thread.conversationId}
        listed={thread.thread}
        retry={null}
      />
    );
  }
  if (thread.kind === "posted") {
    return (
      <KnownThread
        {...props}
        threadId={thread.threadId}
        listed={null}
        retry={thread.retry}
      />
    );
  }
  if (thread.kind === "unopened") {
    return (
      <UnopenedThread
        botId={props.botId}
        conversationId={props.conversationId}
        announcementId={props.originMessageId}
        sendFailure={props.sendFailure}
      />
    );
  }
  return <UnlistedThread thread={thread} sendFailure={props.sendFailure} />;
}

/** A question, proposal or direct post nobody has replied under yet. */
function UnopenedThread(props: {
  readonly botId: string;
  readonly conversationId: string;
  readonly announcementId: string;
  readonly sendFailure: BotSendFailure;
}): ReactNode {
  return (
    <BotMessageComposer
      botId={props.botId}
      conversationId={props.conversationId}
      threadId={null}
      announcementId={props.announcementId}
      placeholder="Reply…"
      label="Reply in a new thread"
      testId="bot-thread-composer"
      failure={props.sendFailure}
      edit={null}
      onEditEnd={noEdit}
      onSent={keepOpenThread}
    />
  );
}

/** A box that never edits: a thread nobody has replied in has nothing to edit. */
function noEdit(): void {}

/** A reply sent from the panel leaves open the thread it was sent in. */
function keepOpenThread(): void {}

/**
 * The rule and reply count, the replies and the box of a thread whose id is
 * known. A thread with no reply yet draws neither the count nor room for
 * replies, so its box follows the post; a listed one's transcript stays
 * subscribed with nothing drawn while it connects, and takes the room once
 * a reply is listed. A thread the list has not returned yet (`listed:
 * null`) has no replies to read, and still says the bot is replying and
 * takes a reply; a failed read of the list says so where the replies go,
 * with Retry, and keeps the box as it is.
 */
function KnownThread(
  props: Omit<ThreadPanelBodyProps, "thread"> & {
    readonly threadId: string;
    readonly listed: BotThreadSummary | null;
    readonly retry: (() => void) | null;
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
    resolveMember,
    sendFailure,
  } = props;
  const client = useTabHostClient();
  const { mutate: send, isPending: sending } =
    useBotConversationSendMutation(client);
  const { fail: failSend, clear: clearSendFailure } = sendFailure;
  // The thread's own session answers in it; its running turn is the
  // thread's typing line, and an answer it holds or fails is said on the
  // message, with Retry and Edit.
  const activity = useBotActivity(botId)?.threads[threadId] ?? null;
  const failedInThread = useCallback(
    (requestId: string) => failedOn(activity, requestId),
    [activity],
  );
  const [edit, setEdit] = useState<BotComposerEdit | null>(null);
  const endEdit = useCallback(() => setEdit(null), []);
  const failedRequest = useBotFailedRequest({
    client,
    hostId,
    boundHostId,
    botId,
    conversationId,
    threadId,
    failedOn: failedInThread,
    onEdit: setEdit,
    failure: sendFailure,
  });
  // A reply's option, clicked, is the person's next message in the thread:
  // offered only while no earlier pick is still being sent, and a pick that
  // fails says so where a failed message does.
  const surface = useMemo(
    () => ({
      kind: "thread" as const,
      chooseOption: sending
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
              },
              { onError: failSend },
            );
          },
      failedRequest,
    }),
    [
      botId,
      clearSendFailure,
      conversationId,
      failSend,
      failedRequest,
      send,
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
      {listed === null ? (
        <ThreadListReadFailure retry={retry} />
      ) : (
        <div
          className={cn("flex min-h-0 flex-col", hasReplies && "flex-1")}
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
          />
        </div>
      )}
      <BotReplyingStrip
        botTitle={botTitle}
        activity={activity}
        testId="bot-thread-replying-strip"
      />
      <BotMessageComposer
        botId={botId}
        conversationId={conversationId}
        threadId={threadId}
        announcementId={null}
        placeholder="Reply…"
        label="Reply in the thread"
        testId="bot-thread-composer"
        failure={sendFailure}
        edit={edit}
        onEditEnd={endEdit}
        onSent={keepOpenThread}
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

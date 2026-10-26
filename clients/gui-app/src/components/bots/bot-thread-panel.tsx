import { useCallback, useMemo, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { BotMessageFrame } from "@/components/chat/chat-bot-message";
import { BotAvatar, MemberAvatar } from "@/components/bots/bot-avatars";
import { TextSegment } from "@/components/chat/segments/text-segment";
import { BotChatTranscript } from "@/components/bots/bot-chat-transcript";
import {
  BotMessageComposer,
  type BotComposerEdit,
} from "@/components/bots/bot-message-composer";
import { BotUnansweredNotice } from "@/components/bots/bot-channel-notices";
import { useBotSendFailure } from "@/hooks/bots/use-bot-send-failure";
import { BotReadFailure } from "@/components/bots/bot-read-failure";
import { BotReplyingStrip } from "@/components/bots/bot-replying-strip";
import { ChannelPostText } from "@/components/bots/bot-channel-post-text";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useBotConversationSendMutation } from "@/hooks/bots/use-bot-mutations";
import { failedOn, useBotActivity } from "@/hooks/bots/use-bot-activity";
import { useBotFailedRequest } from "@/hooks/bots/use-bot-failed-request";
import type { ChatBotFailedRequest } from "@/components/chat/chat-bot-presentation-context";
import { formatUsd } from "@/lib/usage-analytics/cost-format";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";

/**
 * The open post's thread as the channel's thread list has it: listed; not
 * listed yet, as a just-posted thread is until the next read; not opened
 * yet, a question or proposal nobody has replied under; or unknown, because
 * the read failed.
 */
export type BotThreadPanelThread =
  | { readonly kind: "listed"; readonly thread: BotThreadSummary }
  | { readonly kind: "pending" }
  | {
      readonly kind: "unopened";
      readonly conversationId: string;
      readonly announcementId: string;
    }
  | { readonly kind: "failed"; readonly retry: () => void };

/**
 * A thread of a bot's channel, in Slack's thread panel (Tracy Bots): the
 * header names the thread and its channel and says what the thread has cost,
 * the post it answers sits on top, then the replies - the thread record in
 * the ordinary message list - and a box that replies in the thread.
 *
 * "Under the hood" opens the transcript of the bot's session that runs the
 * thread, read-only, in the bot's under-the-hood view.
 *
 * A message of the thread the bot failed to answer is retried as it is, or
 * edited in the thread's box; the post the thread answers is edited in the
 * channel's box (`onEditPost`), since its replacement is a new post.
 */
export function BotThreadPanel(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly botTitle: string;
  readonly thread: BotThreadPanelThread;
  /** The viewer's own name for their posts, as the channel shows them. */
  readonly anchorSenderLabel: (senderUserId: string | null) => string;
  readonly resolveMember: BotMemberResolver;
  readonly onClose: () => void;
  readonly onOpenUnderTheHood: (sessionChatId: string) => void;
  readonly onEditPost: (edit: BotComposerEdit) => void;
}): ReactNode {
  const {
    botId,
    hostId,
    botTitle,
    anchorSenderLabel,
    resolveMember,
    onClose,
    onOpenUnderTheHood,
    onEditPost,
  } = props;
  const thread = props.thread.kind === "listed" ? props.thread.thread : null;
  return (
    <section
      aria-label="Thread"
      data-testid="bot-thread-panel"
      data-thread-id={thread?.threadId ?? undefined}
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
      <ThreadPanelBody
        botId={botId}
        hostId={hostId}
        botTitle={botTitle}
        thread={props.thread}
        anchorSenderLabel={anchorSenderLabel}
        resolveMember={resolveMember}
        onOpenUnderTheHood={onOpenUnderTheHood}
        onEditPost={onEditPost}
      />
    </section>
  );
}

type ThreadPanelBodyProps = {
  readonly botId: string;
  readonly hostId: string;
  readonly botTitle: string;
  readonly thread: BotThreadPanelThread;
  readonly anchorSenderLabel: (senderUserId: string | null) => string;
  readonly resolveMember: BotMemberResolver;
  readonly onOpenUnderTheHood: (sessionChatId: string) => void;
  readonly onEditPost: (edit: BotComposerEdit) => void;
};

/** Under the header: the thread, a box that starts one, or why neither shows. */
function ThreadPanelBody(props: ThreadPanelBodyProps): ReactNode {
  const { thread } = props;
  if (thread.kind === "listed") {
    return <ListedThread {...props} thread={thread.thread} />;
  }
  if (thread.kind === "unopened") {
    return (
      <UnopenedThread
        botId={props.botId}
        conversationId={thread.conversationId}
        announcementId={thread.announcementId}
      />
    );
  }
  return <UnlistedThread thread={thread} />;
}

/** A question, proposal or direct post nobody has replied under yet. */
function UnopenedThread(props: {
  readonly botId: string;
  readonly conversationId: string;
  readonly announcementId: string;
}): ReactNode {
  const sendFailure = useBotSendFailure();
  return (
    <>
      <p
        className="flex-1 px-4 py-3 text-ui-sm text-muted-foreground"
        data-testid="bot-thread-unopened"
      >
        Reply to start a thread. The bot answers there.
      </p>
      <BotMessageComposer
        botId={props.botId}
        conversationId={props.conversationId}
        threadId={null}
        announcementId={props.announcementId}
        placeholder="Reply…"
        label="Reply in a new thread"
        testId="bot-thread-composer"
        failure={sendFailure}
        edit={null}
        onEditEnd={noEdit}
      />
    </>
  );
}

/** A box that never edits: a thread nobody has replied in has nothing to edit. */
function noEdit(): void {}

/** The anchor, the replies and the box of a listed thread. */
function ListedThread(
  props: Omit<ThreadPanelBodyProps, "thread"> & {
    readonly thread: BotThreadSummary;
  },
): ReactNode {
  const {
    botId,
    hostId,
    botTitle,
    thread,
    anchorSenderLabel,
    resolveMember,
    onOpenUnderTheHood,
    onEditPost,
  } = props;
  const client = useTabHostClient();
  const { mutate: send, isPending: sending } =
    useBotConversationSendMutation(client);
  const sendFailure = useBotSendFailure();
  const { fail: failSend, clear: clearSendFailure } = sendFailure;
  const { threadId, conversationId, anchor } = thread;
  // The thread's own session answers in it; its running turn is the
  // thread's typing line, and an answer it holds or fails the notice under
  // the last row and Retry and Edit on the message.
  const activity = useBotActivity(botId)?.threads[threadId] ?? null;
  const failedInThread = useCallback(
    (requestId: string) => failedOn(activity, requestId),
    [activity],
  );
  const [edit, setEdit] = useState<BotComposerEdit | null>(null);
  const endEdit = useCallback(() => setEdit(null), []);
  const failedRequest = useBotFailedRequest({
    client,
    botId,
    conversationId,
    threadId,
    failedOn: failedInThread,
    onEdit: setEdit,
    failure: sendFailure,
  });
  // The post is the channel's: retried as a post, edited in the channel.
  const failedPost = useBotFailedRequest({
    client,
    botId,
    conversationId,
    threadId: null,
    failedOn: failedInThread,
    onEdit: onEditPost,
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
  return (
    <>
      <div className="flex shrink-0 flex-col gap-2 px-2 pt-2">
        {anchor === null ? null : (
          <ChannelPostText
            botId={botId}
            hostId={hostId}
            conversationId={conversationId}
            messageId={anchor.messageId}
            fetchCold
          >
            {(text) => (
              <ThreadAnchor
                anchor={anchor}
                failed={failedPost(anchor.requestId)}
                text={text}
                botTitle={botTitle}
                senderLabel={anchorSenderLabel(anchor.senderUserId)}
                avatarUrl={
                  anchor.senderUserId === null
                    ? null
                    : (resolveMember(anchor.senderUserId)?.avatarUrl ?? null)
                }
              />
            )}
          </ChannelPostText>
        )}
        <div
          className="flex items-center gap-3 px-2 text-ui-xs text-muted-foreground"
          data-testid="bot-thread-reply-count"
        >
          <span className="shrink-0">
            {thread.replyCount === 1
              ? "1 reply"
              : `${thread.replyCount} replies`}
          </span>
          <span className="h-px flex-1 bg-border/60" aria-hidden="true" />
        </div>
      </div>
      <BotChatTranscript
        botId={botId}
        chatId={thread.threadId}
        hostId={hostId}
        title={botTitle}
        instanceId={`bot-thread:${thread.threadId}`}
        surface={surface}
        resolveMember={resolveMember}
      />
      <BotReplyingStrip
        botTitle={botTitle}
        activity={activity}
        testId="bot-thread-replying-strip"
      />
      <BotUnansweredNotice
        botTitle={botTitle}
        activity={activity}
        onOpenUnderTheHood={() => onOpenUnderTheHood(thread.sessionChatId)}
        testId="bot-thread-unanswered"
      />
      <BotMessageComposer
        botId={botId}
        conversationId={thread.conversationId}
        threadId={thread.threadId}
        announcementId={null}
        placeholder="Reply…"
        label="Reply in the thread"
        testId="bot-thread-composer"
        failure={sendFailure}
        edit={edit}
        onEditEnd={endEdit}
      />
    </>
  );
}

/** A thread the list cannot show yet: waited for, or failed to read. */
function UnlistedThread(props: {
  readonly thread: BotThreadPanelThread;
}): ReactNode {
  if (props.thread.kind === "failed") {
    return (
      <div className="p-4">
        <BotReadFailure
          message="Couldn't load this thread."
          onRetry={props.thread.retry}
          testId="bot-thread-error"
        />
      </div>
    );
  }
  return (
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
  );
}

/**
 * The post the thread answers, drawn as the channel draws it, its text read
 * from the channel's row (`null` while the channel has not loaded it): a
 * member's post, or the bot's own question or proposal.
 */
function ThreadAnchor(props: {
  readonly anchor: NonNullable<BotThreadSummary["anchor"]>;
  /** The post's Retry and Edit while the thread's session failed on it. */
  readonly failed: ChatBotFailedRequest | null;
  readonly text: string | null;
  readonly botTitle: string;
  readonly senderLabel: string;
  readonly avatarUrl: string | null;
}): ReactNode {
  const { anchor, failed, text, botTitle, senderLabel, avatarUrl } = props;
  if (anchor.senderUserId === null) {
    return (
      <BotMessageFrame
        avatar={<BotAvatar size="lg" />}
        name={botTitle}
        app
        sentAt={anchor.sentAt}
        instanceId={anchor.messageId}
        testId="bot-thread-anchor"
        replyInThread={null}
        failed={null}
      >
        {text === null ? null : (
          <TextSegment
            findUnitId={null}
            markdown={text}
            isStreaming={false}
            nextStepActions={null}
          />
        )}
      </BotMessageFrame>
    );
  }
  return (
    <BotMessageFrame
      avatar={
        <MemberAvatar
          userId={anchor.senderUserId}
          name={senderLabel}
          avatarUrl={avatarUrl}
          size="lg"
        />
      }
      name={senderLabel}
      app={false}
      sentAt={anchor.sentAt}
      instanceId={anchor.messageId}
      testId="bot-thread-anchor"
      replyInThread={null}
      failed={
        failed === null || text === null
          ? null
          : {
              onRetry: () => failed.retry(text),
              retrying: failed.retrying,
              onEdit: () => failed.edit(text),
            }
      }
    >
      {text === null ? null : (
        <TextSegment
          findUnitId={null}
          markdown={text}
          isStreaming={false}
          nextStepActions={null}
        />
      )}
    </BotMessageFrame>
  );
}

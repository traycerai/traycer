import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  BotThreadListResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { OpenMessage } from "@traycer/protocol/persistence/epic/open-harness-records";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { BotReadFailure } from "@/components/bots/bot-read-failure";
import { ChannelPost } from "@/components/bots/bot-channel-post";
import { firstLineOf, threadOpenOf } from "@/lib/bots/bot-trunk-model";
import { postTextOf } from "@/lib/bots/reply-row";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";

/**
 * A bot's Threads tab (Tracy Bots T86, decision 115): its threads, most
 * recent first, each named by the post it hangs off with its replies.
 * Choosing one opens it beside the channel, in Messages.
 */
export function BotThreadsPage(props: {
  readonly botId: string;
  readonly hostId: string;
  /** `null` on a host without the list. */
  readonly threadList: UseQueryResult<
    BotThreadListResponse,
    HostRpcError
  > | null;
  readonly onOpenPost: (open: BotOpenThread) => void;
}): ReactNode {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4"
      data-testid="bot-threads-page"
    >
      <BotThreadsBody {...props} />
    </div>
  );
}

function BotThreadsBody(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly threadList: UseQueryResult<
    BotThreadListResponse,
    HostRpcError
  > | null;
  readonly onOpenPost: (open: BotOpenThread) => void;
}): ReactNode {
  const { botId, hostId, threadList, onOpenPost } = props;
  if (threadList === null) {
    return <EmptyLine text="This bot's host can't list its threads." />;
  }
  const threads = threadList.data?.threads;
  if (threads === undefined) {
    if (threadList.isError) {
      return (
        <BotReadFailure
          message="Couldn't load the threads."
          onRetry={() => void threadList.refetch()}
          testId="bot-threads-error"
        />
      );
    }
    return (
      <div
        className="py-1 text-muted-foreground"
        aria-busy="true"
        data-testid="bot-threads-loading"
      >
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </div>
    );
  }
  if (threads.length === 0) return <EmptyLine text="No threads yet." />;
  return (
    <ul className="flex flex-col gap-1">
      {threads.map((thread) => (
        <li key={thread.threadId}>
          <ThreadRow
            botId={botId}
            hostId={hostId}
            thread={thread}
            onOpenPost={onOpenPost}
          />
        </li>
      ))}
    </ul>
  );
}

function EmptyLine(props: { readonly text: string }): ReactNode {
  return <p className="py-1 text-ui-xs text-muted-foreground">{props.text}</p>;
}

/**
 * One thread: the first line of its post and its replies, opening the thread
 * as the post's own row does. The list reads only the posts the channel has
 * loaded; a thread whose post is older is named "Thread" until chosen, when
 * this row alone locates its post, holds it while it shows, and opens the
 * thread once it is read (the one reader that fetched it owns the hold, as a
 * task row's does).
 */
function ThreadRow(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly thread: BotThreadSummary;
  readonly onOpenPost: (open: BotOpenThread) => void;
}): ReactNode {
  const { botId, hostId, thread, onOpenPost } = props;
  const [wanted, setWanted] = useState(false);
  const replies =
    thread.replyCount === 1 ? "1 reply" : `${thread.replyCount} replies`;
  const anchor = thread.anchor;
  if (anchor === null) {
    return (
      <ThreadRowBody
        title="Thread"
        replies={replies}
        onOpen={null}
        pending={false}
      />
    );
  }
  return (
    <ChannelPost
      botId={botId}
      hostId={hostId}
      conversationId={thread.conversationId}
      messageId={anchor.messageId}
      fetchCold={wanted}
    >
      {(row) => (
        <ThreadRowFromPost
          row={row}
          anchorMessageId={anchor.messageId}
          replies={replies}
          wanted={wanted}
          onWant={() => setWanted(true)}
          onOpenPost={onOpenPost}
        />
      )}
    </ChannelPost>
  );
}

function ThreadRowFromPost(props: {
  readonly row: OpenMessage | null;
  readonly anchorMessageId: string;
  readonly replies: string;
  /** Chosen before its post was read: it opens once the post is. */
  readonly wanted: boolean;
  readonly onWant: () => void;
  readonly onOpenPost: (open: BotOpenThread) => void;
}): ReactNode {
  const { row, anchorMessageId, replies, wanted, onWant, onOpenPost } = props;
  const open = row === null ? null : threadOpenOf(row);
  const openThread = (): void => {
    if (open === null) return;
    onOpenPost({
      anchorMessageId,
      announcement: open.announcement,
      answer: open.answer,
      sent: null,
    });
  };
  const openOnRead = useEffectEvent(openThread);
  const readAfterChosen = wanted && open !== null;
  useEffect(() => {
    if (readAfterChosen) openOnRead();
  }, [readAfterChosen]);
  if (row === null) {
    return (
      <ThreadRowBody
        title="Thread"
        replies={replies}
        onOpen={wanted ? null : onWant}
        pending={wanted}
      />
    );
  }
  return (
    <ThreadRowBody
      title={firstLineOf(postTextOf(row)) ?? "Thread"}
      replies={replies}
      onOpen={open === null ? null : openThread}
      pending={false}
    />
  );
}

function ThreadRowBody(props: {
  readonly title: string;
  readonly replies: string;
  readonly onOpen: (() => void) | null;
  /** Its post is being read, to open it. */
  readonly pending: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      data-testid="bot-thread-row"
      disabled={props.onOpen === null}
      aria-busy={props.pending}
      onClick={props.onOpen ?? undefined}
      className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-foreground/6 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2 disabled:hover:bg-transparent"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-ui-sm text-foreground">
          {props.title}
        </span>
        {props.pending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
      </span>
      <span className="text-ui-xs text-muted-foreground">{props.replies}</span>
    </button>
  );
}

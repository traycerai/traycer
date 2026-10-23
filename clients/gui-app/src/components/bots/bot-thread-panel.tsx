import type { ReactNode } from "react";
import { Hash, X } from "lucide-react";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BotMessageFrame,
  MemberAvatar,
} from "@/components/chat/chat-bot-message";
import { TextSegment } from "@/components/chat/segments/text-segment";
import { BotChatTranscript } from "@/components/bots/bot-chat-transcript";
import { BotMessageComposer } from "@/components/bots/bot-message-composer";
import { formatUsd } from "@/lib/usage-analytics/cost-format";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";

/**
 * A thread of a bot's channel, in Slack's thread panel (Tracy Bots): the
 * header names the thread and its channel and says what the thread has cost,
 * the post it answers sits on top, then the replies - the thread record in
 * the ordinary message list - and a box that replies in the thread.
 *
 * "Under the hood" opens the transcript of the bot's session that runs the
 * thread, read-only, in the bot's under-the-hood view.
 */
export function BotThreadPanel(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly botTitle: string;
  /** The listed thread; `null` while a post's thread is not listed yet. */
  readonly thread: BotThreadSummary | null;
  /** The viewer's own name for their posts, as the channel shows them. */
  readonly anchorSenderLabel: (senderUserId: string | null) => string;
  readonly resolveMember: BotMemberResolver;
  readonly onClose: () => void;
  readonly onOpenUnderTheHood: (sessionChatId: string) => void;
}): ReactNode {
  const {
    botId,
    hostId,
    botTitle,
    thread,
    anchorSenderLabel,
    resolveMember,
    onClose,
    onOpenUnderTheHood,
  } = props;
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
          <span className="flex min-w-0 items-center truncate text-ui-xs text-muted-foreground">
            <Hash className="size-3 shrink-0" aria-hidden="true" />
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
      {thread === null ? (
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
      ) : (
        <>
          <div className="flex shrink-0 flex-col gap-2 px-2 pt-2">
            {thread.anchor === null ? null : (
              <ThreadAnchor
                anchor={thread.anchor}
                senderLabel={anchorSenderLabel(thread.anchor.senderUserId)}
                avatarUrl={
                  thread.anchor.senderUserId === null
                    ? null
                    : (resolveMember(thread.anchor.senderUserId)?.avatarUrl ??
                      null)
                }
              />
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
            surface={THREAD_SURFACE}
            resolveMember={resolveMember}
          />
          <BotMessageComposer
            botId={botId}
            conversationId={thread.conversationId}
            threadId={thread.threadId}
            placeholder="Reply…"
            label="Reply in the thread"
            testId="bot-thread-composer"
          />
        </>
      )}
    </section>
  );
}

const THREAD_SURFACE = { kind: "thread" } as const;

/** The post the thread answers, drawn as the channel draws it. */
function ThreadAnchor(props: {
  readonly anchor: NonNullable<BotThreadSummary["anchor"]>;
  readonly senderLabel: string;
  readonly avatarUrl: string | null;
}): ReactNode {
  const { anchor, senderLabel, avatarUrl } = props;
  const open = anchor.resolvedAt === null;
  return (
    <BotMessageFrame
      avatar={<MemberAvatar name={senderLabel} avatarUrl={avatarUrl} />}
      name={senderLabel}
      app={false}
      sentAt={anchor.sentAt}
      instanceId={anchor.messageId}
      testId="bot-thread-anchor"
    >
      <TextSegment
        findUnitId={null}
        markdown={anchor.text}
        isStreaming={false}
        nextStepActions={null}
      />
      <div
        className="flex items-center gap-2"
        data-testid="conversation-request"
        data-request-id={anchor.requestId}
        data-request-state={open ? "open" : "resolved"}
      >
        <Badge variant={open ? "warning" : "success"} size="xs">
          {open ? "Open" : "Resolved"}
        </Badge>
      </div>
    </BotMessageFrame>
  );
}

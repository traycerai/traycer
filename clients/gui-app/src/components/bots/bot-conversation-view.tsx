import {
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { BotConversationSendDelivery } from "@traycer/protocol/host/bot/conversation-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useBotConversationListQuery } from "@/hooks/bots/use-bot-conversation-list-query";
import { useBotConversationSendMutation } from "@/hooks/bots/use-bot-mutations";
import { BotChatTranscript } from "@/components/bots/bot-chat-transcript";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import { BotTranscriptPaused } from "@/components/bots/bot-transcript-paused";

const MESSAGE_MAX = 100_000;

/**
 * The person's conversation with a bot (Tracy Bots): the app conversation's
 * transcript, where each of their rows carries its request state, and a
 * composer that writes through `bot.conversation.send`.
 *
 * The composer is deliberately plain. A send is a request to the bot, not a
 * turn: there is no model to choose, nothing to approve, no files to attach,
 * and the bot may be paused - in which case the host accepts the message as
 * `queued` and the bot reads it once it can be reached. The view says so
 * inline, once, for the send that was queued.
 */
export function BotConversationView(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly botTitle: string;
  /**
   * The tab is not on the host that runs the bot and cannot reach it (the
   * paused state): the transcript is that host's to serve, so a placeholder
   * stands in for it, while the list and the composer keep working through
   * this tab's host - a send is accepted and delivered when the bot can be
   * reached.
   */
  readonly paused: boolean;
  /** Names and pictures the members who wrote the conversation's rows. */
  readonly resolveMember: BotMemberResolver;
}): ReactNode {
  const { botId, hostId, botTitle, paused, resolveMember } = props;
  const client = useTabHostClient();
  const conversations = useBotConversationListQuery(client, botId, true);
  // The app conversation is the bot's first; later ones (A2A, other
  // surfaces) are listed after it by creation time.
  const conversation = useMemo(() => {
    const rows = conversations.data?.conversations ?? [];
    let first = null;
    for (const row of rows) {
      if (first === null || row.createdAt < first.createdAt) first = row;
    }
    return first;
  }, [conversations.data]);

  if (conversations.isError) {
    return (
      <div
        role="status"
        data-testid="bot-conversation-error"
        className="m-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-ui-sm text-destructive"
      >
        <span>Couldn&apos;t load this bot&apos;s conversation.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void conversations.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (conversations.data === undefined) {
    return (
      <div
        className="flex flex-1 items-center justify-center py-10 text-muted-foreground"
        aria-busy="true"
        data-testid="bot-conversation-loading"
      >
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </div>
    );
  }
  if (conversation === null) {
    // `bot.create` opens the app conversation with the bot, so an answered
    // list is never empty for a live bot; this is the host disagreeing, and
    // it is said rather than spun on.
    return (
      <p
        role="status"
        data-testid="bot-conversation-empty"
        className="m-4 text-ui-sm text-muted-foreground"
      >
        This bot has no conversation yet.
      </p>
    );
  }
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="bot-conversation"
    >
      {paused ? (
        <BotTranscriptPaused />
      ) : (
        <BotChatTranscript
          botId={botId}
          chatId={conversation.conversationId}
          hostId={hostId}
          title={botTitle}
          instanceId={`bot-conversation:${botId}`}
          linkRequests
          resolveMember={resolveMember}
        />
      )}
      <BotConversationComposer
        botId={botId}
        conversationId={conversation.conversationId}
      />
    </div>
  );
}

function ComposerStatus(props: {
  readonly error: string | null;
  readonly queued: boolean;
}): ReactNode {
  if (props.error !== null) {
    return (
      <p role="alert" className="text-destructive">
        {props.error}
      </p>
    );
  }
  if (!props.queued) return null;
  return (
    <p
      role="status"
      className="text-muted-foreground"
      data-testid="bot-conversation-queued"
    >
      Saved. The bot will read it.
    </p>
  );
}

function BotConversationComposer(props: {
  readonly botId: string;
  readonly conversationId: string;
}): ReactNode {
  const { botId, conversationId } = props;
  const client = useTabHostClient();
  const send = useBotConversationSendMutation(client);
  const [text, setText] = useState("");
  const [lastDelivery, setLastDelivery] =
    useState<BotConversationSendDelivery | null>(null);
  const inputId = useId();
  const trimmed = text.trim();
  const canSend =
    trimmed.length > 0 && trimmed.length <= MESSAGE_MAX && !send.isPending;

  const submit = (): void => {
    if (!canSend) return;
    send.mutate(
      { botId, conversationId, text: trimmed },
      {
        onSuccess: (response) => {
          setText("");
          setLastDelivery(response.delivery);
        },
      },
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    submit();
  };

  return (
    <form
      className="flex shrink-0 flex-col gap-2 border-t border-border/60 px-4 py-3"
      data-testid="bot-conversation-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Message to the bot
      </label>
      <Textarea
        id={inputId}
        value={text}
        size="sm"
        rows={2}
        placeholder="Ask the bot, or tell it what to look after"
        disabled={send.isPending}
        maxLength={MESSAGE_MAX}
        data-testid="bot-conversation-input"
        onChange={(event) => {
          setText(event.target.value);
          if (lastDelivery !== null) setLastDelivery(null);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-ui-xs">
          <ComposerStatus
            error={send.error === null ? null : send.error.message}
            queued={lastDelivery === "queued"}
          />
        </div>
        <Button
          type="submit"
          size="sm"
          disabled={!canSend}
          data-testid="bot-conversation-send"
        >
          Send
          {send.isPending ? (
            <AgentSpinningDots
              className="ml-1"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
      </div>
    </form>
  );
}

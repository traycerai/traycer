import { useCallback, useRef, type ReactNode } from "react";
import { CornerDownRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { NamedBotAvatar } from "@/components/bots/bot-avatars";
import { TracyTranscriptOriginScope } from "@/components/bots/tracy-transcript-origin-scope";
import { REMOVED_BOT_NAME } from "@/components/chat/bot-exchange-lines-context";
import { ChatMessageTimestamp } from "@/components/chat/chat-message-timestamp";
import { AgentReferenceMarkdown } from "@/components/chat/segments/agent-reference-markdown";
import type {
  BotExchange,
  BotExchangeLogEntry,
} from "@/lib/bots/bot-exchanges";
import { useMessageTime } from "@/lib/relative-time";

/**
 * The log of a bot's messages with one other bot (Tracy Bots, decision 174),
 * open in the rail a thread opens in: the two bots at the top, then every
 * message between them in the bot's feed, oldest first, each with who sent
 * it, when, its text, and the earlier message it replies to, which scrolls
 * there. Read-only: opening it marks nothing read.
 */
export function BotExchangeLog(props: {
  readonly botId: string;
  readonly botTitle: string;
  readonly peerBotId: string;
  /** The other bot's name; `null` for one the environment no longer lists. */
  readonly peerName: string | null;
  readonly entries: ReadonlyArray<BotExchangeLogEntry>;
  /** The bot's feed has not handed over its history yet. */
  readonly loading: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const { botId, botTitle, peerBotId, entries } = props;
  const peerName = props.peerName ?? REMOVED_BOT_NAME;
  const rows = useRef(new Map<string, HTMLLIElement>());
  const scrollTo = useCallback((key: string) => {
    rows.current.get(key)?.scrollIntoView({ block: "center" });
  }, []);
  const senderOf = (exchange: BotExchange) =>
    exchange.direction === "sent"
      ? { botId, name: botTitle }
      : { botId: peerBotId, name: peerName };
  return (
    <section
      aria-label={`${botTitle} and ${peerName}`}
      data-testid="bot-exchange-log"
      className="flex min-h-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <h2 className="flex min-w-0 flex-1 items-center gap-1.5 text-ui-md font-semibold text-foreground">
          <NamedBotAvatar botId={botId} size="xs" />
          <span className="truncate">{botTitle}</span>
          <span aria-hidden="true" className="text-muted-foreground">
            ↔
          </span>
          <NamedBotAvatar botId={peerBotId} size="xs" />
          <span className="truncate">{peerName}</span>
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          data-testid="bot-exchange-log-close"
          onClick={props.onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      {entries.length === 0 ? (
        <EmptyLog loading={props.loading} />
      ) : (
        <ol className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          {entries.map(({ exchange, replyTo }) => {
            const sender = senderOf(exchange);
            return (
              <li
                key={exchange.key}
                ref={(element) => {
                  if (element === null) return;
                  rows.current.set(exchange.key, element);
                  return () => {
                    rows.current.delete(exchange.key);
                  };
                }}
                data-testid="bot-exchange-log-row"
                data-direction={exchange.direction}
                className="flex gap-2"
              >
                <NamedBotAvatar botId={sender.botId} size="sm" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  {replyTo === null ? null : (
                    <ReplyingTo
                      name={senderOf(replyTo).name}
                      at={replyTo.timestamp}
                      onClick={() => scrollTo(replyTo.key)}
                    />
                  )}
                  <div className="flex min-w-0 items-baseline gap-2 text-ui-xs">
                    <span className="truncate text-ui-sm font-semibold text-foreground">
                      {sender.name}
                    </span>
                    <ChatMessageTimestamp
                      timestamp={exchange.timestamp}
                      separated={false}
                      instanceId={exchange.key}
                    />
                  </div>
                  <div className="min-w-0 text-ui-sm">
                    <TracyTranscriptOriginScope botId={botId}>
                      <AgentReferenceMarkdown
                        isStreaming={false}
                        markdown={exchange.text}
                        proseSize="compact"
                        quotable={false}
                        components={null}
                      />
                    </TracyTranscriptOriginScope>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** The earlier message a reply answers, named by its sender and time; it scrolls there. */
function ReplyingTo(props: {
  readonly name: string;
  readonly at: number;
  readonly onClick: () => void;
}): ReactNode {
  const time = useMessageTime(props.at);
  return (
    <button
      type="button"
      data-testid="bot-exchange-log-reply"
      onClick={props.onClick}
      className="flex min-w-0 items-center gap-1 self-start rounded-sm text-ui-xs text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
    >
      <CornerDownRight aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{`Replying to ${props.name}, ${time}`}</span>
    </button>
  );
}

function EmptyLog(props: { readonly loading: boolean }): ReactNode {
  if (props.loading) {
    return (
      <div
        className="flex flex-1 items-center justify-center py-10 text-muted-foreground"
        aria-busy="true"
      >
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </div>
    );
  }
  return (
    <p role="status" className="m-4 text-ui-sm text-muted-foreground">
      No messages between them.
    </p>
  );
}

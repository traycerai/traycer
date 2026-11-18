import { Fragment, use, type ReactNode } from "react";
import {
  BotExchangeLinesContext,
  REMOVED_BOT_NAME,
} from "@/components/chat/bot-exchange-lines-context";
import { ChatMessageTimestamp } from "@/components/chat/chat-message-timestamp";
import type { BotExchangePair } from "@/lib/bots/bot-exchanges";

/**
 * A run of the bot's messages with other bots, as one quiet centred line
 * between the channel's rows (Tracy Bots, decision 174), the way Slack says
 * members joined: one pair per other bot, `Tracy ↔ Release Bot · 4
 * messages`, in the order the run reached them, and the time of the run's
 * last message. Each pair opens that pair's log.
 */
export function BotExchangeLineSegment(props: {
  readonly id: string;
  readonly pairs: ReadonlyArray<BotExchangePair>;
  readonly lastAt: number;
}): ReactNode {
  const lines = use(BotExchangeLinesContext);
  if (lines === null) return null;
  return (
    <div
      data-testid="bot-exchange-line"
      className="flex w-full flex-wrap items-baseline justify-center gap-x-1.5 gap-y-0.5 px-2 py-1 text-center text-ui-xs text-muted-foreground"
    >
      {props.pairs.map((pair, index) => {
        const peer = lines.peerName(pair.peerBotId) ?? REMOVED_BOT_NAME;
        return (
          <Fragment key={pair.peerBotId}>
            {index === 0 ? null : <span aria-hidden="true">·</span>}
            <button
              type="button"
              data-testid="bot-exchange-pair"
              data-peer-bot-id={pair.peerBotId}
              onClick={() => lines.openPair(pair.peerBotId)}
              className="rounded-sm text-foreground/80 underline decoration-border decoration-dotted underline-offset-4 hover:text-foreground hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              {`${lines.botTitle} ↔ ${peer} · ${messageCount(pair.count)}`}
            </button>
          </Fragment>
        );
      })}
      <ChatMessageTimestamp
        timestamp={props.lastAt}
        separated={false}
        instanceId={props.id}
      />
    </div>
  );
}

function messageCount(count: number): string {
  return count === 1 ? "1 message" : `${count} messages`;
}

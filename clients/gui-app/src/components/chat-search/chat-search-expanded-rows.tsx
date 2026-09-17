import { useState } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useChatSearchNavProps } from "@/components/chat-search/chat-search-keyboard-nav";
import {
  ChatSearchHighlightedText,
  ChatSearchResultTime,
} from "@/components/chat-search/chat-search-results-view";
import {
  useChatSearchMessageRows,
  type ChatSearchBaseRequest,
} from "@/hooks/chats/use-chat-search-query";
import { chatSearchTierLabel } from "@/lib/chat-search/chat-search-results";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * One result group expanded to its matching message rows, fetched with
 * `scope: chat` and paged by that scope's `messageCursor`. Each row opens the
 * chat on that message.
 */
export function ChatSearchExpandedRows(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly base: ChatSearchBaseRequest;
  readonly epicId: string;
  readonly chatId: string;
  readonly onOpenMessage: (messageId: string) => void;
}) {
  const { base, chatId, client, epicId, onOpenMessage } = props;
  const navProps = useChatSearchNavProps();
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([]);
  const status = useChatSearchMessageRows({
    client,
    base,
    epicId,
    chatId,
    cursors,
  });

  if (status.kind === "loading") {
    return (
      <div className="flex py-1.5 pl-7">
        <AgentSpinningDots
          tone="muted"
          testId={undefined}
          variant={undefined}
        />
      </div>
    );
  }
  if (status.kind === "error") {
    return (
      <p className="py-1.5 pl-7 text-ui-xs text-destructive">
        {status.message}
      </p>
    );
  }
  return (
    <div className="ml-4 flex flex-col border-l border-border/60 pl-1">
      <ul className="flex flex-col">
        {status.messages.map((hit) => (
          <li key={JSON.stringify([hit.messageId, hit.tier])}>
            <button
              type="button"
              {...navProps}
              onClick={() => onOpenMessage(hit.messageId)}
              className="flex w-full min-w-0 flex-col items-start gap-0.5 px-2 py-1 text-left outline-none hover:bg-foreground/5 focus-visible:bg-foreground/8"
            >
              <span className="line-clamp-2 text-ui-xs text-foreground/80">
                <ChatSearchHighlightedText
                  text={hit.snippet.text}
                  ranges={hit.snippet.highlights}
                />
              </span>
              <span className="flex gap-1.5 text-ui-xs text-muted-foreground">
                <span>{chatSearchTierLabel(hit)}</span>
                <span aria-hidden>·</span>
                <ChatSearchResultTime at={hit.createdAt} />
              </span>
            </button>
          </li>
        ))}
      </ul>
      {status.loadMoreError !== null ? (
        <div className="flex flex-wrap items-center gap-x-1">
          <p role="alert" className="px-2 text-ui-xs text-destructive">
            {status.loadMoreError.message}
          </p>
          <Button
            {...navProps}
            variant="muted"
            size="xs"
            className="self-start"
            onClick={status.loadMoreError.retry}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {status.loadMoreError === null && status.nextCursor !== null ? (
        <Button
          {...navProps}
          variant="muted"
          size="xs"
          className="self-start"
          disabled={status.loadingMore}
          onClick={() => {
            const next = status.nextCursor;
            if (next !== null) setCursors((current) => [...current, next]);
          }}
        >
          Show more in this chat
        </Button>
      ) : null}
    </div>
  );
}

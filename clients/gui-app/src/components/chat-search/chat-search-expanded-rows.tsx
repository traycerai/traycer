import { useState } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useChatSearchNavProps } from "@/components/chat-search/chat-search-keyboard-nav";
import {
  ChatSearchMessageRow,
  type ChatSearchExpansionTarget,
} from "@/components/chat-search/chat-search-results-view";
import {
  useChatSearchMessageRows,
  type ChatSearchBaseRequest,
} from "@/hooks/chats/use-chat-search-query";
import { collapseIdenticalSnippets } from "@/lib/chat-search/chat-search-results";
import type { HostRpcRegistry } from "@/lib/host";
import { cn } from "@/lib/utils";

/** One chat's fetched pages, collapsed by visible snippet with best kept first. */
export function ChatSearchExpandedRows(
  props: ChatSearchExpansionTarget & {
    readonly client: HostClient<HostRpcRegistry> | null;
    readonly base: ChatSearchBaseRequest;
    readonly onOpenMessage: (messageId: string) => void;
  },
) {
  const {
    base,
    best,
    chatId,
    client,
    epicId,
    expanded,
    matchCount,
    onOpenMessage,
    variant,
  } = props;
  const navProps = useChatSearchNavProps();
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([]);
  const status = useChatSearchMessageRows({
    client,
    base,
    epicId,
    chatId,
    cursors,
  });
  const messages = status.kind === "ready" ? status.messages : [];
  const snippets = collapseIdenticalSnippets(
    best === null ? messages : [best, ...messages],
  );
  const first = best === null ? undefined : snippets[0];
  const remaining = best === null ? snippets : snippets.slice(1);
  const loaded = snippets.reduce((total, snippet) => total + snippet.count, 0);
  return (
    <>
      {first === undefined ? null : (
        <ChatSearchMessageRow
          hit={first.representative}
          count={first.count}
          onOpenMessage={onOpenMessage}
          variant={variant}
          disabled={false}
        />
      )}
      <div
        inert={!expanded}
        className={cn(
          "grid transition-[grid-template-rows] duration-180 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none starting:grid-rows-[0fr]",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div
          className={cn(
            "min-h-0 overflow-hidden transition-opacity duration-120 ease-[cubic-bezier(0.23,1,0.32,1)] starting:opacity-0",
            expanded ? "opacity-100" : "opacity-0",
          )}
        >
          {status.kind === "loading" ? (
            <div className="flex px-2 py-1.5">
              <AgentSpinningDots
                className={undefined}
                tone="muted"
                testId={undefined}
                variant={undefined}
              />
            </div>
          ) : null}
          {status.kind === "error" ? (
            <p role="alert" className="px-2 py-1.5 text-ui-xs text-destructive">
              {status.message}
            </p>
          ) : null}
          <ul className="flex min-w-0 flex-col gap-px">
            {remaining.map(({ representative, count }) => (
              <li
                key={JSON.stringify([
                  representative.messageId,
                  representative.tier,
                ])}
                className="min-w-0"
              >
                <ChatSearchMessageRow
                  hit={representative}
                  count={count}
                  onOpenMessage={onOpenMessage}
                  variant={variant}
                  disabled={!expanded}
                />
              </li>
            ))}
          </ul>
          {status.kind === "ready" ? (
            <>
              <p className="px-2 py-1 text-micro text-muted-foreground tabular-nums">
                Showing {snippets.length}{" "}
                {snippets.length === 1 ? "snippet" : "snippets"} · {loaded} of{" "}
                {matchCount} matches
              </p>
              {status.loadMoreError !== null ? (
                <div className="flex flex-wrap items-center gap-x-1">
                  <p role="alert" className="px-2 text-ui-xs text-destructive">
                    {status.loadMoreError.message}
                  </p>
                  <button
                    type="button"
                    {...navProps}
                    tabIndex={-1}
                    disabled={!expanded}
                    className={CONTINUATION_CLASS}
                    onClick={status.loadMoreError.retry}
                  >
                    Retry
                  </button>
                </div>
              ) : null}
              {status.loadMoreError === null && status.nextCursor !== null ? (
                <button
                  type="button"
                  {...navProps}
                  tabIndex={-1}
                  disabled={!expanded || status.loadingMore}
                  className={CONTINUATION_CLASS}
                  onClick={() => {
                    const next = status.nextCursor;
                    if (next !== null)
                      setCursors((current) => [...current, next]);
                  }}
                >
                  Show more matches
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}

const CONTINUATION_CLASS =
  "relative m-0.5 min-h-6 rounded-sm px-2 py-1 text-ui-xs text-muted-foreground outline-none transition-colors duration-120 hover:bg-foreground/6 active:press-scrim focus-visible:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

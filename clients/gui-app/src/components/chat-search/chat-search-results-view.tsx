/**
 * The result list of the global chat search dialog, as the spec's noise-control
 * wireframe draws it: title matches under "Chats", a divider labelled "matches
 * in messages", then message matches grouped by chat.
 *
 * Presentational. The pages are fetched and folded by the panel
 * (`useChatSearchResults` -> `mergeChatSearchPages`); expanding a group renders
 * whatever `renderExpansion` returns, which in the app is a chat-scoped query.
 */
import { useCallback, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import type {
  ChatSearchChatMatch,
  ChatSearchMessageMatch,
  ChatSearchRange,
} from "@traycer/protocol/host/chat-search/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  chatSearchGroupKey,
  chatSearchTierLabel,
  formatMatchCount,
  highlightSegments,
  type ChatSearchMergedResults,
} from "@/lib/chat-search/chat-search-results";
import { useRegisteredEpicTitle } from "@/lib/epic-selectors";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { useChatSearchNavProps } from "@/components/chat-search/chat-search-keyboard-nav";

export interface ChatSearchOpenTarget {
  readonly epicId: string;
  readonly chatId: string;
  readonly messageId: string | null;
}

export interface ChatSearchExpansionTarget {
  readonly epicId: string;
  readonly chatId: string;
}

export interface ChatSearchResultsViewProps {
  readonly results: ChatSearchMergedResults;
  /** A show-more page is in flight; its button stays disabled. */
  readonly loadingMore: boolean;
  /**
   * The query is long enough for the host to search message text. Below that
   * only titles are searched, and an empty message section says nothing.
   */
  readonly messagesSearched: boolean;
  readonly onOpen: (target: ChatSearchOpenTarget) => void;
  readonly onShowMoreChats: (cursor: string) => void;
  readonly onShowMoreMessages: (cursor: string) => void;
  readonly renderExpansion: (target: ChatSearchExpansionTarget) => ReactNode;
}

export function ChatSearchResultsView(props: ChatSearchResultsViewProps) {
  const {
    loadingMore,
    messagesSearched,
    onOpen,
    onShowMoreChats,
    onShowMoreMessages,
    renderExpansion,
    results,
  } = props;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleExpanded = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const { chatMatches, messageMatches } = results;
  const empty = chatMatches.length === 0 && messageMatches.length === 0;

  return (
    <div className="flex flex-col pb-2">
      {results.indexState === "partial" ? (
        <p
          role="status"
          className="mx-3 mt-2 rounded-md bg-foreground/5 px-2.5 py-1.5 text-ui-xs text-muted-foreground"
        >
          Still indexing chats on this host. Some results may be missing.
        </p>
      ) : null}
      {empty ? (
        <p className="px-3 py-6 text-center text-ui-sm text-muted-foreground">
          No chats match.
        </p>
      ) : null}

      {chatMatches.length > 0 ? (
        <section aria-label="Chats">
          <h3 className="px-3 pt-2 pb-1 text-ui-xs font-medium tracking-wide text-muted-foreground uppercase">
            Chats
          </h3>
          <ul className="flex flex-col">
            {chatMatches.map((match) => {
              const key = chatSearchGroupKey(match);
              return (
                <ChatMatchRow
                  key={key}
                  match={match}
                  expanded={expanded.has(key)}
                  onOpen={onOpen}
                  onToggleExpanded={() => toggleExpanded(key)}
                  renderExpansion={renderExpansion}
                />
              );
            })}
          </ul>
          {results.chatNextCursor !== null ? (
            <ShowMoreButton
              label="Show more chats"
              disabled={loadingMore}
              onClick={() => {
                if (results.chatNextCursor !== null) {
                  onShowMoreChats(results.chatNextCursor);
                }
              }}
            />
          ) : null}
        </section>
      ) : null}

      {messageMatches.length > 0 ? (
        <section>
          <div
            role="separator"
            aria-label="Matches in messages"
            className="flex items-center gap-2.5 px-3 pt-3 pb-1 text-ui-xs text-muted-foreground before:flex-1 before:border-t before:border-border after:flex-1 after:border-t after:border-border"
          >
            matches in messages
          </div>
          <ul className="flex flex-col">
            {messageMatches.map((match) => {
              const key = chatSearchGroupKey(match);
              return (
                <MessageMatchRow
                  key={key}
                  match={match}
                  expanded={expanded.has(key)}
                  onOpen={onOpen}
                  onToggleExpanded={() => toggleExpanded(key)}
                  renderExpansion={renderExpansion}
                />
              );
            })}
          </ul>
          {results.messageNextCursor !== null ? (
            <ShowMoreButton
              label="Show more message matches"
              disabled={loadingMore}
              onClick={() => {
                if (results.messageNextCursor !== null) {
                  onShowMoreMessages(results.messageNextCursor);
                }
              }}
            />
          ) : null}
        </section>
      ) : null}

      {!messagesSearched ? (
        <p className="px-3 pt-2 text-ui-xs text-muted-foreground">
          Type at least two characters to search messages.
        </p>
      ) : null}
      {loadingMore ? (
        <div className="flex justify-center py-2">
          <AgentSpinningDots
            className="text-muted-foreground"
            testId={undefined}
            variant={undefined}
          />
        </div>
      ) : null}
    </div>
  );
}

interface RowProps<Match> {
  readonly match: Match;
  readonly expanded: boolean;
  readonly onOpen: (target: ChatSearchOpenTarget) => void;
  readonly onToggleExpanded: () => void;
  readonly renderExpansion: (target: ChatSearchExpansionTarget) => ReactNode;
}

function ChatMatchRow(props: RowProps<ChatSearchChatMatch>) {
  const navProps = useChatSearchNavProps();
  const { expanded, match, onOpen, onToggleExpanded, renderExpansion } = props;
  const title = displayChatTitle(match.title);
  return (
    <li className="flex flex-col">
      <button
        type="button"
        {...navProps}
        className={ROW_BUTTON_CLASS}
        onClick={() =>
          onOpen({
            epicId: match.epicId,
            chatId: match.chatId,
            messageId: null,
          })
        }
      >
        <span className="truncate font-medium text-foreground">
          <ChatSearchHighlightedText
            text={title}
            ranges={title === match.title ? match.titleHighlights : []}
          />
        </span>
        <RowMeta>
          <TaskLabel epicId={match.epicId} />
          <ChatSearchResultTime at={match.updatedAt} />
          {match.lifecycleState === "archived" ? <span>archived</span> : null}
        </RowMeta>
      </button>
      {match.messageMatchCount > 0 ? (
        <ExpandToggle
          label={`also ${formatMatchCount(match.messageMatchCount)} in messages`}
          expanded={expanded}
          onToggle={onToggleExpanded}
        />
      ) : null}
      {expanded
        ? renderExpansion({ epicId: match.epicId, chatId: match.chatId })
        : null}
    </li>
  );
}

function MessageMatchRow(props: RowProps<ChatSearchMessageMatch>) {
  const navProps = useChatSearchNavProps();
  const { expanded, match, onOpen, onToggleExpanded, renderExpansion } = props;
  const best = match.best;
  return (
    <li className="flex flex-col">
      <button
        type="button"
        {...navProps}
        className={ROW_BUTTON_CLASS}
        onClick={() =>
          onOpen({
            epicId: match.epicId,
            chatId: match.chatId,
            messageId: best.messageId,
          })
        }
      >
        <span className="truncate font-medium text-foreground">
          {displayChatTitle(match.title)}
        </span>
        <span className="line-clamp-2 text-ui-xs text-foreground/80">
          <ChatSearchHighlightedText
            text={best.snippet.text}
            ranges={best.snippet.highlights}
          />
        </span>
        <RowMeta>
          <TaskLabel epicId={match.epicId} />
          <span>{chatSearchTierLabel(best)}</span>
          <ChatSearchResultTime at={best.createdAt} />
          <span>{formatMatchCount(match.matchCount)}</span>
        </RowMeta>
      </button>
      {match.matchCount > 1 ? (
        <ExpandToggle
          label={`Show all ${formatMatchCount(match.matchCount)}`}
          expanded={expanded}
          onToggle={onToggleExpanded}
        />
      ) : null}
      {expanded
        ? renderExpansion({ epicId: match.epicId, chatId: match.chatId })
        : null}
    </li>
  );
}

const ROW_BUTTON_CLASS =
  "flex w-full min-w-0 flex-col items-start gap-0.5 px-3 py-1.5 text-left text-ui-sm outline-none hover:bg-foreground/5 focus-visible:bg-foreground/8";

function RowMeta(props: { readonly children: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-ui-xs text-muted-foreground [&>*:not(:first-child)]:before:mr-1.5 [&>*:not(:first-child)]:before:content-['·']">
      {props.children}
    </span>
  );
}

function ExpandToggle(props: {
  readonly label: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const navProps = useChatSearchNavProps();
  return (
    <button
      type="button"
      {...navProps}
      aria-expanded={props.expanded}
      onClick={props.onToggle}
      className="flex items-center gap-1 self-start px-3 pb-1 text-ui-xs text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground focus-visible:underline"
    >
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "size-3 transition-transform",
          props.expanded && "rotate-90",
        )}
      />
      {props.label}
    </button>
  );
}

function ShowMoreButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  const navProps = useChatSearchNavProps();
  return (
    <Button
      {...navProps}
      variant="ghost"
      size="xs"
      className="mx-1.5 mt-0.5 self-start text-muted-foreground"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </Button>
  );
}

/** A leaf, so the shared minute clock repaints the label and not the row. */
export function ChatSearchResultTime(props: { readonly at: number }) {
  return <span>{useRelativeTimestamp(props.at)}</span>;
}

/** A chat's task, when that task is open in this window; nothing otherwise. */
function TaskLabel(props: { readonly epicId: string }) {
  const title = useRegisteredEpicTitle(props.epicId);
  if (title === null || title.length === 0) return null;
  return <span className="max-w-full truncate">{title}</span>;
}

export function ChatSearchHighlightedText(props: {
  readonly text: string;
  readonly ranges: ReadonlyArray<ChatSearchRange>;
}) {
  return (
    <>
      {highlightSegments(props.text, props.ranges).map((segment) =>
        segment.highlighted ? (
          // Keyed by offset: segments never overlap, so the start is unique.
          <mark
            key={segment.start}
            className="rounded-[2px] bg-primary/25 text-foreground"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={segment.start}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function displayChatTitle(title: string): string {
  return title.trim().length === 0 ? "Untitled chat" : title;
}

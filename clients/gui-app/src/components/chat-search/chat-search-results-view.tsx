/**
 * The result list of the global chat search dialog, as the spec's noise-control
 * wireframe draws it: title matches under "Chats", a divider labelled "matches
 * in messages", then message matches grouped by chat.
 *
 * Presentational. The pages are fetched and folded by the panel
 * (`useChatSearchResults` -> `mergeChatSearchPages`); expanding a group renders
 * whatever `renderExpansion` returns, which in the app is a chat-scoped query.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronRightIcon } from "lucide-react";
import type {
  ChatSearchChatMatch,
  ChatSearchMessageMatch,
  ChatSearchMessageHit,
  ChatSearchRange,
} from "@traycer/protocol/host/chat-search/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  chatSearchGroupKey,
  chatSearchRoleLabels,
  chatSearchSnippetWindow,
  formatMatchCount,
  highlightSegments,
  type ChatSearchMergedResults,
} from "@/lib/chat-search/chat-search-results";
import type {
  ChatSearchLoadMoreError,
  ChatSearchPageError,
} from "@/hooks/chats/use-chat-search-query";
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
  readonly best: ChatSearchMessageHit | null;
  readonly matchCount: number;
  readonly expanded: boolean;
  readonly variant: ChatSearchRowVariant;
}

export interface ChatSearchResultsViewProps {
  readonly results: ChatSearchMergedResults;
  /** A show-more page is in flight; its button stays disabled. */
  readonly loadingMore: boolean;
  /**
   * A show-more page that failed. Its section keeps the rows it has and shows
   * the failure with a retry in place of the continuation it could not load.
   */
  readonly loadMoreError: ChatSearchLoadMoreError | null;
  /**
   * The query is long enough for the host to search message text. Below that
   * only titles are searched, and an empty message section says nothing.
   */
  readonly messagesSearched: boolean;
  readonly onOpen: (target: ChatSearchOpenTarget) => void;
  readonly onShowMoreChats: (cursor: string) => void;
  readonly onShowMoreMessages: (cursor: string) => void;
  readonly renderExpansion: (target: ChatSearchExpansionTarget) => ReactNode;
  /**
   * Task names by epic id from a source that covers tasks this window has not
   * opened (the account's task list). A task open in this window uses its live
   * registered title instead.
   */
  readonly taskTitles: ReadonlyMap<string, string>;
}

export function ChatSearchResultsView(props: ChatSearchResultsViewProps) {
  const {
    loadMoreError,
    loadingMore,
    messagesSearched,
    onOpen,
    onShowMoreChats,
    onShowMoreMessages,
    renderExpansion,
    results,
    taskTitles,
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

  const { chatMatches, chatNextCursor, messageMatches, messageNextCursor } =
    results;
  const { chatsError, chatsShown, exhausted, messagesError, messagesShown } =
    sectionsOf(results, loadMoreError);
  const loadMoreChats = useMemo(
    () =>
      chatNextCursor === null ? null : () => onShowMoreChats(chatNextCursor),
    [chatNextCursor, onShowMoreChats],
  );
  const loadMoreMessages = useMemo(
    () =>
      messageNextCursor === null
        ? null
        : () => onShowMoreMessages(messageNextCursor),
    [messageNextCursor, onShowMoreMessages],
  );

  return (
    <div className="flex flex-col pb-2">
      {results.indexState === "partial" ? <ChatSearchPartialIndexNote /> : null}
      {exhausted ? (
        <p className="px-3 py-6 text-center text-ui-sm text-muted-foreground">
          No chats match.
        </p>
      ) : null}

      {chatsShown ? (
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
                  taskTitle={taskTitles.get(match.epicId) ?? null}
                />
              );
            })}
          </ul>
          {chatMatches.length === 0 ? <EmptyPageNote /> : null}
          <SectionContinuation
            error={chatsError}
            label="Show more chats"
            disabled={loadingMore}
            onShowMore={loadMoreChats}
          />
        </section>
      ) : null}

      {messagesShown ? (
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
                  taskTitle={taskTitles.get(match.epicId) ?? null}
                  variant="full"
                />
              );
            })}
          </ul>
          {messageMatches.length === 0 ? <EmptyPageNote /> : null}
          <SectionContinuation
            error={messagesError}
            label="Show more matches"
            disabled={loadingMore}
            onShowMore={loadMoreMessages}
          />
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
            className={undefined}
            tone="muted"
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
  /** The task list's name for this result's task, when it has one. */
  readonly taskTitle: string | null;
}

function ChatMatchRow(props: RowProps<ChatSearchChatMatch>) {
  const navProps = useChatSearchNavProps();
  const {
    expanded,
    match,
    onOpen,
    onToggleExpanded,
    renderExpansion,
    taskTitle,
  } = props;
  const title = displayChatTitle(match.title);
  const expansionId = useId();
  const onKeyDown = useDisclosureKeys(
    expanded,
    onToggleExpanded,
    match.messageMatchCount > 0,
  );
  return (
    <li className="flex min-w-0 flex-col py-1">
      <div className="flex min-w-0 items-start gap-2">
        <button
          type="button"
          {...navProps}
          onKeyDown={onKeyDown}
          className={ROW_BUTTON_CLASS}
          onClick={() =>
            onOpen({
              epicId: match.epicId,
              chatId: match.chatId,
              messageId: null,
            })
          }
        >
          <span className="max-w-full truncate font-medium text-foreground">
            <ChatSearchHighlightedText
              text={title}
              ranges={title === match.title ? match.titleHighlights : []}
            />
          </span>
          <RowMeta>
            <TaskLabel epicId={match.epicId} listedTitle={taskTitle} />
            <ChatSearchResultTime at={match.updatedAt} />
            {match.lifecycleState === "archived" ? <span>archived</span> : null}
          </RowMeta>
        </button>
        {match.messageMatchCount > 0 ? (
          <ExpandToggle
            label={formatMatchCount(match.messageMatchCount)}
            expanded={expanded}
            onToggle={onToggleExpanded}
            controls={expansionId}
          />
        ) : null}
      </div>
      <div id={expansionId}>
        <LazyExpansion
          target={{
            epicId: match.epicId,
            chatId: match.chatId,
            best: null,
            matchCount: match.messageMatchCount,
            expanded,
            variant: "full",
          }}
          renderExpansion={renderExpansion}
        />
      </div>
    </li>
  );
}

/**
 * How wide a column the row is drawn in. `compact` is the sidebar's ~300px
 * one: the task label goes (every hit there belongs to the task on screen) and
 * the snippet takes a single line. Everything else - time, tier, match count,
 * the expand toggle - is the same row.
 *
 * A variant rather than a `className` on purpose: the call site places the
 * row, the row owns how it looks.
 */
export type ChatSearchRowVariant = "full" | "compact";

export interface ChatSearchMessageMatchRowProps {
  readonly match: ChatSearchMessageMatch;
  readonly expanded: boolean;
  readonly onOpen: (target: ChatSearchOpenTarget) => void;
  readonly onToggleExpanded: () => void;
  readonly renderExpansion: (target: ChatSearchExpansionTarget) => ReactNode;
  /** The task list's name for this result's task, when it has one. */
  readonly taskTitle: string | null;
  readonly variant: ChatSearchRowVariant;
}

export function MessageMatchRow(props: ChatSearchMessageMatchRowProps) {
  const navProps = useChatSearchNavProps();
  const {
    expanded,
    match,
    onOpen,
    onToggleExpanded,
    renderExpansion,
    taskTitle,
    variant,
  } = props;
  const expansionId = useId();
  const onKeyDown = useDisclosureKeys(
    expanded,
    onToggleExpanded,
    match.matchCount > 1,
  );
  return (
    <li className="flex min-w-0 flex-col gap-1 px-2 py-1">
      <div className="flex min-w-0 items-start gap-2">
        <button
          type="button"
          {...navProps}
          onKeyDown={onKeyDown}
          className={ROW_BUTTON_CLASS}
          aria-label={`Open chat ${displayChatTitle(match.title)} at its best match`}
          onClick={() =>
            onOpen({
              epicId: match.epicId,
              chatId: match.chatId,
              messageId: match.best.messageId,
            })
          }
        >
          <span className="max-w-full truncate font-medium text-foreground">
            {displayChatTitle(match.title)}
          </span>
          {variant === "full" ? (
            <RowMeta>
              <TaskLabel epicId={match.epicId} listedTitle={taskTitle} />
            </RowMeta>
          ) : null}
        </button>
        {match.matchCount > 1 ? (
          <ExpandToggle
            label={formatMatchCount(match.matchCount)}
            expanded={expanded}
            onToggle={onToggleExpanded}
            controls={expansionId}
          />
        ) : null}
      </div>
      <div
        id={expansionId}
        className="min-w-0 rounded-md bg-foreground/4 p-0.5"
      >
        <LazyExpansion
          target={{
            epicId: match.epicId,
            chatId: match.chatId,
            best: match.best,
            matchCount: match.matchCount,
            expanded,
            variant,
          }}
          renderExpansion={renderExpansion}
        >
          <ChatSearchMessageRow
            hit={match.best}
            count={1}
            onOpenMessage={(messageId) =>
              onOpen({ epicId: match.epicId, chatId: match.chatId, messageId })
            }
            variant={variant}
            disabled={false}
          />
        </LazyExpansion>
      </div>
    </li>
  );
}

/** Fetch on the first disclosure only; retain the content for the closing transition. */
function LazyExpansion(props: {
  readonly target: ChatSearchExpansionTarget;
  readonly renderExpansion: (target: ChatSearchExpansionTarget) => ReactNode;
  readonly children?: ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  if (props.target.expanded && !opened) setOpened(true);
  return opened ? props.renderExpansion(props.target) : props.children;
}

function useDisclosureKeys(
  expanded: boolean,
  toggle: () => void,
  expandable: boolean,
) {
  const navProps = useChatSearchNavProps();
  return (event: KeyboardEvent<HTMLElement>) => {
    if (
      expandable &&
      (event.key === "ArrowRight" || event.key === "ArrowLeft")
    ) {
      event.preventDefault();
      if ((event.key === "ArrowRight") !== expanded) toggle();
      return;
    }
    navProps.onKeyDown?.(event);
  };
}

const ROW_BUTTON_CLASS =
  "relative flex w-full min-w-0 flex-col items-start gap-1 rounded-md px-2.5 py-1.5 text-left text-ui-sm outline-none transition-colors duration-120 hover:bg-foreground/5 active:press-scrim focus-visible:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** One real message, shared by the collapsed best hit and fetched snippets. */
export function ChatSearchMessageRow(props: {
  readonly hit: ChatSearchMessageHit;
  readonly count: number;
  readonly onOpenMessage: (messageId: string) => void;
  readonly variant: ChatSearchRowVariant;
  readonly disabled: boolean;
}) {
  const { hit, count, onOpenMessage, variant, disabled } = props;
  const navProps = useChatSearchNavProps();
  const role = chatSearchRoleLabels(hit);
  const date = new Date(hit.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const repeated = count > 1 ? `, repeated ${count} times` : "";
  return (
    <button
      type="button"
      {...navProps}
      // Without arrow navigation (the sidebar), children remain ordinary Tab stops.
      // ponytail: not a true roving composite; use a shared roving controller if a screen-reader pass asks for it.
      tabIndex={navProps.onKeyDown === undefined ? 0 : -1}
      disabled={disabled}
      aria-label={`${role.full}, ${date}${repeated}: ${hit.snippet.text}`}
      onClick={() => onOpenMessage(hit.messageId)}
      className="relative flex w-full min-w-0 items-baseline gap-2 rounded-sm px-2 py-1.5 text-left text-ui-xs outline-none transition-colors duration-120 hover:bg-foreground/6 active:press-scrim focus-visible:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <TooltipWrapper
        label={role.full}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span
          aria-label={role.full}
          className={cn(
            "shrink-0 truncate text-muted-foreground",
            variant === "compact" ? "w-[7ch]" : "w-[11ch]",
            role.short === "You" && "text-foreground",
          )}
        >
          {role.short}
        </span>
      </TooltipWrapper>
      <CenteredSnippet hit={hit} />
      {count > 1 ? (
        <span
          aria-label={`Repeated ${count} times`}
          className="shrink-0 text-micro font-medium whitespace-nowrap text-muted-foreground tabular-nums"
        >
          ×{count}
        </span>
      ) : null}
      <ChatSearchResultTime at={hit.createdAt} />
    </button>
  );
}

function CenteredSnippet(props: { readonly hit: ChatSearchMessageHit }) {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const [length, setLength] = useState(64);
  useEffect(() => {
    if (element === null) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      // ponytail: conservative average glyph width; measure actual glyphs if proportional-font snippets need tighter fitting.
      const glyphWidth =
        Number.parseFloat(getComputedStyle(element).fontSize) * 0.65;
      if (width > 0 && glyphWidth > 0)
        setLength(Math.max(1, Math.floor(width / glyphWidth) - 2));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  const { snippet } = props.hit;
  const window = chatSearchSnippetWindow(
    snippet.text,
    snippet.highlights,
    length,
  );
  return (
    <span
      ref={setElement}
      className="min-w-0 flex-1 truncate text-foreground/80"
    >
      {window.start > 0 ? "…" : null}
      <ChatSearchHighlightedText
        text={window.text}
        ranges={window.highlights}
      />
      {window.end < snippet.text.length ? "…" : null}
    </span>
  );
}

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
  readonly controls: string;
}) {
  const navProps = useChatSearchNavProps();
  const onKeyDown = useDisclosureKeys(props.expanded, props.onToggle, true);
  return (
    <button
      type="button"
      {...navProps}
      onKeyDown={onKeyDown}
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      onClick={props.onToggle}
      className="relative mt-1.5 mr-1 flex min-h-6 shrink-0 items-center gap-1 rounded-sm bg-foreground/6 px-2 py-0.5 text-ui-xs whitespace-nowrap text-muted-foreground tabular-nums outline-none transition-colors duration-120 hover:bg-foreground/12 active:press-scrim focus-visible:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {props.label}
      <ChevronRightIcon
        aria-hidden
        className={cn("size-3", props.expanded && "rotate-90")}
      />
    </button>
  );
}

/**
 * The index is still building, so an absent result may only be an unread chat.
 * Rendered by every surface that shows hits, so the caveat reads the same
 * wherever the hits are.
 */
export function ChatSearchPartialIndexNote() {
  return (
    <p
      role="status"
      className="mx-3 mt-2 rounded-md bg-foreground/5 px-2.5 py-1.5 text-ui-xs text-muted-foreground"
    >
      Still indexing chats on this host. Some results may be missing.
    </p>
  );
}

/**
 * A page that ranked matches but showed none of them: every one belonged to a
 * task this requester cannot read. The section's continuation control sits
 * right below, because the next page may well have one they can.
 */
function EmptyPageNote() {
  return (
    <p className="px-3 py-1 text-ui-xs text-muted-foreground">
      No matches on this page.
    </p>
  );
}

/**
 * Which sections are drawn. A section is drawn whenever it has rows OR a
 * cursor OR a failed page. Since access is resolved after ranking and paging,
 * a page whose every match was in a task the requester cannot read comes back
 * EMPTY with a cursor still set, and the accessible match sits on the next
 * page - so a section gated on rows alone buries a reachable result
 * permanently. `exhausted` is the terminal answer, and only then: nothing on
 * screen and nowhere left to page to.
 */
function sectionsOf(
  results: ChatSearchMergedResults,
  loadMoreError: ChatSearchLoadMoreError | null,
): {
  readonly chatsError: ChatSearchLoadMoreError | null;
  readonly messagesError: ChatSearchLoadMoreError | null;
  readonly chatsShown: boolean;
  readonly messagesShown: boolean;
  readonly exhausted: boolean;
} {
  const chatsError = loadMoreError?.section === "chats" ? loadMoreError : null;
  const messagesError =
    loadMoreError?.section === "messages" ? loadMoreError : null;
  const chatsShown =
    results.chatMatches.length > 0 ||
    results.chatNextCursor !== null ||
    chatsError !== null;
  const messagesShown =
    results.messageMatches.length > 0 ||
    results.messageNextCursor !== null ||
    messagesError !== null;
  return {
    chatsError,
    messagesError,
    chatsShown,
    messagesShown,
    exhausted: !chatsShown && !messagesShown,
  };
}

/**
 * What follows a section's rows: nothing when it is out of pages, its show-more
 * control when there is a cursor, or - when its last page failed - the failure
 * in that control's place, with a retry that refetches only that page. The rows
 * above stay either way.
 */
export function SectionContinuation(props: {
  readonly error: ChatSearchPageError | null;
  readonly label: string;
  readonly disabled: boolean;
  /** Loads the next page; `null` when the section is out of pages. */
  readonly onShowMore: (() => void) | null;
}) {
  const { error, onShowMore } = props;
  if (error !== null) {
    return (
      <div className="flex flex-wrap items-center gap-x-1 px-1.5 pt-0.5">
        <p role="alert" className="px-1.5 text-ui-xs text-destructive">
          {error.message}
        </p>
        <ShowMoreButton label="Retry" disabled={false} onClick={error.retry} />
      </div>
    );
  }
  if (onShowMore === null) return null;
  return (
    <ShowMoreButton
      label={props.label}
      disabled={props.disabled}
      onClick={onShowMore}
    />
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
      variant="muted"
      size="xs"
      className="mx-1.5 mt-0.5 self-start"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </Button>
  );
}

/** A leaf, so the shared minute clock repaints the label and not the row. */
export function ChatSearchResultTime(props: { readonly at: number }) {
  return (
    <time
      dateTime={new Date(props.at).toISOString()}
      className="shrink-0 text-right text-ui-xs whitespace-nowrap text-muted-foreground tabular-nums"
    >
      {useRelativeTimestamp(props.at)}
    </time>
  );
}

/**
 * A result's task name: the live registered title while the task is open in
 * this window, else the account task list's title, else nothing.
 */
function TaskLabel(props: {
  readonly epicId: string;
  readonly listedTitle: string | null;
}) {
  const registered = useRegisteredEpicTitle(props.epicId);
  const title = registered ?? props.listedTitle;
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
            className="rounded-xs bg-foreground px-0.5 font-medium text-background"
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

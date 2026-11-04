import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronLeft,
  CircleHelp,
  Clock,
  Megaphone,
  Search,
  X,
} from "lucide-react";
import type {
  BotConversationSearchHit,
  BotConversationSearchUnreachable,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import { BotReadFailure } from "@/components/bots/bot-read-failure";
import { NamedBotAvatar, PersonAvatar } from "@/components/bots/bot-avatars";
import {
  ChatSearchHighlightedText,
  ChatSearchResultTime,
} from "@/components/chat-search/chat-search-results-view";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useBotConversationSearch } from "@/hooks/bots/use-bot-conversation-search";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useOpenBotChannel } from "@/hooks/bots/use-open-bot-channel";
import {
  useEnvironmentMemberDirectory,
  useEnvironmentMembers,
} from "@/hooks/bots/use-environment-members-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { botMemberName } from "@/lib/bots/bot-member-names";
import {
  botSearchHitKey,
  botSearchHitsOf,
  botSearchUnreachableOf,
} from "@/lib/bots/bot-search-model";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  BOT_SEARCH_NO_FILTERS,
  jumpToBotSearchHit,
  useBotSearchStore,
  type BotSearchDate,
  type BotSearchFilters,
  type BotSearchFrom,
  type BotSearchRecent,
  type BotSearchScope,
  type BotSearchSort,
  type BotSearchWhere,
} from "@/stores/bots/bot-search-store";

/** How close to the end of the list the next page is asked for. */
const NEXT_PAGE_MARGIN_PX = 240;

const NO_BOTS: ReadonlyArray<BotRecord> = [];

const DATE_OPTIONS: ReadonlyArray<FilterOption<BotSearchDate>> = [
  { value: "any", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

const WHERE_OPTIONS: ReadonlyArray<FilterOption<BotSearchWhere>> = [
  { value: "both", label: "Posts and threads" },
  { value: "posts", label: "Posts only" },
  { value: "threads", label: "Threads only" },
];

const SORT_LABEL: Readonly<Record<BotSearchSort, string>> = {
  relevance: "Most relevant",
  newest: "Newest",
};

interface FilterOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
}

/** The host's count, or the rows so far where it has none and more follow. */
function resultCountLabel(input: {
  readonly total: number | null;
  readonly loaded: number;
  readonly hasMore: boolean;
}): string {
  const count = input.total ?? input.loaded;
  if (input.total === null && input.hasMore) return `${count}+ results`;
  return count === 1 ? "1 result" : `${count} results`;
}

function isFilteredFrom(filters: BotSearchFilters): boolean {
  return (
    filters.from !== BOT_SEARCH_NO_FILTERS.from ||
    filters.date !== BOT_SEARCH_NO_FILTERS.date ||
    filters.where !== BOT_SEARCH_NO_FILTERS.where
  );
}

function fromValue(from: BotSearchFrom): string {
  return typeof from === "string" ? from : `member:${from.userId}`;
}

function fromOfValue(value: string): BotSearchFrom {
  if (value === "anyone" || value === "bot" || value === "me") return value;
  return { userId: value.slice("member:".length) };
}

function titleOf(bots: ReadonlyArray<BotRecord>, botId: string): string | null {
  return bots.find((bot) => bot.botId === botId)?.title ?? null;
}

/**
 * Search in Tracy (decision 186): a bot's channel and threads, or every
 * bot's, in the rail beside the channel, where the thread panel sits. A
 * result lands the channel on its post, or opens its thread here with a link
 * back; ↑/↓ step through the results and land each.
 *
 * The search itself is the store's, so it is here again, with its filters and
 * its scroll, after a result's thread or another bot's channel has had the
 * rail.
 */
export function BotSearchPanel(props: {
  /** The channel the panel is open beside. */
  readonly botId: string;
  readonly botTitle: string;
  readonly hostId: string;
  /** The channel's environment, whose members From offers. */
  readonly environmentId: string;
  readonly onClose: () => void;
}): ReactNode {
  const { botId, botTitle, onClose } = props;
  const client = useTabHostClient();
  const openBotChannel = useOpenBotChannel();
  const bots = useBotListQuery(client, true).data?.bots ?? NO_BOTS;
  const typed = useBotSearchStore((state) => state.query);
  const scope = useBotSearchStore((state) => state.scope);
  const selectedKey = useBotSearchStore((state) => state.selectedKey);
  const focusAsked = useBotSearchStore((state) => state.focusAsked);
  const setQuery = useBotSearchStore((state) => state.setQuery);
  const setScope = useBotSearchStore((state) => state.setScope);
  const remember = useBotSearchStore((state) => state.remember);
  const search = useBotConversationSearch();
  const pages = search.pages?.pages ?? [];
  const hits = botSearchHitsOf(pages);

  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const state = useBotSearchStore.getState();
    if (state.focusAnswered === state.focusAsked) return;
    inputRef.current?.focus();
    state.answerFocus();
  }, [focusAsked]);

  const scopeTitle =
    scope.kind === "bot" ? (titleOf(bots, scope.botId) ?? botTitle) : null;
  const rememberThis = (): void => {
    const query = typed.trim();
    if (query.length > 0) remember({ query, scope, scopeTitle });
  };
  // `keepFocus` for a step of the keyboard's, which goes on from the input
  // wherever the result takes the rail.
  const openHit = (hit: BotConversationSearchHit, keepFocus: boolean): void => {
    rememberThis();
    if (jumpToBotSearchHit(botId, hit, keepFocus)) {
      openBotChannel(hit.botId, null);
    }
  };
  const step = (direction: 1 | -1): void => {
    const at = hits.findIndex((hit) => botSearchHitKey(hit) === selectedKey);
    const next = hits.at(
      at < 0 ? 0 : Math.min(Math.max(at + direction, 0), hits.length - 1),
    );
    if (next !== undefined) openHit(next, true);
  };
  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      step(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen =
        hits.find((hit) => botSearchHitKey(hit) === selectedKey) ?? hits.at(0);
      if (chosen === undefined) rememberThis();
      else openHit(chosen, false);
    } else if (event.key === "Escape") {
      onClose();
    }
  };

  return (
    <section
      aria-label="Search"
      data-testid="bot-search-panel"
      className="flex min-h-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 items-center gap-2 px-4 py-2.5">
        <h2 className="min-w-0 flex-1 truncate text-ui-md font-semibold text-foreground">
          Search
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close search"
          data-testid="bot-search-close"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-4 pb-3">
        <div className="flex items-center gap-1.5 rounded-md border border-input px-2">
          <Search
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <Input
            ref={inputRef}
            type="text"
            variant="bare"
            size="sm"
            aria-label="Search"
            placeholder={scopeTitle === null ? "Search all bots" : "Search"}
            data-testid="bot-search-input"
            value={typed}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
          />
          {scopeTitle === null ? null : (
            <Badge variant="muted" data-testid="bot-search-scope-chip">
              <span className="max-w-32 truncate">{`in ${scopeTitle}`}</span>
              <button
                type="button"
                aria-label="Search all bots"
                data-testid="bot-search-scope-remove"
                className="rounded-xs focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => setScope({ kind: "all" })}
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </Badge>
          )}
        </div>
        {search.query === null ? null : (
          <BotSearchFilterRow
            bots={bots}
            botTitle={botTitle}
            environmentId={props.environmentId}
            hostId={props.hostId}
          />
        )}
      </div>
      {search.query === null ? (
        <BotSearchBeforeTyping botId={botId} />
      ) : (
        <BotSearchResultList
          bots={bots}
          hits={hits}
          scope={scope}
          selectedKey={selectedKey}
          total={pages.at(0)?.total ?? null}
          partial={pages.some((page) => page.indexState === "partial")}
          unreachable={botSearchUnreachableOf(pages)}
          loading={search.loading}
          loadingMore={search.loadingMore}
          hasMore={search.hasMore}
          onLoadMore={search.loadMore}
          moreFailed={search.moreFailed}
          onRetryMore={search.retryMore}
          failed={search.error !== null && pages.length === 0}
          onRetry={search.retry}
          query={search.query}
          scopeTitle={scopeTitle}
          onOpenHit={(hit) => openHit(hit, false)}
        />
      )}
    </section>
  );
}

/** The filters that narrow the results: In, From, Date and Where. */
function BotSearchFilterRow(props: {
  readonly bots: ReadonlyArray<BotRecord>;
  readonly botTitle: string;
  readonly environmentId: string;
  readonly hostId: string;
}): ReactNode {
  const { bots, botTitle, environmentId, hostId } = props;
  const client = useTabHostClient();
  const scope = useBotSearchStore((state) => state.scope);
  const filters = useBotSearchStore((state) => state.filters);
  const setScope = useBotSearchStore((state) => state.setScope);
  const setFilters = useBotSearchStore((state) => state.setFilters);
  const viewer = useAuthStore((state) => state.profile);
  const directory = useEnvironmentMemberDirectory(
    client,
    environmentId,
    useHostMethodSupport(hostId, "environment.members") === true,
  );
  const scopeTitle =
    scope.kind === "bot" ? (titleOf(bots, scope.botId) ?? botTitle) : null;
  const inOptions: ReadonlyArray<FilterOption<string>> = [
    { value: "all", label: "All bots" },
    ...bots
      .filter((bot) => bot.archivedAt === null)
      .map((bot) => ({ value: bot.botId, label: bot.title })),
  ];
  const fromOptions: ReadonlyArray<FilterOption<string>> = [
    { value: "anyone", label: "Anyone" },
    { value: "bot", label: scopeTitle ?? "The bot" },
    { value: "me", label: "Me" },
    ...(directory.members ?? [])
      .filter((member) => member.userId !== viewer?.userId)
      .map((member) => ({
        value: fromValue({ userId: member.userId }),
        label: botMemberName(member.userId, viewer, directory.resolve),
      })),
  ];
  return (
    <div
      data-testid="bot-search-filters"
      className="flex flex-wrap items-center gap-1.5"
    >
      <BotSearchFilter
        name="In"
        testId="bot-search-filter-in"
        options={inOptions}
        selected={scope.kind === "bot" ? scope.botId : "all"}
        onSelect={(value) =>
          setScope(
            value === "all" ? { kind: "all" } : { kind: "bot", botId: value },
          )
        }
      />
      <BotSearchFilter
        name="From"
        testId="bot-search-filter-from"
        options={fromOptions}
        selected={fromValue(filters.from)}
        onSelect={(value) => setFilters({ from: fromOfValue(value) })}
      />
      <BotSearchFilter
        name="Date"
        testId="bot-search-filter-date"
        options={DATE_OPTIONS}
        selected={filters.date}
        onSelect={(date) => setFilters({ date })}
      />
      <BotSearchFilter
        name="Where"
        testId="bot-search-filter-where"
        options={WHERE_OPTIONS}
        selected={filters.where}
        onSelect={(where) => setFilters({ where })}
      />
    </div>
  );
}

function BotSearchFilter<Value extends string>(props: {
  readonly name: string;
  readonly testId: string;
  readonly options: ReadonlyArray<FilterOption<Value>>;
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
}): ReactNode {
  const { name, testId, options, selected, onSelect } = props;
  const chosen = options.find((option) => option.value === selected);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="xs" data-testid={testId}>
          <span className="text-muted-foreground">{name}</span>
          <span className="max-w-28 truncate">{chosen?.label}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={selected}
          onValueChange={(value) => {
            const option = options.find((entry) => entry.value === value);
            if (option !== undefined) onSelect(option.value);
          }}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Before a query: the last searches, and the filters worth setting first. */
function BotSearchBeforeTyping(props: { readonly botId: string }): ReactNode {
  const { botId } = props;
  const recents = useBotSearchStore((state) => state.recents);
  const scope = useBotSearchStore((state) => state.scope);
  const filters = useBotSearchStore((state) => state.filters);
  const setQuery = useBotSearchStore((state) => state.setQuery);
  const setScope = useBotSearchStore((state) => state.setScope);
  const setFilters = useBotSearchStore((state) => state.setFilters);
  const applyRecent = (recent: BotSearchRecent): void => {
    setScope(recent.scope);
    setQuery(recent.query);
  };
  const thisBot = scope.kind === "bot" && scope.botId === botId;
  return (
    <div
      data-testid="bot-search-before-typing"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3"
    >
      {recents.length === 0 ? null : (
        <section aria-label="Recent" className="flex flex-col gap-1">
          <h3 className="text-ui-xs font-medium text-muted-foreground">
            Recent
          </h3>
          <ul className="flex flex-col">
            {recents.map((recent) => (
              <li
                key={JSON.stringify([recent.query, recent.scope])}
                data-testid="bot-search-recent"
              >
                <button
                  type="button"
                  className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-ui-sm text-foreground hover:bg-foreground/6 focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => applyRecent(recent)}
                >
                  <Clock
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {recent.query}
                  </span>
                  <span className="shrink-0 text-ui-xs text-muted-foreground">
                    {recent.scopeTitle ?? "All bots"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Narrow to" className="flex flex-col gap-1.5">
        <h3 className="text-ui-xs font-medium text-muted-foreground">
          Narrow to
        </h3>
        <div className="flex flex-wrap gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-pressed={thisBot}
            data-testid="bot-search-narrow-bot"
            onClick={() => setScope({ kind: "bot", botId })}
          >
            This bot
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-pressed={filters.from === "me"}
            data-testid="bot-search-narrow-me"
            onClick={() => setFilters({ from: "me" })}
          >
            From me
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-pressed={filters.date === "7d"}
            data-testid="bot-search-narrow-week"
            onClick={() => setFilters({ date: "7d" })}
          >
            Last 7 days
          </Button>
        </div>
      </section>
    </div>
  );
}

function BotSearchResultList(props: {
  readonly bots: ReadonlyArray<BotRecord>;
  readonly hits: ReadonlyArray<BotConversationSearchHit>;
  readonly scope: BotSearchScope;
  readonly selectedKey: string | null;
  readonly total: number | null;
  readonly partial: boolean;
  readonly unreachable: ReadonlyArray<BotConversationSearchUnreachable>;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly hasMore: boolean;
  readonly onLoadMore: () => void;
  readonly moreFailed: boolean;
  readonly onRetryMore: () => void;
  readonly failed: boolean;
  readonly onRetry: () => void;
  readonly query: string;
  readonly scopeTitle: string | null;
  readonly onOpenHit: (hit: BotConversationSearchHit) => void;
}): ReactNode {
  const { bots, hits, hasMore, loadingMore, onLoadMore, partial } = props;
  const sort = useBotSearchStore((state) => state.filters.sort);
  const setFilters = useBotSearchStore((state) => state.setFilters);
  const missedKey = useBotSearchStore((state) => state.missedKey);
  const setScrollTop = useBotSearchStore((state) => state.setScrollTop);
  const listRef = useRef<HTMLDivElement | null>(null);
  // The list back where it was: its pages are still held, so its height is.
  const keepList = useCallback((element: HTMLDivElement | null) => {
    listRef.current = element;
    if (element !== null) {
      element.scrollTop = useBotSearchStore.getState().scrollTop;
    }
  }, []);
  const loadMoreNearTheEnd = (): void => {
    const list = listRef.current;
    if (list === null || !hasMore || loadingMore || props.moreFailed) return;
    const left = list.scrollHeight - list.clientHeight - list.scrollTop;
    if (left < NEXT_PAGE_MARGIN_PX) onLoadMore();
  };
  // A page too short to scroll has no scroll to ask for the next one.
  useEffect(loadMoreNearTheEnd);
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [props.selectedKey]);

  if (props.failed) {
    return (
      <div className="p-4">
        <BotReadFailure
          message="Couldn't search."
          onRetry={props.onRetry}
          testId="bot-search-error"
        />
      </div>
    );
  }
  if (props.loading) {
    return (
      <div
        className="flex flex-1 items-center justify-center py-10 text-muted-foreground"
        aria-busy="true"
        data-testid="bot-search-loading"
      >
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </div>
    );
  }
  const notes = (
    <>
      {partial ? (
        <p
          role="status"
          data-testid="bot-search-partial"
          className="mx-4 mt-2 rounded-md bg-foreground/5 px-2.5 py-1.5 text-ui-xs text-muted-foreground"
        >
          Still indexing recent messages
        </p>
      ) : null}
      {props.unreachable.map((entry) => (
        <p
          key={entry.botId}
          role="status"
          data-testid="bot-search-unreachable"
          className="mx-4 mt-2 text-ui-xs text-muted-foreground"
        >
          {`${titleOf(bots, entry.botId) ?? "A bot"}'s host is not reachable`}
        </p>
      ))}
    </>
  );
  if (hits.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <BotSearchNoResults query={props.query} scopeTitle={props.scopeTitle} />
        {notes}
      </div>
    );
  }
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-4 pt-2 pb-1 text-ui-xs text-muted-foreground">
        <span
          className="min-w-0 flex-1 truncate"
          data-testid="bot-search-count"
        >
          {resultCountLabel({
            total: props.total,
            loaded: hits.length,
            hasMore: props.hasMore,
          })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid="bot-search-sort"
          onClick={() =>
            setFilters({ sort: sort === "relevance" ? "newest" : "relevance" })
          }
        >
          {SORT_LABEL[sort]}
        </Button>
      </div>
      <div
        ref={keepList}
        data-testid="bot-search-results"
        className="min-h-0 flex-1 overflow-y-auto pb-3"
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
          loadMoreNearTheEnd();
        }}
      >
        <ul className="flex flex-col">
          {hits.map((hit) => {
            const key = botSearchHitKey(hit);
            const selected = key === props.selectedKey;
            return (
              <li key={key}>
                <BotSearchHitRow
                  hit={hit}
                  botTitle={titleOf(bots, hit.botId)}
                  environmentId={
                    bots.find((bot) => bot.botId === hit.botId)
                      ?.environmentId ?? null
                  }
                  showBot={props.scope.kind === "all"}
                  selected={selected}
                  missed={key === missedKey}
                  onOpen={() => props.onOpenHit(hit)}
                />
              </li>
            );
          })}
        </ul>
        {props.moreFailed ? (
          <div className="px-4 py-3">
            <BotReadFailure
              message="Couldn't load more results."
              onRetry={props.onRetryMore}
              testId="bot-search-more-error"
            />
          </div>
        ) : null}
        {loadingMore ? (
          <div
            className="flex justify-center py-3 text-muted-foreground"
            aria-busy="true"
            data-testid="bot-search-loading-more"
          >
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          </div>
        ) : null}
        {notes}
      </div>
    </>
  );
}

function BotSearchNoResults(props: {
  readonly query: string;
  readonly scopeTitle: string | null;
}): ReactNode {
  const { query, scopeTitle } = props;
  const filters = useBotSearchStore((state) => state.filters);
  const clearFilters = useBotSearchStore((state) => state.clearFilters);
  const setScope = useBotSearchStore((state) => state.setScope);
  const filtered = isFilteredFrom(filters);
  return (
    <div
      data-testid="bot-search-no-results"
      className="flex flex-col items-center gap-3 px-6 py-10 text-center"
    >
      <p className="text-ui-sm font-medium text-foreground">
        {`No results for “${query}”`}
        {scopeTitle === null ? null : ` in ${scopeTitle}`}
      </p>
      {!filtered && scopeTitle === null ? null : (
        <div className="flex flex-wrap justify-center gap-2">
          {filtered ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="bot-search-clear-filters"
              onClick={clearFilters}
            >
              Clear filters
            </Button>
          ) : null}
          {scopeTitle === null ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="bot-search-widen"
              onClick={() => setScope({ kind: "all" })}
            >
              Search all bots
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function BotSearchHitRow(props: {
  readonly hit: BotConversationSearchHit;
  /** `null` for a bot the list does not carry. */
  readonly botTitle: string | null;
  readonly environmentId: string | null;
  /** Say which bot the row is in: it is not the one searched. */
  readonly showBot: boolean;
  readonly selected: boolean;
  readonly missed: boolean;
  readonly onOpen: () => void;
}): ReactNode {
  const { hit, botTitle, environmentId, showBot, selected, missed } = props;
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      data-testid="bot-search-hit"
      data-message-id={hit.messageId}
      className={cn(
        "flex w-full min-w-0 gap-2 px-4 py-2 text-left hover:bg-foreground/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        selected && "bg-foreground/8",
      )}
      onClick={props.onOpen}
    >
      <BotSearchHitSender
        hit={hit}
        botTitle={botTitle}
        environmentId={environmentId}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-1.5 text-ui-xs">
          <BotSearchHitName
            hit={hit}
            botTitle={botTitle}
            environmentId={environmentId}
          />
          <BotSearchHitKind kind={hit.rowKind} />
          <span className="ml-auto shrink-0">
            <ChatSearchResultTime at={hit.createdAt} />
          </span>
        </span>
        {showBot && botTitle !== null && hit.senderUserId !== null ? (
          <span className="truncate text-ui-xs text-muted-foreground">
            {botTitle}
          </span>
        ) : null}
        {hit.threadExcerpt === null ? null : (
          <span
            data-testid="bot-search-hit-thread"
            className="truncate text-ui-xs text-muted-foreground"
          >
            {`in thread: ${hit.threadExcerpt}`}
          </span>
        )}
        <span className="line-clamp-2 text-ui-sm text-foreground">
          <ChatSearchHighlightedText
            text={hit.snippet.text}
            ranges={hit.snippet.highlights}
          />
        </span>
        {hit.replyCount === null || hit.replyCount === 0 ? null : (
          <span className="text-ui-xs text-muted-foreground">
            {hit.replyCount === 1 ? "1 reply" : `${hit.replyCount} replies`}
          </span>
        )}
        {missed ? (
          <span role="alert" className="text-ui-xs text-destructive">
            Couldn't open this thread.
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** The row's sender, by the members of the environment its bot is in. */
function useHitSender(
  hit: BotConversationSearchHit,
  botTitle: string | null,
  environmentId: string | null,
): { readonly name: string; readonly avatarUrl: string | null } {
  const client = useTabHostClient();
  const resolve = useEnvironmentMembers(
    client,
    hit.senderUserId === null ? null : environmentId,
    useHostMethodSupport(useTabHostId(), "environment.members") === true,
  );
  const viewer = useAuthStore((state) => state.profile);
  if (hit.senderUserId === null) {
    return { name: botTitle ?? "Bot", avatarUrl: null };
  }
  return {
    name: botMemberName(hit.senderUserId, viewer, resolve),
    avatarUrl: resolve(hit.senderUserId)?.avatarUrl ?? null,
  };
}

function BotSearchHitSender(props: {
  readonly hit: BotConversationSearchHit;
  readonly botTitle: string | null;
  readonly environmentId: string | null;
}): ReactNode {
  const { hit, botTitle, environmentId } = props;
  const sender = useHitSender(hit, botTitle, environmentId);
  return hit.senderUserId === null ? (
    <NamedBotAvatar botId={hit.botId} size="sm" />
  ) : (
    <PersonAvatar
      userId={hit.senderUserId}
      name={sender.name}
      avatarUrl={sender.avatarUrl}
      size="sm"
    />
  );
}

function BotSearchHitName(props: {
  readonly hit: BotConversationSearchHit;
  readonly botTitle: string | null;
  readonly environmentId: string | null;
}): ReactNode {
  const sender = useHitSender(props.hit, props.botTitle, props.environmentId);
  return (
    <span
      data-testid="bot-search-hit-sender"
      className="min-w-0 truncate font-medium text-foreground"
    >
      {sender.name}
    </span>
  );
}

function BotSearchHitKind(props: {
  readonly kind: BotConversationSearchHit["rowKind"];
}): ReactNode {
  if (props.kind === "question") {
    return (
      <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
        <CircleHelp aria-hidden="true" className="size-3" />
        question
      </span>
    );
  }
  if (props.kind === "announcement") {
    return (
      <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
        <Megaphone aria-hidden="true" className="size-3" />
        announcement
      </span>
    );
  }
  return null;
}

/** The way back to the results, from a result's thread or the channel at it. */
export function BotSearchBackLink(props: {
  readonly onBack: () => void;
}): ReactNode {
  const search = useBotConversationSearch();
  const pages = search.pages?.pages ?? [];
  const count = resultCountLabel({
    total: pages.at(0)?.total ?? null,
    loaded: botSearchHitsOf(pages).length,
    hasMore: search.hasMore,
  });
  return (
    <div className="flex shrink-0 border-b border-border/60 px-2 py-1">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        data-testid="bot-search-back"
        onClick={props.onBack}
      >
        <ChevronLeft aria-hidden="true" />
        <span className="truncate">
          {search.query === null ? "Results" : `${count} for “${search.query}”`}
        </span>
      </Button>
    </div>
  );
}

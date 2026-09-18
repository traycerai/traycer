/**
 * The body of the global chat search dialog: query input, scope and filters,
 * and the result list. Mounted only while the dialog is open.
 *
 * App-wide surface: it searches the effective host through `useHostClient()`,
 * and opens results on that host. Results are host-local, so there is no
 * cross-host merge here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import {
  CHAT_SEARCH_MAX_QUERY_CHARS,
  type ChatSearchRoleFilter,
} from "@traycer/protocol/host/chat-search/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChatSearchExpandedRows } from "@/components/chat-search/chat-search-expanded-rows";
import {
  ChatSearchNavProvider,
  useChatSearchKeyboardNav,
} from "@/components/chat-search/chat-search-keyboard-nav";
import {
  ChatSearchResultsView,
  type ChatSearchExpansionTarget,
  type ChatSearchOpenTarget,
} from "@/components/chat-search/chat-search-results-view";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useChatSearchHost } from "@/hooks/chats/use-chat-search-host";
import {
  useChatSearchResults,
  type ChatSearchBaseRequest,
} from "@/hooks/chats/use-chat-search-query";
import { useChatSearchTaskTitles } from "@/hooks/chats/use-chat-search-task-titles";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import {
  CHAT_SEARCH_BODY_MIN_QUERY_CHARS,
  CHAT_SEARCH_DEBOUNCE_MS,
  chatSearchDateRange,
} from "@/lib/chat-search/chat-search-results";
import { openChatSearchResult } from "@/lib/chat-search/open-chat-search-result";
import { useHostClient } from "@/lib/host";
import { useActiveEpicId } from "@/stores/epics/canvas/canvas-selectors";
import {
  useChatSearchStore,
  type ChatSearchDatePreset,
} from "@/stores/chat-search/chat-search-store";

const EMPTY_CURSORS: ReadonlyArray<string> = [];

const ROLE_OPTIONS: ReadonlyArray<{
  readonly value: ChatSearchRoleFilter;
  readonly label: string;
}> = [
  { value: "any", label: "All messages" },
  // Whose words: only the prompts this user typed, or only the agent's
  // replies. Notices, cards and prompts sent by other agents match under
  // "All messages" alone.
  { value: "human", label: "Your messages" },
  { value: "assistant", label: "Agent replies" },
];

const DATE_OPTIONS: ReadonlyArray<{
  readonly value: ChatSearchDatePreset;
  readonly label: string;
}> = [
  { value: "any", label: "Any time" },
  { value: "day", label: "Past day" },
  { value: "week", label: "Past week" },
  { value: "month", label: "Past month" },
  { value: "year", label: "Past year" },
];

interface Paging {
  /** The request the cursors were issued for; any other request starts over. */
  readonly key: string;
  readonly chatCursors: ReadonlyArray<string>;
  readonly messageCursors: ReadonlyArray<string>;
}

export function ChatSearchPanel(props: { readonly onClose: () => void }) {
  const { onClose } = props;
  const hostId = useEffectiveHostId();
  const client = useHostClient();
  const { hostReachable, methodUnsupported } = useChatSearchHost(
    hostId,
    client,
  );
  const activeEpicId = useActiveEpicId();
  const taskTitles = useChatSearchTaskTitles();
  const scope = useChatSearchStore((state) => state.scope);
  const roleFilter = useChatSearchStore((state) => state.roleFilter);
  const datePreset = useChatSearchStore((state) => state.datePreset);
  const dateAnchorMs = useChatSearchStore((state) => state.dateAnchorMs);
  const setScope = useChatSearchStore((state) => state.setScope);
  const setRoleFilter = useChatSearchStore((state) => state.setRoleFilter);
  const setDatePreset = useChatSearchStore((state) => state.setDatePreset);
  const consumeInitialQuery = useChatSearchStore(
    (state) => state.consumeInitialQuery,
  );

  // A query handed over by another surface (`openWith`), taken once: the panel
  // copies it into its own input state and clears it from the store, so a
  // later ⌘⇧F opens empty. Seeded at mount, which is the ordinary case - the
  // hand-off is what opened the dialog - and subscribed after it, so one that
  // arrives while the dialog is ALREADY open lands in the input rather than
  // sitting parked for the next unrelated search.
  const [query, setQuery] = useState(
    () => useChatSearchStore.getState().initialQuery ?? "",
  );
  useEffect(() => {
    consumeInitialQuery();
    return useChatSearchStore.subscribe((state, previous) => {
      const parked = state.initialQuery;
      if (parked === null || parked === previous.initialQuery) return;
      setQuery(parked);
      consumeInitialQuery();
    });
  }, [consumeInitialQuery]);
  // Capped at the protocol's limit as well as on the input: a pasted block
  // past it would otherwise make every request an invalid-argument error.
  const debouncedQuery = useDebouncedValue(
    query.trim().slice(0, CHAT_SEARCH_MAX_QUERY_CHARS),
    CHAT_SEARCH_DEBOUNCE_MS,
  );
  // "This task" needs a task; outside one the toggle falls back to every task
  // without forgetting the choice.
  const currentTaskScoped = scope === "current-task" && activeEpicId !== null;

  const base = useMemo<ChatSearchBaseRequest | null>(() => {
    if (debouncedQuery.length === 0 || !hostReachable || methodUnsupported) {
      return null;
    }
    return {
      query: debouncedQuery,
      scope: currentTaskScoped
        ? { kind: "current-task", epicId: activeEpicId }
        : { kind: "all-accessible-tasks" },
      tiers: null,
      roleFilter,
      dateRange: chatSearchDateRange(datePreset, dateAnchorMs),
      harness: null,
      mode: "ranked",
    };
  }, [
    activeEpicId,
    currentTaskScoped,
    dateAnchorMs,
    datePreset,
    debouncedQuery,
    hostReachable,
    methodUnsupported,
    roleFilter,
  ]);
  // The host is part of the request's identity: a cursor is the answering
  // host's, so a host switch under an unchanged query must reset paging and
  // remount the results view like any other new request.
  const baseKey = base === null ? "" : JSON.stringify([hostId, base]);

  const [paging, setPaging] = useState<Paging>({
    key: "",
    chatCursors: EMPTY_CURSORS,
    messageCursors: EMPTY_CURSORS,
  });
  const currentPaging =
    paging.key === baseKey
      ? paging
      : {
          key: baseKey,
          chatCursors: EMPTY_CURSORS,
          messageCursors: EMPTY_CURSORS,
        };

  const status = useChatSearchResults({
    client,
    base,
    chatCursors: currentPaging.chatCursors,
    messageCursors: currentPaging.messageCursors,
  });
  const unsupported = methodUnsupported || status.kind === "unsupported";
  const awaitingHost =
    !unsupported && debouncedQuery.length > 0 && !hostReachable;

  const navigate = useNavigate();
  const openTarget = useCallback(
    (target: ChatSearchOpenTarget) => {
      if (hostId === null) return;
      openChatSearchResult(
        navigate,
        { ...target, hostId },
        { effectiveHostId: hostId, now: Date.now() },
      );
      onClose();
    },
    [hostId, navigate, onClose],
  );
  // Functional, against the key the cursor was shown under: a press that lands
  // after the request moved on starts the new request's paging, never appends
  // a stale cursor to it.
  const appendCursor = useCallback(
    (section: "chatCursors" | "messageCursors", cursor: string) =>
      setPaging((previous) => {
        const current =
          previous.key === baseKey
            ? previous
            : {
                key: baseKey,
                chatCursors: EMPTY_CURSORS,
                messageCursors: EMPTY_CURSORS,
              };
        return { ...current, [section]: [...current[section], cursor] };
      }),
    [baseKey],
  );
  const showMoreChats = useCallback(
    (cursor: string) => appendCursor("chatCursors", cursor),
    [appendCursor],
  );
  const showMoreMessages = useCallback(
    (cursor: string) => appendCursor("messageCursors", cursor),
    [appendCursor],
  );
  const renderExpansion = useCallback(
    (target: ChatSearchExpansionTarget) =>
      base === null ? null : (
        <ChatSearchExpandedRows
          client={client}
          base={base}
          epicId={target.epicId}
          chatId={target.chatId}
          onOpenMessage={(messageId) => openTarget({ ...target, messageId })}
        />
      ),
    [base, client, openTarget],
  );

  const inputRef = useRef<HTMLInputElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const { onInputKeyDown, onResultKeyDown } = useChatSearchKeyboardNav(
    inputRef,
    resultsRef,
  );

  return (
    <div className="flex max-h-[min(70vh,40rem)] min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <SearchIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
        <input
          ref={inputRef}
          type="search"
          // No autoFocus: this is the content's first focusable element, which
          // is where the dialog puts focus on open.
          value={query}
          disabled={unsupported}
          maxLength={CHAT_SEARCH_MAX_QUERY_CHARS}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="Search chats…"
          aria-label="Search chats"
          className="h-8 min-w-0 flex-1 bg-transparent text-ui-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
        />
        {status.kind === "loading" ? (
          <AgentSpinningDots
            className={undefined}
            tone="muted"
            testId={undefined}
            variant={undefined}
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        <ButtonGroup aria-label="Search scope">
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={currentTaskScoped}
            disabled={unsupported || activeEpicId === null}
            onClick={() => setScope("current-task")}
          >
            This task
          </Button>
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={!currentTaskScoped}
            disabled={unsupported}
            onClick={() => setScope("all-accessible-tasks")}
          >
            All tasks
          </Button>
        </ButtonGroup>
        <Select
          value={roleFilter}
          disabled={unsupported}
          onValueChange={(value) => {
            const option = ROLE_OPTIONS.find((entry) => entry.value === value);
            if (option !== undefined) setRoleFilter(option.value);
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label="Message filter"
            className="w-auto"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={datePreset}
          disabled={unsupported}
          onValueChange={(value) => {
            const option = DATE_OPTIONS.find((entry) => entry.value === value);
            if (option !== undefined) setDatePreset(option.value, Date.now());
          }}
        >
          <SelectTrigger size="sm" aria-label="Date" className="w-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div ref={resultsRef} className="min-h-0 flex-1 overflow-y-auto">
        {unsupported ? (
          <p className="px-3 py-6 text-center text-ui-sm text-muted-foreground">
            Chat search isn&apos;t available on this host. Update Traycer Host
            to search your chats.
          </p>
        ) : null}
        {awaitingHost ? (
          <p
            role="status"
            className="px-3 py-6 text-center text-ui-sm text-muted-foreground"
          >
            Waiting for the host to connect…
          </p>
        ) : null}
        {!unsupported && status.kind === "error" ? (
          <p
            role="alert"
            className="px-3 py-6 text-center text-ui-sm text-destructive"
          >
            {status.message}
          </p>
        ) : null}
        {!unsupported && status.kind === "ready" ? (
          <ChatSearchNavProvider value={onResultKeyDown}>
            {/* Keyed by the request: a new search starts with every group
                collapsed, so no expansion carries the previous request's
                cursors into this one. */}
            <ChatSearchResultsView
              key={baseKey}
              results={status.results}
              loadingMore={status.loadingMore}
              loadMoreError={status.loadMoreError}
              messagesSearched={
                debouncedQuery.length >= CHAT_SEARCH_BODY_MIN_QUERY_CHARS
              }
              onOpen={openTarget}
              onShowMoreChats={showMoreChats}
              onShowMoreMessages={showMoreMessages}
              renderExpansion={renderExpansion}
              taskTitles={taskTitles}
            />
          </ChatSearchNavProvider>
        ) : null}
      </div>
    </div>
  );
}

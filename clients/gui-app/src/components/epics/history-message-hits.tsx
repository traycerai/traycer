/**
 * History's second list: message hits for the query already in History's box,
 * drawn under the task list.
 *
 * History's own list answers "which TASK", from the cloud task list; this
 * section answers "which MESSAGE", from the active host's local chat index.
 * The two are different questions from different places, so they stay two
 * lists sharing one query box rather than one merged, invented ranking.
 *
 * Two consequences of that split are visible here. History's filters - repo,
 * workspace, chat host, ownership - do not exist in the index and cannot be
 * applied to a hit without a task-id filter on `epic.listTasks` that does not
 * exist, so the section shows anyway and SAYS it is unfiltered rather than
 * implying the narrowing carried. And the index is one host's, so the header
 * names that host: hits from another machine are not missing, they were never
 * searched.
 *
 * Chat-TITLE matches are dropped by `useChatSearchMessageHits`, which is what
 * makes this a second list rather than a second copy of the first: History
 * already lists titles above.
 */
import {
  useCallback,
  useId,
  useRef,
  useLayoutEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { HistoryGroupHeader } from "@/components/epics/history-group-header";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ChatSearchExpandedRows } from "@/components/chat-search/chat-search-expanded-rows";
import { ChatSearchMessageHitList } from "@/components/chat-search/chat-search-message-hit-list";
import { ChatSearchNavProvider } from "@/components/chat-search/chat-search-keyboard-nav";
import {
  ChatSearchPartialIndexNote,
  type ChatSearchExpansionTarget,
  type ChatSearchOpenTarget,
} from "@/components/chat-search/chat-search-results-view";
import {
  useChatSearchMessageHits,
  type ChatSearchMessageHitsStatus,
  type ChatSearchSurfaceScope,
} from "@/hooks/chats/use-chat-search-message-hits";
import { useChatSearchTaskTitles } from "@/hooks/chats/use-chat-search-task-titles";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import {
  CHAT_SEARCH_BODY_MIN_QUERY_CHARS,
  projectSearchCount,
} from "@/lib/chat-search/chat-search-results";
import type { HistoryCount } from "@/components/epics/history-scope-bar";
import { cn } from "@/lib/utils";
import { openChatSearchResult } from "@/lib/chat-search/open-chat-search-result";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { useOptionalHostClient, type HostRpcRegistry } from "@/lib/host";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useChatSearchStore } from "@/stores/chat-search/chat-search-store";
import { useBindingForAction } from "@/stores/settings/keybinding-store";
import {
  useSystemOverlayActive,
  useSystemTabModalActions,
} from "@/stores/tabs/use-system-tab-modal";

/**
 * Fixed, and module-scoped so the hook's request identity does not churn on
 * every render. History is the account's task list, so its message half is the
 * account's chats; the narrower scopes belong to surfaces that sit inside one
 * task.
 */
const ALL_TASKS_SCOPE: ChatSearchSurfaceScope = {
  kind: "all-accessible-tasks",
};

export interface HistoryMessageHitsInputs {
  /** History's raw query; the trim, cap and debounce are the hook's. */
  readonly query: string;
  /**
   * A History filter that narrows WHICH TASKS the list shows is active - repo,
   * workspace, chat host or ownership. Not the query, which is what this
   * section is searching for, and not the sort, which never applies to hits.
   */
  readonly filtersActive: boolean;
  /**
   * The task list has rendered its first result or its empty state. Until it
   * has, this section draws nothing at all, so the list above never appears to
   * be waiting on a host it does not read from.
   */
  readonly taskListSettled: boolean;
  /** History's arrow-key traversal, bound to each hit control. */
  readonly onRowKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export interface HistoryMessageHitsProps extends HistoryMessageHitsInputs {
  readonly display: "list" | "count-only";
  readonly standalone: boolean;
  readonly onCountChange: (count: HistoryCount) => void;
  readonly onShowTasks: () => void;
}

/**
 * The cheap gates, kept in a component of their own so the section's queries -
 * the search itself and the task-title index - are never mounted for a History
 * that cannot show hits. Below the body-search minimum there is nothing to ask
 * for, and with no host runtime above this panel (a task picker rendered bare,
 * a suite mounting the list alone) there is nobody to ask.
 */
export function HistoryMessageHits(props: HistoryMessageHitsProps): ReactNode {
  const hostId = useEffectiveHostId();
  const client = useOptionalHostClient();
  if (
    client === null ||
    props.query.trim().length < CHAT_SEARCH_BODY_MIN_QUERY_CHARS
  ) {
    return <HistoryMessageHitsUnavailable {...props} />;
  }
  return (
    <HistoryMessageHitsSection {...props} client={client} hostId={hostId} />
  );
}

function HistoryMessageHitsSection(
  props: HistoryMessageHitsProps & {
    readonly client: HostClient<HostRpcRegistry>;
    readonly hostId: string | null;
  },
): ReactNode {
  const {
    client,
    filtersActive,
    hostId,
    onRowKeyDown,
    query,
    taskListSettled,
    display,
    standalone,
  } = props;
  const status = useChatSearchMessageHits({
    client,
    hostId,
    query,
    scope: ALL_TASKS_SCOPE,
  });
  const headingId = useId();
  const groupRef = useRef<HTMLElement>(null);
  const count = messageCountProjection(status);
  const { onCountChange } = props;
  useLayoutEffect(() => onCountChange(count), [count, onCountChange]);
  const animateArrival = useMessageArrival(display, standalone);
  const taskTitles = useChatSearchTaskTitles();
  const hostEntry = useHostDirectoryEntry(hostId);
  const navigate = useNavigate();
  const openWith = useChatSearchStore((state) => state.openWith);
  // History is a modal on the routes that have no History TAB. Opening the
  // dialog from inside it has to dismiss it, or the dialog opens behind the
  // overlay it was summoned from; in the tab form there is nothing to dismiss.
  const historyOverlayActive = useSystemOverlayActive("history");
  const { close } = useSystemTabModalActions();
  const chord = useBindingForAction("app.chat-search.open");

  const openTarget = useCallback(
    (target: ChatSearchOpenTarget) => {
      if (hostId === null) return;
      openChatSearchResult(
        navigate,
        { ...target, hostId },
        { effectiveHostId: hostId, now: Date.now() },
      );
      if (historyOverlayActive) close();
    },
    [close, historyOverlayActive, hostId, navigate],
  );
  const expansionBase = status.kind === "ready" ? status.expansionBase : null;
  const renderExpansion = useCallback(
    (target: ChatSearchExpansionTarget) =>
      expansionBase === null ? null : (
        <ChatSearchExpandedRows
          client={client}
          base={expansionBase}
          {...target}
          onOpenMessage={(messageId) =>
            openTarget({
              epicId: target.epicId,
              chatId: target.chatId,
              messageId,
            })
          }
        />
      ),
    [client, expansionBase, openTarget],
  );
  const openDialog = useCallback(() => {
    openWith(
      { query: query.trim(), scope: "all-accessible-tasks" },
      Date.now(),
    );
    if (historyOverlayActive) close();
  }, [close, historyOverlayActive, openWith, query]);

  if (display === "count-only") return null;
  if (status.kind === "absent")
    return <HistoryMessageHitsUnavailable {...props} />;
  if (status.kind === "loading" && !taskListSettled && !standalone) return null;
  return (
    <>
      <HistoryGroupHeader
        kind="messages"
        id={headingId}
        hostLabel={hostEntry?.label ?? "this machine"}
        targetRef={groupRef}
        pinBottom={!standalone}
        actions={
          <Button variant="link" size="sm" onClick={openDialog}>
            Refine in chat search
            {chord === null ? null : (
              <span aria-hidden className="text-muted-foreground">
                {formatChordForDisplay(chord)}
              </span>
            )}
          </Button>
        }
      />
      <section
        ref={groupRef}
        aria-labelledby={headingId}
        className={cn(
          "flex scroll-mt-[var(--history-messages-header-height,3rem)] flex-col",
          animateArrival &&
            !standalone &&
            "transition-[opacity,translate] duration-160 ease-[cubic-bezier(0.23,1,0.32,1)] starting:translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0",
        )}
      >
        <p role="status" className="sr-only">
          {status.kind === "loading" ? "Searching messages…" : null}
          {status.kind === "ready"
            ? chatCountLabel(status.messages.length, status.showMore !== null)
            : null}
        </p>
        {filtersActive ? (
          <p className="px-3.5 pb-2 text-ui-xs text-muted-foreground">
            Filters apply to tasks only.
          </p>
        ) : null}
        <HistoryMessageHitsBody
          status={status}
          hostId={hostId}
          onOpen={openTarget}
          onRowKeyDown={onRowKeyDown}
          renderExpansion={renderExpansion}
          taskTitles={taskTitles}
        />
      </section>
    </>
  );
}

/** Cheap-gate explanation; no search or title-query hooks mount here. */
function HistoryMessageHitsUnavailable(
  props: HistoryMessageHitsProps,
): ReactNode {
  const { onCountChange } = props;
  useLayoutEffect(() => onCountChange(null), [onCountChange]);
  if (props.display === "count-only" || !props.standalone) return null;
  const tooShort = props.query.trim().length < CHAT_SEARCH_BODY_MIN_QUERY_CHARS;
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
      <p className="text-ui-sm font-medium">
        {tooShort
          ? "Type 2 characters to search messages"
          : "Message search isn't available right now."}
      </p>
      <Button variant="muted" size="sm" onClick={props.onShowTasks}>
        Show tasks
      </Button>
    </div>
  );
}

function HistoryMessageHitsBody(props: {
  readonly status: ChatSearchMessageHitsStatus;
  /** Keys the list; see the `key` below. */
  readonly hostId: string | null;
  readonly onOpen: (target: ChatSearchOpenTarget) => void;
  readonly onRowKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly renderExpansion: (target: ChatSearchExpansionTarget) => ReactNode;
  readonly taskTitles: ReadonlyMap<string, string>;
}): ReactNode {
  const { hostId, onOpen, onRowKeyDown, renderExpansion, status, taskTitles } =
    props;
  if (status.kind === "loading") {
    return (
      <div className="flex px-3 py-1.5">
        <AgentSpinningDots
          className={undefined}
          tone="muted"
          testId="history-message-hits-loading"
          variant={undefined}
        />
      </div>
    );
  }
  if (status.kind === "error") {
    return (
      <p role="alert" className="px-3 py-1.5 text-ui-xs text-destructive">
        {status.message}
      </p>
    );
  }
  // Nothing found and nowhere left to look. A page that ranked matches and
  // showed none of them - every one in a task this requester cannot read -
  // still carries a cursor, and the accessible hit sits on the next page, so
  // the list renders instead and keeps its continuation control reachable.
  if (
    status.kind === "ready" &&
    status.messages.length === 0 &&
    status.showMore === null &&
    status.loadMoreError === null
  ) {
    return (
      <>
        {/* The caveat belongs with the EMPTY result most of all: a startup
            sweep that has not finished is the likeliest reason there is
            nothing here, and this branch returns before the list that would
            otherwise have drawn it. Kept alongside "No messages match."
            rather than in place of it, exactly as the dialog pairs the note
            with "No chats match.": what was searched did not match, and the
            note says what was not searched yet. */}
        {status.indexState === "partial" ? (
          <ChatSearchPartialIndexNote />
        ) : null}
        <p className="px-3 py-1.5 text-ui-xs text-muted-foreground">
          No messages match.
        </p>
      </>
    );
  }
  // Every hit control joins History's own arrow traversal rather than running
  // a second one beside it: the hits are the tail of one list that starts at
  // the first task row. See `use-history-list-keyboard-nav.ts`.
  return (
    <ChatSearchNavProvider value={onRowKeyDown}>
      {/* The host, because the list keys itself by the REQUEST and a host
          switch under an unchanged query produces a byte-identical one - so
          the expansion state and its collected page cursors would carry over
          onto rows from a different machine's index, whose chat ids the
          previous host's cursors mean nothing against. The two keys compose
          into the (hostId, base) identity the hook already pages by. */}
      <ChatSearchMessageHitList
        key={hostId}
        status={status}
        onOpen={onOpen}
        renderExpansion={renderExpansion}
        taskTitles={taskTitles}
        variant="full"
      />
    </ChatSearchNavProvider>
  );
}

/** A hit is one CHAT, however many of its messages matched. */
function chatCountLabel(count: number, more: boolean): string {
  if (more) return `${count}+ chats`;
  return count === 1 ? "1 chat" : `${count} chats`;
}

function messageCountProjection(
  status: ChatSearchMessageHitsStatus,
): HistoryCount {
  const projection = projectSearchCount(
    status.kind === "ready"
      ? {
          kind: "ready",
          count: status.messages.length,
          more: status.showMore !== null,
        }
      : status,
  );
  if (projection.kind === "pending") return "pending";
  if (projection.kind === "count")
    return `${projection.value}${projection.more ? "+" : ""}`;
  return null;
}

function useMessageArrival(
  display: "list" | "count-only",
  standalone: boolean,
): boolean {
  // Scope switches are instant. Only the initial asynchronous group arrival
  // in All gets the existing fade/translate, even though the query stays live.
  const [entrance, setEntrance] = useState({
    display,
    standalone,
    animate: !standalone && display === "list",
  });
  if (entrance.display !== display || entrance.standalone !== standalone) {
    setEntrance({ display, standalone, animate: false });
    return false;
  }
  return entrance.animate;
}

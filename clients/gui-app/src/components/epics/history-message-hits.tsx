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
import { useCallback, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ChatSearchExpandedRows } from "@/components/chat-search/chat-search-expanded-rows";
import { ChatSearchMessageHitList } from "@/components/chat-search/chat-search-message-hit-list";
import { ChatSearchNavProvider } from "@/components/chat-search/chat-search-keyboard-nav";
import type {
  ChatSearchExpansionTarget,
  ChatSearchOpenTarget,
} from "@/components/chat-search/chat-search-results-view";
import {
  useChatSearchMessageHits,
  type ChatSearchMessageHitsStatus,
  type ChatSearchSurfaceScope,
} from "@/hooks/chats/use-chat-search-message-hits";
import { useChatSearchTaskTitles } from "@/hooks/chats/use-chat-search-task-titles";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { CHAT_SEARCH_BODY_MIN_QUERY_CHARS } from "@/lib/chat-search/chat-search-results";
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

export interface HistoryMessageHitsProps {
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
    return null;
  }
  return (
    <HistoryMessageHitsSection
      client={client}
      hostId={hostId}
      query={props.query}
      filtersActive={props.filtersActive}
      taskListSettled={props.taskListSettled}
      onRowKeyDown={props.onRowKeyDown}
    />
  );
}

function HistoryMessageHitsSection(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
  readonly query: string;
  readonly filtersActive: boolean;
  readonly taskListSettled: boolean;
  readonly onRowKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}): ReactNode {
  const {
    client,
    filtersActive,
    hostId,
    onRowKeyDown,
    query,
    taskListSettled,
  } = props;
  const status = useChatSearchMessageHits({
    client,
    hostId,
    query,
    scope: ALL_TASKS_SCOPE,
  });
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
          epicId={target.epicId}
          chatId={target.chatId}
          onOpenMessage={(messageId) => openTarget({ ...target, messageId })}
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

  if (status.kind === "absent") return null;
  if (status.kind === "loading" && !taskListSettled) return null;
  return (
    <section aria-label="Message matches" className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-2 border-t border-border px-3 pt-3 pb-1">
        <h3 className="min-w-0 text-ui-xs text-muted-foreground">
          <span className="font-medium tracking-wide uppercase">
            In messages
          </span>
          <HeaderDetail
            status={status}
            hostLabel={hostEntry?.label ?? "this host"}
            filtersActive={filtersActive}
          />
        </h3>
        <Button variant="link" size="inline-xs" onClick={openDialog}>
          Open in Search chats
          {/* A visual affordance only: run into the label it follows, the
              chord turns the button's accessible name into one unreadable
              word, and the action it names is already announced. */}
          {chord === null ? null : (
            <span aria-hidden className="text-muted-foreground">
              {formatChordForDisplay(chord)}
            </span>
          )}
        </Button>
      </div>
      <HistoryMessageHitsBody
        status={status}
        onOpen={openTarget}
        onRowKeyDown={onRowKeyDown}
        renderExpansion={renderExpansion}
        taskTitles={taskTitles}
      />
    </section>
  );
}

/**
 * What the header says after "In messages": the host whose index answered, how
 * much it found, and - when History is narrowed by a filter the index cannot
 * reproduce - that the hits below ignore it.
 */
function HeaderDetail(props: {
  readonly status: ChatSearchMessageHitsStatus;
  readonly hostLabel: string;
  readonly filtersActive: boolean;
}): ReactNode {
  const { filtersActive, hostLabel, status } = props;
  return (
    <>
      <span>{` · on ${hostLabel}`}</span>
      {status.kind === "ready" ? (
        <span>{` · ${chatCountLabel(status.messages.length)}`}</span>
      ) : null}
      {filtersActive ? <span> · not filtered</span> : null}
    </>
  );
}

function HistoryMessageHitsBody(props: {
  readonly status: ChatSearchMessageHitsStatus;
  readonly onOpen: (target: ChatSearchOpenTarget) => void;
  readonly onRowKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly renderExpansion: (target: ChatSearchExpansionTarget) => ReactNode;
  readonly taskTitles: ReadonlyMap<string, string>;
}): ReactNode {
  const { onOpen, onRowKeyDown, renderExpansion, status, taskTitles } = props;
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
      <p className="px-3 py-1.5 text-ui-xs text-muted-foreground">
        No messages match.
      </p>
    );
  }
  // Every hit control joins History's own arrow traversal rather than running
  // a second one beside it: the hits are the tail of one list that starts at
  // the first task row. See `use-history-list-keyboard-nav.ts`.
  return (
    <ChatSearchNavProvider value={onRowKeyDown}>
      <ChatSearchMessageHitList
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
function chatCountLabel(count: number): string {
  return count === 1 ? "1 chat" : `${count} chats`;
}

/**
 * "In messages" under the Agents panel's tree: the message hits the task's own
 * host has indexed for the query already narrowing that tree.
 *
 * One box, two readers. The panel's search filters the tree by TITLE, locally
 * and instantly, and this section answers the second question underneath -
 * which of this task's agents said the word. The index's own chat-title
 * section is dropped: the tree above is a superset of it, so showing it here
 * would be the same answer twice. The cost is the one case the spec accepts -
 * a chat whose title matches and whose messages do not appears only in the
 * tree.
 *
 * The request and the host gate are `epic-sidebar-message-hits-state.ts`; this
 * file is the section that draws the answer. It is a SIBLING of the tree's
 * `role="tree"`, never rows inside it, and it is mounted from
 * `epic-sidebar.tsx` and placed by the tree so it lands inside the same scroll
 * container as the rows.
 */
import { useCallback, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ChatSearchExpandedRows } from "@/components/chat-search/chat-search-expanded-rows";
import { ChatSearchMessageHitList } from "@/components/chat-search/chat-search-message-hit-list";
import type {
  ChatSearchExpansionTarget,
  ChatSearchOpenTarget,
} from "@/components/chat-search/chat-search-results-view";
import type { EpicSidebarMessageHitsState } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import type { ChatSearchMessageHitsStatus } from "@/hooks/chats/use-chat-search-message-hits";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { openChatSearchResult } from "@/lib/chat-search/open-chat-search-result";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { useChatSearchStore } from "@/stores/chat-search/chat-search-store";
import { useChatTranscriptJumpStore } from "@/stores/chats/chat-transcript-jump-store";
import { useBindingForAction } from "@/stores/settings/keybinding-store";

/**
 * Every hit here belongs to the task already on screen, so the compact row
 * hides the task label and there is nothing to look a title up for.
 */
const NO_TASK_TITLES: ReadonlyMap<string, string> = new Map();

export function EpicSidebarMessageHits(props: {
  readonly state: EpicSidebarMessageHitsState;
}) {
  const { client, hostId, query, status } = props.state;
  const navigate = useNavigate();
  const effectiveHostId = useEffectiveHostId();
  const openWith = useChatSearchStore((state) => state.openWith);
  const chord = useBindingForAction("app.chat-search.open");

  const openTarget = useCallback(
    (target: ChatSearchOpenTarget) => {
      if (hostId === null) return;
      // The session host answered, so that is the tile the jump is parked for.
      // The effective host is context, reported honestly: the route uses it to
      // decide whether the chat tile it may have to open FRESH would be bound
      // to the searched host, and claiming an agreement that does not hold
      // would let a tile on the other host consume this jump.
      openChatSearchResult(
        navigate,
        { ...target, hostId },
        { effectiveHostId, now: Date.now() },
      );
      // Which leaves the case the route is right to decline and this surface
      // can answer for itself. Its fresh-tile fallback is a HOSTLESS epic
      // intent, so from a notification it may land on any host and it parks
      // nothing unless the two agree. From here it cannot: every hit is scoped
      // to this task, and `openOrFocusEpicIntent` carries `tabId: null`, which
      // `resolveTabIdForEpic` answers with the tab already showing this epic -
      // THIS tab, the one this sidebar is rendered in, bound to the host that
      // served the search. So park the jump for that host when the app is
      // pointed elsewhere. The store is keyed by (host, chat), so no tile on
      // the effective host can take it.
      if (effectiveHostId === hostId || target.messageId === null) return;
      useChatTranscriptJumpStore.getState().requestJump(hostId, target.chatId, {
        kind: "message",
        messageId: target.messageId,
      });
    },
    [effectiveHostId, hostId, navigate],
  );
  // The request the rows were ranked under, so an expanded group asks the same
  // question with `scope: chat` rather than one rebuilt from the raw query.
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
  // Cross-task search and the who/when filters are the dialog's remaining job:
  // this column has no room for them, so it hands the query over instead.
  const openDialog = useCallback(() => {
    openWith(
      { query: query.trim(), scope: "all-accessible-tasks" },
      Date.now(),
    );
  }, [openWith, query]);

  if (status.kind === "absent") return null;
  return (
    <section aria-label="In messages" className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-2 border-t border-border px-3 pt-3 pb-1">
        <h3 className="min-w-0 text-ui-xs text-muted-foreground">
          <span className="font-medium tracking-wide uppercase">
            In messages
          </span>
          {status.kind === "ready" && status.messages.length > 0 ? (
            <span>{` · ${agentCountLabel(status.messages.length)}`}</span>
          ) : null}
        </h3>
        <Button variant="link" size="inline-xs" onClick={openDialog}>
          All tasks
          {chord === null ? null : (
            <span className="text-muted-foreground">
              {formatChordForDisplay(chord)}
            </span>
          )}
        </Button>
      </div>
      <MessageHitsBody
        status={status}
        hostId={hostId}
        onOpen={openTarget}
        renderExpansion={renderExpansion}
      />
    </section>
  );
}

function MessageHitsBody(props: {
  readonly status: ChatSearchMessageHitsStatus;
  /** Keys the list: a host change is a different index, not a new page. */
  readonly hostId: string | null;
  readonly onOpen: (target: ChatSearchOpenTarget) => void;
  readonly renderExpansion: (target: ChatSearchExpansionTarget) => ReactNode;
}): ReactNode {
  const { hostId, onOpen, renderExpansion, status } = props;
  if (status.kind === "loading") {
    return (
      <div className="flex px-3 py-1.5">
        <AgentSpinningDots
          className={undefined}
          tone="muted"
          testId={undefined}
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
  // The rows are the dialog's own, in the variant built for this column: the
  // task label goes and the snippet takes one line. There is no nav provider
  // here - the tree owns its own roving focus and the rows are ordinary
  // buttons, reachable by Tab.
  //
  // Keyed by the host on top of the list's own per-request remount, which does
  // not include one: a host switch under an unchanged query is a different
  // index answering, so expanded groups must not carry the previous host's
  // chat ids into it.
  return (
    <ChatSearchMessageHitList
      key={hostId}
      status={status}
      onOpen={onOpen}
      renderExpansion={renderExpansion}
      taskTitles={NO_TASK_TITLES}
      variant="compact"
      showIndexingNotice
    />
  );
}

/** A hit is one AGENT, however many of its messages matched. */
function agentCountLabel(count: number): string {
  return count === 1 ? "1 agent" : `${count} agents`;
}

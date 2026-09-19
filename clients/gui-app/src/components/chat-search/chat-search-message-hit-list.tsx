/**
 * The message-hit half of a chat search, as a list any surface can drop under
 * its own content: the sidebar's agent filter, History's task list, and the
 * dialog's own message section all draw the same row.
 *
 * Presentational, and paired with `useChatSearchMessageHits`, which owns the
 * request. It renders the `ready` status only - `absent`, `loading` and
 * `error` are the surrounding section's to draw (or, for `absent`, not to
 * draw), because each surface places its own header and spinner.
 */
import { useCallback, useState, type ReactNode } from "react";
import {
  ChatSearchPartialIndexNote,
  MessageMatchRow,
  SectionContinuation,
  type ChatSearchExpansionTarget,
  type ChatSearchOpenTarget,
  type ChatSearchRowVariant,
} from "@/components/chat-search/chat-search-results-view";
import type { ChatSearchMessageHitsStatus } from "@/hooks/chats/use-chat-search-message-hits";
import { chatSearchGroupKey } from "@/lib/chat-search/chat-search-results";

export interface ChatSearchMessageHitListProps {
  readonly status: ChatSearchMessageHitsStatus;
  readonly onOpen: (target: ChatSearchOpenTarget) => void;
  readonly renderExpansion: (target: ChatSearchExpansionTarget) => ReactNode;
  /**
   * Task names by epic id, for the rows' task label. `compact` hides that
   * label, so a single-task surface can pass an empty map.
   */
  readonly taskTitles: ReadonlyMap<string, string>;
  readonly variant: ChatSearchRowVariant;
}

/** A `ready` status, the only one this list draws. */
type ReadyStatus = Extract<
  ChatSearchMessageHitsStatus,
  { readonly kind: "ready" }
>;

export function ChatSearchMessageHitList(props: ChatSearchMessageHitListProps) {
  const { onOpen, renderExpansion, status, taskTitles, variant } = props;
  if (status.kind !== "ready") return null;
  return (
    <ReadyMessageHitList
      // Keyed by the request, the way the dialog keys its results view.
      // Two pieces of state here belong to the request that produced these
      // rows and to no other: which groups are expanded, and - inside each
      // expansion - the page cursors `ChatSearchExpandedRows` has collected.
      // A surface mounts this list once and feeds it status after status, so
      // without the remount a new query inherits the old one's expansion and
      // immediately re-requests every page of it against a chat that may not
      // even be in the new results.
      key={JSON.stringify(status.expansionBase)}
      status={status}
      onOpen={onOpen}
      renderExpansion={renderExpansion}
      taskTitles={taskTitles}
      variant={variant}
    />
  );
}

function ReadyMessageHitList(props: {
  readonly status: ReadyStatus;
  readonly onOpen: (target: ChatSearchOpenTarget) => void;
  readonly renderExpansion: (target: ChatSearchExpansionTarget) => ReactNode;
  readonly taskTitles: ReadonlyMap<string, string>;
  readonly variant: ChatSearchRowVariant;
}) {
  const { onOpen, renderExpansion, status, taskTitles, variant } = props;
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

  return (
    <div className="flex flex-col">
      {status.indexState === "partial" ? <ChatSearchPartialIndexNote /> : null}
      <ul className="flex flex-col">
        {status.messages.map((match) => {
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
              variant={variant}
            />
          );
        })}
      </ul>
      <SectionContinuation
        error={status.loadMoreError}
        label="Show more matches"
        disabled={status.loadingMore}
        onShowMore={status.showMore}
      />
    </div>
  );
}

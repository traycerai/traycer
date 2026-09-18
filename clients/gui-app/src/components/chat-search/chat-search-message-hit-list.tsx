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

export function ChatSearchMessageHitList(props: ChatSearchMessageHitListProps) {
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

  if (status.kind !== "ready") return null;
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
        label="Show more"
        disabled={status.loadingMore}
        onShowMore={status.showMore}
      />
    </div>
  );
}

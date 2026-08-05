import { useCallback, useMemo, useState } from "react";
import { MessageSquarePlus, MessageSquareWarning } from "lucide-react";
import { type EpicArtifactKind } from "@traycer/protocol/common/registry";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useEpicCommentThreads } from "@/hooks/comments/use-epic-comment-threads";
import { useEpicDurabilityStatus } from "@/lib/epic-selectors";
import {
  useActiveThreadId,
  useCommentThreadsStore,
} from "@/stores/comments/comment-threads-store";
import {
  filterThreadsByStatus,
  sortThreadsByDocumentOrder,
  type AnchorPositionMap,
  type CommentThreadStatusFilter,
  type SortedThread,
} from "@/lib/comments/comment-filter-utils";
import { CommentThreadCard } from "./comment-thread-card";

export interface CommentSidebarProps {
  readonly epicId: string;
  readonly artifactType: EpicArtifactKind;
  readonly artifactId: string;
  /** Threads-anchored-in-document positions, derived from the active tile's
   *  Tiptap editor by the parent. Used both for sort order and orphan
   *  detection (no entry → orphan). */
  readonly anchorPositions: AnchorPositionMap;
  /** Logged-in user id. Resolved upstream from the auth profile against the
   *  collaborators query. `null` while resolving. */
  readonly currentUserId: string | null;
  /** True when caller may resolve / delete-thread regardless of authorship.
   *  Editor + Owner = true. Viewer = false. */
  readonly canModerate: boolean;
  /** Triggered when the user clicks a thread card so the parent can scroll
   *  the originating tile to the anchor + flash. */
  readonly onActivateThread: (threadId: string) => void;
}

/**
 * Sidebar surface that swaps in for the artifact tree when the user opens
 * the comments view. Owns the tab filter (Open/Resolved/All) and routes
 * thread expansion through the Zustand `activeThreadId` so the editor
 * decoration plugin paints the matching anchor.
 */
export function CommentSidebar(props: CommentSidebarProps) {
  const {
    epicId,
    artifactType,
    artifactId,
    anchorPositions,
    currentUserId,
    canModerate,
    onActivateThread,
  } = props;

  const [filter, setFilter] = useState<CommentThreadStatusFilter>("open");
  const activeThreadId = useActiveThreadId(epicId);
  const setActiveThread = useCommentThreadsStore((s) => s.setActiveThread);
  const setDraft = useCommentThreadsStore((s) => s.setDraft);
  const durabilityStatus = useEpicDurabilityStatus();
  const localCommentsUnavailable = durabilityStatus === "local";

  const query = useEpicCommentThreads(epicId, artifactType, artifactId, {
    enabled: !localCommentsUnavailable,
  });

  const sorted = useMemo(() => {
    if (query.data === undefined) return [];
    const filtered = filterThreadsByStatus(query.data.threads, filter);
    return sortThreadsByDocumentOrder(filtered, anchorPositions);
  }, [query.data, filter, anchorPositions]);

  // `query.data === undefined` - not `sorted.length === 0` - separates "we do
  // not know" from "there are none". TanStack keeps the last successful
  // snapshot when a REFETCH fails, so a populated sidebar keeps rendering real
  // threads through an outage; the read that renders nothing is the COLD one
  // (opening comments, switching artifacts, after cache eviction) while the
  // host's collab provider is null, which `epic.listCommentThreads` answers
  // with an error for the whole duration of every reconnect. A cold query
  // that is disabled because no host client is ready is unknown for the same
  // reason: it has never produced a snapshot.
  const isUnavailable =
    localCommentsUnavailable ||
    (query.data === undefined && query.fetchStatus !== "fetching");

  const handleExpandedChange = useCallback(
    (threadId: string, next: boolean) => {
      setActiveThread(epicId, next ? threadId : null);
    },
    [epicId, setActiveThread],
  );

  const handleStartDraft = useCallback(() => {
    // Surface a hint when nothing is selected - selection capture lives in
    // the toolbar / shortcut path, not here. We just clear any stale draft
    // so the floating popover state is in a known shape if the user goes
    // back and selects text.
    setDraft(epicId, null);
  }, [epicId, setDraft]);

  return (
    <div
      data-slot="comment-sidebar"
      className="flex h-full min-h-0 w-full flex-col bg-background"
    >
      <Tabs
        value={filter}
        onValueChange={(v) => setFilter(v as CommentThreadStatusFilter)}
        className="px-3 pt-2"
      >
        <TabsList className="w-full">
          <TabsTrigger value="open">Open</TabsTrigger>
          <TabsTrigger value="resolved">Resolved</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
        {(["open", "resolved", "all"] as const).map((tab) => (
          <TabsContent key={tab} value={tab} className="mt-0" />
        ))}
      </Tabs>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-3">
        <SidebarBody
          isLoading={query.isLoading}
          isUnavailable={isUnavailable}
          localCommentsUnavailable={localCommentsUnavailable}
          sorted={sorted}
          filter={filter}
          epicId={epicId}
          artifactType={artifactType}
          artifactId={artifactId}
          activeThreadId={activeThreadId}
          currentUserId={currentUserId}
          canModerate={canModerate}
          onExpandedChange={handleExpandedChange}
          onActivateThread={onActivateThread}
          onPromptDraft={handleStartDraft}
        />
      </div>
    </div>
  );
}

interface SidebarBodyProps {
  readonly isLoading: boolean;
  /** The read failed with nothing cached to fall back on, so the thread list
   *  is unknown rather than empty. See where it is derived in
   *  {@link CommentSidebar}. */
  readonly isUnavailable: boolean;
  readonly localCommentsUnavailable: boolean;
  readonly sorted: ReadonlyArray<SortedThread>;
  readonly filter: CommentThreadStatusFilter;
  readonly epicId: string;
  readonly artifactType: EpicArtifactKind;
  readonly artifactId: string;
  readonly activeThreadId: string | null;
  readonly currentUserId: string | null;
  readonly canModerate: boolean;
  readonly onExpandedChange: (threadId: string, next: boolean) => void;
  readonly onActivateThread: (threadId: string) => void;
  readonly onPromptDraft: () => void;
}

function SidebarBody(props: SidebarBodyProps) {
  if (props.isLoading) {
    return (
      <div
        data-slot="comment-sidebar-loading"
        className="flex items-center justify-center py-8"
      >
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </div>
    );
  }
  // Ordered ahead of the empty state on purpose: both render zero threads, and
  // only one of them knows that to be true.
  if (props.isUnavailable) {
    return (
      <UnavailableState
        localCommentsUnavailable={props.localCommentsUnavailable}
      />
    );
  }
  if (props.sorted.length === 0) {
    return (
      <EmptyState filter={props.filter} onPromptDraft={props.onPromptDraft} />
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {props.sorted.map(({ thread, anchorPosition }) => (
        <li key={thread.threadId}>
          <CommentThreadCard
            epicId={props.epicId}
            artifactType={props.artifactType}
            artifactId={props.artifactId}
            thread={thread}
            currentUserId={props.currentUserId}
            canModerate={props.canModerate}
            isExpanded={props.activeThreadId === thread.threadId}
            hasAnchor={anchorPosition !== null}
            onExpandedChange={(next) =>
              props.onExpandedChange(thread.threadId, next)
            }
            onActivateAnchor={() => props.onActivateThread(thread.threadId)}
          />
        </li>
      ))}
    </ul>
  );
}

interface EmptyStateProps {
  readonly filter: CommentThreadStatusFilter;
  readonly onPromptDraft: () => void;
}

function EmptyState({ filter, onPromptDraft }: EmptyStateProps) {
  const message = emptyMessageFor(filter);
  return (
    <div
      data-slot="comment-sidebar-empty"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border/60 bg-muted/20 px-4 py-8 text-center",
      )}
    >
      <MessageSquarePlus className="size-6 text-muted-foreground" />
      <p className="text-ui-sm text-muted-foreground">{message}</p>
      <Button variant="ghost" size="sm" onClick={onPromptDraft}>
        Got it
      </Button>
    </div>
  );
}

/**
 * Shown when the thread read failed and nothing is cached — the honest
 * counterpart to {@link EmptyState}.
 *
 * Deliberately says the threads could not be *loaded*, never that there are
 * none, and makes no claim about why or about when they come back. It borrows
 * the empty state's quiet dashed frame rather than an alert treatment: this is
 * a correction to what the sidebar was previously asserting, not a new alarm.
 * The agent-facing path already degrades this way — `comments.listThreads`
 * emits a `<warning>` for an unavailable artifact instead of an empty list
 * (`protocol/src/comments/comments-xml-formatting.ts`).
 */
function UnavailableState(props: {
  readonly localCommentsUnavailable: boolean;
}) {
  return (
    <div
      data-slot="comment-sidebar-unavailable"
      // A status, not an alert: the same quiet register as the visual
      // treatment. `polite` announces the correction once the reader finishes
      // its current utterance, rather than interrupting to report a failed
      // background read.
      role="status"
      aria-live="polite"
      className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border/60 bg-muted/20 px-4 py-8 text-center"
    >
      <MessageSquareWarning className="size-6 text-muted-foreground" />
      <div className="flex flex-col gap-1">
        <p className="text-ui-sm text-muted-foreground">
          {props.localCommentsUnavailable
            ? "Comments are available after cloud sync."
            : "Comments couldn't be loaded."}
        </p>
        <p className="text-ui-xs text-muted-foreground/80">
          {props.localCommentsUnavailable
            ? "This epic is currently stored locally."
            : "This doesn't mean there are none."}
        </p>
      </div>
    </div>
  );
}

function emptyMessageFor(filter: CommentThreadStatusFilter): string {
  if (filter === "open") {
    return "No open comments. Select text in the editor and click 💬 to start a thread (⌘⌥M).";
  }
  if (filter === "resolved") return "No resolved comments yet.";
  return "No comments on this artifact yet.";
}

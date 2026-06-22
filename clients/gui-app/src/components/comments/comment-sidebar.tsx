import { useCallback, useMemo, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { type EpicArtifactKind } from "@traycer/protocol/common/registry";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useEpicCommentThreads } from "@/hooks/comments/use-epic-comment-threads";
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

  const query = useEpicCommentThreads(epicId, artifactType, artifactId, {
    enabled: true,
  });

  const sorted = useMemo(() => {
    if (query.data === undefined) return [];
    const filtered = filterThreadsByStatus(query.data.threads, filter);
    return sortThreadsByDocumentOrder(filtered, anchorPositions);
  }, [query.data, filter, anchorPositions]);

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
      <div className="flex items-center justify-center py-8">
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </div>
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

function emptyMessageFor(filter: CommentThreadStatusFilter): string {
  if (filter === "open") {
    return "No open comments. Select text in the editor and click 💬 to start a thread (⌘⌥M).";
  }
  if (filter === "resolved") return "No resolved comments yet.";
  return "No comments on this artifact yet.";
}

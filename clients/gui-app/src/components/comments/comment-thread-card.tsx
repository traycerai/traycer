import { useCallback, useRef, useState } from "react";
import { MoreHorizontal, CheckCircle2, RotateCcw, Trash2 } from "lucide-react";
import {
  type EpicArtifactKind,
  type JsonContent,
} from "@traycer/protocol/common/registry";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useDeleteComment,
  useDeleteCommentThread,
  useEditComment,
  useReplyToCommentThread,
  useSetCommentThreadResolved,
} from "@/hooks/comments/use-comment-thread-mutations";
import {
  CommentComposer,
  type CommentComposerHandle,
} from "./comment-composer";
import { CommentContent } from "./comment-content-renderer";
import { deriveInitials } from "./mention-utils";

export interface CommentThreadCardProps {
  readonly epicId: string;
  readonly artifactType: EpicArtifactKind;
  readonly artifactId: string;
  readonly thread: CommentThreadWire;
  /** Logged-in user id; resolved upstream from the auth profile against the
   *  collaborators list. `null` while unresolved (rare; the sidebar should
   *  hide actions until it lands). */
  readonly currentUserId: string | null;
  /** True when the caller's role permits resolve / delete-thread. Author of
   *  the thread is always permitted regardless of role. */
  readonly canModerate: boolean;
  readonly isExpanded: boolean;
  readonly hasAnchor: boolean;
  readonly onExpandedChange: (next: boolean) => void;
  readonly onActivateAnchor: () => void;
}

/**
 * Single comment thread shown in the sidebar.
 *
 * Layout:
 *   - quoted snapshot (italic, line-clamped) - frozen at thread creation
 *     time; never re-derived from the live document so anchor edits never
 *     mutate the visible quote
 *   - comments stack (oldest first) with per-comment edit / delete kebab
 *   - inline reply composer at the bottom (only when expanded)
 *   - "Anchor missing" badge when the parent reports `hasAnchor=false`
 *
 * Mutation invalidation is handled by the mutation hooks themselves; this
 * component only kicks them off and reacts to `isPending` for spinners.
 */
export function CommentThreadCard(props: CommentThreadCardProps) {
  const {
    epicId,
    artifactType,
    artifactId,
    thread,
    currentUserId,
    canModerate,
    isExpanded,
    hasAnchor,
    onExpandedChange,
    onActivateAnchor,
  } = props;

  const replyMutation = useReplyToCommentThread();
  const editMutation = useEditComment();
  const deleteCommentMutation = useDeleteComment();
  const deleteThreadMutation = useDeleteCommentThread();
  const setResolvedMutation = useSetCommentThreadResolved();

  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const replyHandleRef = useRef<CommentComposerHandle | null>(null);

  const isAuthor =
    currentUserId !== null && currentUserId === thread.data.createdByUserId;
  const canManageThread = isAuthor || canModerate;

  const handleReplySubmit = useCallback(
    (content: JsonContent) => {
      replyMutation.mutate(
        {
          epicId,
          artifactType,
          artifactId,
          threadId: thread.threadId,
          content,
        },
        {
          onSuccess: () => {
            replyHandleRef.current?.reset();
            replyHandleRef.current?.focus();
          },
        },
      );
    },
    [replyMutation, epicId, artifactType, artifactId, thread.threadId],
  );

  const handleToggleResolved = useCallback(() => {
    setResolvedMutation.mutate({
      epicId,
      artifactType,
      artifactId,
      threadId: thread.threadId,
      resolved: !thread.resolved,
    });
  }, [
    setResolvedMutation,
    epicId,
    artifactType,
    artifactId,
    thread.threadId,
    thread.resolved,
  ]);

  const handleDeleteThread = useCallback(() => {
    deleteThreadMutation.mutate({
      epicId,
      artifactType,
      artifactId,
      threadId: thread.threadId,
    });
  }, [deleteThreadMutation, epicId, artifactType, artifactId, thread.threadId]);

  const handleHeaderClick = useCallback(() => {
    if (!isExpanded) {
      onExpandedChange(true);
      onActivateAnchor();
      return;
    }
    onExpandedChange(false);
  }, [isExpanded, onExpandedChange, onActivateAnchor]);

  const quotedText = thread.data.quotedText ?? "";

  return (
    <article
      data-slot="comment-thread-card"
      data-resolved={thread.resolved ? "true" : undefined}
      data-expanded={isExpanded ? "true" : undefined}
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border bg-card p-3 transition-colors",
        "data-[resolved=true]:opacity-70",
        isExpanded ? "ring-1 ring-ring/40" : "hover:bg-muted/40",
      )}
    >
      <button
        type="button"
        onClick={handleHeaderClick}
        aria-expanded={isExpanded}
        aria-controls={`comment-thread-body-${thread.threadId}`}
        className="flex w-full items-start gap-2 text-left"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {quotedText.length > 0 ? (
            <span className="line-clamp-3 border-l-2 border-muted-foreground/40 pl-2 text-ui-xs text-muted-foreground italic">
              {quotedText}
            </span>
          ) : null}
          <div className="flex items-center gap-2 text-ui-xs text-muted-foreground">
            <span>
              {thread.comments.length} comment
              {thread.comments.length === 1 ? "" : "s"}
            </span>
            {thread.resolved ? (
              <Badge variant="secondary" className="h-4 px-1 text-overline">
                Resolved
              </Badge>
            ) : null}
            {hasAnchor ? null : (
              <Badge variant="outline" className="h-4 px-1 text-overline">
                Anchor missing
              </Badge>
            )}
          </div>
        </div>
      </button>

      {isExpanded ? (
        <div
          id={`comment-thread-body-${thread.threadId}`}
          className="flex flex-col gap-3"
        >
          <ul className="flex flex-col gap-3">
            {thread.comments.map((comment) => (
              <CommentEntry
                key={comment.commentId}
                comment={comment}
                epicId={epicId}
                currentUserId={currentUserId}
                isEditing={editingCommentId === comment.commentId}
                onStartEdit={() => setEditingCommentId(comment.commentId)}
                onCancelEdit={() => setEditingCommentId(null)}
                onSubmitEdit={(next) => {
                  editMutation.mutate(
                    {
                      epicId,
                      artifactType,
                      artifactId,
                      threadId: thread.threadId,
                      commentId: comment.commentId,
                      content: next,
                    },
                    { onSuccess: () => setEditingCommentId(null) },
                  );
                }}
                onDelete={() => {
                  deleteCommentMutation.mutate({
                    epicId,
                    artifactType,
                    artifactId,
                    threadId: thread.threadId,
                    commentId: comment.commentId,
                  });
                }}
              />
            ))}
          </ul>

          <CommentComposer
            ref={replyHandleRef}
            epicId={epicId}
            initialContent={null}
            placeholder="Reply…"
            focusOnMount={false}
            submitLabel="Reply"
            onSubmit={handleReplySubmit}
            onCancel={null}
            className={undefined}
          />

          <footer className="flex items-center justify-end gap-2">
            {canManageThread ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleToggleResolved}
                disabled={setResolvedMutation.isPending}
              >
                {thread.resolved ? (
                  <>
                    <RotateCcw className="size-4" />
                    Reopen
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="size-4" />
                    Resolve
                  </>
                )}
              </Button>
            ) : null}
            {canManageThread ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDeleteThread}
                disabled={deleteThreadMutation.isPending}
                aria-label="Delete thread"
              >
                <Trash2 className="size-4" />
              </Button>
            ) : null}
          </footer>
        </div>
      ) : null}
    </article>
  );
}

type CommentEntryData = CommentThreadWire["comments"][number];

interface CommentEntryProps {
  readonly comment: CommentEntryData;
  readonly epicId: string;
  readonly currentUserId: string | null;
  readonly isEditing: boolean;
  readonly onStartEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onSubmitEdit: (content: JsonContent) => void;
  readonly onDelete: () => void;
}

function CommentEntry(props: CommentEntryProps) {
  const {
    comment,
    epicId,
    currentUserId,
    isEditing,
    onStartEdit,
    onCancelEdit,
    onSubmitEdit,
    onDelete,
  } = props;

  const isCommentAuthor =
    currentUserId !== null && currentUserId === comment.author.userId;
  const authorLabel = comment.author.fallbackHandle ?? comment.author.userId;

  return (
    <li className="flex flex-col gap-1.5" data-slot="comment-entry">
      <header className="flex items-center gap-2">
        <Avatar size="sm">
          <AvatarFallback>{deriveInitials(authorLabel)}</AvatarFallback>
        </Avatar>
        <span className="truncate text-ui-sm font-medium">{authorLabel}</span>
        <time
          className="text-ui-xs text-muted-foreground"
          dateTime={new Date(comment.createdAt).toISOString()}
        >
          {formatRelativeTime(comment.createdAt)}
        </time>
        {comment.updatedAt !== null ? (
          <span className="text-ui-xs text-muted-foreground">(edited)</span>
        ) : null}
        {isCommentAuthor ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto size-6"
                aria-label="Comment actions"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onStartEdit}>Edit</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>
      {isEditing ? (
        <CommentComposer
          epicId={epicId}
          initialContent={comment.content}
          placeholder="Edit comment…"
          focusOnMount
          submitLabel="Save"
          onSubmit={onSubmitEdit}
          onCancel={onCancelEdit}
          className={undefined}
        />
      ) : (
        <CommentContent content={comment.content} className={undefined} />
      )}
    </li>
  );
}

/**
 * Approximate `now - timestamp` formatter used by both the sidebar and the
 * hover popover. Keeps the bundle small (no `date-fns` for one helper) and
 * aligns with the granularity Views uses ("just now / 5m / 2h / 3d / Apr 12").
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - timestamp);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

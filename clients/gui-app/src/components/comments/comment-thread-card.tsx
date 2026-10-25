import type { CommentArtifactKind } from "@/lib/comments/artifact-comment-kind";
import { useCallback, useRef, useState, type Ref } from "react";
import {
  MoreHorizontal,
  CheckCircle2,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { type JsonContent } from "@traycer/protocol/common/registry";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
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
import type { HostRpcRegistry } from "@/lib/host";
import {
  useDeleteCommentForClient,
  useDeleteCommentThreadForClient,
  useEditCommentForClient,
  useReplyToCommentThreadForClient,
  useSetCommentThreadResolvedForClient,
} from "@/hooks/comments/use-comment-thread-mutations";
import {
  CommentComposer,
  type CommentComposerHandle,
} from "./comment-composer";
import { CommentContent } from "./comment-content-renderer";
import { deriveInitials } from "./mention-utils";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";

export interface CommentThreadCardProps {
  readonly epicId: string;
  /** The host serving the surface this card was mounted from - the Epic
   *  session's client under the sidebar. Passed rather than read here so the
   *  card stays mountable from a tile too (D15). */
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly artifactType: CommentArtifactKind;
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
  readonly framePresentation?: {
    readonly number: number;
    readonly label: string;
    readonly onClose: () => void;
  };
}

/**
 * Thread body and actions shared by the sidebar and frame popovers.
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
    hostClient,
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

  const replyMutation = useReplyToCommentThreadForClient(hostClient);
  const editMutation = useEditCommentForClient(hostClient);
  const deleteCommentMutation = useDeleteCommentForClient(hostClient);
  const deleteThreadMutation = useDeleteCommentThreadForClient(hostClient);
  const setResolvedMutation = useSetCommentThreadResolvedForClient(hostClient);

  const [editingComment, setEditingComment] = useState<{
    readonly commentId: string;
  } | null>(null);
  const replyHandleRef = useRef<CommentComposerHandle | null>(null);
  const editHandleRef = useRef<CommentComposerHandle | null>(null);

  const isAuthor =
    currentUserId !== null && currentUserId === thread.data.createdByUserId;
  const canManageThread = isAuthor || canModerate;

  const handleReplySubmit = useCallback(
    async (content: JsonContent) => {
      const submittedComposer = replyHandleRef.current;
      await replyMutation.mutateAsync({
        epicId,
        artifactType,
        artifactId,
        threadId: thread.threadId,
        content,
      });
      if (replyHandleRef.current === submittedComposer) {
        submittedComposer?.reset();
        submittedComposer?.focus();
      }
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

  const quotedText =
    artifactType === "canvas" && thread.data.anchorKind === "artifact"
      ? "Whole canvas"
      : (thread.data.quotedText ?? "");

  return (
    <article
      data-slot="comment-thread-card"
      data-resolved={thread.resolved ? "true" : undefined}
      data-expanded={isExpanded ? "true" : undefined}
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border bg-card p-3 transition-colors",
        "data-[resolved=true]:opacity-70",
        isExpanded ? "ring-1 ring-ring/40" : "hover:bg-foreground/5",
      )}
    >
      {props.framePresentation === undefined ? (
        <button
          type="button"
          // The card's expand/collapse control. Named as a slot because it is not
          // a `ui/button` and the coarse-pointer hit-slop rules address controls
          // by slot; its own box is a single line of meta text on a thread with no
          // quoted snapshot, well under the 44px touch target.
          data-slot="comment-thread-toggle"
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
                <Badge variant="secondary" className="h-4" size="sm">
                  Resolved
                </Badge>
              ) : null}
              {hasAnchor ? null : (
                <Badge variant="outline" className="h-4" size="sm">
                  Anchor missing
                </Badge>
              )}
            </div>
          </div>
        </button>
      ) : (
        <FrameThreadHeader
          presentation={props.framePresentation}
          hasAnchor={hasAnchor}
          canManage={canManageThread}
          resolved={thread.resolved}
          resolving={setResolvedMutation.isPending}
          deleting={deleteThreadMutation.isPending}
          onResolve={handleToggleResolved}
          onDelete={handleDeleteThread}
        />
      )}

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
                hostClient={hostClient}
                currentUserId={currentUserId}
                isEditing={editingComment?.commentId === comment.commentId}
                isPending={editMutation.isPending}
                editComposerRef={editHandleRef}
                onStartEdit={() =>
                  setEditingComment({ commentId: comment.commentId })
                }
                onCancelEdit={() => setEditingComment(null)}
                onSubmitEdit={async (next) => {
                  const submittedComposer = editHandleRef.current;
                  await editMutation.mutateAsync({
                    epicId,
                    artifactType,
                    artifactId,
                    threadId: thread.threadId,
                    commentId: comment.commentId,
                    content: next,
                  });
                  if (editHandleRef.current === submittedComposer) {
                    setEditingComment((current) =>
                      current === editingComment ? null : current,
                    );
                  }
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
            hostClient={hostClient}
            initialContent={null}
            placeholder="Reply…"
            focusOnMount={false}
            submitLabel="Reply"
            isPending={replyMutation.isPending}
            onSubmit={handleReplySubmit}
            onCancel={null}
            className={undefined}
          />

          {props.framePresentation === undefined ? (
            <CommentThreadFooter
              canManage={canManageThread}
              resolved={thread.resolved}
              resolving={setResolvedMutation.isPending}
              deleting={deleteThreadMutation.isPending}
              onResolve={handleToggleResolved}
              onDelete={handleDeleteThread}
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

interface ThreadActionsProps {
  readonly canManage: boolean;
  readonly resolved: boolean;
  readonly resolving: boolean;
  readonly deleting: boolean;
  readonly onResolve: () => void;
  readonly onDelete: () => void;
}

function CommentThreadFooter(props: ThreadActionsProps) {
  return (
    <footer className="flex items-center justify-end gap-2">
      {props.canManage ? (
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={props.onResolve}
            disabled={props.resolving}
          >
            {props.resolved ? (
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
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onDelete}
            disabled={props.deleting}
            aria-label="Delete thread"
          >
            <Trash2 className="size-4" />
          </Button>
        </>
      ) : null}
    </footer>
  );
}

function FrameThreadHeader(
  props: {
    readonly presentation: NonNullable<
      CommentThreadCardProps["framePresentation"]
    >;
    readonly hasAnchor: boolean;
  } & ThreadActionsProps,
) {
  return (
    <>
      <header className="flex items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-ui-xs font-medium text-primary-foreground">
          {props.presentation.number}
        </span>
        <span className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground">
          {props.presentation.label}
        </span>
        {props.canManage ? (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={props.resolved ? "Reopen thread" : "Resolve thread"}
              disabled={props.resolving}
              onClick={props.onResolve}
            >
              {props.resolved ? <RotateCcw /> : <CheckCircle2 />}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Thread actions"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  variant="destructive"
                  disabled={props.deleting}
                  onSelect={props.onDelete}
                >
                  <Trash2 />
                  Delete thread
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close thread"
          onClick={props.presentation.onClose}
        >
          <X />
        </Button>
      </header>
      {props.hasAnchor ? null : (
        <Badge variant="outline" size="sm">
          Anchor missing
        </Badge>
      )}
    </>
  );
}

export function FrameCommentSummary(props: {
  readonly thread: CommentThreadWire;
  readonly number: number;
  readonly label: string;
  readonly hasAnchor: boolean;
  readonly onActivate: () => void;
}) {
  const first = props.thread.comments.at(0);
  const author =
    first?.author.fallbackHandle ?? first?.author.userId ?? "Unknown author";
  const replies = Math.max(0, props.thread.comments.length - 1);
  const createdAt = first?.createdAt ?? props.thread.createdAt;
  return (
    <button
      type="button"
      data-slot="frame-comment-summary"
      aria-label={`Open comment ${props.number}`}
      onClick={props.onActivate}
      className="flex w-full flex-col gap-2 rounded-md border border-border bg-card p-3 text-left hover:bg-foreground/5"
    >
      <span className="flex w-full items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-ui-xs font-medium text-primary-foreground">
          {props.number}
        </span>
        <Avatar size="sm">
          <AvatarFallback>{deriveInitials(author)}</AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1 truncate text-ui-sm font-medium">
          {author}
        </span>
        <time
          dateTime={new Date(createdAt).toISOString()}
          className="shrink-0 text-ui-xs text-muted-foreground"
        >
          {formatRelativeTime(createdAt)}
        </time>
      </span>
      <span className="line-clamp-2 text-ui-sm">
        {first === undefined
          ? "Comment deleted"
          : extractPlainTextFromComposerJSONContent(first.content)}
      </span>
      <span className="w-full truncate text-ui-xs text-muted-foreground">
        {props.label}
      </span>
      <span className="flex items-center gap-2 text-ui-xs text-muted-foreground">
        {replies} {replies === 1 ? "reply" : "replies"}
        {props.hasAnchor ? null : (
          <Badge variant="outline" size="sm">
            Anchor missing
          </Badge>
        )}
      </span>
    </button>
  );
}

type CommentEntryData = CommentThreadWire["comments"][number];

interface CommentEntryProps {
  readonly comment: CommentEntryData;
  readonly epicId: string;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly currentUserId: string | null;
  readonly isEditing: boolean;
  readonly isPending: boolean;
  readonly editComposerRef: Ref<CommentComposerHandle>;
  readonly onStartEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onSubmitEdit: (content: JsonContent) => Promise<void>;
  readonly onDelete: () => void;
}

function CommentEntry(props: CommentEntryProps) {
  const {
    comment,
    epicId,
    hostClient,
    currentUserId,
    isEditing,
    isPending,
    editComposerRef,
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
        {comment.updatedAt !== null && comment.updatedAt > comment.createdAt ? (
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
          ref={editComposerRef}
          epicId={epicId}
          hostClient={hostClient}
          initialContent={comment.content}
          placeholder="Edit comment…"
          focusOnMount
          submitLabel="Save"
          isPending={isPending}
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

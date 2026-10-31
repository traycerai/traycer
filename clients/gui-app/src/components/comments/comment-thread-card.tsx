import { FrameFullscreenContext } from "./frame-comment-surface-context";
import type { CommentArtifactKind } from "@/lib/comments/artifact-comment-kind";
import {
  useCallback,
  useContext,
  useSyncExternalStore,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  CanvasCommentDraftContext,
  EMPTY_CANVAS_THREAD_DRAFT,
  submitCanvasCommentDraft,
  type SharedCommentComposerDraft,
  type CanvasCommentDraftStore,
} from "./canvas-comment-drafts";
import { MoreHorizontal, CheckCircle2, RotateCcw, Trash2 } from "lucide-react";
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
import "@/lib/composer/tiptap-json-content";

function sharedComposerDraft(
  store: CanvasCommentDraftStore | null,
  threadId: string,
  commentId: string | null,
): SharedCommentComposerDraft | undefined {
  if (store === null) return undefined;
  const draft = store.getState().threads[threadId] ?? EMPTY_CANVAS_THREAD_DRAFT;
  const edit = draft.edit;
  if (commentId !== null && edit?.commentId !== commentId) return undefined;
  return {
    content: commentId === null ? draft.reply : (edit?.content ?? null),
    dirty: commentId === null ? draft.reply !== null : edit?.dirty === true,
    pending: draft.pending,
    onChange: (content, empty) => {
      const current =
        store.getState().threads[threadId] ?? EMPTY_CANVAS_THREAD_DRAFT;
      if (current.pending) return;
      if (commentId === null)
        store
          .getState()
          .update(threadId, { ...current, reply: empty ? null : content });
      else if (current.edit?.commentId === commentId)
        store.getState().update(threadId, {
          ...current,
          edit: { commentId, content, dirty: true },
        });
    },
  };
}

function useCommentDraft(
  threadId: string,
  replySaving: boolean,
  editSaving: boolean,
) {
  const sharedStore = useContext(CanvasCommentDraftContext);
  const shared = useSyncExternalStore(
    (listener) => sharedStore?.subscribe(listener) ?? (() => undefined),
    () =>
      sharedStore?.getState().threads[threadId] ?? EMPTY_CANVAS_THREAD_DRAFT,
  );
  const [localEditingComment, setEditingComment] = useState<{
    readonly commentId: string;
  } | null>(null);
  const editingComment =
    sharedStore === null ? localEditingComment : shared.edit;
  return {
    sharedStore,
    shared,
    editingComment,
    setEditingComment,
    replyPending: replySaving || shared.pending,
    editPending: editSaving || shared.pending,
  };
}

export interface CommentThreadCardProps {
  readonly epicId: string;
  /** The host serving the surface this card was mounted from - the Epic
   *  session's client under the sidebar. Passed rather than read here so the
   *  card stays mountable from a tile too. */
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
}

/** What the card quotes: canvas-wide anchors carry a label, not page text. */
function threadQuotedText(
  artifactType: CommentArtifactKind,
  thread: CommentThreadWire,
): string {
  if (artifactType !== "canvas") return thread.data.quotedText ?? "";
  if (thread.data.anchorKind === "artifact") return "Whole canvas";
  if (thread.data.anchorKind === "canvas-point")
    return thread.data.label ?? "Pinned on canvas";
  return thread.data.quotedText ?? "";
}

/**
 * Thread body and actions for the comments sidebar.
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

  const {
    sharedStore,
    shared,
    editingComment,
    setEditingComment,
    replyPending,
    editPending,
  } = useCommentDraft(
    thread.threadId,
    replyMutation.isPending,
    editMutation.isPending,
  );
  const replyHandleRef = useRef<CommentComposerHandle | null>(null);
  const editHandleRef = useRef<CommentComposerHandle | null>(null);

  const isAuthor =
    currentUserId !== null && currentUserId === thread.data.createdByUserId;
  const canManageThread = isAuthor || canModerate;

  const handleReplySubmit = useCallback(
    async (content: JsonContent) => {
      const submittedComposer = replyHandleRef.current;
      const saved = await submitCanvasCommentDraft(
        sharedStore,
        thread.threadId,
        "reply",
        async () => {
          await replyMutation.mutateAsync({
            epicId,
            artifactType,
            artifactId,
            threadId: thread.threadId,
            content,
          });
        },
      );
      if (saved && replyHandleRef.current === submittedComposer) {
        submittedComposer?.reset();
        submittedComposer?.focus();
      }
    },
    [
      replyMutation,
      epicId,
      artifactType,
      artifactId,
      thread.threadId,
      sharedStore,
    ],
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

  const quotedText = threadQuotedText(artifactType, thread);

  // A pin click (or any other activation) expands the card from outside the
  // sidebar's own scroll, so the list scrolls to the thread it just opened.
  // Starts false so a card that MOUNTS expanded scrolls too - a pin tap that
  // opens a closed panel selects the thread before its card exists.
  const wasExpanded = useRef(false);
  const scrollOnExpand = useCallback(
    (node: HTMLElement | null): void => {
      const appeared = isExpanded && !wasExpanded.current;
      wasExpanded.current = isExpanded;
      if (appeared) node?.scrollIntoView({ block: "nearest" });
    },
    [isExpanded],
  );

  return (
    <article
      ref={scrollOnExpand}
      data-slot="comment-thread-card"
      data-resolved={thread.resolved ? "true" : undefined}
      data-expanded={isExpanded ? "true" : undefined}
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border bg-card p-3 transition-colors",
        "data-[resolved=true]:opacity-70",
        isExpanded ? "ring-1 ring-ring/40" : "hover:bg-foreground/5",
      )}
    >
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
                isPending={editPending}
                editComposerRef={editHandleRef}
                sharedDraft={sharedComposerDraft(
                  sharedStore,
                  thread.threadId,
                  comment.commentId,
                )}
                onStartEdit={() => {
                  if (sharedStore === null)
                    setEditingComment({ commentId: comment.commentId });
                  // Choosing Edit again while this comment's edit is already
                  // open must not reseed it: that would discard the typing.
                  else if (
                    !shared.pending &&
                    shared.edit?.commentId !== comment.commentId
                  )
                    sharedStore.getState().update(thread.threadId, {
                      ...shared,
                      edit: {
                        commentId: comment.commentId,
                        content: comment.content,
                        dirty: false,
                      },
                    });
                }}
                onCancelEdit={() => {
                  if (sharedStore === null) setEditingComment(null);
                  else if (!shared.pending)
                    sharedStore
                      .getState()
                      .update(thread.threadId, { ...shared, edit: null });
                }}
                onSubmitEdit={async (next) => {
                  const submittedComposer = editHandleRef.current;
                  const saved = await submitCanvasCommentDraft(
                    sharedStore,
                    thread.threadId,
                    "edit",
                    async () => {
                      await editMutation.mutateAsync({
                        epicId,
                        artifactType,
                        artifactId,
                        threadId: thread.threadId,
                        commentId: comment.commentId,
                        content: next,
                      });
                    },
                  );
                  if (
                    saved &&
                    sharedStore === null &&
                    editHandleRef.current === submittedComposer
                  ) {
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
            sharedDraft={sharedComposerDraft(
              sharedStore,
              thread.threadId,
              null,
            )}
            placeholder="Reply…"
            focusOnMount={false}
            submitLabel="Reply"
            isPending={replyPending}
            onSubmit={handleReplySubmit}
            onCancel={null}
            className={undefined}
          />

          <CommentThreadFooter
            canManage={canManageThread}
            resolved={thread.resolved}
            resolving={setResolvedMutation.isPending}
            deleting={deleteThreadMutation.isPending}
            onResolve={handleToggleResolved}
            onDelete={handleDeleteThread}
          />
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

type CommentEntryData = CommentThreadWire["comments"][number];

interface CommentEntryProps {
  readonly comment: CommentEntryData;
  readonly epicId: string;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly currentUserId: string | null;
  readonly isEditing: boolean;
  readonly isPending: boolean;
  readonly editComposerRef: Ref<CommentComposerHandle>;
  readonly sharedDraft: SharedCommentComposerDraft | undefined;
  readonly onStartEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onSubmitEdit: (content: JsonContent) => Promise<void>;
  readonly onDelete: () => void;
}

function CommentEntry(props: CommentEntryProps) {
  const fullscreenContainer = useContext(FrameFullscreenContext);
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
          <DropdownMenu modal={fullscreenContainer === null}>
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
            <DropdownMenuContent align="end" container={fullscreenContainer}>
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
          sharedDraft={props.sharedDraft}
          placeholder="Edit comment…"
          focusOnMount={props.sharedDraft === undefined}
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

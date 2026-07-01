import {
  FloatingDraftPopover,
  ThreadAnchorHoverPopover,
} from "@/components/comments";
import {
  applyCommentDecorationSnapshot,
  ArtifactToolbar,
  deriveCollabUser,
  type ArtifactCommentAction,
  type CollabUser,
} from "@/editor-core";
import { useEpicCommentThreads } from "@/hooks/comments/use-epic-comment-threads";
import { useNativeDivScrollRestoration } from "@/hooks/scroll/use-native-div-scroll-restoration";
import {
  EPIC_NODE_PLACEHOLDER_TEXT,
  isEpicArtifactKind,
} from "@/lib/artifacts/node-display";
import { consumeArtifactEditorFocus } from "@/lib/artifacts/pending-editor-focus";
import { commentArtifactKindFor } from "@/lib/comments/artifact-comment-kind";
import {
  registerCommentEditor,
  revealCommentThreadAnchor,
} from "@/lib/comments/comment-editor-registry";
import { startCommentDraft } from "@/lib/comments/start-comment-draft";
import {
  useChildIdsOf,
  useEpicArtifactBodyAvailability,
  useEpicArtifactBodyAwareness,
  useEpicArtifactFragment,
  useEpicPermissionRole,
  useEpicSnapshotLoaded,
  useOpenEpicId,
} from "@/lib/epic-selectors";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useAnchorPositionsStore } from "@/stores/comments/anchor-positions-store";
import { useRegisterTileFindAdapter } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import {
  useActiveThreadId,
  useCommentThreadsStore,
  useDraftRange,
  useFlashThread,
  useHoverThreadId,
} from "@/stores/comments/comment-threads-store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import { WORKSPACE_FILE_TAB_KIND } from "@/stores/epics/canvas/types";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import type { EpicArtifactRoomAvailability } from "@/stores/epics/open-epic/types";
import type { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { ArtifactChildIndex } from "./artifact-child-index";
import {
  resolveArtifactEditorBackgroundFocusPosition,
  shouldHandleArtifactEditorBackgroundFocus,
} from "./artifact-editor-background-focus";
import { createArtifactEditorFindAdapter } from "../tile-find/artifact-editor-find-adapter";
import { useCollabTileEditor } from "./use-collab-tile-editor";

interface CollabTileBodyProps {
  readonly node: EpicNodeRef;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly isActive: boolean;
  readonly testId: string;
}

interface CollabTileBodyEditorProps extends CollabTileBodyProps {
  readonly fragment: Y.XmlFragment;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
}

const GUEST_COLLAB_USER: CollabUser = deriveCollabUser({
  userName: "Guest",
  email: null,
});

/**
 * Shared body for spec / ticket / story tiles. Resolves the node's
 * `Y.XmlFragment` from the per-Epic Y.Doc and wires it into a live Tiptap
 * editor with collaboration + caret presence. Re-gates `editable` whenever
 * the user's permission role changes so a viewer-downgrade synchronously
 * locks the surface.
 */
export function CollabTileBody(props: CollabTileBodyProps) {
  const fragment = useEpicArtifactFragment(props.node.id);
  const artifactRoomAwareness = useEpicArtifactBodyAwareness(props.node.id);
  const bodyAvailability = useEpicArtifactBodyAvailability(props.node.id);
  const snapshotLoaded = useEpicSnapshotLoaded();
  const fragmentDoc = fragment?.doc ?? null;

  if (
    !snapshotLoaded ||
    fragment === null ||
    fragmentDoc === null ||
    artifactRoomAwareness === null
  ) {
    return (
      <CollabTileSkeleton
        testId={props.testId}
        bodyAvailability={bodyAvailability}
      />
    );
  }

  return (
    <CollabTileBodyEditor
      {...props}
      fragment={fragment}
      doc={fragmentDoc}
      awareness={artifactRoomAwareness}
    />
  );
}

function CollabTileSkeleton(props: {
  readonly testId: string;
  readonly bodyAvailability: EpicArtifactRoomAvailability;
}) {
  const testIdSuffix =
    props.bodyAvailability === "unavailable" ? "unavailable" : "loading";

  return (
    <div
      data-testid={`${props.testId}-${testIdSuffix}`}
      data-artifact-room-availability={props.bodyAvailability}
      className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-8"
    >
      <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
    </div>
  );
}

function CollabTileBodyEditor(props: CollabTileBodyEditorProps) {
  const {
    node,
    viewTabId,
    tileId,
    isActive,
    testId,
    fragment,
    doc,
    awareness,
  } = props;
  const role = useEpicPermissionRole();
  const profile = useAuthStore((s) => s.profile);
  const editable = role === "owner" || role === "editor";
  const editorRootRef = useRef<HTMLDivElement>(null);
  const epicId = useOpenEpicId();
  const commentArtifactKind =
    node.type === WORKSPACE_FILE_TAB_KIND
      ? null
      : commentArtifactKindFor(node.type);

  const user = useMemo<CollabUser>(
    () => (profile === null ? GUEST_COLLAB_USER : deriveCollabUser(profile)),
    [profile],
  );

  // Comments wiring - chat tiles get `null` and the toolbar / shortcut
  // surfaces simply don't render; everything else opts in.
  const commentsSupported = commentArtifactKind !== null;
  const setDraft = useCommentThreadsStore((s) => s.setDraft);
  const setActiveThread = useCommentThreadsStore((s) => s.setActiveThread);
  const activeThreadId = useActiveThreadId(epicId);
  const hoverThreadId = useHoverThreadId(epicId);
  const flashThread = useFlashThread(epicId);
  const draft = useDraftRange(epicId);
  const threadsQuery = useEpicCommentThreads(
    epicId,
    commentArtifactKind ?? "spec",
    node.id,
    { enabled: commentsSupported },
  );
  const setActivePanelIdAndExpand = useLeftPanelStore(
    (s) => s.setActivePanelIdAndExpand,
  );
  const revealCommentsPanel = useLeftPanelStore((s) => s.revealCommentsPanel);
  const setFlashThread = useCommentThreadsStore((s) => s.setFlashThread);
  const clearFlashThread = useCommentThreadsStore((s) => s.clearFlashThread);
  const resolvedThreadIds = useMemo(
    () =>
      (threadsQuery.data?.threads ?? []).reduce(
        (ids, thread) => (thread.resolved ? ids.add(thread.threadId) : ids),
        new Set<string>(),
      ),
    [threadsQuery.data],
  );
  // `null` until the thread list resolves so we don't transiently treat
  // every anchor as orphan during initial load. Once loaded, anchors
  // whose `threadId` is missing from this set get filtered out of the
  // decoration layer - a defense against historical orphan marks left in
  // production docs before the host-side strip shipped.
  const liveThreadIds = useMemo<ReadonlySet<string> | null>(
    () =>
      threadsQuery.data === undefined
        ? null
        : new Set(threadsQuery.data.threads.map((thread) => thread.threadId)),
    [threadsQuery.data],
  );
  const ownedDraftRange = useMemo(
    () =>
      draft !== null && draft.tileId === tileId && draft.artifactId === node.id
        ? { from: draft.from, to: draft.to }
        : null,
    [draft, tileId, node.id],
  );

  // Stable callback for the keymap extension. Reads via closure; the
  // extension caches it on `this.options` so a callback identity flip
  // would NOT reach it without rebuilding the editor - keeping the deps
  // tight to the tile/node owner so the saved draft cannot leak to a
  // sibling pane in the same Epic.
  const onCommentShortcut = useMemo<
    ((editor: Editor) => boolean) | null
  >(() => {
    if (!commentsSupported) return null;
    return (ed) =>
      startCommentDraft(
        ed,
        { epicId, tabId: viewTabId, tileId, artifactId: node.id },
        setDraft,
      ).started;
  }, [commentsSupported, epicId, viewTabId, tileId, node.id, setDraft]);

  // A container (any artifact with children) renders its child index below the
  // body, so the empty-doc authoring placeholder ("Describe what you want to
  // build…") both fights that index and prompts the wrong thing. Suppress it
  // when children exist; the body stays editable for an optional overview.
  const hasChildren = useChildIdsOf(node.id).length > 0;
  const kindPlaceholder = isEpicArtifactKind(node.type)
    ? EPIC_NODE_PLACEHOLDER_TEXT[node.type]
    : "Start writing…";
  const editor = useCollabTileEditor({
    doc,
    fragment,
    awareness,
    editable,
    user,
    onCommentShortcut,
    anchorScope: commentsSupported ? { epicId, artifactId: node.id } : null,
    placeholderText: hasChildren ? "" : kindPlaceholder,
  });

  // One-shot focus handoff from the create flows: when this tile exists
  // because the user just created an empty spec/ticket/story/review, drop
  // the caret at the start of the placeholder line as soon as the editor
  // mounts. Gated on `isActive` so a user who tabbed away mid-create doesn't
  // get focus yanked. Emptiness is checked BEFORE consuming the token:
  // content can land in the Y.Doc ahead of this effect, and a doc that
  // already has content must not silently burn the request.
  useEffect(() => {
    if (editor === null) return;
    if (!isActive || !editable) return;
    if (!isEpicArtifactKind(node.type)) return;
    if (!editor.isEmpty) return;
    if (!consumeArtifactEditorFocus(node.id, node.instanceId)) return;
    editor.commands.focus("start");
  }, [editor, isActive, editable, node.id, node.instanceId, node.type]);

  const commentAction = useMemo<ArtifactCommentAction | null>(() => {
    if (!commentsSupported || editor === null) return null;
    return {
      onStart: () => {
        startCommentDraft(
          editor,
          { epicId, tabId: viewTabId, tileId, artifactId: node.id },
          setDraft,
        );
      },
    };
  }, [commentsSupported, editor, epicId, viewTabId, tileId, node.id, setDraft]);

  useEffect(() => {
    const rootElement = editorRootRef.current;
    if (rootElement === null || editor === null || !isActive || !editable) {
      return;
    }

    const handleBackgroundMouseDown = (event: MouseEvent): void => {
      if (event.target === null) return;
      if (
        !shouldHandleArtifactEditorBackgroundFocus({
          editor,
          eventButton: event.button,
          eventTarget: event.target,
          rootElement,
          clientX: event.clientX,
        })
      ) {
        return;
      }

      const focusPosition = resolveArtifactEditorBackgroundFocusPosition(
        editor,
        event.clientX,
        event.clientY,
      );
      editor.commands.focus(focusPosition, { scrollIntoView: false });
    };

    rootElement.addEventListener("mousedown", handleBackgroundMouseDown);
    return () => {
      rootElement.removeEventListener("mousedown", handleBackgroundMouseDown);
    };
  }, [editor, isActive, editable]);

  // Swap the left panel to Comments + focus the matching thread. Shared
  // by the floating-draft `onCreated` callback and the hover popover's
  // click handler so both paths land on the same surface.
  const onActivateThread = useCallback(
    (threadId: string) => {
      setActiveThread(epicId, threadId);
      setFlashThread(epicId, threadId);
      revealCommentsPanel(viewTabId);
      setActivePanelIdAndExpand(viewTabId, "comments");
      revealCommentThreadAnchor(epicId, node.id, threadId);
    },
    [
      epicId,
      node.id,
      setActiveThread,
      setFlashThread,
      revealCommentsPanel,
      setActivePanelIdAndExpand,
      viewTabId,
    ],
  );

  useEffect(() => {
    if (flashThread === null) return;
    const timeout = window.setTimeout(() => {
      clearFlashThread(epicId, flashThread.nonce);
    }, 1_000);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [epicId, flashThread, clearFlashThread]);

  useEffect(() => {
    if (editor === null || !commentsSupported) return;
    return registerCommentEditor({
      epicId,
      artifactId: node.id,
      tileId,
      editor,
      isActive,
    });
  }, [editor, commentsSupported, epicId, node.id, tileId, isActive]);

  useEffect(() => {
    if (editor === null || !commentsSupported) return;
    applyCommentDecorationSnapshot(editor, {
      activeThreadId,
      hoverThreadId,
      flashThreadId: flashThread?.threadId ?? null,
      resolvedThreadIds,
      liveThreadIds,
      draftRange: ownedDraftRange,
    });
  }, [
    editor,
    commentsSupported,
    activeThreadId,
    hoverThreadId,
    flashThread,
    resolvedThreadIds,
    liveThreadIds,
    ownedDraftRange,
  ]);

  // Anchor positions: the `AnchorReporter` Tiptap extension (mounted by
  // `useCollabTileEditor` when `anchorScope` is non-null) writes into
  // `useAnchorPositionsStore` on every editor transaction. We only need
  // an unmount-time cleanup here so a closed tile's bucket doesn't outlive
  // the editor instance.
  const clearAnchorPositions = useAnchorPositionsStore(
    (s) => s.clearForArtifact,
  );
  useEffect(() => {
    if (!commentsSupported) return;
    return () => {
      clearAnchorPositions(epicId, node.id);
    };
  }, [commentsSupported, epicId, node.id, clearAnchorPositions]);

  // Preserve the document's reading position across epic switches and remount.
  // Gated on the editor existing so restore waits for real content to lay out.
  const { scrollContainerRef: scrollRestorationRef, onScroll } =
    useNativeDivScrollRestoration(node.instanceId, editor !== null);
  const setScrollContainerRef = useCallback(
    (element: HTMLDivElement | null): void => {
      editorRootRef.current = element;
      scrollRestorationRef(element);
    },
    [scrollRestorationRef],
  );

  return (
    <div
      ref={setScrollContainerRef}
      data-testid={testId}
      data-node-id={node.id}
      className="flex h-full min-h-0 flex-col overflow-y-auto px-6 py-8"
      onScroll={onScroll}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <div className="tc-editor-surface">
          <div className="tc-editor-body">
            {editor !== null && isEpicArtifactKind(node.type) ? (
              <ArtifactFindAdapterRegistration editor={editor} node={node} />
            ) : null}
            <EditorContent editor={editor} />
          </div>
          {editor !== null ? (
            <ArtifactToolbar
              editor={editor}
              className={undefined}
              commentAction={commentAction}
              suppressBubbleMenu={ownedDraftRange !== null}
            />
          ) : null}
        </div>
        {isEpicArtifactKind(node.type) ? (
          <ArtifactChildIndex
            parentId={node.id}
            viewTabId={viewTabId}
            hostId={node.hostId}
          />
        ) : null}
      </div>
      {editor !== null && commentArtifactKind !== null ? (
        <>
          <FloatingDraftPopover
            epicId={epicId}
            artifactType={commentArtifactKind}
            artifactId={node.id}
            tileId={tileId}
            editor={editor}
            onCreated={onActivateThread}
          />
          <ThreadAnchorHoverPopover
            epicId={epicId}
            artifactType={commentArtifactKind}
            artifactId={node.id}
            editor={editor}
            resolvedThreadIds={resolvedThreadIds}
            onActivateThread={onActivateThread}
          />
        </>
      ) : null}
    </div>
  );
}

function ArtifactFindAdapterRegistration(props: {
  readonly editor: Editor;
  readonly node: EpicNodeRef;
}) {
  const { editor, node } = props;
  const adapter = useMemo(
    () =>
      createArtifactEditorFindAdapter({
        editor,
        tileInstanceId: node.instanceId,
        tileKind: node.type,
        activeUnitId: node.id,
      }),
    [editor, node.id, node.instanceId, node.type],
  );
  useRegisterTileFindAdapter(adapter);
  return null;
}

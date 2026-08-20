import {
  FloatingDraftPopover,
  ThreadAnchorHoverPopover,
} from "@/components/comments";
import {
  applyCommentDecorationSnapshot,
  ArtifactLinkPopover,
  ArtifactToolbar,
  deriveCollabUser,
  updateArtifactToolbarPosition,
  type ArtifactCommentAction,
  type CollabUser,
} from "@/editor-core";
import { useEpicCommentThreadsForClient } from "@/hooks/comments/use-epic-comment-threads";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useLoadDeadline } from "@/hooks/host/use-load-deadline";
import { collabTileNotice } from "./collab-tile-availability-copy";
import { TILE_CONTENT_BUDGET_MS } from "@/lib/host/bounded-load-budgets";
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
  useEpicCommentsHaveNoCloudRoom,
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
  type DraftRange,
} from "@/stores/comments/comment-threads-store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import { WORKSPACE_FILE_TAB_KIND } from "@/stores/epics/canvas/types";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { EpicArtifactRoomAvailability } from "@/stores/epics/open-epic/types";
import type { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type UIEvent,
} from "react";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { ArtifactChildIndex } from "./artifact-child-index";
import { ArtifactHeadingMinimap } from "./artifact-heading-minimap";
import {
  resolveArtifactEditorBackgroundFocusPosition,
  shouldHandleArtifactEditorBackgroundFocus,
} from "./artifact-editor-background-focus";
import { createArtifactEditorFindAdapter } from "../tile-find/artifact-editor-find-adapter";
import { seedArtifactTitleHeading } from "./artifact-editor-seed";
import { useArtifactDocTitleFollow } from "./use-artifact-doc-title-follow";
import { useCollabTileEditor } from "./use-collab-tile-editor";
import { useArtifactLinkOpener } from "./use-artifact-link-opener";
import { useArtifactImagePaste } from "@/hooks/artifacts/use-artifact-image-paste";
import type { UseComposerPasteResult } from "@/hooks/composer/use-composer-paste";

/**
 * Hint shown inside the empty leading title heading of a freshly seeded
 * hand-created artifact. Kind-agnostic - the body hint below already carries
 * the per-kind guidance.
 */
const ARTIFACT_TITLE_PLACEHOLDER = "Untitled";

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

type ArtifactPasteHandlers = Pick<
  UseComposerPasteResult,
  "onPaste" | "onDrop" | "onDragOver" | "onDragEnter" | "onDragLeave"
>;

function artifactPasteHandlers(
  enabled: boolean,
  paste: UseComposerPasteResult,
): Partial<ArtifactPasteHandlers> {
  if (!enabled) return {};
  return {
    onPaste: paste.onPaste,
    onDrop: paste.onDrop,
    onDragOver: paste.onDragOver,
    onDragEnter: paste.onDragEnter,
    onDragLeave: paste.onDragLeave,
  };
}

/**
 * Shared body for spec / ticket / story tiles. Resolves the node's
 * `Y.XmlFragment` from the per-Epic Y.Doc and wires it into a live Tiptap
 * editor with collaboration + caret presence. Re-gates `editable` whenever
 * the user's permission role changes so a viewer-downgrade synchronously
 * locks the surface.
 */
export function CollabTileBody(props: CollabTileBodyProps) {
  // `useEpicArtifactFragment` takes the artifact-room lease itself, which is
  // what materializes the room and pins it for this editor's lifetime.
  const fragment = useEpicArtifactFragment(props.node.id);
  const artifactRoomAwareness = useEpicArtifactBodyAwareness(props.node.id);
  const bodyAvailability = useEpicArtifactBodyAvailability(props.node.id);
  const snapshotLoaded = useEpicSnapshotLoaded();
  const fragmentDoc = fragment?.doc ?? null;

  const bodyPending =
    !snapshotLoaded ||
    fragment === null ||
    fragmentDoc === null ||
    artifactRoomAwareness === null;
  // Invariant 6. The artifact room is doc-scoped rather than host-scoped, so
  // this bounds on the node itself rather than reaching for a host lease -
  // there is no host here whose name would tell the reader anything.
  const loadBudgetElapsed = useLoadDeadline(
    bodyPending ? props.node.id : null,
    TILE_CONTENT_BUDGET_MS,
  );

  if (bodyPending) {
    return (
      <CollabTileSkeleton
        testId={props.testId}
        bodyAvailability={bodyAvailability}
        budgetElapsed={loadBudgetElapsed}
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

/**
 * The three pre-editor states, which used to be ONE.
 *
 * `unavailable` and `loading` rendered byte-identical markup - the same three
 * pulsing bars - distinguished only by a `data-testid` suffix no reader can
 * see. So a document whose room the host had refused looked exactly like a
 * document that was about to appear, and the only way to tell them apart was
 * to keep waiting: indefinitely, since neither state ended.
 *
 * Now each says which one it is, and the wait has a deadline (invariant 6).
 * The pulsing bars are kept for the short, genuinely-loading window - they
 * are a good placeholder for content that is coming - and retired the moment
 * the answer is anything else.
 */
function CollabTileSkeleton(props: {
  readonly testId: string;
  readonly bodyAvailability: EpicArtifactRoomAvailability;
  readonly budgetElapsed: boolean;
}) {
  const testIdSuffix =
    props.bodyAvailability === "unavailable" ? "unavailable" : "loading";
  const notice = collabTileNotice(props.bodyAvailability, props.budgetElapsed);

  return (
    <div
      data-testid={`${props.testId}-${testIdSuffix}`}
      data-artifact-room-availability={props.bodyAvailability}
      data-budget-elapsed={props.budgetElapsed ? "true" : "false"}
      className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-8"
    >
      {notice === null ? (
        <>
          {/* muted-fill-ok: tile body renders on the epic canvas, and
              --canvas never equals --muted in any theme */}
          <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
        </>
      ) : (
        <p
          role="status"
          aria-live="polite"
          className="text-ui-sm text-muted-foreground"
        >
          {notice}
        </p>
      )}
    </div>
  );
}

/**
 * The empty-doc authoring placeholder ("Describe what you want to build…").
 * A container (any artifact with children) renders its child index below the
 * body, so the placeholder both fights that index and prompts the wrong
 * thing - suppressed when children exist; the body stays editable for an
 * optional overview.
 */
function bodyPlaceholderText(
  nodeType: CollabTileBodyEditorProps["node"]["type"],
  hasChildren: boolean,
): string {
  if (hasChildren) return "";
  return isEpicArtifactKind(nodeType)
    ? EPIC_NODE_PLACEHOLDER_TEXT[nodeType]
    : "Start writing…";
}

/**
 * The draft selection range, only when THIS tile's artifact owns it - a
 * sibling pane's draft in the same Epic must not decorate this editor.
 */
function draftRangeOwnedByTile(
  draft: DraftRange | null,
  tileId: string,
  artifactId: string,
): { readonly from: number; readonly to: number } | null {
  if (
    draft === null ||
    draft.tileId !== tileId ||
    draft.artifactId !== artifactId
  ) {
    return null;
  }
  return { from: draft.from, to: draft.to };
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
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const editorRootRef = useRef<HTMLDivElement>(null);
  const headingMinimapRefreshRef = useRef<() => void>(() => undefined);
  const epicId = useOpenEpicId();
  const artifactLinkOpener = useArtifactLinkOpener({
    epicId,
    artifactId: node.id,
    viewTabId,
  });
  const commentArtifactKind =
    node.type === WORKSPACE_FILE_TAB_KIND
      ? null
      : commentArtifactKindFor(node.type);

  const user = useMemo<CollabUser>(
    () => (profile === null ? GUEST_COLLAB_USER : deriveCollabUser(profile)),
    [profile],
  );

  // Local artifact rooms deliberately have no comment-thread provider. Do not
  // let a person invest a draft in an action that the host can only reject as
  // `no_active_session`; the comments panel explains this boundary directly.
  //
  // `commentsHaveNoCloudRoom`, not `!== "local"`: the reserved-but-pre-cutover
  // `promoting` window has the same null provider and used to slip through.
  //
  // The STICKY hook rather than the bare predicate: a stream reconnect clears
  // the store's durability slots, and for the few frames before the
  // replacement arrives the raw answer flips to "comments are fine" on an epic
  // that has no room - long enough to start a draft the restored gate wipes.
  const noCloudRoom = useEpicCommentsHaveNoCloudRoom();
  const commentsSupported = commentArtifactKind !== null && !noCloudRoom;
  const setDraft = useCommentThreadsStore((s) => s.setDraft);
  const setActiveThread = useCommentThreadsStore((s) => s.setActiveThread);
  const activeThreadId = useActiveThreadId(epicId);
  const hoverThreadId = useHoverThreadId(epicId);
  const flashThread = useFlashThread(epicId);
  const draft = useDraftRange(epicId);
  // The artifact this tile edits is served by the TAB's host, so its threads
  // are read (and its comments written) on that client - never the app-wide
  // one, which answers a different machine mid re-point (D15). Resolved once
  // here and handed to both comment popovers so all three share one cache key.
  const tabHostClient = useTabHostClient();
  const threadsQuery = useEpicCommentThreadsForClient({
    client: tabHostClient,
    epicId,
    artifactType: commentArtifactKind ?? "spec",
    artifactId: node.id,
    options: { enabled: commentsSupported },
  });
  const setActivePanelIdAndExpand = useLeftPanelStore(
    (s) => s.setActivePanelIdAndExpand,
  );
  const revealCommentsPanel = useLeftPanelStore((s) => s.revealCommentsPanel);
  const setFlashThread = useCommentThreadsStore((s) => s.setFlashThread);
  const clearFlashThread = useCommentThreadsStore((s) => s.clearFlashThread);
  useEffect(() => {
    if (noCloudRoom) setDraft(epicId, null);
  }, [noCloudRoom, epicId, setDraft]);
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
    () => draftRangeOwnedByTile(draft, tileId, node.id),
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

  const hasChildren = useChildIdsOf(node.id).length > 0;
  const editor = useCollabTileEditor({
    doc,
    fragment,
    awareness,
    editable,
    user,
    onCommentShortcut,
    anchorScope: commentsSupported ? { epicId, artifactId: node.id } : null,
    placeholderText: bodyPlaceholderText(node.type, hasChildren),
    titlePlaceholderText: ARTIFACT_TITLE_PLACEHOLDER,
  });
  const artifactImagePaste = useArtifactImagePaste(editor, epicId, node.id);

  // Notion-style title inheritance: a hand-created artifact whose title still
  // follows the doc renames itself from the leading `# ` heading as the user
  // types, so the tab / sidebar title mirrors the document title.
  useArtifactDocTitleFollow({
    editor,
    epicId,
    node,
    viewTabId,
    editable,
  });

  // One-shot handoff from the create flows: when this tile exists because the
  // user just hand-created an empty spec/ticket/story/review, seed the
  // Notion-style title line (an empty `# ` heading + body paragraph) and drop
  // the caret into the title so the user types a title first - which the tab
  // then follows via `useArtifactDocTitleFollow`. Gated on `isActive` so a
  // user who tabbed away mid-create doesn't get focus yanked. Emptiness is
  // checked BEFORE consuming the token: content can land in the Y.Doc ahead
  // of this effect, and a doc that already has content must not silently burn
  // the request (nor get a stray heading prepended). The token is set only by
  // the manual "+" create flow on the creating client, so no collaborator
  // races in a second heading.
  useEffect(() => {
    if (editor === null) return;
    if (!isActive || !editable) return;
    if (!isEpicArtifactKind(node.type)) return;
    if (!editor.isEmpty) return;
    if (!consumeArtifactEditorFocus(node.id, node.instanceId)) return;
    seedArtifactTitleHeading(editor);
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
  const {
    scrollContainerRef: scrollRestorationRef,
    onScroll: onScrollRestoration,
  } = useNativeDivScrollRestoration(node.instanceId, editor !== null);
  const setScrollContainerRef = useCallback(
    (element: HTMLDivElement | null): void => {
      editorRootRef.current = element;
      setScrollContainer(element);
      scrollRestorationRef(element);
    },
    [scrollRestorationRef],
  );
  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>): void => {
      onScrollRestoration(event);
      // Pure arithmetic against the rail's cached heading offsets - kept on
      // this existing handler so the rail never attaches a scroll listener of
      // its own (the lesson the chat rail's own consolidation encodes).
      headingMinimapRefreshRef.current();
      if (editor === null || ownedDraftRange !== null || linkPopoverOpen) {
        return;
      }
      // TipTap's native BubbleMenu scroll listener is trailing-debounced.
      // Drive its documented escape hatch from this existing handler so the
      // selection toolbar tracks every native tile scroll event immediately.
      updateArtifactToolbarPosition(editor);
    },
    [editor, linkPopoverOpen, onScrollRestoration, ownedDraftRange],
  );

  // The heading rail is a sibling of the scroller, not a child: the scroller is
  // its own positioning context, so an overlay inside it would scroll away with
  // the document instead of holding the tile edge.
  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      <ArtifactHeadingMinimapMount
        editor={editor}
        node={node}
        refreshRef={headingMinimapRefreshRef}
        scroller={scrollContainer}
      />
      <div
        ref={setScrollContainerRef}
        data-testid={testId}
        data-node-id={node.id}
        className="flex h-full min-h-0 flex-col overflow-y-auto px-6 py-8"
        onScroll={onScroll}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <div className="tc-editor-surface">
            <div
              className="tc-editor-body"
              {...artifactPasteHandlers(
                artifactImagePaste.supported && editable,
                artifactImagePaste.paste,
              )}
            >
              {editor !== null && isEpicArtifactKind(node.type) ? (
                <ArtifactFindAdapterRegistration editor={editor} node={node} />
              ) : null}
              <EditorContent editor={editor} />
            </div>
            {editor !== null ? (
              <ArtifactToolbar
                editor={editor}
                className={undefined}
                scrollTarget={scrollContainer}
                commentAction={commentAction}
                suppressBubbleMenu={ownedDraftRange !== null || linkPopoverOpen}
              />
            ) : null}
          </div>
          {isEpicArtifactKind(node.type) ? (
            <ArtifactChildIndex
              epicId={epicId}
              parentId={node.id}
              viewTabId={viewTabId}
              hostId={node.hostId}
            />
          ) : null}
        </div>
        {editor !== null && commentsSupported ? (
          <>
            <FloatingDraftPopover
              epicId={epicId}
              hostClient={tabHostClient}
              artifactType={commentArtifactKind}
              artifactId={node.id}
              tileId={tileId}
              editor={editor}
              onCreated={onActivateThread}
            />
            <ThreadAnchorHoverPopover
              epicId={epicId}
              hostClient={tabHostClient}
              artifactType={commentArtifactKind}
              artifactId={node.id}
              editor={editor}
              resolvedThreadIds={resolvedThreadIds}
              onActivateThread={onActivateThread}
            />
          </>
        ) : null}
        {editor !== null ? (
          <ArtifactLinkPopover
            editor={editor}
            editable={editable}
            scrollContainer={scrollContainer}
            openLink={artifactLinkOpener.openLink}
            openLinkPending={artifactLinkOpener.isExternalPending}
            onOpenChange={setLinkPopoverOpen}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Gate for the heading rail, kept out of `CollabTileBodyEditor` so its two
 * conditions do not count against that component's complexity ceiling. Only
 * artifact kinds get an outline - a workspace file tile shares this body but
 * is not a document with a heading skeleton.
 */
function ArtifactHeadingMinimapMount(props: {
  readonly editor: Editor | null;
  readonly node: EpicNodeRef;
  readonly refreshRef: RefObject<() => void>;
  readonly scroller: HTMLElement | null;
}) {
  const side = useSettingsStore((state) => state.chatTurnMinimapSide);
  if (
    props.editor === null ||
    !isEpicArtifactKind(props.node.type) ||
    side === "hide"
  ) {
    return null;
  }
  return (
    <ArtifactHeadingMinimap
      editor={props.editor}
      refreshRef={props.refreshRef}
      scroller={props.scroller}
      side={side}
    />
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

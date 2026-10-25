import {
  useActiveThreadId,
  useCommentThreadsStore,
} from "@/stores/comments/comment-threads-store";
import { Button } from "@/components/ui/button";
import { FrameCommentsToolbar } from "@/components/comments/frame-comments";
import { CommentSidebarPanel } from "@/components/comments/comment-sidebar-panel";
import {
  useLeftPanelStore,
  DEFAULT_LEFT_PANEL_ID,
} from "@/stores/epics/left-panel-store";
import { X } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  queryOptions,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import { MessageSquarePlus } from "lucide-react";
import { useActivateCommentThread } from "@/hooks/comments/use-activate-comment-thread";
import { useFrameCommentThreads } from "@/hooks/comments/use-frame-comment-threads";
import { useFrameCommentsEnabled } from "@/hooks/comments/use-frame-comments-enabled";
import { usePaneFocused } from "@/components/epic-tabs/pane-visibility-context";
import { useAnchorPositionsStore } from "@/stores/comments/anchor-positions-store";
import { registerCommentEditor } from "@/lib/comments/comment-editor-registry";
import { deriveFrameCommentPositions } from "@/lib/comments/frame-comment-positions";
import { openFrameCommentDraft } from "@/lib/comments/open-frame-comment-draft";
import { canvasQueryKeys } from "@/lib/query-keys/canvas-query-keys";
import { FrameCommentPins } from "@/components/comments/frame-comment-pins";
import { cn } from "@/lib/utils";
import { useOrderedFrameThreads } from "@/components/comments/use-ordered-frame-threads";
import { ToolbarActionButton } from "@/editor-core/toolbar/toolbar-action-button";
import type { CanvasAnnotationScope } from "./canvas-annotation-action";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import { useCanvasBoardDocument } from "./use-canvas-board-document";
import { readCanvasBoardDocument } from "./canvas-board-document";
import {
  sameCanvasElement,
  useCanvasSelectionStore,
  type CanvasSelection,
} from "./canvas-selection-store";

export function CanvasCommentAction(props: {
  readonly scope: CanvasAnnotationScope;
  readonly tileId: string;
  readonly selection: CanvasSelection;
  readonly registry: CanvasFrameRegistry;
}) {
  const enabled = useFrameCommentsEnabled();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  if (!enabled) return null;
  return (
    <>
      <ToolbarActionButton
        label="Comment"
        tooltip={null}
        className="tc-editor-toolbar-action"
        icon={<MessageSquarePlus className="size-4" aria-hidden="true" />}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          useCommentThreadsStore
            .getState()
            .setActiveThread(props.scope.epicId, null);
          props.registry.view?.setCommenting(true);
          const entry = props.registry.get(props.selection.boardPath);
          if (entry.bridge === null || entry.frame === null) return;
          void openFrameCommentDraft({
            epicId: props.scope.epicId,
            tileId: props.tileId,
            artifactType: "canvas",
            selection: props.selection,
            bridge: entry.bridge,
            frame: entry.frame,
            source: entry.source,
            queryClient,
            isCurrent: () => {
              const current = useCanvasSelectionStore.getState().selection;
              return (
                props.registry.get(props.selection.boardPath).bridge ===
                  entry.bridge &&
                current?.artifactId === props.selection.artifactId &&
                current.servedSha256 === props.selection.servedSha256 &&
                sameCanvasElement(current.element, props.selection.element)
              );
            },
          })
            .then(setMessage)
            .catch(() =>
              setMessage("The page changed. Select the element again."),
            );
        }}
      />
      {message === null ? null : (
        <span role="status" className="text-ui-xs text-muted-foreground">
          {message}
        </span>
      )}
    </>
  );
}

export function CanvasCommentPins(props: {
  readonly scope: CanvasAnnotationScope;
  readonly boardPath: string;
  readonly registry: CanvasFrameRegistry;
}) {
  const entry = useSyncExternalStore(props.registry.subscribe, () =>
    props.registry.get(props.boardPath),
  );
  const allThreads = useFrameCommentThreads(
    props.scope.epicId,
    props.scope.artifactId,
    "canvas",
  );
  const threads = useMemo(
    () =>
      allThreads?.filter(
        (thread) => thread.data.artboard === props.boardPath,
      ) ?? [],
    [allThreads, props.boardPath],
  );
  const document = useCanvasBoardDocument(
    props.scope.artifactId,
    props.boardPath,
    props.registry,
    threads.length > 0,
  );
  const ordered = useOrderedFrameThreads(
    props.scope.epicId,
    props.scope.artifactId,
    "canvas",
  );
  const activate = useActivateCommentThread({
    ...props.scope,
    artifactType: "canvas",
  });
  const commenting = useSyncExternalStore(
    props.registry.subscribe,
    () => props.registry.view?.commenting === true,
  );
  const activeThreadId = useActiveThreadId(props.scope.epicId);
  const targetId = threads.find((thread) => thread.threadId === activeThreadId)
    ?.data.elementId;
  useEffect(() => {
    const { bridge, sha256, page } = entry;
    if (
      !commenting ||
      targetId === undefined ||
      bridge === null ||
      sha256 === null
    )
      return;
    if (
      useCanvasSelectionStore.getState().selection?.artifactId ===
      props.scope.artifactId
    )
      useCanvasSelectionStore.getState().clear();
    let active = true;
    void bridge
      .revealElement({ tid: targetId })
      .then(() => bridge.describeElement({ tid: targetId }))
      .then((element) => {
        if (!active || element === null) return;
        useCanvasSelectionStore.getState().select({
          artifactId: props.scope.artifactId,
          boardPath: props.boardPath,
          page,
          servedSha256: sha256,
          element,
          textRange: null,
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [commenting, targetId, entry, props.scope.artifactId, props.boardPath]);
  if (!commenting) return null;
  return (
    <FrameCommentPins
      epicId={props.scope.epicId}
      artifactId={props.scope.artifactId}
      artifactType="canvas"
      ordered={ordered ?? []}
      threads={threads}
      source={
        document.data?.sha256 === entry.sha256 ? document.data.text : null
      }
      bridge={entry.bridge}
      frame={entry.frame}
      onActivate={activate}
    />
  );
}

/** The canvas-space pins outside every board, on the page being shown. */
export function CanvasCommentPointPins(props: {
  readonly scope: CanvasAnnotationScope;
  readonly page: string;
  readonly viewport: {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
  };
  readonly registry: CanvasFrameRegistry;
}) {
  const { scope, page, viewport, registry } = props;
  const threads = useFrameCommentThreads(
    scope.epicId,
    scope.artifactId,
    "canvas",
  );
  const ordered = useOrderedFrameThreads(
    scope.epicId,
    scope.artifactId,
    "canvas",
  );
  const activate = useActivateCommentThread({
    ...scope,
    artifactType: "canvas",
  });
  const commenting = useSyncExternalStore(
    registry.subscribe,
    () => registry.view?.commenting === true,
  );
  const activeThreadId = useActiveThreadId(scope.epicId);
  if (!commenting) return null;
  const pins =
    threads?.filter(
      (thread) =>
        thread.data.anchorKind === "canvas-point" &&
        thread.data.page === page &&
        thread.data.x !== undefined &&
        thread.data.y !== undefined &&
        (!thread.resolved || thread.threadId === activeThreadId),
    ) ?? [];
  return (
    <div
      className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
      data-slot="canvas-point-pins"
    >
      {pins.map((thread) => {
        const entry = ordered?.find(
          (candidate) => candidate.thread.threadId === thread.threadId,
        );
        if (
          entry === undefined ||
          thread.data.x === undefined ||
          thread.data.y === undefined
        )
          return null;
        return (
          <button
            key={thread.threadId}
            type="button"
            data-comment-pin={thread.threadId}
            aria-label={`Open comment ${entry.number}`}
            className={cn(
              "canvas-nopan touch-auto pointer-events-auto absolute flex size-6 -translate-x-full items-center justify-center rounded-full border border-primary bg-primary text-xs font-medium text-primary-foreground shadow-sm",
              activeThreadId === thread.threadId &&
                "ring-2 ring-ring ring-offset-2",
            )}
            style={{
              left: thread.data.x * viewport.zoom + viewport.x,
              top: thread.data.y * viewport.zoom + viewport.y,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              activate(thread.threadId);
            }}
          >
            {entry.number}
          </button>
        );
      })}
    </div>
  );
}

/** Includes unloaded boards: virtualization must not make their anchors missing. */
export function CanvasCommentIndex(props: {
  readonly scope: CanvasAnnotationScope;
  readonly tileId: string;
  readonly registry: CanvasFrameRegistry;
}) {
  const { scope, registry, tileId } = props;
  const view = useSyncExternalStore(registry.subscribe, () => registry.view);
  const threads = useFrameCommentThreads(
    scope.epicId,
    scope.artifactId,
    "canvas",
  );
  const focused = usePaneFocused();
  const paths = view?.order ?? [];
  const queries = useQueries({
    queries: paths.map((path) => {
      const source = view?.sourceForBoard(path) ?? null;
      const hash =
        source?.kind === "artifact" &&
        Object.hasOwn(source.manifest.files, source.entryPath)
          ? source.manifest.files[source.entryPath].sha256
          : null;
      return queryOptions({
        queryKey: canvasQueryKeys.source(scope.artifactId, path, hash, source),
        enabled:
          hash !== null &&
          threads?.some((thread) => thread.data.artboard === path) === true,
        staleTime: Infinity,
        retry: false,
        queryFn: ({ signal }: { signal: AbortSignal }) => {
          if (source === null) throw new Error("This artboard is unavailable.");
          return readCanvasBoardDocument(source, signal);
        },
      });
    }),
  });
  const positions = deriveFrameCommentPositions(
    threads ?? [],
    paths.map((path, index) => ({
      path,
      text: queries[index].data?.text ?? null,
    })),
  );
  useEffect(() => {
    if (focused)
      useAnchorPositionsStore
        .getState()
        .setForArtifact(scope.epicId, scope.artifactId, positions);
  }, [focused, scope.epicId, scope.artifactId, positions]);
  useEffect(
    () =>
      registerCommentEditor({
        epicId: scope.epicId,
        artifactId: scope.artifactId,
        tileId,
        isActive: focused,
        reveal: (threadId) => {
          if (!focused) return false;
          const thread = threads?.find(
            (candidate) => candidate.threadId === threadId,
          );
          if (thread === undefined) return false;
          view?.setCommenting(true);
          if (thread.data.anchorKind === "canvas-point") {
            return thread.data.page !== undefined &&
              thread.data.x !== undefined &&
              thread.data.y !== undefined
              ? (view?.revealCanvasPoint(
                  thread.data.page,
                  thread.data.x,
                  thread.data.y,
                ) ?? false)
              : false;
          }
          if (thread.data.artboard === undefined) {
            if (
              useCanvasSelectionStore.getState().selection?.artifactId ===
              scope.artifactId
            )
              useCanvasSelectionStore.getState().clear();
            return true;
          }
          return view?.revealBoard(thread.data.artboard) ?? false;
        },
      }),
    [scope.epicId, scope.artifactId, tileId, focused, threads, view],
  );
  return null;
}

export function CanvasCommentsControl(props: {
  readonly registry: CanvasFrameRegistry;
}) {
  const view = useSyncExternalStore(
    props.registry.subscribe,
    () => props.registry.view,
  );
  return (
    <FrameCommentsToolbar
      active={view?.commenting === true}
      onToggle={() => view?.setCommenting(!view.commenting)}
    />
  );
}

export function CanvasCommentsSidebar(props: {
  readonly scope: CanvasAnnotationScope;
}) {
  const { epicId, artifactId, viewTabId } = props.scope;
  const open = useLeftPanelStore(
    (state) =>
      state.activePanelIdByTabId[viewTabId] === "comments" &&
      !state.mainCollapsedByTabId[viewTabId],
  );
  if (!open) return null;
  return (
    <aside
      aria-label="Comments sidebar"
      className="flex h-full w-1/3 min-w-0 max-w-sm shrink-0 flex-col border-r bg-background"
    >
      <div className="flex shrink-0 items-center justify-between p-2">
        <span className="text-ui-sm font-medium">Comments</span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Close comments"
          onClick={() =>
            useLeftPanelStore
              .getState()
              .setActivePanelId(viewTabId, DEFAULT_LEFT_PANEL_ID)
          }
        >
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <CommentSidebarPanel epicId={epicId} activeArtifactId={artifactId} />
      </div>
    </aside>
  );
}

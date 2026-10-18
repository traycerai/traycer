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
import {
  FrameCommentPins,
  WholeArtifactCommentPin,
} from "@/components/comments/frame-comment-pins";
import { Button } from "@/components/ui/button";
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
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
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
      >
        <MessageSquarePlus />
        Comment
      </Button>
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
  const activate = useActivateCommentThread(props.scope);
  return (
    <FrameCommentPins
      epicId={props.scope.epicId}
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

export function CanvasWholeCommentPin({
  scope,
}: {
  readonly scope: CanvasAnnotationScope;
}) {
  const threads = useFrameCommentThreads(
    scope.epicId,
    scope.artifactId,
    "canvas",
  );
  const activate = useActivateCommentThread(scope);
  return (
    <WholeArtifactCommentPin
      epicId={scope.epicId}
      threads={threads ?? []}
      onActivate={activate}
    />
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
          const thread = threads?.find(
            (candidate) => candidate.threadId === threadId,
          );
          if (thread === undefined) return false;
          if (thread.data.artboard !== undefined)
            registry.view?.revealBoard(thread.data.artboard);
          return true;
        },
      }),
    [scope.epicId, scope.artifactId, tileId, focused, threads, registry],
  );
  return null;
}

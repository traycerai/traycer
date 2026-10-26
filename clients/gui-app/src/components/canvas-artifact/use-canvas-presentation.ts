import { useCallback, useMemo, useState } from "react";
import type { Viewport } from "@xyflow/react";
import type { CanvasLayoutSnapshot } from "@traycer/protocol/persistence/epic/canvas-layout";
import { usePaneFocused } from "@/components/epic-tabs/pane-visibility-context";
import {
  boardFrame,
  selectLiveBoards,
  type CanvasPageItems,
} from "./canvas-model";
import type { CanvasFullscreenSizing } from "./canvas-fullscreen";
import { useCanvasFullscreenSurface } from "./use-canvas-fullscreen-surface";

function currentFullscreen(
  boards: Readonly<Record<string, unknown>>,
  path: string | null,
): string | null {
  return path !== null && Object.hasOwn(boards, path) ? path : null;
}

export function useCanvasPresentation({
  snapshot,
  items,
  boardFiles,
  liveFrameLimit,
  size,
  viewport,
  settledViewport,
  playingBoard,
}: {
  readonly snapshot: CanvasLayoutSnapshot;
  readonly items: CanvasPageItems;
  readonly boardFiles: ReadonlySet<string> | null;
  readonly liveFrameLimit: number;
  readonly size: { readonly width: number; readonly height: number };
  readonly viewport: Viewport;
  readonly settledViewport: Viewport;
  readonly playingBoard: string | null;
}) {
  const [fullscreen, setFullscreen] = useState<string | null>(null);
  const [sizing, setSizing] = useState<CanvasFullscreenSizing>("fit");
  const [recentBoards, setRecentBoards] = useState<readonly string[]>([]);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const paneFocused = usePaneFocused();
  const activeFullscreen = paneFocused
    ? currentFullscreen(snapshot.boards, fullscreen)
    : null;
  const closeFullscreen = useCallback(() => setFullscreen(null), []);
  useCanvasFullscreenSurface(
    surface,
    activeFullscreen !== null,
    closeFullscreen,
  );
  const rememberBoard = useCallback(
    (path: string): void => {
      setRecentBoards((previous) =>
        [path, ...previous.filter((item) => item !== path)].slice(
          0,
          Math.max(1, liveFrameLimit),
        ),
      );
    },
    [liveFrameLimit],
  );
  const liveBoards = useMemo(() => {
    const nearest = selectLiveBoards(
      items,
      {
        x: (size.width / 2 - settledViewport.x) / settledViewport.zoom,
        y: (size.height / 2 - settledViewport.y) / settledViewport.zoom,
      },
      liveFrameLimit,
    );
    // Explicitly visited boards retain their running document in a bounded
    // working set. The remaining slots go to the boards nearest the viewport.
    const candidates = [
      ...(activeFullscreen === null ? [] : [activeFullscreen]),
      // The playing board keeps its running document whatever the camera does.
      ...(playingBoard === null ? [] : [playingBoard]),
      ...recentBoards.slice(0, 1),
      ...[...nearest].slice(0, Math.max(1, Math.floor(liveFrameLimit / 2))),
      ...recentBoards.slice(1),
      ...nearest,
    ].filter(
      (path) =>
        Object.hasOwn(snapshot.boards, path) &&
        (boardFiles === null || boardFiles.has(path)),
    );
    return new Set(
      [...new Set(candidates)].slice(0, Math.max(0, liveFrameLimit)),
    );
  }, [
    items,
    size,
    settledViewport,
    liveFrameLimit,
    activeFullscreen,
    playingBoard,
    recentBoards,
    snapshot.boards,
    boardFiles,
  ]);
  const renderedBoards = useMemo(
    () => [
      ...items.boards,
      ...[...liveBoards]
        .filter((path) => !items.boards.some(([item]) => item === path))
        .map((path) => [path, snapshot.boards[path]] as const),
    ],
    [items.boards, liveBoards, snapshot.boards],
  );
  const fullscreenFrame =
    activeFullscreen === null
      ? null
      : boardFrame(snapshot.boards[activeFullscreen]);
  const fullscreenZoom =
    fullscreenFrame === null
      ? 1
      : Math.max(
          0.01,
          sizing === "fill"
            ? size.width / fullscreenFrame.w
            : Math.min(
                size.width / fullscreenFrame.w,
                size.height / fullscreenFrame.h,
              ),
        );
  const fullscreenHeight =
    fullscreenFrame === null
      ? size.height
      : Math.max(size.height, fullscreenFrame.h * fullscreenZoom);
  const shownViewport =
    fullscreenFrame === null
      ? viewport
      : {
          x:
            (size.width - fullscreenFrame.w * fullscreenZoom) / 2 -
            fullscreenFrame.x * fullscreenZoom,
          y:
            (fullscreenHeight - fullscreenFrame.h * fullscreenZoom) / 2 -
            fullscreenFrame.y * fullscreenZoom,
          zoom: fullscreenZoom,
        };
  const fullscreenView = activeFullscreen !== null;
  const presentation = {
    fullscreen: fullscreenView,
    backgroundClassName: fullscreenView ? "invisible" : undefined,
    height: fullscreenView ? fullscreenHeight : "100%",
    minZoom: fullscreenView ? 0.001 : 0.05,
    maxZoom: fullscreenView ? 100 : 4,
    container: fullscreenView ? surface : null,
    commentContainer: surface,
  };
  return {
    presentation,
    activeFullscreen,
    setFullscreen,
    closeFullscreen,
    sizing,
    setSizing,
    setSurface,
    rememberBoard,
    liveBoards,
    renderedBoards,
    fullscreenHeight,
    shownViewport,
  };
}

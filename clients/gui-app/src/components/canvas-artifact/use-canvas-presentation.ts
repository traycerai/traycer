import { useCallback, useMemo, useState } from "react";
import type { Viewport } from "@xyflow/react";
import type { CanvasLayoutSnapshot } from "@traycer/protocol/persistence/epic/canvas-layout";
import {
  usePaneFocused,
  usePaneVisible,
} from "@/components/epic-tabs/pane-visibility-context";
import {
  adjacentFullscreenBoard,
  boardFrame,
  selectLiveBoards,
  type CanvasPageItems,
} from "./canvas-model";
import { useTabBodySelected } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import { useCanvasBoardMounts } from "./use-canvas-board-mounts";
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
  boardByteLengths,
  liveSlotBudget,
  size,
  viewport,
  settledViewport,
  playingBoard,
}: {
  readonly snapshot: CanvasLayoutSnapshot;
  readonly items: CanvasPageItems;
  readonly boardByteLengths: Readonly<Record<string, number>> | null;
  readonly liveSlotBudget: number;
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
  const paneVisible = usePaneVisible();
  const tabSelected = useTabBodySelected();
  const activeFullscreen =
    paneFocused && tabSelected
      ? currentFullscreen(snapshot.boards, fullscreen)
      : null;
  const closeFullscreen = useCallback(() => setFullscreen(null), []);
  const rememberBoard = useCallback(
    (path: string): void => {
      setRecentBoards((previous) =>
        [path, ...previous.filter((item) => item !== path)].slice(
          0,
          Math.max(1, liveSlotBudget),
        ),
      );
    },
    [liveSlotBudget],
  );
  const stepFullscreen = useCallback(
    (direction: -1 | 1): void => {
      if (activeFullscreen === null) return;
      const target = adjacentFullscreenBoard(
        snapshot,
        activeFullscreen,
        direction,
      );
      if (target === null) return;
      rememberBoard(target);
      setFullscreen(target);
    },
    [activeFullscreen, snapshot, rememberBoard],
  );
  useCanvasFullscreenSurface(
    surface,
    activeFullscreen !== null,
    closeFullscreen,
    stepFullscreen,
  );
  const desiredBoards = useMemo(
    () =>
      selectLiveBoards({
        boards: snapshot.boards,
        pageBoards: items.boards.map(([path]) => path),
        byteLengths: boardByteLengths,
        viewport: {
          x: -settledViewport.x / settledViewport.zoom,
          y: -settledViewport.y / settledViewport.zoom,
          w: size.width / settledViewport.zoom,
          h: size.height / settledViewport.zoom,
        },
        fullscreenBoard: activeFullscreen,
        playingBoard,
        recentBoards,
        slotBudget: liveSlotBudget,
      }),
    [
      items.boards,
      snapshot.boards,
      boardByteLengths,
      size,
      settledViewport,
      activeFullscreen,
      playingBoard,
      recentBoards,
      liveSlotBudget,
    ],
  );
  const { liveBoards, onBoardStatus } = useCanvasBoardMounts(
    desiredBoards,
    paneVisible && tabSelected,
  );
  const renderedBoards = useMemo(
    () => [
      ...items.boards,
      ...[...liveBoards]
        .filter(
          (path) =>
            Object.hasOwn(snapshot.boards, path) &&
            !items.boards.some(([item]) => item === path),
        )
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
    onBoardStatus,
    renderedBoards,
    shownViewport,
  };
}

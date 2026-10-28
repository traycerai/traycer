import type { CanvasPageError } from "@/lib/sandbox/canvas-bridge";
import { resolveCanvasBoardLink } from "./canvas-links";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import {
  Background,
  ReactFlow,
  type NodeChange,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import {
  addPage,
  moveBoardOrder,
  readCanvasLayout,
  removeNote,
  removePage,
  setBoardFrame,
  setBoardMetadata,
  setPageName,
  upsertNote,
  type CanvasNote,
  type CanvasLayoutSnapshot,
} from "@traycer/protocol/persistence/epic/canvas-layout";
import type { Awareness } from "y-protocols/awareness";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import type { CollabUser } from "@/editor-core/awareness/derive-collab-user";
import { getResolvedTheme, subscribeResolvedTheme } from "@/lib/theme-applier";
import { CanvasLayoutStore } from "./canvas-layout-store";
import { useCanvasLayoutState } from "./use-canvas-layout";
import {
  boardFrame,
  canvasPageItems,
  canvasToolForKey,
  CANVAS_INSPECTOR_ENABLED,
  isCanvasTextInput,
  noteDimensions,
  type CanvasPoint,
  type CanvasTool,
} from "./canvas-model";
import {
  CanvasNodeContext,
  type CanvasFlowNode,
  type CanvasNodeActions,
} from "./canvas-node-context";
import { CanvasBoardNode, CanvasNoteNode } from "./canvas-nodes";
import { CanvasPageMenu } from "./canvas-pages";
import { CanvasToolbar, CanvasViewControls } from "./canvas-toolbar";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "./canvas-selection-store";
import { CanvasFullscreen } from "./canvas-fullscreen";
import { useCanvasPresentation } from "./use-canvas-presentation";
import {
  FrameFullscreenContext,
  FrameCommentPortalContext,
} from "@/components/comments/frame-comment-surface-context";
import { cn } from "@/lib/utils";
import { CanvasCursors } from "./canvas-presence";
import { useCanvasPointer } from "./use-canvas-pointer";
import { resizedNote } from "./canvas-geometry";
import { CanvasDrawingLayer } from "./canvas-drawing-layer";
import { CanvasNoteProperties } from "./canvas-note-toolbar";
import type { CanvasFrameEvents } from "./canvas-frame";
import "@xyflow/react/dist/style.css";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

function resolveCanvasPage(
  snapshot: CanvasLayoutSnapshot,
  chosenPage: string | null,
): string {
  return (
    snapshot.pages.find((item) => item.id === chosenPage)?.id ??
    snapshot.pages.at(0)?.id ??
    ""
  );
}
function wheelUnit(mode: number, height: number): number {
  if (mode === 1) return 16;
  if (mode === 2) return height;
  return 1;
}
function canvasPanButtons(
  fullscreen: boolean,
  pan: boolean,
): boolean | number[] {
  if (fullscreen) return false;
  return pan ? true : [1, 2];
}
const NODE_TYPES = {
  board: CanvasBoardNode,
  sticky: CanvasNoteNode,
  title: CanvasNoteNode,
  rect: CanvasNoteNode,
  oval: CanvasNoteNode,
  line: CanvasNoteNode,
  arrow: CanvasNoteNode,
  pen: CanvasNoteNode,
  image: CanvasNoteNode,
};
const INITIAL_VIEW: Viewport = { x: 60, y: 100, zoom: 0.6 };
/** Shapes and placed text come back selected; the pen keeps drawing until Esc. */
const SELECT_AFTER_CREATE: ReadonlySet<string> = new Set([
  "sticky",
  "title",
  "rect",
  "oval",
  "line",
  "arrow",
]);
const TYPE_AFTER_CREATE: ReadonlySet<string> = new Set(["sticky", "title"]);
const PRO_OPTIONS = { hideAttribution: true };
interface NodeInteraction {
  readonly position?: CanvasPoint;
  readonly dimensions?: { width: number; height: number };
  readonly measured?: { width: number; height: number };
  readonly selected?: boolean;
}
export interface CanvasArtifactEditorProps {
  readonly viewOnly?: boolean;
  readonly onAddError?: (path: string, error: CanvasPageError) => void;
  readonly artifactId: string;
  readonly store: CanvasLayoutStore;
  readonly awareness: Awareness | null;
  readonly user: CollabUser;
  readonly sourceForBoard: (path: string) => SandboxSource | null;
  /** The committed manifest's paths; see {@link canvasPageItems}. */
  readonly boardFiles: ReadonlySet<string> | null;
  readonly frameEvents: CanvasFrameEvents | null;
  readonly liveFrameLimit: number;
}
function canvasToolAllowed(
  tool: CanvasTool | null,
  events: CanvasFrameEvents | null,
): tool is CanvasTool {
  return (
    tool !== null && (tool !== "comment" || events?.commentsEnabled === true)
  );
}
// A fullscreen board keeps the armed tool for later but is a play surface
// now: the drawing layer must not mount over it.
function canvasDrawingEnabled(
  readOnly: boolean,
  tool: CanvasTool,
  fullscreenPath: string | null,
): tool is Exclude<CanvasTool, "select" | "hand" | "comment"> {
  return (
    !readOnly &&
    fullscreenPath === null &&
    tool !== "select" &&
    tool !== "hand" &&
    tool !== "comment"
  );
}
function canvasSelectionEnabled(readOnly: boolean, tool: CanvasTool): boolean {
  return !readOnly && tool === "select";
}
function handleCanvasUndo(
  event: KeyboardEvent,
  store: CanvasLayoutStore,
): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.code !== "KeyZ") return false;
  event.preventDefault();
  event.stopPropagation();
  if (event.shiftKey) store.redo();
  else store.undo();
  return true;
}
function notePosition(note: CanvasNote): CanvasPoint {
  return {
    x: Math.min(note.x ?? 0, note.x2 ?? note.x ?? 0),
    y: Math.min(note.y ?? 0, note.y2 ?? note.y ?? 0),
  };
}
function noteKind(note: CanvasNote): string {
  if (note.type === "sticky" || note.type === undefined) return "Note";
  if (note.type === "title") return "Text";
  return "Shape";
}
/** The inspector for a free note or shape; boards and elements use renderPanel. */
function CanvasNoteInspector({
  id,
  note,
  onClose,
}: {
  readonly id: string;
  readonly note: CanvasNote;
  readonly onClose: () => void;
}) {
  const kind = noteKind(note);
  return (
    <aside
      aria-label={`${kind} inspector`}
      className="flex h-full w-full min-w-0 flex-col overflow-y-auto border-l bg-card shadow-sm"
    >
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <h2 className="text-ui-sm font-medium">{kind}</h2>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close inspector"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="p-3">
        <CanvasNoteProperties id={id} note={note} />
      </div>
    </aside>
  );
}
/** The inspector beside the canvas: note properties for one note, else renderPanel. */
function CanvasInspectorOverlay({
  store,
  frameEvents,
  selectedNotes,
  onClose,
}: {
  readonly store: CanvasLayoutStore;
  readonly frameEvents: CanvasFrameEvents | null;
  readonly selectedNotes: readonly CanvasFlowNode[];
  readonly onClose: () => void;
}) {
  const note = selectedNotes.length === 1 ? selectedNotes[0].data : null;
  return (
    <div className="flex h-full w-80 max-w-[45%] shrink-0 [&]:pointer-events-auto">
      {note !== null && note.note !== null ? (
        <CanvasNoteInspector
          id={note.path}
          note={note.note}
          onClose={onClose}
        />
      ) : (
        frameEvents?.renderPanel?.(store, { onClose })
      )}
    </div>
  );
}
/** What the toggle-less inspector follows: the selected element, one note,
 * else the selected board (whose panel holds its size and fit controls). */
function canvasInspectorKey(
  elementSelection: CanvasSelection | null,
  selectedNotes: readonly CanvasFlowNode[],
  selectedBoards: readonly CanvasFlowNode[],
): string | null {
  if (elementSelection !== null) {
    const element = elementSelection.element;
    const identity = element.tid ?? element.marker ?? element.selector;
    return `element:${elementSelection.boardPath}:${identity}`;
  }
  if (selectedNotes.length === 1) return `note:${selectedNotes[0].data.path}`;
  if (selectedBoards.length === 1)
    return `board:${selectedBoards[0].data.path}`;
  return null;
}

function canvasInspectorOpen(
  elementSelection: CanvasSelection | null,
  selectedNotes: readonly CanvasFlowNode[],
  selectedBoards: readonly CanvasFlowNode[],
  dismissedKey: string | null,
): boolean {
  const key = canvasInspectorKey(
    elementSelection,
    selectedNotes,
    selectedBoards,
  );
  return key !== null && key !== dismissedKey;
}

function canvasInteractionMode({
  readOnly,
  commenting,
  spaceHeld,
  tool,
}: {
  readonly readOnly: boolean;
  readonly commenting: boolean;
  readonly spaceHeld: boolean;
  readonly tool: CanvasTool;
}) {
  let activeTool = tool;
  if (spaceHeld) activeTool = "hand";
  if (commenting) activeTool = "comment";
  return {
    activeTool,
    editingDisabled: readOnly || commenting,
    toolsHidden: commenting,
    cursorClassName: commenting ? "cursor-crosshair" : undefined,
  };
}

function canvasCommentSurfaces(
  events: CanvasFrameEvents | null,
  fullscreen: boolean,
  page: string,
  viewport: Viewport,
) {
  return {
    draft: events?.renderCommentDraft?.(),
    // Point pins live outside every board, so a fullscreen board shows none.
    pointPins: fullscreen ? null : events?.renderCanvasPins?.(page, viewport),
  };
}

export function CanvasArtifactEditor({
  artifactId,
  store,
  awareness,
  user,
  sourceForBoard,
  boardFiles,
  frameEvents,
  liveFrameLimit,
  viewOnly,
  onAddError,
}: CanvasArtifactEditorProps) {
  const readOnly = viewOnly === true;
  const activeStore = useRef<CanvasLayoutStore | null>(null);
  useLayoutEffect(() => {
    activeStore.current = store;
    return () => {
      activeStore.current = null;
    };
  }, [store]);
  const state = useCanvasLayoutState(store);
  const snapshot = state.layout;
  const [chosenPage, setChosenPage] = useState<string | null>(null);
  const page = resolveCanvasPage(snapshot, chosenPage);
  const [tool, setTool] = useState<CanvasTool>("select");
  // One board plays in place at a time. The state is ephemeral by design:
  // never persisted or synced, and a page switch or reload stops it.
  const [playingBoard, setPlayingBoard] = useState<string | null>(null);
  const [commenting, setCommenting] = useState(false);
  const [pageErrors, setPageErrors] = useState<
    Readonly<Record<string, CanvasPageError | null | undefined>>
  >({});
  // The inspector has no toolbar toggle: it opens beside the canvas while an
  // in-board element or a single free note is selected, and closing it keeps
  // it closed until the selection moves to a different target.
  const [dismissedInspectorKey, setDismissedInspectorKey] = useState<
    string | null
  >(null);
  const elementSelection = useCanvasSelectionStore((state) =>
    state.selection?.artifactId === artifactId ? state.selection : null,
  );
  // Holding Space pans from any tool, as in design tools, without changing it.
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [navigation, setNavigation] = useState<CanvasNodeActions["navigation"]>(
    {},
  );
  const [flow, setFlow] = useState<ReactFlowInstance<CanvasFlowNode> | null>(
    null,
  );
  const [viewport, setViewport] = useState(INITIAL_VIEW);
  const [settledViewport, setSettledViewport] = useState(INITIAL_VIEW);
  const [interactions, setInteractions] = useState<
    Readonly<Record<string, NodeInteraction | undefined>>
  >({});
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const theme = useSyncExternalStore(
    subscribeResolvedTheme,
    getResolvedTheme,
    getResolvedTheme,
  );
  const pointer = useCanvasPointer(awareness, artifactId, page, user);
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const measure = (): void =>
      setSize({ width: stage.clientWidth, height: stage.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    measure();
    return () => observer.disconnect();
  }, []);
  const items = useMemo(
    () => canvasPageItems(snapshot, page, boardFiles),
    [snapshot, page, boardFiles],
  );
  const {
    presentation,
    activeFullscreen,
    setFullscreen,
    closeFullscreen,
    setSurface,
    sizing,
    setSizing,
    rememberBoard,
    liveBoards,
    renderedBoards,
    shownViewport,
  } = useCanvasPresentation({
    snapshot,
    items,
    boardFiles,
    liveFrameLimit,
    size,
    viewport,
    settledViewport,
    playingBoard,
  });
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    stage.scrollTop = 0;
    stage.scrollLeft = 0;
  }, [activeFullscreen, sizing]);
  const { activeTool, editingDisabled, toolsHidden, cursorClassName } = useMemo(
    () => canvasInteractionMode({ readOnly, commenting, spaceHeld, tool }),
    [readOnly, commenting, spaceHeld, tool],
  );
  const commentSurfaces = canvasCommentSurfaces(
    frameEvents,
    presentation.fullscreen,
    page,
    viewport,
  );
  const selectEnabled = canvasSelectionEnabled(readOnly, activeTool);
  const nodes = useMemo<CanvasFlowNode[]>(
    () => [
      ...renderedBoards.map(([path, board], index): CanvasFlowNode => {
        const id = `board:${path}`;
        const frame = boardFrame(board);
        const local = interactions[id];
        return {
          id,
          type: "board",
          position: local?.position ?? { x: frame.x, y: frame.y },
          width: local?.dimensions?.width ?? frame.w,
          height: local?.dimensions?.height ?? frame.h,
          measured: local?.measured,
          selected: !editingDisabled && (local?.selected ?? false),
          dragHandle: "[data-canvas-board-handle]",
          // Board removal belongs to the host file-write path; removing only
          // its map entry would be immediately undone by layout repair.
          deletable: false,
          zIndex: index,
          style: {
            visibility: (
              activeFullscreen !== null
                ? path !== activeFullscreen
                : !items.boards.some(([item]) => item === path)
            )
              ? "hidden"
              : "visible",
          },
          data: {
            path,
            board,
            note: null,
            live: liveBoards.has(path),
            play: playingBoard === path,
          },
        };
      }),
      ...items.notes.map(([path, note]): CanvasFlowNode => {
        const id = `note:${path}`;
        const local = interactions[id];
        const dimensions = noteDimensions(note);
        return {
          id,
          type: note.type ?? "sticky",
          position: local?.position ?? notePosition(note),
          width: local?.dimensions?.width ?? dimensions.width,
          height: local?.dimensions?.height ?? dimensions.height,
          measured: local?.measured,
          selected: !editingDisabled && (local?.selected ?? false),
          zIndex: items.boards.length + 1,
          style: {
            visibility: activeFullscreen === null ? "visible" : "hidden",
          },
          data: { path, board: null, note, live: false, play: false },
        };
      }),
    ],
    [
      items,
      renderedBoards,
      interactions,
      liveBoards,
      editingDisabled,
      playingBoard,
      activeFullscreen,
    ],
  );
  const changeNodes = useCallback(
    (changes: NodeChange<CanvasFlowNode>[]): void => {
      setInteractions((previous) => {
        const next = { ...previous };
        for (const change of changes) {
          if (change.type === "select")
            next[change.id] = { ...next[change.id], selected: change.selected };
          // Resize positions have no dragging flag. Keep them until the resize
          // commits; measurement-only dimensions must not clear that origin.
          if (change.type === "position" && change.position !== undefined)
            next[change.id] = {
              ...next[change.id],
              position: change.dragging === false ? undefined : change.position,
            };
          // XYResizer reads measured, not width/height. Controlled nodes must
          // retain observations even when the change is not an active resize.
          if (change.type === "dimensions" && change.dimensions !== undefined)
            next[change.id] = {
              ...next[change.id],
              measured: change.dimensions,
            };
          if (change.type === "dimensions" && change.resizing === true)
            next[change.id] = {
              ...next[change.id],
              dimensions: change.dimensions,
            };
          if (change.type === "dimensions" && change.resizing === false)
            next[change.id] = {
              ...next[change.id],
              position: undefined,
              dimensions: undefined,
            };
        }
        return next;
      });
    },
    [],
  );
  const toCanvas = useCallback(
    (point: CanvasPoint): CanvasPoint =>
      flow?.screenToFlowPosition(point) ?? point,
    [flow],
  );
  const centerBoard = useCallback(
    (path: string): void => {
      const board = snapshot.boards[path];
      if (!Object.hasOwn(snapshot.boards, path)) return;
      const boardPage = board.page ?? snapshot.pages.at(0)?.id ?? "";
      setChosenPage(boardPage);
      const frame = boardFrame(board);
      // A move on the current page glides so the eye can follow it; a page
      // switch remounts the boards, so there is nothing to animate through.
      void flow?.setCenter(frame.x + frame.w / 2, frame.y + frame.h / 2, {
        zoom: Math.min(1, viewport.zoom),
        duration: boardPage === page ? 300 : 0,
      });
    },
    [snapshot, flow, viewport.zoom, page],
  );
  const stopPlay = useCallback((): void => {
    if (playingBoard === null) return;
    setPlayingBoard(null);
    // Clearing the entry resets a board the played document navigated away
    // from; its frame remounts its own source.
    setNavigation((previous) => {
      if (previous[playingBoard] === undefined) return previous;
      const next = { ...previous };
      delete next[playingBoard];
      return next;
    });
  }, [playingBoard]);
  const revealCanvasPoint = useCallback(
    (pageId: string, x: number, y: number): boolean => {
      // A vanished page keeps the sidebar thread where it is: no silent
      // relocation to another page.
      if (flow === null || !snapshot.pages.some((item) => item.id === pageId))
        return false;
      // A page switch stops play, here as everywhere.
      if (pageId !== page) stopPlay();
      // Point pins live outside every board, so a fullscreen board cannot
      // show one: leave fullscreen before revealing the spot.
      setChosenPage(pageId);
      const zoom = Math.min(1, viewport.zoom);
      if (activeFullscreen !== null) {
        closeFullscreen();
        // While fullscreen, onMove ignores the flow's viewport events, so
        // setCenter would be snapped back by the controlled viewport on the
        // next render. Write the centered viewport through the controlled
        // state instead, batched with the close.
        const centered = {
          x: size.width / 2 - x * zoom,
          y: size.height / 2 - y * zoom,
          zoom,
        };
        setViewport(centered);
        setSettledViewport(centered);
        return true;
      }
      void flow.setCenter(x, y, { zoom, duration: 200 });
      return true;
    },
    [
      flow,
      snapshot.pages,
      page,
      stopPlay,
      viewport.zoom,
      size,
      activeFullscreen,
      closeFullscreen,
    ],
  );
  const revealCommentBoard = useCallback(
    (path: string): boolean => {
      if (flow === null || !Object.hasOwn(snapshot.boards, path)) return false;
      const board = snapshot.boards[path];
      rememberBoard(path);
      if (activeFullscreen !== null) {
        setFullscreen(path);
        return true;
      }
      const boardPage = board.page ?? snapshot.pages.at(0)?.id ?? "";
      // A page switch stops play, here as everywhere.
      if (boardPage !== page) stopPlay();
      setChosenPage(boardPage);
      const frame = boardFrame(board);
      void flow.fitBounds(
        { x: frame.x, y: frame.y, width: frame.w, height: frame.h },
        { padding: 0.15, duration: 200 },
      );
      return true;
    },
    [
      snapshot.boards,
      snapshot.pages,
      page,
      stopPlay,
      flow,
      rememberBoard,
      activeFullscreen,
      setFullscreen,
    ],
  );
  const clearNodeSelection = useCallback((): void => {
    setEditingNote(null);
    setInteractions((previous) => {
      const next: Record<string, NodeInteraction | undefined> = {};
      for (const [key, value] of Object.entries(previous))
        next[key] = value === undefined ? value : { ...value, selected: false };
      return next;
    });
  }, []);
  // Deliberately no camera move: Play applies to the board where it lies,
  // and the person keeps the viewport they had. Playing another board stops
  // the first — one board plays at a time.
  const startPlay = useCallback(
    (path: string): void => {
      clearNodeSelection();
      frameEvents?.onBoardSelect?.(null);
      // Switching play stops the outgoing board like its stop button would:
      // clearing its navigation entry remounts its own source.
      const outgoing = playingBoard;
      if (outgoing !== null && outgoing !== path)
        setNavigation((entries) => {
          if (entries[outgoing] === undefined) return entries;
          const next = { ...entries };
          delete next[outgoing];
          return next;
        });
      setPlayingBoard(path);
      setCommenting(false);
      setSpaceHeld(false);
      rememberBoard(path);
    },
    [clearNodeSelection, frameEvents, playingBoard, rememberBoard],
  );
  // Fullscreen is orthogonal to in-place play: it is its own play surface and
  // leaving it changes nothing on the canvas.
  const openFullscreen = useCallback(
    (path: string): void => {
      clearNodeSelection();
      frameEvents?.onBoardSelect?.(null);
      setSpaceHeld(false);
      rememberBoard(path);
      setFullscreen(path);
    },
    [clearNodeSelection, frameEvents, rememberBoard, setFullscreen],
  );
  useEffect(() => {
    frameEvents?.onCanvasView?.({
      tool: commenting ? "comment" : tool,
      // Only fullscreen covers the canvas; an in-place playing board leaves
      // the rest of the page editable, pasting included.
      play: activeFullscreen !== null,
      commenting,
      setCommenting,
      order: snapshot.order,
      sourceForBoard,
      revealBoard: revealCommentBoard,
      revealCanvasPoint,
      clearNodeSelection,
    });
    return () => frameEvents?.onCanvasView?.(null);
  }, [
    frameEvents,
    tool,
    activeFullscreen,
    commenting,
    readOnly,
    snapshot.order,
    sourceForBoard,
    revealCommentBoard,
    revealCanvasPoint,
    clearNodeSelection,
  ]);
  const zoomAt = useCallback(
    (delta: number, point: CanvasPoint): void => {
      const stage = stageRef.current;
      if (activeFullscreen !== null || flow === null || stage === null) return;
      const bounds = stage.getBoundingClientRect();
      const current = flow.getViewport();
      const zoom = Math.min(
        4,
        Math.max(
          0.05,
          current.zoom *
            Math.exp(-Math.max(-240, Math.min(240, delta)) * 0.003),
        ),
      );
      const ratio = zoom / current.zoom;
      const x = point.x - bounds.left;
      const y = point.y - bounds.top;
      void flow.setViewport({
        x: x - (x - current.x) * ratio,
        y: y - (y - current.y) * ratio,
        zoom,
      });
    },
    [activeFullscreen, flow],
  );
  // Wheel panning is our own handler, not xyflow's panOnScroll: each event's
  // delta is capped so momentum tails cannot sling the canvas, while the
  // uncapped per-pixel gain stays 1. One feel everywhere — the same path takes
  // the playing board's forwarded fall-through gestures.
  const settleTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (settleTimer.current !== null)
        window.clearTimeout(settleTimer.current);
    },
    [],
  );
  const panBy = useCallback(
    (dx: number, dy: number): void => {
      // A fullscreen board's fall-through gesture scrolls the stage that
      // holds it (Fill width overflows there), uncapped like native scroll.
      if (activeFullscreen !== null) {
        stageRef.current?.scrollBy({ left: dx, top: dy, behavior: "instant" });
        return;
      }
      if (flow === null) return;
      const cap = (delta: number): number =>
        Math.sign(delta) * Math.min(Math.abs(delta), 80);
      const current = flow.getViewport();
      const next = {
        x: current.x - cap(dx),
        y: current.y - cap(dy),
        zoom: current.zoom,
      };
      void flow.setViewport(next);
      setViewport(next);
      if (settleTimer.current !== null)
        window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => {
        settleTimer.current = null;
        setSettledViewport(flow.getViewport());
      }, 200);
    },
    [flow, activeFullscreen],
  );
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const wheel = (event: WheelEvent): void => {
      const unit = wheelUnit(event.deltaMode, stage.clientHeight);
      if (event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        zoomAt(event.deltaY * unit, { x: event.clientX, y: event.clientY });
        return;
      }
      if (activeFullscreen !== null) return;
      // The playing board's document takes its own wheel; what it cannot
      // scroll by comes back through the bridge as a pan.
      if (
        event.target instanceof Element &&
        event.target.closest(".canvas-nowheel") !== null
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      // Shift turns a mouse's vertical wheel into a horizontal pan.
      if (event.shiftKey && dx === 0) panBy(dy, 0);
      else panBy(dx, dy);
    };
    stage.addEventListener("wheel", wheel, { passive: false, capture: true });
    return () => stage.removeEventListener("wheel", wheel, true);
  }, [zoomAt, panBy, activeFullscreen]);
  const boardEvents = useMemo<CanvasFrameEvents>(
    () => ({
      ...frameEvents,
      onZoom: zoomAt,
      onPan: (gesture) => panBy(gesture.dx, gesture.dy),
      onPageError: (path, error) => {
        setPageErrors((previous) => ({ ...previous, [path]: error }));
        frameEvents?.onPageError?.(path, error);
      },
      onBridge: (path, bridge) => {
        setPageErrors((previous) =>
          previous[path] === null || previous[path] === undefined
            ? previous
            : { ...previous, [path]: null },
        );
        if (bridge !== null && Object.hasOwn(snapshot.boards, path))
          frameEvents?.onBoardPage?.(
            path,
            snapshot.boards[path].page ?? snapshot.pages.at(0)?.id ?? null,
          );
        frameEvents?.onBridge(path, bridge);
      },
      onStatus: (path, status) => frameEvents?.onStatus(path, status),
      onEditPointer: (path, point) => {
        if (!readOnly) frameEvents?.onEditPointer(path, point);
      },
      onAddError: (path, error) => {
        if (readOnly) return;
        onAddError?.(path, error);
        frameEvents?.onAddError?.(path, error);
      },
      onRelativeLink: (path, href) => {
        const target = resolveCanvasBoardLink(
          path,
          href,
          Object.keys(snapshot.boards),
        );
        if (target !== null) {
          rememberBoard(target.path);
          const hop = playingBoard === path && target.path !== path;
          setNavigation((previous) => {
            const next = {
              ...previous,
              [target.path]: {
                search: target.search,
                hash: target.hash,
                visit: (previous[target.path]?.visit ?? 0) + 1,
              },
            };
            // Play leaving the source board resets it, like a stop would.
            if (hop) delete next[path];
            return next;
          });
          if (activeFullscreen !== null) setFullscreen(target.path);
          else if (hop) {
            // A link hop moves play to the target and reveals it once; a
            // same-board link navigates inside the frame with no camera move.
            setPlayingBoard(target.path);
            centerBoard(target.path);
          }
        }
        frameEvents?.onRelativeLink?.(path, href);
      },
    }),
    [
      frameEvents,
      readOnly,
      onAddError,
      snapshot.boards,
      snapshot.pages,
      activeFullscreen,
      playingBoard,
      centerBoard,
      rememberBoard,
      zoomAt,
      panBy,
      setFullscreen,
    ],
  );
  const actions = useMemo<CanvasNodeActions>(
    () => ({
      sourceForBoard,
      viewOnly: readOnly || commenting,
      selectionEnabled:
        selectEnabled ||
        (!readOnly &&
          activeTool === "comment" &&
          frameEvents?.commentsEnabled === true),
      commentMode:
        activeTool === "comment" && frameEvents?.commentsEnabled === true,
      panMode: activeTool === "hand" && !readOnly,
      onAddError: (path, error) => {
        if (readOnly) return;
        onAddError?.(path, error);
        frameEvents?.onAddError?.(path, error);
      },
      frameEvents: boardEvents,
      fullscreen: openFullscreen,
      fullscreenPath: activeFullscreen,
      startPlay,
      stopPlay,
      playingBoard,
      navigation,
      renameBoard: (path, title) =>
        store.transact((layout) =>
          setBoardMetadata(layout, path, {
            title,
            is_interactive: undefined,
            radius: undefined,
          }),
        ),
      setNoteText: (id, text) => {
        if (
          Object.hasOwn(snapshot.notes, id) &&
          snapshot.notes[id].text !== text
        )
          store.transact((layout) => upsertNote(layout, id, { text }));
      },
      updateNote: (id, patch) => {
        if (Object.hasOwn(snapshot.notes, id))
          store.transact((layout) => upsertNote(layout, id, patch));
      },
      editingNote: commenting ? null : editingNote,
      setEditingNote,
      fitBoardHeight: (path, height) => {
        // Only a board the agent left without a height is fitted, once: the
        // write gives it one, so later content changes never resize it.
        // Read the live document, not this render's snapshot: a resize or a
        // peer's edit may already have given the board a height.
        if (readOnly || activeStore.current !== store || store.doc.isDestroyed)
          return;
        const current = readCanvasLayout(store.handle);
        if (
          !Object.hasOwn(current.boards, path) ||
          current.boards[path].h !== undefined
        )
          return;
        const frame = boardFrame(current.boards[path]);
        store.transact((layout) =>
          setBoardFrame(layout, path, { ...frame, h: Math.round(height) }),
        );
      },
      resize: (id, frame) => {
        // XYResizer may deliver the gesture-start callback after a replacement
        // document or remote edit. Commit only to this view's live document.
        if (activeStore.current !== store || store.doc.isDestroyed) return;
        const current = readCanvasLayout(store.handle);
        if (id.startsWith("board:")) {
          const path = id.slice(6);
          if (Object.hasOwn(current.boards, path))
            store.transact((layout) =>
              setBoardFrame(layout, path, {
                x: frame.x,
                y: frame.y,
                w: frame.width,
                h: frame.height,
              }),
            );
        } else {
          const path = id.slice(5);
          if (Object.hasOwn(current.notes, path))
            store.transact((layout) =>
              upsertNote(layout, path, resizedNote(current.notes[path], frame)),
            );
        }
        setInteractions((previous) => ({
          ...previous,
          [id]: { ...previous[id], position: undefined, dimensions: undefined },
        }));
      },
    }),
    [
      sourceForBoard,
      selectEnabled,
      activeTool,
      frameEvents,
      boardEvents,
      readOnly,
      onAddError,
      store,
      snapshot,
      editingNote,
      commenting,
      openFullscreen,
      activeFullscreen,
      startPlay,
      stopPlay,
      playingBoard,
      navigation,
    ],
  );
  const setPage = (id: string): void => {
    pointer.clear();
    stopPlay();
    setChosenPage(id);
    setInteractions({});
  };
  const moveOrder = (path: string, before: string | null): void =>
    store.transact((layout) => moveBoardOrder(layout, path, before));
  // Arming a tool never stops play; only the stop icon, Escape with nothing
  // more local to do, a play elsewhere, a link hop or a page switch does.
  const chooseTool = (next: CanvasTool): void => {
    setCommenting(next === "comment");
    if (next !== "comment") setTool(next);
  };
  const createNote = (note: CanvasNote): void => {
    const id = crypto.randomUUID();
    store.transact((layout) => upsertNote(layout, id, { ...note, page }));
    if (!SELECT_AFTER_CREATE.has(note.type ?? "sticky")) return;
    // The new item replaces whatever was selected, so the inspector and the
    // note bar describe it rather than the board picked before.
    frameEvents?.onBoardSelect?.(null);
    clearNodeSelection();
    setInteractions((previous) => ({
      ...previous,
      [`note:${id}`]: { selected: true },
    }));
    if (TYPE_AFTER_CREATE.has(note.type ?? "sticky")) setEditingNote(id);
    setTool("select");
  };
  const selectedNotes = nodes.filter(
    (node) => node.selected && node.data.note !== null,
  );
  const selectedBoards = nodes.filter(
    (node) => node.selected && node.data.board !== null,
  );
  const inspectorOpen = canvasInspectorOpen(
    elementSelection,
    selectedNotes,
    selectedBoards,
    dismissedInspectorKey,
  );
  const deleteSelectedNotes = (event: KeyboardEvent): void => {
    if (selectedNotes.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    store.transact((layout) => {
      for (const node of selectedNotes) removeNote(layout, node.data.path);
    });
  };
  // Most-local first: an armed tool disarms, then the selection steps out
  // (element, then board — the selection provider handles that further
  // along, so the event is let through), and only an Escape with nothing
  // closer to undo stops the playing board.
  const escapeCanvas = (event: KeyboardEvent): void => {
    if (!readOnly && tool !== "select") {
      chooseTool("select");
      return;
    }
    const selectionHeld =
      elementSelection !== null || nodes.some((node) => node.selected);
    if (!selectionHeld && playingBoard !== null) {
      event.preventDefault();
      event.stopPropagation();
      stopPlay();
    }
  };
  const chooseToolForKey = (event: KeyboardEvent): void => {
    const next = canvasToolForKey(
      event.code.startsWith("Key") ? event.code.slice(3) : event.code,
    );
    if (!canvasToolAllowed(next, frameEvents)) return;
    event.preventDefault();
    event.stopPropagation();
    chooseTool(next);
  };
  return (
    <CanvasNodeContext.Provider value={actions}>
      <FrameFullscreenContext.Provider value={presentation.container}>
        <FrameCommentPortalContext.Provider
          value={presentation.commentContainer}
        >
          <div
            ref={setSurface}
            data-canvas-fullscreen={presentation.fullscreen || undefined}
            role="application"
            tabIndex={-1}
            aria-label="Canvas"
            className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-canvas text-foreground outline-none"
            onPointerDownCapture={(event) => {
              if (!isCanvasTextInput(event.target, event.currentTarget))
                event.currentTarget.focus({ preventScroll: true });
            }}
            onKeyUpCapture={(event) => {
              if (event.code === "Space") setSpaceHeld(false);
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                setSpaceHeld(false);
            }}
            onKeyDownCapture={(event) => {
              if (activeFullscreen !== null || commenting) return;
              if (isCanvasTextInput(event.target, event.currentTarget)) return;
              if (event.code === "Escape") {
                escapeCanvas(event);
                return;
              }
              if (readOnly) return;
              if (event.code === "Space") {
                event.preventDefault();
                setSpaceHeld(true);
                return;
              }
              if (handleCanvasUndo(event, store)) return;
              if (event.metaKey || event.ctrlKey || event.altKey) return;
              if (event.code === "Delete" || event.code === "Backspace") {
                deleteSelectedNotes(event);
                return;
              }
              chooseToolForKey(event);
            }}
          >
            {commentSurfaces.draft}
            <CanvasFullscreen
              path={activeFullscreen}
              snapshot={snapshot}
              errors={pageErrors}
              events={boardEvents}
              viewOnly={readOnly}
              sizing={sizing}
              onSizing={setSizing}
              onSelect={openFullscreen}
              onClose={closeFullscreen}
              container={presentation.container}
            />
            <div className="flex min-h-0 flex-1">
              <div
                ref={stageRef}
                className={cn(
                  "relative min-h-0 min-w-0 flex-1",
                  cursorClassName,
                  activeFullscreen !== null && "overflow-auto",
                )}
                onPointerMove={(event) =>
                  pointer.publish(
                    toCanvas({ x: event.clientX, y: event.clientY }),
                  )
                }
                onPointerLeave={pointer.clear}
              >
                <div
                  className="w-full"
                  style={{
                    height: presentation.height,
                  }}
                >
                  <ReactFlow<CanvasFlowNode>
                    nodes={nodes}
                    edges={[]}
                    nodeTypes={NODE_TYPES}
                    onNodesChange={changeNodes}
                    onNodeClick={(_event, node) => {
                      if (!readOnly && node.data.board !== null)
                        frameEvents?.onBoardSelect?.(node.data.path);
                    }}
                    onPaneClick={(event) => {
                      if (readOnly) return;
                      if (
                        activeTool === "comment" &&
                        frameEvents?.commentsEnabled === true
                      )
                        frameEvents.onPaneComment?.({
                          screen: { x: event.clientX, y: event.clientY },
                          canvas: toCanvas({
                            x: event.clientX,
                            y: event.clientY,
                          }),
                          page,
                        });
                      else if (activeTool === "select") {
                        frameEvents?.onBoardSelect?.(null);
                        clearNodeSelection();
                      }
                    }}
                    onInit={setFlow}
                    viewport={shownViewport}
                    minZoom={presentation.minZoom}
                    maxZoom={presentation.maxZoom}
                    colorMode={theme}
                    proOptions={PRO_OPTIONS}
                    noDragClassName="touch-auto"
                    noPanClassName="canvas-nopan"
                    noWheelClassName="canvas-nowheel"
                    nodesConnectable={false}
                    nodesDraggable={selectEnabled}
                    elementsSelectable={selectEnabled}
                    selectionOnDrag={selectEnabled}
                    panOnDrag={canvasPanButtons(
                      activeFullscreen !== null,
                      !commenting && (readOnly || activeTool === "hand"),
                    )}
                    panOnScroll={false}
                    preventScrolling={!presentation.fullscreen}
                    zoomOnPinch={!presentation.fullscreen}
                    zoomActivationKeyCode={null}
                    zoomOnScroll={false}
                    zoomOnDoubleClick={false}
                    deleteKeyCode={null}
                    onMove={(_event, value) => {
                      if (activeFullscreen === null) setViewport(value);
                    }}
                    onMoveEnd={(_event, value) => {
                      if (activeFullscreen !== null) return;
                      setViewport(value);
                      setSettledViewport(value);
                    }}
                    onNodeDragStop={(_event, node, dragged) =>
                      !readOnly &&
                      store.transact((layout) => {
                        for (const moved of dragged.length === 0
                          ? [node]
                          : dragged) {
                          if (
                            moved.data.board !== null &&
                            Object.hasOwn(snapshot.boards, moved.data.path)
                          ) {
                            const frame = boardFrame(
                              snapshot.boards[moved.data.path],
                            );
                            setBoardFrame(layout, moved.data.path, {
                              ...frame,
                              x: moved.position.x,
                              y: moved.position.y,
                            });
                          } else if (
                            moved.data.note !== null &&
                            Object.hasOwn(snapshot.notes, moved.data.path)
                          ) {
                            const note = snapshot.notes[moved.data.path];
                            const old = notePosition(note);
                            const dx = moved.position.x - old.x,
                              dy = moved.position.y - old.y;
                            upsertNote(layout, moved.data.path, {
                              x: (note.x ?? 0) + dx,
                              y: (note.y ?? 0) + dy,
                              ...(note.x2 === undefined
                                ? {}
                                : { x2: note.x2 + dx }),
                              ...(note.y2 === undefined
                                ? {}
                                : { y2: note.y2 + dy }),
                            });
                          }
                        }
                      })
                    }
                    aria-label="Canvas workspace"
                  >
                    <Background
                      color="var(--border)"
                      className={presentation.backgroundClassName}
                    />
                  </ReactFlow>
                </div>
                {canvasDrawingEnabled(
                  readOnly,
                  activeTool,
                  activeFullscreen,
                ) ? (
                  <CanvasDrawingLayer
                    key={activeTool}
                    tool={activeTool}
                    viewport={viewport}
                    toCanvas={toCanvas}
                    onCreate={createNote}
                  />
                ) : null}
                {presentation.fullscreen ? null : (
                  <>
                    <CanvasCursors
                      awareness={awareness}
                      artifactId={artifactId}
                      page={page}
                      viewport={viewport}
                    />
                    {commentSurfaces.pointPins}
                  </>
                )}
                {activeFullscreen === null ? (
                  <div className="pointer-events-none absolute inset-0 flex">
                    <div className="flex min-w-0 flex-1 items-start justify-between gap-2 p-2">
                      <div className="min-w-0 [&]:pointer-events-auto">
                        {toolsHidden ? null : (
                          <CanvasToolbar
                            viewOnly={readOnly}
                            commentsEnabled={
                              frameEvents?.commentsEnabled === true
                            }
                            tool={tool}
                            onTool={chooseTool}
                            pages={
                              <CanvasPageMenu
                                viewOnly={readOnly}
                                pages={snapshot.pages}
                                page={page}
                                boards={items.boards}
                                onSelect={setPage}
                                onRename={(id, name) =>
                                  store.transact((layout) =>
                                    setPageName(layout, id, name),
                                  )
                                }
                                onAdd={() => {
                                  const id = crypto.randomUUID();
                                  store.transact((layout) =>
                                    addPage(
                                      layout,
                                      id,
                                      `Page ${snapshot.pages.length + 1}`,
                                      null,
                                    ),
                                  );
                                  setPage(id);
                                }}
                                onRemove={(id) =>
                                  store.transact((layout) =>
                                    removePage(layout, id),
                                  )
                                }
                                onCenterBoard={centerBoard}
                                onMoveBoard={moveOrder}
                              />
                            }
                          />
                        )}
                      </div>
                      <div className="shrink-0 [&]:pointer-events-auto">
                        <CanvasViewControls
                          viewOnly={readOnly}
                          commenting={commenting}
                          trailing={frameEvents?.renderToolbarControls?.()}
                          undo={store.undo}
                          redo={store.redo}
                          canUndo={state.canUndo}
                          canRedo={state.canRedo}
                          zoom={{
                            ready: flow !== null,
                            percent: Math.round(viewport.zoom * 100),
                            canZoomIn: viewport.zoom < 4,
                            canZoomOut: viewport.zoom > 0.05,
                            onZoomIn: () => {
                              void flow?.zoomIn();
                            },
                            onZoomOut: () => {
                              void flow?.zoomOut();
                            },
                            onFit: () => {
                              void flow?.fitView({
                                nodes: [
                                  ...items.boards.map(([path]) => ({
                                    id: `board:${path}`,
                                  })),
                                  ...items.notes.map(([path]) => ({
                                    id: `note:${path}`,
                                  })),
                                ],
                                padding: 0.15,
                                duration: 200,
                              });
                            },
                            onZoom: (zoom) => {
                              void flow?.zoomTo(zoom);
                            },
                          }}
                        />
                      </div>
                    </div>
                    {!CANVAS_INSPECTOR_ENABLED ||
                    editingDisabled ||
                    !inspectorOpen ? null : (
                      <CanvasInspectorOverlay
                        store={store}
                        frameEvents={frameEvents}
                        selectedNotes={selectedNotes}
                        onClose={() =>
                          setDismissedInspectorKey(
                            canvasInspectorKey(
                              elementSelection,
                              selectedNotes,
                              selectedBoards,
                            ),
                          )
                        }
                      />
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </FrameCommentPortalContext.Provider>
      </FrameFullscreenContext.Provider>
    </CanvasNodeContext.Provider>
  );
}

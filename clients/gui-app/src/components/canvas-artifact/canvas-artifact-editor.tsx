import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Background,
  MiniMap,
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
  isCanvasTextInput,
  noteDimensions,
  selectLiveBoards,
  type CanvasPoint,
  type CanvasTool,
} from "./canvas-model";
import {
  CanvasNodeContext,
  type CanvasFlowNode,
  type CanvasNodeActions,
} from "./canvas-node-context";
import { CanvasBoardNode, CanvasNoteNode } from "./canvas-nodes";
import { CanvasPages } from "./canvas-pages";
import { CanvasToolbar } from "./canvas-toolbar";
import { CanvasReadingOrder } from "./canvas-reading-order";
import { CanvasFullscreen } from "./canvas-fullscreen";
import { CanvasCursors } from "./canvas-presence";
import { useCanvasPointer } from "./use-canvas-pointer";
import { resizedNote } from "./canvas-geometry";
import { CanvasDrawingLayer } from "./canvas-drawing-layer";
import type { CanvasFrameEvents } from "./canvas-frame";
import "@xyflow/react/dist/style.css";

const MINIMAP_COLORS: Readonly<Record<string, string>> = {
  board: "var(--primary)",
  sticky: "var(--warning)",
  title: "var(--info)",
};
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
const PRO_OPTIONS = { hideAttribution: true };
interface NodeInteraction {
  readonly position?: CanvasPoint;
  readonly dimensions?: { width: number; height: number };
  readonly measured?: { width: number; height: number };
  readonly selected?: boolean;
}
export interface CanvasArtifactEditorProps {
  readonly artifactId: string;
  readonly store: CanvasLayoutStore;
  readonly awareness: Awareness | null;
  readonly user: CollabUser;
  readonly sourceForBoard: (path: string) => SandboxSource | null;
  readonly frameEvents: CanvasFrameEvents | null;
  readonly liveFrameLimit: number;
}
function currentFullscreen(
  boards: Readonly<Record<string, unknown>>,
  path: string | null,
): string | null {
  return path !== null && Object.hasOwn(boards, path) ? path : null;
}
function notePosition(note: CanvasNote): CanvasPoint {
  return {
    x: Math.min(note.x ?? 0, note.x2 ?? note.x ?? 0),
    y: Math.min(note.y ?? 0, note.y2 ?? note.y ?? 0),
  };
}
export function CanvasArtifactEditor({
  artifactId,
  store,
  awareness,
  user,
  sourceForBoard,
  frameEvents,
  liveFrameLimit,
}: CanvasArtifactEditorProps) {
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
  const page =
    snapshot.pages.find((item) => item.id === chosenPage)?.id ??
    snapshot.pages.at(0)?.id ??
    "";
  const [tool, setTool] = useState<CanvasTool>("select");
  const [play, setPlay] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState<string | null>(null);
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
    () => canvasPageItems(snapshot, page),
    [snapshot, page],
  );
  const activeFullscreen = currentFullscreen(snapshot.boards, fullscreen);
  const liveBoards = useMemo(
    () =>
      selectLiveBoards(
        snapshot,
        page,
        {
          x: (size.width / 2 - settledViewport.x) / settledViewport.zoom,
          y: (size.height / 2 - settledViewport.y) / settledViewport.zoom,
        },
        Math.max(0, liveFrameLimit - (activeFullscreen === null ? 0 : 1)),
      ),
    [snapshot, page, size, settledViewport, liveFrameLimit, activeFullscreen],
  );
  const nodes = useMemo<CanvasFlowNode[]>(
    () => [
      ...items.boards.map(([path, board], index): CanvasFlowNode => {
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
          selected: local?.selected ?? false,
          dragHandle: "[data-canvas-board-handle]",
          // Board removal belongs to the host file-write path; removing only
          // its map entry would be immediately undone by layout repair.
          deletable: false,
          zIndex: index,
          data: {
            path,
            board,
            note: null,
            live: liveBoards.has(path) && path !== activeFullscreen,
            play,
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
          selected: local?.selected ?? false,
          zIndex: items.boards.length + 1,
          data: { path, board: null, note, live: false, play },
        };
      }),
    ],
    [items, interactions, liveBoards, play, activeFullscreen],
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
      setChosenPage(board.page ?? snapshot.pages.at(0)?.id ?? "");
      const frame = boardFrame(board);
      void flow?.setCenter(frame.x + frame.w / 2, frame.y + frame.h / 2, {
        zoom: Math.min(1, viewport.zoom),
        duration: 200,
      });
    },
    [snapshot, flow, viewport.zoom],
  );
  const actions = useMemo<CanvasNodeActions>(
    () => ({
      sourceForBoard,
      frameEvents,
      fullscreen: setFullscreen,
      renameBoard: (path, title) =>
        store.transact((layout) =>
          setBoardMetadata(layout, path, {
            title,
            is_interactive: undefined,
            radius: undefined,
          }),
        ),
      toggleInteractive: (path) =>
        store.transact((layout) =>
          setBoardMetadata(layout, path, {
            title: undefined,
            is_interactive: snapshot.boards[path].is_interactive !== true,
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
    [sourceForBoard, frameEvents, store, snapshot],
  );
  const setPage = (id: string): void => {
    pointer.clear();
    setChosenPage(id);
    setInteractions({});
  };
  const moveOrder = (path: string, before: string | null): void =>
    store.transact((layout) => moveBoardOrder(layout, path, before));
  return (
    <CanvasNodeContext.Provider value={actions}>
      <div
        role="application"
        tabIndex={-1}
        aria-label="Canvas"
        className="flex h-full min-h-0 w-full min-w-0 flex-col bg-canvas text-foreground outline-none"
        onPointerDownCapture={(event) => {
          if (!isCanvasTextInput(event.target, event.currentTarget))
            event.currentTarget.focus({ preventScroll: true });
        }}
        onKeyDownCapture={(event) => {
          if (activeFullscreen !== null) return;
          if (isCanvasTextInput(event.target, event.currentTarget)) return;
          if ((event.metaKey || event.ctrlKey) && event.code === "KeyZ") {
            event.preventDefault();
            event.stopPropagation();
            if (event.shiftKey) store.redo();
            else store.undo();
            return;
          }
          if (event.metaKey || event.ctrlKey || event.altKey) return;
          if (
            !play &&
            (event.code === "Delete" || event.code === "Backspace")
          ) {
            const selected = nodes.filter(
              (node) => node.selected && node.data.note !== null,
            );
            if (selected.length > 0) {
              event.preventDefault();
              event.stopPropagation();
              store.transact((layout) => {
                for (const node of selected) removeNote(layout, node.data.path);
              });
            }
            return;
          }
          const next = canvasToolForKey(
            event.code.startsWith("Key") ? event.code.slice(3) : event.code,
          );
          if (next !== null) {
            event.preventDefault();
            event.stopPropagation();
            setTool(next);
            setPlay(false);
          }
        }}
      >
        <CanvasPages
          pages={snapshot.pages}
          page={page}
          onSelect={setPage}
          onRename={(id, name) =>
            store.transact((layout) => setPageName(layout, id, name))
          }
          onAdd={() => {
            const id = crypto.randomUUID();
            store.transact((layout) =>
              addPage(layout, id, `Page ${snapshot.pages.length + 1}`, null),
            );
            setPage(id);
          }}
          onRemove={(id) => store.transact((layout) => removePage(layout, id))}
        />
        <CanvasToolbar
          onZoom={(zoom) => {
            void flow?.zoomTo(zoom);
          }}
          tool={tool}
          setTool={setTool}
          play={play}
          setPlay={setPlay}
          orderOpen={orderOpen}
          toggleOrder={() => setOrderOpen((open) => !open)}
          undo={store.undo}
          redo={store.redo}
          canUndo={state.canUndo}
          canRedo={state.canRedo}
          zoom={{
            ready: flow !== null,
            scalePercent: Math.round(viewport.zoom * 100),
            canZoomIn: viewport.zoom < 4,
            canZoomOut: viewport.zoom > 0.05,
            onZoomIn: () => {
              void flow?.zoomIn();
            },
            onZoomOut: () => {
              void flow?.zoomOut();
            },
            fitKind: "screen",
            fitActive: false,
            onFit: () => {
              void flow?.fitView({ padding: 0.15, duration: 200 });
            },
            actualSizeActive: Math.abs(viewport.zoom - 1) < 0.001,
            onActualSize: () => {
              void flow?.zoomTo(1);
            },
          }}
        />
        <div className="flex min-h-0 flex-1">
          {orderOpen ? (
            <CanvasReadingOrder
              boards={items.boards}
              onCenter={centerBoard}
              onMove={moveOrder}
            />
          ) : null}
          <div
            ref={stageRef}
            className="relative min-h-0 min-w-0 flex-1"
            onPointerMove={(event) =>
              pointer.publish(toCanvas({ x: event.clientX, y: event.clientY }))
            }
            onPointerLeave={pointer.clear}
          >
            <ReactFlow<CanvasFlowNode>
              nodes={nodes}
              edges={[]}
              nodeTypes={NODE_TYPES}
              onNodesChange={changeNodes}
              onInit={setFlow}
              defaultViewport={INITIAL_VIEW}
              minZoom={0.05}
              maxZoom={4}
              colorMode={theme}
              proOptions={PRO_OPTIONS}
              noDragClassName="touch-auto"
              noPanClassName="pointer-events-auto"
              noWheelClassName="overscroll-contain"
              nodesConnectable={false}
              nodesDraggable={!play && tool === "select"}
              elementsSelectable={!play && tool === "select"}
              selectionOnDrag={!play && tool === "select"}
              panOnDrag={play || tool === "hand" ? true : [1, 2]}
              panOnScroll
              zoomOnScroll={false}
              deleteKeyCode={null}
              onMove={(_event, value) => setViewport(value)}
              onMoveEnd={(_event, value) => {
                setViewport(value);
                setSettledViewport(value);
              }}
              onNodeDragStop={(_event, node, dragged) =>
                store.transact((layout) => {
                  for (const moved of dragged.length === 0 ? [node] : dragged) {
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
                        ...(note.x2 === undefined ? {} : { x2: note.x2 + dx }),
                        ...(note.y2 === undefined ? {} : { y2: note.y2 + dy }),
                      });
                    }
                  }
                })
              }
              aria-label="Canvas workspace"
            >
              <Background color="var(--border)" />
              <MiniMap
                pannable
                zoomable
                nodeColor={(node) =>
                  Object.hasOwn(MINIMAP_COLORS, node.type ?? "")
                    ? MINIMAP_COLORS[node.type ?? ""]
                    : "var(--muted-foreground)"
                }
                maskColor="color-mix(in oklab, var(--background) 65%, transparent)"
                maskStrokeColor="var(--border)"
              />
            </ReactFlow>
            {!play && tool !== "select" && tool !== "hand" ? (
              <CanvasDrawingLayer
                key={tool}
                tool={tool}
                viewport={viewport}
                toCanvas={toCanvas}
                onCreate={(note) => {
                  store.transact((layout) =>
                    upsertNote(layout, crypto.randomUUID(), { ...note, page }),
                  );
                  setTool("select");
                }}
              />
            ) : null}
            <CanvasCursors
              awareness={awareness}
              artifactId={artifactId}
              page={page}
              viewport={viewport}
            />
          </div>
        </div>
        {activeFullscreen === null ? null : (
          <CanvasFullscreen
            path={activeFullscreen}
            snapshot={snapshot}
            sourceForBoard={sourceForBoard}
            events={frameEvents}
            onSelect={setFullscreen}
            onClose={() => setFullscreen(null)}
          />
        )}
      </div>
    </CanvasNodeContext.Provider>
  );
}

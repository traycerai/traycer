import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ComponentType, ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { NodeChange, NodeProps } from "@xyflow/react";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import {
  readCanvasLayout,
  removeNote,
  setBoardFrame,
  upsertNote,
} from "@traycer/protocol/persistence/epic/canvas-layout";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CanvasArtifactEditor } from "../canvas-artifact-editor";
import { useCanvasSelectionStore } from "../canvas-selection-store";
import type { CanvasFrameEvents } from "../canvas-frame";
import type { CanvasCommentView } from "../canvas-frame-registry";
import type { CanvasFlowNode } from "../canvas-node-context";
import type { CanvasLayoutStore } from "../canvas-layout-store";
import { canvasElement } from "./canvas-edit-test-support";
import {
  ARTIFACT_ID,
  storeFromFixture,
  type CanvasFixtureFile,
} from "./canvas-fixtures";

type DragStop = (
  event: MouseEvent,
  node: CanvasFlowNode,
  nodes: CanvasFlowNode[],
) => void;

interface ResizeFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
type ResizeEnd = (event: MouseEvent, frame: ResizeFrame) => void;

interface MockFlowProps {
  readonly nodes: CanvasFlowNode[];
  readonly nodeTypes: Readonly<
    Record<string, ComponentType<NodeProps<CanvasFlowNode>>>
  >;
  readonly onNodeDragStop: DragStop;
  readonly onNodesChange: (changes: NodeChange<CanvasFlowNode>[]) => void;
  readonly noPanClassName?: string;
  readonly viewport: {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
  };
  readonly onInit: (flow: FakeFlowInstance) => void;
  readonly children: ReactNode;
}

interface FitViewOptions {
  readonly nodes: readonly { readonly id: string }[];
  readonly padding: number;
  readonly duration: number;
}

// The instance methods the editor calls on xyflow's handle. The pane reports
// one on mount; the zoom menu stays disabled until it does.
interface FakeFlowInstance {
  readonly screenToFlowPosition: (point: { x: number; y: number }) => {
    x: number;
    y: number;
  };
  readonly zoomTo: (zoom: number) => void;
  readonly setCenter: (x: number, y: number, options: object) => void;
  readonly fitView: (options: FitViewOptions) => void;
}

// xyflow measures a real layout and owns pointer dragging and resizing,
// neither of which jsdom has. The mock keeps what the editor is responsible
// for: it renders the nodes the editor produced through the editor's own node
// renderers, and it hands the test the three callbacks xyflow would call: the
// node changes it streams while a gesture is in flight, the drag-stop, and
// each node's resize-end (the resizer learns its node from context, as the
// real one does).
interface FlowCapture {
  nodes: CanvasFlowNode[];
  dragStop: DragStop | null;
  onNodesChange: MockFlowProps["onNodesChange"] | null;
  noPanClassName: string | undefined;
  viewport: MockFlowProps["viewport"] | null;
  resizeEnds: Map<string, ResizeEnd>;
  zoomTo: Mock<(zoom: number) => void>;
  setCenter: Mock<(x: number, y: number, options: object) => void>;
  fitView: Mock<(options: FitViewOptions) => void>;
}
const flow: FlowCapture = vi.hoisted(() => ({
  nodes: [],
  dragStop: null,
  onNodesChange: null,
  noPanClassName: undefined,
  viewport: null,
  resizeEnds: new Map<string, ResizeEnd>(),
  zoomTo: vi.fn<(zoom: number) => void>(),
  setCenter: vi.fn<(x: number, y: number, options: object) => void>(),
  fitView: vi.fn<(options: FitViewOptions) => void>(),
}));

vi.mock("@xyflow/react", async () => {
  const { createContext, useContext, useEffect } = await import("react");
  const NodeIdContext = createContext<string | null>(null);
  return {
    ReactFlow: (props: MockFlowProps) => {
      const { onInit } = props;
      useEffect(
        () =>
          onInit({
            screenToFlowPosition: (point) => point,
            zoomTo: flow.zoomTo,
            setCenter: flow.setCenter,
            fitView: flow.fitView,
          }),
        [onInit],
      );
      flow.nodes = props.nodes;
      flow.dragStop = props.onNodeDragStop;
      flow.onNodesChange = props.onNodesChange;
      flow.noPanClassName = props.noPanClassName;
      flow.viewport = props.viewport;
      return (
        <div role="group" aria-label="Canvas pane">
          {props.nodes.map((node) => {
            const type = node.type ?? "board";
            const NodeRenderer = props.nodeTypes[type];
            return (
              <NodeIdContext.Provider key={node.id} value={node.id}>
                <div>
                  <NodeRenderer
                    id={node.id}
                    data={node.data}
                    type={type}
                    selected={node.selected ?? false}
                    dragging={false}
                    zIndex={node.zIndex ?? 0}
                    selectable
                    deletable={false}
                    draggable
                    isConnectable={false}
                    positionAbsoluteX={node.position.x}
                    positionAbsoluteY={node.position.y}
                  />
                </div>
              </NodeIdContext.Provider>
            );
          })}
          {props.children}
        </div>
      );
    },
    Background: () => null,
    // Board headers counter-scale by the viewport zoom; jsdom has no
    // viewport, so every read sees the identity transform.
    useStore: (selector: (state: { transform: number[] }) => number) =>
      selector({ transform: [0, 0, 1] }),
    NodeToolbar: (props: { children: ReactNode }) => props.children,
    Position: { Top: "top" },
    NodeResizer: (props: { onResizeEnd?: ResizeEnd }) => {
      const nodeId = useContext(NodeIdContext);
      const { onResizeEnd } = props;
      useEffect(() => {
        if (nodeId !== null && onResizeEnd !== undefined)
          flow.resizeEnds.set(nodeId, onResizeEnd);
      }, [nodeId, onResizeEnd]);
      return null;
    },
  };
});

const HOME = "boards/home.html";
const CHECKOUT = "boards/checkout.html";
const DETAILS = "boards/details.html";

const file: CanvasFixtureFile = {
  pages: [
    { id: "page-1", name: "Flow" },
    { id: "page-2", name: "Details" },
  ],
  boards: {
    [HOME]: { x: 0, y: 0, w: 1280, h: 800, title: "Home" },
    [CHECKOUT]: { x: 1400, y: 0, w: 640, h: 480, title: "Checkout" },
    [DETAILS]: { x: 0, y: 0, w: 640, h: 480, title: "Specs", page: "page-2" },
  },
  notes: {
    "note-1": { type: "sticky", x: 100, y: 200, text: "start here" },
  },
  order: [HOME, CHECKOUT, DETAILS],
};

interface Mounted {
  readonly store: CanvasLayoutStore;
  readonly sourceForBoard: Mock<(path: string) => SandboxSource | null>;
}

function editorElement(
  store: CanvasLayoutStore,
  sourceForBoard: Mounted["sourceForBoard"],
  frameEvents: CanvasFrameEvents | null,
): ReactNode {
  return (
    <CanvasArtifactEditor
      artifactId={ARTIFACT_ID}
      store={store}
      awareness={null}
      user={{ name: "Ada", color: "#112233" }}
      sourceForBoard={sourceForBoard}
      boardFiles={null}
      frameEvents={frameEvents}
      liveFrameLimit={0}
    />
  );
}

function mountEditorWrapped(
  wrap: (editor: ReactNode) => ReactNode,
  frameEvents: CanvasFrameEvents | null,
): Mounted {
  const store = storeFromFixture(file);
  const sourceForBoard = vi.fn<(path: string) => SandboxSource | null>(
    () => null,
  );
  render(
    <TooltipProvider>
      {wrap(editorElement(store, sourceForBoard, frameEvents))}
    </TooltipProvider>,
  );
  return { store, sourceForBoard };
}

function mountEditor(): Mounted {
  return mountEditorWrapped((editor) => editor, null);
}

function mountEditorWithEvents(frameEvents: CanvasFrameEvents): Mounted {
  return mountEditorWrapped((editor) => editor, frameEvents);
}

function canvasFrameEvents(
  overrides: Partial<CanvasFrameEvents>,
): CanvasFrameEvents {
  return {
    onBridge: vi.fn(),
    onStatus: vi.fn(),
    onEditPointer: vi.fn(),
    ...overrides,
  };
}

// The canvas is opened from inside dialogs (settings, the proof harness), so
// an ancestor with role=dialog must not make the canvas think it is a dialog.
function mountEditorInDialog(): Mounted {
  return mountEditorWrapped(
    (editor) => (
      <div role="dialog" aria-label="Settings">
        {editor}
      </div>
    ),
    null,
  );
}

function nodeNamed(id: string): CanvasFlowNode {
  const node = flow.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`no node ${id} on the canvas`);
  return node;
}

function finishDrag(node: CanvasFlowNode, x: number, y: number): void {
  const dragStop = flow.dragStop;
  if (dragStop === null) throw new Error("the canvas never mounted");
  const moved = { ...node, position: { x, y } };
  act(() => {
    dragStop(new MouseEvent("mouseup"), moved, [moved]);
  });
}

function streamChanges(changes: NodeChange<CanvasFlowNode>[]): void {
  const onNodesChange = flow.onNodesChange;
  if (onNodesChange === null) throw new Error("the canvas never mounted");
  act(() => {
    onNodesChange(changes);
  });
}

// The resize-end callback a node handed xyflow right now. A gesture keeps the
// callback it started with, however long it takes, so tests that want a late
// or stale commit take this before changing anything.
function resizeEndAtGestureStart(id: string): ResizeEnd {
  const resizeEnd = flow.resizeEnds.get(id);
  if (resizeEnd === undefined) throw new Error(`no resizer for ${id}`);
  return resizeEnd;
}

function callResizeEnd(resizeEnd: ResizeEnd, frame: ResizeFrame): void {
  act(() => {
    resizeEnd(new MouseEvent("mouseup"), frame);
  });
}

function finishResize(id: string, frame: ResizeFrame): void {
  callResizeEnd(resizeEndAtGestureStart(id), frame);
}

function frameOfNode(id: string): ResizeFrame {
  const node = nodeNamed(id);
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.width ?? Number.NaN,
    height: node.height ?? Number.NaN,
  };
}

afterEach(() => {
  cleanup();
  flow.nodes = [];
  flow.dragStop = null;
  flow.onNodesChange = null;
  flow.noPanClassName = undefined;
  flow.resizeEnds.clear();
  flow.zoomTo.mockClear();
  flow.setCenter.mockClear();
  flow.fitView.mockClear();
});

async function openZoomMenu(user: UserEvent) {
  await user.click(screen.getByRole("button", { name: /, zoom$/ }));
}

// The zoom menu items carry their shortcut in the accessible name.
async function chooseFromZoomMenu(user: UserEvent, name: RegExp) {
  await openZoomMenu(user);
  await user.click(screen.getByRole("menuitem", { name }));
}

function openPageMenu(): void {
  fireEvent.click(screen.getByRole("button", { name: "Pages" }));
}

// The board's name strip, not the preview that repeats the title.
function boardNameText(title: string): HTMLElement {
  const header = screen
    .getAllByText(title)
    .find((element) => element.closest("[data-canvas-board-handle]") !== null);
  if (header === undefined) throw new Error(`no board header for ${title}`);
  return header;
}

function startRenamingBoard(title: string): HTMLElement {
  fireEvent.doubleClick(boardNameText(title));
  return screen.getByRole("textbox", { name: "Board name" });
}

describe("CanvasArtifactEditor pages and boards", () => {
  it("names the current page on the menu button and marks it in the list", () => {
    mountEditor();
    expect(screen.getByRole("button", { name: "Pages" }).textContent).toBe(
      "Flow",
    );
    openPageMenu();
    const pages = within(screen.getByRole("list", { name: "Canvas pages" }));
    expect(
      pages.getByRole("button", { name: "Flow" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      pages
        .getByRole("button", { name: "Details" })
        .hasAttribute("aria-current"),
    ).toBe(false);
  });

  it("shows placeholders for the current page's boards only", () => {
    const { sourceForBoard } = mountEditor();
    expect(screen.getByRole("img", { name: "Home preview" })).toBeDefined();
    expect(screen.getByRole("img", { name: "Checkout preview" })).toBeDefined();
    expect(screen.queryByRole("img", { name: "Specs preview" })).toBeNull();
    // With no live budget no board should ever ask for a source to run.
    expect(sourceForBoard).not.toHaveBeenCalled();
  });

  it("renames a board by double-clicking its name", () => {
    const { store } = mountEditor();
    const input = startRenamingBoard("Home");
    fireEvent.change(input, { target: { value: "Landing" } });
    fireEvent.blur(input);

    expect(store.getSnapshot().layout.boards[HOME].title).toBe("Landing");
    expect(screen.getByRole("img", { name: "Landing preview" })).toBeDefined();
  });

  it("starts play from a board's own Play button without persisting anything", () => {
    const { store } = mountEditor();
    const before = store.getSnapshot().layout.boards[HOME];
    fireEvent.click(
      screen.getByRole("button", { name: "Play Home on canvas" }),
    );

    // Play is a view, not a document edit: nothing about the board changed.
    expect(store.getSnapshot().layout.boards[HOME]).toEqual(before);
    // Play is per board: this board's button becomes its stop control while
    // every other board keeps its own Play, and the toolbar stays up.
    expect(
      screen.getByRole("button", { name: "Stop Home (Escape)" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Play Checkout on canvas" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Select (V)" })).toBeDefined();
    // Starting play leaves the camera where the reader put it.
    expect(flow.setCenter).not.toHaveBeenCalled();
  });

  it("plays one board at a time: playing another moves the stop control", () => {
    mountEditor();
    fireEvent.click(
      screen.getByRole("button", { name: "Play Home on canvas" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Play Checkout on canvas" }),
    );

    expect(
      screen.getByRole("button", { name: "Play Home on canvas" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Stop Checkout (Escape)" }),
    ).toBeDefined();
  });

  it("stops play on Escape, with the camera untouched either way", () => {
    mountEditor();
    fireEvent.click(
      screen.getByRole("button", { name: "Play Home on canvas" }),
    );

    fireEvent.keyDown(screen.getByLabelText("Canvas"), { code: "Escape" });

    expect(
      screen.queryByRole("button", { name: "Stop Home (Escape)" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Play Home on canvas" }),
    ).toBeDefined();
    expect(flow.setCenter).not.toHaveBeenCalled();
    expect(flow.fitView).not.toHaveBeenCalled();
  });

  it("reorders boards from the reading order under the current page", () => {
    const { store } = mountEditor();
    openPageMenu();
    expect(
      screen.getByRole("list", { name: "Board reading order" }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Move Home later" }));
    // "Later" is relative to the boards on this page; the other page's board
    // is not in the list.
    expect(
      store.getSnapshot().layout.order.filter((path) => path !== DETAILS),
    ).toEqual([CHECKOUT, HOME]);
  });
});

describe("CanvasArtifactEditor page menu", () => {
  it("switches the boards and closes when another page is chosen", () => {
    mountEditor();
    openPageMenu();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    expect(screen.getByRole("img", { name: "Specs preview" })).toBeDefined();
    expect(screen.queryByRole("img", { name: "Home preview" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pages" }).textContent).toBe(
      "Details",
    );
    expect(screen.queryByRole("list", { name: "Canvas pages" })).toBeNull();
  });

  it("adds a page, switches to it and closes", () => {
    const { store } = mountEditor();
    openPageMenu();
    fireEvent.click(screen.getByRole("button", { name: "New page" }));

    expect(store.getSnapshot().layout.pages).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Pages" }).textContent).toBe(
      "Page 3",
    );
    expect(screen.queryByRole("img", { name: "Home preview" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Canvas pages" })).toBeNull();
  });

  it("renames a page inline from its actions menu", async () => {
    const user = userEvent.setup();
    const { store } = mountEditor();
    openPageMenu();
    await user.click(
      screen.getByRole("button", { name: "Actions for Details" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));

    const input = screen.getByRole("textbox", { name: "Page name" });
    fireEvent.change(input, { target: { value: "Specs" } });
    fireEvent.keyDown(input, { code: "Enter" });
    // Enter blurs the field, which is what commits.
    fireEvent.blur(input);

    expect(store.getSnapshot().layout.pages.map((item) => item.name)).toEqual([
      "Flow",
      "Specs",
    ]);
    expect(screen.queryByRole("textbox", { name: "Page name" })).toBeNull();
  });

  it("keeps the old name when the rename is cancelled", async () => {
    const user = userEvent.setup();
    const { store } = mountEditor();
    openPageMenu();
    await user.click(
      screen.getByRole("button", { name: "Actions for Details" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));

    const input = screen.getByRole("textbox", { name: "Page name" });
    fireEvent.change(input, { target: { value: "Specs" } });
    fireEvent.keyDown(input, { code: "Escape" });
    fireEvent.blur(input);

    expect(store.getSnapshot().layout.pages.map((item) => item.name)).toEqual([
      "Flow",
      "Details",
    ]);
  });

  it("deletes a page from its actions menu, and not the last one", async () => {
    const user = userEvent.setup();
    const { store } = mountEditor();
    openPageMenu();
    await user.click(
      screen.getByRole("button", { name: "Actions for Details" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(store.getSnapshot().layout.pages.map((item) => item.name)).toEqual([
      "Flow",
    ]);

    await user.click(screen.getByRole("button", { name: "Actions for Flow" }));
    expect(
      screen
        .getByRole("menuitem", { name: "Delete" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });
});

describe("CanvasArtifactEditor drag end", () => {
  it("writes the dropped position of a board and keeps its size", () => {
    const { store } = mountEditor();
    finishDrag(nodeNamed(`board:${HOME}`), 300, 40);

    expect(store.getSnapshot().layout.boards[HOME]).toMatchObject({
      x: 300,
      y: 40,
      w: 1280,
      h: 800,
    });
  });

  it("moves a note by the distance it was dragged", () => {
    const { store } = mountEditor();
    finishDrag(nodeNamed("note:note-1"), 130, 260);

    expect(store.getSnapshot().layout.notes["note-1"]).toMatchObject({
      x: 130,
      y: 260,
    });
  });

  it("does not write anything for a node that is no longer in the layout", () => {
    const { store } = mountEditor();
    const stale = nodeNamed(`board:${HOME}`);
    const before = store.getSnapshot().layout;
    finishDrag(
      { ...stale, data: { ...stale.data, path: "boards/gone.html" } },
      5,
      5,
    );
    expect(store.getSnapshot().layout.boards).toEqual(before.boards);
  });

  it("makes a drag undoable from the zoom menu", async () => {
    const user = userEvent.setup();
    const { store } = mountEditor();
    await openZoomMenu(user);
    expect(
      screen
        .getByRole("menuitem", { name: /^Undo/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await user.keyboard("{Escape}");

    finishDrag(nodeNamed(`board:${HOME}`), 300, 40);
    await openZoomMenu(user);
    expect(
      screen
        .getByRole("menuitem", { name: /^Undo/ })
        .hasAttribute("aria-disabled"),
    ).toBe(false);

    await user.click(screen.getByRole("menuitem", { name: /^Undo/ }));
    expect(store.getSnapshot().layout.boards[HOME]).toMatchObject({
      x: 0,
      y: 0,
    });
  });

  it("undoes with the keyboard", () => {
    const { store } = mountEditor();
    finishDrag(nodeNamed(`board:${HOME}`), 300, 40);

    fireEvent.keyDown(screen.getByLabelText("Canvas"), {
      code: "KeyZ",
      ctrlKey: true,
    });
    expect(store.getSnapshot().layout.boards[HOME]).toMatchObject({
      x: 0,
      y: 0,
    });
  });
});

describe("CanvasArtifactEditor tool shortcuts", () => {
  it("selects the tool for a pressed key", () => {
    mountEditor();
    const canvas = screen.getByLabelText("Canvas");
    fireEvent.keyDown(canvas, { code: "KeyR" });
    expect(
      screen
        .getByRole("button", { name: "Rectangle (R)" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.keyDown(canvas, { code: "Escape" });
    expect(
      screen
        .getByRole("button", { name: "Select (V)" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("returns to Select on Escape without stopping the key", () => {
    mountEditor();
    fireEvent.keyDown(screen.getByLabelText("Canvas"), { code: "KeyR" });
    // The selection provider steps the selection out on this same key, so it
    // has to reach whatever sits under the canvas root.
    const reached = vi.fn<(event: Event) => void>();
    const pane = screen.getByRole("group", { name: "Canvas pane" });
    pane.addEventListener("keydown", reached);

    const notPrevented = fireEvent.keyDown(pane, { code: "Escape" });

    expect(reached).toHaveBeenCalledOnce();
    expect(notPrevented).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Select (V)" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("leaves the keys alone while a name is being typed", () => {
    mountEditor();
    fireEvent.keyDown(startRenamingBoard("Home"), { code: "KeyR" });
    expect(
      screen
        .getByRole("button", { name: "Rectangle (R)" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });
});

describe("CanvasArtifactEditor board frames in play", () => {
  function overlayCount(): number {
    return document.querySelectorAll("[data-canvas-frame-overlay]").length;
  }

  it("shields every board by default", () => {
    mountEditor();
    expect(overlayCount()).toBe(2);
  });

  it("lifts the shield from the playing board only; the others stay editable", () => {
    mountEditor();
    fireEvent.click(
      screen.getByRole("button", { name: "Play Home on canvas" }),
    );
    expect(overlayCount()).toBe(1);
  });

  it("brings the playing board's shield back when its stop control is used", () => {
    mountEditor();
    fireEvent.click(
      screen.getByRole("button", { name: "Play Home on canvas" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop Home (Escape)" }));
    expect(overlayCount()).toBe(2);
  });
});

describe("CanvasArtifactEditor resize", () => {
  const boardId = `board:${HOME}`;

  // The order xyflow 12 reports a top/left resize in: one batch with the new
  // origin (a position change that carries no `dragging` flag) and the new
  // size, then the resizer's end callback, then a dimensions change that says
  // the gesture is over.
  function streamTopLeftResize(): void {
    streamChanges([
      { type: "position", id: boardId, position: { x: 80, y: 50 } },
      {
        type: "dimensions",
        id: boardId,
        resizing: true,
        setAttributes: true,
        dimensions: { width: 1000, height: 700 },
      },
    ]);
  }

  it("keeps the new origin and size while a top-left resize is in flight", () => {
    const { store } = mountEditor();
    // xyflow reports a top/left drag as a size change and a position change in
    // the same batch, and the position change carries no `dragging` flag.
    streamTopLeftResize();

    expect(frameOfNode(boardId)).toEqual({
      x: 80,
      y: 50,
      width: 1000,
      height: 700,
    });
    expect(store.getSnapshot().layout.boards[HOME]).toMatchObject({
      x: 0,
      y: 0,
      w: 1280,
      h: 800,
    });
    expect(store.getSnapshot().canUndo).toBe(false);
  });

  it("keeps the in-flight origin when xyflow only re-measures the node", () => {
    mountEditor();
    streamTopLeftResize();
    streamChanges([
      {
        type: "dimensions",
        id: boardId,
        dimensions: { width: 1000, height: 700 },
      },
    ]);
    expect(frameOfNode(boardId)).toEqual({
      x: 80,
      y: 50,
      width: 1000,
      height: 700,
    });
  });

  it("ignores a measurement of a node nobody is resizing", () => {
    const { store } = mountEditor();
    streamChanges([
      {
        type: "dimensions",
        id: boardId,
        dimensions: { width: 1280, height: 800 },
      },
    ]);
    expect(frameOfNode(boardId)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
    });
    expect(store.getSnapshot().canUndo).toBe(false);
  });

  it("remembers what xyflow measured without changing the authored size", () => {
    const { store } = mountEditor();
    // The measured size differs from the authored one so the two cannot be
    // mistaken for each other.
    streamChanges([
      {
        type: "dimensions",
        id: boardId,
        dimensions: { width: 1300, height: 820 },
      },
    ]);
    expect(nodeNamed(boardId).measured).toEqual({ width: 1300, height: 820 });
    expect(frameOfNode(boardId)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
    });

    // Selecting rebuilds the controlled node. If the measurement were dropped,
    // the resizer would start the next gesture from 0 by 0 and an outward drag
    // would collapse the board.
    streamChanges([{ type: "select", id: boardId, selected: true }]);
    expect(nodeNamed(boardId).selected).toBe(true);
    expect(nodeNamed(boardId).measured).toEqual({ width: 1300, height: 820 });
    expect(frameOfNode(boardId)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
    });
    expect(store.getSnapshot().canUndo).toBe(false);
  });

  it("tracks the measured size with the size while a resize is in flight", () => {
    mountEditor();
    streamChanges([
      {
        type: "dimensions",
        id: boardId,
        dimensions: { width: 1300, height: 820 },
      },
    ]);
    streamTopLeftResize();
    expect(nodeNamed(boardId).measured).toEqual({ width: 1000, height: 700 });
    expect(frameOfNode(boardId)).toEqual({
      x: 80,
      y: 50,
      width: 1000,
      height: 700,
    });
  });

  it("writes the geometry once on resize end", () => {
    const { store } = mountEditor();
    streamTopLeftResize();
    finishResize(boardId, { x: 80, y: 50, width: 1000, height: 700 });

    expect(store.getSnapshot().layout.boards[HOME]).toMatchObject({
      x: 80,
      y: 50,
      w: 1000,
      h: 700,
    });
  });

  it("follows the document again after the gesture ends", () => {
    const { store } = mountEditor();
    streamTopLeftResize();
    finishResize(boardId, { x: 80, y: 50, width: 1000, height: 700 });
    streamChanges([{ type: "dimensions", id: boardId, resizing: false }]);
    expect(frameOfNode(boardId)).toEqual({
      x: 80,
      y: 50,
      width: 1000,
      height: 700,
    });

    // A peer moves the board. A leftover local override would hide this.
    act(() => {
      store.doc.transact(() => {
        setBoardFrame(store.handle, HOME, { x: 5, y: 6, w: 700, h: 500 });
      }, "remote");
    });
    expect(frameOfNode(boardId)).toEqual({
      x: 5,
      y: 6,
      width: 700,
      height: 500,
    });
  });

  it("makes a finished resize one undo step", async () => {
    const { store } = mountEditor();
    finishResize(boardId, { x: 80, y: 50, width: 1000, height: 700 });
    await chooseFromZoomMenu(userEvent.setup(), /^Undo/);
    expect(store.getSnapshot().layout.boards[HOME]).toMatchObject({
      x: 0,
      y: 0,
      w: 1280,
      h: 800,
    });
  });
});

describe("CanvasArtifactEditor drag in flight", () => {
  const boardId = `board:${HOME}`;

  it("shows the dragged position without writing to the document", () => {
    const { store } = mountEditor();
    streamChanges([
      {
        type: "position",
        id: boardId,
        position: { x: 300, y: 40 },
        dragging: true,
      },
    ]);

    expect(nodeNamed(boardId).position).toEqual({ x: 300, y: 40 });
    expect(store.getSnapshot().layout.boards[HOME]).toMatchObject({
      x: 0,
      y: 0,
    });
    expect(store.getSnapshot().canUndo).toBe(false);
  });

  it("commits once on drag stop and then follows the document", () => {
    const { store } = mountEditor();
    streamChanges([
      {
        type: "position",
        id: boardId,
        position: { x: 300, y: 40 },
        dragging: true,
      },
    ]);
    const dragged = nodeNamed(boardId);
    streamChanges([
      {
        type: "position",
        id: boardId,
        position: { x: 300, y: 40 },
        dragging: false,
      },
    ]);
    finishDrag(dragged, 300, 40);

    expect(store.getSnapshot().layout.boards[HOME]).toMatchObject({
      x: 300,
      y: 40,
      w: 1280,
      h: 800,
    });
    expect(nodeNamed(boardId).position).toEqual({ x: 300, y: 40 });

    act(() => {
      store.doc.transact(() => {
        setBoardFrame(store.handle, HOME, { x: 9, y: 9, w: 1280, h: 800 });
      }, "remote");
    });
    expect(nodeNamed(boardId).position).toEqual({ x: 9, y: 9 });
  });
});

describe.each([
  ["on its own", mountEditor],
  ["inside a dialog", mountEditorInDialog],
])("CanvasArtifactEditor focus %s", (_label, mount) => {
  function focusedElement(): Element {
    const focused = document.activeElement;
    if (focused === null) throw new Error("nothing has focus");
    return focused;
  }

  it("takes focus when the pane is pressed", () => {
    mount();
    expect(document.activeElement).toBe(document.body);

    fireEvent.pointerDown(screen.getByRole("group", { name: "Canvas pane" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Canvas"));
  });

  it("takes focus when a board is pressed", () => {
    mount();
    fireEvent.pointerDown(screen.getByRole("img", { name: "Home preview" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Canvas"));
  });

  it("undoes and redoes from the keyboard after the pane was pressed", () => {
    const { store } = mount();
    finishDrag(nodeNamed(`board:${HOME}`), 300, 40);
    fireEvent.pointerDown(screen.getByRole("group", { name: "Canvas pane" }));

    fireEvent.keyDown(focusedElement(), { code: "KeyZ", ctrlKey: true });
    expect(store.getSnapshot().layout.boards[HOME]).toMatchObject({
      x: 0,
      y: 0,
    });

    fireEvent.keyDown(focusedElement(), {
      code: "KeyZ",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(store.getSnapshot().layout.boards[HOME]).toMatchObject({
      x: 300,
      y: 40,
    });
  });

  it("switches tools from the keyboard after the pane was pressed", () => {
    mount();
    fireEvent.pointerDown(screen.getByRole("group", { name: "Canvas pane" }));
    fireEvent.keyDown(focusedElement(), { code: "KeyR" });
    expect(
      screen
        .getByRole("button", { name: "Rectangle (R)" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("leaves focus in a text field that is pressed", () => {
    mount();
    const input = startRenamingBoard("Home");
    // The field selects its text on mount; jsdom's select() does not move
    // focus the way a browser's does.
    act(() => input.focus());

    fireEvent.pointerDown(input);
    expect(document.activeElement).toBe(input);
  });

  it("leaves focus in the note editor and keeps its keys to itself", () => {
    const { store } = mount();
    finishDrag(nodeNamed(`board:${HOME}`), 300, 40);
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "Edit sticky note" }),
    );
    const textarea = screen.getByRole("textbox", { name: "Sticky note text" });
    expect(document.activeElement).toBe(textarea);

    fireEvent.pointerDown(textarea);
    expect(document.activeElement).toBe(textarea);
    fireEvent.keyDown(textarea, { code: "KeyZ", ctrlKey: true });
    expect(store.getSnapshot().layout.boards[HOME]).toMatchObject({
      x: 300,
      y: 40,
    });
  });

  it("does not undo or switch tools while typing in a text field", () => {
    const { store } = mount();
    finishDrag(nodeNamed(`board:${HOME}`), 300, 40);
    const input = startRenamingBoard("Home");

    fireEvent.keyDown(input, { code: "KeyZ", ctrlKey: true });
    fireEvent.keyDown(input, { code: "KeyR" });

    expect(store.getSnapshot().layout.boards[HOME]).toMatchObject({
      x: 300,
      y: 40,
    });
    expect(
      screen
        .getByRole("button", { name: "Rectangle (R)" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });
});

describe("CanvasArtifactEditor board shield and panning", () => {
  it("lets a drag over an unmarked board pan in Hand mode", () => {
    mountEditor();
    fireEvent.click(screen.getByRole("button", { name: "Hand (H)" }));
    // The edit shield gives way to a layer that passes drags to the canvas.
    expect(
      document.querySelectorAll("[data-canvas-frame-overlay]"),
    ).toHaveLength(0);
    const noPan = flow.noPanClassName ?? "nopan";
    expect(
      screen.getByRole("img", { name: "Home preview" }).closest(`.${noPan}`),
    ).toBeNull();
  });

  it("keeps comment pins mounted over a board in Hand mode", () => {
    mountEditorWithEvents(
      canvasFrameEvents({
        renderOverlay: (path, editing) => (
          <div data-testid={`pins-${path}`} data-editing={String(editing)} />
        ),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Hand (H)" }));

    expect(
      document.querySelectorAll("[data-canvas-frame-overlay]"),
    ).toHaveLength(0);
    for (const path of [HOME, CHECKOUT])
      expect(
        screen.getByTestId(`pins-${path}`).getAttribute("data-editing"),
      ).toBe("false");
  });

  it("pans while Space is held, whatever the tool", () => {
    mountEditor();
    const canvas = screen.getByLabelText("Canvas");
    expect(
      document.querySelectorAll("[data-canvas-frame-overlay]"),
    ).toHaveLength(2);
    fireEvent.keyDown(canvas, { code: "Space" });
    expect(
      document.querySelectorAll("[data-canvas-frame-overlay]"),
    ).toHaveLength(0);
    fireEvent.keyUp(canvas, { code: "Space" });
    expect(
      document.querySelectorAll("[data-canvas-frame-overlay]"),
    ).toHaveLength(2);
  });

  // Play now removes every board's shield outright (see "CanvasArtifactEditor
  // board frames in play"), so there is no shield left to pan through here;
  // that case is covered by `overlayCount()` there instead.
});

describe("CanvasArtifactEditor late resize commits", () => {
  const noteId = "note:note-1";
  const frame: ResizeFrame = { x: 50, y: 100, width: 100, height: 150 };

  it("does not bring back a note a peer deleted mid-gesture", () => {
    const { store } = mountEditor();
    const gestureStart = resizeEndAtGestureStart(noteId);
    act(() => {
      store.doc.transact(() => {
        removeNote(store.handle, "note-1");
      }, "remote");
    });

    callResizeEnd(gestureStart, frame);

    expect(readCanvasLayout(store.handle).notes).not.toHaveProperty("note-1");
    expect(store.getSnapshot().canUndo).toBe(false);
  });

  it("commits against the note as it is now, not as it was when the gesture began", () => {
    const { store } = mountEditor();
    const gestureStart = resizeEndAtGestureStart(noteId);
    // A peer turns the sticky into an arrow that points up and to the left.
    act(() => {
      store.doc.transact(() => {
        upsertNote(store.handle, "note-1", {
          type: "arrow",
          x: 150,
          y: 250,
          x2: 50,
          y2: 100,
        });
      }, "remote");
    });

    callResizeEnd(gestureStart, frame);

    expect(readCanvasLayout(store.handle).notes["note-1"]).toMatchObject({
      type: "arrow",
      x: 150,
      y: 250,
      x2: 50,
      y2: 100,
    });
  });

  it("writes nothing once the editor is gone", () => {
    const { store } = mountEditor();
    const gestureStart = resizeEndAtGestureStart(`board:${HOME}`);
    cleanup();

    callResizeEnd(gestureStart, { x: 80, y: 50, width: 1000, height: 700 });

    expect(readCanvasLayout(store.handle).boards[HOME]).toMatchObject({
      x: 0,
      y: 0,
      w: 1280,
      h: 800,
    });
  });

  it("writes nothing once the document is destroyed, even before the editor unmounts", () => {
    const { store } = mountEditor();
    const gestureStart = resizeEndAtGestureStart(`board:${HOME}`);
    store.doc.destroy();

    callResizeEnd(gestureStart, { x: 80, y: 50, width: 1000, height: 700 });

    expect(readCanvasLayout(store.handle).boards[HOME]).toMatchObject({
      x: 0,
      y: 0,
      w: 1280,
      h: 800,
    });
  });

  it("writes to neither store when the editor moved to another store", () => {
    const first = storeFromFixture(file);
    const second = storeFromFixture(file);
    const sourceForBoard = vi.fn<(path: string) => SandboxSource | null>(
      () => null,
    );
    const { rerender } = render(
      <TooltipProvider>
        {editorElement(first, sourceForBoard, null)}
      </TooltipProvider>,
    );
    const gestureStart = resizeEndAtGestureStart(`board:${HOME}`);
    rerender(
      <TooltipProvider>
        {editorElement(second, sourceForBoard, null)}
      </TooltipProvider>,
    );

    callResizeEnd(gestureStart, { x: 80, y: 50, width: 1000, height: 700 });

    for (const store of [first, second]) {
      expect(readCanvasLayout(store.handle).boards[HOME]).toMatchObject({
        x: 0,
        y: 0,
        w: 1280,
        h: 800,
      });
    }
  });

  it("writes nothing for a node that left the canvas with its page", () => {
    const { store } = mountEditor();
    const gestureStart = resizeEndAtGestureStart(`board:${HOME}`);
    openPageMenu();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    callResizeEnd(gestureStart, { x: 80, y: 50, width: 1000, height: 700 });

    expect(readCanvasLayout(store.handle).boards[HOME]).toMatchObject({
      x: 0,
      y: 0,
      w: 1280,
      h: 800,
    });
    expect(store.getSnapshot().canUndo).toBe(false);
  });
});

describe("CanvasArtifactEditor placing items", () => {
  const FROM = { x: 10, y: 10 };
  const TO = { x: 110, y: 90 };

  // jsdom has no pointer capture, which the drawing layer asks for.
  beforeEach(() => {
    HTMLElement.prototype.setPointerCapture = vi.fn();
  });

  function drawWith(tool: string): void {
    const layer = screen.getByLabelText(`Draw ${tool}`);
    fireEvent.pointerDown(layer, {
      button: 0,
      pointerId: 1,
      clientX: FROM.x,
      clientY: FROM.y,
    });
    fireEvent.pointerUp(layer, { pointerId: 1, clientX: TO.x, clientY: TO.y });
  }

  function pressed(name: string): string | null {
    return screen.getByRole("button", { name }).getAttribute("aria-pressed");
  }

  function noteTypes(store: CanvasLayoutStore): (string | undefined)[] {
    return Object.values(store.getSnapshot().layout.notes).map(
      (note) => note.type,
    );
  }

  it("goes back to Select once a shape is placed, and selects it", () => {
    const onBoardSelect = vi.fn();
    const { store } = mountEditorWithEvents(
      canvasFrameEvents({ onBoardSelect }),
    );
    fireEvent.keyDown(screen.getByLabelText("Canvas"), { code: "KeyR" });
    expect(pressed("Rectangle (R)")).toBe("true");

    drawWith("rect");

    expect(noteTypes(store)).toContain("rect");
    expect(pressed("Select (V)")).toBe("true");
    expect(pressed("Rectangle (R)")).toBe("false");
    expect(screen.queryByLabelText("Draw rect")).toBeNull();
    // The new shape replaces any board that was selected for the inspector.
    expect(onBoardSelect).toHaveBeenCalledWith(null);
  });

  it("keeps the pen active after a stroke", () => {
    const onBoardSelect = vi.fn();
    const { store } = mountEditorWithEvents(
      canvasFrameEvents({ onBoardSelect }),
    );
    fireEvent.keyDown(screen.getByLabelText("Canvas"), { code: "KeyP" });

    drawWith("pen");
    drawWith("pen");

    expect(noteTypes(store).filter((type) => type === "pen")).toHaveLength(2);
    expect(pressed("Pen (P)")).toBe("true");
    expect(screen.getByLabelText("Draw pen")).toBeDefined();
    expect(onBoardSelect).not.toHaveBeenCalled();
  });

  it("opens a placed sticky note for typing", () => {
    mountEditor();
    fireEvent.keyDown(screen.getByLabelText("Canvas"), { code: "KeyN" });

    drawWith("sticky");

    expect(pressed("Select (V)")).toBe("true");
    expect(screen.getByRole("textbox", { name: "Sticky note text" })).toBe(
      document.activeElement,
    );
  });
});

describe("CanvasArtifactEditor inspector", () => {
  function annotations(): HTMLElement | null {
    return screen.queryByLabelText("Annotations");
  }

  function mountWithPanel(): void {
    mountEditorWithEvents(
      canvasFrameEvents({
        renderPanel: (_store, { onClose }) => (
          <aside aria-label="Annotations">
            <button type="button" onClick={onClose}>
              Close annotations
            </button>
          </aside>
        ),
      }),
    );
  }

  function selectElement(tid: string): void {
    act(() => {
      useCanvasSelectionStore.getState().select({
        artifactId: ARTIFACT_ID,
        boardPath: HOME,
        page: null,
        servedSha256: "sha",
        element: canvasElement({ tid }),
        textRange: null,
      });
    });
  }

  afterEach(() => {
    act(() => useCanvasSelectionStore.getState().clear());
  });

  it("stays parked behind its flag whatever is selected", () => {
    mountWithPanel();

    selectElement("first");
    expect(annotations()).toBeNull();

    streamChanges([{ type: "select", id: `board:${HOME}`, selected: true }]);
    expect(annotations()).toBeNull();

    streamChanges([{ type: "select", id: "note:note-1", selected: true }]);
    expect(
      screen.queryByRole("complementary", { name: "Note inspector" }),
    ).toBeNull();
  });
});

describe("CanvasArtifactEditor revealing a canvas point", () => {
  it("leaves a fullscreen board before centering the spot, since point pins live outside every board", () => {
    let view: CanvasCommentView | null = null;
    mountEditorWithEvents(
      canvasFrameEvents({
        onCanvasView: (next) => {
          view = next;
        },
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Play Home fullscreen" }),
    );
    expect(
      screen.getByRole("button", { name: "Back to canvas" }),
    ).toBeDefined();

    let revealed = false;
    act(() => {
      revealed = view?.revealCanvasPoint("page-1", 120, 80) ?? false;
    });

    expect(revealed).toBe(true);
    expect(screen.queryByRole("button", { name: "Back to canvas" })).toBeNull();
    // While fullscreen, the flow's own move events are ignored, so setCenter
    // would be snapped back by the controlled viewport; the reveal writes the
    // centered viewport through the controlled state instead. jsdom measures
    // the stage at 0x0, so the centered origin is -point * zoom.
    expect(flow.setCenter).not.toHaveBeenCalled();
    expect(flow.viewport).toEqual({ x: -120 * 0.6, y: -80 * 0.6, zoom: 0.6 });
  });
});

describe("CanvasArtifactEditor zoom menu", () => {
  it("reads the viewport zoom and zooms to a preset", async () => {
    const user = userEvent.setup();
    mountEditor();
    expect(screen.getByRole("button", { name: "60%, zoom" })).toBeDefined();

    await chooseFromZoomMenu(user, /^200%$/);
    expect(flow.zoomTo).toHaveBeenCalledWith(2);
  });

  it("fits only the current page's boards and notes, not an off-page board the live budget still retains", async () => {
    const store = storeFromFixture(file);
    const sourceForBoard = vi.fn<(path: string) => SandboxSource | null>(
      () => null,
    );
    render(
      <TooltipProvider>
        <CanvasArtifactEditor
          artifactId={ARTIFACT_ID}
          store={store}
          awareness={null}
          user={{ name: "Ada", color: "#112233" }}
          sourceForBoard={sourceForBoard}
          boardFiles={null}
          frameEvents={null}
          liveFrameLimit={2}
        />
      </TooltipProvider>,
    );
    const user = userEvent.setup();

    // Visit Details (the other page's board) once, then leave its page -
    // the live-frame budget keeps it mounted off-page, which is exactly the
    // board Fit must not measure.
    openPageMenu();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Play Specs fullscreen" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to canvas" }));
    openPageMenu();
    fireEvent.click(screen.getByRole("button", { name: "Flow" }));

    await chooseFromZoomMenu(user, /^Fit to screen$/);

    expect(flow.fitView).toHaveBeenCalledOnce();
    const fitted = flow.fitView.mock.calls[0][0].nodes;
    expect(fitted).toEqual(
      expect.arrayContaining([
        { id: `board:${HOME}` },
        { id: `board:${CHECKOUT}` },
        { id: "note:note-1" },
      ]),
    );
    expect(fitted).toHaveLength(3);
  });
});

describe("CanvasArtifactEditor reading order jump", () => {
  it("centres the board that is clicked and closes the menu", () => {
    mountEditor();
    openPageMenu();
    const order = screen.getByRole("list", { name: "Board reading order" });
    fireEvent.click(
      within(order).getByRole("button", { name: /^2\s*Checkout$/ }),
    );

    // Checkout is 640 x 480 at (1400, 0).
    expect(flow.setCenter).toHaveBeenCalledWith(1720, 240, expect.anything());
    expect(screen.queryByRole("list", { name: "Canvas pages" })).toBeNull();
  });
});

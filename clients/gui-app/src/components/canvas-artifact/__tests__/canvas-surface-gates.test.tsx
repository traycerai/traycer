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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeChange, NodeProps } from "@xyflow/react";
import type {
  SandboxFrameProps,
  SandboxSource,
} from "@/components/sandbox/sandbox-frame";
import { readCanvasLayout } from "@traycer/protocol/persistence/epic/canvas-layout";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  SandboxBridgeHost,
  type SandboxHostContext,
} from "@/lib/sandbox/bridge-host";
import type { CanvasPageError } from "@/lib/sandbox/canvas-bridge";
import {
  CanvasArtifactEditor,
  type CanvasArtifactEditorProps,
} from "../canvas-artifact-editor";
import type { CanvasFrameEvents } from "../canvas-frame";
import { useCanvasSelectionStore } from "../canvas-selection-store";
import { canvasElement } from "./canvas-edit-test-support";
import type { CanvasFlowNode } from "../canvas-node-context";
import type { CanvasLayoutStore } from "../canvas-layout-store";
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

interface MockFlowProps {
  readonly nodes: CanvasFlowNode[];
  readonly nodeTypes: Readonly<
    Record<string, ComponentType<NodeProps<CanvasFlowNode>>>
  >;
  readonly onNodeDragStop: DragStop;
  readonly onNodesChange: (changes: NodeChange<CanvasFlowNode>[]) => void;
  readonly onNodeClick: (event: MouseEvent, node: CanvasFlowNode) => void;
  readonly nodesDraggable: boolean;
  readonly elementsSelectable: boolean;
  readonly selectionOnDrag: boolean;
  readonly panOnDrag: boolean | number[];
  readonly onInit: (flow: FakeFlowInstance) => void;
  readonly children: ReactNode;
}

// The instance methods the editor calls on xyflow's handle; the zoom menu is
// disabled until the pane reports one.
interface FakeFlowInstance {
  readonly screenToFlowPosition: (point: { x: number; y: number }) => {
    x: number;
    y: number;
  };
}

// The same stand-in the editor's own test uses: xyflow measures real layout
// and owns pointer gestures, neither of which jsdom has. What the editor is
// responsible for is the props it hands xyflow and the nodes it renders, so
// the mock records the former and renders the latter through the real node
// renderers.
interface FlowCapture {
  nodes: CanvasFlowNode[];
  dragStop: DragStop | null;
  onNodeClick: MockFlowProps["onNodeClick"] | null;
  gestures: {
    nodesDraggable: boolean;
    elementsSelectable: boolean;
    selectionOnDrag: boolean;
    panOnDrag: boolean | number[];
  } | null;
  resizerVisible: Map<string, boolean>;
}
const flow: FlowCapture = vi.hoisted(() => ({
  nodes: [],
  dragStop: null,
  onNodeClick: null,
  gestures: null,
  resizerVisible: new Map<string, boolean>(),
}));

// A board's page is a sandboxed iframe that needs a runner host and a served
// artifact. The editor's contract with it is the props it passes down, so the
// stand-in keeps the latest props per title and lets a test play the part of
// the page: raise an error, report a link, hand over a bridge.
const frames = vi.hoisted(() => new Map<string, SandboxFrameProps>());

vi.mock("@/components/sandbox/sandbox-frame", () => ({
  SandboxFrame: (props: SandboxFrameProps) => {
    frames.set(props.title, props);
    return <div data-testid={`frame-${props.title}`} />;
  },
}));

vi.mock("@xyflow/react", async () => {
  const { createContext, useContext, useEffect } = await import("react");
  const NodeIdContext = createContext<string | null>(null);
  const fakeFlow: FakeFlowInstance = { screenToFlowPosition: (point) => point };
  return {
    ReactFlow: (props: MockFlowProps) => {
      const { onInit } = props;
      useEffect(() => onInit(fakeFlow), [onInit]);
      flow.nodes = props.nodes;
      flow.dragStop = props.onNodeDragStop;
      flow.onNodeClick = props.onNodeClick;
      flow.gestures = {
        nodesDraggable: props.nodesDraggable,
        elementsSelectable: props.elementsSelectable,
        selectionOnDrag: props.selectionOnDrag,
        panOnDrag: props.panOnDrag,
      };
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
    NodeResizer: (props: { isVisible?: boolean }) => {
      const nodeId = useContext(NodeIdContext);
      if (nodeId !== null)
        flow.resizerVisible.set(nodeId, props.isVisible ?? true);
      return null;
    },
  };
});

const HOME = "boards/home.html";
const CHECKOUT = "boards/checkout.html";

const file: CanvasFixtureFile = {
  pages: [{ id: "page-1", name: "Flow" }],
  boards: {
    [HOME]: { x: 0, y: 0, w: 1280, h: 800, title: "Home" },
    [CHECKOUT]: { x: 1400, y: 0, w: 640, h: 480, title: "Checkout" },
  },
  notes: {
    "note-1": { type: "sticky", x: 100, y: 200, text: "start here" },
  },
  order: [HOME, CHECKOUT],
};

const HOST_CONTEXT: SandboxHostContext = {
  theme: "light",
  styles: { variables: {} },
  displayMode: "inline",
  availableDisplayModes: ["inline"],
  platform: "desktop",
};

const bridges: SandboxBridgeHost[] = [];

/** A real canvas bridge whose only observable is the mode it is asked for. */
function canvasBridge() {
  const bridge = new SandboxBridgeHost({
    document: {
      kind: "served",
      canvas: true,
      nonce: "n",
      forwardedShortcuts: [],
      pages: null,
    },
    hostContext: HOST_CONTEXT,
    hostVersion: "9.9.9",
    post: () => undefined,
    events: {
      onStatus: () => undefined,
      onSize: () => undefined,
      onOpenLink: () => Promise.resolve(true),
      onShortcut: () => undefined,
      onRequestTeardown: () => undefined,
      onScrollGesture: () => undefined,
      onWheel: () => undefined,
    },
    appRequests: null,
  });
  bridges.push(bridge);
  const setMode = vi.spyOn(bridge, "setMode").mockResolvedValue(true);
  const navigateCanvas = vi
    .spyOn(bridge, "navigateCanvas")
    .mockResolvedValue(true);
  return { bridge, setMode, navigateCanvas };
}

const HTML_SOURCE: SandboxSource = { kind: "html", html: "<p>page</p>" };

interface Options {
  readonly viewOnly: boolean;
  readonly live: boolean;
  /** When set, only this board has a page to run. */
  readonly onlyBoard: string | null;
  readonly frameEvents: CanvasFrameEvents | null;
  readonly onAddError: CanvasArtifactEditorProps["onAddError"];
  /** Edits made before the editor mounts, e.g. a board marked playable. */
  readonly prepare: ((store: CanvasLayoutStore) => void) | null;
}

const DEFAULTS: Options = {
  viewOnly: false,
  live: false,
  onlyBoard: null,
  frameEvents: null,
  onAddError: undefined,
  prepare: null,
};

function mount(overrides: Partial<Options>) {
  const options = { ...DEFAULTS, ...overrides };
  const store = storeFromFixture(file);
  options.prepare?.(store);
  render(
    <TooltipProvider>
      <CanvasArtifactEditor
        artifactId={ARTIFACT_ID}
        store={store}
        awareness={null}
        user={{ name: "Ada", color: "#112233" }}
        sourceForBoard={(path) =>
          options.live &&
          (options.onlyBoard === null || options.onlyBoard === path)
            ? HTML_SOURCE
            : null
        }
        boardFiles={null}
        frameEvents={options.frameEvents}
        liveFrameLimit={options.live ? 1 : 0}
        viewOnly={options.viewOnly}
        onAddError={options.onAddError}
      />
    </TooltipProvider>,
  );
  return { store };
}

function frameOf(title: string): SandboxFrameProps {
  const props = frames.get(title);
  if (props === undefined) throw new Error(`no frame rendered for ${title}`);
  return props;
}

/** Plays the page: calls a handler the frame was given, inside `act`. */
function fromPage(title: string, run: (props: SandboxFrameProps) => void) {
  act(() => {
    run(frameOf(title));
  });
}

/** Error pills only: the zoom readout is also a status region. */
function pills(): HTMLElement[] {
  return screen
    .queryAllByRole("status")
    .filter((element) => element.getAttribute("aria-label") === null);
}
function queryPill(): HTMLElement | null {
  return pills().at(0) ?? null;
}
function pill(): HTMLElement {
  const first = pills().at(0);
  if (first === undefined) throw new Error("no error pill is showing");
  return first;
}

function pageError(message: string): CanvasPageError {
  return { message, stack: null };
}

function frameEvents(overrides: Partial<CanvasFrameEvents>): CanvasFrameEvents {
  return {
    onBridge: vi.fn(),
    onStatus: vi.fn(),
    onEditPointer: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  useCanvasSelectionStore.getState().clear();
  for (const bridge of bridges.splice(0)) bridge.dispose();
  frames.clear();
  flow.nodes = [];
  flow.dragStop = null;
  flow.onNodeClick = null;
  flow.gestures = null;
  flow.resizerVisible.clear();
});

describe("a view-only canvas (the phone)", () => {
  const TOOL_LABELS = [
    "Select (V)",
    "Hand (H)",
    "Note (N)",
    "Text (T)",
    "Pen (P)",
    "Rectangle (R)",
    "More shapes",
  ];

  it("keeps the editing tools and history off the toolbar", async () => {
    const user = userEvent.setup();
    mount({ viewOnly: true });
    for (const label of TOOL_LABELS)
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    // The reading aids stay.
    expect(screen.getByRole("button", { name: "Pages" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: /, zoom$/ }));
    expect(
      screen.getByRole("menuitem", { name: "Fit to screen" }),
    ).toBeDefined();
    for (const label of [/^Undo/, /^Redo/])
      expect(screen.queryByRole("menuitem", { name: label })).toBeNull();
  });

  it("shows the same toolbar the desktop does when editing is allowed", async () => {
    const user = userEvent.setup();
    mount({ viewOnly: false });
    for (const label of TOOL_LABELS)
      expect(screen.getByRole("button", { name: label })).toBeDefined();
    await user.click(screen.getByRole("button", { name: /, zoom$/ }));
    // The items carry their shortcut in the accessible name.
    for (const label of [/^Undo/, /^Redo/])
      expect(screen.getByRole("menuitem", { name: label })).toBeDefined();
  });

  it("swaps the board's Play for its own stop control, for a reader too", () => {
    mount({ viewOnly: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Play Home on canvas" }),
    );
    expect(
      screen.getByRole("button", { name: "Stop Home (Escape)" }),
    ).toBeDefined();
  });

  it("still lets the reader move between pages but not change them", () => {
    mount({ viewOnly: true });
    fireEvent.click(screen.getByRole("button", { name: "Pages" }));
    expect(
      screen.getByRole("button", { name: "Flow" }).getAttribute("aria-current"),
    ).toBe("page");
    for (const label of ["New page", "Actions for Flow"])
      expect(screen.queryByRole("button", { name: label })).toBeNull();
  });

  it("shows board titles as plain text, with no rename, but still offers to play them", () => {
    mount({ viewOnly: true });
    // The header title, and the preview standing in for the unloaded page.
    expect(screen.getAllByText("Home")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Rename Home" })).toBeNull();
    // Play is how a reader runs a prototype; it is not an editing action.
    expect(
      screen.getByRole("button", { name: "Play Home on canvas" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Play Home fullscreen" }),
    ).toBeDefined();
  });

  it("shows a note's text but offers no way to edit it", () => {
    mount({ viewOnly: true });
    const text = screen.getByText("start here");
    expect(
      screen.queryByRole("button", { name: "Edit sticky note" }),
    ).toBeNull();
    fireEvent.doubleClick(text);
    fireEvent.keyDown(text, { code: "Enter" });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("opens the reading order without reordering controls", () => {
    mount({ viewOnly: true });
    fireEvent.click(screen.getByRole("button", { name: "Pages" }));
    const panel = screen.getByRole("list", { name: "Board reading order" });
    expect(within(panel).getByRole("button", { name: /Home/ })).toBeDefined();
    expect(
      within(panel).queryAllByRole("button", {
        name: /Move .* (earlier|later)/,
      }),
    ).toEqual([]);
    for (const item of within(panel).getAllByRole("listitem"))
      expect(item.getAttribute("draggable")).toBe("false");
  });

  it("takes nothing from the canvas surface but panning and zooming", () => {
    mount({ viewOnly: true });
    expect(flow.gestures).toEqual({
      nodesDraggable: false,
      elementsSelectable: false,
      selectionOnDrag: false,
      panOnDrag: true,
    });
    // A node that is neither selectable nor draggable has no resize handles.
    for (const visible of flow.resizerVisible.values())
      expect(visible).toBe(false);
  });

  it("leaves the gestures to the editor when editing is allowed", () => {
    mount({ viewOnly: false });
    expect(flow.gestures).toEqual({
      nodesDraggable: true,
      elementsSelectable: true,
      selectionOnDrag: true,
      panOnDrag: [1, 2],
    });
  });

  it("ignores a drag that reaches the layout anyway", () => {
    const { store } = mount({ viewOnly: true });
    const home = flow.nodes.find((node) => node.id === `board:${HOME}`);
    const dragStop = flow.dragStop;
    if (home === undefined || dragStop === null)
      throw new Error("the canvas never mounted");
    const moved = { ...home, position: { x: 500, y: 500 } };
    act(() => {
      dragStop(new MouseEvent("mouseup"), moved, [moved]);
    });
    expect(readCanvasLayout(store.handle).boards[HOME]).toMatchObject({
      x: 0,
      y: 0,
    });
    expect(store.getSnapshot().canUndo).toBe(false);
  });

  it("does not select a board for the annotation panel on click", () => {
    const onBoardSelect = vi.fn();
    mount({ viewOnly: true, frameEvents: frameEvents({ onBoardSelect }) });
    const home = flow.nodes.find((node) => node.id === `board:${HOME}`);
    if (home === undefined || flow.onNodeClick === null)
      throw new Error("the canvas never mounted");
    const click = flow.onNodeClick;
    act(() => {
      click(new MouseEvent("click"), home);
    });
    expect(onBoardSelect).not.toHaveBeenCalled();
  });

  it("selects the board when editing is allowed", () => {
    const onBoardSelect = vi.fn();
    mount({ viewOnly: false, frameEvents: frameEvents({ onBoardSelect }) });
    const home = flow.nodes.find((node) => node.id === `board:${HOME}`);
    if (home === undefined || flow.onNodeClick === null)
      throw new Error("the canvas never mounted");
    const click = flow.onNodeClick;
    act(() => {
      click(new MouseEvent("click"), home);
    });
    expect(onBoardSelect).toHaveBeenCalledWith(HOME);
  });

  it("takes no edit pointer and renders no annotation panel", () => {
    const onEditPointer = vi.fn();
    const renderPanel = vi.fn(() => <aside aria-label="Annotations" />);
    mount({
      viewOnly: true,
      live: true,
      frameEvents: frameEvents({ onEditPointer, renderPanel }),
    });
    const shield = document.querySelector("[data-canvas-frame-overlay]");
    expect(shield).not.toBeNull();
    if (shield !== null) fireEvent.pointerDown(shield);
    expect(onEditPointer).not.toHaveBeenCalled();
    expect(renderPanel).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Annotations")).toBeNull();
  });

  it("hands the edit pointer and the panel over when editing is allowed", () => {
    const onEditPointer = vi.fn();
    const renderPanel = vi.fn(() => <aside aria-label="Annotations" />);
    mount({
      viewOnly: false,
      live: true,
      frameEvents: frameEvents({ onEditPointer, renderPanel }),
    });
    const shield = document.querySelector("[data-canvas-frame-overlay]");
    if (shield !== null) fireEvent.pointerDown(shield);
    expect(onEditPointer).toHaveBeenCalledOnce();
    // The inspector is parked behind its flag: picking an element still never
    // opens the panel.
    act(() => {
      useCanvasSelectionStore.getState().select({
        artifactId: ARTIFACT_ID,
        boardPath: HOME,
        page: null,
        servedSha256: "sha",
        element: canvasElement({}),
        textRange: null,
      });
    });
    expect(screen.queryByLabelText("Annotations")).toBeNull();
  });
});

describe("the page error pill", () => {
  it("is absent until a page reports an error", () => {
    mount({ live: true });
    expect(queryPill()).toBeNull();
    expect(frameOf("Home")).toBeDefined();
  });

  it("shows a live board's error on its header", () => {
    mount({ live: true });
    fromPage("Home", (props) =>
      props.onPageError?.(pageError("x is not defined")),
    );
    expect(pill().textContent).toBe("x is not defined");
    expect(pills()).toHaveLength(1);
  });

  it("cuts a long message short in the pill", () => {
    mount({ live: true });
    const message = `${"a".repeat(80)}${"b".repeat(40)}`;
    fromPage("Home", (props) => props.onPageError?.(pageError(message)));
    expect(pill().textContent).toBe("a".repeat(80));
  });

  it("offers Add to chat and hands over the path and the error", () => {
    const onAddError = vi.fn();
    const events = frameEvents({ onAddError: vi.fn() });
    mount({ live: true, onAddError, frameEvents: events });
    const error = pageError("boom");
    fromPage("Home", (props) => props.onPageError?.(error));

    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    expect(onAddError).toHaveBeenCalledWith(HOME, error);
    expect(events.onAddError).toHaveBeenCalledWith(HOME, error);
  });

  it("shows the error to a view-only reader but not Add to chat", () => {
    const onAddError = vi.fn();
    mount({ viewOnly: true, live: true, onAddError });
    fromPage("Home", (props) => props.onPageError?.(pageError("boom")));
    expect(pill().textContent).toBe("boom");
    expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();
    expect(onAddError).not.toHaveBeenCalled();
  });

  it("tells the host's page-error listener as well", () => {
    const onPageError = vi.fn();
    mount({ live: true, frameEvents: frameEvents({ onPageError }) });
    const error = pageError("boom");
    fromPage("Home", (props) => props.onPageError?.(error));
    expect(onPageError).toHaveBeenCalledWith(HOME, error);
  });

  it("keeps the latest error", () => {
    mount({ live: true });
    fromPage("Home", (props) => props.onPageError?.(pageError("first")));
    fromPage("Home", (props) => props.onPageError?.(pageError("second")));
    expect(pill().textContent).toBe("second");
  });

  it("clears when a new document mounts its bridge", () => {
    mount({ live: true });
    fromPage("Home", (props) => props.onPageError?.(pageError("boom")));
    expect(pill()).toBeDefined();

    const { bridge } = canvasBridge();
    fromPage("Home", (props) => props.onBridge?.(bridge));
    expect(queryPill()).toBeNull();
  });

  it("clears when the bridge goes away on a reload", () => {
    mount({ live: true });
    fromPage("Home", (props) => props.onPageError?.(pageError("boom")));
    fromPage("Home", (props) => props.onBridge?.(null));
    expect(queryPill()).toBeNull();
  });

  it("shows an error that arrives after the bridge mounted", () => {
    mount({ live: true });
    const { bridge } = canvasBridge();
    fromPage("Home", (props) => props.onBridge?.(bridge));
    fromPage("Home", (props) => props.onPageError?.(pageError("late")));
    expect(pill().textContent).toBe("late");
  });
});

describe("the frame's mode", () => {
  function ready(title: string) {
    const { bridge, setMode } = canvasBridge();
    fromPage(title, (props) => props.onBridge?.(bridge));
    fromPage(title, (props) => props.onStatus("ready"));
    return setMode;
  }

  it("starts a page in edit mode once it is ready", () => {
    mount({ live: true });
    const setMode = ready("Home");
    expect(setMode).toHaveBeenCalledWith("edit");
    expect(setMode).not.toHaveBeenCalledWith("play");
  });

  it("puts the board in play mode from its own button", () => {
    mount({ live: true, onlyBoard: null });
    const setMode = ready("Home");
    setMode.mockClear();

    fireEvent.click(
      screen.getByRole("button", { name: "Play Home on canvas" }),
    );

    expect(setMode).toHaveBeenLastCalledWith("play");
  });

  it("returns the board to edit mode when its stop control is used", () => {
    mount({ live: true });
    const setMode = ready("Home");
    fireEvent.click(
      screen.getByRole("button", { name: "Play Home on canvas" }),
    );
    setMode.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Stop Home (Escape)" }));

    expect(setMode).toHaveBeenLastCalledWith("edit");
  });

  it("remounts a board that navigated during play once play stops", async () => {
    mount({ live: true });
    const { bridge, navigateCanvas } = canvasBridge();
    fromPage("Home", (props) => props.onBridge?.(bridge));
    fromPage("Home", (props) => props.onStatus("ready"));
    fireEvent.click(
      screen.getByRole("button", { name: "Play Home on canvas" }),
    );
    const before = frameOf("Home").remountKey;

    // A same-board link navigates inside the frame.
    await act(async () => {
      frameOf("Home").onRelativeLink?.("home.html#next");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(navigateCanvas).toHaveBeenCalledWith({
      search: "",
      hash: "#next",
      visit: 1,
    });

    // Stopping discards wherever the document went: a fresh mount of the
    // board's own source.
    fireEvent.click(screen.getByRole("button", { name: "Stop Home (Escape)" }));
    expect(frameOf("Home").remountKey).not.toBe(before);
  });

  it("starts and stops play for a view-only reader too", () => {
    mount({ viewOnly: true, live: true });
    const setMode = ready("Home");
    setMode.mockClear();

    fireEvent.click(
      screen.getByRole("button", { name: "Play Home on canvas" }),
    );
    expect(setMode).toHaveBeenLastCalledWith("play");

    fireEvent.click(screen.getByRole("button", { name: "Stop Home (Escape)" }));
    expect(setMode).toHaveBeenLastCalledWith("edit");
  });

  it("puts a fullscreen board in play mode", () => {
    mount({ live: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Play Home fullscreen" }),
    );
    const setMode = ready("Home");
    expect(setMode).toHaveBeenCalledWith("play");
    expect(setMode).not.toHaveBeenCalledWith("edit");
  });
});

// The fullscreen board promotes the existing Canvas surface in place; there is
// no separate dialog any more, so a test reads its `data-canvas-fullscreen`
// marker instead of scoping to a dialog role.
function canvasSurface(): HTMLElement {
  return screen.getByRole("application", { name: "Canvas" });
}
function isFullscreen(): boolean {
  return canvasSurface().hasAttribute("data-canvas-fullscreen");
}

async function chooseBoardInFullscreen(
  user: UserEvent,
  title: string,
): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Choose board" }));
  await user.click(screen.getByRole("menuitem", { name: title }));
}

/**
 * The fullscreen header bar, scoped off of its "Back to canvas" button. A
 * board that just stopped being fullscreen keeps its own inline header (and
 * so its own error pill) once it is an ordinary board again, so a query for
 * "the" error pill must stay inside this header to mean the fullscreen one.
 */
function fullscreenHeader(): HTMLElement {
  const back = screen.getByRole("button", { name: "Back to canvas" });
  const header = back.closest("div");
  if (header === null)
    throw new Error("no fullscreen header around Back to canvas");
  return header;
}

describe("the fullscreen board", () => {
  function openFullscreen(overrides: Partial<Options>) {
    mount({ live: true, ...overrides });
    fireEvent.click(
      screen.getByRole("button", { name: "Play Home fullscreen" }),
    );
  }

  it("shows the page's error with a way to send it to chat", () => {
    openFullscreen({});
    fromPage("Home", (props) => props.onPageError?.(pageError("boom")));
    expect(within(fullscreenHeader()).getByRole("status").textContent).toBe(
      "boom",
    );
    expect(
      within(fullscreenHeader()).getByRole("button", { name: "Add to chat" }),
    ).toBeDefined();
  });

  it("leaves fullscreen when the error is added, so the chat's picker is not stacked under it", () => {
    const events = frameEvents({ onAddError: vi.fn() });
    openFullscreen({ frameEvents: events });
    const error = pageError("boom");
    fromPage("Home", (props) => props.onPageError?.(error));

    fireEvent.click(
      within(fullscreenHeader()).getByRole("button", { name: "Add to chat" }),
    );

    expect(isFullscreen()).toBe(false);
    expect(events.onAddError).toHaveBeenCalledTimes(1);
    expect(events.onAddError).toHaveBeenCalledWith(HOME, error);
  });

  it("shows a view-only reader the error without Add to chat", () => {
    openFullscreen({ viewOnly: true });
    fromPage("Home", (props) => props.onPageError?.(pageError("boom")));
    expect(within(fullscreenHeader()).getByRole("status").textContent).toBe(
      "boom",
    );
    expect(
      within(fullscreenHeader()).queryByRole("button", {
        name: "Add to chat",
      }),
    ).toBeNull();
  });

  function shownBoard(): string | null {
    return within(fullscreenHeader()).getByRole("button", {
      name: "Choose board",
    }).textContent;
  }

  it("steps through the reading order with the header arrows and the arrow keys", () => {
    openFullscreen({});
    const header = fullscreenHeader();
    const previous = within(header).getByRole("button", {
      name: "Previous board",
    });
    const next = within(header).getByRole("button", { name: "Next board" });
    expect(shownBoard()).toBe("Home");
    expect(previous).toHaveProperty("disabled", true);

    fireEvent.click(next);
    expect(shownBoard()).toBe("Checkout");
    expect(next).toHaveProperty("disabled", true);
    expect(isFullscreen()).toBe(true);

    fireEvent.keyDown(canvasSurface(), { code: "ArrowLeft" });
    expect(shownBoard()).toBe("Home");
    // The first board has nothing before it; the key is a no-op, not an exit.
    fireEvent.keyDown(canvasSurface(), { code: "ArrowLeft" });
    expect(shownBoard()).toBe("Home");
    expect(isFullscreen()).toBe(true);

    // A chord is someone else's; only the bare arrow steps.
    fireEvent.keyDown(canvasSurface(), { code: "ArrowRight", altKey: true });
    expect(shownBoard()).toBe("Home");
    fireEvent.keyDown(canvasSurface(), { code: "ArrowRight" });
    expect(shownBoard()).toBe("Checkout");
  });

  it("opens the board a link points at, and ignores links that point elsewhere", async () => {
    const onRelativeLink = vi.fn();
    openFullscreen({ frameEvents: frameEvents({ onRelativeLink }) });
    expect(screen.getByText("Home")).toBeDefined();

    fromPage("Home", (props) =>
      props.onRelativeLink?.("https://example.com/checkout.html"),
    );
    fromPage("Home", (props) => props.onRelativeLink?.("../../escape.html"));
    fromPage("Home", (props) => props.onRelativeLink?.("missing.html"));
    expect(screen.getByText("Home")).toBeDefined();

    fromPage("Home", (props) => props.onRelativeLink?.("checkout.html#pay"));
    expect(screen.getByText("Checkout")).toBeDefined();
    // The host hears about every link, resolved or not.
    expect(onRelativeLink).toHaveBeenCalledTimes(4);
    expect(onRelativeLink).toHaveBeenLastCalledWith(HOME, "checkout.html#pay");

    // The hash survives to the board it lands on, so once Checkout's own
    // page is ready, the bridge is asked to apply it.
    const { bridge, navigateCanvas } = canvasBridge();
    await act(async () => {
      fromPage("Checkout", (props) => props.onBridge?.(bridge));
      fromPage("Checkout", (props) => props.onStatus("ready"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(navigateCanvas).toHaveBeenCalledExactlyOnceWith({
      search: "",
      hash: "#pay",
      visit: 1,
    });
  });

  it("shows the error of whichever board is currently fullscreen, not a stale one", async () => {
    // Every board keeps running once promoted into fullscreen, so its error
    // is tracked per path at the editor, not reset by a remount; the header
    // must still show only the error of the board on screen right now.
    const user = userEvent.setup();
    openFullscreen({});
    fromPage("Home", (props) => props.onPageError?.(pageError("boom")));
    expect(within(fullscreenHeader()).getByRole("status").textContent).toBe(
      "boom",
    );

    await chooseBoardInFullscreen(user, "Checkout");
    expect(within(fullscreenHeader()).queryByRole("status")).toBeNull();

    await chooseBoardInFullscreen(user, "Home");
    expect(within(fullscreenHeader()).getByRole("status").textContent).toBe(
      "boom",
    );
  });

  it("drops the old board's error when the next board has no page to run", async () => {
    const user = userEvent.setup();
    openFullscreen({ onlyBoard: HOME });
    fromPage("Home", (props) => props.onPageError?.(pageError("boom")));
    expect(within(fullscreenHeader()).getByRole("status")).toBeDefined();

    await chooseBoardInFullscreen(user, "Checkout");

    expect(
      screen.getByRole("button", { name: "Choose board" }).textContent,
    ).toBe("Checkout");
    expect(within(fullscreenHeader()).queryByRole("status")).toBeNull();
  });
});

describe("a link in a board on the canvas", () => {
  it("still tells the host when it names no board", () => {
    const onRelativeLink = vi.fn();
    mount({ live: true, frameEvents: frameEvents({ onRelativeLink }) });
    fromPage("Home", (props) => props.onRelativeLink?.("nowhere.html"));
    expect(onRelativeLink).toHaveBeenCalledWith(HOME, "nowhere.html");
    // Nothing navigates: a link elsewhere on the canvas never opens fullscreen.
    expect(isFullscreen()).toBe(false);
  });
});

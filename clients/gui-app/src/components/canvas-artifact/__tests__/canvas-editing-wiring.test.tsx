import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Fragment, type ComponentType, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeProps } from "@xyflow/react";
import { parseHtmlSource } from "@traycer/html-source";
import type { ArtifactObjectRef } from "@traycer/protocol/persistence/epic/artifacts";
import type { SandboxFrameProps } from "@/components/sandbox/sandbox-frame";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import type {
  CanvasElement,
  CanvasElementLocator,
} from "@/lib/sandbox/canvas-bridge";
import type { ArtifactReadSpan } from "@/lib/sandbox/artifact-serving";
import type { ArtifactProjection } from "@/stores/epics/open-epic/types";
import { CanvasArtifactSurface } from "../canvas-artifact-surface";
import { CanvasSelectionProvider } from "../canvas-selection-provider";
import {
  CanvasArtifactFixtureProvider,
  type CanvasArtifactFixture,
} from "../canvas-surface-context";
import type { CanvasFlowNode } from "../canvas-node-context";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "../canvas-selection-store";
import { ARTIFACT_ID, docFromFixture } from "./canvas-fixtures";
import {
  canvasElement,
  disposeBridges,
  pendingSaves,
  realBridge,
} from "./canvas-edit-test-support";

// The whole editing stack runs for real over a real Y.Doc: the surface, the
// selection provider and its registry, the board nodes, the editing overlay,
// the Layers and Tweaks panels, and the document reader behind them. Only the
// boundaries are stand-ins: the sandboxed iframe (the test plays the page by
// calling the props the frame was given), xyflow's measuring, and the host's
// edit transport.

vi.mock("../use-artboard-edit", async () =>
  (await import("./canvas-edit-test-support")).artboardEditModule(),
);
vi.mock("../canvas-annotation-action", () => ({
  CanvasAnnotationAction: () => null,
  CanvasSelectionAction: () => null,
}));
// Comments are a separate surface; this test exercises the editing stack.
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/hooks/comments/use-frame-comments-enabled", () => ({
  useFrameCommentsEnabled: () => false,
}));
vi.mock("../canvas-comments", () => ({
  CanvasCommentAction: () => null,
  CanvasCommentIndex: () => null,
  CanvasCommentPins: () => null,
  CanvasCommentPointPins: () => null,
}));
vi.mock("@/components/comments/frame-comments", () => ({
  FrameCommentsToolbar: () => null,
}));
vi.mock("@/components/comments/anchored-draft-popover", () => ({
  AnchoredDraftPopover: () => null,
}));
vi.mock("@/components/ui/agent-spinning-dots", () => ({
  AgentSpinningDots: () => null,
}));

interface MockFlowProps {
  readonly nodes: CanvasFlowNode[];
  readonly nodeTypes: Readonly<
    Record<string, ComponentType<NodeProps<CanvasFlowNode>>>
  >;
  readonly onNodeClick?: (event: MouseEvent, node: CanvasFlowNode) => void;
  readonly children: ReactNode;
}
vi.mock("@xyflow/react", () => ({
  ReactFlow: (props: MockFlowProps) => (
    <div role="group" aria-label="Canvas pane">
      {props.nodes.map((node) => {
        const type = node.type ?? "board";
        const NodeRenderer = props.nodeTypes[type];
        return (
          <Fragment key={node.id}>
            <button
              type="button"
              aria-label={`Pick ${node.id}`}
              onClick={(event) => props.onNodeClick?.(event.nativeEvent, node)}
            />
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
          </Fragment>
        );
      })}
      {props.children}
    </div>
  ),
  Background: () => null,
  MiniMap: () => null,
  NodeResizer: () => null,
  // The node chrome scales with the canvas zoom; the test canvas is unzoomed.
  useStore: (select: (state: { transform: number[] }) => unknown) =>
    select({ transform: [0, 0, 1] }),
}));

const frames = vi.hoisted(() => new Map<string, SandboxFrameProps>());
vi.mock("@/components/sandbox/sandbox-frame", () => ({
  SandboxFrame: (props: SandboxFrameProps) => {
    frames.set(props.title, props);
    return <div data-testid={`frame-${props.title}`} />;
  },
}));

const HOME = "boards/home.html";
const SHA = "a".repeat(64);
const HTML = `<!doctype html><html><head><style>:root{--accent:#ff0000;--gap:12px}</style></head><body><h1 data-tid="headline">Welcome home</h1><p>Plain <b>mixed</b> text</p></body></html>`;
const BYTES = new TextEncoder().encode(HTML);
const PARSED = parseHtmlSource(HTML);
const H1_MARKER = HTML.indexOf("<h1");
const P_MARKER = HTML.indexOf("<p>");
const B_MARKER = HTML.indexOf("<b>");

/** What the page would report for the element whose start tag is at `marker`. */
function pageElement(marker: number): CanvasElement | null {
  const node = PARSED.elements.find((item) => item.startTag?.start === marker);
  if (node === undefined) return null;
  return canvasElement({
    marker,
    tid: node.effectiveTid,
    tagName: node.tagName,
    textPreview: node.tagName === "h1" ? "Welcome home" : "",
    textSnapshot: snapshotOf(node.tagName),
  });
}
/** What the page reports as the element's live text. */
function snapshotOf(tagName: string): CanvasElement["textSnapshot"] {
  if (tagName === "h1")
    return { content: "Welcome home", nodes: ["Welcome home"], textOnly: true };
  if (tagName === "p")
    return {
      content: "Plain mixed text",
      nodes: ["Plain ", " text"],
      textOnly: false,
    };
  return { content: "", nodes: [], textOnly: false };
}
function headline(): CanvasElement {
  const found = pageElement(H1_MARKER);
  if (found === null) throw new Error("fixture has no headline");
  return found;
}
function paragraph(): CanvasElement {
  const found = pageElement(P_MARKER);
  if (found === null) throw new Error("fixture has no paragraph");
  return found;
}

/** The page's answer for a locator: the element it names, or nothing. */
function describedElement(locator: CanvasElementLocator): CanvasElement | null {
  if ("marker" in locator) return pageElement(locator.marker);
  return locator.tid === "headline" ? headline() : null;
}

function selectionOf(element: CanvasElement): CanvasSelection {
  return {
    artifactId: ARTIFACT_ID,
    boardPath: HOME,
    page: null,
    servedSha256: SHA,
    element,
    textRange: null,
  };
}

const readSpan = vi.fn<ArtifactReadSpan>((_hash, offset, length, signal) => {
  signal.throwIfAborted();
  return Promise.resolve({
    bytes: BYTES.slice(offset, offset + length),
    totalBytes: BYTES.length,
    mediaType: "text/html",
  });
});

/** A bridge whose page answers for every element the fixture can describe. */
function pageBridge() {
  const bridge = realBridge();
  const describeElement = vi
    .spyOn(bridge, "describeElement")
    .mockImplementation((locator) =>
      Promise.resolve(describedElement(locator)),
    );
  // The selection overlay keeps asking the page where the selected element is
  // and drops the selection when the page cannot find it, so the page must
  // answer for every element it can describe.
  vi.spyOn(bridge, "elementBox").mockImplementation((locator) => {
    const element = describedElement(locator);
    return Promise.resolve(element === null ? null : element.box);
  });
  const setTextTarget = vi
    .spyOn(bridge, "setTextSelectionTarget")
    .mockResolvedValue(true);
  vi.spyOn(bridge, "setMode").mockResolvedValue(true);
  return { bridge, describeElement, setTextTarget };
}

function mountEditing() {
  const doc = docFromFixture({
    pages: [{ id: "flow", name: "Flow" }],
    boards: { [HOME]: { x: 0, y: 0, w: 640, h: 400, title: "Home" } },
    notes: {},
    order: [HOME],
  });
  const files: Record<string, ArtifactObjectRef> = {
    [HOME]: {
      sha256: SHA,
      byteLength: BYTES.length,
      mediaType: "text/html",
      status: "local-only",
    },
  };
  const artifact: ArtifactProjection = {
    id: ARTIFACT_ID,
    kind: "canvas",
    title: "Wiring",
    layout: "folder",
    folderName: "wiring",
    parentId: null,
    artifactRoomId: null,
    createdAt: 0,
    updatedAt: 0,
    status: null,
    createdManually: false,
    head: { files, capturedAt: 0 },
  };
  const binding: CanvasArtifactFixture = {
    doc,
    awareness: null,
    user: { name: "Ada", color: "#112233" },
    treePath: "wiring",
    readSpan,
    resolveOutsideReference: () => null,
  };
  const { bridge, describeElement, setTextTarget } = pageBridge();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <CanvasSelectionProvider
          epicId="epic-1"
          artifactId={ARTIFACT_ID}
          artifactTitle="Wiring"
          artifactType="canvas"
          hostId="host-1"
          viewTabId="tab-1"
        >
          <CanvasArtifactFixtureProvider value={binding}>
            <CanvasArtifactSurface
              epicId="epic-1"
              artifactId={ARTIFACT_ID}
              artifact={artifact}
            />
          </CanvasArtifactFixtureProvider>
        </CanvasSelectionProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { bridge, describeElement, setTextTarget };
}

function homeFrame(): SandboxFrameProps {
  const found = frames.get("Home");
  if (found === undefined) throw new Error("the board never rendered a frame");
  return found;
}

/**
 * The page loads: it hands over its bridge and reports it is ready. Ready asks
 * the page to describe the selected element; the page answers with an already
 * settled promise, so that answer's continuation is the first microtask the
 * call queued and has run when the awaited act resumes.
 */
async function loadPage(bridge: SandboxBridgeHost): Promise<void> {
  await act(async () => {
    homeFrame().onBridge?.(bridge);
    await Promise.resolve();
  });
  await act(async () => {
    homeFrame().onStatus("ready");
    await Promise.resolve();
  });
}

function select(selection: CanvasSelection | null): void {
  act(() => {
    if (selection === null) useCanvasSelectionStore.getState().clear();
    else useCanvasSelectionStore.getState().select(selection);
  });
}

beforeEach(() => {
  pendingSaves.length = 0;
  frames.clear();
  readSpan.mockClear();
  useCanvasSelectionStore.getState().clear();
  // The Layers list is virtualised; jsdom would give it a 0 by 0 viewport.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(360);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(300);
});

afterEach(() => {
  cleanup();
  disposeBridges();
  vi.restoreAllMocks();
  useCanvasSelectionStore.getState().clear();
});

describe("the editing stack over a real canvas document", () => {
  it("gives the live board a frame whose source is the artifact's served file", () => {
    mountEditing();
    const source = homeFrame().source;
    expect(source).toMatchObject({
      kind: "artifact",
      canvas: true,
      entryPath: HOME,
      treePath: "wiring",
    });
  });

  it("points the page's text target at the selected element once the page is ready", async () => {
    const { bridge, setTextTarget } = mountEditing();
    select(selectionOf(headline()));
    await loadPage(bridge);

    expect(setTextTarget).toHaveBeenCalledWith({ tid: "headline" });
  });

  it("clears the page's text target when the selection goes", async () => {
    const { bridge, setTextTarget } = mountEditing();
    select(selectionOf(headline()));
    await loadPage(bridge);

    select(null);
    // Dropping the selection tells the page synchronously, inside the act.
    expect(setTextTarget).toHaveBeenLastCalledWith(null);
  });

  describe("double-click to retype", () => {
    async function selectedAndLoaded() {
      const view = mountEditing();
      select(selectionOf(headline()));
      await loadPage(view.bridge);
      return view;
    }
    const doubleClick = async (element: CanvasElement): Promise<void> => {
      await act(async () => {
        homeFrame().onDoubleClick?.(element);
        await Promise.resolve();
      });
    };

    it("opens the text editor over the selected element, filled with its text", async () => {
      await selectedAndLoaded();
      await doubleClick(headline());

      const field = await screen.findByRole("textbox", {
        name: "Edit element text",
      });
      expect(field).toHaveProperty("value", "Welcome home");
      expect(readSpan).toHaveBeenCalledWith(
        SHA,
        0,
        BYTES.length,
        expect.any(AbortSignal),
      );
    });

    it("saves what is typed against the revision the page was showing", async () => {
      await selectedAndLoaded();
      await doubleClick(headline());
      const field = await screen.findByRole("textbox", {
        name: "Edit element text",
      });
      fireEvent.change(field, { target: { value: "Hello there" } });
      // The editor asks the page for the live text before it saves.
      fireEvent.keyDown(field, { code: "Enter" });
      await waitFor(() => expect(pendingSaves).toHaveLength(1));

      expect(pendingSaves[0].variables.edit).toEqual({
        kind: "set-text-node",
        index: 0,
        expectedText: "Welcome home",
        text: "Hello there",
      });
      expect(pendingSaves[0].variables.selection).toMatchObject({
        boardPath: HOME,
        servedSha256: SHA,
        element: { tid: "headline" },
      });
    });

    it("adopts a double-clicked element that is not the selected one and opens its editor", async () => {
      await selectedAndLoaded();
      await doubleClick(paragraph());

      expect(useCanvasSelectionStore.getState().selection?.element.marker).toBe(
        P_MARKER,
      );
      const field = await screen.findByRole("textbox", {
        name: "Edit element text",
      });
      expect(field).toHaveProperty("value", "Plain mixed text");
    });

    it("opens the whole block, formatting included, when the element has mixed content", async () => {
      const view = mountEditing();
      select(selectionOf(paragraph()));
      await loadPage(view.bridge);
      await doubleClick(paragraph());

      const field = await screen.findByRole("textbox", {
        name: "Edit element text",
      });
      expect(field).toHaveProperty("value", "Plain mixed text");
      expect(
        screen.queryByText("Ask the agent to change this element."),
      ).toBeNull();
    });

    it("saves a change inside formatted text against the inline element that owns it", async () => {
      const view = mountEditing();
      select(selectionOf(paragraph()));
      await loadPage(view.bridge);
      await doubleClick(paragraph());
      const field = await screen.findByRole("textbox", {
        name: "Edit element text",
      });
      fireEvent.change(field, { target: { value: "Plain MIXED text" } });
      fireEvent.keyDown(field, { code: "Enter" });
      await waitFor(() => expect(pendingSaves).toHaveLength(1));

      expect(pendingSaves[0].variables.edit).toEqual({
        kind: "set-text-node",
        index: 0,
        expectedText: "mixed",
        text: "MIXED",
      });
      expect(pendingSaves[0].variables.selection).toMatchObject({
        servedSha256: SHA,
        element: { marker: B_MARKER, tagName: "b", tid: null },
      });
    });

    it("keeps a change that crosses formatted text open instead of saving it", async () => {
      const view = mountEditing();
      select(selectionOf(paragraph()));
      await loadPage(view.bridge);
      await doubleClick(paragraph());
      const field = await screen.findByRole("textbox", {
        name: "Edit element text",
      });
      fireEvent.change(field, { target: { value: "Plain text" } });
      fireEvent.keyDown(field, { code: "Enter" });

      // The refusal is shown once the editor has read the live text.
      expect(
        await screen.findByText(
          "This change crosses formatted text. Ask the agent to change it.",
        ),
      ).toBeDefined();
      expect(pendingSaves).toHaveLength(0);
      expect(field).toHaveProperty("value", "Plain text");
    });

    it("does not open once the selection has moved on", async () => {
      await selectedAndLoaded();
      await doubleClick(headline());
      await screen.findByRole("textbox", { name: "Edit element text" });

      select(selectionOf(paragraph()));
      expect(
        screen.queryByRole("textbox", { name: "Edit element text" }),
      ).toBeNull();
    });
  });

  describe("a retype request belongs to the page that sent it", () => {
    const editor = () =>
      screen.queryByRole("textbox", { name: "Edit element text" });
    const doubleClick = async (element: CanvasElement): Promise<void> => {
      await act(async () => {
        homeFrame().onDoubleClick?.(element);
        await Promise.resolve();
      });
    };
    async function editorOpen() {
      const view = mountEditing();
      select(selectionOf(headline()));
      await loadPage(view.bridge);
      await doubleClick(headline());
      await screen.findByRole("textbox", { name: "Edit element text" });
      return view;
    }
    const retire = async (bridge: SandboxBridgeHost | null): Promise<void> => {
      await act(async () => {
        homeFrame().onBridge?.(bridge);
        await Promise.resolve();
      });
    };

    it("closes the editor when the page's bridge goes away", async () => {
      await editorOpen();
      await retire(null);
      expect(editor()).toBeNull();
    });

    it("keeps the selection through that gap, because its element has a durable tid", async () => {
      await editorOpen();
      await retire(null);
      expect(useCanvasSelectionStore.getState().selection?.element.tid).toBe(
        "headline",
      );
    });

    it("does not reopen for the same bridge coming back with the same revision", async () => {
      const { bridge } = await editorOpen();
      await retire(null);
      await retire(bridge);
      await loadPage(bridge);
      expect(editor()).toBeNull();
    });

    it("does not reopen for a fresh bridge with the same revision", async () => {
      await editorOpen();
      await retire(null);
      const fresh = pageBridge();
      await retire(fresh.bridge);
      await loadPage(fresh.bridge);
      expect(editor()).toBeNull();
    });

    it("opens again for a fresh double-click on the fresh bridge", async () => {
      await editorOpen();
      await retire(null);
      const fresh = pageBridge();
      await loadPage(fresh.bridge);
      await doubleClick(headline());
      expect(
        await screen.findByRole("textbox", { name: "Edit element text" }),
      ).toBeDefined();
    });

    it("ignores a double-click that arrives while there is no bridge", async () => {
      await editorOpen();
      await retire(null);
      await doubleClick(headline());
      const fresh = pageBridge();
      await loadPage(fresh.bridge);
      expect(editor()).toBeNull();
    });

    it("closes the editor when the frame is replaced", async () => {
      await editorOpen();
      const ref = homeFrame().ref;
      if (typeof ref !== "function") throw new Error("no frame callback");
      act(() => {
        ref(document.createElement("iframe"));
      });
      expect(editor()).toBeNull();
    });
  });

  describe("text that a script changed", () => {
    const CHANGED =
      "This text was changed by a script. Ask the agent to change it.";
    const doubleClick = async (element: CanvasElement): Promise<void> => {
      await act(async () => {
        homeFrame().onDoubleClick?.(element);
        await Promise.resolve();
      });
    };

    it("says so, and opens no editor, when the live text differs from the source", async () => {
      const view = mountEditing();
      select(selectionOf(headline()));
      await loadPage(view.bridge);
      await doubleClick({
        ...headline(),
        textSnapshot: {
          content: "Welcome back",
          nodes: ["Welcome back"],
          textOnly: true,
        },
      });

      expect(await screen.findByText(CHANGED)).toBeDefined();
      expect(
        screen.queryByRole("textbox", { name: "Edit element text" }),
      ).toBeNull();
    });

    it("says so, and opens no editor, when the page sent no snapshot", async () => {
      const view = mountEditing();
      select(selectionOf(headline()));
      await loadPage(view.bridge);
      await doubleClick({ ...headline(), textSnapshot: null });

      expect(await screen.findByText(CHANGED)).toBeDefined();
    });

    it("refuses the save when the text changed after the editor opened", async () => {
      const view = mountEditing();
      select(selectionOf(headline()));
      await loadPage(view.bridge);
      await doubleClick(headline());
      const field = await screen.findByRole("textbox", {
        name: "Edit element text",
      });

      // A script rewrites the heading while the person is typing.
      view.describeElement.mockImplementation((locator) => {
        const original = describedElement(locator);
        return Promise.resolve(
          original === null || original.tagName !== "h1"
            ? original
            : {
                ...original,
                textSnapshot: {
                  content: "Rewritten by a script",
                  nodes: ["Rewritten by a script"],
                  textOnly: true,
                },
              },
        );
      });
      fireEvent.change(field, { target: { value: "Hello there" } });
      fireEvent.keyDown(field, { code: "Enter" });

      // The refusal is shown once the editor has read the rewritten text.
      expect(await screen.findByText(CHANGED)).toBeDefined();
      expect(pendingSaves).toHaveLength(0);
      expect(field).toHaveProperty("value", "Hello there");
    });
  });
});
